// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// What the window's operations (DevspaceOperations: they send the flows to the worker) and the worker's pipeline
// (DevspaceService) share: the texts, the time limits of the flows, the targets and options of an operation, and the
// rules of an operation in a window (one operation per repository at a time, the sign-in, the Docker host of the
// operation, the busy marks of the other windows, the cleanup of the session files). It imports nothing of the
// pipeline, so the extension's bundle holds none of it, and no window operation can bypass the worker. No `vscode`.
import type { VscodeServerLink } from '../helperChannel/protocol';
import { type BusyMarkView, type DevspaceBusyMarks } from './busyMarks';
import { dockerHostOf, isOnDockerHost, isUnreadableDockerTarget, unsupportedTargetReason, type DockerTarget } from '../docker/dockerHost';
import { dockerEndpointUnsupported, unsupportedTargetMessage } from '../docker/remoteDocker';
import { BatchHelperUnavailableError, UserFacingError, errorMessage, isUserFacingError } from '../errors';
import { type FlowRefusal } from '../helperChannel/protocol';
import { Messages, Steps, type ProgressStep } from '../messages';
import { isAvailableTo } from '../ownership';
import {
  abortError,
  isAbortError,
  isoTime,
  sleep as defaultSleep,
  type Clock,
  type GitHubAuth,
  type Logger,
  type PipelineUi,
  type ProgressReporter,
} from '../ports';
import { isProcessAlive } from '../session/sessionRules';
import { type DevspaceRegistry } from '../storage/registry';
import type { SessionFiles } from '../storage/sessionFiles';
import type {
  BusyMark,
  BusyOperation,
  Devspace,
  DevspaceSource,
  ExtensionSettings,
  GitHubAccount,
  WindowStatus,
} from '../types';
import {
  otherWindowMarkIsLive,
  readLiveness,
  type MarkLiveness,
  type OpenRecords,
} from './openRecords';
import { windowLifecycleMemory, type LifecycleMemory } from './lifecycleMemory';

// User-visible texts that messages.ts lacks (plain language); to be moved there.
export const PipelineTexts = {
  cancelled: 'The operation was cancelled.',
  startFailed: 'The devspace could not be started.',
  devspaceMissing: 'This devspace does not exist anymore.',
  devspaceBusy: (repository: string) =>
    `${repository} is being changed in another window. Try again when this is finished.`,
  preparingHelper: 'The workspace helper is being prepared. This happens once and can take a few minutes.',
  updatingHelper: 'The workspace helper is being updated. This can take a few minutes.',
  /**
   * The detail of the open while it waits for the download of the VS Code server of the window into the shared store
   * (the very first open of a VS Code version on the engine, or a download that runs in another window).
   */
  downloadingVscodeServer: 'Downloading the VS Code server.',
  /**
   * The detail of an update while it waits for the prepare of its newer image that runs in the background; with the
   * whole minutes of the wait once there is one, "Preparing the newer image (3 min)…".
   */
  preparingNewerImage: (minutes: number) => (minutes < 1 ? 'Preparing the newer image.' : `Preparing the newer image (${minutes} min)…`),
  lifecycleCommandFailed: (command: string | undefined) =>
    `The ${command ?? 'lifecycle command'} of the devspace failed. The devspace is opened anyway.`,
  /** The lock of the devspace stayed held elsewhere for DEVSPACE_LOCK_WAIT_SECONDS. */
  devspaceLockBusy: (repository: string) =>
    `${repository} is busy with an operation from another window or computer; try again in a moment.`,
  /**
   * The worker that holds the lock of the devspace could not be made ready (the helper image could not be built, the
   * worker could not be opened or reaches another Docker engine, or the lock failed in it). Nothing was changed.
   */
  devspaceLockUnavailable: (repository: string, cause: string) =>
    `${repository} was not changed: the Devspaces worker on the Docker host could not be prepared (${cause}). Check that Docker runs and that the workspace helper image can be built (see the Devspaces output), then try again.`,
  /** The record of the devspace holds a name or user that Stop cannot use. */
  stopRefused: (repository: string) =>
    `${repository} cannot be stopped from here: its record holds a value (the container name, the remote user, or the repository folder) that Devspaces cannot pass on. Stop it with Docker.`,
} as const;

