// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Devspace Registry: registry.json in the global storage folder. Several VS Code windows change it. Every
// read-modify-write runs under the lock folder registry.lock, and every write is atomic (temporary file, then rename),
// so a read without the lock sees either the old or the new content.
import * as fs from 'fs';
import { dockerHostOf, isOnDockerHost } from '../docker/dockerHost';
import { isoTime, silentLogger, systemClock, type Clock, type Logger } from '../ports';
import type {
  BuildRecord,
  BusyMark,
  BusyOperation,
  Devspace,
  DevspaceSource,
  GitHubAccount,
  KeptVolume,
  RefusedUpdate,
  RegistryFile,
} from '../types';
import { isGitSummary } from '../git/gitSummary';
import { writeJsonAtomic } from './atomicJson';
import { DEFAULT_LOCK_STALE_MS, DEFAULT_LOCK_TIMEOUT_MS, LockLostError, withLockFolder } from './lockFolder';
import { errorCode, isStorageId, parseJson, readTextFile, retryTransient, type StoragePaths } from './paths';
import { isRecord } from '../valueChecks';
import { parseImageReference } from '../remoteMonitor/protocol';
import { DEFAULT_CONFIG_PATH } from '../pipeline/recordRules';
import { isSourceOf, sourceOf } from '../devspaceSource';

/** The registry format that this version reads and writes. */
export const REGISTRY_VERSION = 1;

// User-visible text that messages.ts lacks; to be moved there.
/** Shown when registry.json was written by a newer version of the extension. */
export const REGISTRY_NEWER_VERSION_MESSAGE =
  'The list of devspaces was saved by a newer version of Devspaces. Update the extension to change it.';

/** Thrown by a change of a registry file with a newer format version. The file is not changed. */
export class RegistryVersionError extends Error {
  constructor(readonly version: number) {
    super(REGISTRY_NEWER_VERSION_MESSAGE);
    this.name = 'RegistryVersionError';
  }
}

export interface RegistryOptions {
  logger?: Logger;
  /** A lock folder older than this counts as stale (the holder crashed). Default: 10 seconds. */
  lockStaleMs?: number;
  /** Maximum wait for the lock. Default: 15 seconds. */
  lockTimeoutMs?: number;
}

const EPOCH = new Date(0).toISOString();

/**
 * True if `devspace` is a devspace of the repository `owner/name` (ignoring case) of the GitHub account `accountId`
 * on the Docker host `dockerHost` ('' = the local Docker), and, with `source`, the devspace of that source
 * (isSourceOf). A repository has at most one devspace per account, Docker host and source.
 */
export function isDevspaceOf(
  devspace: Pick<Devspace, 'repository' | 'owner' | 'dockerHost' | 'configPath' | 'defaultImage'>,
  repository: string,
  accountId: string,
  dockerHost = '',
  source?: DevspaceSource,
): boolean {
  return (
    devspace.repository.toLowerCase() === repository.toLowerCase() &&
    devspace.owner.id === accountId &&
    isOnDockerHost(devspace, dockerHost) &&
    (source === undefined || isSourceOf(devspace, source))
  );
}

/** The Devspace Registry. Used by the windows. It keeps no cache. */
export class DevspaceRegistry {
  private readonly logger: Logger;
  private readonly lockStaleMs: number;
  private readonly lockTimeoutMs: number;

  constructor(
    private readonly paths: StoragePaths,
    private readonly clock: Clock = systemClock,
    options: RegistryOptions = {},
  ) {
    this.logger = options.logger ?? silentLogger;
    this.lockStaleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  }

  /** True if registry.json exists. */
  async exists(): Promise<boolean> {
    try {
      await retryTransient(() => fs.promises.stat(this.paths.registry));
      return true;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false;
      throw error;
    }
  }

  /**
   * Reads the registry without the lock. A missing or invalid file, and a file of a newer format version, give
   * `{ version: 1, devspaces: [] }`. Invalid entries are left out. Throws only if the file exists but cannot be read.
   */
  async read(): Promise<RegistryFile> {
    return parseRegistry(await readTextFile(this.paths.registry)).file;
  }

