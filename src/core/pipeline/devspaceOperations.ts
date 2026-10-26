// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The operations of a window (no bypass of the worker, by construction). Each sends its flow to the worker of the
// Docker target: the open, Stop, Delete and its check, the listing of the configurations, the reads of an attached
// window, the refresh and the rebuild of the registry; the worker runs the pipeline (DevspaceService). Nothing of
// the pipeline is imported here, so the extension's bundle holds none of it. No `vscode`.
import { registryBusyMarks, type DevspaceBusyMarks } from './busyMarks';
import { type DeleteDecision } from './deleteCheck';
import { devspacesOfHost } from '../docker/dockerHost';
import { RemovedEngineError } from '../docker/engineRemoval';
import { UserFacingError, errorMessage } from '../errors';
import {
  LOCK_BUSY_CODE,
  LOCK_UNAVAILABLE_CODE,
  OP_DELETE,
  OP_DELETE_CHECK,
  OP_OPEN,
  OPEN_PROGRESS_DETAIL,
  OP_RECONCILE,
  OP_STOP,
  OP_TOKEN_REMOVE,
  OP_WINDOW_STATE,
  parseDeleteCheckParams,
  parseDeleteCheckValue,
  parseDeleteParams,
  parseDeleteValue,
  parseReconcileParams,
  parseReconcileValue,
  parseOpenParams,
  parseOpenValue,
  parseStopParams,
  parseStopValue,
  parseTokenRemoveValue,
  parseWindowStateParams,
  parseWindowStateValue,
  type OpenParams,
  type TokenRemoveValue,
  type VscodeServerRef,
  type WindowStateValue,
} from '../helperChannel/protocol';
import type { HelperMaintenance } from '../helper/helperImages';
import { MAX_IMAGE_REFERENCES, imageReferencesInUse, type ImageReferencesInUse, type MonitorSettings } from '../remoteMonitor/protocol';
import { HelperChannelError, HelperOperationError } from '../helperChannel/helperChannel';
import { Steps, type ProgressStep } from '../messages';
import { repositoryFolder, splitRepository } from '../names';
import { isAvailableTo } from '../ownership';
import { type DevspaceRuntimeState, type DevspaceStates, type StateDevspace } from './refreshStates';
import { hostAccessChecks } from '../policy/hostAccessChecks';
import { isoTime } from '../ports';
import type { Devspace, DevspaceSource, GitHubAccount } from '../types';
import { sourceOf, sourceOperationKey } from '../devspaceSource';
import { DEFAULT_CONFIG_PATH } from './recordRules';
import { LIFECYCLE_UNKNOWN } from './lifecycleMemory';
import { registryOpenRecords, type OpenRecords } from './openRecords';

import {
  OperationBase,
  StepReporter,
  cancelledError,
  devspaceMissing,
  refusalError,
  PipelineTexts,
  DEVSPACE_LOCK_WAIT_SECONDS,
  STOP_FLOW_TIMEOUT_MS,
  WINDOW_STATE_FLOW_TIMEOUT_MS,
  DELETE_FLOW_TIMEOUT_MS,
  DELETE_CHECK_FLOW_TIMEOUT_MS,
  RECONCILE_FLOW_TIMEOUT_MS,
  OPEN_FLOW_TIMEOUT_MS,
  TOKEN_REMOVE_FLOW_TIMEOUT_MS,
  type DockerStarter,
  type OpenOptions,
  type OpenResult,
  type OperationBaseDeps,
  type OperationOptions,
  type RepositoryTarget,
  type WindowDevspaceStore,
} from './operationBase';

/** The longest detail of a step of the open that the worker reports (the progress notification). */
const MAX_OPEN_DETAIL_LENGTH = 1000;

/**
 * Runs a flow in the worker of the Docker target of the operation (the worker is the deputy of the window); the worker
 * takes the lock of the devspace itself. Rejects with a HelperChannelError when there is no worker, and with a
 * HelperOperationError (`busy` for a lock held elsewhere) when the flow fails. `passive`: a read in the background.
 */
export type OperationFlow = (
  op: string,
  params: unknown,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    passive?: boolean;
    // Each answer of the user to a question of the flow.
    onAnswer?: (call: string, args: unknown[], value: unknown) => void;
    // A question of the flow is asked, and has its answer (or failed).
    onQuestion?: (state: 'asked' | 'settled') => void;
    // A step of the flow began (the progress of the open).
    onProgress?: (step: string, detail?: string) => void;
    // Only the operation `open`: the helper image maintenance of the preparation of its worker
    // (HelperChannelsOptions.prepare), when no worker of the engine is open yet.
    helperMaintenance?: HelperMaintenance;
  },
) => Promise<unknown>;

