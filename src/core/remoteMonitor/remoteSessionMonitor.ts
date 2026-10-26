// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Monitor container on a Docker engine (one on every engine, local and remote): its ensure. It runs in the
// worker of the engine, over the port MonitorEngine (the Engine API, src/core/worker/engineMonitor.ts). The windows
// send their heartbeats through the operation `heartbeat`. No `vscode`.
//
// Pipe loading: the container runs the pipe loader; the script is never an argument or a variable. The create writes
// the script as the first line of the container's input, waits for the monitor's REMOTE_MONITOR_READY_TEXT, then closes
// its input (the container goes on). The loader stores the script at REMOTE_MONITOR_SCRIPT_PATH, so a restart of the
// container resumes from it without input. Neither the script line nor any other input is logged.
import { randomUUID } from 'crypto';
import { errorMessage } from '../errors';
import { VERSION_ENV, userAgentVersion } from '../http';
import { LOADER_EXIT_CODE, MAX_BUNDLE_LINE_LENGTH, bundleHash, encodeBundle, loaderCommand } from '../loader/pipeLoader';
import { abortError, isAbortError, sleep, type Logger } from '../ports';
import { VSCODE_STORE_DIR } from '../names';
import { monitorRestartPolicy } from './cacheSettings';
import type { MonitorRunSpec } from '../worker/dockerEngine';
import type { MonitorEngine, MonitorInspected } from './monitorEngine';
import {
  LABEL_MONITOR_CREATE,
  LABEL_MONITOR,
  REMOTE_MONITOR_CONTAINER,
  REMOTE_MONITOR_ENTRY,
  REMOTE_MONITOR_READY_TEXT,
  REMOTE_MONITOR_SCRIPT_PATH,
  REMOTE_MONITOR_STATE_DIR,
  REMOTE_MONITOR_VOLUME,
  LABEL_MONITOR_OWNER,
  PERMANENT_LABEL_PART,
  monitorModeOf,
  remoteMonitorLabelValue,
  vscodeStoreLabelPart,
  type MonitorMode,
  type MonitorSettings,
} from './protocol';

/** Time limit of each Docker call of ensure (an SSH connection plus the call). */
export const REMOTE_MONITOR_DOCKER_TIMEOUT_MS = 60_000;
/** Time limit of the check of the stored script (the read of one file of the container through the engine). */
export const REMOTE_MONITOR_CHECK_TIMEOUT_MS = 20_000;

/**
 * The log of the monitor container, `docker logs` of at most about 2 MB. Not part of the label (remoteMonitorLabelValue
 * covers the script, the helper tag, the loader and the mode): a running monitor keeps its log settings until it is
 * replaced for another reason.
 */
export const REMOTE_MONITOR_LOG: MonitorRunSpec['log'] = { driver: 'json-file', maxSize: '1m', maxFile: '2' };

export interface RemoteSessionMonitorOptions {
  /** The engine of the monitor (the worker's, over the Engine API). */
  engine: MonitorEngine;
  logger: Logger;
  /** The script of the monitor: the worker's bundle (dist/helperChannel.js), whose entry startMonitor runs the Monitor. */
  script: () => Promise<string>;
  /**
   * The settings of the monitor's background run: its schedule (the setting cacheUpdateSchedule: a cron expression or
   * an interval in minutes), the time zone of this computer, and whether it runs permanently.
   */
  imageMaintenance?: () => ImageMaintenanceSettings;
  /**
   * The shared VS Code server store of the engine (the volume that the worker mounts at VSCODE_STORE_DIR,
   * OwnHelper.vscodeStore), which the monitor mounts there too; none: the monitor has no store, and its background run
   * leaves the VS Code server out.
   */
  vscodeStoreVolume?: string;
  /** Only for the Docker tests: another container and volume name, more labels, and variables of the container. */
  containerName?: string;
  volumeName?: string;
  labels?: Readonly<Record<string, string>>;
  containerEnv?: Readonly<Record<string, string>>;
}

/** See RemoteSessionMonitorOptions.imageMaintenance. */
export interface ImageMaintenanceSettings {
  /**
   * A cron expression of five fields, or an interval in whole minutes (parseCacheSchedule).
   */
  schedule: string;
  timeZone: string;
  /** The monitor runs permanently (MonitorSettings.permanent); missing: it ends when idle. */
  permanent?: MonitorSettings['permanent'];
  /** The ID of this computer (MonitorSettings.computer): the owner of a permanent monitor that it creates. */
  computer?: MonitorSettings['computer'];
}

