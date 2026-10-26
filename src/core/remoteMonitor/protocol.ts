// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The protocol between the computers and the Monitor of a Docker engine (one on every engine): the names of its
// container, volume, and label, the heartbeat records in its volume, the subcommands of its script
// (src/remoteMonitor/main.ts, part of the worker's bundle dist/helperChannel.js), and the strict checks of everything
// that script reads.
// Pure functions without I/O; the script and the extension use the same checks. No `vscode`.
import { createHash } from 'crypto';
import { PIPE_LOADER } from '../loader/pipeLoader';
import { parseCacheSchedule } from './cacheSettings';
import { isTimeZone } from './cron';
import { hasExactKeys, hasOnlyKeys, isRecord } from '../valueChecks';

/**
 * The one Monitor container per Docker engine (never a container of a devspace: no
 * nimblescape.devspaces.id).
 */
export const REMOTE_MONITOR_CONTAINER = 'devspaces-monitor';
/** The volume of its heartbeat records, mounted at REMOTE_MONITOR_STATE_DIR. */
export const REMOTE_MONITOR_VOLUME = 'devspaces-monitor';
/** Label of the container: 12 hex digits of sha256 of the script, the helper tag and the loader (remoteMonitorLabelValue). */
export const LABEL_MONITOR = 'nimblescape.devspaces.monitor';
/**
 * A label with a random nonce per create of the monitor container (not part of
 * remoteMonitorLabelValue). A failed create removes only the container with its own nonce (`docker ps -aq --filter
 * label=…`, then `docker rm -f <id>`), never the container of the name, which may be that of another window by then.
 */
export const LABEL_MONITOR_CREATE = 'nimblescape.devspaces.monitor-create';
/**
 * The label of a permanent monitor with the ID of the computer that created it (not part of remoteMonitorLabelValue):
 * an ensure that wants a monitor that ends when idle replaces its own permanent one, never one that another computer
 * keeps (RemoteSessionMonitor).
 */
export const LABEL_MONITOR_OWNER = 'nimblescape.devspaces.monitor-owner';
/**
 * Where the pipe loader stores the script (its own file system, so it matches the container version). A
 * restart of the container starts it from there without new input (resume); the `docker exec` subcommands run it too.
 */
export const REMOTE_MONITOR_SCRIPT_PATH = '/opt/devspace/monitor.js';
/** The function of the script that the pipe loader starts (src/remoteMonitor/main.ts): the loop, `run`. */
export const REMOTE_MONITOR_ENTRY = 'startMonitor';
/**
 * The start of the log line with which `run` says that it started. The extension waits for it on the output of the
 * attached `docker run` before it lets the container go (RemoteSessionMonitor.ensure).
 */
export const REMOTE_MONITOR_READY_TEXT = 'Monitor started';
/** The mount point of REMOTE_MONITOR_VOLUME in the container. */
export const REMOTE_MONITOR_STATE_DIR = '/state';
/** The folder of the heartbeat records in the volume: `<source>.<devspace id>.json`. */
export const HEARTBEAT_FOLDER = 'heartbeats';
/** The kernel lock (`flock`) of the heartbeat records, in the volume (underRecordsLock). */
export const HEARTBEAT_LOCK_PATH = `${REMOTE_MONITOR_STATE_DIR}/.heartbeats.lock`;
/** How long a heartbeat waits for HEARTBEAT_LOCK_PATH, in seconds. */
export const HEARTBEAT_LOCK_WAIT_SECONDS = 5;
/** A heartbeat that holds HEARTBEAT_LOCK_PATH longer than this, in seconds, is killed (the lock with it). */
export const HEARTBEAT_RUN_LIMIT_SECONDS = 10;

/** Default of the setting devspaces.stopAfterMinutes (10 minutes, on every engine). */
export const DEFAULT_REMOTE_STOP_AFTER_SECONDS = 600;
/** The smallest time limit that a heartbeat can set. */
export const MIN_LIMIT_SECONDS = 60;
/** The largest time limit that a heartbeat can set (one day). */
export const MAX_LIMIT_SECONDS = 86_400;
/** At most this many devspaces in one heartbeat. */
export const MAX_HEARTBEAT_DEVSPACES = 200;
/** The longest heartbeat argument that the script accepts. */
export const MAX_HEARTBEAT_LENGTH = 32_000;
const SOURCE_PATTERN = /^[0-9a-f]{32}$/;
/** The form of `newDevspaceId` (crypto.randomUUID, lower case). */
const DEVSPACE_ID_PATTERN = /^[0-9a-f-]{36}$/;
const RECORD_NAME_PATTERN = /^([0-9a-f]{32})\.([0-9a-f-]{36})\.json$/;