/**
 * The token removal (`tokenRemove`) by the worker of the current engine (`flow`), within TOKEN_REMOVE_FLOW_TIMEOUT_MS.
 * Rejects when the flow fails or answers with an invalid value; its caller logs that (best effort). Used by
 * DevspaceOperations.removeTokenInWorker; apart from the class for the tests of the controller, which give it their
 * fake flow.
 */
export async function removeTokenThroughWorker(flow: OperationFlow, devspaceId: string, containerName: string): Promise<TokenRemoveValue> {
  const value = parseTokenRemoveValue(await flow(OP_TOKEN_REMOVE, { devspaceId, containerName }, { timeoutMs: TOKEN_REMOVE_FLOW_TIMEOUT_MS }));
  if (value === undefined) throw new Error('The worker answered the token removal with an invalid value.');
  return value;
}

/** The deps of the operations of a window. */
export interface DevspaceOperationsDeps extends OperationBaseDeps {
  /** The registry of this computer (the window's operations also change its entries). */
  registry: WindowDevspaceStore;
  /** The busy marks of the window. Default: over `registry` (registryBusyMarks). */
  busyMarks?: DevspaceBusyMarks;
  /** The registry writes of the open. Default: over `registry` (registryOpenRecords). */
  openRecords?: OpenRecords;
  /** Starts Docker when it does not run (for a remote host only a check). */
  startDocker: DockerStarter;
  /** Whether the Docker engine of the operation answers (Stop does nothing without it). */
  dockerRunning: () => Promise<boolean>;
  /**
   * Whether the engine of the Docker host `host` has the removal mark of "Remove Devspaces from This Docker Engine…"
   * (docker-engines.json): the refresh of the states asks Docker nothing there (refreshStates). False when not given.
   */
  engineRemoved?: (host: string) => Promise<boolean>;
  /**
   * readDevspaceStates in the worker of the Docker target (HelperChannels.refresh); it makes the worker ready first,
   * and rejects when it cannot.
   */
  workerRefresh: (devspaces: readonly StateDevspace[]) => Promise<DevspaceStates>;
  /** Runs a flow in the worker of the Docker target of the operation. */
  flow: OperationFlow;
  /** The id of this computer in the Monitor (Delete's `forget`, the open's first heartbeat). */
  monitorSource?: () => string;
  /**
   * The image maintenance of an open: the schedule of the monitor's background run and its mode for the engine
   * `dockerHost` (its mode after a read of the answer of that engine; never rejects).
   */
  openMonitor?: (dockerHost: string) => { images: MonitorSettings } | Promise<{ images: MonitorSettings }>;
  /**
   * The image references in use on the engine `dockerHost` that an open carries for its Monitor; undefined:
   * none. Default: those of the build records of this computer's devspaces there
   * (DevspaceOperations.referencesInUse). The Docker tests give none, so the Monitor of their engine manages
   * no image of it.
   */
  imageReferencesInUse?: (dockerHost: string) => Promise<ImageReferencesInUse | undefined>;
  /**
   * The VS Code server of this window (the commit and quality of its product.json, only for a build of the Microsoft
   * update service), which the open carries; none: the open runs without the shared server.
   */
  vscodeServerOfWindow?: () => Promise<VscodeServerRef | undefined>;
  /**
   * The user's `dev.containers.defaultExtensions`, as the entries that the protocol takes (defaultExtensionsOf); the
   * open carries them only with a VS Code server of the window.
   */
  defaultExtensionsOfWindow?: () => string[];
}

/**
 * The source of the devspace of an open that the worker runs (OpenParams.source; without one, the first configuration
 * of the repository, as the worker's `open` takes it): the gate of the open and the lookup of its devspace on this
 * side (findForAccount).
 */
function openedSource(params: Pick<OpenParams, 'source' | 'target'>): DevspaceSource {
  return params.source ?? { kind: 'configuration', configPath: params.target?.configPaths[0] ?? DEFAULT_CONFIG_PATH };
}

/** The operations of a window, sent to the worker (see the module comment). */
export class DevspaceOperations extends OperationBase {
  /** The engines with the removal mark whose unread states the log named already (refreshStates). */
  private readonly removedEnginesSaid = new Set<string>();

  constructor(protected override readonly deps: DevspaceOperationsDeps) {
    super(deps, deps.startDocker, (view) => ({
      busyMarks: deps.busyMarks ?? registryBusyMarks(deps.registry, view),
      openRecords: deps.openRecords ?? registryOpenRecords(deps.registry, view),
    }));
  }