/** The environment variable that tells the monitor that it runs permanently (`1`). */
export const MONITOR_PERMANENT_ENV = 'DEVSPACE_MONITOR_PERMANENT';
/** The environment variable with the name of the VS Code server store that the monitor mounts. */
export const MONITOR_VSCODE_STORE_ENV = 'DEVSPACE_VSCODE_STORE';
/**
 * The environment variable with the nonce of the create of the monitor (LABEL_MONITOR_CREATE): the monitor finds its own
 * container by it, and tells a new container from a restart of the same one (LAST_USE_FILE).
 */
export const MONITOR_CREATE_ID_ENV = 'DEVSPACE_MONITOR_CREATE_ID';

/** What ensure found or did. `failed`: logged as a warning (ensureOrThrow rejects instead). */
export type EnsureOutcome = 'running' | 'started' | 'created' | 'failed';

type Inspected = MonitorInspected;

/**
 * What the read of REMOTE_MONITOR_SCRIPT_PATH of the container (MonitorEngine.storedScript, the archive endpoint of the
 * engine) tells about the stored script: `same` (its hash), `other` (definite evidence of another or no stored script,
 * or of no container), `unknown` (the check itself failed: no answer in time, a transport error, an unexpected answer).
 */
type StoredScript = 'same' | 'other' | 'unknown';

/**
 * The waits (ms) between the looks at the container after a name conflict of the create while that container is
 * `created` (the attached `docker run` of another window between its create and its start) or `removing` (the old
 * monitor that another window removes): 3.75 s in all.
 */
export const REMOTE_MONITOR_CONFLICT_WAITS_MS: readonly number[] = [250, 500, 1_000, 1_000, 1_000];

/**
 * The waits (ms) between the looks at a container of the name that ensure finds `created` (whatever its label) before
 * it decides anything: the attached `docker run` of another window between its create and its start (over SSH one to
 * several seconds). 12.75 s in all.
 */
export const REMOTE_MONITOR_CREATED_WAITS_MS: readonly number[] = [250, 500, 1_000, 1_000, 2_000, 2_000, 2_000, 2_000, 2_000];

/**
 * The most waits of one look after a name conflict (resolveConflict), whatever the status of the container between
 * them: that of the longer list.
 */
const CONFLICT_LOOK_BUDGET = Math.max(REMOTE_MONITOR_CREATED_WAITS_MS.length, REMOTE_MONITOR_CONFLICT_WAITS_MS.length);

/**
 * A container that is still `created` after REMOTE_MONITOR_CREATED_WAITS_MS is removed only when it is older than this
 * on the clock of the daemon: every live create either starts its container or gives up (and removes it by its nonce)
 * within REMOTE_MONITOR_DOCKER_TIMEOUT_MS of its start, so an older one was certainly abandoned (its client died
 * between the create and the start).
 */
export const REMOTE_MONITOR_STALE_CREATED_MS = REMOTE_MONITOR_DOCKER_TIMEOUT_MS + 30_000;

/** A status in which the container runs its script (paused: it goes on when it is unpaused). */
function isRunning(status: string): boolean {
  return status === 'running' || status === 'paused';
}

/** The Monitor container of an engine (its ensure). */
export class RemoteSessionMonitor {
  readonly containerName: string;
  readonly volumeName: string;

  constructor(private readonly options: RemoteSessionMonitorOptions) {
    this.containerName = options.containerName ?? REMOTE_MONITOR_CONTAINER;
    this.volumeName = options.volumeName ?? REMOTE_MONITOR_VOLUME;
  }

