// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Session Coordinator: the window side of the stop-on-close mechanism. It writes the window status file at activation
// and every 15 seconds (and then drives the window's heartbeats to the Monitor container of each engine),
// removes the pending connection file of the connected devspace, and writes `closing` in deactivate(). There it also
// writes the reopen record of the connected devspace, or removes the record when the window has no devspace.
//
// The Monitor runs only as a container on each engine; there is no local Monitor process. The window
// also does:
//   - when the window leaves its devspace (setDevspace to another one or none, a second start) and when it closes
//     (deactivate), the short release of the devspace it leaves (src/core/session/windowRelease.ts, which records
//     the Git state first), bounded; deactivate() waits for it, within CLOSE_RELEASE_BOUNDS, after the synchronous
//     `closing` write; nothing while another window of this computer uses it (otherWindowUses);
//   - the first heartbeat of a devspace right after its first status write (at start, and when the window changes
//     to another devspace), not after the first interval;
//   - at activation and every hour, the sweep of the storage folder (sweepStorage) and the removal of the status files of
//     other windows whose process ended (cleanUpStorage).
//
// It needs only types from `vscode` (the event is a small own emitter), so it runs in unit tests without VS Code.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import { HEARTBEAT_MAX_AGE_MS, PENDING_MAX_AGE_MS, WINDOW_STATUS_SLACK_MS } from '../core/busy';
import { errorMessage } from '../core/errors';
import { isoTime, systemClock, type Clock, type Logger } from '../core/ports';
import { isProcessAlive } from '../core/session/sessionRules';
import { CLOSE_RELEASE_BOUNDS, SWITCH_RELEASE_BOUNDS, otherWindowHoldsDevspace, type ReleaseBounds } from '../core/session/windowRelease';
import { atomicTemporaryPath } from '../core/storage/atomicJson';
import { retryTransient, retryTransientSync, type StoragePaths } from '../core/storage/paths';
import type { SessionFiles } from '../core/storage/sessionFiles';
import { STORAGE_SWEEP_INTERVAL_MS, sweepStorage } from '../core/storage/storageSweep';
import type { Devspace, ExtensionSettings, PendingConnection, WindowStatus } from '../core/types';

/** Interval of the window status file updates. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

export interface SessionCoordinatorDeps {
  paths: StoragePaths;
  sessionFiles: SessionFiles;
  logger: Logger;
  settings: () => ExtensionSettings;
  /** The Docker context in the authority of this window (ConnectionAdapter.currentDockerContext), for its status file. */
  windowDockerContext?: () => string | undefined;
  clock?: Clock;
  // For tests:
  /** Default: `crypto.randomUUID()`. */
  windowId?: string;
  /** Process ID of this extension host. Default: `process.pid`. */
  pid?: number;
  /** Default: `isProcessAlive`. */
  isAlive?: (pid: number) => boolean;
  /** Default: HEARTBEAT_INTERVAL_MS. */
  heartbeatMs?: number;
  /** The interval of cleanUpStorage after the one at activation. Default: STORAGE_SWEEP_INTERVAL_MS. */
  cleanupMs?: number;
  /**
   * The heartbeats of this window to the Monitor container of each engine
   * (src/core/session/windowHeartbeats.ts), driven by this tick after each status write. Not awaited (a heartbeat over
   * SSH, or the repair of a missing monitor, must not hold the status file back); it skips a tick while one runs.
   */
  windowHeartbeats?: { tick(): Promise<void> };
  /**
   * The release of a devspace this window leaves (releaseDevspace of src/core/session/windowRelease.ts, the
   * recorded state of its repository first, then the short release), within `bounds`. Without it: no release (the long
   * limit of the heartbeats applies).
   */
  release?: (devspaceId: string, bounds: ReleaseBounds) => Promise<unknown>;
  /**
   * Records that this window was seen using its devspace at `at` (an ISO time; DevspaceRegistry.markSeenInUse),
   * for Delete's note: on start() when the window is connected (a reload, also a start that is no open). Not awaited; a
   * failure is logged.
   */
  markSeenInUse?: (devspaceId: string, at: string) => Promise<unknown>;
}

/** Minimal `vscode.EventEmitter` replacement, so that this module has no runtime dependency on `vscode`. */
class Emitter<T> {
  private readonly listeners = new Set<(event: T) => void>();

  constructor(private readonly logger: Logger) {}

