// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The helper channels of a window: at most one per Docker engine, opened at its first use, closed after
// CHANNEL_IDLE_CLOSE_MS without an operation, and opened again after it was lost. When it cannot be opened, it is not
// tried again for CHANNEL_RETRY_AFTER_FAILURE_MS (clearFailures ends that wait). For the local Docker too, never for an
// unsupported endpoint. A call that needs the worker (a flow, the refresh) first makes it ready (the helper image, then
// the open in full, also within that wait); when it cannot, the call is refused, never taken a way without it. The
// worker runs the whole pipeline itself; the extension relays no Docker calls, pulls, starts or locks through it. No
// `vscode`.
import { runWithDockerTarget } from '../docker/dockerTargets';
import { isPodmanDockerTarget, isUnreadableDockerTarget, type DockerTarget } from '../docker/dockerHost';
import type { HelperMaintenance } from '../helper/helperImages';
import { bundleHash, loaderCommand } from '../loader/pipeLoader';
import { HELPER_DOCKER_SOCKET, LABEL_HELPER_CHANNEL, LABEL_HELPER_RUN, VSCODE_STORE_DIR, freeWorkerNumber, workerName, workerNameStart } from '../names';
import { errorMessage, isUserFacingError } from '../errors';
import { VERSION_ENV, isDevspacesVersion, userAgentVersion } from '../http';
import { abortError, isAbortError, type Logger, type RunOptions, type RunResult, type StartedProcess } from '../ports';
import { HelperChannel, HelperChannelError } from './helperChannel';
import {
  CHANNEL_ENTRY,
  CHANNEL_IDLE_CLOSE_MS,
  CHANNEL_SCRIPT_PATH,
  ENGINE_IDENTITY_ARGS,
  LOCK_STATE_DIR,
  OP_PROBE,
  OP_REFRESH,
  OP_SWEEP,
  channelLabelValue,
  engineIdentity,
  parseProbeParams,
  parseProbeValue,
  parseRefreshParams,
  parseRefreshValue,
  parseSweepParams,
  parseSweepValue,
  sameEngine,
  type EngineIdentity,
} from './protocol';
import type { DevspaceStates, StateDevspace } from '../pipeline/refreshStates';

/** The time limit of the operation `refresh`. */
export const CHANNEL_REFRESH_TIMEOUT_MS = 5 * 60_000;

/** After a channel could not be opened, the next attempt for that host waits this long. */
export const CHANNEL_RETRY_AFTER_FAILURE_MS = 5 * 60_000;
/** Time limit of the probe after the start. */
export const CHANNEL_PROBE_TIMEOUT_MS = 30_000;
/** How often the idle channels are looked for. */
export const CHANNEL_SWEEP_INTERVAL_MS = 60_000;

/**
 * The refresh of the sidebar, which no user starts, waits at most this long for a worker that is being opened (longer
 * than a usual open over SSH, far shorter than a hung one); then it is refused, and the open goes on for the next
 * calls.
 */
export const CHANNEL_PASSIVE_OPEN_WAIT_MS = 30_000;

/**
 * `docker run` arguments of a channel container: `--rm -i`, never a pull (the helper image is built by the open
 * pipeline, or made ready by HelperChannelsOptions.prepare; without it the start fails), the labels, outbound network
 * only, no capability, no new privileges, only the Docker socket of the engine, the volume of the lock files
 * (`stateVolume`), and the shared VS Code server store (`vscodeVolume`) at VSCODE_STORE_DIR. Its only variable is
 * VERSION_ENV with the version of Devspaces (`version`, when it is a version x.y.z), for the header User-Agent of its
 * HTTPS requests. The command is the pipe loader with CHANNEL_SCRIPT_PATH, the hash of the script (`scriptHash`,
 * bundleHash), and CHANNEL_ENTRY; the script itself comes as the first line of the input (HelperChannel.open), never on
 * the command line.
 */
