// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Entry point of the Monitor of a Docker engine (on every engine, local and remote). Part of the worker's bundle
// (dist/helperChannel.js, which exports startMonitor): the worker gives its own script to the monitor container that it
// creates. The container devspaces-monitor (image: the worker's own helper image by its
// monitor tag, of which the monitor runs only Node.js, `flock` (the lock of the records, and the devspace lock of an
// automatic stop: stopLock.ts over src/core/helperChannel/lockFile.ts) and `timeout` (the run limit under the lock of
// the records); the Docker socket of its engine at /var/run/docker.sock; the volume devspaces-monitor at /state)
// runs the pipe loader (src/core/loader/pipeLoader.ts): at the first start it gets the script over its standard input,
// stores it at /opt/devspace/monitor.js and calls startMonitor (`run`); after a restart it starts the stored file
// again. The workers run the other subcommands in it as `node /opt/devspace/monitor.js …` (an exec over the Engine API
// of an entry of the registry of the container scripts, monitorFlow.ts):
//   run                          the loop: a tick every 15 s (rules.ts); each automatic stop under the devspace
//                                lock; exits with 0 after REMOTE_IDLE_EXIT_MS without a running devspace container
//                                and without a fresh record while it maintains no images (a created container does not
//                                count), unless it runs permanently (DEVSPACE_MONITOR_PERMANENT: the user answered
//                                the question about it, and stopMonitorWhenIdle is off), image updates or not; and its
//                                background run
//                                (background.ts) by the schedule of cacheUpdateSchedule (CacheSchedule). A permanent
//                                one ends itself after 30 days in which no window used the engine (UnusedEnd: its
//                                restart policy becomes `no`, then it exits with 0)
//   heartbeat <json>             writes the records of one heartbeat (exit 0; 2 for an invalid argument, nothing written);
//                                an entry with `stopNow` (a manual Stop) writes a record that stops the devspace at
//                                a tick soon after, while it is the newest (rules.ts)
//   forget <source> <env id>     removes that record file, valid or not (Delete of a devspace)
//   forget <source> <env id> <at>  removes it only while it holds a valid record with that `at`, then prints `removed`
//                                (the loop; an `at` has no other meaning)
//   images -                     writes the image references in use of standard input, of the computer that sent them
//                                (a list of repositories of an older extension is ignored)
//   settings -                   writes the settings of the background run of standard input (its schedule and time zone)
//   run-now                      "Update All Images Now": asks the loop for its background run at once (RUN_NOW_FILE
//                                in the volume, taken at its next check, so within a minute; after the run that runs,
//                                if one does); it does not wait for the run
// Each subcommand of a window (all but the forget with an `at`) records a use of the engine (recordUse, LAST_USE_FILE).
// It uses Node.js built-ins, small pure modules of src/core, and the worker's client of the Engine API (engine.ts:
// src/helperChannel/engineClient.ts over engineApi.ts): it talks to its engine over that socket, never through a Docker
// CLI. Every argument and every file it reads is checked (protocol.ts); it never acts on a container without the label
// nimblescape.devspaces.id, except the restart policy of its own container before it ends itself (UnusedEnd), and it
// removes nothing but its own files (records, leftover temporary files of
// the volume) and, with image maintenance, the images of the repositories it manages that no rule keeps (those of the
// image references in use); and, in the shared VS Code server store that it mounts at /vscode, the server versions and
// the temporary folders that its cleanup names (background.ts); and the prepared images of devspaces without a
// volume, and the worker scripts of other versions in its volume (prepares.ts). Its background run prepares the next
// devspace image of each devspace of the engine by the worker's own script, run as a child process in its
// container (prepares.ts). The log goes to stdout (`docker logs devspaces-monitor`), one line per event.
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { isMainThread } from 'worker_threads';
import { errorMessage } from '../core/errors';
import { LABEL_COMPOSE_SERVICE, LABEL_DEVSPACE_ID, VSCODE_STORE_DIR } from '../core/names';
import { isMissing, type EngineContainerSummary } from '../core/worker/dockerEngine';
import {
  HEARTBEAT_FOLDER,
  CACHE_RUN_FILE,
  RUN_NOW_FILE,
  IMAGE_SETTINGS_FILE,
  IMAGES_IN_USE_MAX_AGE_MS,
  LABEL_MONITOR_CREATE,
  LAST_USE_FILE,
  MAX_IMAGE_LIST_LENGTH,
  UNUSED_END_MS,
  isMonitorCreateId,
  parseLastUse,
  imagesInUseFileName,
  parseImageSettingsInput,
  parseImagesInput,
  parseImagesInUseFileName,
  parseImagesInUseRecord,
  REMOTE_MONITOR_READY_TEXT,
  REMOTE_MONITOR_STATE_DIR,
  SEQ_ORDER_WINDOW_MS,
  forgetIfUnchangedCommand,
  heartbeatFileName,
  isRemoteDevspaceId,
  isSourceId,
  monitorExecFailure,
  parseHeartbeatFileName,
  parseHeartbeatInput,
  parseHeartbeatRecord,
  type HeartbeatInput,
  type HeartbeatRecord,
  type ImageSettings,
  type ImagesInUseRecord,
  type LastUse,
} from '../core/remoteMonitor/protocol';
import { engineFailure, socketEngine, type LoopEngine, type MonitorEngineParts, type SelfEngine, type VscodeEngine } from './engine';
import { BACKGROUND_ENGINE_TIMEOUT_MS, BackgroundRun, type CacheRunStore, type VscodeBackgroundDeps } from './background';
import { CLOCK_RESET_MS, parseCacheRunState, runRetryDelay, runRetryDue, type CacheRunState } from './backgroundRules';
import { DEFAULT_CACHE_UPDATE_SCHEDULE, cacheRunDue, parseCacheSchedule, type CacheSchedule as ParsedCacheSchedule } from '../core/remoteMonitor/cacheSettings';
import { MONITOR_CREATE_ID_ENV, MONITOR_PERMANENT_ENV, MONITOR_VSCODE_STORE_ENV } from '../core/remoteMonitor/remoteSessionMonitor';
import { REGISTRY_ANSWERS_FILE, registryAnswersText } from '../core/remoteMonitor/registryAnswers';
import { VERSION_ENV, takeUserAgentVersion, type HttpTransport } from '../core/http';
import { proxiedHttpsTransport } from '../core/proxyTransport';
import { storeLock, storeTryLock, unpackServer } from '../core/worker/vscodeServerStore';
import {
  DEFAULT_REMOTE_TIMING,
  REMOTE_TICK_MS,
  decide,
  initialRemoteState,
  isRunningState,
  type RemoteContainer,
  type RemoteStop,
  type RemoteMonitorState,
  type RemoteRecord,
  type RemoteTiming,
} from './rules';
import { DEFAULT_IMAGE_TIME_ZONE, isTimeZone, nextCronTime } from '../core/remoteMonitor/cron';
import {
  ImageMaintenance,
  REMOTE_IMAGE_FIRST_PASS_MS,
  parseReplacedImages,
  type ReferencesInUse,
} from './images';
import { stopLockDeps, stopLocker, type StopLocker } from './stopLock';
import { prepareDevspaces, storedPrepareWorker, type PrepareWorker } from './prepares';
import { MONITOR_WORKER_HASH_ENV } from '../core/remoteMonitor/workerScript';

/** Time limit of the container list (of the list of the engine). */
export const LIST_TIMEOUT_MS = 30_000;
/**
 * Time limit of one stop (the container gets its own stop time, 10 s unless it sets another, before SIGKILL; the
 * request of the engine, as `docker stop` without a time).
 */
export const STOP_TIMEOUT_MS = 60_000;
/** A record file larger than this is not read. */
const MAX_RECORD_BYTES = 4096;
/** Exit code for an invalid argument. */
export const EXIT_INVALID = 2;

/** The folder of the records in the volume. */
export function heartbeatDir(stateDir: string = REMOTE_MONITOR_STATE_DIR): string {
  return path.join(stateDir, HEARTBEAT_FOLDER);
}

/**
 * The containers of the list of the engine (LoopEngine.containerSummaries, by the label of a devspace; the list as
 * it is, no inspect) as the rules take them: the ID, the state as the list names it (`running`, `exited`, `paused`, …,
 * the word that `{{.State}}` of `docker ps` prints), the name, and the devspace ID and the Compose service of their
 * labels (an empty service for the dev container, as `{{.Label …}}` prints a missing label). A container with an
 * invalid ID or devspace ID is skipped.
 */
export function remoteContainersOf(containers: readonly EngineContainerSummary[]): RemoteContainer[] {
  const result: RemoteContainer[] = [];
  for (const container of containers) {
    const devspaceId = container.labels[LABEL_DEVSPACE_ID];
    if (!/^[0-9a-f]{12,64}$/.test(container.id) || !isRemoteDevspaceId(devspaceId)) continue;
    result.push({ id: container.id, state: container.state, name: container.name, devspaceId, composeService: container.labels[LABEL_COMPOSE_SERVICE] ?? '' });
  }
  return result;
}

/**
 * The valid records of the folder: files named `<source>.<devspace id>.json` (regular files, at most 4 KB) with a
 * valid record. Everything else is ignored, and not removed. A missing folder has none. A file with such a name but no
 * valid record may be a record in a newer format of a running devspace (monitors of different versions on one
 * engine), so the loop never removes it; Delete's plain forget removes it by name.
 */
export async function readRecords(dir: string): Promise<RemoteRecord[]> {
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records: RemoteRecord[] = [];
  for (const name of names) {
    const parts = parseHeartbeatFileName(name);
    if (!parts) continue;
    // Removed meanwhile, or not readable: ignored.
    const record = await readRecordFile(path.join(dir, name));
    if (record) records.push({ ...parts, ...record });
  }
  return records;
}

