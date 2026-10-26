// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The lock of a devspace as the worker's own pipeline holds it (DevspaceServiceDeps.devspaceLock): the worker
// acts for the extension, so the lock is taken here, the one way (takeDevspaceLock), with the batch helper of the
// flow started here too (workerBatchSession). Nothing goes through the extension, and no Docker call goes through the
// lock (HeldDevspaceLock has none; the pipeline of the worker uses the engine of the worker).
import { DevspaceLockError, type HeldDevspaceLock } from '../core/docker/devspaceLock';
import { LOCK_BUSY_CODE } from '../core/helperChannel/protocol';
import { abortError } from '../core/ports';
import type { HelperBatchSession } from '../core/helperChannel/helperChannel';
import { acquireFlock, flockFailure } from '../core/helperChannel/lockFile';
import type { PrepareLock } from '../core/pipeline/devspacePorts';
import { takeDevspaceLock, type LockDeps } from './lock';
import { OperationError, type OperationContext } from './server';

/**
 * The PrepareLock of the worker's own pipeline within the operation of `context`, over the prepare lock file
 * (LockDeps.openPrepareLockFile; without it, the lock is always free). A probe or a wait that gets the lock lets it go
 * at once: the open never holds it. A lock that cannot be asked (its file, flock) counts as free, so the open builds as
 * without a prepare; a cancel is an AbortError. The probe can make a prepare that starts at the same moment find its
 * lock taken; that prepare tries again at a later pass of the Monitor.
 */
export function workerPrepareLock(lockDeps: LockDeps, context: OperationContext): PrepareLock {
  const free = async (devspaceId: string, waitSeconds: number | undefined, signal: AbortSignal | undefined): Promise<boolean> => {
    const open = lockDeps.openPrepareLockFile;
    if (open === undefined) return true;
    const attempt = await acquireFlock({
      open: () => open(lockDeps.stateDir, devspaceId),
      close: (fd) => lockDeps.closeFile(fd),
      start: (args, fd) => lockDeps.startFlock(args, fd),
      ...(waitSeconds !== undefined ? { waitSeconds } : {}),
      signal: signal ? AbortSignal.any([context.signal, signal]) : context.signal,
    });
    if (attempt.kind === 'cancelled') throw abortError();
    if (attempt.kind === 'locked') attempt.release();
    return attempt.kind !== 'busy';
  };
  return {
    held: async (devspaceId, signal) => !(await free(devspaceId, undefined, signal)),
    waitFree: (devspaceId, waitSeconds, signal) => free(devspaceId, waitSeconds, signal),
    // The stop request of a Delete (PrepareFiles), then the wait for the lock. The request goes again once the lock got
    // free (or the wait was cancelled); a prepare that saw it took it already.
    // A prepare that did not stop in time keeps it, so that it still stops (and lets the volume go) as soon as it looks.
    stop: async (devspaceId, waitSeconds, signal) => {
      const files = lockDeps.prepareFiles;
      if (files !== undefined) {
        try {
          files.requestStop(lockDeps.stateDir, devspaceId);
        } catch (error) {
          context.log(`The prepare of ${devspaceId} could not be asked to stop: ${error instanceof Error ? error.message : String(error)}`, 'warn');
        }
      }
      let running = false;
      try {
        running = !(await free(devspaceId, waitSeconds, signal));
        return !running;
      } finally {
        if (!running) files?.removeStop(lockDeps.stateDir, devspaceId);
      }
    },
  };
}

/**
 * The prepare lock of `devspaceId` for a prepare (PrepareRun.takeLock), taken without a wait: the held lock, whose
 * `batch` opens the batch helper of the prepare (`openBatch`) and whose `lost` resolves when `signal` aborts (the time
 * limit, a stop request, a cancel: the batch scope then ends its session, and with it the build); `undefined` when
 * another holder has it (a prepare, or the probe of an open). A cancel before the lock is an AbortError; a lock that
 * cannot be asked rejects with its cause.
 */
