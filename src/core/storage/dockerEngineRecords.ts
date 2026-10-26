// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// What Devspaces remembers about each Docker engine, in `docker-engines.json` of the global storage folder: that the
// user answered the question about the Monitor of the engine (src/vscode/monitorQuestion.ts), and that the user removed
// Devspaces from the engine ("Remove Devspaces from This Docker Engine…"). Before that answer, the Monitor of the engine
// stops when no devspace runs (src/vscode/monitorSettings.ts). While the removal mark is set, this computer does no
// Docker work on the engine by itself (extension.ts); a Start, a Rebuild or "Update All Images Now" of the user there
// clears it. While a window removes Devspaces from the engine, the record also names that removal (`removing`), so that
// no other window clears the mark meanwhile. An engine is named by its Docker host (DockerTarget.host): empty for the
// local Docker, the SSH host otherwise. A file that is missing or not valid knows no engine. A file that cannot be read is an error, after the
// retries of a transient error of Windows (a virus scanner holds the file for a moment), so that a change never writes
// over the records of other engines that it could not read. Several windows change the file: every change runs under
// the lock folder next to it (`docker-engines.lock`, as registry.json does), so no change of another window is lost,
// such as the removal mark, also not when a window stalls while it holds the lock (the token of withLockFolder). No
// `vscode`.
import * as fs from 'fs';
import * as path from 'path';
import type { WindowMark } from '../busy';
import { silentLogger, type Logger } from '../ports';
import { writeJsonAtomic } from './atomicJson';
import { DEFAULT_LOCK_STALE_MS, DEFAULT_LOCK_TIMEOUT_MS, LockLostError, withLockFolder, type LockTimings } from './lockFolder';
import { parseJson, readTextFile, retryTransient } from './paths';

/**
 * A removal of Devspaces from an engine that runs in a window of this computer: the window, the process of its
 * extension host, and the start (an ISO time). A busy mark without its operation, so that the liveness rule of the busy
 * marks tells whether it still runs (isBlockingBusyMark, core/busy.ts): the entry of a window that crashed blocks
 * nothing.
 */
export type EngineRemoval = WindowMark;

export interface DockerEngineRecord {
  /** The Docker host of the engine: '' for the local Docker. */
  host: string;
  /** When the user answered the question about the Monitor of the engine (milliseconds since the epoch). */
  monitorAnsweredAt?: number;
  /** When the user removed Devspaces from the engine (milliseconds since the epoch); the removal mark. */
  removedAt?: number;
  /**
   * The removal that runs on the engine: written with the removal mark before anything is removed (startRemoval), and
   * removed at its end (endRemoval). While its window lives, no other window clears the mark (clearRemoved).
   */
  removing?: EngineRemoval;
}

/** What startRemoval did: started, with the record from before; or nothing, because `other` runs on the engine. */
export type RemovalStart = { started: true; before: DockerEngineRecord } | { started: false; other: EngineRemoval };

export interface DockerEnginesFile {
  engines?: DockerEngineRecord[];
}

export interface DockerEngineRecordsOptions {
  /** For the warning about a file that is not valid. Default: no log. */
  logger?: Logger;
  /** A lock folder older than this counts as stale (its holder crashed). Default: 10 seconds. */
  lockStaleMs?: number;
  /** Maximum wait for the lock. Default: 15 seconds. */
  lockTimeoutMs?: number;
}

export class DockerEngineRecords {
  /** The lock folder of the changes: `<name>.lock` next to the file (`docker-engines.lock`). */
  readonly lockDir: string;
  private readonly lockTimings: LockTimings;
  private readonly logger: Logger;

  constructor(readonly file: string, options: DockerEngineRecordsOptions = {}) {
    this.lockDir = path.join(path.dirname(file), `${path.basename(file, '.json')}.lock`);
    this.logger = options.logger ?? silentLogger;
    this.lockTimings = {
      staleMs: options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS,
      timeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    };
  }

  /**
   * The records of the file; an entry that is not valid, one that records nothing, and a second entry of a host are
   * left out. A missing file, and one that is not valid, know no engine. Throws when the file cannot be read; a
   * transient error of Windows (isTransientFsError) is tried again first.
   */
  async read(): Promise<DockerEngineRecord[]> {
    return (await this.readFile()).records;
  }

  /** The record of the engine `host`; undefined when the file records nothing for it. Throws as read. */
  async record(host: string): Promise<DockerEngineRecord | undefined> {
    return (await this.read()).find((record) => record.host === host);
  }

  /** True when the user answered the question about the Monitor of the engine `host`. */
  async monitorAnswered(host: string): Promise<boolean> {
    return (await this.read()).some((record) => record.host === host && record.monitorAnsweredAt !== undefined);
  }