/**
 * Writes the records of one heartbeat, each atomically (a temporary file, then a rename), with mode 0600. An entry is
 * ignored (no write, the record stays as it is):
 * - when its `seq` is lower than the `seq` of the existing record of the same source and that record is at most
 *   SEQ_ORDER_WINDOW_MS old: the newer choice of that computer stays, while an older record is replaced whatever its
 *   `seq` (a clock of the computer that was set back);
 * - when it is `clearOnly` and the existing record of the same source does not say keepRunning:
 *   it only withdraws a keep of this source, and must not create or refresh a record.
 * Returns the ids of the ignored entries. The caller holds the kernel lock of the records (the entry monitorHeartbeat
 * of the registry of the container scripts runs `heartbeat` under `flock`), so two heartbeats read and replace the
 * records one after the other.
 */
export async function writeHeartbeat(dir: string, input: HeartbeatInput, now: number): Promise<string[]> {
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  await removeLeftoverTemporaryFiles(dir);
  const ignored: string[] = [];
  for (const devspace of input.devspaces) {
    const name = heartbeatFileName(input.source, devspace.id);
    const file = path.join(dir, name);
    const existing = await readRecordFile(file);
    const olderEntry = existing !== undefined && existing.seq > devspace.seq && Math.abs(now - existing.at) <= SEQ_ORDER_WINDOW_MS;
    const nothingToClear = devspace.clearOnly === true && existing?.keepRunning !== true;
    if (olderEntry || nothingToClear) {
      ignored.push(devspace.id);
      continue;
    }
    const temp = path.join(dir, `.${name}.${process.pid}.tmp`);
    // The record of a release says so (rules.ts, decide).
    const record: HeartbeatRecord = { at: now, keepRunning: devspace.keepRunning, limitSeconds: input.limitSeconds, seq: devspace.seq };
    if (input.release === true) record.release = true;
    // The record of a manual Stop says so (rules.ts, decide).
    if (devspace.stopNow === true) record.stopNow = true;
    try {
      await fs.promises.writeFile(temp, JSON.stringify(record), { mode: 0o600 });
      await fs.promises.rename(temp, file);
    } finally {
      await fs.promises.rm(temp, { force: true }).catch(() => undefined);
    }
  }
  return ignored;
}

/**
 * Removes the temporary files of heartbeats that were killed between the write and the rename (`timeout -s KILL`, a
 * killed container), `.<record name>.<pid>.tmp`. Only under the lock of the records (the entry monitorHeartbeat), where
 * no other heartbeat writes one. Nothing else is touched; a failure is ignored.
 */
async function removeLeftoverTemporaryFiles(dir: string): Promise<void> {
  const names = await fs.promises.readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    const match = /^\.(.+)\.[0-9]+\.tmp$/.exec(name);
    if (match && parseHeartbeatFileName(match[1])) await fs.promises.rm(path.join(dir, name), { force: true }).catch(() => undefined);
  }
}