  readonly event: vscode.Event<T> = (listener, thisArgs?, disposables?) => {
    const entry = (event: T): void => {
      listener.call(thisArgs, event);
    };
    this.listeners.add(entry);
    const disposable: vscode.Disposable = { dispose: () => this.listeners.delete(entry) };
    disposables?.push(disposable);
    return disposable;
  };

  fire(event: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.logger.error('A listener of the window heartbeat failed.', error);
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

/** `promise`, but resolved after `ms` at the latest. */
function settledWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([promise.then(() => undefined, () => undefined), deadline]).finally(() => clearTimeout(timer));
}

export class SessionCoordinator implements vscode.Disposable {
  /** Random ID of this window, new at each activation (a window reload creates a new ID). */
  readonly windowId: string;
  /** Fired after each periodic status file update (every 15 seconds). */
  readonly onDidHeartbeat: vscode.Event<void>;

  private readonly paths: StoragePaths;
  private readonly sessionFiles: SessionFiles;
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly pid: number;
  private readonly isAlive: (pid: number) => boolean;
  private readonly heartbeatMs: number;
  private readonly cleanupMs: number;
  private readonly heartbeatEmitter: Emitter<void>;

  private currentDevspaceId: string | null = null;
  /** The devspace of this window while it works without Devspaces (WindowStatus.plainDevspaceId); never a heartbeat. */
  private plainDevspaceId: string | null = null;
  private timer: NodeJS.Timeout | undefined;
  private cleanupTimer: NodeJS.Timeout | undefined;
  private cleanupRunning = false;
  private started = false;
  private heartbeatRunning = false;
  /** Set by deactivateSync() and dispose(): no further asynchronous status writes. */
  private stopped = false;
  private deactivated = false;
  /** Incremented by each status write. Only the newest write may replace the file. */
  private writeGeneration = 0;
  /** The releases of a switch that still run (deactivate waits for them within its bound). */
  private readonly releases = new Set<Promise<void>>();

  constructor(private readonly deps: SessionCoordinatorDeps) {
    this.paths = deps.paths;
    this.sessionFiles = deps.sessionFiles;
    this.logger = deps.logger;
    this.clock = deps.clock ?? systemClock;
    this.windowId = deps.windowId ?? crypto.randomUUID();
    this.pid = deps.pid ?? process.pid;
    this.isAlive = deps.isAlive ?? isProcessAlive;
    this.heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
    this.cleanupMs = deps.cleanupMs ?? STORAGE_SWEEP_INTERVAL_MS;
    this.heartbeatEmitter = new Emitter<void>(deps.logger);
    this.onDidHeartbeat = this.heartbeatEmitter.event;
  }

  /** Devspace that this window is connected to, `null` for a window without a devspace. */
  get devspaceId(): string | null {
    return this.currentDevspaceId;
  }

  /**
   * Writes the status file (`active`) at once and then every 15 seconds; each write removes the pending connection file
   * of the devspace (the window that connects deletes this file when it writes its status file). Then cleans up the
   * storage folder (cleanUpStorage), and again every hour. A second call works like `setDevspace`. Never throws:
   * errors are logged, and the next update tries again.
   *
   * Resolves with the pending connection file of the devspace that existed before this call removed it, if it is
   * younger than PENDING_MAX_AGE_MS: the open pipeline has just run for this window (it was opened by our own
   * `vscode.openFolder`). The file itself is gone afterwards, so a caller that needs this must use the result.
   */
  async start(devspaceId: string | null): Promise<PendingConnection | undefined> {
    if (this.stopped) return undefined;
    if (this.started) {
      const previous = this.currentDevspaceId;
      this.currentDevspaceId = devspaceId;
      const pending = await this.freshPending(devspaceId);
      await this.writeStatus();
      this.tickNow(previous, devspaceId);
      this.markSeen(devspaceId);
      this.releaseLeft(previous, devspaceId);
      return pending;
    }
    this.currentDevspaceId = devspaceId;
    this.started = true;
    try {
      await this.paths.ensureDirectories();
    } catch (error) {
      this.logger.warn(`The storage folder could not be created. ${errorMessage(error)}`);
    }
    // Read before the first status write, which removes the file.
    const pending = await this.freshPending(devspaceId);
    if (this.stopped) return undefined;
    this.timer = setInterval(() => this.heartbeat(), this.heartbeatMs);
    this.timer.unref?.();
    this.cleanupTimer = setInterval(() => void this.cleanUpStorage(), this.cleanupMs);
    this.cleanupTimer.unref?.();
    await this.writeStatus();
    // The first heartbeat at once, not after the first interval: a reload of this window follows the short release of
    // its previous activation, which must not run out before this window's long heartbeat reaches the monitor. Not
    // awaited; never throws.
    if (!this.stopped && devspaceId !== null) void this.deps.windowHeartbeats?.tick();
    this.markSeen(devspaceId);
    await this.cleanUpStorage();
    return pending;
  }

