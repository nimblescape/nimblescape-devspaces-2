// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The lock folder of a file in the global storage folder that several VS Code windows change: registry.json
// (registry.lock) and docker-engines.json (docker-engines.lock). A read-modify-write runs while its window holds the
// folder; a read needs no lock, because every write is atomic (temporary file, then rename). No `vscode`.
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { sleep } from '../ports';
import { errorCode, isTransientFsError, readTextFile, retryTransient } from './paths';

/** A lock folder older than 10 seconds counts as stale. */
export const DEFAULT_LOCK_STALE_MS = 10_000;
/** The longest wait for a lock: 15 seconds. */
export const DEFAULT_LOCK_TIMEOUT_MS = 15_000;
// A mkdir every 20 ms costs little, and a waiting window or the Monitor gets the lock soon.
const LOCK_RETRY_MS = 20;
// On Windows, a lock folder that its last holder is still removing cannot be created again for a moment (EPERM). On
// macOS and Linux these errors are permanent, so they are thrown after about one second instead of a lock timeout.
const MAX_TRANSIENT_LOCK_ERRORS = 50;
// The file in the lock folder that holds the token of its holder (see withLockFolder).
const LOCK_OWNER_FILE = 'owner';

export interface LockTimings {
  /** A lock folder older than this counts as stale (its holder crashed). */
  staleMs: number;
  /** Maximum wait for the lock. */
  timeoutMs: number;
}

/** Thrown before a write when another process took over the lock folder meanwhile (see `withLockFolder`). */
export class LockLostError extends Error {
  constructor(lockDir: string) {
    super(`Another process took over the lock ${lockDir} while this process held it. Nothing was written.`);
    this.name = 'LockLostError';
  }
}

/**
 * Runs `fn` while holding the lock folder `lockDir` (created with mkdir, removed after `fn`, stale when older than
 * `staleMs`). Beyond a plain mkdir lock:
 * - two waiters that both see a stale folder must not both get the lock. With a plain "remove, then mkdir", the slower
 *   one removes the fresh lock of the faster one, and one of the two changes is lost;
 * - the holder refreshes the folder time while `fn` runs, so a slow `fn` is not taken for stale;
 * - the holder writes a random token into the folder. When its event loop stalls longer than `staleMs` (a blocked
 *   process, a computer that slept), another process takes the folder over as stale. `fn` gets `held`, which is true
 *   while the folder still has the own token, and checks it before its write. Only a missing token file or another
 *   token is a lost lock; another error of the read (after the retries of transient errors, for example EBUSY on
 *   Windows while a virus scanner reads the file) is thrown. The folder is removed only while it has the own token, so
 *   the lock of the other process stays; a folder whose token cannot be read is left until it is stale;
 * - transient errors of Windows are tried again instead of failing the change.
 */
export async function withLockFolder<T>(lockDir: string, fn: (held: () => Promise<boolean>) => Promise<T>, timings: LockTimings): Promise<T> {
  const token = await acquireLockFolder(lockDir, timings);
  // readTextFile: undefined for a missing file (ENOENT), transient errors tried again, any other error thrown.
  const held = async () => (await readTextFile(path.join(lockDir, LOCK_OWNER_FILE))) === token;
  const heartbeat = setInterval(() => {
    const now = new Date();
    fs.promises.utimes(lockDir, now, now).catch(() => {});
  }, Math.max(10, Math.floor(timings.staleMs / 4)));
  heartbeat.unref();
  try {
    return await fn(held);
  } finally {
    clearInterval(heartbeat);
    if (await held().catch(() => false)) await removeFolder(lockDir);
  }
}

/** Creates the lock folder and writes a new token into it. Returns the token. */
async function acquireLockFolder(lockDir: string, { staleMs, timeoutMs }: LockTimings): Promise<string> {
  const start = Date.now();
  const token = randomUUID();
  await retryTransient(() => fs.promises.mkdir(path.dirname(lockDir), { recursive: true }));
  let transientErrors = 0;
  for (;;) {
    try {
      await fs.promises.mkdir(lockDir);
      if (await writeLockToken(lockDir, token)) return token;
    } catch (error) {
      if (errorCode(error) === 'EEXIST') {
        if (await removeStaleLockFolder(lockDir, staleMs)) continue;
      } else if (!isTransientFsError(error) || ++transientErrors > MAX_TRANSIENT_LOCK_ERRORS) {
        throw error;
      }
    }
    if (Date.now() - start > timeoutMs) throw new Error(`Timeout while waiting for the lock ${lockDir}.`);
    await sleep(LOCK_RETRY_MS);
  }
}

/**
 * Writes `token` into the lock folder that the caller just created. False if another process took the folder over
 * first (it removed the folder as stale, or wrote its own token): the caller waits as for any held lock.
 */
async function writeLockToken(lockDir: string, token: string): Promise<boolean> {
  try {
    await retryTransient(() => fs.promises.writeFile(path.join(lockDir, LOCK_OWNER_FILE), token, { flag: 'wx' }));
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === 'EEXIST' || code === 'ENOENT') return false;
    // A folder without a token blocks every other process until it is stale.
    await removeFolder(lockDir);
    throw error;
  }
}

/**
 * Removes `lockDir` if it is stale (its holder crashed). Returns true if the folder is gone, so that the caller tries
 * mkdir again at once. Only one waiter at a time removes a stale folder: it holds the guard folder `<lockDir>.takeover`
 * and checks the age again, because another waiter may have replaced the stale folder with its own fresh lock meanwhile.
 */
async function removeStaleLockFolder(lockDir: string, staleMs: number): Promise<boolean> {
  const age = await folderAge(lockDir);
  if (age === undefined) return true;
  if (age <= staleMs) return false;
  const guard = `${lockDir}.takeover`;
  try {
    await fs.promises.mkdir(guard);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      // Another waiter removes the stale lock right now. Its guard is stale only if it crashed while doing so.
      const guardAge = await folderAge(guard);
      if (guardAge !== undefined && guardAge > staleMs) await removeFolder(guard);
      return false;
    }
    if (isTransientFsError(error)) return false;
    throw error;
  }
  try {
    const current = await folderAge(lockDir);
    if (current === undefined) return true;
    if (current <= staleMs) return false;
    await removeFolder(lockDir);
    return true;
  } finally {
    await removeFolder(guard);
  }
}

/** Milliseconds since the last change of a folder, or `undefined` if it does not exist. */
async function folderAge(dir: string): Promise<number | undefined> {
  try {
    return Date.now() - (await fs.promises.stat(dir)).mtimeMs;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    // Windows: a folder that another process is removing cannot be opened for a moment. It is not stale.
    if (isTransientFsError(error)) return 0;
    throw error;
  }
}

async function removeFolder(dir: string): Promise<void> {
  await retryTransient(() => fs.promises.rm(dir, { recursive: true, force: true })).catch(() => {});
}
