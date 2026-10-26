// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The operations that run a whole flow in the worker (the worker is the deputy of the extension). Each one builds the
// seams of the flow from the requests of its operation (workerHostSide) and the port of its engine (dockerEngine), runs
// the flow, and answers with its result.
import {
  LOCK_BUSY_CODE,
  LOCK_UNAVAILABLE_CODE,
  MAX_REFUSAL_DETAIL_LENGTH,
  MAX_REFUSAL_MESSAGE_LENGTH,
  parseDeleteCheckParams,
  parseDeleteParams,
  parseListConfigurationsParams,
  parseReconcileParams,
  parseHeartbeatParams,
  parseMonitorEnsureParams,
  parseOpenParams,
  parsePrepareParams,
  MAX_PREPARE_DETAIL_LENGTH,
  type PrepareValue,
  OPEN_PROGRESS_DETAIL,
  type OpenParams,
  type OpenValue,
  type MonitorEnsureValue,
  type MonitorRunNowValue,
  parseRecordGitStateParams,
  type HeartbeatValue,
  type RecordGitStateValue,
  parseStopParams,
  parseTokenRemoveParams,
  parseWindowStateParams,
  type WindowStateValue,
  type FlowRefusal,
  type DeleteCheckValue,
  type DeleteValue,
  type ListConfigurationsValue,
  type StopValue,
  type TokenRemoveValue,
  type ReconcileValue,
} from '../core/helperChannel/protocol';
import { isBatchHelperUnavailable, isUserFacingError } from '../core/errors';
import { isAbortError, silentProgress, type Logger, type ProgressReporter } from '../core/ports';
import { errorMessage } from '../core/errors';
import { readOwnHelper, type OwnHelper } from '../core/worker/ownHelper';
import { workerServices } from '../core/worker/workerServices';
import { EngineDocker } from '../core/worker/engineDocker';
import { windowStateFlow } from '../core/worker/windowStateFlow';
import type { HelperBatchSession } from '../core/helperChannel/helperChannel';
import { workerDevspaceLock, workerPrepareLock } from './workerLock';
import { stopFlow } from '../core/worker/stopFlow';
import { LOCK_DEPS, takeDevspaceLock, type LockDeps } from './lock';
import type { DockerEngine } from '../core/worker/dockerEngine';
import { removeTokenFlow } from '../core/worker/tokenRemoveFlow';
import { requestBackgroundRun, sendHeartbeat, sendMonitorSettings } from '../core/worker/monitorFlow';
import type { ExtensionSettings } from '../core/types';
import { engineMonitor, limited } from '../core/worker/engineMonitor';
import { WorkerConfigurationAnalyzer, analysisSlots } from '../core/helper/configurationAnalysisRunner';
import { analysisFailure, type ConfigurationAnalyzer } from '../core/helper/configurationAnalysis';
import { monitorImageTag } from '../core/helper/helperState';
import { REMOTE_MONITOR_DOCKER_TIMEOUT_MS, RemoteSessionMonitor } from '../core/remoteMonitor/remoteSessionMonitor';
import { imageSettingsOf, isSourceId, type MonitorSettings } from '../core/remoteMonitor/protocol';
import { MONITOR_WORKER_HASH_ENV, storeWorkerScript } from '../core/remoteMonitor/workerScript';
import { bundleHash } from '../core/loader/pipeLoader';
import { workerHostSide } from '../core/worker/workerHostSide';
import type { HostRequest } from '../core/worker/hostSide';
import { ownScript } from './ownScript';
import { runPrepare } from './prepare';
import { OperationError, type OperationContext, type OperationHandler } from './server';

/**
 * The log of the extension as the Logger of the worker's code. `output`, the raw output of the tools (the Dev Container
 * CLI's build and up, the clone, the lifecycle commands, the pulls), goes to the extension's log as the operation's
 * output (OperationContext.output: masked by its StreamRedactor with every secret that the operation ever held, also
 * one split between two pieces; the rest is flushed, masked, when the operation ends; sent in pieces of at most
 * OUTPUT_CHUNK_CHARACTERS).
 */
export function contextLogger(context: OperationContext): Logger {
  return {
    info: (message) => context.log(message),
    warn: (message) => context.log(message, 'warn'),
    error: (message) => context.log(message, 'warn'),
    output: (text) => context.output('stdout', text),
  };
}

/** The seams of a flow from the context of its operation: its requests to the extension and its secrets. */
export function flowHost(context: OperationContext) {
  const ask: (request: HostRequest) => Promise<unknown> = (request) => context.ask(request.kind, { call: request.call, args: request.args });
  return workerHostSide(ask, (name) => context.secrets[name]);
}