/** True for the id of a computer (`computer.id`): 32 lower-case hex digits. */
export function isSourceId(value: unknown): value is string {
  return typeof value === 'string' && SOURCE_PATTERN.test(value);
}

/** True for a devspace id as newDevspaceId makes it (36 characters of lower-case hex digits and `-`). */
export function isRemoteDevspaceId(value: unknown): value is string {
  return typeof value === 'string' && DEVSPACE_ID_PATTERN.test(value);
}

/**
 * One devspace of a heartbeat. `seq`: the wall clock of the sending computer, in ms, at which it read the keep flag
 * (the Monitor: its tick; a window: right after it changed the flag). The remote monitor does not replace a
 * recent record of the same source with a higher `seq` (SEQ_ORDER_WINDOW_MS), so a heartbeat that was under way while
 * the flag changed cannot undo the newer choice.
 *
 * `clearOnly` (only with keepRunning false): the entry only withdraws a keep of this same source. The remote monitor
 * writes it only when the existing record of this source says keepRunning; otherwise it writes nothing for it (no new
 * record, no new `at`), so it is no choice about the devspace and cannot overrule the keep of another computer.
 *
 * `stopNow` (only with keepRunning false, never with `clearOnly` nor in a release): a manual Stop. The monitor writes
 * the record with the flag, and while that record is the newest of the devspace it stops the devspace's
 * containers itself (rules.ts, decide), so a Stop is not lost when VS Code quits before the window's own stop reaches
 * Docker. An older monitor refuses the whole heartbeat (`Invalid heartbeat.`, its strict check of the keys), so a
 * stopNow always goes in a heartbeat of its own.
 */
export interface HeartbeatEntry {
  id: string;
  keepRunning: boolean;
  seq: number;
  clearOnly?: true;
  stopNow?: true;
}

/**
 * The seq order holds only while the stored record is at most this old by the clock of the remote host: the time in
 * which a heartbeat can be under way (a `docker exec` ends after 20 s). An older record is replaced whatever its `seq`,
 * so a clock of the sending computer that was set back does not block its heartbeats.
 */
export const SEQ_ORDER_WINDOW_MS = 60_000;

/**
 * One heartbeat: the computer, its time limit, and the devspaces it uses or keeps. `release`: the short release of a
 * window that left the devspace (windowRelease.ts); its records carry it, and the monitor lets such a record decide
 * only while no record of another source is still within its own limit (rules.ts, decide), so a release never shortens
 * the heartbeats of another computer.
 */
export interface HeartbeatInput {
  source: string;
  limitSeconds: number;
  devspaces: HeartbeatEntry[];
  release?: true;
}

/**
 * A heartbeat record in the volume. `at` is the clock of the remote host at the write, so the clocks of the computers do
 * not matter; `seq` is the one of the entry (HeartbeatEntry).
 */
export interface HeartbeatRecord {
  at: number;
  keepRunning: boolean;
  limitSeconds: number;
  seq: number;
  /** Written by a release (HeartbeatInput.release). */
  release?: true;
  /** Written by a manual Stop (HeartbeatEntry.stopNow). */
  stopNow?: true;
}

function isSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** A time limit in whole seconds within MIN_LIMIT_SECONDS..MAX_LIMIT_SECONDS; the default for a value that is no number. */
export function clampLimitSeconds(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_REMOTE_STOP_AFTER_SECONDS;
  return Math.min(MAX_LIMIT_SECONDS, Math.max(MIN_LIMIT_SECONDS, Math.round(value)));
}

/**
 * The argument of `monitor.js heartbeat`, checked strictly: a JSON object with exactly `source` (isSourceId),
 * `limitSeconds` (an integer, clamped to MIN_LIMIT_SECONDS..MAX_LIMIT_SECONDS), and `devspaces` (at most
 * MAX_HEARTBEAT_DEVSPACES objects with exactly `id` (isRemoteDevspaceId), `keepRunning` (a boolean), and `seq` (a
 * safe non-negative integer), and optionally `clearOnly` (a boolean; true only with keepRunning false) or `stopNow`
 * (only `true`, only with keepRunning false and without `clearOnly`)), and optionally `release` (only `true`, and then
 * no entry with `stopNow`). `undefined` for anything else; then nothing is written.
 */