export function channelRunArgs(p: {
  tag: string;
  socketPath: string;
  stateVolume: string;
  vscodeVolume: string;
  containerName: string;
  label: string;
  scriptHash: string;
  network?: 'bridge' | 'none';
  version?: string;
}): string[] {
  // --mount is CSV: a path with a comma or a quote would change the mount.
  if (/[",]/.test(p.socketPath)) throw new HelperChannelError('open', `The Docker socket path ${p.socketPath} cannot be mounted.`);
  for (const volume of [p.stateVolume, p.vscodeVolume]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(volume)) throw new HelperChannelError('open', `The volume ${volume} cannot be mounted.`);
  }
  return [
    'run',
    '--rm',
    '-i',
    '--pull',
    'never',
    '--name',
    p.containerName,
    '--label',
    `${LABEL_HELPER_RUN}=true`,
    '--label',
    `${LABEL_HELPER_CHANNEL}=${p.label}`,
    // The worker gets outbound network: the default bridge, never a published port; its HTTPS goes through the proxy of
    // the daemon (proxyTransport.ts).
    '--network',
    p.network ?? 'bridge',
    // The engine keeps no log of the channel (its commands and output), whatever its log driver.
    '--log-driver',
    'none',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--mount',
    `type=bind,source=${p.socketPath},target=${HELPER_DOCKER_SOCKET}`,
    // The volume of the Monitor, for the lock files of the devspaces (lock.ts of the worker).
    '--mount',
    `type=volume,source=${p.stateVolume},target=${LOCK_STATE_DIR}`,
    // The VS Code caches are worker operations: the shared VS Code server store of the engine, read-write (only the
    // worker writes it; the dev containers get it read-only). The worker reads its name from the inspect of its own
    // container (readOwnHelper). `volume-nocopy`, as the mount of the dev containers (vscodeStoreMount): the store's
    // content comes only from ensureServer, never from an image.
    '--mount',
    `type=volume,source=${p.vscodeVolume},target=${VSCODE_STORE_DIR},volume-nocopy`,
    ...(isDevspacesVersion(p.version) ? ['--env', `${VERSION_ENV}=${p.version}`] : []),
    p.tag,
    ...loaderCommand({ path: CHANNEL_SCRIPT_PATH, hash: p.scriptHash, entry: CHANNEL_ENTRY }),
  ];
}

export interface ChannelOpenDeps {
  /** BootstrapDocker.start: `docker <args>` with the environment of the operation (its Docker context). */
  start(args: readonly string[]): StartedProcess | undefined;
  /**
   * BootstrapDocker.run: `docker <args>` without the worker, with the environment of the operation (the engine identity
   * of the open).
   */
  runDirect(args: readonly string[], options?: RunOptions): Promise<RunResult>;
  logger: Logger;
  /** The content of dist/helperChannel.js. */
  script(): Promise<string>;
  /** The tag of the workspace helper image (helperImageTag of the Dockerfile of the extension). */
  helperTag(): Promise<string>;
  /** The source of the socket mount on the host of the engine (rootless aware). */
  socketPath(target: DockerTarget): Promise<string>;
  /**
   * The volume with the lock files of the devspaces: the volume of the Monitor (REMOTE_MONITOR_VOLUME), the
   * same for every engine, local and remote (the Docker tests: a volume of their own).
   */
  stateVolume: string;
  /**
   * The shared VS Code server store of the engine (VSCODE_STORE_VOLUME, the same for every engine; the Docker tests: a
   * volume of their own, so that the store of the engine is never created or touched).
   */
  vscodeVolume: string;
  /**
   * The name of the window, read once for each open of a worker channel (also when the worker takes another number or
   * starts without network) for the name of its container (workerNameStart; ConnectionAdapter.windowName). Without
   * it, the worker is named as a window without a name.
   */
  windowName?(): string;
  /**
   * The name of the devspace of the window when it is on the engine of this open (resourceName; windowDevspaceName),
   * read with windowName: the worker of a window of a devspace on its engine is named after it (workerNameStart).
   * Undefined for a window of no devspace and for another engine; when it fails, the worker is named after the window.
   */
  devspaceName?(): Promise<string | undefined>;
}

/** Docker's refusal of `--network bridge` on a daemon without it. */
const NO_BRIDGE = /network "?bridge"? not found/i;
/** Docker's refusal of a container name that another container on the engine has. */
const NAME_IN_USE = /container name "?[^"\s]*"? is already in use/i;
/**
 * The most worker names (workerNameStart) that Docker may refuse in one open, also across the start without
 * network; the open fails at the last one. Enough for that many windows with the same name that start their workers on
 * one engine at the same moment.
 */