/**
 * The port of the engine for one operation: with its own secrets for the standard input of an exec.
 */
export type EngineOfOperation = (context: OperationContext) => DockerEngine;

/**
 * The start that every operation shares. Its parameters by the schema of both sides (`parse`; else `invalid`, "The
 * parameters of the <name> operation are invalid.", or `texts.invalid`), and no secret (else `invalid`, "The <name>
 * operation takes no secret.", or `texts.secret`); then `run` with the parameters.
 */
export function checkedOperation<P>(
  name: string,
  parse: (params: unknown) => P | undefined,
  run: (checked: P, context: OperationContext) => Promise<unknown>,
  texts: { invalid?: string; secret?: string } = {},
): OperationHandler {
  return async (params, context) => {
    const checked = parse(params);
    if (checked === undefined) throw new OperationError('invalid', texts.invalid ?? `The parameters of the ${name} operation are invalid.`);
    if (!context.hasNoSecret()) throw new OperationError('invalid', texts.secret ?? `The ${name} operation takes no secret.`);
    return run(checked, context);
  };
}

/** `cancelled`, "The <name> operation was cancelled.", when the operation was cancelled. */
export function cancelledIfAborted(name: string, context: OperationContext): void {
  if (context.signal.aborted) throw new OperationError('cancelled', `The ${name} operation was cancelled.`);
}

/**
 * The end of an operation that failed with `error`: `cancelled` when it was cancelled (cancelledIfAborted), else
 * `failed` with the message of the error.
 */
export function operationFailure(name: string, error: unknown, context: OperationContext): OperationError {
  cancelledIfAborted(name, context);
  return new OperationError('failed', errorMessage(error));
}

/** `tokenRemove`: empties the token folder of the dev container of a devspace. */
export function tokenRemoveOperation(engineOf: EngineOfOperation): OperationHandler {
  return checkedOperation('tokenRemove', parseTokenRemoveParams, async (checked, context) => {
    const host = flowHost(context);
    context.progress('tokenRemove', checked.containerName);
    try {
      const result = await removeTokenFlow({
        devspaceId: checked.devspaceId,
        containerName: checked.containerName,
        engine: engineOf(context),
        records: host.records,
        log: (line) => context.log(line),
        signal: context.signal,
      });
      context.log(
        result.outcome === 'removed'
          ? `The GitHub token was removed from the container ${checked.containerName}.`
          : `The container ${checked.containerName} does not run: its memory holds no GitHub token.`,
      );
      return result satisfies TokenRemoveValue;
    } catch (error) {
      if (error instanceof OperationError) throw error;
      throw new OperationError('failed', errorMessage(error));
    }
  });
}

/**
 * `stop`, the Stop of a devspace (stopFlow) under its lock, which the operation takes itself (the one way:
 * takeDevspaceLock) and lets go at its end. A lock held elsewhere for the whole wait is `busy`.
 */
export function stopOperation(engineOf: EngineOfOperation, lockDeps: LockDeps = LOCK_DEPS): OperationHandler {
  return checkedOperation('stop', parseStopParams, async (checked, context) => {
    context.progress('lock', checked.devspaceId);
    let release: () => void;
    try {
      release = await takeDevspaceLock(lockDeps, checked.devspaceId, checked.waitSeconds, context.signal);
    } catch (error) {
      // A lock that could not be taken for another reason than a holder elsewhere changed nothing; the extension says
      // so (devspaceLockUnavailable).
      if (error instanceof OperationError && error.code !== LOCK_BUSY_CODE && error.code !== 'cancelled') throw new OperationError(LOCK_UNAVAILABLE_CODE, error.message);
      throw error;
    }
    try {
      context.progress('stop', checked.containerName);
      const result = await stopFlow({
        devspaceId: checked.devspaceId,
        containerName: checked.containerName,
        folder: checked.folder,
        ...(checked.user !== undefined ? { user: checked.user } : {}),
        engine: engineOf(context),
        log: (line) => context.log(line),
        now: () => new Date().toISOString(),
        signal: context.signal,
      });
      return result satisfies StopValue;
    } catch (error) {
      if (error instanceof OperationError) throw error;
      throw operationFailure('stop', error, context);
    } finally {
      release();
    }
  });
}

/**
 * The end of a flow that runs the worker's own pipeline. A refusal of the pipeline (a UserFacingError) is its value, `{
 * refused }`, so that the extension shows it as its own refusal; a cancel ends the operation as `cancelled`; anything
 * else fails it.
 */