  /**
   * Changes the devspace of this window and writes the status file at once. The devspace that the window leaves
   * gets its release (not awaited here; deactivate waits for it within its bound).
   */
  async setDevspace(devspaceId: string | null): Promise<void> {
    if (this.stopped) return;
    const previous = this.currentDevspaceId;
    this.currentDevspaceId = devspaceId;
    if (!this.started) return;
    await this.writeStatus();
    this.tickNow(previous, devspaceId);
    this.releaseLeft(previous, devspaceId);
  }

  /**
   * The devspace that this window is attached to while it works without Devspaces on an engine with the removal mark
   * (Controller.workWithoutDevspaces), or null when it leaves it: only the field plainDevspaceId of the status file,
   * written at once, so that the removal and the operations of other windows see the window. The devspace of the
   * window (`devspaceId`) stays null: no heartbeat, no release and no reopen record go to it.
   */
  async setPlainDevspace(devspaceId: string | null): Promise<void> {
    if (this.stopped) return;
    this.plainDevspaceId = devspaceId;
    if (!this.started) return;
    await this.writeStatus();
  }

  /**
   * The window that starts connected to `devspaceId` was seen using it now (markSeenInUse). Not awaited; never
   * throws.
   */
  private markSeen(devspaceId: string | null): void {
    const mark = this.deps.markSeenInUse;
    if (this.stopped || devspaceId === null || mark === undefined) return;
    const at = new Date(this.clock.now()).toISOString();
    void Promise.resolve()
      .then(() => mark(devspaceId, at))
      .catch((error: unknown) => this.logger.info(`The last use of the devspace could not be recorded: ${errorMessage(error)}`));
  }

  /**
   * After a change to another devspace, its first heartbeat at once (it may have been released a moment ago, by this
   * window or by a reload of it). Not awaited; never throws.
   */
  private tickNow(previous: string | null, next: string | null): void {
    if (this.stopped || next === null || next === previous) return;
    void this.deps.windowHeartbeats?.tick();
  }

  /**
   * Writes the pending connection file of a devspace, so that another window does not take the devspace for
   * unused while this window connects. Throws if the file cannot be written: the caller relies on the protection.
   */
  async writePending(devspaceId: string): Promise<void> {
    await this.sessionFiles.writePending(devspaceId, this.windowId);
  }

  /** Status files of OTHER windows whose process exists, whose state is `active`, and that were updated ≤ 60 s ago. */
  async otherActiveWindows(): Promise<WindowStatus[]> {
    const now = this.clock.now();
    const statuses = await this.sessionFiles.readWindowStatuses();
    return statuses.filter((status) => {
      if (status.windowId === this.windowId || status.state !== 'active') return false;
      const updatedAt = Date.parse(status.updatedAt);
      if (!Number.isFinite(updatedAt) || Math.abs(now - updatedAt) > HEARTBEAT_MAX_AGE_MS) return false;
      return this.isAlive(status.pid);
    });
  }

  /**
   * Whether another window of this computer uses `devspace`, so this window must not release it
   * (otherWindowHoldsDevspace: a status file, a fresh pending connection file, or a live busy mark of another
   * window). True when the files cannot be read (not known: nothing is released, the long limit stays). Never throws.
   */
  async otherWindowUses(devspace: Devspace): Promise<boolean> {
    try {
      const [windowStatuses, pendings] = await Promise.all([this.sessionFiles.readWindowStatuses(), this.sessionFiles.readPendings()]);
      return otherWindowHoldsDevspace(devspace, this.windowId, { now: this.clock.now(), isAlive: this.isAlive, windowStatuses, pendings });
    } catch (error) {
      this.logger.warn(`It is not known whether another window uses ${devspace.repository}; it is not released. ${errorMessage(error)}`);
      return true;
    }
  }