const WORKER_NAME_ATTEMPTS = 10;

/** The name of the engine of `target` in the log. */
function engineName(target: DockerTarget): string {
  return target.kind === 'local' ? 'the local Docker' : target.host;
}

/** An engine identity in a message: its ID and root folder as JSON strings (control characters escaped). */
function identityText(identity: EngineIdentity): string {
  return `${JSON.stringify(identity.id)} ${JSON.stringify(identity.rootDir)}`;
}

/**
 * Opens a channel to the engine of `target`: starts the container with the Docker context of `target`, then checks with
 * the operation `probe` that the worker reaches its engine, and that it is the engine of `target`: the engine identity
 * of the probe must be the one that ENGINE_IDENTITY_ARGS reads without the worker (a socket mount of another engine,
 * for example with DOCKER_HOST set to a TCP endpoint of this computer, is refused). The worker reads its identity over
 * the Engine API (`GET /info`), so both are compared as their values (sameEngine; the Docker CLI prints them as JSON in
 * Go's form, which escapes `<`, `>` and `&`), and the value of the worker is checked (parseProbeValue) as everything
 * that it answers. Throws HelperChannelError('open').
 */
export async function openHelperChannel(deps: ChannelOpenDeps, target: DockerTarget): Promise<HelperChannel> {
  const devspaceName = async (): Promise<string | undefined> => {
    try {
      return await deps.devspaceName?.();
    } catch (error) {
      deps.logger.warn(`The devspace of this window could not be found for the name of its worker (${errorMessage(error)}), so the worker is named after the window.`);
      return undefined;
    }
  };
  const [script, tag, socketPath, devspace] = await Promise.all([deps.script(), deps.helperTag(), deps.socketPath(target), devspaceName()]);
  const name = engineName(target);
  const label = channelLabelValue(script);
  const scriptHash = bundleHash(script);
  const startNamed = async (network: 'bridge' | 'none', containerName: string): Promise<HelperChannel> => {
    // The version of this extension (activate), which the worker names in the header User-Agent and passes on.
    const version = userAgentVersion();
    const args = channelRunArgs({ tag, socketPath, stateVolume: deps.stateVolume, vscodeVolume: deps.vscodeVolume, containerName, label, scriptHash, network, version });
    const process = await runWithDockerTarget(target, async () => deps.start(args));
    if (process === undefined) throw new HelperChannelError('open', 'The Docker CLI cannot be started.');
    return HelperChannel.open(process, script, { logger: deps.logger, name });
  };
  const nameStart = workerNameStart(deps.windowName?.() ?? '', devspace);
  // The names of the containers of the engine that contain nameStart, with one call without the worker (`,` separates
  // the names of one container); undefined when the list fails (the last list stays, and the next number is tried
  // then).
  const workerNames = async (): Promise<string[] | undefined> => {
    let detail: string;
    try {
      const result = await runWithDockerTarget(target, () =>
        deps.runDirect(['ps', '--all', '--filter', `name=${nameStart}`, '--format', '{{.Names}}'], { timeoutMs: CHANNEL_PROBE_TIMEOUT_MS }),
      );
      if (result.exitCode === 0) return result.stdout.split(/[\n,]/).map((line) => line.trim());
      detail = result.timedOut ? 'no answer in time' : result.stderr.trim().slice(-500) || `exit code ${result.exitCode}`;
    } catch (error) {
      detail = errorMessage(error);
    }
    deps.logger.info(
      `The containers on ${name} could not be listed for the name of the worker (${detail}), so the worker takes the lowest number that Docker did not refuse and that no earlier list showed.`,
    );
    return undefined;
  };
  // The numbers whose names Docker refused in this open (at most WORKER_NAME_ATTEMPTS), and the last list of the
  // engine, also for the start without network.
  const inUse = new Set<number>();
  let listed: string[] = [];
  // The worker with the lowest number from 1 that Docker did not refuse (workerNameStart). When another container
  // on the engine has the name (a worker of another window with the same name, or the last worker of this window while
  // Docker removes it; Docker created nothing), the lowest number that no container has, from a new list of the engine
  // after each refusal.
  const start = async (network: 'bridge' | 'none'): Promise<HelperChannel> => {
    for (let number = freeWorkerNumber(nameStart, listed, inUse); ; ) {
      const containerName = workerName(nameStart, number);
      try {
        return await startNamed(network, containerName);
      } catch (error) {
        if (!(error instanceof HelperChannelError) || !NAME_IN_USE.test(error.message)) throw error;
        inUse.add(number);
        if (inUse.size >= WORKER_NAME_ATTEMPTS) {
          throw new HelperChannelError(error.code, `${error.message} Docker refused ${inUse.size} names of the worker on ${name} because other containers have them.`);
        }
        listed = (await workerNames()) ?? listed;
        number = freeWorkerNumber(nameStart, listed, inUse);
        deps.logger.info(`The worker name ${containerName} is in use on ${name}, so the worker starts as ${workerName(nameStart, number)}.`);
      }
    }
  };
  let channel: HelperChannel;
  try {
    channel = await start('bridge');
  } catch (error) {
    // A daemon without its default bridge (`"bridge": "none"`) starts the worker without network; only what needs it
    // (the image check, the downloads) fails then, and the log says why.
    if (!(error instanceof HelperChannelError) || !NO_BRIDGE.test(error.message)) throw error;
    deps.logger.warn(`The Docker engine ${name} has no default bridge network, so the worker runs without outbound network there: image checks and downloads in the worker cannot reach the network.`);
    channel = await start('none');
  }
  let engine: EngineIdentity | undefined;
  try {
    // The parameters of the schema of both sides (none).
    const probe = parseProbeValue(await channel.operation(OP_PROBE, parseProbeParams({}), { timeoutMs: CHANNEL_PROBE_TIMEOUT_MS }));
    if (probe?.serverVersion === undefined) throw new Error(probe?.detail ?? 'an invalid answer');
    engine = probe.engine;
  } catch (error) {
    channel.close();
    throw new HelperChannelError('open', `The helper channel to ${name} does not reach Docker: ${(error as Error).message}`);
  }
  // The engine identity, compared as values with one call without the worker.
  let direct: EngineIdentity | undefined;
  let directDetail = '';
  try {
    const result = await runWithDockerTarget(target, () => deps.runDirect(ENGINE_IDENTITY_ARGS, { timeoutMs: CHANNEL_PROBE_TIMEOUT_MS }));
    direct = result.exitCode === 0 ? engineIdentity(result.stdout) : undefined;
    directDetail = result.stderr.trim().slice(-500);
  } catch (error) {
    directDetail = (error as Error).message;
  }
  if (engine === undefined || direct === undefined || !sameEngine(engine, direct)) {
    channel.close();
    const why =
      engine === undefined
        ? 'the helper did not name its Docker engine'
        : direct === undefined
          ? `the Docker engine could not be identified without it${directDetail ? ` (${directDetail})` : ''}`
          : `it reaches another Docker engine (${identityText(engine)}) than the Docker calls without it (${identityText(direct)})`;
    throw new HelperChannelError('open', `The helper channel to ${name} was closed: ${why}.`);
  }
  // Channel containers that an earlier open created but never started are removed, in the background (a failure is
  // logged; the channel is open already). Its value is checked (parseSweepValue) and the number of removed containers
  // logged. Always sent; the worker is this extension's own bundle (its hash checked by the loader, its protocol at
  // `hello`), which knows `sweep`. It removes every stopped helper container older than 10 minutes, the channels and
  // the batch helpers of the worker, never the Monitor (SWEEP_FILTERS).
  void channel.operation(OP_SWEEP, parseSweepParams({}), { timeoutMs: CHANNEL_PROBE_TIMEOUT_MS }).then(
    (value) => {
      const swept = parseSweepValue(value);
      if (swept === undefined) deps.logger.warn(`The worker on ${name} answered the removal of the stopped helper containers with an invalid value.`);
      else if (swept.removed > 0) deps.logger.info(`Removed ${swept.removed} stopped helper ${swept.removed === 1 ? 'container' : 'containers'} on ${name}.`);
    },
    (error: unknown) => {
      deps.logger.info(`The stopped helper containers on ${name} could not be removed: ${(error as Error).message}`);
    },
  );
  return channel;
}

