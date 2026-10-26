// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The calls of this window to the Monitor of an engine, as operations of the worker of that engine (every
// remote action is a worker operation): the heartbeats (`heartbeat`), the check that the container of a devspace
// exists there (`windowState`), the Git state of a release (`recordGitState`), the ensure of the monitor
// (`monitorEnsure`), and "Update All Images Now" (`monitorRunNow`). The image settings and list come with the operation
// `open`. No `vscode` here; never throws, except the Git state (its caller bounds and logs it).
import type { DockerTarget } from '../core/docker/dockerHost';
import { errorMessage } from '../core/errors';
import {
  OP_HEARTBEAT,
  OP_MONITOR_ENSURE,
  OP_MONITOR_RUN_NOW,
  OP_RECORD_GIT_STATE,
  OP_WINDOW_STATE,
  parseHeartbeatValue,
  parseMonitorEnsureParams,
  parseMonitorEnsureValue,
  parseMonitorRunNowValue,
  parseRecordGitStateParams,
  parseRecordGitStateValue,
  parseWindowStateParams,
  parseWindowStateValue,
} from '../core/helperChannel/protocol';
import { MONITOR_ENSURE_FLOW_TIMEOUT_MS, MONITOR_FLOW_TIMEOUT_MS, MONITOR_RUN_NOW_FLOW_TIMEOUT_MS } from '../core/pipeline/operationBase';
import type { Logger } from '../core/ports';
import type { HeartbeatInput, MonitorSettings } from '../core/remoteMonitor/protocol';
import type { HeartbeatSendResult } from '../core/session/windowHeartbeats';
import type { Devspace } from '../core/types';

/** A flow in the worker of `target` (extensionFlow with its target). */
export type TargetFlow = (op: string, params: unknown, options: { target: DockerTarget; signal?: AbortSignal; timeoutMs?: number }) => Promise<unknown>;

export interface WorkerMonitorDeps {
  flow: TargetFlow;
  /** The window that sends the operations (for `recordGitState`). */
  owner: () => { windowId: string; pid: number };
  logger: Logger;
}

export function workerMonitor(deps: WorkerMonitorDeps) {
  const { flow, logger } = deps;
  return {
    /** One heartbeat on the engine `target` (WindowHeartbeatsDeps.send). */
    async heartbeat(target: DockerTarget, input: HeartbeatInput, signal?: AbortSignal): Promise<HeartbeatSendResult> {
      try {
        const value = parseHeartbeatValue(await flow(OP_HEARTBEAT, { heartbeat: input }, { target, timeoutMs: MONITOR_FLOW_TIMEOUT_MS, ...(signal ? { signal } : {}) }));
        if (value === undefined) return { ok: false, missing: false, detail: 'the worker answered the heartbeat with an invalid value' };
        return value;
      } catch (error) {
        return { ok: false, missing: false, detail: errorMessage(error) };
      }
    },

    /**
     * Whether the container of `devspace` exists on `target` (WindowHeartbeatsDeps.containerExists); false when it does
     * not or cannot be checked.
     */
    async containerExists(target: DockerTarget, devspace: Devspace, signal?: AbortSignal): Promise<boolean> {
      try {
        const params = parseWindowStateParams({ devspaceId: devspace.id, containerName: devspace.containerName, checks: 'off' });
        if (params === undefined) throw new Error('its parameters are beyond the checks of the worker');
        const value = parseWindowStateValue(await flow(OP_WINDOW_STATE, params, { target, timeoutMs: MONITOR_FLOW_TIMEOUT_MS, ...(signal ? { signal } : {}) }));
        if (value === undefined) throw new Error('the worker answered with an invalid value');
        return value.state !== 'missing';
      } catch (error) {
        logger.info(`The container of ${devspace.repository} could not be checked on ${target.kind === 'local' ? 'the local Docker' : target.host}: ${errorMessage(error)}`);
        return false;
      }
    },

    /**
     * Makes sure that the Monitor container of `target` runs (the operation `monitorEnsure`), with the image
     * maintenance of this computer (with the schedule of the background run and the mode of the monitor). Rejects with
     * the cause when it cannot.
     */
    async monitorEnsure(target: DockerTarget, images: MonitorSettings, signal?: AbortSignal): Promise<void> {
      const params = parseMonitorEnsureParams({ images });
      if (params === undefined) throw new Error('The image maintenance of this computer cannot be sent to the worker.');
      const value = parseMonitorEnsureValue(await flow(OP_MONITOR_ENSURE, params, { target, timeoutMs: MONITOR_ENSURE_FLOW_TIMEOUT_MS, ...(signal ? { signal } : {}) }));
      if (value === undefined) throw new Error('The worker answered the ensure of the Monitor with an invalid value.');
    },

    /**
     * "Update All Images Now": the Monitor of `target` made sure (with the image maintenance of this computer,
     * as monitorEnsure), then asked to run its background run at once (the operation `monitorRunNow`). Resolves when
     * the monitor took the request, not when the run ends; rejects with the cause when it cannot.
     */
    async monitorRunNow(target: DockerTarget, images: MonitorSettings, signal?: AbortSignal): Promise<void> {
      const params = parseMonitorEnsureParams({ images });
      if (params === undefined) throw new Error('The image maintenance of this computer cannot be sent to the worker.');
      const value = parseMonitorRunNowValue(await flow(OP_MONITOR_RUN_NOW, params, { target, timeoutMs: MONITOR_RUN_NOW_FLOW_TIMEOUT_MS, ...(signal ? { signal } : {}) }));
      if (value === undefined) throw new Error('The worker answered the request of the background run with an invalid value.');
    },

    /** Records the Git state of `devspace` (the release of this window), by the worker of `target`. */
    async recordGitState(target: DockerTarget, devspace: Devspace, signal?: AbortSignal): Promise<boolean> {
      const params = parseRecordGitStateParams({ devspaceId: devspace.id, dockerHost: target.host, owner: deps.owner() });
      if (params === undefined) throw new Error('The Git state of the release cannot be sent to the worker.');
      const value = parseRecordGitStateValue(await flow(OP_RECORD_GIT_STATE, params, { target, timeoutMs: MONITOR_FLOW_TIMEOUT_MS, ...(signal ? { signal } : {}) }));
      if (value === undefined) throw new Error('The worker answered the Git state of the release with an invalid value.');
      return value.recorded;
    },
  };
}