/** How long an operation waits for the lock of a devspace that is held elsewhere. */
export const DEVSPACE_LOCK_WAIT_SECONDS = 10;

/**
 * The longest Stop in the worker (the wait for the lock, the Git state, the stop of each container). A Stop with more
 * than about eight services that all hit their own time limit ends here.
 */
export const STOP_FLOW_TIMEOUT_MS = 10 * 60_000;

/** The longest read of an attached window in the worker (the branch read has 15 s of its own). */
export const WINDOW_STATE_FLOW_TIMEOUT_MS = 30_000;

/**
 * The longest listing of the configurations (`listConfigurations`) in the worker: the wait for the lock, the start of the batch helper, and
 * its step.
 */
export const LIST_CONFIGURATIONS_FLOW_TIMEOUT_MS = 5 * 60_000;

/**
 * The longest Delete in the worker: the wait for the operation of another window and for the lock, the stop and removal
 * of the containers, the images, the volumes with their retries. Delete is not cancellable.
 */
export const DELETE_FLOW_TIMEOUT_MS = 30 * 60_000;

/**
 * The longest check of Delete in the worker: the Git state (GIT_SUMMARY_TIMEOUT_MS) and the questions, which wait for
 * the user.
 */
export const DELETE_CHECK_FLOW_TIMEOUT_MS = 60 * 60_000;

/** The longest rebuild of the registry in the worker (it lists and inspects the volumes and containers). */
export const RECONCILE_FLOW_TIMEOUT_MS = 2 * 60_000;

/**
 * The longest open in the worker: the clone, the image check and pulls, the build of the image (a large one may take an
 * hour or more), `up` with the lifecycle commands, and the questions to the user, which wait for an answer.
 */
export const OPEN_FLOW_TIMEOUT_MS = 4 * 60 * 60_000;

/**
 * The whole token removal in the worker: the two tries of the flow (TOKEN_REMOVE_TIMEOUT_MS of
 * src/core/worker/tokenRemoveFlow.ts each; its test ties them to this limit) and the requests around them.
 */
export const TOKEN_REMOVE_FLOW_TIMEOUT_MS = 60_000;

/**
 * The longest ensure of the Monitor in the worker: its looks and waits (a name conflict, a container that
 * another window creates: 25.5 s at most), the create and the wait for its ready line (60 s), each call of the engine
 * bounded by 60 s.
 */
export const MONITOR_ENSURE_FLOW_TIMEOUT_MS = 5 * 60_000;

/**
 * The longest heartbeat or monitor command in the worker: its `docker exec` (20 s) and the way there.
 */
export const MONITOR_FLOW_TIMEOUT_MS = 30_000;

/**
 * The longest "Update All Images Now" in the worker: the ensure of the monitor (MONITOR_ENSURE_FLOW_TIMEOUT_MS), then
 * one command in it (MONITOR_FLOW_TIMEOUT_MS).
 */
export const MONITOR_RUN_NOW_FLOW_TIMEOUT_MS = MONITOR_ENSURE_FLOW_TIMEOUT_MS + MONITOR_FLOW_TIMEOUT_MS;

/**
 * The part of DevspaceRegistry that the service uses: no change of an entry by a function and no added entry: the
 * worker's pipeline sends each of its writes to the extension as a specific request (busy marks, open records, the Git
 * state).
 */
export type DevspaceStore = Pick<DevspaceRegistry, 'get' | 'list' | 'read' | 'forgetKeptVolumes' | 'findForAccount' | 'restore' | 'remove'>;

/**
 * The part of DevspaceRegistry that the window's operations use (DevspaceOperations): also the changes of an
 * entry, and the busy marks and the registry writes of the open over it (registryBusyMarks, registryOpenRecords).
 */