export function parseHeartbeatInput(text: string): HeartbeatInput | undefined {
  if (text.length > MAX_HEARTBEAT_LENGTH) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  // Optionally `release` (true only).
  if (!isRecord(value)) return undefined;
  const keys = 'release' in value ? ['source', 'limitSeconds', 'devspaces', 'release'] : ['source', 'limitSeconds', 'devspaces'];
  if (!hasExactKeys(value, keys)) return undefined;
  if ('release' in value && value.release !== true) return undefined;
  const { source, limitSeconds, devspaces } = value;
  if (!isSourceId(source) || typeof limitSeconds !== 'number' || !Number.isInteger(limitSeconds)) return undefined;
  if (!Array.isArray(devspaces) || devspaces.length > MAX_HEARTBEAT_DEVSPACES) return undefined;
  const checked: HeartbeatInput['devspaces'] = [];
  for (const entry of devspaces) {
    if (!isRecord(entry)) return undefined;
    // Optionally `stopNow` (true only, with keepRunning false, never with `clearOnly`).
    const keys = ['id', 'keepRunning', 'seq', ...['clearOnly', 'stopNow'].filter((key) => key in entry)];
    if (!hasExactKeys(entry, keys)) return undefined;
    if (!isRemoteDevspaceId(entry.id) || typeof entry.keepRunning !== 'boolean' || !isSeq(entry.seq)) return undefined;
    if ('clearOnly' in entry && (typeof entry.clearOnly !== 'boolean' || (entry.clearOnly && entry.keepRunning))) return undefined;
    if ('stopNow' in entry && (entry.stopNow !== true || entry.keepRunning || 'clearOnly' in entry || value.release === true)) return undefined;
    const checkedEntry: HeartbeatEntry = { id: entry.id, keepRunning: entry.keepRunning, seq: entry.seq };
    if (entry.clearOnly === true) checkedEntry.clearOnly = true;
    if (entry.stopNow === true) checkedEntry.stopNow = true;
    checked.push(checkedEntry);
  }
  const input: HeartbeatInput = { source, limitSeconds: clampLimitSeconds(limitSeconds), devspaces: checked };
  if (value.release === true) input.release = true;
  return input;
}

/** The content of a record file; `undefined` for anything that is not a valid record. */
export function parseHeartbeatRecord(text: string): HeartbeatRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const { at, keepRunning, limitSeconds, seq, release, stopNow } = value;
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) return undefined;
  if (typeof keepRunning !== 'boolean' || !isSeq(seq)) return undefined;
  if (typeof limitSeconds !== 'number' || !Number.isInteger(limitSeconds) || limitSeconds < MIN_LIMIT_SECONDS || limitSeconds > MAX_LIMIT_SECONDS) {
    return undefined;
  }
  // A release record; any other value of `release` is no valid record.
  if (release !== undefined && release !== true) return undefined;
  // A record of a manual Stop; only `true`, only without keepRunning and not of a release.
  if (stopNow !== undefined && (stopNow !== true || keepRunning || release !== undefined)) return undefined;
  const record: HeartbeatRecord = { at, keepRunning, limitSeconds, seq };
  if (release === true) record.release = true;
  if (stopNow === true) record.stopNow = true;
  return record;
}

/** The file name of the record of `source` for `devspaceId`. Throws for an invalid id. */
export function heartbeatFileName(source: string, devspaceId: string): string {
  if (!isSourceId(source) || !isRemoteDevspaceId(devspaceId)) throw new Error('Invalid heartbeat record name.');
  return `${source}.${devspaceId}.json`;
}

/** The parts of a record file name; `undefined` for any other name (temporary files, foreign files). */
export function parseHeartbeatFileName(name: string): { source: string; devspaceId: string } | undefined {
  const match = RECORD_NAME_PATTERN.exec(name);
  return match ? { source: match[1], devspaceId: match[2] } : undefined;
}

/** The exit code of a command under the lock of the records that did not get the lock in time (`flock -E`). */
export const RECORDS_LOCK_BUSY_EXIT = 75;
/** The exit code of a command under the lock of the records that `timeout -s KILL` ended (128 + SIGKILL). */
export const RECORDS_RUN_LIMIT_EXIT = 137;