  /**
   * Records that the user answered the question about the Monitor of the engine `host` at `now`. Nothing is written
   * while the record names a removal for which `runs` is true (another window removes Devspaces from the engine now: its
   * mark forgot the answer, and the next flow of the user there asks again); `other` is that removal then. Without
   * `runs`, every removal that the record names counts as running.
   */
  async recordMonitorAnswer(host: string, now: number, runs: (removal: EngineRemoval) => boolean = () => true): Promise<{ recorded: boolean; other?: EngineRemoval }> {
    let outcome: { recorded: boolean; other?: EngineRemoval } = { recorded: false };
    await this.change(host, (record) => {
      if (record.removing !== undefined && runs(record.removing)) {
        outcome = { recorded: false, other: record.removing };
        return undefined;
      }
      outcome = { recorded: true };
      return { ...record, monitorAnsweredAt: now };
    });
    return outcome;
  }

  /** True while the engine `host` has the removal mark. */
  async removed(host: string): Promise<boolean> {
    return (await this.read()).some((record) => record.host === host && record.removedAt !== undefined);
  }

  /**
   * The removal that the record of the engine `host` names (DockerEngineRecord.removing), also one whose window has
   * ended: the caller applies the liveness rule. Throws as read.
   */
  async removing(host: string): Promise<EngineRemoval | undefined> {
    return (await this.record(host))?.removing;
  }

  /**
   * Sets the removal mark of the engine `host` (`removedAt`), or clears it (undefined). Setting it also forgets the
   * answer about the Monitor of the engine: the next user-started flow there asks again.
   */
  async setRemoved(host: string, removedAt: number | undefined): Promise<void> {
    await this.change(host, (record) => {
      if (removedAt !== undefined) return { ...(record.removing !== undefined ? { removing: record.removing } : {}), host, removedAt };
      const rest = { ...record };
      delete rest.removedAt;
      return rest;
    });
  }

  /**
   * Starts the removal `removal` on the engine `host` in one change: the removal mark (`removedAt`, which also forgets
   * the answer about the Monitor, as setRemoved does) and the entry `removing`. Nothing is written while the record
   * names another removal for which `runs` is true (another window removes Devspaces from the engine now); that removal
   * is returned then. Otherwise the record from before, which endRemoval brings back when the removal stops early.
   */
  async startRemoval(host: string, removal: EngineRemoval, removedAt: number, runs: (other: EngineRemoval) => boolean): Promise<RemovalStart> {
    let start: RemovalStart | undefined;
    await this.change(host, (record) => {
      if (record.removing !== undefined && !sameRemoval(record.removing, removal) && runs(record.removing)) {
        start = { started: false, other: record.removing };
        return undefined;
      }
      start = { started: true, before: record };
      return { host, removedAt, removing: removal };
    });
    // change() runs `update` before it resolves (once more after a lost lock: the last run counts).
    return start as RemovalStart;
  }

  /**
   * Ends the removal `removal` on the engine `host`: its entry `removing` goes, and the removal mark stays. With `before`
   * (startRemoval: the removal stopped before it removed anything), the removal mark is the one from before again (none
   * when there was none), and an answer about the Monitor from before comes back unless a newer one was given. Nothing
   * changes when the record names another removal, or none.
   */
  async endRemoval(host: string, removal: EngineRemoval, before?: DockerEngineRecord): Promise<void> {
    await this.change(host, (record) => {
      if (record.removing === undefined || !sameRemoval(record.removing, removal)) return undefined;
      const rest = { ...record };
      delete rest.removing;
      if (before === undefined) return rest;
      delete rest.removedAt;
      const answeredAt = rest.monitorAnsweredAt ?? before.monitorAnsweredAt;
      return {
        ...rest,
        ...(before.removedAt !== undefined ? { removedAt: before.removedAt } : {}),
        ...(answeredAt !== undefined ? { monitorAnsweredAt: answeredAt } : {}),
      };
    });
  }

  /**
   * Clears the removal mark of the engine `host` (a flow of the user there), and with it the entry of a removal that
   * does not run anymore. Refused, with nothing written, while the record names a removal for which `runs` is true
   * (another window removes Devspaces from the engine now): `other` is that removal then. `cleared`: a mark was cleared.
   */
  async clearRemoved(host: string, runs: (removal: EngineRemoval) => boolean): Promise<{ cleared: boolean; other?: EngineRemoval }> {
    let outcome: { cleared: boolean; other?: EngineRemoval } = { cleared: false };
    await this.change(host, (record) => {
      // Set on each run: after a lost lock, the second run counts (change).
      outcome = { cleared: false };
      if (record.removing !== undefined && runs(record.removing)) {
        outcome = { cleared: false, other: record.removing };
        return undefined;
      }
      if (record.removedAt === undefined && record.removing === undefined) return undefined;
      outcome = { cleared: record.removedAt !== undefined };
      const rest = { ...record };
      delete rest.removedAt;
      delete rest.removing;
      return rest;
    });
    return outcome;
  }