export function flowRefusal(error: unknown, context: OperationContext): { refused: FlowRefusal } {
  if (context.signal.aborted || isAbortError(error) || (isUserFacingError(error) && error.code === 'cancelled')) {
    throw new OperationError('cancelled', 'The operation was cancelled.');
  }
  if (error instanceof OperationError) throw error;
  if (!isUserFacingError(error) || error.code === 'cancelled') throw new OperationError('failed', errorMessage(error));
  const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
  return {
    refused: {
      code: error.code,
      message: clip(error.message || error.code, MAX_REFUSAL_MESSAGE_LENGTH),
      ...(error.detail !== undefined ? { detail: clip(error.detail, MAX_REFUSAL_DETAIL_LENGTH) } : {}),
      ...(isBatchHelperUnavailable(error) ? { batchHelperUnavailable: true as const } : {}),
    },
  };
}

/** The worker's own helper image and socket, for the batch helpers of its flows (readOwnHelper). */
export type OwnHelperOf = (context: OperationContext) => Promise<OwnHelper>;

/**
 * The worker's own helper image of an operation (ownHelperOf). A cancel ends the operation as `cancelled`; another
 * failure changed nothing, so the extension says so as for a worker that cannot take the lock (LOCK_UNAVAILABLE_CODE:
 * devspaceLockUnavailable). One function for the operations that read it before their pipeline.
 */
async function ownHelperOfOperation(ownHelperOf: OwnHelperOf, context: OperationContext): Promise<OwnHelper> {
  try {
    return await ownHelperOf(context);
  } catch (error) {
    if (context.signal.aborted) throw new OperationError('cancelled', 'The operation was cancelled.');
    throw new OperationError(LOCK_UNAVAILABLE_CODE, `The helper image of the worker cannot be read: ${errorMessage(error)}`);
  }
}

/**
 * The host access analysis of an operation in the worker: each job in a thread of its own, started from the worker's
 * own file after the check of its hash (ownScript), with the limits of the extension's (ANALYSIS_LIMITS), its failures
 * logged to the operation and refused (fail closed).
 */
export function workerAnalyzer(context: OperationContext): ConfigurationAnalyzer {
  const thread = workerThreadAnalyzer(context);
  // The operations of the worker share MAX_WORKER_ANALYSIS_THREADS threads.
  return {
    analyze: (job) =>
      WORKER_ANALYSIS_SLOTS(async () => {
        // A job whose operation ended while it waited starts no thread (refused).
        if (context.signal.aborted) return analysisFailure(job, { kind: 'internal', reason: 'the operation was cancelled' });
        return thread.analyze(job);
      }),
  };
}

/**
 * The analyzer of the thread of an operation (workerAnalyzer, without the shared slots): the worker's own file and its
 * hash (ownScript, the file that the loader checked; the end of main.ts starts the analysis in a thread of it), the
 * limits of the extension, the log of the operation. Apart, so that its tests need no seam in workerAnalyzer.
 */
export function workerThreadAnalyzer(context: OperationContext): WorkerConfigurationAnalyzer {
  const { file, hash } = ownScript();
  return new WorkerConfigurationAnalyzer({ file, hash }, contextLogger(context));
}

/** The most analysis threads that the worker runs at once, for all its operations. */
export const MAX_WORKER_ANALYSIS_THREADS = 2;
const WORKER_ANALYSIS_SLOTS = analysisSlots(MAX_WORKER_ANALYSIS_THREADS);

/**
 * The worker's own helper image, read once (`read`), and again after a failure (one failed read never holds every later
 * flow).
 */
export function ownHelperCache(read: OwnHelperOf): OwnHelperOf {
  let cached: Promise<OwnHelper> | undefined;
  return (context) => {
    const current = (cached ??= read(context));
    current.catch(() => {
      if (cached === current) cached = undefined;
    });
    return current;
  };
}

/** The time limit of a read of the worker's own helper image. */
export const OWN_HELPER_TIMEOUT_MS = 60_000;

/**
 * The worker's own helper image over the port of its engine: the inspect of the container of `hostname` (its short ID),
 * within OWN_HELPER_TIMEOUT_MS, cached (ownHelperCache). Apart, for its tests.
 */
export function ownHelperOfEngine(engineOf: EngineOfOperation, hostname: () => string, timeoutMs = OWN_HELPER_TIMEOUT_MS): OwnHelperOf {
  return ownHelperCache((context) => readOwnHelper(engineOf(context), hostname(), AbortSignal.timeout(timeoutMs)));
}

/** Opens a batch session of a flow in the worker (workerBatchSession of batch.ts). */
export type OpenWorkerBatch = (context: OperationContext, p: { volume: string; image: string; socket: string }) => Promise<HelperBatchSession>;

/**
 * `listConfigurations`, the listing of the configurations, run by the worker's own pipeline (workerServices): the
 * record and the account through the requests of the operation, the lock and the batch helper (on the worker's own
 * image) taken here.
 */