/**
 * `command` under the kernel lock `flock` (util-linux) of HEARTBEAT_LOCK_PATH.
 *
 * Two heartbeats (two `docker exec` at the same time) read and replace the records one after the other. The kernel
 * releases the lock when its process ends, also when it is killed, so no lock is ever left over; a command that does
 * not get the lock within HEARTBEAT_LOCK_WAIT_SECONDS fails with RECORDS_LOCK_BUSY_EXIT and writes nothing, and one
 * that holds it longer than HEARTBEAT_RUN_LIMIT_SECONDS is killed (`timeout`, coreutils; RECORDS_RUN_LIMIT_EXIT), so a
 * hanging heartbeat cannot block the others. Together at most 15 s, within the 20 s of a `docker exec` of a heartbeat.
 * The prefix of the entries monitorHeartbeat and monitorForget of the registry of the container scripts
 * (src/core/worker/containerScripts.ts), and of forgetIfUnchangedCommand of the monitor itself.
 */
export function underRecordsLock(command: readonly string[]): string[] {
  return [
    'flock',
    '-w',
    String(HEARTBEAT_LOCK_WAIT_SECONDS),
    '-E',
    String(RECORDS_LOCK_BUSY_EXIT),
    HEARTBEAT_LOCK_PATH,
    'timeout',
    '-s',
    'KILL',
    String(HEARTBEAT_RUN_LIMIT_SECONDS),
    ...command,
  ];
}

/**
 * Whether `command` runs under the lock of the records (underRecordsLock: the entries monitorHeartbeat and monitorForget
 * of the registry, forgetIfUnchangedCommand).
 */
export function isUnderRecordsLock(command: readonly string[]): boolean {
  return command[0] === 'flock';
}

/**
 * The reason of a failed `docker exec` of the monitor: its stderr, else for a command under the lock of the records
 * (`underLock`) the busy lock or a kill by their exit codes, else the exit code. 137 is any SIGKILL (the time limit, an
 * OOM kill, a container removed meanwhile), so the text names both; a command without the lock gets the bare exit
 * code.
 */
export function monitorExecFailure(exitCode: number | null, stderr: string, underLock: boolean): string {
  const text = stderr.trim();
  if (text !== '') return text;
  if (underLock && exitCode === RECORDS_LOCK_BUSY_EXIT) {
    return `the heartbeat records stayed locked by another command for ${HEARTBEAT_LOCK_WAIT_SECONDS} s`;
  }
  if (underLock && exitCode === RECORDS_RUN_LIMIT_EXIT) {
    return `the command was killed (its limit of ${HEARTBEAT_RUN_LIMIT_SECONDS} s, or a kill from outside)`;
  }
  return `exit code ${exitCode}`;
}

// The commands that the worker runs in the monitor container (a heartbeat, Delete's forget, the image settings and
// list) are entries of the registry of the container scripts (monitorHeartbeat, monitorForget, monitorSettings,
// monitorImages in src/core/worker/containerScripts.ts). Delete's forget runs under the lock of the records, so a
// heartbeat that read the record before cannot write it back after.

/**
 * The command with which the monitor itself removes an old record (`forget` with the `at` of the record as it read it),
 * under the lock of the records: it removes the record only when its `at` is still that one, so a heartbeat written
 * after the read stays. It prints `removed` when it removed it.
 */
export function forgetIfUnchangedCommand(source: string, devspaceId: string, at: number): string[] {
  return underRecordsLock(['node', REMOTE_MONITOR_SCRIPT_PATH, 'forget', source, devspaceId, String(at)]);
}

// ---- The images of the engine (on every engine): the image references in use are kept up to date, and what stays
// follows them, not a version order ----

/**
 * The longest input of `monitor.js images -`: 512 KiB, so the image references in use and their recorded digests fit
 * beside a full list of repositories (which an older extension may send, parseImagesInput).
 */
export const MAX_IMAGE_LIST_LENGTH = 512 * 1024;

// ---- The image references in use ----

/** At most this many image references in use of one computer (one input of `monitor.js images -`). */
export const MAX_IMAGE_REFERENCES = 200;
/**
 * The longest image reference in use. Every reference that the grammar allows fits (a name of at most 255 characters, a
 * tag of at most 128, a digest of 71: 456 with their separators); the bound stops a longer text before the pattern.
 */
export const MAX_IMAGE_REFERENCE_LENGTH = 512;
/**
 * The references in use that a computer sent count for the Monitor while they are at most this old (by the clock
 * of the engine's host): the union of the computers that opened a devspace on the engine within the last 30 days.
 */
export const IMAGES_IN_USE_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

