// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The pure session helpers that the window needs (its heartbeats to the Monitor container of each engine, Close
// and Keep Running, the checks of other windows). No `vscode`, no I/O but `process.kill(pid, 0)`.
import { DEFAULT_REMOTE_STOP_AFTER_SECONDS, clampLimitSeconds } from '../remoteMonitor/protocol';

const MAX_PID = 0x7fffffff;

/**
 * The process exists: `process.kill(pid, 0)` does not throw `ESRCH`. `EPERM` (a process of another user) counts as
 * alive. Works on macOS, Linux, and Windows. Invalid IDs (0, negative, not an integer) give false, because `kill` with
 * 0 or a negative ID would address a process group.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid > MAX_PID) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * The time limit of the heartbeats to the Monitor container, in seconds, from the setting stopAfterMinutes (on
 * every engine). Clamped to one minute..one day as the protocol allows (the setting itself is 5..1440 minutes); a
 * missing or invalid value gives 10 minutes.
 */
export function stopAfterSeconds(minutes: number | undefined): number {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return DEFAULT_REMOTE_STOP_AFTER_SECONDS;
  return clampLimitSeconds(minutes * 60);
}

/** What keptWhenClosed needs of a devspace. */
export interface KeepFlags {
  /** Keep Running When Closed (`keepRunning`) or Close and Keep Running (`keepRunningOnce`). */
  keepRunning: boolean;
  /** The repository configuration sets `"shutdownAction": "none"`. */
  shutdownActionNone: boolean;
}

/** What keptWhenClosed needs of the settings (the extension settings). */
export interface KeepSettings {
  stopOnClose?: boolean;
  respectShutdownActionNone?: boolean;
}

/**
 * The keep-running flag of a heartbeat for a devspace. True when it is never stopped when closed (Keep Running When
 * Closed, Close and Keep Running, stopOnClose off, a respected `"shutdownAction": "none"`), so the Monitor
 * container does not stop it either when this computer goes offline.
 */
export function keptWhenClosed(devspace: KeepFlags, settings: KeepSettings): boolean {
  // Anything but an explicit false keeps the default (stop).
  if (settings.stopOnClose === false) return true;
  // Keep Running When Closed: only the user stops it.
  if (devspace.keepRunning) return true;
  return settings.respectShutdownActionNone === true && devspace.shutdownActionNone;
}

/** The KeepFlags of a registry entry (keepRunning, keepRunningOnce, shutdownActionNone). */
export function keepFlagsOf(devspace: { keepRunning?: boolean; keepRunningOnce?: boolean; shutdownActionNone?: boolean }): KeepFlags {
  return {
    keepRunning: devspace.keepRunning === true || devspace.keepRunningOnce === true,
    shutdownActionNone: devspace.shutdownActionNone === true,
  };
}
