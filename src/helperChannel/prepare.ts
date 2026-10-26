// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The headless prepare in the worker, the entry point of the operation `prepare` (flowOperations.ts, prepareOperation),
// which the Monitor's trigger sends to this worker's script that it runs in its own container
// (src/remoteMonitor/prepares.ts: one prepare at a time per engine, the most recently used devspace first, with the
// ID of the devspace). It needs nothing of a computer: the pipeline runs on the deps of a prepare
// (headlessServiceDeps: the engine of the worker, its own helper image, the devspaces from the labels of the
// volumes, anonymous registries), under the prepare lock of the devspace only (takePrepareLock, taken without a
// wait), with its files next to that lock (PrepareFiles: the stop request of a Delete, polled every
// PREPARE_STOP_POLL_MS; the hash that the time limit stopped or whose build failed). Worker only.
import type { ConfigurationAnalyzer } from '../core/helper/configurationAnalysis';
import type { HelperBatchSession } from '../core/helperChannel/helperChannel';
import { errorMessage } from '../core/errors';
import { DevspaceService } from '../core/pipeline/devspaceService';
import type { PrepareResult } from '../core/pipeline/devspacePorts';
import type { Logger } from '../core/ports';
import type { DockerEngine } from '../core/worker/dockerEngine';
import type { OwnHelper } from '../core/worker/ownHelper';
import { headlessServiceDeps } from '../core/worker/workerServices';
import type { LockDeps } from './lock';
import { takePrepareLock } from './workerLock';

/** How often a running prepare looks for the stop request of a Delete. */
export const PREPARE_STOP_POLL_MS = 1_000;

export interface RunPrepareDeps {
  /** The engine of the worker (without any secret: the prepare has none). */
  engine: DockerEngine;
  /** The worker's own helper image and socket (readOwnHelper). */
  ownHelper: OwnHelper;
  logger: Logger;
  /** The host access analysis of the worker (workerAnalyzer). */
  analyzer: ConfigurationAnalyzer;
  /** The prepare lock (LockDeps.openPrepareLockFile) and the files next to it (LockDeps.prepareFiles). */
  lockDeps: LockDeps;
  /** Opens the batch helper of the prepare on the volume of the devspace (workerBatchSession). */
  openBatch: (p: { volume: string; image: string; socket: string }) => Promise<HelperBatchSession>;
  /** The cancel of the caller. */
  signal: AbortSignal;
  /** The hard limit (default PREPARE_LIMIT_MS; for the tests). */
  limitMs?: number;
  /** For the tests (default PREPARE_STOP_POLL_MS). */
  stopPollMs?: number;
  /** The folder of the Monitor's registry answers (default LOCK_STATE_DIR; for the tests). */
  registryAnswersDir?: string;
}

/**
 * The headless prepare of the devspace `devspaceId` on the engine of the worker (DevspaceService.prepare on
 * headlessServiceDeps). A stop request of a Delete (PrepareFiles.stopRequested) that comes while it holds the prepare
 * lock is taken (removed) and stops it (`cancelled`). Never rejects; its outcome and duration are logged by the
 * pipeline.
 */
export async function runPrepare(deps: RunPrepareDeps, devspaceId: string): Promise<PrepareResult> {
  const stop = new AbortController();
  const files = deps.lockDeps.prepareFiles;
  const stateDir = deps.lockDeps.stateDir;
  let watch: ReturnType<typeof setInterval> | undefined;
  const service = new DevspaceService(
    headlessServiceDeps({
      engine: deps.engine,
      logger: deps.logger,
      ownHelper: deps.ownHelper,
      analyzer: deps.analyzer,
      ...(deps.registryAnswersDir !== undefined ? { registryAnswersDir: deps.registryAnswersDir } : {}),
    }),
  );
  try {
    return await service.prepare(devspaceId, {
      signal: AbortSignal.any([deps.signal, stop.signal]),
      ...(deps.limitMs !== undefined ? { limitMs: deps.limitMs } : {}),
      takeLock: async (id, signal) => {
        const held = await takePrepareLock(deps.lockDeps, id, signal, deps.openBatch);
        if (held !== undefined && files !== undefined) {
          watch = setInterval(() => {
            if (!files.stopRequested(stateDir, id)) return;
            clearInterval(watch);
            // Taken: a request that this prepare saw is no request to a later one.
            files.removeStop(stateDir, id);
            deps.logger.info(`A Delete asked the prepare of ${id} to stop.`);
            stop.abort();
          }, deps.stopPollMs ?? PREPARE_STOP_POLL_MS);
        }
        return held;
      },
      stoppedKey: async (id) => files?.readStopped(stateDir, id),
      recordStopped: async (id, hash) => {
        try {
          files?.writeStopped(stateDir, id, hash);
        } catch (error) {
          deps.logger.warn(`The stopped prepare of ${id} could not be recorded: ${errorMessage(error)}`);
        }
      },
    });
  } finally {
    if (watch !== undefined) clearInterval(watch);
  }
}
