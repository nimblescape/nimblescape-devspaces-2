// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The operations of the helper channel (src/core/helperChannel/protocol.ts): `probe` (whether the worker reaches its
// engine, and which engine), `sweep`, `refresh` (the states and branches of the devspaces), and the flows that run
// whole operations here, next to the engine (flowOperations.ts). There is no relay operation: the worker runs the whole
// pipeline itself, under its own locks and batch helpers. Every operation acts on the engine through its port
// (DockerEngine); the worker runs no Docker CLI of its own.
import {
  OP_PROBE,
  OP_DELETE,
  OP_DELETE_CHECK,
  OP_RECONCILE,
  OP_HEARTBEAT,
  OP_OPEN,
  OP_PREPARE,
  OP_MONITOR_ENSURE,
  OP_MONITOR_RUN_NOW,
  OP_RECORD_GIT_STATE,
  OP_LIST_CONFIGURATIONS,
  OP_WINDOW_STATE,
  OP_STOP,
  OP_TOKEN_REMOVE,
  OP_REFRESH,
  MAX_PROBE_DETAIL_LENGTH,
  OP_SWEEP,
  SWEEP_FILTERS,
  parseProbeParams,
  parseRefreshParams,
  parseSweepParams,
  refreshValue,
  type ProbeValue,
  type RefreshValue,
  type SweepValue,
  LOCK_STATE_DIR,
} from '../core/helperChannel/protocol';
import { errorMessage } from '../core/errors';
import { readDevspaceStates } from '../core/pipeline/refreshStates';
import { EngineDocker } from '../core/worker/engineDocker';
import { batchDeps, workerBatchSession } from './batch';
import { LOCK_DEPS } from './lock';
import { engineApi, engineHijack } from './engineApi';
import { dockerEngine } from './engineClient';
import { cancelledIfAborted, checkedOperation, contextLogger, deleteCheckOperation, deleteOperation, listConfigurationsOperation, ownHelperOfEngine, reconcileOperation, heartbeatOperation, monitorEnsureOperation, monitorRunNowOperation, openOperation, ensureWorkerMonitor, operationFailure, prepareOperation, recordGitStateOperation, stopOperation, tokenRemoveOperation, windowStateOperation, type EngineOfOperation, type OwnHelperOf, type WorkerScriptSource } from './flowOperations';
import * as os from 'os';
import type { OperationHandler } from './server';

/**
 * `probe`: the version of the engine behind the socket of the worker, and the identity of that engine, which the
 * extension compares with the identity that its own Docker CLI reads without the worker. Over the port of the engine
 * (`GET /version`, `GET /info`), no Docker CLI of the worker. A version that cannot be read is the answer (its reason
 * as the detail: the extension closes the worker, "does not reach Docker"); an identity that cannot be read is left out
 * (the extension closes the worker too). The time limit is the one of the request (the extension sets it).
 */
export function probeOperation(engineOf: EngineOfOperation): OperationHandler {
  return checkedOperation('probe', parseProbeParams, async (_checked, context) => {
    context.progress('probe');
    const engine = engineOf(context);
    let version: string;
    try {
      version = (await engine.version(context.signal)).version;
    } catch (error) {
      cancelledIfAborted('probe', context);
      const failed: ProbeValue = { detail: errorMessage(error).slice(-MAX_PROBE_DETAIL_LENGTH) };
      return failed;
    }
    if (version === '') {
      const failed: ProbeValue = { detail: 'The Docker engine did not name its version.' };
      return failed;
    }
    const value: ProbeValue = { serverVersion: version, detail: `Docker ${version}` };
    try {
      value.engine = await engine.identity(context.signal);
    } catch (error) {
      cancelledIfAborted('probe', context);
      // No identity, so the extension refuses this worker; the log says why.
      context.log(`The identity of the Docker engine could not be read: ${errorMessage(error)}`, 'warn');
    }
    return value;
  }, { invalid: 'The probe operation takes no parameters.' });
}

/**
 * `sweep` removes the channel containers that were created but never started (protocol.ts, OP_SWEEP): the prune of the
 * port of the engine with SWEEP_FILTERS (`POST /containers/prune`); its value is how many it removed. Every stopped
 * helper container (the channels and the batch helpers), never the Monitor.
 */
export function sweepOperation(engineOf: EngineOfOperation): OperationHandler {
  return checkedOperation('sweep', parseSweepParams, async (_checked, context) => {
    try {
      const removed = await engineOf(context).pruneContainers(SWEEP_FILTERS, context.signal);
      const value: SweepValue = { removed: removed.length };
      // What the sweep did, in the log of the worker: the helper containers, the channels and the batch helpers alike.
      context.log(`The sweep removed ${removed.length} stopped helper container(s) older than 10 minutes.`);
      return value;
    } catch (error) {
      throw operationFailure('sweep', error, context);
    }
  }, { invalid: 'The sweep operation takes no parameters.' });
}