  /**
   * The sweep of the storage folder (sweepStorage: stale pending files, disconnect requests, temporary files), and the
   * removal of the status files of other windows whose process ended and that were not updated for HEARTBEAT_MAX_AGE_MS
   * plus the waiting time (a window that just closed keeps its `closing` file that long). At activation and every hour;
   * one at a time. Never throws.
   */
  async cleanUpStorage(): Promise<void> {
    if (this.cleanupRunning) return;
    this.cleanupRunning = true;
    try {
      const now = this.clock.now();
      try {
        const removed = await sweepStorage(this.paths, now);
        const files = [...removed.pending, ...removed.disconnect, ...removed.temporary, ...removed.checks];
        if (files.length > 0) this.logger.info(`Removed outdated files from the storage folder: ${files.join(', ')}`);
      } catch (error) {
        this.logger.warn(`The storage folder could not be cleaned up. ${errorMessage(error)}`);
      }
      if (this.deactivated || this.stopped) return;
      const maxAgeMs = HEARTBEAT_MAX_AGE_MS + WINDOW_STATUS_SLACK_MS;
      let statuses: WindowStatus[] = [];
      try {
        statuses = await this.sessionFiles.readWindowStatuses();
      } catch (error) {
        this.logger.warn(`The window status files could not be read. ${errorMessage(error)}`);
      }
      for (const status of statuses) {
        // A run that was under way when the window closed removes nothing more (it reads files that the closing wrote
        // after it started).
        if (this.deactivated || this.stopped) break;
        if (status.windowId === this.windowId || this.isAlive(status.pid)) continue;
        const updatedAt = Date.parse(status.updatedAt);
        if (Number.isFinite(updatedAt) && Math.abs(now - updatedAt) <= maxAgeMs) continue;
        try {
          await this.sessionFiles.removeWindowStatus(status.windowId);
          this.logger.info(`Removed the status file of the closed window ${status.windowId}.`);
        } catch (error) {
          this.logger.warn(`The status file of the closed window ${status.windowId} could not be removed. ${errorMessage(error)}`);
        }
      }
    } finally {
      this.cleanupRunning = false;
    }
  }

  /**
   * For `deactivate()`: synchronous write of the state `closing`, and of the reopen record. A window that is connected
   * to a devspace writes the record of its devspace; any other window removes the record, so that the reopen at startup
   * opens a devspace only when the window that closed last was connected to it. This also runs at each reload of the
   * window (Reload Window, a Start or Switch in this window, Close Remote Connection); a window that closes before its
   * start() leaves the record as it is. Stops the updates first; an update that is still running cannot replace the
   * file afterwards (see `writeActiveStatus`). Never throws.
   */
  deactivateSync(): void {
    if (this.deactivated) return;
    this.deactivated = true;
    this.stopTimer();
    // A window that never started has no status file to change.
    if (!this.started) return;
    const devspaceId = this.currentDevspaceId;
    const now = isoTime(this.clock);
    try {
      this.sessionFiles.writeWindowStatusSync({
        windowId: this.windowId,
        pid: this.pid,
        devspaceId,
        state: 'closing',
        updatedAt: now,
      });
    } catch (error) {
      this.logger.error('The window status could not be set to closing.', error);
    }
    if (devspaceId !== null) {
      try {
        this.sessionFiles.writeReopenSync({ devspaceId, closedAt: now });
      } catch (error) {
        this.logger.error('The reopen record could not be written.', error);
      }
      return;
    }
    // A local window, the window of another remote, or one that works without Devspaces (plainDevspaceId): the record
    // of a window that closed before it goes.
    try {
      this.sessionFiles.removeReopenSync();
    } catch (error) {
      this.logger.error('The reopen record could not be removed.', error);
    }
  }

  /**
   * `deactivate()` of the extension. First deactivateSync() (synchronously, before any await), then the release of the
   * connected devspace (the recorded state of its repository first) and of the releases of a switch that still run,
   * all within CLOSE_RELEASE_BOUNDS.totalMs. Never rejects. A second call releases nothing more.
   */
  deactivate(): Promise<void> {
    const first = !this.deactivated;
    this.deactivateSync();
    if (!first || !this.started) return Promise.resolve();
    const work = [...this.releases];
    const devspaceId = this.currentDevspaceId;
    if (devspaceId !== null) work.push(this.runRelease(devspaceId, CLOSE_RELEASE_BOUNDS));
    if (work.length === 0) return Promise.resolve();
    return settledWithin(Promise.all(work), CLOSE_RELEASE_BOUNDS.totalMs);
  }

  dispose(): void {
    this.stopTimer();
    this.heartbeatEmitter.dispose();
  }