export function listConfigurationsOperation(engineOf: EngineOfOperation, ownHelperOf: OwnHelperOf, openBatch: OpenWorkerBatch, lockDeps: LockDeps = LOCK_DEPS): OperationHandler {
  return checkedOperation('listConfigurations', parseListConfigurationsParams, async (checked, context) => {
    context.progress('listConfigurations', checked.devspaceId);
    const ownHelper = await ownHelperOfOperation(ownHelperOf, context);
    const { service } = workerServices({
      host: flowHost(context),
      engine: engineOf(context),
      secretOf: (name) => context.secrets[name],
      forgetSecret: (name) => context.forgetSecret(name),
      logger: contextLogger(context),
      ownHelper,
      dockerHost: checked.dockerHost,
      owner: checked.owner,
      devspaceLock: workerDevspaceLock(lockDeps, (p) => openBatch(context, p), context),
      analyzer: workerAnalyzer(context),
    });
    try {
      const configPaths = await service.listConfigurations(checked.devspaceId, { progress: silentProgress, signal: context.signal });
      return { configPaths } satisfies ListConfigurationsValue;
    } catch (error) {
      return flowRefusal(error, context) satisfies ListConfigurationsValue;
    }
  });
}

/**
 * `windowState`, what an attached window reads of its dev container (windowStateFlow). It only reads: no lock, no
 * secret, no request to the extension.
 */
export function windowStateOperation(engineOf: EngineOfOperation): OperationHandler {
  return checkedOperation('windowState', parseWindowStateParams, async (checked, context) => {
    try {
      const value = await windowStateFlow({ ...checked, docker: new EngineDocker(engineOf(context), contextLogger(context)), signal: context.signal });
      return value satisfies WindowStateValue;
    } catch (error) {
      throw operationFailure('windowState', error, context);
    }
  });
}

/**
 * `delete`, the Delete of a devspace, run by the worker's own pipeline (workerServices, DevspaceService.delete):
 * the busy mark, the entry and the session files through the requests of the operation (each for its devspace only),
 * the lock taken here, the removal over the port of the engine, and the heartbeat record of the computer that sent it
 * forgotten in the Monitor of the engine.
 */
export function deleteOperation(engineOf: EngineOfOperation, ownHelperOf: OwnHelperOf, openBatch: OpenWorkerBatch, lockDeps: LockDeps = LOCK_DEPS): OperationHandler {
  return checkedOperation('delete', parseDeleteParams, async (checked, context) => {
    context.progress('delete', checked.devspaceId);
    const ownHelper = await ownHelperOfOperation(ownHelperOf, context);
    const { service } = workerServices({
      host: flowHost(context),
      engine: engineOf(context),
      secretOf: (name) => context.secrets[name],
      forgetSecret: (name) => context.forgetSecret(name),
      logger: contextLogger(context),
      ownHelper,
      dockerHost: checked.dockerHost,
      owner: checked.owner,
      devspaceLock: workerDevspaceLock(lockDeps, (p) => openBatch(context, p), context),
      // Delete stops a running prepare of the devspace first.
      prepareLock: workerPrepareLock(lockDeps, context),
      analyzer: workerAnalyzer(context),
      monitorSource: checked.monitorSource,
    });
    try {
      await service.delete(checked.devspaceId, { progress: silentProgress, signal: context.signal, additionalVolumesToRemove: checked.additionalVolumesToRemove });
      return { deleted: true } satisfies DeleteValue;
    } catch (error) {
      return flowRefusal(error, context) satisfies DeleteValue;
    }
  });
}

/**
 * `deleteCheck`, the check of Delete and its questions, run by the worker's own pipeline (workerServices,
 * DevspaceService.deleteCheck): the record, the account and the registry through the requests of the operation, the
 * Git state recorded through `record recordGitSummary`, the questions as `question` requests. No lock: it only reads on
 * the engine.
 */
export function deleteCheckOperation(engineOf: EngineOfOperation, ownHelperOf: OwnHelperOf, openBatch: OpenWorkerBatch, lockDeps: LockDeps = LOCK_DEPS): OperationHandler {
  return checkedOperation('deleteCheck', parseDeleteCheckParams, async (checked, context) => {
    context.progress('deleteCheck', checked.devspaceId);
    const ownHelper = await ownHelperOfOperation(ownHelperOf, context);
    const { service } = workerServices({
      host: flowHost(context),
      engine: engineOf(context),
      secretOf: (name) => context.secrets[name],
      forgetSecret: (name) => context.forgetSecret(name),
      logger: contextLogger(context),
      ownHelper,
      dockerHost: checked.dockerHost,
      owner: checked.owner,
      devspaceLock: workerDevspaceLock(lockDeps, (p) => openBatch(context, p), context),
      analyzer: workerAnalyzer(context),
    });
    try {
      const decision = await service.deleteCheck(checked.devspaceId, { progress: silentProgress, signal: context.signal, repository: checked.repository, otherWindow: checked.otherWindow });
      return decision satisfies DeleteCheckValue;
    } catch (error) {
      return flowRefusal(error, context) satisfies DeleteCheckValue;
    }
  });
}