interface Entry {
  channel?: HelperChannel;
  opening?: Promise<HelperChannel | undefined>;
  failedAt?: number;
  /** Why the last open failed (for the refusal of a call). */
  failure?: string;
  /** Closed by `close` while it was being opened: the channel of that open is closed at once. */
  closed?: boolean;
}

export interface HelperChannelsOptions {
  open(target: DockerTarget): Promise<HelperChannel>;
  /**
   * Makes the state that a worker of `target` needs consistent before it is opened for a call (a flow, the refresh):
   * the helper image, built when its tag is missing (HelperImages.ensureImagePresent). `maintenance` when the call is
   * an operation `open` (its flow option `helperMaintenance`): the maintaining ensure in its place
   * (HelperImages.ensureImageUse: the rebuild that a check asked for, the weekly check of the base image, the daily
   * cleanup), before the worker of the open starts (not while another call opens the worker of the engine). Rejects
   * when it cannot; the call is then refused. An AbortError when `signal` aborts.
   */
  prepare?(target: DockerTarget, signal: AbortSignal | undefined, maintenance?: HelperMaintenance): Promise<void>;
  /**
   * What the refresh of the sidebar, which no user starts, checks instead of `prepare`: that the helper image is
   * present (HelperImages.checkImagePresent), never a build, so a refresh neither waits for a build without a time
   * limit nor builds again after each failed build. Rejects when the image is missing or cannot be checked; the refresh
   * is then refused, and the next operation (Start, Stop, Delete) builds it.
   */
  checkPresent?(target: DockerTarget, signal: AbortSignal | undefined): Promise<void>;
  /**
   * The refresh (`refresh`, not another passive read) was refused because `checkPresent` rejected: the helper image of
   * `target` is missing or could not be checked. The window builds it in the background then (MissingHelperBuild); the
   * refresh itself still never builds and never waits for a build.
   */
  onRefreshWithoutHelper?(target: DockerTarget): void;
  logger: Logger;
  idleCloseMs?: number;
  retryAfterFailureMs?: number;
  sweepIntervalMs?: number;
}