  /**
   * Makes sure that the monitor container runs the current script with the helper image `helperTag`, by the state of the
   * container with the name (pipe loading):
   * - the matching label and running or paused → nothing; when Docker restarted it (RestartCount > 0), a read of the
   *   stored script through the archive endpoint checks it (nothing runs in the container, so the read works in every
   *   state of it and the exit of the loader cannot cut it off; a restarted container whose first load was cut off has
   *   none: its loader exits 3 again and again; only in the rare case of a first run that was killed before it wrote its
   *   marker does it wait up to 60 s for an input, as `running`, and this check catches it); only definite evidence of
   *   another or no stored script (storedScript `other`) → `docker rm -f`, then create; a check that fails is followed
   *   by checkAgain (an inspect by the same ID: restarting, exited with LOADER_EXIT_CODE or a grown RestartCount →
   *   replaced), and without evidence it keeps the container (logged);
   * - the matching label and exited with an exit code other than LOADER_EXIT_CODE → `docker start <ID>` (the loader
   *   resumes from the stored script); then the stored script is checked as for a restarted one: `same` → started;
   *   definite evidence of another or no stored script (`other`: a first run killed before its script was stored exits
   *   3 at once) → `docker rm -f <ID>`, then create; a check that fails → checkAgain as for a restarted one, then kept
   *   (logged) without evidence;
   * - created (any label): it may be the create of another window between its create and its start, so ensure looks
   *   again, 12.75 s at most (REMOTE_MONITOR_CREATED_WAITS_MS; a cancellation ends the wait), while the same ID stays
   *   `created`; when another ID is found still `created`, the waits start once more for it (once only, 25.5 s at most
   *   in all); any other state it finds (gone, running, another ID after that, …) goes through this table. Still
   *   `created` → `docker rm -f <ID>`, then create, only when the daemon created it more than
   *   REMOTE_MONITOR_STALE_CREATED_MS ago by the clock of the daemon (`.Created` and `docker info` SystemTime); younger,
   *   or an age that cannot be read → kept, `failed`;
   * - the matching label and restarting with RestartCount 0 or 1 (it failed once) → the stored script is read as for a
   *   restarted one: `same` → nothing (the next start of the restart policy runs it); `other` or `unknown` →
   *   `docker rm -f <ID>`, then create (a container between two failed starts is no healthy monitor to keep without
   *   evidence); restarting with a higher RestartCount (it fails at each start, also with its script) → `docker rm -f
   *   <ID>`, then create, whose ready check reports the cause;
   * - the matching label and dead, removing, or exited with LOADER_EXIT_CODE (the loader refused its stored script and
   *   its input), another label, or none → `docker rm -f <ID>`, then create;
   * - missing → create.
   * `docker rm -f` removes the container by the ID that inspect read, so a window never removes a container that
   * another window created meanwhile: its `rm` gets "No such container", and its create meets the name conflict, which
   * accepts a matching container that runs. Never by the name: when the ID cannot be read, nothing is removed or
   * started and ensure fails. An `rm` that finds the removal of that container already in progress (another window
   * removes it) is tolerated too, and the create goes on to the name conflict.
   * Create: the attached create (runSpec, MonitorEngine.create, over the Engine API) gets the script as the first line
   * of its input, and the monitor is up when its output has REMOTE_MONITOR_READY_TEXT within
   * REMOTE_MONITOR_DOCKER_TIMEOUT_MS; then its input is closed. On a name conflict (another window creates or removes
   * the container meanwhile) it looks again (resolveConflict): while that container is `created` or `removing` it waits
   * and looks again (`created` 12.75 s at most, REMOTE_MONITOR_CREATED_WAITS_MS; `removing`
   * REMOTE_MONITOR_CONFLICT_WAITS_MS; one counter for both; only the budget of 9 waits ends the looks, a shorter list
   * repeats its last wait, so a container that stays `removing` gets 9 waits, 7.75 s, 10 looks in all); a matching one
   * that runs or is paused is accepted; when the name is free, the create is tried once more (once only); anything else
   * (still `created` after the waits, another label, another status) fails. Nothing is removed there: the container is
   * not ours. A conflict is only the daemon's refusal of the name (its status 409 with that message), and only when no
   * container has the nonce of this create (a list that fails is a failure); a matching running container that Docker
   * restarted is accepted only with the stored script of this version; a conflict that fails removes the container of
   * its nonce (none after a true conflict). Any other failure (no ready line in time, the container ended, a
   * cancellation) removes the container of this create (by the nonce label LABEL_MONITOR_CREATE, best effort; never by
   * its name). A create request that the time limit or the cancel cut off may still make its container after this
   * removal; that `created` container is replaced as abandoned after REMOTE_MONITOR_STALE_CREATED_MS. `socketPath`: the
   * source of the socket mount on the host of the engine (as for the workspace helper, rootless aware). `helperImage`:
   * the image of the container when it is not `helperTag`: the checked image ID of the helper image of the open, or its
   * monitor tag, with `imageId`, the image ID that the created container must have (checked by the create before its
   * start); the label and the log lines keep the tag. Never throws, except an AbortError; a failure is logged as a
   * warning.
   */
  async ensure(helperTag: string, socketPath: string, signal?: AbortSignal, helperImage?: string, imageId?: string): Promise<EnsureOutcome> {
    try {
      return await this.ensureOrThrow(helperTag, socketPath, signal, helperImage, imageId);
    } catch (error) {
      if (isAbortError(error)) throw error;
      this.options.logger.warn(`The Monitor on the Docker host could not be started: ${errorMessage(error)}`);
      return 'failed';
    }
  }