/**
 * `reconcile`, the registry rebuilt from the labels of the volumes of the engine (when the registry is lost), by the
 * worker's own pipeline (workerServices, DevspaceService.reconcileFromVolumes): the volumes and the containers read
 * over the port of the engine, the entries added by the extension (`record restore`). No lock: it only reads on the
 * engine.
 */
export function reconcileOperation(engineOf: EngineOfOperation, ownHelperOf: OwnHelperOf, openBatch: OpenWorkerBatch, lockDeps: LockDeps = LOCK_DEPS): OperationHandler {
  return checkedOperation('reconcile', parseReconcileParams, async (checked, context) => {
    const ownHelper = await ownHelperOfOperation(ownHelperOf, context);
    const { service } = workerServices({
      host: flowHost(context),
      engine: engineOf(context),
      secretOf: (name) => context.secrets[name],
      forgetSecret: (name) => context.forgetSecret(name),
      logger: contextLogger(context),
      ownHelper,
      dockerHost: checked.dockerHost,
      owner: checked.owner,
      devspaceLock: workerDevspaceLock(lockDeps, (p) => openBatch(context, p), context),
      analyzer: workerAnalyzer(context),
    });
    try {
      return { added: await service.reconcileFromVolumes() } satisfies ReconcileValue;
    } catch (error) {
      throw operationFailure('reconcile', error, context);
    }
  });
}

/**
 * `heartbeat`, one heartbeat of a window to the Monitor container of the worker's engine
 * (monitorFlow.sendHeartbeat). `missing` tells the window to start the monitor again.
 */
export function heartbeatOperation(engineOf: EngineOfOperation): OperationHandler {
  return checkedOperation('heartbeat', parseHeartbeatParams, async (checked, context) => {
    const value = await sendHeartbeat(engineOf(context), checked.heartbeat, context.signal).catch((error: unknown) => {
      cancelledIfAborted('heartbeat', context);
      throw error;
    });
    return value satisfies HeartbeatValue;
  });
}

/**
 * `recordGitState`, the Git state of the running dev container of a devspace that a window releases, by the
 * worker's own pipeline (DevspaceService.recordGitState): the record through `record get`, the state recorded
 * through `record recordGitSummary`. No lock: it only reads on the engine.
 */
export function recordGitStateOperation(engineOf: EngineOfOperation, ownHelperOf: OwnHelperOf, openBatch: OpenWorkerBatch, lockDeps: LockDeps = LOCK_DEPS): OperationHandler {
  return checkedOperation('recordGitState', parseRecordGitStateParams, async (checked, context) => {
    const ownHelper = await ownHelperOfOperation(ownHelperOf, context);
    const { service } = workerServices({
      host: flowHost(context),
      engine: engineOf(context),
      secretOf: (name) => context.secrets[name],
      forgetSecret: (name) => context.forgetSecret(name),
      logger: contextLogger(context),
      ownHelper,
      dockerHost: checked.dockerHost,
      owner: checked.owner,
      devspaceLock: workerDevspaceLock(lockDeps, (p) => openBatch(context, p), context),
      analyzer: workerAnalyzer(context),
    });
    const recorded = await service.recordGitState(checked.devspaceId, context.signal);
    cancelledIfAborted('recordGitState', context);
    return { recorded } satisfies RecordGitStateValue;
  });
}

/**
 * The image of the monitor container: the worker's own image (the pinned helper image) by its monitor tag
 * `devspaces-monitor:<hash>`, tagged here, with the ID that the create checks; by the ID itself when the tag of the
 * worker is no helper tag or the tag fails (the name in the Containers view only).
 */
export async function monitorImage(engine: DockerEngine, own: { tag: string; id?: string }, logger: Logger, signal: AbortSignal): Promise<{ reference: string; id?: string }> {
  // Without an ID, its tag (readOwnHelper always reads one).
  if (own.id === undefined) return { reference: own.tag };
  const reference = monitorImageTag(own.tag);
  if (reference === undefined) return { reference: own.id };
  try {
    const id = own.id;
    await limited(REMOTE_MONITOR_DOCKER_TIMEOUT_MS, signal, (limit) => engine.tagImage(id, reference, limit));
  } catch (error) {
    if (signal.aborted) throw error;
    logger.warn(`The image of the Monitor could not be tagged as ${reference}; it runs from ${own.id}: ${errorMessage(error)}`);
    return { reference: own.id };
  }
  return { reference, id: own.id };
}