  /**
   * The registry lost content: true when registry.json lost content that the volume labels can restore. That is, the
   * file is missing, is not valid (not JSON, no or an unknown format version, `devspaces` is not a list), or has
   * entries that the registry leaves out as invalid (the next write drops them). False for a valid file, and for a file
   * of a newer format version, which this version must not change. Throws only if the file exists but cannot be read.
   */
  async needsRestore(): Promise<boolean> {
    const parsed = parseRegistry(await readTextFile(this.paths.registry));
    return parsed.state === 'missing' || parsed.state === 'invalid' || (parsed.state === 'ok' && parsed.dropped > 0);
  }

  async list(): Promise<Devspace[]> {
    return (await this.read()).devspaces;
  }

  async get(id: string): Promise<Devspace | undefined> {
    return (await this.list()).find((devspace) => devspace.id === id);
  }

  /**
   * Finds the devspace of `source` of `owner/name` (ignoring case) of the GitHub account `accountId` on the Docker
   * host `dockerHost` ('' = the local Docker). Without `source`: any devspace of the repository there (the most
   * recently used one first).
   */
  async findForAccount(repository: string, accountId: string, dockerHost = '', source?: DevspaceSource): Promise<Devspace | undefined> {
    const found = (await this.list()).filter((devspace) => isDevspaceOf(devspace, repository, accountId, dockerHost, source));
    return found.sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt))[0];
  }

  /** Finds the devspace of a container name, with or without the leading `/` of `docker inspect`. */
  async findByContainerName(containerName: string): Promise<Devspace | undefined> {
    const wanted = withoutLeadingSlash(containerName);
    return (await this.list()).find((devspace) => withoutLeadingSlash(devspace.containerName) === wanted);
  }

  /**
   * Read-modify-write under the lock folder `paths.registryLock` (see `withLockFolder`). The mutator changes `file` in
   * place. The file is written only if the content changed. If the mutator throws, nothing is written. Keep the mutator
   * short: do not call Docker or the network in it, and never call `update` from inside it (the lock is not
   * re-entrant). Throws `RegistryVersionError` for a file of a newer format version. `onlyIfClean`: when the file is
   * missing, invalid, or has invalid entries or records (it still needs its restore), neither the mutator runs nor
   * anything is written; resolves with `undefined`. If another process took over the lock meanwhile (this process
   * stalled longer than the stale time), nothing is written and the whole change runs once more on the current
   * content, so the mutator can run twice.
   */
  async update<T>(mutator: (file: RegistryFile) => T | Promise<T>): Promise<T>;
  async update<T>(mutator: (file: RegistryFile) => T | Promise<T>, options: { onlyIfClean: true }): Promise<T | undefined>;
  async update<T>(mutator: (file: RegistryFile) => T | Promise<T>, options: { onlyIfClean?: boolean } = {}): Promise<T | undefined> {
    const run = () =>
      withLockFolder(this.paths.registryLock, (held) => this.updateLocked(mutator, options.onlyIfClean === true, held), {
        staleMs: this.lockStaleMs,
        timeoutMs: this.lockTimeoutMs,
      });
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof LockLostError)) throw error;
      this.logger.warn(`${error.message} The change runs again on the current content.`);
      return run();
    }
  }

  /**
   * Adds a devspace. Throws if a devspace with the same ID exists, or one of the same repository (ignoring
   * case), the same owner account, the same Docker host and the same source (isDevspaceOf): one devspace per
   * repository, GitHub account and source. The check runs under the lock, so two windows of one account that start
   * the same source of a repository at the same time cannot both add a devspace.
   */
  async add(devspace: Devspace): Promise<void> {
    const accountId = devspace.owner.id;
    await this.update((file) => {
      if (file.devspaces.some((existing) => existing.id === devspace.id)) {
        throw new Error(`The devspace ${devspace.id} exists already.`);
      }
      if (file.devspaces.some((existing) => isDevspaceOf(existing, devspace.repository, accountId, dockerHostOf(devspace), sourceOf(devspace)))) {
        throw new Error(`A devspace of ${devspace.repository} of the GitHub account ${accountId} exists already.`);
      }
      file.devspaces.push(devspace);
    });
  }

  /**
   * When the registry lost content (`record restore`): adds the entries that were rebuilt from the labels of their
   * volumes, under the lock. An entry whose ID or volume the registry has is left out (it was never lost); one of a
   * repository of which its owner account has a devspace of the same source (sourceOf) on its Docker host already is
   * left out too (one devspace per repository, account and source) and named in `skipped` (its volume name).
   */
  async restore(entries: readonly Devspace[]): Promise<{ added: number; skipped: string[] }> {
    return this.update((file) => {
      let added = 0;
      const skipped: string[] = [];
      for (const entry of entries) {
        // A volume or container of the same name in another case is the same one.
        const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
        if (file.devspaces.some((e) => e.id === entry.id || same(e.volumeName, entry.volumeName) || same(e.containerName, entry.containerName))) continue;
        if (file.devspaces.some((e) => isDevspaceOf(e, entry.repository, entry.owner.id, dockerHostOf(entry), sourceOf(entry)))) {
          skipped.push(entry.volumeName);
          continue;
        }
        file.devspaces.push(entry);
        added++;
      }
      return { added, skipped };
    });
  }

  /**
   * Changes one devspace under the lock. Returns the changed devspace, or `undefined` if the ID does not exist.
   * An async mutator is awaited before the write (TypeScript accepts one also for a `void` return type).
   */
  async updateDevspace(
    id: string,
    mutator: (devspace: Devspace) => void | Promise<void>,
  ): Promise<Devspace | undefined> {
    return this.update(async (file) => {
      const devspace = file.devspaces.find((candidate) => candidate.id === id);
      if (!devspace) return undefined;
      await mutator(devspace);
      return devspace;
    });
  }

  /**
   * Records that a window was seen using the devspace `id` at `at` (an ISO time): sets `lastSeenInUseAt`, but never
   * back to an earlier time. A missing ID is not an error (nothing is written). Nothing is written either while the
   * file is not clean (missing, invalid, or with invalid entries or records): this runs at activation, before the
   * restore check, and a write would drop the lost entries before they are restored from the volume labels. The mark
   * only serves Delete's note.
   */
  async markSeenInUse(id: string, at: string): Promise<void> {
    const time = Date.parse(at);
    if (!Number.isFinite(time)) return;
    await this.update(
      (file) => {
        const devspace = file.devspaces.find((candidate) => candidate.id === id);
        if (!devspace) return;
        const previous = devspace.lastSeenInUseAt === undefined ? Number.NaN : Date.parse(devspace.lastSeenInUseAt);
        if (Number.isFinite(previous) && previous >= time) return;
        devspace.lastSeenInUseAt = at;
      },
      { onlyIfClean: true },
    );
  }

  /**
   * Removes the entry `id`; a missing ID is not an error. `volumes.kept`: additional volumes of the entry that its Delete kept; they are recorded with
   * the owner of the entry, besides the records of other owners of the same name (each keeps its data there).
   * `volumes.removed`: volumes that no longer exist; all their records are dropped. One change of the file, so no
   * volume is ever without its record.
   */
  async remove(id: string, volumes: { kept?: readonly string[]; removed?: readonly string[] } = {}): Promise<void> {
    await this.update((file) => {
      const entry = file.devspaces.find((devspace) => devspace.id === id);
      file.devspaces = file.devspaces.filter((devspace) => devspace.id !== id);
      const removed = new Set(volumes.removed ?? []);
      const records = (file.keptVolumes ?? []).filter((record) => !removed.has(record.name));
      const keptAt = isoTime(this.clock);
      if (entry) {
        for (const name of new Set(volumes.kept ?? [])) {
          if (removed.has(name) || records.some((record) => record.name === name && record.owner.id === entry.owner.id)) continue;
          records.push({ name, owner: entry.owner, keptAt });
        }
      }
      if (records.length > 0) file.keptVolumes = records;
      else delete file.keptVolumes;
    });
  }

  /**
   * Drops the records of the kept volumes `names`, of every owner: the caller found that these volumes no longer exist,
   * so a volume of that name that is created later holds none of the data that the records protect.
   */
  async forgetKeptVolumes(names: readonly string[]): Promise<void> {
    if (names.length === 0) return;
    await this.update((file) => {
      if (!file.keptVolumes) return;
      const gone = new Set(names);
      const records = file.keptVolumes.filter((record) => !gone.has(record.name));
      if (records.length > 0) file.keptVolumes = records;
      else delete file.keptVolumes;
    });
  }

  /** The additional volumes that Deletes kept (see `remove`). */
  async keptVolumes(): Promise<KeptVolume[]> {
    return (await this.read()).keptVolumes ?? [];
  }

  /**
   * Marks the devspace as busy, so the Monitor does not stop it. Replaces an existing mark. Throws if the
   * devspace does not exist, because the caller relies on the protection.
   */
  async setBusy(id: string, operation: BusyOperation, owner: { windowId: string; pid: number }): Promise<void> {
    const since = isoTime(this.clock);
    const changed = await this.updateDevspace(id, (devspace) => {
      devspace.busy = { operation, since, pid: owner.pid, windowId: owner.windowId };
    });
    if (!changed) throw new Error(`The devspace ${id} does not exist.`);
  }

  /** Removes the busy mark. A missing devspace or a missing mark is not an error. */
  async clearBusy(id: string): Promise<void> {
    await this.updateDevspace(id, (devspace) => {
      delete devspace.busy;
    });
  }

  private async updateLocked<T>(
    mutator: (file: RegistryFile) => T | Promise<T>,
    onlyIfClean: boolean,
    held: () => Promise<boolean>,
  ): Promise<T | undefined> {
    const parsed = parseRegistry(await readTextFile(this.paths.registry));
    if (parsed.state === 'newer') throw new RegistryVersionError(parsed.version ?? REGISTRY_VERSION);
    if (onlyIfClean && !isClean(parsed)) return undefined;
    const file = parsed.file;
    const before = JSON.stringify(file);
    const result = await mutator(file);
    file.version = REGISTRY_VERSION;
    if (JSON.stringify(file) !== before) {
      // The process that took over the lock read the file before this write: the write would undo its change. The token
      // is checked before the backup, and again after the temporary file is written, right before the rename. Only the
      // very short time between that last check and the rename is not covered: a takeover exactly then is not seen.
      const checkHeld = async (): Promise<void> => {
        if (!(await held())) throw new LockLostError(this.paths.registryLock);
      };
      await checkHeld();
      if (parsed.state === 'invalid' || parsed.dropped > 0 || parsed.droppedRecords > 0 || parsed.old > 0) await this.backup(parsed);
      await retryTransient(() => writeJsonAtomic(this.paths.registry, file, { beforeRename: checkHeld }));
    }
    return result;
  }

  /** Keeps a copy of a file whose content the next write would lose (invalid file, invalid or old entries). */
  private async backup(parsed: ParsedRegistry): Promise<void> {
    const copy = `${this.paths.registry}.backup-${this.clock.now()}`;
    await retryTransient(() => fs.promises.copyFile(this.paths.registry, copy));
    const reason =
      parsed.state === 'invalid'
        ? 'was not valid'
        : parsed.dropped > 0
          ? `contained ${parsed.dropped} invalid devspace entries`
          : parsed.droppedRecords > 0
            ? `contained ${parsed.droppedRecords} invalid records of kept volumes`
            : `contained ${parsed.old} entries of version 0.2.1 or older`;
    this.logger.warn(`The devspace registry ${reason}. A copy was saved as ${copy}.`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Normalization

interface ParsedRegistry {
  /** `invalid`: not JSON, not an object, no or an unknown version, or `devspaces` is not a list. */
  state: 'missing' | 'ok' | 'invalid' | 'newer';
  file: RegistryFile;
  /** Version of a newer file. */
  version?: number;
  /** Number of entries left out (invalid, or a repeated ID). */
  dropped: number;
  /** Number of records of kept volumes left out as invalid (a list that is no list counts as one). */
  droppedRecords: number;
  /**
   * Number of entries of version 0.2.1 or older left out (isOldEntry). A restore cannot bring them back, so they do not
   * count as lost content (needsRestore, isClean); the next write keeps a copy of the file first.
   */
  old: number;
}

/**
 * True when a write would lose nothing that a restore needs: the file exists, is valid, and has no invalid entries nor
 * invalid records of kept volumes.
 */
function isClean(parsed: ParsedRegistry): boolean {
  return parsed.state === 'ok' && parsed.dropped === 0 && parsed.droppedRecords === 0;
}

function emptyRegistry(): RegistryFile {
  return { version: REGISTRY_VERSION, devspaces: [] };
}

function parseRegistry(text: string | undefined): ParsedRegistry {
  if (text === undefined) return { state: 'missing', file: emptyRegistry(), dropped: 0, droppedRecords: 0, old: 0 };
  const value = parseJson(text);
  if (!isRecord(value)) return { state: 'invalid', file: emptyRegistry(), dropped: 0, droppedRecords: 0, old: 0 };

  // Every file that this extension writes has a version: a file without one is invalid.
  const version = value.version;
  if (version !== REGISTRY_VERSION) {
    if (typeof version === 'number' && Number.isFinite(version) && version > REGISTRY_VERSION) {
      return { state: 'newer', file: emptyRegistry(), version, dropped: 0, droppedRecords: 0, old: 0 };
    }
    return { state: 'invalid', file: emptyRegistry(), dropped: 0, droppedRecords: 0, old: 0 };
  }
  if (value.devspaces !== undefined && !Array.isArray(value.devspaces)) {
    return { state: 'invalid', file: emptyRegistry(), dropped: 0, droppedRecords: 0, old: 0 };
  }

  const entries: unknown[] = Array.isArray(value.devspaces) ? value.devspaces : [];
  const ids = new Set<string>();
  const devspaces: Devspace[] = [];
  let old = 0;
  for (const entry of entries) {
    if (isOldEntry(entry)) {
      old++;
      continue;
    }
    const devspace = normalizeDevspace(entry);
    if (!devspace || ids.has(devspace.id)) continue;
    ids.add(devspace.id);
    devspaces.push(devspace);
  }
  // Invalid records of kept volumes are left out. That makes the policy looser (the volume of such a record is no longer
  // refused to other accounts), so the next write keeps a copy of the file first, as for invalid entries.
  let droppedRecords = 0;
  if (value.keptVolumes !== undefined) {
    const kept = Array.isArray(value.keptVolumes) ? value.keptVolumes.filter(isKeptVolume) : [];
    droppedRecords = Array.isArray(value.keptVolumes) ? value.keptVolumes.length - kept.length : 1;
    if (kept.length > 0) value.keptVolumes = kept;
    else delete value.keptVolumes;
  }
  // The parsed object is kept, so fields that this version does not know survive a read-modify-write.
  value.version = REGISTRY_VERSION;
  value.devspaces = devspaces;
  return { state: 'ok', file: value as unknown as RegistryFile, dropped: entries.length - old - devspaces.length, droppedRecords, old };
}

type Check = (value: unknown) => boolean;

const OPTIONAL_FIELDS: ReadonlyArray<readonly [keyof Devspace, Check]> = [
  ['gitSummary', isGitSummary],
  ['lastSeenInUseAt', isString],
  ['buildRecord', isBuildRecord],
  // The default image of the last open (DevspaceSource).
  ['defaultImage', isImageReference],
  ['busy', isBusyMark],
  ['remoteUser', isString],
  ['remoteWorkspaceFolder', isString],
  ['shutdownActionNone', (value) => typeof value === 'boolean'],
  ['additionalVolumes', (value) => Array.isArray(value) && value.every(isNonEmptyString)],
  ['serviceVolumes', (value) => Array.isArray(value) && value.every(isNonEmptyString)],
  ['serviceFolders', (value) => Array.isArray(value) && value.every(isNonEmptyString)],
  ['serviceFoldersOverflow', (value) => typeof value === 'boolean'],
  ['lastBuildNumber', isCount],
  ['refusedUpdate', isRefusedUpdate],
  ['keepRunning', (value) => typeof value === 'boolean'],
  // Close and Keep Running.
  ['keepRunningOnce', (value) => typeof value === 'boolean'],
  // The Docker host; '' is the local Docker, as a missing field.
  ['dockerHost', isNonEmptyString],
  // A container whose lifecycle commands did not run.
  ['lifecycleIncomplete', isNonEmptyString],
];

/** The start of the names of the devspaces of version 0.2.1 and older (since then RESOURCE_NAME_PREFIX). */
const OLD_RESOURCE_NAME_PREFIX = 'devspace-';

/**
 * True for an entry of version 0.2.1 or older: its volume name starts with OLD_RESOURCE_NAME_PREFIX. Its volume and
 * container have the old names and labels, which this version does not use (docs/guide.md, "Update from version 0.2.1
 * or older"), so the entry is left out: a start creates a new devspace instead of one with an old name.
 */
function isOldEntry(value: unknown): boolean {
  return isRecord(value) && isNonEmptyString(value.volumeName) && value.volumeName.toLowerCase().startsWith(OLD_RESOURCE_NAME_PREFIX);
}

/**
 * Checks one entry in place. An entry without a usable ID, repository, volume name, container name, or owner is left out.
 * Missing configuration path and times get defaults. Invalid optional fields are removed. Unknown fields are kept.
 */
function normalizeDevspace(value: unknown): Devspace | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !isNonEmptyString(value.id) ||
    !isRepositoryName(value.repository) ||
    !isNonEmptyString(value.volumeName) ||
    !isNonEmptyString(value.containerName) ||
    !isOwner(value.owner)
  ) {
    return undefined;
  }
  if (!isNonEmptyString(value.configPath)) value.configPath = DEFAULT_CONFIG_PATH;
  if (!isString(value.createdAt)) value.createdAt = EPOCH;
  if (!isString(value.lastUsedAt)) value.lastUsedAt = value.createdAt;
  for (const [key, check] of OPTIONAL_FIELDS) {
    if (key in value && !check(value[key])) delete value[key];
  }
  return value as unknown as Devspace;
}