/** One record file: a regular file of at most 4 KB with a valid record; `undefined` for anything else. */
async function readRecordFile(file: string): Promise<HeartbeatRecord | undefined> {
  try {
    const stat = await fs.promises.lstat(file);
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) return undefined;
    return parseHeartbeatRecord(await fs.promises.readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Removes one record. With `at`, only while the file holds a record with that `at` (the caller holds the lock of the
 * records). With `at`: true when it removed the file, false when the file is missing or does not hold a record with
 * that `at`. Without `at`: removes it if present, always true.
 */
export async function removeRecord(dir: string, source: string, devspaceId: string, at?: number): Promise<boolean> {
  const file = path.join(dir, heartbeatFileName(source, devspaceId));
  if (at !== undefined && (await readRecordFile(file))?.at !== at) return false;
  await fs.promises.rm(file, { force: true });
  return true;
}

/**
 * Removes an old record that `decide` named, under the lock of the records and only while the file still holds it (the
 * `at` it read). True when it removed it.
 */
export type RecordRemover = (record: RemoteRecord) => Promise<boolean>;

/** The time limit of a removal: the wait for the lock and the run limit (protocol.ts), plus the start of Node.js. */
export const FORGET_TIMEOUT_MS = 20_000;

/** The part of execFile that recordRemover uses (the tests pass their own). */
export type ExecFile = (
  file: string,
  args: string[],
  options: { timeout: number; windowsHide: boolean },
  callback: (error: { code?: string | number | null; killed?: boolean; signal?: string | null; message: string } | null, stdout: string, stderr: string) => void,
) => unknown;

/**
 * Runs `forget <source> <env id> <at>` of this script under the lock of the records (forgetIfUnchangedCommand). A
 * timeout and a failed start (a string code such as ENOENT) say so, not "exit code null". The timeout kills only
 * `flock`, whose child may still remove the record, so the text says so; another signal is named.
 */
export const recordRemover =
  (exec: ExecFile = execFile): RecordRemover =>
  (record) =>
    new Promise((resolve, reject) => {
      const [file, ...args] = forgetIfUnchangedCommand(record.source, record.devspaceId, record.at);
      exec(file, args, { timeout: FORGET_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
        if (!error) resolve(String(stdout).trim() === 'removed');
        else if (error.killed) reject(new Error(`no answer within ${FORGET_TIMEOUT_MS / 1000} s (it may still end)`));
        else if (error.signal) reject(new Error(`killed by ${error.signal}`));
        else reject(new Error(typeof error.code === 'string' ? error.message : monitorExecFailure(error.code ?? null, String(stderr), true)));
      });
    });

export interface RemoteLoopDeps {
  /**
   * The engine of the monitor over the Engine API (engine.ts): the list of the containers of the devspaces and their
   * stops.
   */
  engine: LoopEngine;
  /** Removes an old record (recordRemover); the tests remove it in the process. */
  removeRecord: RecordRemover;
  /** The folder of the records. */
  dir: string;
  now: () => number;
  log: (message: string) => void;
  timing?: RemoteTiming;
  /**
   * The devspace lock of an automatic stop, without waiting (stopLock.ts). A devspace is stopped only while the
   * monitor holds its lock.
   */
  lockDevspace: StopLocker;
  /**
   * A monotonic clock in ms for the idle time of the monitor (default `performance.now()`, which a step of the wall
   * clock does not move).
   */
  monotonic?: () => number;
}

/** The loop of `run`: one `tick()` per interval. The log names each event once, not every tick. */
export class RemoteMonitorLoop {
  private state: RemoteMonitorState = initialRemoteState();
  private listFailing = false;
  /** Env ids whose "keeps running" was logged; env ids whose failed stop was logged. */
  private readonly keptLogged = new Set<string>();
  private readonly stopFailedLogged = new Set<string>();
  /**
   * The records (`<source>.<env id>.<at>`) whose failed removal was logged. Like stopFailedLogged, it is kept across a
   * tick that ends early.
   */
  private removeFailedLogged = new Set<string>();
  private graceLogged = false;
  /**
   * Env ids whose lock was busy at the last tick that wanted to stop them (logged once per busy streak), and those
   * whose lock file could not be opened or locked (logged once per streak).
   */
  private busyLogged = new Set<string>();
  private lockFailedLogged = new Set<string>();
  /**
   * The monotonic time at which a container with the label nimblescape.devspaces.id was last seen running
   * (or Docker did not answer, which is not known to be idle); the start of the loop at first. Also when the decision
   * of a tick was `active` (a fresh record; only that, not a `created` labelled container or a keep of a devspace
   * whose container has not ended).
   */
  private activeAt: number;
  /**
   * The pass of removals that runs in the background, at most one at a time. Never rejects (each removal catches its
   * error). Read by the tests through `removals`.
   */
  private removing?: Promise<void>;

  constructor(private readonly deps: RemoteLoopDeps) {
    this.activeAt = this.monotonic();
  }

  private monotonic(): number {
    return (this.deps.monotonic ?? (() => performance.now()))();
  }

  /**
   * How long (ms) no container with the label nimblescape.devspaces.id ran, as the finished ticks saw it. A
   * kept devspace that runs counts as running. Nor was a tick `active` (decide).
   */
  idleMs(): number {
    return this.monotonic() - this.activeAt;
  }

  get currentState(): RemoteMonitorState {
    return this.state;
  }

  /** The pass of removals that runs now, if any (for the tests). */
  get removals(): Promise<void> | undefined {
    return this.removing;
  }

  /** One tick; returns the devspaces whose containers were stopped. Never throws. */
  async tick(): Promise<string[]> {
    const { engine, log } = this.deps;
    // The containers with the label of a devspace, stopped ones included (as `docker ps -a --filter label=…`), from
    // the engine within the time limit of the list; as its list gives them, without an inspect of each.
    let listed: EngineContainerSummary[];
    try {
      listed = await engine.containerSummaries(LABEL_DEVSPACE_ID, AbortSignal.timeout(LIST_TIMEOUT_MS));
    } catch (error) {
      if (!this.listFailing) log(`Docker does not answer; nothing is stopped while it does not answer. ${engineFailure(error, LIST_TIMEOUT_MS)}`);
      this.listFailing = true;
      // Not known to be idle.
      this.activeAt = this.monotonic();
      return [];
    }
    if (this.listFailing) log('Docker answers again.');
    this.listFailing = false;
    const containers = remoteContainersOf(listed);
    const anyRunning = containers.some((container) => isRunningState(container.state));
    // Also when the records cannot be read below.
    if (anyRunning) this.activeAt = this.monotonic();
    let records: RemoteRecord[];
    try {
      records = await readRecords(this.deps.dir);
    } catch (error) {
      log(`The heartbeat records could not be read; nothing is stopped. ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
    const decision = decide({
      now: this.deps.now(),
      containers,
      records,
      state: this.state,
      timing: this.deps.timing ?? DEFAULT_REMOTE_TIMING,
    });
    this.state = decision.state;
    // A fresh record (a window still sends heartbeats, for example while an open clones and builds before its container
    // exists) counts as activity too (decide: `active`). A `created` container or a keep alone does not, so a container
    // left `created` for ever lets the monitor exit.
    if (decision.active) this.activeAt = this.monotonic();
    if (decision.grace && !this.graceLogged) log('A pause or a start: nothing is stopped until the computers have sent heartbeats again.');
    this.graceLogged = decision.grace;

    for (const id of decision.kept) {
      if (!this.keptLogged.has(id)) log(`${id} keeps running: a computer asked to keep it running when closed.`);
    }
    this.keptLogged.clear();
    for (const id of decision.kept) this.keptLogged.add(id);

    // Each stop under the lock of its devspace, taken without a wait. A busy lock (an operation of a window, or a
    // Stop or Delete) skips the devspace in this tick (logged once per busy streak); a lock that cannot be opened or
    // taken skips it too (logged once per streak): never a stop without the lock. Under the lock, its containers and
    // records are read again and decided again (the newest record decides), so a heartbeat or a Start that came before
    // the lock was taken is seen; then the stop (the dev container first) and the release.
    const stopped: string[] = [];
    const busy = new Set<string>();
    const lockFailed = new Set<string>();
    for (const { devspaceId } of decision.stop) {
      const attempt = await this.deps.lockDevspace(devspaceId);
      if (attempt.kind === 'busy') {
        busy.add(devspaceId);
        if (!this.busyLogged.has(devspaceId)) log(`${devspaceId} is busy with an operation; it is not stopped now and is checked again at the next tick.`);
        continue;
      }
      if (attempt.kind === 'failed') {
        lockFailed.add(devspaceId);
        if (!this.lockFailedLogged.has(devspaceId)) log(`The lock of ${devspaceId} could not be taken; it is not stopped. ${attempt.detail}`);
        continue;
      }
      try {
        const again = await this.decideAgain(devspaceId);
        if (again === undefined) continue;
        if (await this.stopContainers(devspaceId, again)) stopped.push(devspaceId);
      } catch (error) {
        log(`${devspaceId} is not stopped: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        attempt.release();
      }
    }
    this.busyLogged = busy;
    this.lockFailedLogged = lockFailed;
    // Measured again when the stops are done, so a long stop is no idle time.
    if (anyRunning) this.activeAt = this.monotonic();

    // The log line names why a record is removed. Each removal runs under the lock of the records and only while the
    // file still holds the record that `decide` saw, so a heartbeat written since stays. After the stops, which a
    // removal (up to FORGET_TIMEOUT_MS each) would otherwise delay; the `at` check makes a late removal safe. A failed
    // one is logged once per series. The removals run in the background, one pass at a time, and never lengthen a tick
    // (a long one would make the next tick a gap, which holds every stop). A tick that reaches the end of its stops
    // while no pass runs starts the next one, with the records it read at its start; a duplicate removal finds a
    // missing file or another `at` and does nothing; the "Removed…" line comes when the removal ends. A removed record
    // never matters to a stop: a superseded one is never the newest, and the forgotten ones of a devspace go oldest
    // first (a keep last of equal `at`; in the order of `decide`, by the times as the rules see them, clamped), and
    // after one that is not removed the rest of it stay, so the newest records of a devspace stay until all are
    // gone, even if containers of it are created meanwhile.
    const removals = [
      ...decision.forget.map((record) => ({ record, reason: 'no container of it exists', forget: true })),
      ...decision.superseded.map((record) => ({ record, reason: 'a newer record of it exists', forget: false })),
    ];
    this.removing ??= (async () => {
      const failing = new Set<string>();
      const held = new Set<string>();
      for (const { record, reason, forget } of removals) {
        const key = `${record.source}.${record.devspaceId}.${record.at}`;
        // A skipped record keeps its logged failure.
        if (forget && held.has(record.devspaceId)) {
          if (this.removeFailedLogged.has(key)) failing.add(key);
          continue;
        }
        let removed = false;
        try {
          removed = await this.deps.removeRecord(record);
          if (removed) log(`Removed the old record of ${record.devspaceId} (${reason}).`);
        } catch (error) {
          if (!this.removeFailedLogged.has(key)) log(`The old record of ${record.devspaceId} could not be removed: ${error instanceof Error ? error.message : String(error)}`);
          failing.add(key);
        }
        if (!removed) held.add(record.devspaceId);
      }
      this.removeFailedLogged = failing;
    })().finally(() => (this.removing = undefined));
    return stopped;
  }

  /**
   * Under the lock of `devspaceId`, its containers and records read again and decided again with the state of this
   * tick (no new gap: the time since the start of the tick is no pause). The stop of `decide` for it, or undefined
   * (logged) when it is not to be stopped any more. Throws when the containers or the records cannot be read (no stop).
   */
  private async decideAgain(devspaceId: string): Promise<RemoteStop | undefined> {
    // The containers with the label of this devspace from the engine (as `docker ps -a --filter label=…=<id>`),
    // filtered by its ID again; as its list gives them, without an inspect of each.
    let listed: EngineContainerSummary[];
    try {
      listed = await this.deps.engine.containerSummaries(`${LABEL_DEVSPACE_ID}=${devspaceId}`, AbortSignal.timeout(LIST_TIMEOUT_MS));
    } catch (error) {
      throw new Error(`its containers could not be listed again. ${engineFailure(error, LIST_TIMEOUT_MS)}`);
    }
    const records = (await readRecords(this.deps.dir)).filter((record) => record.devspaceId === devspaceId);
    const now = this.deps.now();
    const decision = decide({
      now,
      containers: remoteContainersOf(listed).filter((container) => container.devspaceId === devspaceId),
      records,
      state: { ...this.state, lastTickAt: now },
      timing: this.deps.timing ?? DEFAULT_REMOTE_TIMING,
    });
    const stop = decision.stop.find((entry) => entry.devspaceId === devspaceId);
    if (stop === undefined) this.deps.log(`${devspaceId} is not stopped: a heartbeat or another change came before its lock was taken.`);
    return stop;
  }

  /**
   * The stop of the containers of one stop, the dev container first. True when all are stopped (or gone). The stop of
   * the engine without a time (the container's own stop time, as `docker stop` without `-t`) within STOP_TIMEOUT_MS; a
   * container that is gone (404) counts as stopped, and any other failure of the request (the engine's refusal, no
   * answer in time, a broken connection) is a failed stop.
   */
  private async stopContainers(devspaceId: string, { containers, reason }: RemoteStop): Promise<boolean> {
    const { engine, log } = this.deps;
    let failed = false;
    for (const container of containers) {
      log(`Stopping the container ${container.name} of ${devspaceId}: ${reason}.`);
      try {
        await engine.stop(container.id, undefined, AbortSignal.timeout(STOP_TIMEOUT_MS));
      } catch (error) {
        if (isMissing(error)) continue;
        failed = true;
        // Tried again at the next tick; logged once per series.
        if (!this.stopFailedLogged.has(devspaceId)) log(`The container ${container.name} could not be stopped: ${engineFailure(error, STOP_TIMEOUT_MS)}`);
      }
    }
    if (failed) this.stopFailedLogged.add(devspaceId);
    else this.stopFailedLogged.delete(devspaceId);
    return !failed;
  }
}

/**
 * The tick of the tests of the container (DEVSPACE_MONITOR_TICK_MS, 100..60000 ms): the gap and the grace scale with it
 * (4 and 8 ticks), the hold of a stopNow record is one tick. Without it, or with another value, the times of rules.ts.
 */
export function timingFromEnv(env: NodeJS.ProcessEnv): { tickMs: number; timing: RemoteTiming } {
  const text = env.DEVSPACE_MONITOR_TICK_MS;
  if (text !== undefined && /^\d{3,5}$/.test(text)) {
    const tickMs = Number(text);
    if (tickMs >= 100 && tickMs <= 60_000) return { tickMs, timing: { gapMs: 4 * tickMs, graceMs: 8 * tickMs, stopNowHoldMs: tickMs } };
  }
  return { tickMs: REMOTE_TICK_MS, timing: DEFAULT_REMOTE_TIMING };
}

/**
 * The monitor exits (code 0, so the restart policy `on-failure` leaves it exited) after this time without a running
 * container with the label nimblescape.devspaces.id, when it maintains no images. Nor a fresh record
 * (RemoteDecision.active), so an open whose clone and build take longer than this keeps it (its window sends heartbeats
 * for its busy mark). A `created` container or a keep without a running container does not keep it. The next open
 * ensures it again (`docker start`), and again right after its container started; the heartbeats of a window start it
 * again when it is missing (their repair).
 */
export const REMOTE_IDLE_EXIT_MS = 5 * 60_000;

/**
 * The idle time of the tests of the container (DEVSPACE_MONITOR_IDLE_MS, 100..86400000 ms); without it, or with another
 * value, REMOTE_IDLE_EXIT_MS.
 */
export function idleExitFromEnv(env: NodeJS.ProcessEnv): number {
  const text = env.DEVSPACE_MONITOR_IDLE_MS;
  if (text !== undefined && /^\d{3,8}$/.test(text) && Number(text) >= 100 && Number(text) <= 86_400_000) return Number(text);
  return REMOTE_IDLE_EXIT_MS;
}

/** A use of a window is written to LAST_USE_FILE at most this often (its heartbeats come every 30 s). */
export const LAST_USE_WRITE_MS = 60 * 60_000;
/**
 * The end after the time without use (UnusedEnd) looks again this long after the first check that found that time, and
 * a failed end is tried again after this time; never longer than the time without use itself (the tests).
 */
export const UNUSED_END_RECHECK_MS = 60 * 60_000;
/** Time limit of each call of the engine for the end after the time without use. */
export const UNUSED_END_TIMEOUT_MS = 30_000;

/**
 * The time without use of the tests of the container (DEVSPACE_MONITOR_UNUSED_MS, 100 ms to UNUSED_END_MS); without it,
 * or with another value, UNUSED_END_MS.
 */
export function unusedEndFromEnv(env: NodeJS.ProcessEnv): number {
  const text = env.DEVSPACE_MONITOR_UNUSED_MS;
  if (text !== undefined && /^\d{3,10}$/.test(text) && Number(text) >= 100 && Number(text) <= UNUSED_END_MS) return Number(text);
  return UNUSED_END_MS;
}

/** A time span for the log: in whole days, hours or minutes, or else in seconds (the tests). */
export function spanText(ms: number): string {
  for (const [unit, size] of [
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
  ] as const) {
    const count = ms / size;
    if (Number.isInteger(count) && count > 0) return `${count} ${count === 1 ? unit : `${unit}s`}`;
  }
  return `${Math.round(ms / 1000)} s`;
}

/** The nonce of the create of this monitor container (MONITOR_CREATE_ID_ENV); undefined when it has none. */
function createIdOf(env: NodeJS.ProcessEnv): string | undefined {
  const value = env[MONITOR_CREATE_ID_ENV];
  return isMonitorCreateId(value) ? value : undefined;
}

/** The last use in the volume (LAST_USE_FILE); undefined when there is none or it is not valid. Never throws. */
export async function readLastUse(stateDir: string): Promise<LastUse | undefined> {
  const text = await fs.promises.readFile(path.join(stateDir, LAST_USE_FILE), 'utf8').catch(() => undefined);
  return text === undefined ? undefined : parseLastUse(text);
}

/** Writes a use at `at` (LAST_USE_FILE), with the nonce `createId` when there is one. */
async function writeLastUse(stateDir: string, at: number, createId: string | undefined): Promise<void> {
  const use: LastUse = createId === undefined ? { at } : { at, createId };
  await writeStateFile(stateDir, LAST_USE_FILE, JSON.stringify(use));
}

/**
 * Records a use of the engine by a window at `now` (LAST_USE_FILE): after each subcommand of a window (a heartbeat,
 * `images -`, `settings -`, `run-now`, and the forget of a Delete; not the forget of the loop). At most once per
 * LAST_USE_WRITE_MS (and per a quarter of the time without use of the tests), so the heartbeats every 30 s write it
 * about once an hour. It never moves the stored time earlier: a stored time later than `now` (the clock went back, or
 * was ahead when it was written) stays until the loop finds the clock still behind it at its second look (UnusedEnd),
 * so a clock that is set back and set right again within the hour keeps the last use. A clock that stays behind longer
 * can make the monitor end early (UnusedEnd); the next open creates it again. Never throws: a failure keeps the older
 * time, and the next use writes it.
 */
export async function recordUse(stateDir: string, env: NodeJS.ProcessEnv, now: number): Promise<void> {
  try {
    const stored = await readLastUse(stateDir);
    const every = Math.min(LAST_USE_WRITE_MS, Math.floor(unusedEndFromEnv(env) / 4));
    if (stored !== undefined && (now < stored.at || now - stored.at < every)) return;
    await writeLastUse(stateDir, now, createIdOf(env) ?? stored?.createId);
  } catch {
    // The next use writes it.
  }
}

/**
 * At the start of `run`: a new monitor container (a nonce of its create other than the stored one, or no valid file)
 * counts as a use at `now`, with its nonce; a restart of the same container (Docker starts it again after a restart of
 * the engine) keeps the stored time. As recordUse, it never moves the stored time earlier. Never throws.
 */
export async function recordStart(stateDir: string, env: NodeJS.ProcessEnv, now: number): Promise<void> {
  try {
    const stored = await readLastUse(stateDir);
    const createId = createIdOf(env);
    if (stored !== undefined && (createId === undefined || stored.createId === createId)) return;
    await writeLastUse(stateDir, stored === undefined ? now : Math.max(now, stored.at), createId);
  } catch {
    // Then the first check of UnusedEnd counts a use now.
  }
}

/**
 * The end of a permanent monitor that no window used for `unusedMs` (UNUSED_END_MS; DEVSPACE_MONITOR_UNUSED_MS in the
 * tests of the container), by the last use in the volume (LAST_USE_FILE). `check` runs between two ticks of the loop; it
 * reads the file only when the time it knows is that old. The first check that finds the time without use looks again
 * after UNUSED_END_RECHECK_MS, so a clock that jumped ahead and is set right again within that time ends nothing.
 * Until the second look it reads the file at each check, and a use that returns ends the wait at once (`paused`). No
 * valid file counts as a use now. A stored time later than now (the clock went back) counts as a use now too, in memory
 * only: the stored time is replaced only when the clock is still behind it at a second look after
 * UNUSED_END_RECHECK_MS, so a clock that is set back and set right again within that time keeps the time of the last
 * use (recordUse moves it only later). A clock that stays behind longer loses it: once it is set right, the time that
 * replaced it can be old enough to end the monitor early; the next open creates it again. At the end, the restart
 * policy of its own container (found by the nonce of its create, MONITOR_CREATE_ID_ENV) becomes `no`, so Docker leaves
 * it exited after the exit with 0 that follows, also after a restart of the engine; the next open of a window creates
 * it again (its ensure replaces a monitor whose policy is not that of its mode). A use that comes before the exit
 * (`usedAgain`) sets the policy back, and the monitor goes on. A failure is logged once, and tried again after
 * UNUSED_END_RECHECK_MS: without the change of the policy the monitor does not exit (Docker would start it again). A
 * use ends that wait as it ends the wait for the second look; a later end then starts afresh, and its failure is
 * logged again.
 */
export class UnusedEnd {
  /** The time of the last use that the last read found (undefined: none read yet). */
  private lastUseAt: number | undefined;
  /** The monotonic time of the check that found the time without use (undefined: none found). */
  private foundAt: number | undefined;
  /** The monotonic time of the check that found the clock behind the stored time (undefined: not behind). */
  private behindAt: number | undefined;
  /** The monotonic time of the next try after a failed end (only while the time without use is found). */
  private retryAt: number | undefined;
  /** A failed end was logged (once per end that was found). */
  private failureLogged = false;
  /** Its restart policy is `no`: the monitor exits at the next chance (not during a background run). */
  ending = false;

  constructor(
    private readonly deps: {
      stateDir: string;
      env: NodeJS.ProcessEnv;
      engine: SelfEngine;
      now: () => number;
      monotonic: () => number;
      log: (message: string) => void;
      unusedMs: number;
    },
  ) {}

  private get recheckMs(): number {
    return Math.min(UNUSED_END_RECHECK_MS, this.deps.unusedMs);
  }

  /**
   * True from the check that found the time without use until a check finds a use again (the next check after the
   * use), and while the monitor ends: a background run that is only due waits then (CacheSchedule `paused`), so it
   * neither holds the end back nor pulls, downloads and builds for an engine that nobody uses.
   */
  get paused(): boolean {
    return this.ending || this.foundAt !== undefined;
  }

  /** True when the monitor ends now (its restart policy is `no`). Never throws. */
  async check(): Promise<boolean> {
    if (this.ending) return true;
    const { stateDir, env, now, monotonic, log, unusedMs } = this.deps;
    const mono = monotonic();
    // While the end waits for the second look, or for the next try after a failure, a use that returns ends the wait.
    if (this.foundAt !== undefined && (mono - this.foundAt < this.recheckMs || (this.retryAt !== undefined && mono < this.retryAt))) {
      await this.endWaitIfUsed();
      return false;
    }
    // A clock behind the stored time is a use now until the second look.
    if (this.behindAt !== undefined && mono - this.behindAt < this.recheckMs) return false;
    const before = now();
    // A use only moves the stored time later, so a recent one needs no read.
    if (this.foundAt === undefined && this.behindAt === undefined && this.lastUseAt !== undefined && before >= this.lastUseAt && before - this.lastUseAt < unusedMs) {
      return false;
    }
    const stored = await readLastUse(stateDir);
    const time = now();
    if (stored === undefined || (time < stored.at && this.behindAt !== undefined)) {
      // No valid file, or the clock is still behind the stored time at the second look: a use now, written.
      this.lastUseAt = time;
      this.useFound();
      this.behindAt = undefined;
      await writeLastUse(stateDir, time, createIdOf(env) ?? stored?.createId).catch(() => undefined);
      return false;
    }
    if (time < stored.at) {
      // The clock went back (or the stored time was written by a clock that was ahead): a use now, in memory only, so
      // that a clock that is set right again within the hour finds the stored time of the last use.
      this.lastUseAt = time;
      this.useFound();
      this.behindAt = mono;
      return false;
    }
    this.behindAt = undefined;
    this.lastUseAt = stored.at;
    if (time - stored.at < unusedMs) {
      this.useFound();
      return false;
    }
    if (this.foundAt === undefined) {
      this.foundAt = mono;
      log(`No window used Devspaces on this Docker engine for ${spanText(unusedMs)}. The Monitor looks again in ${spanText(this.recheckMs)}; then it ends itself.`);
      return false;
    }
    try {
      await this.endItself();
    } catch (error) {
      const reason = errorMessage(error).replace(/\.$/, '');
      if (!this.failureLogged) log(`The Monitor could not end itself (${reason}). It tries again in ${spanText(this.recheckMs)}.`);
      this.failureLogged = true;
      this.retryAt = mono + this.recheckMs;
      return false;
    }
    this.ending = true;
    return true;
  }

  /**
   * While the monitor ends (its restart policy is `no`), before its exit: true when a window used the engine since the
   * end was found (a later use in LAST_USE_FILE; the ensure of a window can accept the monitor just before its policy
   * changes). Then its restart policy is `unless-stopped` again, and the monitor goes on. False without such a use, and
   * when the policy cannot be set back (logged): then it exits, and the next open creates it again. Never throws.
   */
  async usedAgain(): Promise<boolean> {
    if (!this.ending) return false;
    const stored = await readLastUse(this.deps.stateDir);
    if (stored === undefined || this.lastUseAt === undefined || stored.at <= this.lastUseAt) return false;
    try {
      await this.setOwnRestartPolicy('unless-stopped');
    } catch (error) {
      this.deps.log(`A window used Devspaces on this Docker engine while the Monitor was ending, but the Monitor cannot go on (${errorMessage(error).replace(/\.$/, '')}).`);
      return false;
    }
    this.ending = false;
    this.useFound();
    this.lastUseAt = stored.at;
    this.deps.log('A window used Devspaces on this Docker engine while the Monitor was ending; the Monitor goes on. Its restart policy is "unless-stopped" again.');
    return true;
  }

  /** While the end waits (paused): a later use in LAST_USE_FILE ends the wait. */
  private async endWaitIfUsed(): Promise<void> {
    const stored = await readLastUse(this.deps.stateDir);
    if (stored === undefined || this.lastUseAt === undefined || stored.at <= this.lastUseAt) return;
    this.lastUseAt = stored.at;
    this.useFound();
    this.deps.log('A window used Devspaces on this Docker engine again; the Monitor does not end itself.');
  }

  /** A use ends the wait for the end, also the wait for the next try: a later end is found afresh, and logged again. */
  private useFound(): void {
    this.foundAt = undefined;
    this.retryAt = undefined;
    this.failureLogged = false;
  }

  /** Sets the restart policy of its own container to `no`; throws with the reason when it cannot. */
  private endItself(): Promise<void> {
    return this.setOwnRestartPolicy('no');
  }

  /** Sets the restart policy of its own container (by the nonce of its create); throws with the reason when it cannot. */
  private async setOwnRestartPolicy(policy: 'no' | 'unless-stopped'): Promise<void> {
    const { env, engine } = this.deps;
    const createId = createIdOf(env);
    if (createId === undefined) throw new Error('it does not know its container: the nonce of its create is missing');
    let ids: string[];
    try {
      ids = await engine.containerIds({ label: [`${LABEL_MONITOR_CREATE}=${createId}`] }, AbortSignal.timeout(UNUSED_END_TIMEOUT_MS));
    } catch (error) {
      throw new Error(`its container could not be listed: ${engineFailure(error, UNUSED_END_TIMEOUT_MS)}`);
    }
    if (ids.length !== 1) throw new Error(`${ids.length} containers have the nonce of its create`);
    try {
      await engine.updateRestartPolicy(ids[0], policy, AbortSignal.timeout(UNUSED_END_TIMEOUT_MS));
    } catch (error) {
      throw new Error(`its restart policy could not be changed: ${engineFailure(error, UNUSED_END_TIMEOUT_MS)}`);
    }
  }
}

export interface MainDeps {
  env: NodeJS.ProcessEnv;
  stateDir?: string;
  /**
   * The engine of `run` (the loop and the image maintenance); default: the port over the socket of the container
   * (socketEngine). The tests pass a fake engine.
   */
  engine?: MonitorEngineParts;
  /**
   * The images: the registry, and the standard input of `images -`. The HTTPS of the registry requests, made afresh for
   * each pass of the images (default: the proxy of the daemon of the engine, proxiedHttpsTransport, as the VS Code part
   * and the worker).
   */
  registryTransport?: () => HttpTransport;
  readStdin?: () => Promise<string>;
  /** The start of the removals of `run` (recordRemover). */
  exec?: ExecFile;
  /** The lock of an automatic stop (default: stopLocker on the lock files of the volume). */
  lockDevspace?: StopLocker;
  /**
   * The VS Code part of the background run (default: vscodeBackgroundDeps of the devspace and the engine; the tests
   * give their own or none).
   */
  vscodeBackground?: () => VscodeBackgroundDeps | undefined;
  /**
   * The worker of the prepares of the background run (default: storedPrepareWorker, the worker script of
   * MONITOR_WORKER_HASH_ENV in the volume, run as a child process); the tests give their own.
   */
  prepareWorker?: () => PrepareWorker | { reason: string };
  /** The monotonic clock of the idle time, and the wait between two ticks (the tests). */
  monotonic?: () => number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

function timestamped(out: (text: string) => void): (message: string) => void {
  return (message) => out(`${new Date().toISOString()} ${message}\n`);
}

/** The standard input as text, at most MAX_IMAGE_LIST_LENGTH + 1 characters (a longer one is refused). */
export function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      text += chunk;
      if (text.length > MAX_IMAGE_LIST_LENGTH) {
        process.stdin.destroy();
        resolve(text);
      }
    });
    process.stdin.on('end', () => resolve(text));
    process.stdin.on('error', () => resolve(text));
  });
}