  /**
   * The open of a repository (`open`) by the worker of the Docker target, as the operation `open` (openThroughWorker).
   * The worker's pipeline finds the devspace of the source of the repository (`options.source`, else the first
   * configuration of the target) of the signed-in account, or creates it.
   */
  async openInWorker(target: RepositoryTarget, options: OpenOptions): Promise<OpenResult> {
    splitRepository(target.repository);
    // The gate of the devspace of the source of the open (as the worker's `open` keys it): two devspaces of one
    // repository open next to each other.
    const source = openedSource({ ...(options.source !== undefined ? { source: options.source } : {}), target: { configPaths: target.configPaths, trusted: target.trusted } });
    return this.exclusive(sourceOperationKey(target.repository, source), options.signal, async () => {
      try {
        return await this.openThroughWorker(
          target.repository,
          { target: { ...(target.defaultBranch !== undefined ? { defaultBranch: target.defaultBranch } : {}), configPaths: [...target.configPaths], trusted: target.trusted } },
          options,
        );
      } catch (error) {
        throw this.toUserError(error, options.signal);
      }
    });
  }

  /** The open of an existing devspace (`openDevspace`) by the worker of the Docker target (openThroughWorker). */
  async openDevspaceInWorker(devspaceId: string, options: OpenOptions): Promise<OpenResult> {
    const devspace = await this.deps.registry.get(devspaceId);
    if (!devspace) throw devspaceMissing();
    await this.requireCurrentHost(devspace);
    return this.exclusive(sourceOperationKey(devspace.repository, sourceOf(devspace)), options.signal, async () => {
      try {
        const current = await this.deps.registry.get(devspaceId);
        if (!current) throw devspaceMissing(devspace.repository);
        return await this.openThroughWorker(current.repository, { devspaceId: current.id }, options);
      } catch (error) {
        throw this.toUserError(error, options.signal);
      }
    });
  }

  /**
   * Sends the open to the worker and answers with what the window needs to connect, after the worker released the lock
   * of the devspace. Before it is sent: the sign-in of this window (with a dialog when needed: the worker asks for
   * the token without one) and the start of the local Docker. The steps of the worker are the progress of the open. The
   * open carries the image maintenance of this computer and the image references in use. The answer names a
   * devspace of the signed-in account on the Docker host of the operation (and of the repository of the open), which
   * the window takes from its own registry. The flow carries the helper image maintenance (HelperMaintenance, with the
   * setting updateImagesOnConnect) for the preparation of its worker, and a build of the helper image there is a detail
   * of the progress until that preparation ended.
   */
  private async openThroughWorker(
    repository: string,
    what: Pick<OpenParams, 'devspaceId'> | Pick<OpenParams, 'target'>,
    options: OpenOptions,
  ): Promise<OpenResult> {
    const { signal } = options;
    const session = await this.requireSession();
    // A devspace of another account is never sent.
    if ('devspaceId' in what && what.devspaceId !== undefined) {
      const entry = await this.deps.registry.get(what.devspaceId);
      if (!entry) throw devspaceMissing(repository);
      this.availableEntry(entry, session.account);
    }
    const steps = new StepReporter(options.progress, this.logger);
    await this.startDocker(steps, signal);
    this.throwIfCancelled(signal);
    const dockerHost = await this.currentDockerHost();
    const monitor = await this.deps.openMonitor?.(dockerHost);
    // The image references in use on this engine, for its Monitor.
    const references = monitor === undefined ? undefined : this.deps.imageReferencesInUse !== undefined ? await this.deps.imageReferencesInUse(dockerHost) : await this.referencesInUse(dockerHost);
    const settings = this.deps.settings();
    // The server of this window's VS Code, when its build qualifies (never rejects).
    const vscodeServer = await this.deps.vscodeServerOfWindow?.();
    // The user's default extensions, only with the server of the official VS Code.
    const defaultExtensions = vscodeServer !== undefined ? this.deps.defaultExtensionsOfWindow?.() : undefined;
    const params = parseOpenParams({
      dockerHost,
      owner: this.deps.owner,
      monitorSource: this.deps.monitorSource?.(),
      settings: {
        updateImagesOnConnect: settings.updateImagesOnConnect,
        hostAccessChecks: hostAccessChecks(repository, settings),
        stopOnClose: settings.stopOnClose !== false,
        respectShutdownActionNone: settings.respectShutdownActionNone === true,
        ...(settings.stopAfterMinutes !== undefined ? { stopAfterMinutes: settings.stopAfterMinutes } : {}),
      },
      images: monitor?.images,
      ...(references !== undefined ? { references: references.references } : {}),
      // The digests that the opens recorded for them (the evidence of their registry).
      ...(references !== undefined && Object.keys(references.digests).length > 0 ? { referenceDigests: references.digests } : {}),
      repository,
      ...what,
      ...(options.forceRebuild === true ? { forceRebuild: true } : {}),
      ...(options.source !== undefined ? { source: options.source } : {}),
      ...(vscodeServer !== undefined ? { vscodeServer } : {}),
      ...(defaultExtensions !== undefined && defaultExtensions.length > 0 ? { defaultExtensions } : {}),
    });
    if (params === undefined) throw new Error(`The open of ${repository} cannot be sent to the worker.`);
    // The preparation of the worker of this open (when no worker of the engine is open) runs the helper image
    // maintenance with the setting updateImagesOnConnect; its build (a missing tag, or the rebuild that a check asked
    // for) is shown as the detail of the progress until the preparation ended.
    const helperMaintenance: HelperMaintenance = {
      checkBaseImage: settings.updateImagesOnConnect,
      onBuild: (kind) => steps.detail(kind === 'refresh' ? PipelineTexts.updatingHelper : PipelineTexts.preparingHelper),
      onBuildEnd: () => steps.clearDetail(),
    };
    // The steps of the worker's pipeline (it logs them itself); `starting`: its `up` may run from here on.
    let started = false;
    const onProgress = (step: string, detail?: string) => {
      if (step === OPEN_PROGRESS_DETAIL) {
        const text = detail ?? '';
        options.progress.detail(text.length > MAX_OPEN_DETAIL_LENGTH ? `${text.slice(0, MAX_OPEN_DETAIL_LENGTH - 1)}…` : text);
      } else if (Object.hasOwn(Steps, step)) {
        if (step === 'starting') started = true;
        options.progress.step(step as ProgressStep);
      }
    };
    let answer: unknown;
    try {
      answer = await this.workerFlow({ repository }, OP_OPEN, params, OPEN_FLOW_TIMEOUT_MS, signal, undefined, undefined, onProgress, helperMaintenance);
    } catch (error) {
      // The user cancelled a question of the open in the worker (the worker cleaned up through its requests, which were
      // answered): a cancel. Never a worker that ended the operation itself (its shutdown, a defect): its requests
      // ended with it, so this window cleans up.
      if (error instanceof HelperOperationError && error.code === 'cancelled' && !error.timedOut && !error.aborted && signal?.aborted !== true) throw cancelledError();
      await this.afterLostWorkerOpen(repository, params, session.account, started);
      throw error;
    }
    const value = parseOpenValue(answer);
    if (value === undefined) {
      await this.afterLostWorkerOpen(repository, params, session.account, started);
      throw new Error(`The worker answered the open of ${repository} with an invalid value.`);
    }
    if ('refused' in value) throw refusalError(value.refused);
    const { opened } = value;
    const devspace = await this.deps.registry.get(opened.devspaceId);
    const expected = params.devspaceId ?? (await this.deps.registry.findForAccount(repository, session.account.id, dockerHost, openedSource(params)))?.id;
    // And its folder is the one that the open recorded (`record openFinished`).
    if (
      !devspace ||
      devspace.id !== expected ||
      !isAvailableTo(devspace, session.account) ||
      (devspace.dockerHost ?? '') !== dockerHost ||
      devspace.remoteWorkspaceFolder !== opened.remoteWorkspaceFolder
    ) {
      throw new Error(`The worker answered the open of ${repository} with a devspace that is not the one of the open.`);
    }
    return { devspace, containerName: opened.containerName, remoteWorkspaceFolder: opened.remoteWorkspaceFolder };
  }