  /**
   * Ensure, but a failure rejects with its cause (an Error) instead of `failed`, so the open is refused. Nothing is
   * logged for the failure here; the caller says it.
   */
  async ensureOrThrow(helperTag: string, socketPath: string, signal?: AbortSignal, helperImage?: string, imageId?: string): Promise<Exclude<EnsureOutcome, 'failed'>> {
    const { logger } = this.options;
    const script = await this.options.script();
    // The memory guard of the loader, before an old monitor is removed.
    const scriptLine = encodeBundle(script);
    if (scriptLine.length - 1 > MAX_BUNDLE_LINE_LENGTH) {
      throw new Error(`The script of the Monitor is too long (${scriptLine.length - 1} characters as JSON).`);
    }
    const images = this.options.imageMaintenance?.();
    // The schedule and the time zone come with `settings -` (monitorSettings), so computers with other settings or
    // another time zone on the same engine do not replace it at each open. The label holds the mode (permanent or not:
    // its restart policy and its exit when idle) and the store that it mounts; the owner of a permanent one has its own
    // label (LABEL_MONITOR_OWNER).
    const mode = monitorModeOf(images);
    const store = this.options.vscodeStoreVolume;
    const label = monitorLabel(script, helperTag, mode, store);
    // Several computers can use one engine, so an ensure that wants a monitor that ends when idle takes a running
    // permanent monitor of the same version that another computer owns (LABEL_MONITOR_OWNER) as current (`accepted`),
    // and replaces only this computer's own; one that wants a permanent monitor takes any running permanent one. So
    // turning stopMonitorWhenIdle on replaces this computer's own permanent monitor at its next ensure (so does an ensure
    // of this computer before the user answered the question about the Monitor of the engine), a computer with the
    // setting on never replaces one that another computer created, and one with the setting off (and the answer) makes
    // it permanent again at its next ensure.
    const accepted: AcceptedLabels =
      mode === PERMANENT_LABEL_PART ? { label, mode } : { label, mode, running: monitorLabel(script, helperTag, PERMANENT_LABEL_PART, store), notOwnedBy: images?.computer };
    // The nonce of this create, so that a failure removes only its own container.
    const createId = randomUUID();
    const spec = this.runSpec(helperImage ?? helperTag, socketPath, label, script, images, createId, imageId);
    let current = await this.inspect(signal);
    // A `created` container (of any label) may be the create of another window
    // between its create and its start: look again for a while before anything is decided.
    if (current.exists && current.status === 'created') current = await this.waitWhileCreated(current, signal);
    if (current.exists) {
      const decided = await this.decide(current, accepted, script, signal);
      if (decided !== 'replace') return decided;
      // By its ID only, so never a container that another window created meanwhile.
      await this.options.engine.remove(this.idOf(current), signal);
    }
    let created = await this.create(spec, scriptLine, signal);
    let triedAgain = false;
    // Another window creates or removes it at the same time: accept it when it is the same version and runs. It is not
    // ours, so it is not removed. Wait while it is being created or removed, and create once more when the name became
    // free. A create that met the conflict made no container, so the nonce of this create stays that of the next one.
    while (created.kind === 'exited' && created.conflict) {
      // A container with the nonce of this create means that this create did make one: no conflict. A list that fails
      // is no evidence either way: fail, and remove nothing but by the nonce.
      const own = await this.listOwn(createId, signal);
      if (own === undefined || own.length > 0) {
        await this.removeBestEffort(createId);
        throw new Error(`docker run failed: ${created.detail}`);
      }
      const found = await this.resolveConflict(accepted, script, signal);
      if (found === 'running') return 'running';
      if (found === 'missing' && !triedAgain) {
        triedAgain = true;
        created = await this.create(spec, scriptLine, signal);
        continue;
      }
      // By the nonce only, so after a true conflict it finds nothing.
      await this.removeBestEffort(createId);
      throw new Error(`docker run failed: ${created.detail}`);
    }
    if (created.kind === 'ready') {
      logger.info(`The Monitor on the Docker host was created (${this.containerName}, image ${helperTag}).`);
      return 'created';
    }
    await this.removeBestEffort(createId);
    if (created.kind === 'aborted') throw abortError();
    if (created.kind === 'timeout') {
      throw new Error(`the monitor did not report its start within ${REMOTE_MONITOR_DOCKER_TIMEOUT_MS / 1000} seconds.`);
    }
    throw new Error(`docker run failed: ${created.detail}`);
  }