/** Writes a file of the volume at once (a temporary file, then rename). */
let temporaryFiles = 0;

async function writeStateFile(stateDir: string, name: string, text: string): Promise<void> {
  const file = path.join(stateDir, name);
  // A name of its own for each write, so two writes at the same time never mix.
  const temporary = `${file}.${process.pid}.${++temporaryFiles}.tmp`;
  try {
    await fs.promises.writeFile(temporary, text, { mode: 0o600 });
    await fs.promises.rename(temporary, file);
  } finally {
    // A failed write (a full volume) leaves no temporary file behind.
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * Stores the image references in use of the computer `source`, with the time of the write by the clock of this host, in
 * a file of its own (imagesInUseFileName), so the computers that share the engine never overwrite each other's
 * (atomically: a temporary file, then a rename).
 */
export async function writeImagesInUse(stateDir: string, source: string, references: readonly string[], at: number, digests?: Record<string, string[]>): Promise<void> {
  // With the recorded digests of the references, when the computer sent some.
  const record: ImagesInUseRecord = { at, references: [...references], ...(digests !== undefined && Object.keys(digests).length > 0 ? { digests } : {}) };
  await writeStateFile(stateDir, imagesInUseFileName(source), JSON.stringify(record));
}

/**
 * The image references in use on this engine: the union of the files of the computers (writeImagesInUse) written within
 * IMAGES_IN_USE_MAX_AGE_MS of `now` (a file of a later time counts too). An older one is removed (the computer opened
 * nothing here for 30 days; a deleted devspace drops out at the next open of its computer). A file that cannot be
 * read or is invalid makes the result not `complete` (nothing is removed in that pass); such a file whose modification
 * time is older than IMAGES_IN_USE_MAX_AGE_MS is removed. Only regular files of such names, never a link. Never throws.
 * With the union of their recorded digests.
 */
export async function readImagesInUse(stateDir: string, now: number): Promise<ReferencesInUse> {
  let names: string[];
  try {
    names = await fs.promises.readdir(stateDir);
  } catch (error) {
    // No folder: no file of any computer.
    return { references: [], complete: (error as NodeJS.ErrnoException).code === 'ENOENT' };
  }
  const references = new Set<string>();
  const digests: Record<string, string[]> = {};
  let complete = true;
  for (const name of names.sort()) {
    if (parseImagesInUseFileName(name) === undefined) continue;
    const file = path.join(stateDir, name);
    try {
      const stat = await fs.promises.lstat(file);
      if (!stat.isFile()) continue;
      const record = stat.size <= MAX_IMAGE_LIST_LENGTH ? parseImagesInUseRecord(await fs.promises.readFile(file, 'utf8')) : undefined;
      if (record === undefined) {
        complete = false;
        if (now - stat.mtimeMs > IMAGES_IN_USE_MAX_AGE_MS) await fs.promises.unlink(file).catch(() => undefined);
        continue;
      }
      if (now - record.at > IMAGES_IN_USE_MAX_AGE_MS) {
        await fs.promises.unlink(file).catch(() => undefined);
        continue;
      }
      for (const reference of record.references) references.add(reference);
      for (const [reference, list] of Object.entries(record.digests ?? {})) digests[reference] = [...new Set([...(digests[reference] ?? []), ...list])];
    } catch (error) {
      // Removed meanwhile: it holds nothing; any other failure: not complete.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') complete = false;
    }
  }
  return { references: [...references], ...(Object.keys(digests).length > 0 ? { digests } : {}), complete };
}

/**
 * The temporary files of writeStateFile (`<name>.<pid>.<count>.tmp`) that a killed write left behind: of
 * image-settings.json, replaced-images.json, pulled-over-images.json, cache-run.json (written at the end of every
 * background run), registry-digests.json (REGISTRY_ANSWERS_FILE), last-use.json (LAST_USE_FILE) and the files of the
 * images in use (`images-in-use.<source>.json`). images.json is not written by this monitor; the leftovers of an older
 * monitor are removed too.
 */
export const STATE_TEMPORARY_FILE = /^(images|image-settings|replaced-images|pulled-over-images|cache-run|registry-digests|last-use|images-in-use\.[0-9a-f]{32})\.json\.\d+\.\d+\.tmp$/;
/**
 * Such a file whose modification time is more than this from now is removed at the start of `run` (only then: a younger
 * one stays until the next start).
 */
export const STATE_TEMPORARY_MAX_AGE_MS = 60 * 60_000;

/**
 * Removes the leftover temporary files of writeStateFile in the volume whose modification time is more than
 * STATE_TEMPORARY_MAX_AGE_MS from now, in either direction (a younger one may belong to a write that runs now). Only
 * regular files with such a name, never a link; every error is ignored. Returns the names it removed.
 */
export async function removeStaleStateTemporaryFiles(stateDir: string, now: number): Promise<string[]> {
  const removed: string[] = [];
  const names = await fs.promises.readdir(stateDir).catch(() => [] as string[]);
  for (const name of names) {
    if (!STATE_TEMPORARY_FILE.test(name)) continue;
    const file = path.join(stateDir, name);
    try {
      const stat = await fs.promises.lstat(file);
      if (!stat.isFile() || Math.abs(now - stat.mtimeMs) <= STATE_TEMPORARY_MAX_AGE_MS) continue;
      await fs.promises.unlink(file);
      removed.push(name);
    } catch {
      // Removed meanwhile, or not removable: left alone.
    }
  }
  return removed;
}

/**
 * The times of the Docker tests: DEVSPACE_IMAGE_FIRST_MS (the first pass) and DEVSPACE_IMAGE_INTERVAL_MS (a fixed
 * interval instead of the daily time), 100..86400000 ms each, of the whole background run (the first check of its
 * schedule after the start, and a fixed interval of runs instead of the schedule).
 */
export function imageTimesFromEnv(env: NodeJS.ProcessEnv): { firstMs: number; intervalMs?: number } {
  const read = (text: string | undefined) => (text !== undefined && /^\d{3,8}$/.test(text) && Number(text) >= 100 ? Number(text) : undefined);
  return { firstMs: read(env.DEVSPACE_IMAGE_FIRST_MS) ?? REMOTE_IMAGE_FIRST_PASS_MS, intervalMs: read(env.DEVSPACE_IMAGE_INTERVAL_MS) };
}

/**
 * The schedule of the whole background run: DEVSPACE_IMAGE_SCHEDULE (the setting cacheUpdateSchedule,
 * parseCacheSchedule: a cron expression of five fields or an interval in minutes) in DEVSPACE_IMAGE_TZ (the time zone
 * of the computer that created the monitor). Invalid or missing: DEFAULT_CACHE_UPDATE_SCHEDULE (daily at 06:07) and
 * DEFAULT_IMAGE_TIME_ZONE (Europe/Vienna).
 */
export function cacheScheduleFromEnv(env: NodeJS.ProcessEnv): { schedule: ParsedCacheSchedule; timeZone: string } {
  return {
    schedule: parseCacheSchedule(env.DEVSPACE_IMAGE_SCHEDULE) ?? parseCacheSchedule(DEFAULT_CACHE_UPDATE_SCHEDULE)!,
    timeZone: isTimeZone(env.DEVSPACE_IMAGE_TZ) ? env.DEVSPACE_IMAGE_TZ : DEFAULT_IMAGE_TIME_ZONE,
  };
}

/** The monitor runs permanently (DEVSPACE_MONITOR_PERMANENT `1`, part of its label). */
export function permanentFromEnv(env: NodeJS.ProcessEnv): boolean {
  return env[MONITOR_PERMANENT_ENV] === '1';
}

/** The IDs of images that pulls replaced, in the volume. */
export const REPLACED_IMAGES_FILE = 'replaced-images.json';
/**
 * Of those, the IDs that the monitor's own pull replaced (ImageMaintenanceDeps.pulledOver), in the volume, in the same
 * form.
 */
export const PULLED_OVER_IMAGES_FILE = 'pulled-over-images.json';
/** How often the monitor looks whether a time of the schedule has come (as cron: every minute). */
export const IMAGE_CHECK_MS = 60_000;

/**
 * The settings of the image maintenance with the parsed schedule: the schedule of the whole background run (a cron
 * expression or an interval).
 */
export interface ActiveCacheSettings extends ImageSettings {
  parsed: ParsedCacheSchedule;
}

/** The text of the schedule for the log. */
function scheduleText({ parsed, timeZone }: ActiveCacheSettings): string {
  return parsed.kind === 'interval' ? `every ${parsed.minutes} minutes` : `at "${parsed.text}" (cron, ${timeZone})`;
}

/**
 * The settings of the whole background run: those of the container (DEVSPACE_IMAGE_*), or the newer ones that an
 * extension stored in the volume (`monitor.js settings -`, image-settings.json), read again before each check. So
 * another computer (another time zone, another schedule) does not replace the container.
 */
export class CurrentCacheSettings {
  value: ActiveCacheSettings;
  private stored = '';

  constructor(
    env: NodeJS.ProcessEnv,
    private readonly stateDir: string,
    private readonly log: (message: string) => void,
  ) {
    const { schedule, timeZone } = cacheScheduleFromEnv(env);
    this.value = { schedule: schedule.text, timeZone, parsed: schedule };
  }

  /**
   * Reads the stored settings; keeps the current ones when there are none or they are invalid. Never throws. The
   * prefixes that an older monitor stored with them are ignored (parseImageSettingsInput).
   */
  async refresh(): Promise<void> {
    let text: string;
    try {
      text = await fs.promises.readFile(path.join(this.stateDir, IMAGE_SETTINGS_FILE), 'utf8');
    } catch {
      return;
    }
    if (text === this.stored) return;
    this.stored = text;
    const settings = parseImageSettingsInput(text);
    if (!settings) return;
    this.value = { ...settings, parsed: parseCacheSchedule(settings.schedule)! };
    this.log(`Background run settings: ${scheduleText(this.value)}.`);
  }
}

/**
 * The time of the last use of each devspace: the `at` of its newest heartbeat record in `dir` (the time of the last
 * heartbeat of a window of it, on the clock of this host). None when the records cannot be read.
 */
export async function lastUsedTimes(dir: string): Promise<Map<string, number>> {
  const times = new Map<string, number>();
  for (const record of await readRecords(dir).catch((): RemoteRecord[] => [])) {
    times.set(record.devspaceId, Math.max(times.get(record.devspaceId) ?? -Infinity, record.at));
  }
  return times;
}

/** The state of the background run in the volume (CACHE_RUN_FILE), written atomically (writeStateFile). */
export function cacheRunStore(stateDir: string): CacheRunStore {
  const read = async (): Promise<CacheRunState> => parseCacheRunState(await fs.promises.readFile(path.join(stateDir, CACHE_RUN_FILE), 'utf8').catch(() => '{}'));
  return {
    read,
    update: async (change) => writeStateFile(stateDir, CACHE_RUN_FILE, JSON.stringify({ ...(await read()), ...change })),
  };
}

/**
 * The request of "Update All Images Now" in the volume (RUN_NOW_FILE). `take` removes it and answers whether there was
 * one: one unlink, so one request runs once, also when two checks race, and a request that cannot be removed runs
 * nothing (no run at every check; the failure is logged once until it changes).
 */
export function runRequestStore(stateDir: string, log: (message: string) => void): { take(): Promise<boolean> } {
  let logged = '';
  return {
    async take() {
      try {
        await fs.promises.unlink(path.join(stateDir, RUN_NOW_FILE));
        logged = '';
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          const message = error instanceof Error ? error.message : String(error);
          if (message !== logged) log(`The request of "Update All Images Now" could not be taken, so it is not run: ${message}`);
          logged = message;
        }
        return false;
      }
    },
  };
}

/** Writes the request of "Update All Images Now" (`run-now`), atomically. */
export async function writeRunRequest(stateDir: string, now: number): Promise<void> {
  await writeStateFile(stateDir, RUN_NOW_FILE, JSON.stringify({ requestedAt: now }));
}

/**
 * The one schedule of the whole background run, checked every IMAGE_CHECK_MS. At most one run at a time: a time that
 * comes during a run is left out. By the setting cacheUpdateSchedule: with an interval, a run when the end of the last
 * run is at least the interval ago; with a cron schedule, a run when a time of it came after the end of the last run
 * (cacheRunDue). The end of the last run is kept in the volume (CacheRunStore), so a restart of the monitor does not
 * run again at once: at its start it runs only when the run is due by that time (never ran: due). So a time of the
 * schedule that the monitor missed (it was down, the engine off, the computer asleep) runs once at its next check, and
 * a clock that jumps ahead runs once too. And a request of "Update All Images Now" (`runRequest`, RUN_NOW_FILE) runs
 * the run at a check whether it is due or not; one that comes during a run is kept for the check after it. A run that
 * did not reach the network (`pass` resolves false: a computer that woke up before its Wi-Fi or VPN, an engine without
 * internet) does not count as a run: the end of the last run stays, and the run is tried again after runRetryDelay
 * (2, 5, 10, 20, 30 minutes, then every hour) until one reaches it; the retry is kept in the volume too, so a restart of
 * the monitor keeps it. While it waits, the next run comes at its time, or earlier at a time of the schedule counted
 * from the last attempt (`lastAttemptAt`), so a schedule shorter than the wait still runs at its times.
 */
export class CacheSchedule {
  /** The end of the last run (the stored one at first; undefined: none is known). */
  private lastEndAt: number | undefined;
  /** When a run that did not reach the network is tried again (the stored one at first; undefined: none waits). */
  private retryAt: number | undefined;
  /** How many runs in a row did not reach the network (0 while no retry waits). */
  private retries = 0;
  /** When the last run that did not reach the network ended (while a retry waits). */
  private lastAttemptAt: number | undefined;
  private loaded = false;
  private running = false;
  /** A check that takes longer than a minute (a slow list of the images) is not joined. */
  private checking = false;
  /** The observe of a check that runs now; a pass waits for it. */
  private observing: Promise<void> | undefined;
  /** A due run waits (`paused`), and the log said so. */
  private pauseLogged = false;

  constructor(
    private readonly deps: {
      now: () => number;
      log: (message: string) => void;
      settings: Pick<CurrentCacheSettings, 'value' | 'refresh'>;
      /** The run; false when it did not reach the network (BackgroundRun.run). */
      pass: () => Promise<boolean | void>;
      /** At each check while no pass runs (the IDs of the images of the repositories). */
      observe?: () => Promise<void>;
      /** The end of the last run in the volume. */
      state: Pick<CacheRunStore, 'read' | 'update'>;
      /** The request of "Update All Images Now" (runRequestStore); none in the tests that leave it out. */
      runRequest?: { take(): Promise<boolean> };
      /**
       * True while a run that is only due waits (UnusedEnd.paused: a permanent monitor found the time without use); a
       * requested run still runs. Never paused when it is left out.
       */
      paused?: () => boolean;
    },
  ) {}

  /** One check: a run when it is due (cacheRunDue). */
  async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      await this.checkOnce();
    } finally {
      this.checking = false;
    }
  }

  private async checkOnce(): Promise<void> {
    await this.deps.settings.refresh();
    if (!this.loaded) {
      this.loaded = true;
      const stored = await this.deps.state.read().catch((): CacheRunState => ({}));
      this.lastEndAt = stored.lastEndAt;
      this.retryAt = stored.retryAt;
      this.retries = stored.retries ?? 0;
      this.lastAttemptAt = stored.lastAttemptAt;
    }
    if (!this.running && this.deps.observe) {
      this.observing = this.deps.observe().finally(() => (this.observing = undefined));
      await this.observing;
    }
    const time = this.deps.now();
    // A clock that steps back by more than CLOCK_RESET_MS behind the end of the last run (a clock that was far ahead,
    // then corrected) starts the schedule again from now; otherwise no run would come until the clock caught up. A
    // smaller step back runs no time that was handled already again.
    if (this.lastEndAt !== undefined && time < this.lastEndAt - CLOCK_RESET_MS) {
      this.deps.log(`The clock of the host went back by ${Math.round((this.lastEndAt - time) / 60_000)} minutes; the schedule of the background run goes on from now.`);
      this.lastEndAt = time;
      await this.deps.state.update({ lastEndAt: time }).catch(() => undefined);
    }
    if (this.running) return;
    // A request is taken (removed) only here, while no run runs, so one that came during a run is kept for this check
    // after it.
    const requested = (await this.deps.runRequest?.take()) === true;
    // While a retry waits: its time, or the schedule counted from the last attempt (when it is known), whichever comes
    // first.
    const settings = this.deps.settings.value;
    const due =
      this.retryAt !== undefined
        ? runRetryDue(this.retryAt, time) || (this.lastAttemptAt !== undefined && cacheRunDue(settings.parsed, this.lastAttemptAt, time, settings.timeZone))
        : cacheRunDue(settings.parsed, this.lastEndAt, time, settings.timeZone);
    if (!requested && !due) return;
    if (!requested && this.deps.paused?.() === true) {
      if (!this.pauseLogged) this.deps.log('The background run is due, but it does not start: no window used Devspaces on this Docker engine for a long time.');
      this.pauseLogged = true;
      return;
    }
    this.pauseLogged = false;
    if (!requested && this.retryAt !== undefined) this.deps.log(`The background run is tried again (retry ${this.retries}).`);
    if (requested) this.deps.log('"Update All Images Now" asked for the background run; it runs now.');
    await this.run();
    // The times of a cron schedule that came during the run are left out (logged); the end of the run counts, so no
    // second run follows at once.
    const { parsed, timeZone } = this.deps.settings.value;
    const missed = parsed.kind === 'cron' ? nextCronTime(time, parsed.cron, timeZone) : undefined;
    if (missed !== undefined && missed <= this.deps.now()) this.deps.log('A background run was still running; the times of the schedule during it are left out.');
  }

  /**
   * Whether a run runs now, until its end is stored. The idle exit asks at each tick and never waits for the run.
   */
  get busy(): boolean {
    return this.running;
  }

  /**
   * A monitor that ends when idle starts a requested run before it exits (the request came after its last check), so
   * the request is not left until its next start. True when it took one (the run then counts as busy).
   */
  async runIfRequested(): Promise<boolean> {
    if (this.running || !(await this.deps.runRequest?.take())) return false;
    this.deps.log('"Update All Images Now" asked for the background run; it runs now.');
    void this.run();
    return true;
  }

  /** One run now, unless one runs; then its end is kept (in the volume too). Never throws. */
  run(): Promise<void> {
    if (this.running) {
      this.deps.log('A background run is still running; this time of the schedule is left out.');
      return Promise.resolve();
    }
    this.running = true;
    return this.runOnce();
  }

  private async runOnce(): Promise<void> {
    // A run that throws (a failure of the monitor itself, not of the network) counts as a run, so it does not repeat.
    let reached = true;
    try {
      // Not together with the observe of a check (both keep the store of IDs).
      await this.observing?.catch(() => undefined);
      await this.deps.settings.refresh();
      reached = (await this.deps.pass()) !== false;
    } catch (error) {
      this.deps.log(`The background run failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.loaded = true;
      const end = this.deps.now();
      let change: CacheRunState;
      if (reached) {
        this.lastEndAt = end;
        this.retryAt = undefined;
        this.retries = 0;
        this.lastAttemptAt = undefined;
        // Undefined fields are left out of the stored state (JSON), so a waiting retry goes.
        change = { lastEndAt: end, retryAt: undefined, retries: undefined, lastAttemptAt: undefined };
      } else {
        this.retries++;
        this.retryAt = end + runRetryDelay(this.retries);
        this.lastAttemptAt = end;
        this.deps.log(`The background run did not reach the network; it is tried again at ${new Date(this.retryAt).toISOString()}.`);
        change = { retryAt: this.retryAt, retries: this.retries, lastAttemptAt: end };
      }
      await this.deps.state.update(change).catch((error: unknown) => {
        this.deps.log(`The end of the background run could not be stored: ${error instanceof Error ? error.message : String(error)}`);
      });
      // The run counts as running (busy) until its end is stored, so the idle exit never ends the process during that
      // write.
      this.running = false;
    }
  }
}

/**
 * The HTTPS of the monitor: through the proxy of the daemon of `engine` (as the worker; its settings read once, when
 * the first request needs them, within BACKGROUND_ENGINE_TIMEOUT_MS). For the VS Code part of the background run and
 * the registry requests of the image maintenance.
 */
export function daemonProxyTransport(engine: Pick<VscodeEngine, 'proxy'>): ReturnType<typeof proxiedHttpsTransport> {
  return proxiedHttpsTransport(() => engine.proxy(AbortSignal.timeout(BACKGROUND_ENGINE_TIMEOUT_MS)));
}

/**
 * The VS Code part of the background run in the container: the store that the worker mounts, read-write at
 * VSCODE_STORE_DIR (its volume named by DEVSPACE_VSCODE_STORE, which RemoteSessionMonitor.runSpec sets with the mount),
 * the HTTPS of the proxy of the daemon (as the worker), the lock of a server version with and without a wait, and
 * `tar`. Undefined without a valid store name (no store mounted).
 */
export function vscodeBackgroundDeps(
  env: NodeJS.ProcessEnv,
  engine: VscodeEngine,
  log: (message: string) => void,
  stateDir: string = REMOTE_MONITOR_STATE_DIR,
): VscodeBackgroundDeps | undefined {
  const storeVolume = env[MONITOR_VSCODE_STORE_ENV];
  if (storeVolume === undefined || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(storeVolume)) return undefined;
  return {
    store: {
      root: VSCODE_STORE_DIR,
      transport: daemonProxyTransport(engine),
      architecture: (signal) => engine.architecture(signal),
      lock: (root, name, waitSeconds, signal) => storeLock(root, name, waitSeconds, signal),
      unpack: (archive, folder, signal) => unpackServer(archive, folder, signal),
      logger: { info: log, warn: log, error: (message) => log(message), output: () => {} },
      background: true,
    },
    storeVolume,
    engine,
    tryLock: (name) => storeTryLock(VSCODE_STORE_DIR, name),
    // The extension lists in the run's own volume (deps.stateDir of `run` for the tests).
    extensionStateDir: stateDir,
  };
}

/**
 * Runs one subcommand of `argv` (without node and the script). Resolves with the exit code; `run` resolves only when
 * the monitor is idle, with 0.
 */
export async function main(argv: readonly string[], deps: MainDeps): Promise<number> {
  const out = deps.out ?? ((text: string) => process.stdout.write(text));
  const err = deps.err ?? ((text: string) => process.stderr.write(text));
  const now = deps.now ?? Date.now;
  const dir = heartbeatDir(deps.stateDir);
  // A subcommand of a window is a use of the engine (UnusedEnd).
  const used = () => recordUse(deps.stateDir ?? REMOTE_MONITOR_STATE_DIR, deps.env, now());
  const [command, ...args] = argv;
  switch (command) {
    case 'heartbeat': {
      const input = args.length === 1 ? parseHeartbeatInput(args[0]) : undefined;
      if (!input) {
        err('Invalid heartbeat.\n');
        return EXIT_INVALID;
      }
      await writeHeartbeat(dir, input, now());
      await used();
      return 0;
    }
    case 'forget': {
      // Optionally the `at` of the record as the loop read it.
      const at = args.length === 3 && /^\d{1,16}$/.test(args[2]) ? Number(args[2]) : undefined;
      if (args.length < 2 || (args.length > 2 && !Number.isSafeInteger(at)) || !isSourceId(args[0]) || !isRemoteDevspaceId(args[1])) {
        err('Invalid record.\n');
        return EXIT_INVALID;
      }
      if ((await removeRecord(dir, args[0], args[1], at)) && at !== undefined) out('removed\n');
      // The forget of a Delete comes from a window; the one with `at` from the loop.
      if (at === undefined) await used();
      return 0;
    }
    case 'images': {
      // The image references in use of the computer that sent them, on stdin. A list of repositories, which an older
      // extension on another computer may send (alone, or beside the references), is taken and ignored.
      const input = args.length === 1 && args[0] === '-' ? parseImagesInput(await (deps.readStdin ?? readStdin)()) : undefined;
      if (!input) {
        err('Invalid image list.\n');
        return EXIT_INVALID;
      }
      const stateDir = deps.stateDir ?? REMOTE_MONITOR_STATE_DIR;
      if (input.inUse !== undefined) await writeImagesInUse(stateDir, input.inUse.source, input.inUse.references, now(), input.inUse.digests);
      await used();
      return 0;
    }
    case 'run-now': {
      // "Update All Images Now"; the loop runs the background run at its next check (CacheSchedule). Nothing else is
      // read or written.
      if (args.length !== 0) {
        err('run-now takes no argument.\n');
        return EXIT_INVALID;
      }
      await writeRunRequest(deps.stateDir ?? REMOTE_MONITOR_STATE_DIR, now());
      await used();
      return 0;
    }
    case 'settings': {
      // The settings of the background run of the computer that opened last, on stdin. Stored without the prefixes that
      // an older extension may send (parseImageSettingsInput).
      const text = args.length === 1 && args[0] === '-' ? await (deps.readStdin ?? readStdin)() : undefined;
      const settings = text === undefined ? undefined : parseImageSettingsInput(text);
      if (!settings) {
        err('Invalid image settings.\n');
        return EXIT_INVALID;
      }
      await writeStateFile(deps.stateDir ?? REMOTE_MONITOR_STATE_DIR, IMAGE_SETTINGS_FILE, JSON.stringify(settings));
      await used();
      return 0;
    }
    case 'run': {
      if (args.length !== 0) {
        err('run takes no argument.\n');
        return EXIT_INVALID;
      }
      const { tickMs, timing } = timingFromEnv(deps.env);
      const log = timestamped(out);
      // The engine over the socket of the container, not the Docker CLI.
      const engine = deps.engine ?? socketEngine();
      // The removals run /opt/devspace/monitor.js under the lock of /state, so they always act on /state; deps.stateDir
      // only moves the reading (the tests). The lock files of the volume (as the workers open them; deps.stateDir for
      // the tests).
      const lockDevspace = deps.lockDevspace ?? stopLocker(stopLockDeps(deps.stateDir ?? REMOTE_MONITOR_STATE_DIR));
      const loop = new RemoteMonitorLoop({ engine, removeRecord: recordRemover(deps.exec), dir, now, log, timing, lockDevspace, monotonic: deps.monotonic });
      const idleExitMs = idleExitFromEnv(deps.env);
      // Pipe loading: the extension waits for this line (REMOTE_MONITOR_READY_TEXT) after `docker run`.
      log(`${REMOTE_MONITOR_READY_TEXT} (Node.js ${process.version}, a check every ${tickMs / 1000} s).`);
      // The version of Devspaces of the worker that created this monitor (RemoteSessionMonitor.runSpec), for the header
      // User-Agent of its HTTPS requests and of those of its prepares; said once when it has none.
      const noVersion = takeUserAgentVersion(deps.env[VERSION_ENV], `The version of Devspaces (${VERSION_ENV})`);
      if (noVersion !== undefined) log(noVersion);
      // The temporary files that killed writes of the volume left behind. Only here, at the start of `run`: a leftover
      // younger than STATE_TEMPORARY_MAX_AGE_MS at a start stays until the next start.
      const leftovers = await removeStaleStateTemporaryFiles(deps.stateDir ?? REMOTE_MONITOR_STATE_DIR, now());
      if (leftovers.length > 0) log(`Removed ${leftovers.length} leftover temporary file(s) of the volume.`);
      const stateDir = deps.stateDir ?? REMOTE_MONITOR_STATE_DIR;
      // A new container is a use; a restart of the same one is none.
      await recordStart(stateDir, deps.env, now());
      // The whole background run (the images in use, the VS Code server, the cleanup of the store) by the one schedule
      // of the setting cacheUpdateSchedule; the first check one minute after the start runs it when it is due by the
      // end of the last run in the volume.
      const settings = new CurrentCacheSettings(deps.env, stateDir, log);
      await settings.refresh();
      const images = new ImageMaintenance({
        engine,
        registryTransport: deps.registryTransport ?? (() => daemonProxyTransport(engine)),
        log,
        // The image references in use that the computers sent.
        referencesInUse: () => readImagesInUse(stateDir, now()),
        // The IDs that pulls replaced, in the volume.
        replaced: {
          read: async () => parseReplacedImages(await fs.promises.readFile(path.join(stateDir, REPLACED_IMAGES_FILE), 'utf8').catch(() => '{}')),
          write: (value) => writeStateFile(stateDir, REPLACED_IMAGES_FILE, JSON.stringify(value)),
        },
        // The IDs that the monitor's own pull replaced.
        pulledOver: {
          read: async () => parseReplacedImages(await fs.promises.readFile(path.join(stateDir, PULLED_OVER_IMAGES_FILE), 'utf8').catch(() => '{}')),
          write: (value) => writeStateFile(stateDir, PULLED_OVER_IMAGES_FILE, JSON.stringify(value)),
        },
        // The registry's answers for the tags in use, with the schedule that this monitor runs with (the open takes
        // them while they are fresh by it), written atomically.
        registryAnswers: {
          write: (digests) =>
            writeStateFile(stateDir, REGISTRY_ANSWERS_FILE, registryAnswersText({ schedule: settings.value.schedule, timeZone: settings.value.timeZone, digests })),
        },
        now,
      });
      const state = cacheRunStore(stateDir);
      // The VS Code part afresh for each run (BackgroundRunDeps.vscode).
      const vscodeOf = deps.vscodeBackground ?? (() => vscodeBackgroundDeps(deps.env, engine, log, stateDir));
      const vscode = vscodeOf();
      // The prepares, the most recently used devspace first (the newest heartbeat record of each), by the worker
      // script that the worker which created this monitor named.
      const monotonic = deps.monotonic ?? (() => performance.now());
      const prepares = () =>
        prepareDevspaces({
          engine,
          log,
          monotonic,
          lastUsed: () => lastUsedTimes(dir),
          worker: deps.prepareWorker ?? storedPrepareWorker(deps.env[MONITOR_WORKER_HASH_ENV], stateDir, now),
        });
      const background = new BackgroundRun({ log, now, images: () => images.pass(), vscode: vscodeOf, state, prepares });
      // With the request of "Update All Images Now" (`run-now`).
      const runRequest = runRequestStore(stateDir, log);
      const permanent = permanentFromEnv(deps.env);
      const unusedMs = unusedEndFromEnv(deps.env);
      const unused = new UnusedEnd({ stateDir, env: deps.env, engine, now, monotonic, log, unusedMs });
      // After the time without use was found, a run that is only due does not start (UnusedEnd.paused).
      const schedule = new CacheSchedule({ now, log, settings, pass: () => background.run(), observe: () => images.observe(), state, runRequest, paused: () => unused.paused });
      const { firstMs, intervalMs } = imageTimesFromEnv(deps.env);
      log(
        `Background run (the images in use, the VS Code server${vscode === undefined ? ' left out: no store' : ''}, the cleanup): ` +
          `first check in ${Math.round(firstMs / 1000)} s, then ${scheduleText(settings.value)}; ${permanent ? 'runs permanently.' : `ends after ${Math.round(idleExitMs / 1000)} s without a running devspace.`}` +
          (permanent ? ` It ends itself when no window used Devspaces on this engine for ${spanText(unusedMs)}.` : ''),
      );
      // Unreferenced: the loop below keeps the process; a monitor that exits when idle does not wait for them.
      setTimeout(() => {
        // The Docker tests: a fixed interval (DEVSPACE_IMAGE_INTERVAL_MS) of runs instead of the schedule.
        if (intervalMs !== undefined) {
          void schedule.run();
          setInterval(() => void schedule.run(), intervalMs).unref?.();
        } else {
          void schedule.check();
          setInterval(() => void schedule.check(), IMAGE_CHECK_MS).unref?.();
        }
      }, firstMs).unref?.();
      const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
      // The wait for a run is logged once per idle time.
      let waitLogged = false;
      for (;;) {
        await loop.tick();
        // A permanent monitor that no window used for 30 days ends itself (UnusedEnd): between two ticks as the exit
        // when idle, never during a background run, and after the removals of the records. Its restart policy is `no`
        // first, so Docker leaves it exited.
        if (permanent && !schedule.busy && (await unused.check())) {
          await loop.removals;
          // The timer of the schedule can start a run meanwhile; the exit waits for the next tick without one.
          if (schedule.busy) continue;
          // A window that used the engine meanwhile (its ensure can accept the monitor just before the end) sets the
          // restart policy back, and the monitor goes on; a request of "Update All Images Now" then runs at the next
          // check of the schedule. A request without such a use runs before the exit, as before the exit when idle.
          if ((await unused.usedAgain()) || (await schedule.runIfRequested())) continue;
          log(`No window used Devspaces on this Docker engine for ${spanText(unusedMs)}; the Monitor ends itself. Its restart policy is now "no". The next open starts a new one.`);
          return 0;
        }
        // Only here, between two ticks, so never while it holds a lock or stops a container; the removals of the
        // records (each under the lock of the records) end first. The records stay in the volume. A permanent monitor
        // (after the answer of the user, with stopMonitorWhenIdle off) never exits when idle; one that ends when idle
        // does so also with image updates.
        if (!permanent && loop.idleMs() >= idleExitMs) {
          // Not during a background run (a download would be cut, and its end not stored). The loop does not wait for
          // the run: it goes on ticking (the stops of devspaces whose windows closed, the heartbeats) and exits at
          // the first idle tick after the run's end. A request of "Update All Images Now" that came after the last
          // check runs first.
          if (schedule.busy || (await schedule.runIfRequested())) {
            if (!waitLogged) log('No devspace container runs, but a background run is running; the Monitor exits after its end.');
            waitLogged = true;
            await sleep(tickMs);
            continue;
          }
          await loop.removals;
          // The timer of the schedule can start a run while the removals end, so the exit looks again; the next idle
          // tick waits for that run as above.
          if (schedule.busy) continue;
          // The text names the fresh heartbeats too.
          log(`No devspace container ran and no heartbeat was fresh for ${Math.round(idleExitMs / 1000)} s, and it does not run permanently; the Monitor exits. The next open starts it again.`);
          return 0;
        }
        waitLogged = false;
        await sleep(tickMs);
      }
    }
    default:
      err('Usage: monitor.js run | heartbeat <json> | forget <source> <devspace id> [<at>] | images - | settings - | run-now\n');
      return EXIT_INVALID;
  }
}

/** What runEntry needs of the process (the tests give their own). */
export interface EntryDeps {
  onSignal(signal: 'SIGTERM' | 'SIGINT', listener: () => void): void;
  exit(code: number): void;
  err(text: string): void;
  main(argv: readonly string[]): Promise<number>;
}

function processEntryDeps(): EntryDeps {
  return {
    onSignal: (signal, listener) => process.on(signal, listener),
    exit: (code) => process.exit(code),
    err: (text) => process.stderr.write(text),
    main: (argv) => main(argv, { env: process.env }),
  };
}

/**
 * Runs the subcommand `argv` as the program of this process: SIGTERM and SIGINT end it with 0 (`docker stop`), the exit
 * code of the subcommand ends it, a failure ends it with 1.
 */
export function runEntry(argv: readonly string[], deps: EntryDeps = processEntryDeps()): Promise<void> {
  deps.onSignal('SIGTERM', () => deps.exit(0));
  deps.onSignal('SIGINT', () => deps.exit(0));
  return deps.main(argv).then(
    (code) => deps.exit(code),
    (error: unknown) => {
      deps.err(`${error instanceof Error ? error.message : String(error)}\n`);
      deps.exit(1);
    },
  );
}

/**
 * Pipe loading: the function that the pipe loader of the container starts (REMOTE_MONITOR_ENTRY), at the first start
 * and after each restart: the loop (`run`). `_input`: what the loader read after the script (nothing is expected; the
 * standard input is not read).
 */
export function startMonitor(_input = '', deps: EntryDeps = processEntryDeps()): void {
  void runEntry(['run'], deps);
}

// Only when the bundle is the entry module of the process (`docker exec … node /opt/devspace/monitor.js <subcommand>`),
// not when the loader or a test loads it. A thread that starts from the bundle file (the host access analysis) has the
// file as its entry module too, so the main thread is a condition.
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module && isMainThread) {
  void runEntry(process.argv.slice(2));
}