  /**
   * Writes the record of `host` that `update` makes of the current one (an empty record when there is none); a record
   * with nothing but its host is left out, and `undefined` writes nothing. The read and the write run under the lock
   * folder `lockDir`, so a change of another window between them is not lost. Throws, and writes nothing, when the lock
   * is not free within the wait or the file cannot be read (read). A file that is not valid knows no engine: a copy of
   * it is kept first, as registry.json does, so that a repair by hand can bring back what it held. If another process
   * took over the lock meanwhile (this process stalled longer than the stale time, see withLockFolder), nothing is
   * written and the whole change runs once more on the current records, as for registry.json: `update` can run twice,
   * and the outcome of its last run counts.
   */
  private async change(host: string, update: (record: DockerEngineRecord) => DockerEngineRecord | undefined): Promise<void> {
    const run = () => withLockFolder(this.lockDir, (held) => this.changeLocked(host, update, held), this.lockTimings);
    try {
      await run();
    } catch (error) {
      if (!(error instanceof LockLostError)) throw error;
      this.logger.warn(`${error.message} The change runs again on the current records.`);
      await run();
    }
  }

  /** The read and the write of `change`, while this process holds the lock folder (`held`: it still does). */
  private async changeLocked(
    host: string,
    update: (record: DockerEngineRecord) => DockerEngineRecord | undefined,
    held: () => Promise<boolean>,
  ): Promise<void> {
    const { records, invalid } = await this.readFile();
    const others = records.filter((record) => record.host !== host);
    const next = update(records.find((record) => record.host === host) ?? { host });
    if (next === undefined) return;
    // The process that took over the lock read the file before this write: the write would undo its change. The token
    // is checked before the copy, and again after the temporary file is written, right before the rename.
    const checkHeld = async (): Promise<void> => {
      if (!(await held())) throw new LockLostError(this.lockDir);
    };
    await checkHeld();
    if (invalid) await this.keepCopy();
    const engines = Object.keys(next).length > 1 ? [...others, next] : others;
    await retryTransient(() => writeJsonAtomic(this.file, { engines } satisfies DockerEnginesFile, { beforeRename: checkHeld }));
  }

  /** The records of the file (see read), and whether a file is there that is not valid. */
  private async readFile(): Promise<{ records: DockerEngineRecord[]; invalid: boolean }> {
    const text = await readTextFile(this.file);
    if (text === undefined) return { records: [], invalid: false };
    const value = parseJson(text);
    return { records: normalize(value), invalid: !isEnginesFile(value) };
  }

  /** Keeps a copy of a file that is not valid before a change writes over it: `<file>.backup-<time>`. */
  private async keepCopy(): Promise<void> {
    const copy = `${this.file}.backup-${Date.now()}`;
    await retryTransient(() => fs.promises.copyFile(this.file, copy));
    this.logger.warn(`The records of the Docker engines were not valid, so they count as none. A copy was saved as ${copy}.`);
  }
}

/** True for the content of a valid file: an object with the list `engines`. */
function isEnginesFile(value: unknown): boolean {
  return typeof value === 'object' && value !== null && Array.isArray((value as DockerEnginesFile).engines);
}

/** A time of the file: a whole number of milliseconds, not negative. */
function timeOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** The entry `removing` of the file: a window ID, a process ID, and a start (a `since` that cannot be parsed stays). */
function removalOf(value: unknown): EngineRemoval | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { windowId, pid, since } = value as Record<string, unknown>;
  if (typeof windowId !== 'string' || windowId === '' || typeof since !== 'string') return undefined;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  return { windowId, pid, since };
}

/** The same removal: the same window, process and start. */
function sameRemoval(a: EngineRemoval, b: EngineRemoval): boolean {
  return a.windowId === b.windowId && a.pid === b.pid && a.since === b.since;
}

function normalize(value: unknown): DockerEngineRecord[] {
  if (!isEnginesFile(value)) return [];
  const records: DockerEngineRecord[] = [];
  for (const entry of (value as DockerEnginesFile).engines as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { host, monitorAnsweredAt, removedAt, removing } = entry as Record<string, unknown>;
    if (typeof host !== 'string' || records.some((record) => record.host === host)) continue;
    const answeredAt = timeOf(monitorAnsweredAt);
    const removed = timeOf(removedAt);
    const removal = removalOf(removing);
    if (answeredAt === undefined && removed === undefined && removal === undefined) continue;
    records.push({
      host,
      ...(answeredAt !== undefined ? { monitorAnsweredAt: answeredAt } : {}),
      ...(removed !== undefined ? { removedAt: removed } : {}),
      ...(removal !== undefined ? { removing: removal } : {}),
    });
  }
  return records;
}