/** An image reference split as the Docker reference grammar has it; `repository` as the engine lists it. */
export interface ImageReferenceParts {
  /** `ghcr.io/acme/base`, `mcr.microsoft.com/devcontainers/base`; Docker Hub without its registry (`node`, `acme/tool`). */
  repository: string;
  tag?: string;
  /** `sha256:<64 hex>`. */
  digest?: string;
}

const DOMAIN_COMPONENT = '[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?';
const PATH_COMPONENT = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*';
const IMAGE_REFERENCE = new RegExp(
  `^(?:(${DOMAIN_COMPONENT}(?:\\.${DOMAIN_COMPONENT})*(?::[0-9]{1,5})?)/)?(${PATH_COMPONENT}(?:/${PATH_COMPONENT})*)(?::(\\w[\\w.-]{0,127}))?(?:@(sha256:[0-9a-f]{64}))?$`,
);
const PATH_COMPONENT_ONLY = new RegExp(`^${PATH_COMPONENT}$`);

/**
 * An image reference as a configuration writes it (`node:20`, `mcr.microsoft.com/devcontainers/base:ubuntu`,
 * `ghcr.io/acme/base@sha256:…`), checked by the Docker reference grammar: an optional registry (its first part has a
 * `.`, a port or upper case, or is `localhost`), a path of lower-case parts, an optional tag and an optional sha256
 * digest; a name of at most 255 characters, the whole at most MAX_IMAGE_REFERENCE_LENGTH. The repository is the one
 * that the engine lists: Docker Hub (`docker.io`, `index.docker.io`) without its registry, and its official images
 * without `library/`. Undefined for anything else.
 */
export function parseImageReference(value: unknown): ImageReferenceParts | undefined {
  if (typeof value !== 'string' || value.length > MAX_IMAGE_REFERENCE_LENGTH) return undefined;
  const match = IMAGE_REFERENCE.exec(value);
  if (!match) return undefined;
  let domain: string | undefined = match[1];
  let path = match[2];
  const tag: string | undefined = match[3];
  const digest: string | undefined = match[4];
  // A first part without a `.`, a port or upper case, other than localhost, is a part of the path.
  if (domain !== undefined && !/[.:A-Z]/.test(domain) && domain !== 'localhost') {
    if (!PATH_COMPONENT_ONLY.test(domain)) return undefined;
    path = `${domain}/${path}`;
    domain = undefined;
  }
  if ((domain === undefined ? 0 : domain.length + 1) + path.length > 255) return undefined;
  const hub = domain === undefined || domain === 'docker.io' || domain === 'index.docker.io';
  const repository = hub ? (/^library\/[^/]+$/.test(path) ? path.slice('library/'.length) : path) : `${domain}/${path}`;
  return { repository, ...(tag !== undefined ? { tag } : {}), ...(digest !== undefined ? { digest } : {}) };
}

/** A repository as the engine lists it (parseImageReference of it is itself, without a tag or a digest). */
export function isListedRepository(value: unknown): value is string {
  const parts = parseImageReference(value);
  return parts !== undefined && parts.repository === value && parts.tag === undefined && parts.digest === undefined;
}

/**
 * At most this many recorded digests of one reference in use (the digests that the opens read from the registry right
 * before their builds; one per devspace that uses the reference, the newest builds first).
 */
export const MAX_IMAGE_DIGESTS = 8;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * The image references in use of devspaces, and the digests that the opens recorded for them (`buildRecord.images`:
 * reference → the digest that the open read from the registry right before its build): the evidence that an image of
 * the engine came from the registry also when the registry does not have that manifest any more.
 */
export interface ImageReferencesInUse {
  references: string[];
  /** Reference → its recorded digests (each `sha256:<64 hex>`, at most MAX_IMAGE_DIGESTS); only references that have one. */
  digests: Record<string, string[]>;
}

/**
 * The image references in use of `devspaces` (those of this computer on one engine): of their build records, the
 * keys of `images` (the image references as the configuration writes them, the `image` of the other services of Docker
 * Compose among them) and `compose.serviceImages`; valid ones only (parseImageReference), each once, sorted (the open
 * sends at most MAX_IMAGE_REFERENCES of them), with the recorded digest of each (the valid ones, each once, the
 * devspaces' newest builds first, at most MAX_IMAGE_DIGESTS).
 */