/**
 * The key of the engine of a target: its Docker context and its endpoint. By the context alone, a context of the user
 * that is pointed to another host under the same name (`docker context update`) would keep the channel to the old
 * engine, and the calls through it would go there. The channel of the old endpoint gets no new operation and is closed
 * by the sweep after CHANNEL_IDLE_CLOSE_MS. Not seen: an SSH alias of `~/.ssh/config` pointed to another machine (the
 * same endpoint).
 */
function keyOf(target: DockerTarget): string {
  return JSON.stringify([target.context ?? null, target.endpoint]);
}

/** The channels of this window, one per Docker engine (local and remote). */
export class HelperChannels {
  private readonly entries = new Map<string, Entry>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private disposed = false;

  constructor(private readonly options: HelperChannelsOptions) {
    this.sweepTimer = setInterval(() => this.sweep(), options.sweepIntervalMs ?? CHANNEL_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  /**
   * The next get of every engine opens a channel again at once, also within CHANNEL_RETRY_AFTER_FAILURE_MS after a
   * failed open (the Docker engine began to answer, or the helper image was built).
   */
  clearFailures(): void {
    for (const entry of this.entries.values()) entry.failedAt = undefined;
  }

  /**
   * The open channel to the engine of `target`, opened now if needed. Undefined for an unsupported target, after
   * dispose, when it cannot be opened (logged once per attempt; the next attempt after CHANNEL_RETRY_AFTER_FAILURE_MS),
   * and when it is not open within `wait.waitMs`. Rejects only with an AbortError when `wait.signal` aborts, as every
   * call with that signal does.
   */
  async get(target: DockerTarget, wait: { signal?: AbortSignal; waitMs?: number } = {}): Promise<HelperChannel | undefined> {
    if (wait.signal?.aborted) throw abortError();
    const opening = this.channelFor(target);
    if (wait.waitMs === undefined && wait.signal === undefined) return opening;
    // The caller's signal and its time for the wait end the wait, not the opening.
    return new Promise<HelperChannel | undefined>((resolve, reject) => {
      const timer = wait.waitMs === undefined ? undefined : setTimeout(() => done(() => resolve(undefined)), wait.waitMs);
      const onAbort = () => done(() => reject(abortError()));
      wait.signal?.addEventListener('abort', onAbort, { once: true });
      let settled = false;
      const done = (settle: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        wait.signal?.removeEventListener('abort', onAbort);
        settle();
      };
      opening.then((channel) => done(() => resolve(channel)));
    });
  }

  /** The open channel, or the shared opening of one (see get). */
  private async channelFor(target: DockerTarget): Promise<HelperChannel | undefined> {
    // The local Docker too; never an endpoint that is neither local nor SSH.
    if (this.disposed || (target.kind !== 'remote' && target.kind !== 'local')) return undefined;
    const key = keyOf(target);
    let entry = this.entries.get(key);
    if (entry === undefined) {
      entry = {};
      this.entries.set(key, entry);
    }
    if (entry.channel?.isOpen) return entry.channel;
    if (entry.opening) return entry.opening;
    const retryAfter = this.options.retryAfterFailureMs ?? CHANNEL_RETRY_AFTER_FAILURE_MS;
    if (entry.failedAt !== undefined && Math.abs(Date.now() - entry.failedAt) < retryAfter) return undefined;
    const current = entry;
    current.channel = undefined;
    current.opening = this.options.open(target).then(
      (channel) => {
        current.opening = undefined;
        if (this.disposed || current.closed === true) {
          channel.close();
          return undefined;
        }
        current.channel = channel;
        current.failedAt = undefined;
        channel.onClose(() => {
          if (current.channel === channel) current.channel = undefined;
        });
        return channel;
      },
      (error: unknown) => {
        current.opening = undefined;
        current.failedAt = Date.now();
        current.failure = (error as Error).message;
        this.options.logger.info(
          // The calls that need it are refused, never run without it.
          `${(error as Error).message} The Docker calls of operations on ${engineName(target)} are refused until it is open.`,
        );
        return undefined;
      },
    );
    return current.opening;
  }

  /**
   * The open channel to the engine of `target`, made ready now if needed: when none is open, first `prepare` (the
   * helper image; `checkPresent` when `passive`, for the refresh), then the open in full (openInFull; when `passive`,
   * the open that keeps the wait after a failed open). Throws HelperChannelError('unavailable') with the cause when
   * either fails, and an AbortError when `signal` aborts. `maintenance` (the flow of an operation `open`) goes to
   * `prepare`; a worker that is open already is used as it is, without a preparation, and one that another call is
   * opening gets the preparation without the maintenance.
   */
  private async ready(
    target: DockerTarget,
    signal: AbortSignal | undefined,
    passive = false,
    maintenance?: HelperMaintenance,
    refresh = false,
  ): Promise<HelperChannel> {
    if (signal?.aborted) throw abortError();
    const open = this.entries.get(keyOf(target))?.channel;
    if (open?.isOpen) return open;
    this.refuseUnsupported(target);
    // The refresh only checks the helper image (checkPresent), never builds it.
    const prepare = passive ? this.options.checkPresent : this.options.prepare;
    if (prepare !== undefined) {
      try {
        // The maintenance of the flow of an operation `open` goes to `prepare`; the check of a passive read
        // (checkPresent) never gets one. Nor does the preparation while another call opens the worker of the engine:
        // the open joins that worker, which starts from the image that the tag has before a rebuild, so it would wait
        // for a rebuild that it does not use.
        const opening = this.entries.get(keyOf(target))?.opening !== undefined;
        if (!passive && maintenance !== undefined && !opening) await this.options.prepare?.(target, signal, maintenance);
        else await prepare(target, signal);
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) throw isAbortError(error) ? error : abortError();
        const cause = isUserFacingError(error) && error.detail ? `${error.message} ${error.detail}` : errorMessage(error);
        this.options.logger.warn(`The helper image for the worker on ${engineName(target)} could not be prepared: ${cause}`);
        // The refresh found no helper image; the window builds it in the background (never this refresh).
        if (passive && refresh) this.reportRefreshWithoutHelper(target);
        throw new HelperChannelError('unavailable', `the helper image could not be prepared: ${cause}`);
      }
    }
    if (passive) {
      // The refresh keeps the wait after a failed open (CHANNEL_RETRY_AFTER_FAILURE_MS): within it, it is refused at
      // once; only an operation (a flow that is not passive) opens again at once (openInFull). At most
      // CHANNEL_PASSIVE_OPEN_WAIT_MS for an open that is still running.
      const channel = await this.get(target, { signal, waitMs: CHANNEL_PASSIVE_OPEN_WAIT_MS });
      if (channel !== undefined) return channel;
      this.refuseUnsupported(target);
      const entry = this.entries.get(keyOf(target));
      if (entry?.opening !== undefined) throw new HelperChannelError('unavailable', 'the worker is still being opened');
      throw new HelperChannelError('unavailable', entry?.failure ?? 'the worker could not be opened');
    }
    return this.openInFull(target, signal);
  }

  /** HelperChannelsOptions.onRefreshWithoutHelper; a failure of it is logged, never thrown. */
  private reportRefreshWithoutHelper(target: DockerTarget): void {
    try {
      this.options.onRefreshWithoutHelper?.(target);
    } catch (error) {
      this.options.logger.warn(`The background build of the helper image on ${engineName(target)} could not be requested: ${errorMessage(error)}`);
    }
  }

  /**
   * No worker for the window that closes, or for an endpoint that is neither local nor SSH, a current context that
   * could not be read, or Podman.
   */
  private refuseUnsupported(target: DockerTarget): void {
    if (this.disposed) throw new HelperChannelError('unavailable', 'the window is closing');
    if (isUnreadableDockerTarget(target)) throw new HelperChannelError('unavailable', 'the current Docker context could not be read');
    if (isPodmanDockerTarget(target)) throw new HelperChannelError('unavailable', 'the docker command uses Podman, which Devspaces does not support');
    if (target.kind !== 'remote' && target.kind !== 'local') throw new HelperChannelError('unavailable', 'the Docker endpoint is neither local nor SSH');
  }

  /**
   * For the flows, an explicit attempt to make the state consistent: the wait after a failed open ends for this engine,
   * and the open is awaited in full. Throws HelperChannelError('unavailable') with the cause of the failed open, and an
   * AbortError when `signal` aborts.
   */
  private async openInFull(target: DockerTarget, signal: AbortSignal | undefined): Promise<HelperChannel> {
    const entry = this.entries.get(keyOf(target));
    if (entry !== undefined) entry.failedAt = undefined;
    const channel = await this.get(target, { signal });
    if (channel !== undefined) return channel;
    this.refuseUnsupported(target);
    throw new HelperChannelError('unavailable', this.entries.get(keyOf(target))?.failure ?? 'the worker could not be opened');
  }

  /**
   * A flow in the worker of `target` (HelperChannel.flow). Made ready (ready: HelperChannelError('unavailable') when
   * that fails), and sent once more through a channel made ready again when it was not sent because the channel closed
   * before (`closed`: it did not run); never a way without the worker. With `passive` (a read in the background, as the
   * refresh), the worker is made ready as for the refresh: the helper image is only checked, never built, and the wait
   * after a failed open is kept (ready). `helperMaintenance` (only the operation `open` passes it) makes the
   * preparation of a worker that is not open yet the maintaining ensure (ready); it is not sent to the worker.
   */
  async flow(
    target: DockerTarget,
    op: string,
    params: unknown,
    options: Parameters<HelperChannel['flow']>[2] & { passive?: boolean; helperMaintenance?: HelperMaintenance } = {},
  ): Promise<unknown> {
    const { passive, helperMaintenance, ...flowOptions } = options;
    return this.withChannel(target, options.signal, (channel) => channel.flow(op, params, flowOptions), passive === true, helperMaintenance);
  }

  /** `call` with the channel of `target` (ready), once more through a new channel when it was `closed`. */
  private async withChannel<T>(
    target: DockerTarget,
    signal: AbortSignal | undefined,
    call: (channel: HelperChannel) => Promise<T>,
    passive = false,
    maintenance?: HelperMaintenance,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const channel = await this.ready(target, signal, passive, maintenance);
      try {
        return await call(channel);
      } catch (error) {
        if (attempt === 0 && error instanceof HelperChannelError && error.code === 'closed') continue;
        throw error;
      }
    }
  }