export async function takePrepareLock(
  lockDeps: LockDeps,
  devspaceId: string,
  signal: AbortSignal,
  openBatch: (p: { volume: string; image: string; socket: string }) => Promise<HelperBatchSession>,
): Promise<HeldDevspaceLock | undefined> {
  const open = lockDeps.openPrepareLockFile;
  if (open === undefined) throw new Error('The worker has no prepare lock.');
  const attempt = await acquireFlock({
    open: () => open(lockDeps.stateDir, devspaceId),
    close: (fd) => lockDeps.closeFile(fd),
    start: (args, fd) => lockDeps.startFlock(args, fd),
    signal,
  });
  switch (attempt.kind) {
    case 'locked':
      break;
    case 'busy':
      return undefined;
    case 'cancelled':
      throw abortError();
    case 'openFailed':
    case 'startThrew':
      throw new Error(`The prepare lock could not be taken: ${attempt.error instanceof Error ? attempt.error.message : String(attempt.error)}`);
    case 'startFailed':
      throw new Error(`The prepare lock could not be taken: flock could not be started: ${attempt.detail}`);
    case 'failed':
      throw new Error(`The prepare lock could not be taken: ${flockFailure(attempt, true)}`);
    case 'timeout':
      // Never: no time limit is given.
      throw new Error('The prepare lock could not be taken: flock did not end in time.');
  }
  let released = false;
  const lost = new Promise<string>((resolve) => {
    const ended = () => {
      if (!released) resolve('the prepare was stopped');
    };
    if (signal.aborted) ended();
    else signal.addEventListener('abort', ended, { once: true });
  });
  return {
    devspaceId,
    lost,
    batch: (p) => openBatch(p),
    release: async () => {
      if (released) return;
      released = true;
      attempt.release();
    },
  };
}

/** The devspaceLock of the worker's own pipeline within the operation of `context`. */
export function workerDevspaceLock(
  lockDeps: LockDeps,
  /** Opens a batch session of the flow (workerBatchSession of batch.ts). */
  openBatch: (p: { volume: string; image: string; socket: string }) => Promise<HelperBatchSession>,
  context: OperationContext,
): (devspaceId: string, waitSeconds: number, signal: AbortSignal | undefined) => Promise<HeldDevspaceLock> {
  return async (devspaceId, waitSeconds, signal) => {
    let release: () => void;
    try {
      release = await takeDevspaceLock(lockDeps, devspaceId, waitSeconds, signal ? AbortSignal.any([context.signal, signal]) : context.signal);
    } catch (error) {
      // As the pipeline expects them: a cancel is an AbortError, a holder elsewhere `busy`, anything else `unavailable`
      // (nothing has changed).
      if (error instanceof OperationError && error.code === 'cancelled') throw abortError();
      if (error instanceof OperationError && error.code === LOCK_BUSY_CODE) throw new DevspaceLockError('busy', error.message);
      throw new DevspaceLockError('unavailable', error instanceof Error ? error.message : String(error));
    }
    let released = false;
    // The kernel lock lives with the open file of this worker until `release`, or until the worker exits (the end of
    // the operation alone does not let it go). The pipeline releases it in `finally`, after its batch helper was
    // closed, also after a cancel (withDevspaceLock); a cancel only marks the lock as lost, so that the batch scope
    // ends its session first.
    const lost = new Promise<string>((resolve) => {
      const ended = () => {
        if (!released) resolve('the operation of the worker ended');
      };
      if (context.signal.aborted) ended();
      else context.signal.addEventListener('abort', ended, { once: true });
    });
    return {
      devspaceId,
      lost,
      // The open ends with the operation (its signal and time limit), not with a signal of its own; the listing has
      // none narrower.
      batch: (p) => openBatch(p),
      release: async () => {
        // Once: a second close could close a file descriptor that the process has reused since.
        if (released) return;
        released = true;
        release();
      },
    };
  };
}
