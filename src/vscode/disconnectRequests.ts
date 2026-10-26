// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Disconnect requests: a window that stops, rebuilds, or deletes a devspace that another window is connected to
// asks that window to close its connection first. The connected window then hands off as for its own request (busy
// mark, pending operation, Close Remote Connection), so that VS Code asks there about unsaved files in the usual way,
// and its reloaded empty window runs the operation (role B).
//
// File: `disconnect/<devspace-id>.json` in the global storage folder, written atomically. The content has the fields
// of a pending operation (`PendingOperation`). No `vscode` import.
import * as fs from 'fs';
import { removeFile, writeJsonAtomic } from '../core/storage/atomicJson';
import { StoragePaths, errorCode, readJsonTolerant, retryTransient } from '../core/storage/paths';
import { isPendingOperation } from '../core/storage/sessionFiles';
import type { PendingOperation } from '../core/types';

/**
 * A request older than this is dropped without running: the connected window checks every 15 seconds (heartbeat) and
 * on each change of the folder, so a request that is still there after this time found no window that answers.
 */
export const DISCONNECT_REQUEST_MAX_AGE_MS = 60_000;

/** Content of `disconnect/<devspace-id>.json`: the operation that the connected window hands off. */
export type DisconnectRequest = PendingOperation;

/** True if the request is recent enough to run (a time far in the future after a clock change does not count). */
export function isFreshDisconnectRequest(request: DisconnectRequest, now: number): boolean {
  const requestedAt = Date.parse(request.requestedAt);
  return Number.isFinite(requestedAt) && Math.abs(now - requestedAt) <= DISCONNECT_REQUEST_MAX_AGE_MS;
}

export class DisconnectRequests {
  readonly dir: string;
  /** The paths of the storage layout (paths.ts), not built a second time here. */
  private readonly paths: StoragePaths;

  /** @param root The global storage folder (`StoragePaths.root`). */
  constructor(root: string) {
    this.paths = new StoragePaths(root);
    this.dir = this.paths.disconnectDir;
  }

  async write(request: DisconnectRequest): Promise<void> {
    const file = this.file(request.devspaceId);
    await retryTransient(() => writeJsonAtomic(file, request));
  }

  /** The request for the devspace, or `undefined` when there is none (or the file is invalid). */
  async read(devspaceId: string): Promise<DisconnectRequest | undefined> {
    const value = await readJsonTolerant(this.file(devspaceId));
    return isPendingOperation(value) && value.devspaceId === devspaceId ? value : undefined;
  }

  /**
   * Removes the request and returns true, if this call removed it. False when it was gone already: another window (or
   * another check of this window) took it first.
   */
  async take(devspaceId: string): Promise<boolean> {
    const file = this.file(devspaceId);
    try {
      await retryTransient(() => fs.promises.unlink(file));
      return true;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false;
      throw error;
    }
  }

  /** Removes the request. A missing request is not an error. */
  async remove(devspaceId: string): Promise<void> {
    const file = this.file(devspaceId);
    await retryTransient(() => removeFile(file));
  }

  /**
   * Calls `onChange` when a file in the folder changes, so the connected window answers within moments instead of at its
   * next heartbeat. Returns `undefined` when the folder cannot be watched; the heartbeat still checks then.
   */
  watch(onChange: () => void, onError: (error: unknown) => void): { dispose(): void } | undefined {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const watcher = fs.watch(this.dir, () => onChange());
      watcher.on('error', onError);
      return { dispose: () => watcher.close() };
    } catch (error) {
      onError(error);
      return undefined;
    }
  }

  /** `disconnect/<devspace-id>.json`; throws for an invalid ID (StoragePaths.disconnectFile). */
  private file(devspaceId: string): string {
    return this.paths.disconnectFile(devspaceId);
  }
}