export type WindowDevspaceStore = DevspaceStore & Pick<DevspaceRegistry, 'add' | 'updateDevspace'>;

/** The part of SessionFiles that the service uses. */
export type DevspaceSessionFiles = Pick<
  SessionFiles,
  'writePending' | 'removePending' | 'removeOperation' | 'removeDisconnectRequest' | 'removeReopenOf' | 'readPendings'
>;

/** Starts Docker when it does not run and waits until it is ready. */
export type DockerStarter = (options: { onStarting: () => void; signal?: AbortSignal }) => Promise<void>;

export interface RepositoryTarget {
  /** `owner/name`. */
  repository: string;
  defaultBranch?: string | null;
  /** From the discovery, in the order of precedence. Empty for an unknown repository: the pipeline then uses the first configuration in the volume. */
  configPaths: string[];
  /** isTrustedOwner(). */
  trusted: boolean;
}

export interface OperationOptions {
  progress: ProgressReporter;
  signal?: AbortSignal;
}

export interface OpenOptions extends OperationOptions {
  /** Manual rebuild: build the devspace image also when no digest changed. */
  forceRebuild?: boolean;
  /**
   * Opens the devspace with another configuration path of its repository (a rebuild). No command sends it since
   * version 0.6.0 (each configuration is its own devspace, DevspaceSource): the tests of a changed configuration use
   * it, and the pipeline keeps the switch of the dev service of Docker Compose that a changed configuration brings
   * about.
   */
  configPath?: string;
  /**
   * The source of the open (DevspaceSource): the devspace of a repository that the open opens or creates (the first
   * configuration of the repository without it), and, for an existing default-image devspace, the image of the
   * setting now (without it, the devspace keeps the image of its last open). A devspace never changes its kind: a
   * source of the other kind is not followed.
   */
  source?: DevspaceSource;
}

export interface OpenResult {
  /** Registry entry after the pipeline. */
  devspace: Devspace;
  containerName: string;
  /** From `devcontainer up`, fallback `/workspaces/<name>`. */
  remoteWorkspaceFolder: string;
  /** What the link of the shared VS Code server did (an open with a server only; the worker's pipeline). */
  vscodeServer?: VscodeServerLink;
}

export const BUSY_POLL_MS = 500;
const DEFAULT_BUSY_WAIT_MS = 10_000;
/** The questions whether a process runs that the pipeline asks at the same time. */
const PROCESS_QUESTIONS_AT_ONCE = 4;

/** Reports each progress step once, and logs it. */
export class StepReporter {
  private current: ProgressStep | undefined;
  /** The detail shown with the current step (a new step removes it). */
  private shownDetail: string | undefined;

  constructor(
    private readonly progress: ProgressReporter,
    private readonly logger: Logger,
  ) {}

  step(step: ProgressStep): void {
    if (step === this.current) return;
    this.current = step;
    this.shownDetail = undefined;
    this.logger.info(`Step: ${Steps[step]}`);
    this.progress.step(step);
  }

  /** Shows `message` with the current step, once while it is shown. */
  detail(message: string): void {
    if (message === this.shownDetail) return;
    this.shownDetail = message;
    this.progress.detail(message);
  }

  /** Removes the detail of the current step (an empty detail is not shown). */
  clearDetail(): void {
    this.shownDetail = undefined;
    this.progress.detail('');
  }
}

export function cancelledError(): UserFacingError {
  return new UserFacingError('cancelled', PipelineTexts.cancelled);
}

export function devspaceMissing(repository?: string): UserFacingError {
  return new UserFacingError('startFailed', repository ? Messages.noDevspace(repository) : PipelineTexts.devspaceMissing);
}

export function devspaceBusy(repository: string, mark: BusyMark): UserFacingError {
  return new UserFacingError(
    'startFailed',
    PipelineTexts.devspaceBusy(repository),
    `Busy mark: ${mark.operation} since ${mark.since}, process ${mark.pid}, window ${mark.windowId}.`,
  );
}

