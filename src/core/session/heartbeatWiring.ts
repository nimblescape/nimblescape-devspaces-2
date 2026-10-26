// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The wiring of the helper image for the heartbeats of a window: the preparation of the heartbeats
// (HeartbeatPreparation, disposed with the window), the end of its waits when a build of the helper image succeeded
// (HelperImages' onImageBuilt: the wait of the engine of the operation that built it, every wait when that engine is
// not known), the preparation of a worker (HelperChannels' `prepare`) and the repair of a Monitor container,
// both through heartbeatHelperImage. A heartbeat never prepares a worker on an engine with the removal mark
// (`engineRemoved`). extension.ts uses it; here so the wiring is tested. No `vscode`.
import { describeDockerHost, type DockerTarget } from '../docker/dockerHost';
import { removedEngineNote } from '../docker/engineRemoval';
import type { HelperMaintenance } from '../helper/helperImages';
import { heartbeatHelperImage, type HeartbeatHelperImageDeps } from './heartbeatHelperImage';
import { HeartbeatPreparation } from './heartbeatPreparation';

export interface HeartbeatWiringDeps extends Omit<HeartbeatHelperImageDeps, 'preparation'> {
  /** The Docker target of the running operation (operationDockerTarget), `undefined` when it is not known. */
  operationTarget: () => DockerTarget | undefined;
  /** The disposables of the window (context.subscriptions): the preparation is disposed with it. */
  subscriptions: { push(disposable: { dispose(): void }): unknown };
  /** The preparation of the heartbeats (a new one by default). */
  preparation?: HeartbeatPreparation;
  /**
   * Whether the engine `target` has the removal mark of "Remove Devspaces from This Docker Engine…" (docker-engines.json;
   * never throws). The preparation of a worker for a heartbeat (its send, its repair, its checks) is refused there: it
   * would build the helper image again, and the worker would create the volumes that it mounts. An operation of the
   * user prepares its worker there as everywhere. Without it, no engine is refused.
   */
  engineRemoved?: (target: DockerTarget) => Promise<boolean>;
}

/**
 * Starts the Monitor container of `target` again: the operation `monitorEnsure` of the worker of `target`,
 * which runs from the helper image (its preparation, below, gives it).
 */
export type EnsureMonitor = (target: DockerTarget, signal: AbortSignal) => Promise<void>;

export interface HeartbeatWiring {
  /** The preparation of the heartbeats (its scope for their send, repair and check). */
  readonly preparation: HeartbeatPreparation;
  /** HelperImages' onImageBuilt: a build succeeded, so the wait of its engine ends (every wait when not known). */
  imageBuilt(): void;
  /**
   * HelperChannels' `prepare`: the helper image for the worker of `target`, through the preparation (its wait). With
   * `maintenance` (the preparation for an operation `open`), the maintaining ensure (heartbeatHelperImage). In the scope
   * of a heartbeat on an engine with the removal mark, it rejects without a build (removedEngineNote).
   */
  prepareWorker(target: DockerTarget, signal: AbortSignal | undefined, maintenance?: HelperMaintenance): Promise<void>;
  /**
   * The repair of the Monitor container of a heartbeat: in the scope of a heartbeat, `ensureMonitor` on
   * `target` (the worker's operation; its preparation is the helper image through the preparation and its wait, as for
   * every operation of a heartbeat).
   */
  repair(ensureMonitor: EnsureMonitor): (target: DockerTarget, signal: AbortSignal) => Promise<void>;
}

export function heartbeatWiring(deps: HeartbeatWiringDeps): HeartbeatWiring {
  const preparation = deps.preparation ?? new HeartbeatPreparation();
  // The window closes: the preparations that its heartbeats started are aborted.
  deps.subscriptions.push({ dispose: () => preparation.dispose() });
  const image = heartbeatHelperImage({ preparation, helper: deps.helper, inTarget: deps.inTarget, onOutput: deps.onOutput });
  return {
    preparation,
    imageBuilt: () => {
      const built = deps.operationTarget();
      if (built !== undefined) preparation.clear(built);
      else preparation.clearAll();
    },
    prepareWorker: async (target, signal, maintenance) => {
      // Devspaces was removed from the engine (or is being removed): a heartbeat sets nothing up there again.
      if (preparation.inScope() && deps.engineRemoved !== undefined && (await deps.engineRemoved(target))) {
        throw new Error(removedEngineNote(describeDockerHost(target.host)));
      }
      await image.prepareWorker(target, signal, maintenance);
    },
    repair: (ensureMonitor) => (target, signal) => preparation.scope(() => ensureMonitor(target, signal)),
  };
}