  /**
   * What ensure does with the existing container `current` (see ensure): `running` or `started` (kept), or `replace`
   * (removed by its ID, then created). Throws when it is kept but ensure fails (a `created` one that may still be
   * starting, an ID that cannot be read).
   */
  private async decide(current: Inspected & { exists: true }, accepted: AcceptedLabels, script: string, signal: AbortSignal | undefined): Promise<'running' | 'started' | 'replace'> {
    const { logger } = this.options;
    if (current.status === 'created') {
      // Still `created` after the waits. Removed only when it is certainly abandoned.
      const age = await this.ageOnDaemon(current, signal);
      if (age === undefined) {
        throw new Error('the container of the Monitor has not started yet and its age cannot be read; it is kept.');
      }
      if (age <= REMOTE_MONITOR_STALE_CREATED_MS) {
        throw new Error(`the container of the Monitor was created ${Math.round(age / 1000)} seconds ago and has not started yet (another window may be starting it); it is kept.`);
      }
      this.idOf(current);
      logger.info(`The Monitor on the Docker host was created ${Math.round(age / 1000)} seconds ago and never started; it is replaced (${this.containerName}).`);
      return 'replace';
    }
    // A running permanent monitor of the same version counts as current for an ensure that wants one that ends when
    // idle (accepted.running); anything else of another label is replaced.
    if (!labelAccepted(current, accepted)) {
      this.idOf(current);
      logger.info(`The Monitor on the Docker host is of another version; it is replaced (${this.containerName}).`);
      return 'replace';
    }
    // The restart policy of the mode of its own label (not of the mode that this ensure wants, so a permanent monitor
    // of another computer stays): a permanent monitor that ended itself after 30 days without use has `no`
    // (src/remoteMonitor/main.ts), and is replaced, so Docker starts it again after a restart of the engine. A policy
    // that cannot be read keeps it.
    const policy = monitorRestartPolicy(acceptedMode(current, accepted) === PERMANENT_LABEL_PART);
    if (current.restartPolicy !== undefined && current.restartPolicy !== policy) {
      this.idOf(current);
      logger.info(`The Monitor on the Docker host has the restart policy "${current.restartPolicy}" instead of "${policy}"; it is replaced (${this.containerName}).`);
      return 'replace';
    }
    if (isRunning(current.status)) {
      // A container that Docker restarted runs its stored script only when it has one; one whose first load was cut off
      // gets a new input without a writer and never its script. RestartCount 0 (a normal open, or the create of another
      // window that is still loading) needs no extra call. A paused one is checked too: the read runs nothing in it.
      if (current.restartCount === 0) return 'running';
      // Only definite evidence replaces it; a check that fails keeps it, after checkAgain.
      let stored = await this.storedScript(script, signal);
      if (stored === 'unknown') stored = await this.checkAgain(current, signal);
      if (stored === 'same') return 'running';
      if (stored === 'unknown') {
        logger.info(`The Monitor on the Docker host was restarted and its stored script could not be checked; it is kept (${this.containerName}).`);
        return 'running';
      }
      this.idOf(current);
      logger.info(`The Monitor on the Docker host was restarted without its script; it is replaced (${this.containerName}).`);
      return 'replace';
    }
    if (current.status === 'exited' && current.exitCode !== LOADER_EXIT_CODE) {
      // Started by its ID, then the stored script is checked as for a restarted one: a first run killed before its
      // script was stored exits 3 again at once. Only definite evidence replaces it.
      const id = this.idOf(current);
      await this.options.engine.start(id, signal);
      let stored = await this.storedScript(script, signal);
      // `docker start` resets RestartCount to 0, so the count before the start is no base for a restart by the policy
      // after it.
      if (stored === 'unknown') stored = await this.checkAgain({ ...current, restartCount: 0 }, signal);
      if (stored === 'same') {
        logger.info(`The Monitor on the Docker host was started again (${this.containerName}).`);
        return 'started';
      }
      if (stored === 'unknown') {
        logger.info(`The Monitor on the Docker host was started again and its stored script could not be checked; it is kept (${this.containerName}).`);
        return 'started';
      }
      logger.info(`The Monitor on the Docker host was started again without its script; it is replaced (${this.containerName}).`);
      return 'replace';
    }
    if (current.status === 'restarting' && current.restartCount <= 1 && (await this.storedScript(script, signal)) === 'same') {
      // Between the first two starts of its restart policy (the script failed once, after a run): it holds the stored
      // script of this version, so the next start runs it. A container that has failed more often fails at each start
      // (the loader already ran this script): it is replaced, so the create's ready check reports the cause. Without
      // the evidence (another or no stored script, or a read that fails) it is replaced as before.
      logger.info(`The Monitor on the Docker host is restarting with its script; it is kept (${this.containerName}).`);
      return 'running';
    }
    this.idOf(current);
    const how = current.status === 'exited' ? `exited with ${current.exitCode}` : current.status;
    logger.info(`The Monitor on the Docker host does not run (${how}); it is replaced (${this.containerName}).`);
    return 'replace';
  }