export function otherAccount(repository: string): UserFacingError {
  return new UserFacingError('otherAccount', Messages.otherAccount(repository));
}

/** Waits for `promise`; rejects with an AbortError when `signal` aborts first. */
export function waitUnlessAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** The UserFacingError of a refusal that the worker's own pipeline answered (FlowRefusal). */
export function refusalError(refused: FlowRefusal): UserFacingError {
  return refused.batchHelperUnavailable === true ? new BatchHelperUnavailableError(refused.message, refused.detail) : new UserFacingError(refused.code, refused.message, refused.detail);
}

/** A token together with the account of its session. */
export interface GitHubSession {
  token: string;
  account: GitHubAccount;
}

/** The deps of an operation of a window, which DevspaceOperations and DevspaceService share. */
export interface OperationBaseDeps {
  registry: DevspaceStore;
  sessionFiles: DevspaceSessionFiles;
  auth: Pick<GitHubAuth, 'getToken' | 'getAccount'>;
  ui: Pick<PipelineUi, 'warn'>;
  logger: Logger;
  clock: Clock;
  /** For busy marks and pending connection files. */
  owner: { windowId: string; pid: number };
  settings: () => ExtensionSettings;
  /**
   * The Docker host of the operation ('' = the local Docker; DockerTargets.host). New devspaces record it; only
   * devspaces of this host are opened, restored, or changed. Default: the local Docker.
   */
  dockerHost?: () => Promise<string>;
  /**
   * The Docker target of the operation (DockerTargets.current), with its kind. When given, it decides instead of
   * `dockerHost`: an endpoint that is neither local nor SSH ('unsupported') is refused by every operation
   * (dockerEndpointUnsupported) and never read or recorded.
   */
  dockerTarget?: () => Promise<Pick<DockerTarget, 'kind' | 'host' | 'endpoint' | 'podman'>>;
  /** Default: `isProcessAlive` of sessionRules.ts (`process.kill(pid, 0)` does not fail with ESRCH). */
  isProcessAlive?: (pid: number) => boolean;
  /**
   * Whether the process `pid` of this computer runs, asked before a decision about the other windows (processesAlive).
   * Default: `isProcessAlive`; the worker's pipeline asks the extension (`local processAlive`).
   */
  processAlive?: (pid: number) => Promise<boolean>;
  /**
   * The containers that the window remembers because their lifecycle mark could not be recorded. Default: a memory of
   * its own; the worker's pipeline uses the window's through requests.
   */
  lifecycleMemory?: LifecycleMemory;
  /**
   * All window status files (SessionFiles.readWindowStatuses). When given, a busy mark of another window counts only
   * while that window also has a recent status file of the same process (see `isBusyMarkLive`), so a process ID that
   * was reused after a restart does not block the devspace.
   */
  windowStatuses?: () => Promise<readonly WindowStatus[]>;
  /** How long an operation waits for the busy mark of another live window. Default 10 s. */
  busyWaitMs?: number;
  /** For tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * The busy marks and the registry writes of the open of an operation. The window's operations write them to the
 * registry of this computer (registryBusyMarks, registryOpenRecords); the worker's pipeline sends them to the extension
 * (hostBusyMarks, hostOpenRecords).
 */
export interface OperationRecords {
  busyMarks: DevspaceBusyMarks;
  openRecords: OpenRecords;
}

/** The owner, clock, and view of the windows with which the window of `deps` decides busy marks. */
export function markViewOf(deps: Pick<OperationBaseDeps, 'owner' | 'clock' | 'isProcessAlive' | 'windowStatuses' | 'logger'>): BusyMarkView {
  return { owner: deps.owner, clock: deps.clock, isAlive: deps.isProcessAlive ?? isProcessAlive, windowStatuses: deps.windowStatuses, logger: deps.logger };
}

/** The rules of an operation of a window (see the module comment). */
export abstract class OperationBase {
  private readonly queues = new Map<string, Promise<void>>();
  /**
   * The window's memory of the containers that run without their lifecycle commands while the registry could not record
   * it (LifecycleMemory).
   */
  protected readonly lifecycleMemory: LifecycleMemory;
  /** Whether a process of this computer runs (OperationBaseDeps.processAlive). */
  protected readonly processAlive: (pid: number) => Promise<boolean>;
  /** The messages of refused targets (an endpoint that is neither local nor SSH, or Podman) that the reads showed: once each. */
  private readonly shownRefusals = new Set<string>();
  protected readonly isAlive: (pid: number) => boolean;
  protected readonly busyMarks: DevspaceBusyMarks;
  /** The owner, clock, and view of the windows with which this window decides busy marks. */
  protected readonly markView: BusyMarkView;
  protected readonly openRecords: OpenRecords;
  protected readonly busyWaitMs: number;
  protected readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(
    protected readonly deps: OperationBaseDeps,
    private readonly startDockerFn: DockerStarter,
    /** The busy marks and the registry writes of the open, over the view of the marks of this window. */
    records: (view: BusyMarkView) => OperationRecords,
  ) {
    this.isAlive = deps.isProcessAlive ?? isProcessAlive;
    this.processAlive = deps.processAlive ?? (async (pid) => this.isAlive(pid));
    this.lifecycleMemory = deps.lifecycleMemory ?? windowLifecycleMemory();
    this.markView = markViewOf(deps);
    const given = records(this.markView);
    this.busyMarks = given.busyMarks;
    this.openRecords = given.openRecords;
    this.busyWaitMs = Math.max(0, deps.busyWaitMs ?? DEFAULT_BUSY_WAIT_MS);
    this.sleepFn = deps.sleep ?? defaultSleep;
  }

