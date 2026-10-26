// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Coordination files in the global storage folder: window status files, pending connection files, pending operations,
// and the reopen record. The window reads the settings itself. Every write is atomic. Reads skip files that are
// missing, unreadable, or invalid.
import * as fs from 'fs';
import * as path from 'path';
import { isoTime, systemClock, type Clock } from '../ports';
import type {
  PendingConnection,
  PendingOperation,
  PendingOperationKind,
  ReopenRecord,
  WindowStatus,
} from '../types';
import { listJsonFiles, removeFile, removeFileSync, writeJsonAtomic, writeJsonAtomicSync } from './atomicJson';
import {
  CLAIM_MARKER,
  errorCode,
  isStorageId,
  listNames,
  parseClaimedOperationName,
  parseJson,
  readJsonTolerant,
  readTextFile,
  retryTransient,
  retryTransientSync,
  type StoragePaths,
} from './paths';
import { isRecord } from '../valueChecks';

/** Default age after which `cleanupStaleClaims` removes a claimed operation file. */
export const DEFAULT_CLAIM_MAX_AGE_MS = 60 * 60 * 1000;

export class SessionFiles {
  constructor(
    private readonly paths: StoragePaths,
    private readonly clock: Clock = systemClock,
  ) {}

  // --- Window status files (sessions/<window-id>.json) -------------------------------------------------------------

  async writeWindowStatus(status: WindowStatus): Promise<void> {
    const file = this.paths.sessionFile(status.windowId);
    await retryTransient(() => writeJsonAtomic(file, status));
  }

  /** Synchronous write, for `deactivate()`. */
  writeWindowStatusSync(status: WindowStatus): void {
    const file = this.paths.sessionFile(status.windowId);
    retryTransientSync(() => writeJsonAtomicSync(file, status));
  }

  /** All valid window status files. Invalid files, and files whose name does not match their window ID, are skipped. */
  async readWindowStatuses(): Promise<WindowStatus[]> {
    return readAll(this.paths.sessionsDir, isWindowStatus, (status) => status.windowId);
  }

  async removeWindowStatus(windowId: string): Promise<void> {
    const file = this.paths.sessionFile(windowId);
    await retryTransient(() => removeFile(file));
  }

  // --- Pending connection files (pending/<devspace-id>.json) ----------------------------------------------------

  /** Writes the pending connection file with `createdAt` = now. */
  async writePending(devspaceId: string, windowId: string): Promise<void> {
    const pending: PendingConnection = { devspaceId, windowId, createdAt: isoTime(this.clock) };
    const file = this.paths.pendingFile(devspaceId);
    await retryTransient(() => writeJsonAtomic(file, pending));
  }

  async readPendings(): Promise<PendingConnection[]> {
    return readAll(this.paths.pendingDir, isPendingConnection, (pending) => pending.devspaceId);
  }

  async removePending(devspaceId: string): Promise<void> {
    const file = this.paths.pendingFile(devspaceId);
    await retryTransient(() => removeFile(file));
  }

  // --- Disconnect requests (disconnect/<devspace-id>.json, src/vscode/disconnectRequests.ts) ---------------------

  /**
   * Removes the disconnect request of the devspace (Delete). A missing one is not an error.
   */
  async removeDisconnectRequest(devspaceId: string): Promise<void> {
    const file = this.paths.disconnectFile(devspaceId);
    await retryTransient(() => removeFile(file));
  }

  // --- Pending operations (operations/<devspace-id>.json) -------------------------------------------------------

  async writeOperation(operation: PendingOperation): Promise<void> {
    const file = this.paths.operationFile(operation.devspaceId);
    await retryTransient(() => writeJsonAtomic(file, operation));
  }

  /** Pending operations that no window has claimed yet. */
  async readOperations(): Promise<PendingOperation[]> {
    return readAll(this.paths.operationsDir, isPendingOperation, (operation) => operation.devspaceId);
  }