  /**
   * After a stored-script check of the container `current` that gave `unknown` (the read failed: no answer in time, a
   * transport error), the container of the name is inspected again. The same ID found `restarting`, exited with
   * LOADER_EXIT_CODE, or with a RestartCount above that of `current` is definite evidence that it exits at once without
   * its script → `other` (replaced by its ID). Anything else (the same ID still running, an inspect that fails, a
   * missing container, another ID or an ID that cannot be read) → `unknown` (no evidence: kept). No second read: the
   * read works in every state of the container, so one that failed would most likely fail again. Only an inspect; a
   * cancellation passes (AbortError).
   */
  private async checkAgain(current: Inspected & { exists: true }, signal: AbortSignal | undefined): Promise<'other' | 'unknown'> {
    let again: Inspected;
    try {
      again = await this.inspect(signal);
    } catch (error) {
      if (isAbortError(error)) throw error;
      return 'unknown';
    }
    if (!again.exists || current.id === undefined || again.id !== current.id) return 'unknown';
    if (again.status === 'restarting' || (again.status === 'exited' && again.exitCode === LOADER_EXIT_CODE) || again.restartCount > current.restartCount) {
      return 'other';
    }
    return 'unknown';
  }

  /**
   * The ID of the container that is removed or started; throws when it cannot be read (never the name: the container of
   * the name may be that of another window by then).
   */
  private idOf(current: Inspected & { exists: true }): string {
    if (current.id === undefined) throw new Error('the ID of the Monitor container cannot be read; it is kept.');
    return current.id;
  }

  /**
   * Looks at the container of the name again while it stays `created` with the same ID, with the waits of
   * REMOTE_MONITOR_CREATED_WAITS_MS, and gives the first other state (gone, another status, another ID) or the last
   * look. Only inspects. A cancellation during a wait passes (AbortError). When the name moves to another container
   * that is still `created` (another window removed an abandoned one and created its own, between its create and its
   * start), the waits start once more for that ID (once only: 2 × 12.75 s at most, one budget of looks); another ID
   * after that, or one that cannot be read, ends the wait, and that container is judged by its own age.
   */
  private async waitWhileCreated(first: Inspected & { exists: true }, signal: AbortSignal | undefined): Promise<Inspected> {
    const waits = REMOTE_MONITOR_CREATED_WAITS_MS;
    let found: Inspected = first;
    let id = first.id;
    let restarted = false;
    let step = 0;
    for (let looks = 0; looks < 2 * waits.length && step < waits.length; looks += 1) {
      // The wait of ports.ts (a cancellation ends it with an AbortError).
      await sleep(waits[step], signal);
      step += 1;
      found = await this.inspect(signal);
      if (!found.exists || found.status !== 'created') return found;
      if (found.id !== id) {
        if (restarted || found.id === undefined) return found;
        restarted = true;
        id = found.id;
        step = 0;
      }
    }
    return found;
  }

  /**
   * How long ago (ms) the daemon created `current`, by its creation time and the clock of the daemon
   * (MonitorEngine.daemonTime), so the clock of this computer does not count. Undefined when either cannot be read
   * (logged); a cancellation passes.
   */
  private async ageOnDaemon(current: Inspected & { exists: true }, signal: AbortSignal | undefined): Promise<number | undefined> {
    const { logger } = this.options;
    if (current.createdAt === undefined) {
      logger.info(`The creation time of the Monitor container cannot be read (${this.containerName}).`);
      return undefined;
    }
    const now = await this.options.engine.daemonTime(signal);
    if (typeof now !== 'number') {
      logger.info(`The time of the Docker host cannot be read: ${now.reason}`);
      return undefined;
    }
    return now - current.createdAt;
  }

  /**
   * What the container of the name is after a name conflict of the create: `running` (the matching label, running or
   * paused), `missing` (the name is free again), or `other` (anything else, also a container that is still `created`
   * after the waits of REMOTE_MONITOR_CREATED_WAITS_MS, or still `removing` after the waits of
   * REMOTE_MONITOR_CONFLICT_WAITS_MS: CONFLICT_LOOK_BUDGET waits in all, whatever the status, a shorter list repeating
   * its last wait, so a container that stays `removing` gets 9 waits, 7.75 s, 10 looks in all). Only inspects: it never
   * removes anything. A cancellation during a wait passes (AbortError). A running or paused one that Docker restarted
   * (RestartCount > 0) is accepted only when it holds the stored script of this version (storedScript `same`);
   * otherwise `other` (the next open's first look decides on evidence).
   */
  private async resolveConflict(accepted: AcceptedLabels, script: string, signal: AbortSignal | undefined): Promise<'running' | 'missing' | 'other'> {
    for (let attempt = 0; ; attempt += 1) {
      const found = await this.inspect(signal);
      if (!found.exists) return 'missing';
      // Also a running permanent monitor of the same version for an ensure of one that ends when idle.
      if (labelAccepted(found, accepted) && isRunning(found.status)) {
        if (found.restartCount === 0) return 'running';
        return (await this.storedScript(script, signal)) === 'same' ? 'running' : 'other';
      }
      // A `created` one gets the waits of the first look (the create-to-start gap of another window over SSH), a
      // `removing` one the short ones. One counter for both, never reset, so the waits end after the longer list at
      // most, also when the status changes between them. Only CONFLICT_LOOK_BUDGET bounds the looks. A list shorter
      // than the counter repeats its last wait, so a status that changes late (`created`, then `removing`) still gets a
      // wait.
      const waits = found.status === 'created' ? REMOTE_MONITOR_CREATED_WAITS_MS : found.status === 'removing' ? REMOTE_MONITOR_CONFLICT_WAITS_MS : undefined;
      if (waits === undefined || attempt >= CONFLICT_LOOK_BUDGET) return 'other';
      await sleep(waits[Math.min(attempt, waits.length - 1)], signal);
    }
  }