  protected get logger(): Logger {
    return this.deps.logger;
  }

  /**
   * The signed-in account (`interactive`: a sign-in may be asked for); refuses a devspace of another account.
   */
  protected async requireOwnAccount(devspace: Devspace, interactive: boolean): Promise<void> {
    const account = await this.deps.auth.getAccount({ interactive });
    if (!account) throw new UserFacingError('signInRequired', Messages.signInRequired);
    this.availableEntry(devspace, account);
  }

  /** The registry entry, when it belongs to `account`. Throws otherAccount for an entry of another account. */
  protected availableEntry(devspace: Devspace, account: GitHubAccount): Devspace {
    if (isAvailableTo(devspace, account)) return devspace;
    this.logger.info(`The devspace ${devspace.id} does not belong to the signed-in account. It is not used.`);
    throw otherAccount(devspace.repository);
  }

  /**
   * The token and the account of the GitHub session; asks for a sign-in when needed. Both must come from one session: a
   * sign-in with another account between the two questions would give a devspace of this account the token of the
   * other one.
   */
  protected async requireSession(): Promise<GitHubSession> {
    const token = await this.deps.auth.getToken({ interactive: true });
    if (!token) throw new UserFacingError('signInRequired', Messages.signInRequired);
    const account = await this.deps.auth.getAccount({ interactive: false });
    if (!account || (await this.deps.auth.getToken({ interactive: false })) !== token) {
      throw new UserFacingError('signInRequired', Messages.signInRequired, 'The GitHub session changed during the open.');
    }
    return { token, account };
  }

  /**
   * The one check of the Docker target of the service. The target of the operation (dockerTarget), else the host of
   * `dockerHost` (local or SSH).
   */
  protected async dockerTarget(): Promise<Pick<DockerTarget, 'kind' | 'host' | 'endpoint' | 'podman'>> {
    if (this.deps.dockerTarget) return this.deps.dockerTarget();
    const host = (await this.deps.dockerHost?.()) ?? '';
    return { kind: host === '' ? 'local' : 'remote', host, endpoint: '' };
  }