export function imageReferencesInUse(
  devspaces: ReadonlyArray<{ buildRecord?: { builtAt?: string; images: Record<string, string>; compose?: { serviceImages: readonly string[] } } }>,
): ImageReferencesInUse {
  const references = new Set<string>();
  const digests = new Map<string, string[]>();
  const newestFirst = [...devspaces].sort((a, b) => (b.buildRecord?.builtAt ?? '').localeCompare(a.buildRecord?.builtAt ?? ''));
  for (const devspace of newestFirst) {
    if (devspace.buildRecord === undefined) continue;
    for (const reference of [...Object.keys(devspace.buildRecord.images), ...(devspace.buildRecord.compose?.serviceImages ?? [])]) {
      if (parseImageReference(reference) !== undefined) references.add(reference);
    }
    for (const [reference, digest] of Object.entries(devspace.buildRecord.images)) {
      if (parseImageReference(reference) === undefined || !IMAGE_DIGEST.test(digest)) continue;
      const list = digests.get(reference) ?? [];
      if (!list.includes(digest) && list.length < MAX_IMAGE_DIGESTS) list.push(digest);
      digests.set(reference, list);
    }
  }
  return { references: [...references].sort(), digests: Object.fromEntries([...digests].sort(([a], [b]) => a.localeCompare(b))) };
}

/**
 * The strict check of recorded digests of references (ImageReferencesInUse.digests): an object whose keys are among
 * `references`, each a list of 1..MAX_IMAGE_DIGESTS distinct `sha256:<64 hex>`. Undefined for anything else.
 */
export function parseReferenceDigests(value: unknown, references: readonly string[]): Record<string, string[]> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, string[]> = {};
  for (const [reference, list] of Object.entries(value)) {
    if (!references.includes(reference) || !Array.isArray(list) || list.length === 0 || list.length > MAX_IMAGE_DIGESTS) return undefined;
    if (!list.every((digest) => typeof digest === 'string' && IMAGE_DIGEST.test(digest)) || new Set(list).size !== list.length) return undefined;
    result[reference] = [...(list as string[])];
  }
  return result;
}

/**
 * The image references in use that a computer (`source`, its heartbeat ID) sent, with their recorded digests
 * (`digests`, optional).
 */
export interface ImagesInUse {
  source: string;
  references: string[];
  digests?: Record<string, string[]>;
}

/**
 * The input of `monitor.js images -`: the references in use of a computer. `inUse` is missing for the input of an older
 * extension that sent only a list of repositories.
 */
export interface ImagesInput {
  inUse?: ImagesInUse;
}

/** Valid references (parseImageReference), at most MAX_IMAGE_REFERENCES, each once; else undefined. */
function referencesOf(references: unknown): string[] | undefined {
  if (!Array.isArray(references) || references.length > MAX_IMAGE_REFERENCES || !references.every((reference) => parseImageReference(reference) !== undefined)) return undefined;
  return [...new Set(references as string[])];
}

/**
 * The input of `monitor.js images -`, strict: `{ "source": "…", "references": [...] }`: the image references in use of
 * the computer `source` (isSourceId), at most MAX_IMAGE_REFERENCES; optionally
 * `"digests": { "<reference>": ["sha256:…"] }`, their recorded digests (parseReferenceDigests). An older extension on
 * another computer may send a list of repositories, alone (`{ "repositories": [...] }`) or as `"repositories"` beside
 * the references; the list is an array and is ignored. Undefined for anything else.
 */
export function parseImagesInput(text: string): ImagesInput | undefined {
  if (text.length > MAX_IMAGE_LIST_LENGTH) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if ('repositories' in value && !Array.isArray(value.repositories)) return undefined;
  if (hasExactKeys(value, ['repositories'])) return {};
  if (!hasOnlyKeys(value, ['source', 'references'], ['repositories', 'digests']) || !isSourceId(value.source)) return undefined;
  const references = referencesOf(value.references);
  if (references === undefined) return undefined;
  // The recorded digests of the references, optional (the input of an older extension has none).
  let digests: Record<string, string[]> | undefined;
  if (value.digests !== undefined) {
    digests = parseReferenceDigests(value.digests, references);
    if (digests === undefined) return undefined;
  }
  return { inUse: { source: value.source, references, ...(digests !== undefined ? { digests } : {}) } };
}

/** The file of the references in use of the computer `source` in the volume of the monitor. */
export function imagesInUseFileName(source: string): string {
  if (!isSourceId(source)) throw new Error('Invalid source of the images in use.');
  return `images-in-use.${source}.json`;
}