/**
 * The Monitor of the worker's engine made sure, as `monitorEnsure` does it, for that operation and for the open
 * in the worker (WorkerServicesDeps.monitorEnsure): from the worker's own helper image (its monitor tag, monitorImage),
 * with the socket that the worker mounts, the worker's own script as the script of the Monitor and the image
 * maintenance of the operation. Rejects with the cause when it cannot. With the mode of the monitor
 * (MonitorSettings.permanent), and with the shared VS Code server store that the worker mounts (OwnHelper.vscodeStore),
 * which the monitor mounts too for its background run. With `worker`, the worker's own script stored in the volume of
 * the monitor first (storeWorkerScript; a failure is one warning and the ensure goes on), and its hash given to a
 * monitor that this ensure creates (MONITOR_WORKER_HASH_ENV), so that the monitor's prepares run this worker; no token,
 * no credential, nothing else.
 */
export async function ensureWorkerMonitor(
  engine: DockerEngine,
  own: OwnHelper,
  logger: Logger,
  script: () => string,
  images: MonitorSettings,
  signal: AbortSignal,
  worker?: WorkerScriptSource,
): Promise<MonitorEnsureValue['outcome']> {
  const workerHash = worker === undefined ? undefined : storedWorkerHash(worker, logger);
  const monitor = new RemoteSessionMonitor({
    engine: engineMonitor(engine),
    logger,
    script: async () => script(),
    imageMaintenance: () => images,
    ...(own.vscodeStore !== undefined ? { vscodeStoreVolume: own.vscodeStore } : {}),
    ...(workerHash !== undefined ? { containerEnv: { [MONITOR_WORKER_HASH_ENV]: workerHash } } : {}),
  });
  const image = await monitorImage(engine, own.image, logger, signal);
  return monitor.ensureOrThrow(own.image.tag, own.socket, signal, image.reference, image.id);
}

/**
 * The worker's own script (its bundle as the loader stored it) and the volume of the Monitor as the worker
 * mounts it (LOCK_STATE_DIR), where ensureWorkerMonitor stores the script for the monitor's prepares.
 */
export interface WorkerScriptSource {
  read(): string;
  stateDir: string;
}

/**
 * Stores the worker's script for the monitor (storeWorkerScript) and answers its hash; undefined after one warning when
 * the script cannot be read (no prepare then). A failed store is a warning too, but the hash is answered (the monitor
 * then says that the script is missing, and the next ensure stores it again).
 */
function storedWorkerHash(worker: WorkerScriptSource, logger: Logger): string | undefined {
  let script: string;
  try {
    script = worker.read();
  } catch (error) {
    logger.warn(`The worker script cannot be read, so the Monitor prepares no devspace image: ${errorMessage(error)}`);
    return undefined;
  }
  try {
    return storeWorkerScript(worker.stateDir, script);
  } catch (error) {
    logger.warn(`The worker script could not be stored for the prepares of the Monitor: ${errorMessage(error)}`);
    return bundleHash(script);
  }
}

/**
 * `monitorEnsure`, the Monitor container of the worker's engine made sure (RemoteSessionMonitor.ensureOrThrow
 * over the Engine API, engineMonitor): with the worker's own helper image (the image the worker runs from: its tag in
 * the label, its ID as the image of the container, its monitor tag: monitorImage), the socket that the worker mounts,
 * and `script` (the worker's own script, whose entry startMonitor runs the Monitor). A failure fails the operation with
 * its cause.
 */
export function monitorEnsureOperation(engineOf: EngineOfOperation, ownHelperOf: OwnHelperOf, script: () => string, worker?: WorkerScriptSource): OperationHandler {
  return checkedOperation('monitorEnsure', parseMonitorEnsureParams, async (checked, context) => {
    try {
      const own = await ownHelperOf(context);
      const outcome = await ensureWorkerMonitor(engineOf(context), own, contextLogger(context), script, checked.images, context.signal, worker);
      return { outcome } satisfies MonitorEnsureValue;
    } catch (error) {
      throw operationFailure('monitorEnsure', error, context);
    }
  });
}

/**
 * `monitorRunNow`, "Update All Images Now": the Monitor container of the worker's engine made sure as
 * `monitorEnsure` does (so it runs, and its script knows `run-now`), then its request for the background run at once
 * (requestBackgroundRun). A failure of either fails the operation with its cause; the run itself is not waited for.
 */