  /**
   * The Docker host of the operation ('' = the local Docker). An endpoint that is neither local nor SSH is refused
   * (UserFacingError dockerEndpointUnsupported), so no operation reaches it or records it.
   */
  protected async currentDockerHost(): Promise<string> {
    const target = await this.dockerTarget();
    if (target.kind === 'unsupported') {
      this.logger.warn(`${unsupportedTargetReason(target)} Nothing is done.`);
      throw dockerEndpointUnsupported(target);
    }
    return target.host;
  }

  /**
   * The Docker host for the reads of the view and the restore (states, branch, volumes): undefined for a target that is
   * not supported, and the reads do nothing then. An endpoint that is neither local nor SSH, and Podman, do not change
   * by themselves: their message is shown once. A current context that could not be read may be so for a moment only
   * (for example a time-out of `docker context inspect` during a refresh in the background): the reads only log it.
   * The sidebar names it, and an operation of the user shows its message (currentDockerHost).
   */
  protected async readableDockerHost(): Promise<string | undefined> {
    const target = await this.dockerTarget();
    if (target.kind !== 'unsupported') return target.host;
    const reason = `${unsupportedTargetReason(target)} Its containers and volumes are not read.`;
    if (isUnreadableDockerTarget(target)) {
      this.logger.info(reason);
      return undefined;
    }
    const message = unsupportedTargetMessage(target);
    if (!this.shownRefusals.has(message)) {
      this.shownRefusals.add(message);
      this.logger.warn(reason);
      this.deps.ui.warn(message);
    }
    return undefined;
  }

  protected async isOnCurrentHost(devspace: Devspace): Promise<boolean> {
    const host = await this.readableDockerHost();
    return host !== undefined && isOnDockerHost(devspace, host);
  }

  /**
   * A devspace of another Docker host is never acted on (no clone, restore, recreation, deletion, stop, or token
   * write there): UserFacingError('otherDockerHost').
   */
  protected async requireCurrentHost(devspace: Devspace): Promise<void> {
    const host = await this.currentDockerHost();
    if (isOnDockerHost(devspace, host)) return;
    const devspaceHost = dockerHostOf(devspace);
    this.logger.warn(`${devspace.repository}: the devspace is on the Docker host ${devspaceHost || '(local)'}, and Docker is set to ${host || '(local)'}. Nothing is done.`);
    throw new UserFacingError('otherDockerHost', Messages.otherDockerHost(devspace.repository, devspaceHost, host));
  }

  protected async startDocker(steps: StepReporter, signal: AbortSignal | undefined): Promise<void> {
    this.throwIfCancelled(signal);
    await this.startDockerFn({ onStarting: () => steps.step('startingDocker'), signal });
  }

  /**
   * Whether the processes `pids` of this computer run, asked once each (DevspaceServiceDeps.processAlive; in the
   * worker, the extension answers). A process whose answer fails counts as running, and so does one not asked: when in
   * doubt, another window uses the devspace, and nothing is stopped or taken over.
   */
  protected async processesAlive(pids: Iterable<number>): Promise<(pid: number) => boolean> {
    const alive = new Map<number, boolean>();
    const unique = [...new Set(pids)];
    // A few at a time, far below the open requests that an operation may have (MAX_OPEN_ASKS), so that the other
    // requests of the open (its pending file, its questions) still get through.
    for (let start = 0; start < unique.length; start += PROCESS_QUESTIONS_AT_ONCE) {
      await Promise.all(
        unique.slice(start, start + PROCESS_QUESTIONS_AT_ONCE).map(async (pid) => {
          try {
            alive.set(pid, await this.processAlive(pid));
          } catch (error) {
            this.logger.warn(`Whether the process ${pid} runs could not be read: ${errorMessage(error)}`);
            alive.set(pid, true);
          }
        }),
      );
    }
    return (pid) => alive.get(pid) ?? true;
  }

  /** What markBlocks decides with (the window status files, read once, and the time), as plain data. */
  protected markLiveness(): Promise<MarkLiveness> {
    return readLiveness(this.markView);
  }