/** The source of a file name of imagesInUseFileName; undefined for any other name. */
export function parseImagesInUseFileName(name: string): string | undefined {
  return /^images-in-use\.([0-9a-f]{32})\.json$/.exec(name)?.[1];
}

/** A stored file of references in use: `at` (the clock of the engine's host at the write), the references. */
export interface ImagesInUseRecord {
  at: number;
  references: string[];
  /** The recorded digests of the references (optional, as the files of an older monitor have none). */
  digests?: Record<string, string[]>;
}

/** The strict check of a stored ImagesInUseRecord; undefined for anything else. */
export function parseImagesInUseRecord(text: string): ImagesInUseRecord | undefined {
  if (text.length > MAX_IMAGE_LIST_LENGTH) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !hasOnlyKeys(value, ['at', 'references'], ['digests'])) return undefined;
  const { at } = value;
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) return undefined;
  const references = referencesOf(value.references);
  if (references === undefined) return undefined;
  if (value.digests === undefined) return { at, references };
  const digests = parseReferenceDigests(value.digests, references);
  return digests === undefined ? undefined : { at, references, digests };
}

/**
 * The settings of the background run are not part of the label of the monitor, so computers with other settings or
 * another time zone on the same engine do not replace it at each open. Each open sends them (`monitor.js settings -`,
 * JSON on stdin); the newest settings of any computer apply from its next check on.
 */
export const IMAGE_SETTINGS_FILE = 'image-settings.json';

/**
 * The settings of the monitor's background run.
 */
export interface ImageSettings {
  /**
   * A cron expression of five fields or an interval in whole minutes (the setting cacheUpdateSchedule,
   * parseCacheSchedule); the schedule of the whole background run of the monitor, not only of its images.
   */
  schedule: string;
  /** An IANA time zone. */
  timeZone: string;
}

/**
 * The settings of the Monitor that an open and `monitorEnsure` carry: the image settings (ImageSettings, which
 * the monitor gets with `settings -`), and whether it runs permanently (monitorRunsPermanently: on every engine once the
 * user answered the question about it there, unless stopMonitorWhenIdle is on). The mode is part of its label
 * (monitorModeOf, monitorLabel), never of `settings -`; missing means false. And `computer`, the ID of the computer
 * (isSourceId): the owner of a permanent monitor that it creates (LABEL_MONITOR_OWNER).
 */
export interface MonitorSettings extends ImageSettings {
  permanent?: boolean;
  computer?: string;
}

/** The image settings of MonitorSettings, as `settings -` takes them (without the mode). */
export function imageSettingsOf(settings: ImageSettings): ImageSettings {
  return { schedule: settings.schedule, timeZone: settings.timeZone };
}

/** The schedule and the time zone of `value` when both are valid; else undefined. */
function scheduleSettingsOf(value: Record<string, unknown>): ImageSettings | undefined {
  const { schedule, timeZone } = value;
  if (typeof schedule !== 'string' || !parseCacheSchedule(schedule) || typeof timeZone !== 'string' || !isTimeZone(timeZone)) return undefined;
  return { schedule, timeZone };
}

/**
 * The strict check of MonitorSettings (both sides of `open` and `monitorEnsure`): an object with the keys `schedule`
 * and `timeZone` (as parseImageSettingsInput) and optionally `permanent` (a boolean) and `computer` (isSourceId).
 * Undefined for anything else. No `prefixes` (the extension and its worker are of one version).
 */
export function parseMonitorSettings(value: unknown): MonitorSettings | undefined {
  if (!isRecord(value)) return undefined;
  const { permanent, computer } = value;
  if (!hasOnlyKeys(value, ['schedule', 'timeZone'], ['permanent', 'computer'])) return undefined;
  if ('permanent' in value && typeof permanent !== 'boolean') return undefined;
  if ('computer' in value && !isSourceId(computer)) return undefined;
  const images = scheduleSettingsOf(value);
  if (images === undefined) return undefined;
  return { ...images, ...(typeof permanent === 'boolean' ? { permanent } : {}), ...(isSourceId(computer) ? { computer } : {}) };
}

/**
 * The input of `monitor.js settings -` and the stored image-settings.json: `{ "schedule": "…", "timeZone": "…" }`,
 * strict. The schedule a cron expression or an interval in minutes (parseCacheSchedule), as the setting gives it. An
 * older extension on another computer, and the file that an older monitor stored, may still carry `"prefixes": [...]`;
 * that array is ignored.
 */