export function monitorRunNowOperation(
  engineOf: EngineOfOperation,
  ownHelperOf: OwnHelperOf,
  script: () => string,
  ensure: typeof ensureWorkerMonitor = ensureWorkerMonitor,
  worker?: WorkerScriptSource,
): OperationHandler {
  return checkedOperation('monitorRunNow', parseMonitorEnsureParams, async (checked, context) => {
    try {
      const own = await ownHelperOf(context);
      const engine = engineOf(context);
      await ensure(engine, own, contextLogger(context), script, checked.images, context.signal, worker);
      const requested = await requestBackgroundRun(engine, context.signal);
      if (!requested.ok) throw new Error(`The Monitor did not take the request: ${requested.detail}`);
      return { requested: true } satisfies MonitorRunNowValue;
    } catch (error) {
      throw operationFailure('monitorRunNow', error, context);
    }
  });
}

/**
 * `prepare`, the headless prepare of the next devspace image of a devspace of the worker's engine (runPrepare):
 * no request to the extension (it has no HostSide: the Monitor runs it without VS Code), no secret, under the
 * prepare lock only, its batch helper on the worker's own image. Its value says what it did (PrepareValue); a cancel of
 * the operation ends it as `cancelled`.
 */
export function prepareOperation(engineOf: EngineOfOperation, ownHelperOf: OwnHelperOf, openBatch: OpenWorkerBatch, lockDeps: LockDeps = LOCK_DEPS): OperationHandler {
  return checkedOperation('prepare', parsePrepareParams, async (checked, context) => {
    context.progress('prepare', checked.devspaceId);
    const ownHelper = await ownHelperOfOperation(ownHelperOf, context);
    const result = await runPrepare(
      {
        engine: engineOf(context),
        ownHelper,
        logger: contextLogger(context),
        analyzer: workerAnalyzer(context),
        lockDeps,
        openBatch: (p) => openBatch(context, p),
        signal: context.signal,
      },
      checked.devspaceId,
    );
    cancelledIfAborted('prepare', context);
    const detail = result.detail.length > MAX_PREPARE_DETAIL_LENGTH ? `${result.detail.slice(0, MAX_PREPARE_DETAIL_LENGTH - 1)}…` : result.detail;
    return { outcome: result.outcome, detail, seconds: Math.round(result.durationMs / 1000) } satisfies PrepareValue;
  });
}

/**
 * The settings of the pipeline of an open from its OpenSettings: the host access checks of its repository
 * (`hostAccessChecksOff` names it only when they are off), and nothing that the pipeline does not read.
 */
export function openSettingsOf(repository: string, settings: OpenParams['settings']): ExtensionSettings {
  return {
    reopenLastOnStartup: false,
    stopOnClose: settings.stopOnClose,
    updateImagesOnConnect: settings.updateImagesOnConnect,
    respectShutdownActionNone: settings.respectShutdownActionNone,
    owners: [],
    includeArchived: false,
    includeForks: false,
    refreshIntervalMinutes: 0,
    hostAccessChecksOff: settings.hostAccessChecks === 'off' ? [repository] : [],
    ...(settings.stopAfterMinutes !== undefined ? { stopAfterMinutes: settings.stopAfterMinutes } : {}),
  };
}

/** The progress of the pipeline as the progress of the operation (OPEN_PROGRESS_DETAIL for a detail). */
export function operationProgress(context: OperationContext): ProgressReporter {
  return {
    step: (step) => context.progress(step),
    detail: (message) => context.progress(OPEN_PROGRESS_DETAIL, message),
  };
}

/**
 * The image settings of an open for the Monitor of the worker's engine, after its ensure (always: they hold the
 * schedule of the background run), and the image references in use of the computer of the open (`references` of
 * `monitorSource`), when it carries them. Best effort: a failure is logged. No image list of repositories is sent. The
 * monitor is the one of this version (the ensure ran before); an older one that another computer put in its place
 * meanwhile may refuse either input (logged), and the next open sends them again.
 */
export async function giveMonitorImages(
  engine: DockerEngine,
  params: Pick<OpenParams, 'images' | 'references' | 'referenceDigests'> & Partial<Pick<OpenParams, 'monitorSource'>>,
  logger: Logger,
  signal: AbortSignal,
): Promise<void> {
  // Always: the schedule of the whole background run (the newest settings of any computer apply); without the mode,
  // which is part of the label (imageSettingsOf).
  const settings = await sendMonitorSettings(engine, { settings: imageSettingsOf(params.images) }, signal);
  if (!settings.ok) logger.warn(`The image settings could not be given to the Monitor: ${settings.detail}`);
  if (params.references === undefined || !isSourceId(params.monitorSource)) return;
  // With the recorded digests of the references.
  const inUse = { source: params.monitorSource, references: params.references, ...(params.referenceDigests !== undefined ? { digests: params.referenceDigests } : {}) };
  const list = await sendMonitorSettings(engine, { inUse }, signal);
  if (!list.ok) logger.warn(`The image references in use could not be given to the Monitor: ${list.detail}`);
}