export function isBuildRecord(value: unknown): value is BuildRecord {
  return (
    isRecord(value) &&
    isString(value.builtAt) &&
    isNonEmptyString(value.devspaceImage) &&
    (value.imageId === undefined || isNonEmptyString(value.imageId)) &&
    isCount(value.buildNumber) &&
    isString(value.configPath) &&
    isString(value.configHash) &&
    (value.defaultImage === undefined || isImageReference(value.defaultImage)) &&
    isStringRecord(value.images) &&
    isStringRecord(value.features)
  );
}

function isRefusedUpdate(value: unknown): value is RefusedUpdate {
  return (
    isRecord(value) &&
    isString(value.configPath) &&
    isString(value.configHash) &&
    isStringRecord(value.images) &&
    isStringRecord(value.features) &&
    isString(value.items)
  );
}

/** A record of a volume that a Delete kept: its name, the time, and the owner account. */
function isKeptVolume(value: unknown): value is KeptVolume {
  return isRecord(value) && isNonEmptyString(value.name) && isString(value.keptAt) && isOwner(value.owner);
}

/** The owner account: a GitHub user ID and a login (empty after a restore from the volume labels). */
function isOwner(value: unknown): value is GitHubAccount {
  return isRecord(value) && isStorageId(value.id) && isString(value.login);
}

function isBusyMark(value: unknown): value is BusyMark {
  // Any operation name is accepted: a mark of a newer version must still protect the container.
  return (
    isRecord(value) &&
    isNonEmptyString(value.operation) &&
    isString(value.since) &&
    isCount(value.pid) &&
    value.pid > 0 &&
    isString(value.windowId)
  );
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** A default image (Devspace.defaultImage, BuildRecord.defaultImage): an image reference, as the worker checks it. */
function isImageReference(value: unknown): value is string {
  return isNonEmptyString(value) && parseImageReference(value) !== undefined;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(isString);
}

function isRepositoryName(value: unknown): value is string {
  return typeof value === 'string' && /^[^/\s]+\/[^/\s]+$/.test(value);
}

function withoutLeadingSlash(name: string): string {
  return name.startsWith('/') ? name.slice(1) : name;
}
