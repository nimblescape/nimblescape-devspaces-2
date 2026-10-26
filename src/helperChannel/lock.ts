// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The lock of one devspace on the Docker host, as the worker takes it (takeDevspaceLock; for every flow that
// changes a devspace, workerLock.ts). The worker opens the lock file (never through a symbolic link) and keeps it
// open; `flock` takes the kernel lock on that open file, which it inherits as its file descriptor 3, and exits; the
// lock then stays with the file of the worker until it is let go (the file is closed) or the worker ends (the kernel
// frees it). A lock is never taken over or forced, and the lock files are never deleted. The open of the lock file and
// the start of `flock` are in src/core/helperChannel/lockFile.ts, which the Monitor container uses for its
// stops too. No lock is held for the extension.
import * as fs from 'fs';
import { LOCK_BUSY_CODE, LOCK_STATE_DIR } from '../core/helperChannel/protocol';
import { acquireFlock, flockFailure, openLockFile, openPrepareLockFile, startFlockProcess, type FlockProcess } from '../core/helperChannel/lockFile';
import { OperationError } from './server';
import { PREPARE_FILES, type PrepareFiles } from './prepareFiles';

export interface LockDeps {
  /** The mount point of the volume of the Monitor. */
  stateDir: string;
  /** Opens (creates) the lock file; returns its file descriptor. Throws when it is not a plain file of its own. */
  openLockFile(stateDir: string, devspaceId: string): number;
  /**
   * Opens (creates) the prepare lock file of the devspace (as openLockFile). Without it, no prepare holds a lock
   * that an open would see (workerPrepareLock).
   */
  openPrepareLockFile?(stateDir: string, devspaceId: string): number;
  /**
   * The files of a prepare next to its lock (the stop request of a Delete, the hash that the time limit stopped).
   * Without them, a Delete asks no prepare to stop (it only waits) and no stopped prepare is remembered.
   */
  prepareFiles?: PrepareFiles;
  closeFile(fd: number): void;
  /** Starts `flock <args>` with `fd` as its file descriptor FLOCK_FD. */
  startFlock(args: readonly string[], fd: number): FlockProcess;
}

export const LOCK_DEPS: LockDeps = {
  stateDir: LOCK_STATE_DIR,
  openLockFile,
  openPrepareLockFile,
  prepareFiles: PREPARE_FILES,
  closeFile: (fd) => fs.closeSync(fd),
  startFlock: startFlockProcess,
};

/**
 * Takes the lock of `devspaceId` within the operation of `signal` (the open of the lock file, then `flock` with
 * `waitSeconds`), and resolves with the function that lets it go. Throws an OperationError: `busy` (LOCK_BUSY_CODE)
 * when another holder kept it for the whole wait, `cancelled`, or `failed`. The one way the worker takes a lock: for
 * every flow that changes a devspace.
 */
export async function takeDevspaceLock(deps: LockDeps, devspaceId: string, waitSeconds: number, signal: AbortSignal): Promise<() => void> {
  // The acquisition of lockFile.ts; the outcomes keep their errors.
  const attempt = await acquireFlock({
    open: () => deps.openLockFile(deps.stateDir, devspaceId),
    close: (fd) => deps.closeFile(fd),
    start: (args, fd) => deps.startFlock(args, fd),
    waitSeconds,
    signal,
  });
  switch (attempt.kind) {
    case 'locked':
      return attempt.release;
    case 'openFailed':
      throw new OperationError('failed', `The lock file could not be opened: ${(attempt.error as Error).message}`);
    case 'cancelled':
      throw new OperationError('cancelled', 'The lock operation was cancelled.');
    case 'startThrew':
      throw new OperationError('failed', `flock could not be started: ${(attempt.error as Error).message}`);
    case 'startFailed':
      throw new OperationError('failed', `flock could not be started: ${attempt.detail}`);
    case 'busy':
      throw new OperationError(LOCK_BUSY_CODE, `The lock stayed held by another holder for ${waitSeconds} s.`);
    case 'failed':
      throw new OperationError('failed', flockFailure(attempt, true));
    case 'timeout':
      // Never: no time limit is given.
      throw new OperationError('failed', 'flock did not end in time.');
  }
}