/**
 * The Monitor of an open: its ensure with the image maintenance of the parameters, then its image settings and
 * the references in use (giveMonitorImages); each with the signal of the operation when the pipeline gives none.
 */
export function openMonitor(
  engine: DockerEngine,
  own: OwnHelper,
  logger: Logger,
  script: () => string,
  params: Pick<OpenParams, 'images' | 'references' | 'referenceDigests'> & Partial<Pick<OpenParams, 'monitorSource'>>,
  operationSignal: AbortSignal,
  ensure: typeof ensureWorkerMonitor = ensureWorkerMonitor,
  worker?: WorkerScriptSource,
): { monitorEnsure: (signal: AbortSignal | undefined) => Promise<unknown>; monitorImages: (signal: AbortSignal | undefined) => Promise<void> } {
  return {
    monitorEnsure: (signal) => ensure(engine, own, logger, script, params.images, signal ?? operationSignal, worker),
    monitorImages: (signal) => giveMonitorImages(engine, params, logger, signal ?? operationSignal),
  };
}

/**
 * `open`, the open of a devspace by the worker's own pipeline (workerServices, DevspaceService.open or
 * openDevspace): the records, the questions, the token and the registry logins through the requests of the
 * operation, the lock and the batch helper (on the worker's own image) taken here, the Monitor of the engine
 * made sure with the image maintenance of the parameters (ensureWorkerMonitor, with the signal of the operation when
 * the pipeline gives none), its image settings and references given after it (giveMonitorImages), and its first
 * heartbeat with the time limit of the settings. It answers with what the window needs to connect; a refusal of the
 * pipeline is its value.
 */
export function openOperation(
  engineOf: EngineOfOperation,
  ownHelperOf: OwnHelperOf,
  openBatch: OpenWorkerBatch,
  script: () => string,
  lockDeps: LockDeps = LOCK_DEPS,
  worker?: WorkerScriptSource,
): OperationHandler {
  return checkedOperation('open', parseOpenParams, async (checked, context) => {
    context.progress('open', checked.devspaceId ?? checked.repository);
    const ownHelper = await ownHelperOfOperation(ownHelperOf, context);
    const engine = engineOf(context);
    const logger = contextLogger(context);
    const monitor = openMonitor(engine, ownHelper, logger, script, checked, context.signal, ensureWorkerMonitor, worker);
    const { service } = workerServices({
      host: flowHost(context),
      engine,
      secretOf: (name) => context.secrets[name],
      forgetSecret: (name) => context.forgetSecret(name),
      logger,
      ownHelper,
      dockerHost: checked.dockerHost,
      owner: checked.owner,
      devspaceLock: workerDevspaceLock(lockDeps, (p) => openBatch(context, p), context),
      // An update may wait for the prepare of its image.
      prepareLock: workerPrepareLock(lockDeps, context),
      analyzer: workerAnalyzer(context),
      settings: openSettingsOf(checked.repository, checked.settings),
      monitorSource: checked.monitorSource,
      monitorEnsure: monitor.monitorEnsure,
      monitorImages: monitor.monitorImages,
      // The server of the window's VS Code, for the shared VS Code server store.
      ...(checked.vscodeServer !== undefined ? { vscodeServer: checked.vscodeServer } : {}),
      // The user's default extensions, for the shared extension cache.
      ...(checked.defaultExtensions !== undefined ? { defaultExtensions: checked.defaultExtensions } : {}),
    });
    const options = {
      progress: operationProgress(context),
      signal: context.signal,
      ...(checked.forceRebuild === true ? { forceRebuild: true } : {}),
      ...(checked.source !== undefined ? { source: checked.source } : {}),
    };
    try {
      const result =
        checked.devspaceId !== undefined
          ? await service.openDevspace(checked.devspaceId, options)
          : await service.open({ repository: checked.repository, ...checked.target!, defaultBranch: checked.target!.defaultBranch ?? null }, options);
      return {
        opened: { devspaceId: result.devspace.id, containerName: result.containerName, remoteWorkspaceFolder: result.remoteWorkspaceFolder },
        // What the link of the shared VS Code server did (one value; the log of the open says why).
        ...(result.vscodeServer !== undefined ? { vscodeServer: result.vscodeServer } : {}),
      } satisfies OpenValue;
    } catch (error) {
      return flowRefusal(error, context) satisfies OpenValue;
    }
  }, { secret: 'The open operation takes no secret: it asks for the ones it needs.' });
}