/**
 * `refresh`: readDevspaceStates of the worker, the same code as in the pipeline, over the port of its engine
 * (EngineDocker), no Docker CLI of its own. It only reads; it takes no secret.
 */
export function refreshOperation(engineOf: EngineOfOperation): OperationHandler {
  return checkedOperation('refresh', parseRefreshParams, async (checked, context) => {
    context.progress('refresh');
    const value: RefreshValue = refreshValue(await readDevspaceStates(new EngineDocker(engineOf(context), contextLogger(context)), checked.devspaces));
    return value;
  });
}

/** The Engine API of the worker's engine, over its socket. */
const ENGINE = engineApi();

/** The port of the engine for the flows that run in the worker, per operation. */
const HIJACK = engineHijack();
// The output of an exec masked with every secret of the operation.
const ENGINE_OF: EngineOfOperation = (context) => dockerEngine(ENGINE, HIJACK, (name) => context.secrets[name], () => context.maskedValues());

/** The batch helpers of the flows of this worker (workerBatchSession), over its engine. */
const BATCH = batchDeps(ENGINE_OF);

/**
 * The worker's own helper image and socket, read once from the engine (the inspect of its own container, whose host
 * name is its short ID), and again after a failure, each read within a time limit (ownHelperOfEngine).
 */
const OWN_HELPER_OF: OwnHelperOf = ownHelperOfEngine(ENGINE_OF, () => os.hostname());

/**
 * This worker's own script (as the loader stored it) for the Monitor's prepares, stored by each ensure of the
 * monitor in its volume (LOCK_STATE_DIR, the same volume).
 */
const WORKER_SCRIPT: WorkerScriptSource = { read: () => BATCH.readScript(), stateDir: LOCK_STATE_DIR };

/** The script of the Monitor: this worker's own script, whose entry startMonitor runs the Monitor (main.ts). */
const MONITOR_SCRIPT = (): string => BATCH.readScript();

export const OPERATIONS: Readonly<Record<string, OperationHandler>> = {
  // Over the port of the engine too.
  [OP_PROBE]: probeOperation(ENGINE_OF),
  [OP_SWEEP]: sweepOperation(ENGINE_OF),
  [OP_REFRESH]: refreshOperation(ENGINE_OF),
  // The flows that run in the worker (flowOperations.ts).
  [OP_TOKEN_REMOVE]: tokenRemoveOperation(ENGINE_OF),
  // Stop, under the lock that the operation takes itself.
  [OP_STOP]: stopOperation(ENGINE_OF),
  // The listing of the configurations, by the worker's own pipeline.
  [OP_LIST_CONFIGURATIONS]: listConfigurationsOperation(ENGINE_OF, OWN_HELPER_OF, (context, p) => workerBatchSession(BATCH, context, p)),
  // Delete, by the worker's own pipeline.
  [OP_DELETE]: deleteOperation(ENGINE_OF, OWN_HELPER_OF, (context, p) => workerBatchSession(BATCH, context, p)),
  // The check of Delete and its questions, by the worker's own pipeline.
  [OP_DELETE_CHECK]: deleteCheckOperation(ENGINE_OF, OWN_HELPER_OF, (context, p) => workerBatchSession(BATCH, context, p)),
  // The reads of an attached window.
  [OP_WINDOW_STATE]: windowStateOperation(ENGINE_OF),
  // The registry rebuilt from the volumes, by the worker's own pipeline.
  [OP_RECONCILE]: reconcileOperation(ENGINE_OF, OWN_HELPER_OF, (context, p) => workerBatchSession(BATCH, context, p)),
  // The heartbeats of the Monitor, and the Git state of a release (the image settings come with the open).
  [OP_HEARTBEAT]: heartbeatOperation(ENGINE_OF),
  [OP_RECORD_GIT_STATE]: recordGitStateOperation(ENGINE_OF, OWN_HELPER_OF, (context, p) => workerBatchSession(BATCH, context, p)),
  // The ensure of the Monitor container, with this worker's own script as the script of the Monitor.
  [OP_MONITOR_ENSURE]: monitorEnsureOperation(ENGINE_OF, OWN_HELPER_OF, MONITOR_SCRIPT, WORKER_SCRIPT),
  // "Update All Images Now", the same ensure, then the request of the run.
  [OP_MONITOR_RUN_NOW]: monitorRunNowOperation(ENGINE_OF, OWN_HELPER_OF, MONITOR_SCRIPT, ensureWorkerMonitor, WORKER_SCRIPT),
  // The open, by the worker's own pipeline, with the Monitor of this bundle.
  [OP_OPEN]: openOperation(ENGINE_OF, OWN_HELPER_OF, (context, p) => workerBatchSession(BATCH, context, p), MONITOR_SCRIPT, LOCK_DEPS, WORKER_SCRIPT),
  // The headless prepare of the next devspace image (the Monitor triggers it).
  [OP_PREPARE]: prepareOperation(ENGINE_OF, OWN_HELPER_OF, (context, p) => workerBatchSession(BATCH, context, p)),
};