export function parseImageSettingsInput(text: string): ImageSettings | undefined {
  if (text.length > MAX_IMAGE_LIST_LENGTH) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !hasOnlyKeys(value, ['schedule', 'timeZone'], ['prefixes'])) return undefined;
  if ('prefixes' in value && !Array.isArray(value.prefixes)) return undefined;
  return scheduleSettingsOf(value);
}

/**
 * The part of the label of a monitor that runs permanently (restart policy `unless-stopped`, never an exit when idle),
 * so a change of the mode replaces it at the next ensure. The monitor always has its outbound network (the VS Code
 * server of its background run), and the settings of the run are not part of the label. Who wants it permanent is its
 * own label (LABEL_MONITOR_OWNER): an ensure that wants a monitor that ends when idle takes a running permanent monitor
 * of the same version that another computer owns as current, and replaces only its own (RemoteSessionMonitor), so a
 * computer that turns stopMonitorWhenIdle on replaces its own permanent monitor, never one that another computer
 * created; a computer with the setting off makes a replaced one permanent again at its next ensure.
 */
export const PERMANENT_LABEL_PART = 'permanent';

/** The mode of a monitor: it ends when idle, or it is permanent. */
export type MonitorMode = 'idle' | typeof PERMANENT_LABEL_PART;

/** The mode of the monitor that MonitorSettings ask for. */
export function monitorModeOf(settings: Pick<MonitorSettings, 'permanent'> | undefined): MonitorMode {
  return settings?.permanent === true ? PERMANENT_LABEL_PART : 'idle';
}

/**
 * The part of the label of a monitor that mounts the shared VS Code server store `volume`, so that a monitor created
 * without the store (or with another one) is replaced by an ensure that has it.
 */
export function vscodeStoreLabelPart(volume: string): string {
  return `vscode-store:${volume}`;
}

/** The file of the background run in the volume of the monitor (the end of its last run, its last cleanup). */
export const CACHE_RUN_FILE = 'cache-run.json';
/**
 * The request of "Update All Images Now" in the volume of the monitor (`monitor.js run-now` writes it): the monitor
 * removes it at its next check and runs its background run at once (after the run that runs, if one does).
 */
export const RUN_NOW_FILE = 'run-now.json';

/**
 * The last use of the engine by a window, in the volume of the monitor (LastUse): written by the subcommands of the
 * windows (src/remoteMonitor/main.ts, at most once an hour) and by the start of a new monitor container. A permanent
 * monitor ends itself after UNUSED_END_MS without a use.
 */
export const LAST_USE_FILE = 'last-use.json';
/**
 * A permanent monitor that no window used for this time (by the clock of the engine's host) ends itself: its restart
 * policy becomes `no`, then it exits with 0. The next open of a window creates it again.
 */
export const UNUSED_END_MS = 30 * 24 * 60 * 60_000;

/** The content of LAST_USE_FILE. */
export interface LastUse {
  /** The time of the last use (milliseconds since the epoch, on the clock of the engine's host). */
  at: number;
  /**
   * The nonce of the monitor container that wrote it (LABEL_MONITOR_CREATE): the start of a container with another one
   * is a use; a restart of the same container is none.
   */
  createId?: string;
}

/** The nonce of a create of the monitor (LABEL_MONITOR_CREATE): a UUID. */
export function isMonitorCreateId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

/** The content of LAST_USE_FILE; undefined when it is not valid. */
export function parseLastUse(text: string): LastUse | undefined {
  if (text.length > 1024) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !hasOnlyKeys(value, ['at'], ['createId'])) return undefined;
  const { at, createId } = value;
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) return undefined;
  if (createId !== undefined && !isMonitorCreateId(createId)) return undefined;
  return createId === undefined ? { at } : { at, createId };
}

/**
 * The value of LABEL_MONITOR: 12 hex digits of sha256 of the script, the helper tag, the pipe loader (a new
 * loader is a new version of the container, so every monitor of an older way of loading is replaced once), and the
 * `extra` parts.
 */
export function remoteMonitorLabelValue(script: string, helperTag: string, extra: readonly string[] = []): string {
  const hash = createHash('sha256').update(script, 'utf8').update('\n', 'utf8').update(helperTag, 'utf8');
  hash.update('\n', 'utf8').update(PIPE_LOADER, 'utf8');
  if (extra.length > 0) hash.update('\n', 'utf8').update(JSON.stringify(extra), 'utf8');
  return hash.digest('hex').slice(0, 12);
}