  /**
   * The attached create of the monitor (MonitorEngine.create): writes `scriptLine` (the first line of the loader), waits for
   * the ready line, its end, the time limit (REMOTE_MONITOR_DOCKER_TIMEOUT_MS), or the cancellation, and then closes its
   * input in every case (after the ready line, the container goes on alone).
   */
  private create(spec: MonitorRunSpec, scriptLine: string, signal: AbortSignal | undefined) {
    return this.options.engine.create(spec, scriptLine, REMOTE_MONITOR_READY_TEXT, signal);
  }

  /**
   * The removal of the container of a failed create; a failure is ignored (the next open replaces it anyway). By the
   * nonce label of this create (the containers with it, then each by its ID), never by the name: when the create failed
   * because another window removed and replaced the container meanwhile ("No such container"), the container of the
   * name is that of the other window.
   */
  private async removeBestEffort(createId: string): Promise<void> {
    try {
      const listed = await this.listOwn(createId, undefined);
      for (const id of listed ?? []) {
        await this.options.engine.remove(id);
      }
    } catch {
      // Best effort.
    }
  }

  /**
   * The IDs of the containers with the nonce `createId` of a create (MonitorEngine.idsWithLabel; only full IDs of 64
   * hex digits); undefined when the list fails. A cancellation passes (the conflict check passes the signal of ensure;
   * the cleanup passes none).
   */
  private async listOwn(createId: string, signal: AbortSignal | undefined): Promise<string[] | undefined> {
    const listed = await this.options.engine.idsWithLabel(`${LABEL_MONITOR_CREATE}=${createId}`, signal);
    return listed?.filter((id) => /^[0-9a-f]{64}$/.test(id));
  }

  /**
   * Whether the container holds the script (the SHA-256 of REMOTE_MONITOR_SCRIPT_PATH in it, read through the archive
   * endpoint, MonitorEngine.storedScript): its bundleHash → `same`; another hash → `other`; definite evidence that no
   * script is stored or that the container does not exist (`none`) → `other`. No answer in time, a failure, or another
   * answer → `unknown`. A cancellation passes.
   */
  private async storedScript(script: string, signal: AbortSignal | undefined): Promise<StoredScript> {
    const found = await this.options.engine.storedScript(this.containerName, signal);
    if (found === 'none') return 'other';
    if (found === 'unknown') return 'unknown';
    return found.hash === bundleHash(script) ? 'same' : 'other';
  }

