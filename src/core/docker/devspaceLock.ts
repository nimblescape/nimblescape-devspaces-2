// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The lock of a devspace on the Docker host (taken in the worker, src/helperChannel/workerLock.ts) and the scope of
// an operation that holds it: the pipeline of the worker knows the devspaces whose lock it holds
// (holdsDevspaceLock) and runs its volume steps in the batch helper of the lock (src/core/helper/batchScope.ts). No
// Docker call goes through the lock. The scope is re-entrant: an operation that holds the lock of a devspace does
// not take it again. No `vscode`.
import { AsyncLocalStorage } from 'async_hooks';
import type { HelperBatchSession } from '../helperChannel/helperChannel';

/** A held lock of a devspace (the worker's own, workerDevspaceLock of src/helperChannel/workerLock.ts). */
export interface HeldDevspaceLock {
  readonly devspaceId: string;
  /**
   * Resolves with the reason when the lock was lost without `release`: the worker was lost or closed, or the lock
   * operation ended by itself (its backstop). Never rejects.
   */
  readonly lost: Promise<string>;
  /**
   * A batch helper of the operation in the worker that holds the lock (workerBatchSession). The open pipeline runs its
   * volume steps in it (src/core/helper/batchScope.ts).
   */
  batch?(p: { volume: string; image: string; socket: string }, signal?: AbortSignal): Promise<HelperBatchSession>;
  /** Lets go of the lock and resolves when the worker confirmed it, or the worker was lost (the kernel frees it). Never rejects. */
  release(): Promise<void>;
}

/**
 * The lock could not be taken. `busy`: another window or computer holds it (after the wait).
 * `unavailable`: no worker (it could not be opened, it reaches another engine, it does not know the lock), or the lock
 * failed in the worker (the state is not consistent; the operation is refused).
 */
export class DevspaceLockError extends Error {
  constructor(
    readonly kind: 'busy' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'DevspaceLockError';
  }
}

interface LockScope {
  readonly devspaceIds: ReadonlySet<string>;
  active: boolean;
}

const lockScopes = new AsyncLocalStorage<LockScope>();

/** The scope of the held lock of the running operation, if any (an ended scope counts as none). */
function currentScope(): LockScope | undefined {
  const scope = lockScopes.getStore();
  return scope?.active ? scope : undefined;
}

/** True while the running operation holds the lock of `devspaceId`. */
export function holdsDevspaceLock(devspaceId: string): boolean {
  return currentScope()?.devspaceIds.has(devspaceId) === true;
}

/** Runs `fn` in the scope of the held `lock` (see the module comment). The caller releases the lock after it. */
export async function runWithDevspaceLock<T>(lock: HeldDevspaceLock, fn: () => Promise<T>): Promise<T> {
  const parent = currentScope();
  const scope: LockScope = {
    devspaceIds: new Set([...(parent?.devspaceIds ?? []), lock.devspaceId]),
    active: true,
  };
  try {
    return await lockScopes.run(scope, fn);
  } finally {
    scope.active = false;
  }
}