  /**
   * readDevspaceStates in the worker of `target` (the operation `refresh`), with the strict checks of its parameters
   * and its value (protocol.ts); never a way without the worker. The worker is made ready first (ready:
   * HelperChannelError('unavailable') when that fails; the worker is this extension's own bundle, which knows
   * `refresh`); parameters beyond the check reject with HelperChannelError('unsendable'); a refresh that was not sent
   * because the channel closed before is sent once more through a channel made ready again. Rejects when it was sent and
   * failed, or answered with an invalid value.
   */
  async refresh(target: DockerTarget, devspaces: readonly StateDevspace[], signal?: AbortSignal): Promise<DevspaceStates> {
    const params = parseRefreshParams({ devspaces });
    if (params === undefined) throw new HelperChannelError('unsendable', 'The devspaces are beyond what the refresh of the worker carries.');
    for (let attempt = 0; ; attempt++) {
      const channel = await this.ready(target, signal, true, undefined, true);
      let value: unknown;
      try {
        value = await channel.operation(OP_REFRESH, params, { timeoutMs: CHANNEL_REFRESH_TIMEOUT_MS, signal });
      } catch (error) {
        if (attempt === 0 && error instanceof HelperChannelError && error.code === 'closed') continue;
        throw error;
      }
      const states = parseRefreshValue(value, params);
      if (states === undefined) throw new HelperChannelError('protocol', 'The worker answered the refresh with an invalid value.');
      return states;
    }
  }