  /**
   * The container of the monitor as its create makes it (MonitorRunSpec). `helperImage`: the helper tag, or an image ID
   * (pipe loading): the command is the pipe loader with the path, the hash of `script`, and REMOTE_MONITOR_ENTRY; the
   * script itself goes over the input (ensure), never here. `createId`: the nonce of this create
   * (LABEL_MONITOR_CREATE), which ensure always passes. Never a pull: the helper image exists only on the engine.
   * `imageId`: the image ID that the container of the tag `helperImage` must have (MonitorRunSpec.imageId).
   */
  runSpec(helperImage: string, socketPath: string, label: string, script: string, images?: ImageMaintenanceSettings, createId?: string, imageId?: string): MonitorRunSpec {
    const permanent = images?.permanent === true;
    const labels: Record<string, string> = { [LABEL_MONITOR]: label };
    if (createId !== undefined) labels[LABEL_MONITOR_CREATE] = createId;
    // Who wants it permanent; a monitor that ends when idle has no owner.
    if (permanent && images?.computer !== undefined) labels[LABEL_MONITOR_OWNER] = images.computer;
    for (const [key, value] of Object.entries(this.options.labels ?? {})) labels[key] = value;
    const env: Record<string, string> = { ...(this.options.containerEnv ?? {}) };
    // The monitor finds its own container by the nonce (its end after 30 days without use).
    if (createId !== undefined) env[MONITOR_CREATE_ID_ENV] = createId;
    if (images) {
      // The schedule of the whole background run, under the names DEVSPACE_IMAGE_SCHEDULE and DEVSPACE_IMAGE_TZ.
      env.DEVSPACE_IMAGE_SCHEDULE = images.schedule;
      env.DEVSPACE_IMAGE_TZ = images.timeZone;
    }
    // The mode, fixed for the life of the container (it is part of its label).
    if (permanent) env[MONITOR_PERMANENT_ENV] = '1';
    const store = this.options.vscodeStoreVolume;
    if (store !== undefined) env[MONITOR_VSCODE_STORE_ENV] = store;
    // The version of Devspaces that this program got at its start (the worker: from the extension), for the header
    // User-Agent of the Monitor and of the workers of its prepares. Not part of the label: a new version without a
    // change of the script keeps the Monitor, which then names the version that created it.
    const version = userAgentVersion();
    if (version !== undefined) env[VERSION_ENV] = version;
    return {
      name: this.containerName,
      image: helperImage,
      ...(imageId !== undefined ? { imageId } : {}),
      labels,
      // Our own container (the refusal of restart policies is for the containers of repositories). A monitor that ends
      // when idle has `on-failure`: it exits with 0 when it is idle (no running devspace container for 5 minutes,
      // REMOTE_IDLE_EXIT_MS of src/remoteMonitor/main.ts) and stays exited until an open ensures it or the heartbeats
      // of a window repair it; a failure (an uncaught error, the loader's exit 3) is restarted, and the loader resumes
      // from the stored script. A permanent monitor (on any engine, once the user answered the question about it there,
      // with stopMonitorWhenIdle off) never exits when idle and has `unless-stopped`, so Docker starts it again after a
      // crash and after a restart of the engine; after 30 days in which no window used the engine, it sets its own
      // policy to `no` and exits (UnusedEnd of main.ts), and the next ensure replaces it (decide). No published port, no
      // capability: it needs the socket and its volumes.
      restartPolicy: monitorRestartPolicy(permanent),
      // The background run always reaches the update service of VS Code, so it always has the default network (outbound
      // only: it publishes no port and accepts no connection).
      network: 'default',
      log: REMOTE_MONITOR_LOG,
      // The store of the worker read-write at VSCODE_STORE_DIR, as the worker mounts it (nocopy).
      mounts: {
        socket: socketPath,
        volume: this.volumeName,
        volumeTarget: REMOTE_MONITOR_STATE_DIR,
        ...(store !== undefined ? { store: { volume: store, target: VSCODE_STORE_DIR } } : {}),
      },
      env,
      command: loaderCommand({ path: REMOTE_MONITOR_SCRIPT_PATH, hash: bundleHash(script), entry: REMOTE_MONITOR_ENTRY }),
    };
  }

  private inspect(signal: AbortSignal | undefined): Promise<Inspected> {
    return this.options.engine.inspect(this.containerName, signal);
  }
}

/**
 * The label of the monitor container (remoteMonitorLabelValue) for its mode: no part for one that ends when idle,
 * `permanent` for a permanent one (PERMANENT_LABEL_PART); and the store that it mounts (vscodeStoreLabelPart).
 */
export function monitorLabel(script: string, helperTag: string, mode: MonitorMode, store?: string): string {
  return remoteMonitorLabelValue(script, helperTag, [...(mode === 'idle' ? [] : [mode]), ...(store !== undefined ? [vscodeStoreLabelPart(store)] : [])]);
}

/**
 * The labels that an ensure takes as current: its own `label`, and for an ensure of a monitor that ends when idle also
 * `running`, the label of the permanent monitor of the same version, while that container runs and another computer
 * owns it (`notOwnedBy`: this computer; undefined: any owner).
 */
interface AcceptedLabels {
  label: string;
  /** The mode of `label`: the one that the ensure wants. */
  mode: MonitorMode;
  running?: string;
  notOwnedBy?: string;
}

/** Whether the container `found` has a label that the ensure takes as current (AcceptedLabels). */
function labelAccepted(found: Inspected & { exists: true }, accepted: AcceptedLabels): boolean {
  if (found.label === accepted.label) return true;
  if (accepted.running === undefined || found.label !== accepted.running || !isRunning(found.status)) return false;
  return accepted.notOwnedBy === undefined || found.owner !== accepted.notOwnedBy;
}

/** The mode of the label of `found`, which labelAccepted took: that of `label`, or permanent (`running`). */
function acceptedMode(found: Inspected & { exists: true }, accepted: AcceptedLabels): MonitorMode {
  return found.label === accepted.label ? accepted.mode : PERMANENT_LABEL_PART;
}