  private stopTimer(): void {
    this.stopped = true;
    // A write that started before cannot replace the file anymore.
    this.writeGeneration++;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  /** The release of `previous` when the window left it for `next`. Not awaited; tracked. */
  private releaseLeft(previous: string | null, next: string | null): void {
    if (previous === null || previous === next) return;
    const running = this.runRelease(previous, SWITCH_RELEASE_BOUNDS);
    this.releases.add(running);
    void running.finally(() => this.releases.delete(running));
  }

  /** The release of `devspaceId` within `bounds`. Never rejects. */
  private runRelease(devspaceId: string, bounds: ReleaseBounds): Promise<void> {
    const release = this.deps.release;
    if (release === undefined) return Promise.resolve();
    let started: Promise<unknown>;
    try {
      started = release(devspaceId, bounds);
    } catch (error) {
      started = Promise.reject(error);
    }
    return settledWithin(
      started.catch((error: unknown) => this.logger.warn(`The release of the devspace could not be sent. ${errorMessage(error)}`)),
      bounds.totalMs,
    );
  }

  private heartbeat(): void {
    // A slow file system must not pile up writes.
    if (this.stopped || this.heartbeatRunning) return;
    this.heartbeatRunning = true;
    (async () => {
      try {
        await this.writeStatus();
        if (!this.stopped) {
          // Never throws; not awaited.
          void this.deps.windowHeartbeats?.tick();
          this.heartbeatEmitter.fire();
        }
      } finally {
        this.heartbeatRunning = false;
      }
    })().catch((error: unknown) => this.logger.error('The window status update failed.', error));
  }

  /** The pending connection file of the devspace if it is not older than PENDING_MAX_AGE_MS. Never throws. */
  private async freshPending(devspaceId: string | null): Promise<PendingConnection | undefined> {
    if (devspaceId === null) return undefined;
    try {
      const pending = (await this.sessionFiles.readPendings()).find((item) => item.devspaceId === devspaceId);
      const createdAt = pending === undefined ? Number.NaN : Date.parse(pending.createdAt);
      return Number.isFinite(createdAt) && Math.abs(this.clock.now() - createdAt) <= PENDING_MAX_AGE_MS ? pending : undefined;
    } catch (error) {
      this.logger.warn(`The pending connection files could not be read. ${errorMessage(error)}`);
      return undefined;
    }
  }

  /** Writes the status file (`active`); after a successful write, removes the pending file of the devspace. */
  private async writeStatus(): Promise<void> {
    const devspaceId = this.currentDevspaceId;
    let written = false;
    try {
      written = await this.writeActiveStatus(devspaceId);
    } catch (error) {
      this.logger.warn(`The window status file could not be written. ${errorMessage(error)}`);
    }
    if (!written || devspaceId === null || this.stopped) return;
    try {
      await this.sessionFiles.removePending(devspaceId);
    } catch (error) {
      this.logger.warn(`The pending connection file could not be removed. ${errorMessage(error)}`);
    }
  }

  /**
   * Atomic write of the status file with the state `active`. The temporary file is written asynchronously, but the check
   * and the rename are synchronous: deactivateSync() runs on the same thread, so it cannot run between them. A write
   * that is overtaken by a newer write, by deactivateSync(), or by dispose() is dropped. Returns true if the file was
   * replaced.
   */
  private async writeActiveStatus(devspaceId: string | null): Promise<boolean> {
    if (this.stopped) return false;
    const generation = ++this.writeGeneration;
    const plainDevspaceId = this.plainDevspaceId;
    // Also for a window that works without Devspaces: another window that shows it opens exactly its URI.
    const dockerContext = devspaceId === null && plainDevspaceId === null ? undefined : this.deps.windowDockerContext?.();
    const status: WindowStatus = {
      windowId: this.windowId,
      pid: this.pid,
      devspaceId,
      state: 'active',
      updatedAt: isoTime(this.clock),
      ...(dockerContext ? { dockerContext } : {}),
      ...(plainDevspaceId !== null ? { plainDevspaceId } : {}),
    };
    const file = this.paths.sessionFile(this.windowId);
    // The name form of writeJsonAtomic, so that the sweep of the storage folder removes a leftover (storageSweep.ts, R8).
    const temp = atomicTemporaryPath(file);
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await retryTransient(() => fs.promises.writeFile(temp, JSON.stringify(status, null, 2), 'utf8'));
      if (this.stopped || generation !== this.writeGeneration) return false;
      retryTransientSync(() => fs.renameSync(temp, file));
      return true;
    } finally {
      // Normally gone after the rename; left over after a dropped or failed write.
      await fs.promises.rm(temp, { force: true }).catch(() => {});
    }
  }
}