  /** Closes the channels without an operation for CHANNEL_IDLE_CLOSE_MS. */
  sweep(): void {
    const idleMs = this.options.idleCloseMs ?? CHANNEL_IDLE_CLOSE_MS;
    for (const entry of this.entries.values()) {
      const channel = entry.channel;
      if (channel?.isOpen && channel.busy === 0 && Date.now() - channel.lastUsed >= idleMs) {
        this.options.logger.info('A helper channel was closed after a time without use.');
        entry.channel = undefined;
        channel.close();
      }
    }
  }

  /**
   * Closes the channel to the engine of `target` ("Remove Devspaces from This Docker Engine…" removes the containers of
   * the workers next): its input ends, so the worker ends what still runs and exits (HelperChannel.close). A channel that
   * is being opened is closed once it is open. The next call that needs the worker opens a new one.
   */
  close(target: DockerTarget): void {
    const key = keyOf(target);
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.entries.delete(key);
    entry.closed = true;
    const channel = entry.channel;
    entry.channel = undefined;
    if (channel === undefined) return;
    this.options.logger.info(`The helper channel to ${engineName(target)} was closed.`);
    channel.close();
  }

  /**
   * Closes every channel (the window closes): at once (closeNow), because the extension host may end right after, and
   * no timer of it runs then.
   */
  dispose(): void {
    this.disposed = true;
    clearInterval(this.sweepTimer);
    for (const entry of this.entries.values()) entry.channel?.closeNow();
    this.entries.clear();
  }
}