  /**
   * The test "a live mark of another window" (`isBusyMarkLive`) for `mark`: a mark of an ended process, a mark older
   * than 6 hours, and (with window status files) a mark whose window has no recent status file of that process are
   * ignored. Reads the window status files once per call.
   */
  protected async markBlocks(mark: BusyMark): Promise<boolean> {
    const liveness = await this.markLiveness();
    // Whether its process runs is asked first (in the worker, the extension answers); never for a mark of this window
    // or its process, which never counts.
    const isAlive = await this.processesAlive(mark.pid === this.markView.owner.pid ? [] : [mark.pid]);
    return otherWindowMarkIsLive(mark, { owner: this.markView.owner, isAlive }, liveness);
  }

  /**
   * Waits while another live window holds a busy mark (for example the window that asked for a rebuild and is closing
   * its remote connection), at most `busyWaitMs`. Returns the current registry entry.
   * Assumption: after "Close Remote Connection", the extension host of the old window ends within this time, so
   * the reloaded window can take over the operation that the old window marked.
   */
  protected async waitForOtherOperation(devspace: Devspace, signal: AbortSignal | undefined): Promise<Devspace> {
    const attempts = Math.ceil(this.busyWaitMs / BUSY_POLL_MS);
    let current = devspace;
    for (let attempt = 0; ; attempt++) {
      const mark = current.busy;
      if (!mark || !(await this.markBlocks(mark))) return current;
      if (attempt >= attempts) throw devspaceBusy(current.repository, mark);
      if (attempt === 0) {
        this.logger.info(`${current.repository} is busy (${mark.operation}) in another window (process ${mark.pid}). Waiting.`);
      }
      await this.sleepFn(BUSY_POLL_MS, signal);
      const next = await this.deps.registry.get(current.id);
      if (!next) throw devspaceMissing(current.repository);
      current = next;
    }
  }

  protected async clearOwnMark(devspaceId: string): Promise<void> {
    await this.quietly('clear the busy mark', () => this.busyMarks.clear(devspaceId));
  }

  /**
   * Removes the pending connection file, the pending operation, the disconnect request, and a reopen record of the
   * devspace.
   */
  protected async removeDevspaceFiles(devspaceId: string): Promise<void> {
    const files = this.deps.sessionFiles;
    await this.quietly('remove the pending connection file', () => files.removePending(devspaceId));
    await this.quietly('remove the pending operation', () => files.removeOperation(devspaceId));
    // A disconnect request of the deleted devspace.
    await this.quietly('remove the disconnect request', () => files.removeDisconnectRequest(devspaceId));
    // One request from the worker (the reopen record is read where it is).
    await this.quietly('remove the reopen record', () => files.removeReopenOf(devspaceId));
  }

  /** Runs operations on the same key one after the other. Waiting ends with `cancelled` when the signal aborts. */
  protected async exclusive<T>(key: string, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => done);
    this.queues.set(key, tail);
    try {
      try {
        await waitUnlessAborted(previous, signal);
      } catch {
        throw cancelledError();
      }
      return await fn();
    } finally {
      release();
      if (this.queues.get(key) === tail) this.queues.delete(key);
    }
  }

  protected throwIfCancelled(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw cancelledError();
  }

  protected isCancellation(error: unknown, signal: AbortSignal | undefined): boolean {
    return signal?.aborted === true || isAbortError(error) || (isUserFacingError(error) && error.code === 'cancelled');
  }

  /** A cancelled operation ends with UserFacingError('cancelled'); other errors pass unchanged. */
  protected toUserError(error: unknown, signal: AbortSignal | undefined): unknown {
    if (this.isCancellation(error, signal)) {
      return isUserFacingError(error) && error.code === 'cancelled' ? error : cancelledError();
    }
    return error;
  }

  /** Runs a cleanup step; a failure is logged and ignored. */
  protected async quietly(what: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.logger.warn(`Could not ${what}: ${errorMessage(error)}`);
    }
  }

  protected busyMark(operation: BusyOperation): BusyMark {
    return { operation, since: isoTime(this.deps.clock), pid: this.deps.owner.pid, windowId: this.deps.owner.windowId };
  }
}