  /**
   * The image references in use on the engine `dockerHost`: of the build records of all devspaces of this computer
   * there (any account: when in doubt, an image stays), for the Monitor, which keeps them up to date. Undefined
   * when the registry cannot be read (logged): then none are sent, and the monitor keeps what this computer sent
   * before.
   */
  private async referencesInUse(dockerHost: string): Promise<ImageReferencesInUse | undefined> {
    try {
      const { references, digests } = imageReferencesInUse(devspacesOfHost(await this.deps.registry.list(), dockerHost));
      if (references.length > MAX_IMAGE_REFERENCES) {
        this.logger.warn(`The devspaces on ${dockerHost === '' ? 'the local Docker' : dockerHost} use ${references.length} images; the Monitor keeps the first ${MAX_IMAGE_REFERENCES} up to date.`);
      }
      const sent = references.slice(0, MAX_IMAGE_REFERENCES);
      // With the recorded digests of the references that it sends.
      return { references: sent, digests: Object.fromEntries(Object.entries(digests).filter(([reference]) => sent.includes(reference))) };
    } catch (error) {
      this.logger.warn(`The images in use could not be read for the Monitor: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /**
   * A worker open that ended without its answer (a lost channel, its time limit, a cancel) could not clean up on this
   * computer: its requests end with it. This window does it for the devspace of the open: the pending connection
   * file goes; the busy mark of this window goes, and a create mark stays as ended (so the next open completes the
   * clone, or Delete removes the devspace); and when the worker had begun `up` (its step `starting`), this window
   * remembers the lifecycle of the devspace as unknown (the worker could record neither the lifecycle mark nor this
   * window's memory), so its next open of the devspace does not open a running container as it is
   * (LIFECYCLE_UNKNOWN).
   */
  private async afterLostWorkerOpen(repository: string, params: OpenParams, account: GitHubAccount, started: boolean): Promise<void> {
    const id =
      params.devspaceId ??
      (await this.deps.registry.findForAccount(repository, account.id, params.dockerHost, openedSource(params)).catch((error: unknown) => {
        this.logger.warn(`The devspace of ${repository} could not be read after the open in the worker ended: ${errorMessage(error)}`);
        return undefined;
      }))?.id;
    if (id === undefined) return;
    await this.quietly('remove the pending connection file', () => this.deps.sessionFiles.removePending(id));
    await this.quietly('end the busy mark of this window', async () => {
      const busy = (await this.deps.registry.get(id))?.busy;
      if (busy === undefined || busy.windowId !== this.deps.owner.windowId || busy.pid !== this.deps.owner.pid) return;
      if (busy.operation === 'create') await this.openRecords.createMark(id, 'ended');
      else await this.busyMarks.clear(id);
    });
    if (started) {
      await this.lifecycleMemory.remember(id, LIFECYCLE_UNKNOWN).catch((error: unknown) => this.logger.warn(`The window could not remember ${repository}: ${errorMessage(error)}`));
      this.logger.warn(`The open of ${repository} in the worker ended while it started the container: the next open of this window runs its lifecycle commands again.`);
    }
  }

  /**
   * Stop: records the Git summary from the running container, then `docker stop`. Does not start Docker. The other
   * services of a Docker Compose devspace are stopped after the dev container.
   */
  async stop(devspaceId: string): Promise<void> {
    const devspace = await this.deps.registry.get(devspaceId);
    if (!devspace) {
      this.logger.info(`Stop: the devspace ${devspaceId} does not exist.`);
      return;
    }
    await this.requireCurrentHost(devspace);
    await this.requireOwnAccount(devspace, false);
    await this.exclusive(sourceOperationKey(devspace.repository, sourceOf(devspace)), undefined, async () => {
      // Stop ends Close and Keep Running (Keep Running When Closed stays).
      if ((await this.deps.registry.get(devspaceId))?.keepRunningOnce !== undefined) {
        await this.quietly('clear Close and Keep Running', () =>
          this.deps.registry.updateDevspace(devspaceId, (entry) => {
            delete entry.keepRunningOnce;
          }),
        );
      }
      if (!(await this.deps.dockerRunning())) {
        this.logger.info('Docker is not running, so no container runs.');
        return;
      }
      // An update, rebuild, or delete in another window replaces or removes the container: no stop in between (the busy
      // mark applies to the Monitor; a Stop from a sidebar that is not up to date must respect it too).
      const env = await this.waitForOtherOperation((await this.deps.registry.get(devspaceId)) ?? devspace, undefined);
      // The Stop runs in the worker, under the lock of the devspace that the worker takes itself; this window
      // records the Git state that it answers. The parameters are checked here, so that one the worker would refuse is
      // named.
      const params = parseStopParams({
        devspaceId: env.id,
        containerName: env.containerName,
        folder: repositoryFolder(env.repository),
        ...(env.remoteUser !== undefined && env.remoteUser !== '' ? { user: env.remoteUser } : {}),
        waitSeconds: DEVSPACE_LOCK_WAIT_SECONDS,
      });
      if (params === undefined) {
        throw new UserFacingError('recordInvalid', PipelineTexts.stopRefused(env.repository), `container ${env.containerName}, remote user ${JSON.stringify(env.remoteUser ?? '')}, repository ${env.repository}`);
      }
      const value = parseStopValue(await this.workerFlow(env, OP_STOP, params, STOP_FLOW_TIMEOUT_MS));
      if (value === undefined) throw new Error(`The worker answered the Stop of ${env.repository} with an invalid value.`);
      const summary = value.gitSummary;
      if (summary !== undefined) {
        // The time of this computer, as the other times of the entry (lastUsedAt), never the clock of the Docker host;
        // recordedStateNote compares them.
        const recorded = { ...summary, recordedAt: isoTime(this.deps.clock) };
        await this.quietly('record the Git state', () =>
          this.deps.registry.updateDevspace(env.id, (entry) => {
            entry.gitSummary = recorded;
          }),
        );
      }
      // The containers that could not be stopped, after the Git state is recorded.
      if (value.failures.length > 0) throw new Error(value.failures.join(' '));
    });
  }

  /**
   * A flow in the worker, with the refusals of the lock: a lock held elsewhere is devspaceLockBusy, no worker (or no
   * helper image for it) is devspaceLockUnavailable, and nothing runs another way. Any other failure of the flow is
   * thrown as it is.
   */
  private async workerFlow(
    env: Pick<Devspace, 'repository'>,
    op: string,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
    onAnswer?: (call: string, args: unknown[], value: unknown) => void,
    onQuestion?: (state: 'asked' | 'settled') => void,
    // The progress of the flow (the open).
    onProgress?: (step: string, detail?: string) => void,
    // The helper image maintenance of the preparation of the worker (the open).
    helperMaintenance?: HelperMaintenance,
  ): Promise<unknown> {
    try {
      return await this.deps.flow(op, params, {
        signal,
        timeoutMs,
        ...(onAnswer ? { onAnswer } : {}),
        ...(onQuestion ? { onQuestion } : {}),
        ...(onProgress ? { onProgress } : {}),
        ...(helperMaintenance ? { helperMaintenance } : {}),
      });
    } catch (error) {
      if (this.isCancellation(error, signal)) throw error;
      if (error instanceof HelperOperationError && error.code === LOCK_BUSY_CODE) {
        this.logger.info(`${env.repository} is locked on the Docker host by another window or computer: ${error.message}`);
        throw new UserFacingError('startFailed', PipelineTexts.devspaceLockBusy(env.repository), error.message);
      }
      // Only a refusal before anything ran is "nothing is changed": the lock that could not be taken, or a worker that
      // could not be reached or knows no such flow (`closed`: the flow was not sent). A channel lost while the flow ran
      // is thrown as it is (the flow may have changed something).
      if ((error instanceof HelperOperationError && error.code === LOCK_UNAVAILABLE_CODE) || (error instanceof HelperChannelError && (error.code === 'unavailable' || error.code === 'unsendable' || error.code === 'open' || error.code === 'closed'))) {
        this.logger.warn(`${env.repository}: the worker on the Docker host could not be reached, so nothing is changed: ${errorMessage(error)}`);
        throw new UserFacingError('helperFailed', PipelineTexts.devspaceLockUnavailable(env.repository, errorMessage(error)), errorMessage(error));
      }
      throw error;
    }
  }

  /**
   * The check of Delete and its questions in the worker of the Docker host of the operation (`deleteCheck`), which asks
   * them through its requests. A refusal of its pipeline is thrown as a user error (refusalError); a worker that cannot
   * be reached is refused as for Stop (workerFlow). A devspace that is not in the registry is not deleted (cancel);
   * nothing is sent then.
   */
  async deleteCheckInWorker(devspaceId: string, options: OperationOptions & { repository: string; otherWindow: boolean }): Promise<DeleteDecision> {
    const devspace = await this.deps.registry.get(devspaceId);
    if (!devspace) {
      this.logger.info(`The devspace ${devspaceId} does not exist anymore. Nothing is deleted.`);
      return { decision: 'cancel' };
    }
    await this.requireCurrentHost(devspace);
    try {
      const params = parseDeleteCheckParams({
        devspaceId: devspace.id,
        dockerHost: await this.currentDockerHost(),
        owner: this.deps.owner,
        repository: options.repository,
        otherWindow: options.otherWindow,
      });
      if (params === undefined) throw new Error(`The check of the Delete of ${devspace.repository} cannot be sent to the worker.`);
      // The decision of the worker counts only as far as the user gave it here.
      const given = { confirm: undefined as unknown, volumes: [] as string[], volumesAnswer: undefined as unknown, serviceData: [] as string[], picked: [] as string[], cancelled: false };
      const onAnswer = (call: string, args: unknown[], value: unknown) => {
        if (call === 'confirmDelete') given.confirm = value;
        if (call === 'deleteAdditionalVolumes') {
          given.volumes = Array.isArray(args[0]) ? (args[0] as string[]) : [];
          given.volumesAnswer = value;
          // Escape at a later question cancels the Delete.
          if (value !== 'remove' && value !== 'keep') given.cancelled = true;
        }
        if (call === 'deleteServiceData') {
          given.serviceData = Array.isArray(args[0]) ? (args[0] as string[]) : [];
          given.picked = Array.isArray(value) ? (value as string[]) : [];
          if (!Array.isArray(value)) given.cancelled = true;
        }
      };
      // A decision while a question is still open is not the user's.
      let open = 0;
      const onQuestion = (state: 'asked' | 'settled') => {
        open += state === 'asked' ? 1 : -1;
      };
      const value = parseDeleteCheckValue(await this.workerFlow(devspace, OP_DELETE_CHECK, params, DELETE_CHECK_FLOW_TIMEOUT_MS, options.signal, onAnswer, onQuestion));
      if (value === undefined) throw new Error(`The worker answered the check of the Delete of ${devspace.repository} with an invalid value.`);
      if ('refused' in value) throw refusalError(value.refused);
      if (value.decision === 'cancel') return value;
      if (value.decision !== given.confirm || (value.decision === 'delete' && given.cancelled) || open > 0) {
        throw new Error(`The worker answered the check of the Delete of ${devspace.repository} with a decision that the user did not give.`);
      }
      if (value.decision === 'delete') {
        const allowed = new Set([...(given.volumesAnswer === 'remove' ? given.volumes : []), ...given.picked.filter((name) => given.serviceData.includes(name))]);
        const odd = value.additionalVolumesToRemove.filter((name) => !allowed.has(name));
        if (odd.length > 0) throw new Error(`The worker answered the check of the Delete of ${devspace.repository} with volumes that the user did not choose: ${odd.join(', ')}.`);
      }
      return value;
    } catch (error) {
      throw this.toUserError(error, options.signal);
    }
  }

  /**
   * Delete in the worker of the Docker host of the operation, where its own pipeline runs `delete` (the busy mark, the
   * entry and the session files of the devspace through its requests, the lock there, `forget` in the Session
   * Monitor). The caller made the safety check and closed a connected window. A devspace that is not in the
   * registry has nothing on Docker: only its session files are removed here. A refusal of that pipeline is thrown as a
   * user error (refusalError); a worker that cannot be reached or take the lock is refused as for Stop (workerFlow).
   */
  async deleteInWorker(devspaceId: string, options: OperationOptions & { additionalVolumesToRemove: readonly string[] }): Promise<void> {
    const devspace = await this.deps.registry.get(devspaceId);
    if (!devspace) {
      await this.removeDevspaceFiles(devspaceId);
      return;
    }
    await this.requireCurrentHost(devspace);
    await this.exclusive(sourceOperationKey(devspace.repository, sourceOf(devspace)), options.signal, async () => {
      try {
        const monitorSource = this.deps.monitorSource?.();
        const params = parseDeleteParams({
          devspaceId: devspace.id,
          dockerHost: await this.currentDockerHost(),
          owner: this.deps.owner,
          additionalVolumesToRemove: [...options.additionalVolumesToRemove],
          monitorSource,
        });
        if (params === undefined) throw new Error(`The Delete of ${devspace.repository} cannot be sent to the worker.`);
        let answer: unknown;
        try {
          answer = await this.workerFlow(devspace, OP_DELETE, params, DELETE_FLOW_TIMEOUT_MS, options.signal);
        } catch (error) {
          // A worker that ended without an answer (its channel lost, its time limit, a cancel) may have marked the
          // devspace busy for this window and could not clear it; this window clears its own mark (never the mark of
          // another window). A refusal (the value) was cleared by the worker.
          await this.clearOwnMark(devspace.id);
          throw error;
        }
        const value = parseDeleteValue(answer);
        if (value === undefined) throw new Error(`The worker answered the Delete of ${devspace.repository} with an invalid value.`);
        if ('refused' in value) throw refusalError(value.refused);
      } catch (error) {
        throw this.toUserError(error, options.signal);
      }
    });
  }

  /**
   * Container and volume state of each devspace. Does not start Docker: `undefined` when Docker does not run. No
   * Docker call at all on an endpoint that is neither local nor SSH; its (empty) map of states. refreshStates without
   * branches.
   */
  async inspectStates(): Promise<Map<string, DevspaceRuntimeState> | undefined> {
    return (await this.refreshStates(new Set())).runtime;
  }

  /**
   * The states of inspectStates and the branches of the running dev containers of `branchIds` (the sidebar: the
   * devspaces of the account), in one worker operation (`refresh`; also outside of an operation, never directly). A
   * worker refresh that cannot be made or fails is never read directly: the refresh fails (logged, with the cause).
   * `runtime` is `undefined` when Docker does not run or the states could not be read; then there are no branches.
   * Without a devspace on the current Docker host there is nothing to read: empty maps, without `docker info` and
   * without a worker. On an engine with the removal mark (`engineRemoved`), Docker is not asked either (no `docker
   * info`, no worker): `runtime` is `undefined`, with `engineRemoved`, so that the caller asks Docker nothing too.
   */
  async refreshStates(
    branchIds: ReadonlySet<string>,
  ): Promise<{ runtime: Map<string, DevspaceRuntimeState> | undefined; branches: Map<string, string>; engineRemoved?: true }> {
    try {
      const readable = await this.readableDockerHost();
      if (readable === undefined) return { runtime: new Map(), branches: new Map() };
      // Only the devspaces of the current Docker host; the others are hidden.
      const devspaces: StateDevspace[] = devspacesOfHost(await this.deps.registry.list(), readable).map((env) => ({
        id: env.id,
        containerName: env.containerName,
        volumeName: env.volumeName,
        ...(env.remoteUser ? { user: env.remoteUser } : {}),
        folder: repositoryFolder(env.repository),
        branch: branchIds.has(env.id),
      }));
      // No devspace here (for example before the first Start): Docker is not asked, and no worker is started for it.
      if (devspaces.length === 0) return { runtime: new Map(), branches: new Map() };
      // Nor on an engine with the removal mark, until a flow of the user there clears it (below: said once).
      if (await this.deps.engineRemoved?.(readable)) throw new RemovedEngineError(readable);
      if (!(await this.deps.dockerRunning())) return { runtime: undefined, branches: new Map() };
      // A failure of the worker refresh fails the refresh (below); only through the worker.
      const states = await this.deps.workerRefresh(devspaces);
      this.removedEnginesSaid.delete(readable);
      return states;
    } catch (error) {
      // An engine with the removal mark: the states stay unknown there until a Start of the user; said once per engine
      // in this window, not at each refresh.
      const removed = error instanceof RemovedEngineError ? error.host : undefined;
      if (removed === undefined || !this.removedEnginesSaid.has(removed)) {
        this.logger.warn(`The state of the devspaces could not be read: ${errorMessage(error)}`);
      }
      if (removed === undefined) return { runtime: undefined, branches: new Map() };
      this.removedEnginesSaid.add(removed);
      return { runtime: undefined, branches: new Map(), engineRemoved: true };
    }
  }

  /**
   * What an attached window reads of the dev container `containerName` of `devspace`, by the worker of the Docker
   * host of the operation (`windowState`): its state, whether it may be used as it is, and with `branch` the branch of
   * its repository. `undefined` when it could not be read (the worker could not be reached, or it failed): the window
   * keeps its state then ("unknown"). Never throws. The worker is made ready passively (as for the refresh: never a
   * build of the helper image, the wait after a failed open kept), and within WINDOW_STATE_FLOW_TIMEOUT_MS. With
   * `signal` (a read within an operation of the user, with its progress and Cancel), it is made ready in full, as for
   * the pipeline, until `signal` aborts.
   */
  async windowStateInWorker(
    devspace: Devspace,
    containerName: string,
    options: { branch?: boolean; signal?: AbortSignal } = {},
  ): Promise<WindowStateValue | undefined> {
    try {
      // A devspace of another Docker host is not read through the worker of this one.
      if (!(await this.isOnCurrentHost(devspace))) {
        // The reason of an unread state is in the log.
        this.logger.info(`The state of the container ${containerName} was not read: Docker is set to another host now.`);
        return undefined;
      }
      const params = parseWindowStateParams({
        devspaceId: devspace.id,
        containerName,
        checks: hostAccessChecks(devspace.repository, this.deps.settings()),
        ...(options.branch
          ? { branch: { folder: repositoryFolder(devspace.repository), ...(devspace.remoteUser !== undefined && devspace.remoteUser !== '' ? { user: devspace.remoteUser } : {}) } }
          : {}),
      });
      if (params === undefined) throw new Error('its parameters are beyond the checks of the worker');
      const value = parseWindowStateValue(
        await this.deps.flow(
          OP_WINDOW_STATE,
          params,
          options.signal !== undefined
            ? { timeoutMs: WINDOW_STATE_FLOW_TIMEOUT_MS, signal: options.signal }
            : { timeoutMs: WINDOW_STATE_FLOW_TIMEOUT_MS, passive: true, signal: AbortSignal.timeout(WINDOW_STATE_FLOW_TIMEOUT_MS) },
        ),
      );
      if (value === undefined) throw new Error('the worker answered with an invalid value');
      return value;
    } catch (error) {
      this.logger.info(`The state of the container ${containerName} could not be read: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /**
   * The rebuild of a lost registry by the worker of the Docker host of the operation (`reconcile`, where
   * reconcileFromVolumes runs; the entries come back as `record restore`, which this computer adds under its registry
   * lock). Returns the number of added entries. Does not start Docker: 0 when it does not run, and on an endpoint that
   * is neither local nor SSH. `passive`: a call in the background; the worker is made ready as for the refresh (the
   * helper image only checked, the wait after a failed open kept). Throws when the worker could not be reached or
   * failed (nothing is added then).
   */
  async reconcileInWorker(options: { passive: boolean; signal?: AbortSignal }): Promise<number> {
    const readable = await this.readableDockerHost();
    if (readable === undefined) return 0;
    if (!(await this.deps.dockerRunning())) return 0;
    const params = parseReconcileParams({ dockerHost: readable, owner: this.deps.owner });
    if (params === undefined) throw new Error('The rebuild of the registry cannot be sent to the worker.');
    const value = parseReconcileValue(
      await this.deps.flow(OP_RECONCILE, params, { timeoutMs: RECONCILE_FLOW_TIMEOUT_MS, ...(options.passive ? { passive: true } : {}), ...(options.signal ? { signal: options.signal } : {}) }),
    );
    if (value === undefined) throw new Error('The worker answered the rebuild of the registry with an invalid value.');
    return value.added;
  }

  /**
   * The token removal from the dev container `containerName` of a devspace by the worker of the current engine
   * (removeTokenThroughWorker), through the operations of the window, as every other flow. Its caller checks the Docker
   * host first.
   */
  async removeTokenInWorker(devspaceId: string, containerName: string): Promise<TokenRemoveValue> {
    return removeTokenThroughWorker(this.deps.flow, devspaceId, containerName);
  }
}