  /**
   * The pending operations that could be read, and the files that could not. The files are named per devspace and a
   * value counts only for the devspace of its file name, so a file that cannot be read says nothing about the
   * others. A folder that cannot be read throws.
   */
  async readOperationsKnown(): Promise<{ operations: PendingOperation[]; unreadable: Array<{ file: string; error: unknown }> }> {
    const { values, unreadable } = await readAllKnown(this.paths.operationsDir, isPendingOperation, (operation) => operation.devspaceId);
    return { operations: values, unreadable };
  }

  /**
   * The pending operation of this devspace that no window has claimed yet, if any. Reads only this devspace's
   * file: a file of another devspace that cannot be read says nothing about it. A file that cannot be read throws.
   */
  async readOperation(devspaceId: string): Promise<PendingOperation | undefined> {
    const text = await readTextFile(this.paths.operationFile(devspaceId));
    const operation = text === undefined ? undefined : parseJson(text);
    return isPendingOperation(operation) && operation.devspaceId === devspaceId ? operation : undefined;
  }

  /**
   * Atomically claims the pending operation: renames it to `<devspace-id>.claimed.<time>.<window-id>`. A rename of one
   * source succeeds only once, also across processes, so only one window wins. Returns the operation if this window won;
   * `undefined` if another window was first or no operation exists. An invalid claimed file is removed.
   */
  async claimOperation(devspaceId: string, windowId: string): Promise<PendingOperation | undefined> {
    const source = this.paths.operationFile(devspaceId);
    const claimed = this.paths.claimedOperationFile(devspaceId, windowId, this.clock.now());
    try {
      await retryTransient(() => fs.promises.rename(source, claimed));
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw error;
    }
    // Read errors other than invalid content are thrown, and the claimed file stays: the operation is not lost silently.
    const text = await readTextFile(claimed);
    const operation = text === undefined ? undefined : parseJson(text);
    if (!isPendingOperation(operation) || operation.devspaceId !== devspaceId) {
      await retryTransient(() => removeFile(claimed)).catch(() => {});
      return undefined;
    }
    return operation;
  }

  /** Removes the operation file and the claimed files of this devspace. */
  async removeOperation(devspaceId: string): Promise<void> {
    const file = this.paths.operationFile(devspaceId);
    await retryTransient(() => removeFile(file));
    const dir = this.paths.operationsDir;
    for (const name of await listNames(dir)) {
      if (parseClaimedOperationName(name)?.devspaceId === devspaceId) {
        await retryTransient(() => removeFile(path.join(dir, name)));
      }
    }
  }

  /**
   * Removes claimed files older than `maxAgeMs` (default 1 hour). The age counts from the claim time in the file name.
   * A claimed file is only a trace of work in progress: the claiming window has the operation in memory. Best effort.
   */
  async cleanupStaleClaims(maxAgeMs: number = DEFAULT_CLAIM_MAX_AGE_MS): Promise<void> {
    const dir = this.paths.operationsDir;
    const now = this.clock.now();
    for (const name of await listNames(dir)) {
      if (!name.includes(CLAIM_MARKER)) continue;
      const file = path.join(dir, name);
      try {
        const claimedAt = parseClaimedOperationName(name)?.claimedAtMs ?? (await fs.promises.stat(file)).mtimeMs;
        // A claim time far in the future (the clock was changed) also counts as stale.
        if (Math.abs(now - claimedAt) > maxAgeMs) await retryTransient(() => removeFile(file));
      } catch {
        // Removed by another window in the meantime, or not removable now: the next cleanup tries again.
      }
    }
  }

  // --- Reopen record (reopen.json) ---------------------------------------------------------------------------------

  /** Synchronous write, for `deactivate()`. */
  writeReopenSync(record: ReopenRecord): void {
    retryTransientSync(() => writeJsonAtomicSync(this.paths.reopen, record));
  }

  async readReopen(): Promise<ReopenRecord | undefined> {
    const value = await readJsonTolerant(this.paths.reopen);
    return isReopenRecord(value) ? value : undefined;
  }

  async removeReopen(): Promise<void> {
    await retryTransient(() => removeFile(this.paths.reopen));
  }

  /** Synchronous removal, for `deactivate()` of a window that is not connected to a devspace. */
  removeReopenSync(): void {
    retryTransientSync(() => removeFileSync(this.paths.reopen));
  }

  /**
   * Removes the reopen record when it names `devspaceId` (Delete of that devspace); another one stays.
   */
  async removeReopenOf(devspaceId: string): Promise<void> {
    if ((await this.readReopen())?.devspaceId === devspaceId) await this.removeReopen();
  }
}

/** Reads all `*.json` files of a folder, in name order. Keeps a value only if it is valid and its key matches the file name. */
async function readAll<T>(dir: string, isValid: (value: unknown) => value is T, key: (value: T) => string): Promise<T[]> {
  const { values, unreadable } = await readAllKnown(dir, isValid, key);
  // A file that cannot be read is not known, never missing.
  if (unreadable.length > 0) throw unreadable[0].error;
  return values;
}

/**
 * As readAll, but a file that cannot be read (not missing, not EISDIR) is returned in `unreadable` instead of throwing.
 * A folder named *.json is no one's file and is skipped; invalid JSON stays tolerant (atomic writes).
 */
async function readAllKnown<T>(
  dir: string,
  isValid: (value: unknown) => value is T,
  key: (value: T) => string,
): Promise<{ values: T[]; unreadable: Array<{ file: string; error: unknown }> }> {
  const files = (await listJsonFiles(dir)).sort();
  const results: Array<T | undefined> = [];
  const unreadable: Array<{ file: string; error: unknown }> = [];
  await Promise.all(
    files.map(async (file, index) => {
      let text: string | undefined;
      try {
        text = await readTextFile(file);
      } catch (error) {
        if (errorCode(error) !== 'EISDIR') unreadable.push({ file, error });
        return;
      }
      const value = text === undefined ? undefined : parseJson(text);
      if (isValid(value) && `${key(value)}.json` === path.basename(file)) results[index] = value;
    }),
  );
  return { values: results.filter((value): value is T => value !== undefined), unreadable };
}

// ---------------------------------------------------------------------------------------------------------------------
// Validation of the file contents. Unknown fields are allowed.

function isTime(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function isWindowStatus(value: unknown): value is WindowStatus {
  return (
    isRecord(value) &&
    isStorageId(value.windowId) &&
    isPid(value.pid) &&
    (value.devspaceId === null || isNonEmptyString(value.devspaceId)) &&
    (value.state === 'active' || value.state === 'closing') &&
    isTime(value.updatedAt) &&
    (value.dockerContext === undefined || isNonEmptyString(value.dockerContext)) &&
    (value.plainDevspaceId === undefined || isStorageId(value.plainDevspaceId))
  );
}

export function isPendingConnection(value: unknown): value is PendingConnection {
  return (
    isRecord(value) &&
    isStorageId(value.devspaceId) &&
    isNonEmptyString(value.windowId) &&
    isTime(value.createdAt)
  );
}

// Records over the union types of types.ts, so that the compiler reports a kind or reason that is missing here.
// A missing kind would make readOperations skip, and claimOperation delete, every operation of that kind.
const OPERATION_KINDS: Record<PendingOperationKind, true> = { rebuild: true, delete: true, stop: true };
const OPERATION_REASONS: Record<PendingOperation['reason'], true> = {
  manual: true,
  update: true,
  configChanged: true,
};

function isKeyOf<K extends string>(record: Record<K, true>, value: unknown): value is K {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(record, value);
}

export function isPendingOperation(value: unknown): value is PendingOperation {
  return (
    isRecord(value) &&
    isStorageId(value.devspaceId) &&
    isKeyOf(OPERATION_KINDS, value.operation) &&
    isTime(value.requestedAt) &&
    typeof value.requestedBy === 'string' &&
    isKeyOf(OPERATION_REASONS, value.reason) &&
    (value.additionalVolumesToRemove === undefined ||
      (Array.isArray(value.additionalVolumesToRemove) && value.additionalVolumesToRemove.every(isNonEmptyString)))
  );
}

export function isReopenRecord(value: unknown): value is ReopenRecord {
  return isRecord(value) && isNonEmptyString(value.devspaceId) && isTime(value.closedAt);
}

