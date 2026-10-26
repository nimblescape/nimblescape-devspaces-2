// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import { createRequire, syncBuiltinESMExports } from 'module';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../core/ports';
import { StoragePaths } from '../core/storage/paths';
import { SessionFiles, isWindowStatus } from '../core/storage/sessionFiles';
import { ATOMIC_TEMPORARY_FILE, STALE_PENDING_MAX_AGE_MS } from '../core/storage/storageSweep';
import type { Devspace, ExtensionSettings, WindowStatus } from '../core/types';
import { CLOSE_RELEASE_BOUNDS, SWITCH_RELEASE_BOUNDS, type ReleaseBounds } from '../core/session/windowRelease';
import { HEARTBEAT_INTERVAL_MS, SessionCoordinator, type SessionCoordinatorDeps } from './sessionCoordinator';

const ID_A = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const ID_B = '7c1d2e3f-0000-4000-8000-000000000002';
const T0 = Date.parse('2026-09-24T17:00:00.000Z');
const OWN_PID = 4242;
const OTHER_PID = 4343;
const DEAD_PID = 5151;

const iso = (ms: number): string => new Date(ms).toISOString();

const SETTINGS: ExtensionSettings = {
  reopenLastOnStartup: true,
  stopOnClose: true,
  updateImagesOnConnect: true,
  respectShutdownActionNone: false,
  owners: [],
  includeArchived: false,
  includeForks: true,
  refreshIntervalMinutes: 60,
  hostAccessChecksOff: [],
};

class MemoryLogger implements Logger {
  lines: string[] = [];
  info(message: string): void {
    this.lines.push(`info ${message}`);
  }
  warn(message: string): void {
    this.lines.push(`warn ${message}`);
  }
  error(message: string): void {
    this.lines.push(`error ${message}`);
  }
  output(): void {}
}

interface Harness {
  root: string;
  paths: StoragePaths;
  sessionFiles: SessionFiles;
  clock: { time: number; now(): number };
  alive: Set<number>;
  /** The releases the coordinator asked for, in order. */
  releases: Array<{ devspaceId: string; bounds: ReleaseBounds }>;
  /** What the next release does (default: resolves at once). */
  releaseImpl: (devspaceId: string, bounds: ReleaseBounds) => Promise<unknown>;
  logger: MemoryLogger;
  settings: ExtensionSettings;
  coordinator: SessionCoordinator;
  create(overrides?: Partial<SessionCoordinatorDeps>): SessionCoordinator;
}

let harnesses: Harness[] = [];

function createHarness(): Harness {
  // A sub-folder that does not exist yet: start() creates it.
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-test-')), 'storage');
  const paths = new StoragePaths(root);
  const clock = {
    time: T0,
    now(): number {
      return this.time;
    },
  };
  const sessionFiles = new SessionFiles(paths, clock);
  const alive = new Set<number>([OWN_PID, OTHER_PID]);
  const logger = new MemoryLogger();
  const harness = { root, paths, sessionFiles, clock, alive, logger, settings: { ...SETTINGS }, releases: [] } as unknown as Harness;
  harness.releaseImpl = async () => undefined;
  harness.create = (overrides = {}) =>
    new SessionCoordinator({
      paths,
      sessionFiles,
      logger,
      settings: () => harness.settings,
      clock,
      windowId: 'window-1',
      pid: OWN_PID,
      isAlive: (pid) => alive.has(pid),
      release: (devspaceId, bounds) => {
        harness.releases.push({ devspaceId, bounds });
        return harness.releaseImpl(devspaceId, bounds);
      },
      ...overrides,
    });
  harness.coordinator = harness.create();
  harnesses.push(harness);
  return harness;
}

afterEach(() => {
  for (const harness of harnesses) {
    harness.coordinator.dispose();
    fs.rmSync(path.dirname(harness.root), { recursive: true, force: true });
  }
  harnesses = [];
});

function readStatus(h: Harness, windowId = 'window-1'): WindowStatus | undefined {
  try {
    return JSON.parse(fs.readFileSync(h.paths.sessionFile(windowId), 'utf8')) as WindowStatus;
  } catch {
    return undefined;
  }
}

function nextHeartbeat(coordinator: SessionCoordinator): Promise<void> {
  return new Promise((resolve) => {
    const subscription = coordinator.onDidHeartbeat(() => {
      subscription.dispose();
      resolve();
    });
  });
}

function sessionFileNames(h: Harness): string[] {
  return fs.readdirSync(h.paths.sessionsDir).sort();
}

describe('SessionCoordinator', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });

  it('has a random UUID as window ID by default', () => {
    const first = new SessionCoordinator({ paths: h.paths, sessionFiles: h.sessionFiles, logger: h.logger, settings: () => SETTINGS });
    const second = new SessionCoordinator({ paths: h.paths, sessionFiles: h.sessionFiles, logger: h.logger, settings: () => SETTINGS });
    expect(first.windowId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first.windowId).not.toBe(second.windowId);
    first.dispose();
    second.dispose();
  });

  // The status file is written under the name form of atomicTemporaryPath, in the sessions folder, so that the sweep of
  // the storage folder (storageSweep.ts) removes a leftover.
  it('writes the status file through a temporary file that the sweep of the storage folder recognises', async () => {
    // The namespace of the ES module `fs` cannot be spied on; its CommonJS exports can, and syncBuiltinESMExports
    // passes the spy on to the namespace that sessionCoordinator.ts reads.
    const spy = vi.spyOn(createRequire(import.meta.url)('fs') as typeof fs, 'renameSync');
    syncBuiltinESMExports();
    try {
      await h.coordinator.start(ID_A);
      const file = h.paths.sessionFile('window-1');
      const writes = spy.mock.calls.filter(([, target]) => target === file);
      expect(writes.length).toBeGreaterThan(0);
      for (const [temporary] of writes) {
        expect(path.dirname(String(temporary))).toBe(h.paths.sessionsDir);
        expect(path.basename(String(temporary))).toMatch(ATOMIC_TEMPORARY_FILE);
        expect(path.basename(String(temporary)).startsWith(`.window-1.json.${process.pid}.`)).toBe(true);
      }
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
    }
  });

  // No monitor.json and no local Monitor process.
  it('start writes the active status file and removes the pending file; it writes no monitor.json and starts nothing', async () => {
    await h.sessionFiles.writePending(ID_A, 'window-0');
    await h.coordinator.start(ID_A);
    expect(h.coordinator.devspaceId).toBe(ID_A);
    expect(readStatus(h)).toEqual({
      windowId: 'window-1',
      pid: OWN_PID,
      devspaceId: ID_A,
      state: 'active',
      updatedAt: iso(T0),
    });
    expect(await h.sessionFiles.readPendings()).toEqual([]);
    expect(fs.existsSync(path.join(h.root, 'monitor.json'))).toBe(false);
    expect(fs.existsSync(path.join(h.root, 'monitor.lock'))).toBe(false);
    expect(h.releases).toEqual([]);
    // No temporary files are left behind.
    expect(sessionFileNames(h)).toEqual(['window-1.json']);
  });

  // The status file names the Docker context of the window's authority.
  it('writes the Docker context of the window into its status file, only for a window attached to a devspace', async () => {
    h.coordinator.dispose();
    h.coordinator = h.create({ windowDockerContext: () => 'devspaces-remote-5709ff28' });
    await h.coordinator.start(ID_A);
    expect(readStatus(h)).toMatchObject({ devspaceId: ID_A, dockerContext: 'devspaces-remote-5709ff28' });
    h.coordinator.dispose();
    h.coordinator = h.create({ windowDockerContext: () => 'devspaces-remote-5709ff28' });
    await h.coordinator.start(null);
    expect(readStatus(h)).not.toHaveProperty('dockerContext');
    // Also for a window that works without Devspaces on a devspace of a remote engine: a Start in another window shows
    // it by exactly its URI. Mutation: the context only for a window with a devspace fails it.
    await h.coordinator.setPlainDevspace(ID_A);
    expect(readStatus(h)).toMatchObject({ devspaceId: null, plainDevspaceId: ID_A, dockerContext: 'devspaces-remote-5709ff28' });
    await h.coordinator.setPlainDevspace(null);
    expect(readStatus(h)).not.toHaveProperty('dockerContext');
  });

  it('start resolves with the fresh pending file of its devspace that it removes, so the caller knows the pipeline ran', async () => {
    await h.sessionFiles.writePending(ID_A, 'window-0');
    expect(await h.coordinator.start(ID_A)).toEqual({ devspaceId: ID_A, windowId: 'window-0', createdAt: iso(T0) });
    expect(await h.sessionFiles.readPendings()).toEqual([]);
    // A later call finds nothing.
    expect(await h.coordinator.start(ID_A)).toBeUndefined();
  });

  it('start resolves with nothing for a stale pending file, another devspace, or no devspace', async () => {
    h.clock.time = T0 - 120_001;
    await h.sessionFiles.writePending(ID_A, 'window-0');
    h.clock.time = T0;
    await h.sessionFiles.writePending(ID_B, 'window-0');
    expect(await h.coordinator.start(ID_A)).toBeUndefined();
    expect((await h.sessionFiles.readPendings()).map((pending) => pending.devspaceId)).toEqual([ID_B]);
    const other = h.create({ windowId: 'window-2' });
    expect(await other.start(null)).toBeUndefined();
    other.dispose();
  });

  it('keeps the pending files of other devspaces', async () => {
    await h.sessionFiles.writePending(ID_B, 'window-0');
    await h.coordinator.start(ID_A);
    expect((await h.sessionFiles.readPendings()).map((pending) => pending.devspaceId)).toEqual([ID_B]);
    await h.coordinator.start(null);
    expect(readStatus(h)?.devspaceId).toBeNull();
    expect((await h.sessionFiles.readPendings()).map((pending) => pending.devspaceId)).toEqual([ID_B]);
  });

  it('updates the status file periodically, removes the pending file each time, and fires onDidHeartbeat', async () => {
    const coordinator = h.create({ heartbeatMs: 20 });
    h.coordinator.dispose();
    h.coordinator = coordinator;
    await coordinator.start(ID_A);
    h.clock.time = T0 + HEARTBEAT_INTERVAL_MS;
    await h.sessionFiles.writePending(ID_A, 'window-1');
    await nextHeartbeat(coordinator);
    expect(readStatus(h)?.updatedAt).toBe(iso(T0 + HEARTBEAT_INTERVAL_MS));
    expect(await h.sessionFiles.readPendings()).toEqual([]);
  });

  // The window's tick drives its heartbeats to the Monitor container (not awaited).
  it('drives the window heartbeats at each periodic update, and not after dispose', async () => {
    let ticks = 0;
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const coordinator = h.create({
      heartbeatMs: 20,
      windowHeartbeats: {
        tick: () => {
          ticks += 1;
          // A heartbeat that hangs does not hold the status updates back.
          return blocked;
        },
      },
    });
    h.coordinator.dispose();
    h.coordinator = coordinator;
    await coordinator.start(ID_A);
    // The first heartbeat goes at once after the first status write.
    expect(ticks).toBe(1);
    await nextHeartbeat(coordinator);
    await nextHeartbeat(coordinator);
    expect(ticks).toBeGreaterThanOrEqual(3);
    coordinator.dispose();
    const after = ticks;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(ticks).toBe(after);
    release();
  });

  // A window that stops during a periodic update sends no more heartbeats: the window closes during the status write of
  // the update.
  it('does not drive the window heartbeats when the coordinator stops during an update', async () => {
    let ticks = 0;
    let disposeOnWrite = false;
    let writes = 0;
    const coordinator: SessionCoordinator = h.create({
      heartbeatMs: 20,
      windowHeartbeats: {
        tick: async () => {
          ticks += 1;
        },
      },
      windowDockerContext: () => {
        writes += 1;
        // The window closes while this update runs.
        if (disposeOnWrite) coordinator.dispose();
        return undefined;
      },
    });
    h.coordinator.dispose();
    h.coordinator = coordinator;
    await coordinator.start(ID_A);
    const before = ticks;
    const writesBefore = writes;
    disposeOnWrite = true;
    for (let i = 0; i < 50 && writes === writesBefore; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(writes).toBeGreaterThan(writesBefore);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(ticks).toBe(before);
  });

  it('setDevspace writes the status file at once', async () => {
    await h.coordinator.start(null);
    await h.coordinator.setDevspace(ID_B);
    expect(readStatus(h)?.devspaceId).toBe(ID_B);
    expect(h.coordinator.devspaceId).toBe(ID_B);
  });

  // A window that works without Devspaces on an engine with the removal mark: other windows see it, but its devspace
  // gets no heartbeat, no release and no reopen record. As any window without a devspace, it removes the record of a
  // window that closed before it.
  it('setPlainDevspace writes the devspace apart, at once and with each update; no heartbeat, no release, no reopen record', async () => {
    h.sessionFiles.writeReopenSync({ devspaceId: ID_B, closedAt: iso(T0 - 60_000) });
    const coordinator = h.create({ heartbeatMs: 20 });
    h.coordinator.dispose();
    h.coordinator = coordinator;
    await coordinator.start(null);
    await coordinator.setPlainDevspace(ID_A);
    expect(readStatus(h)).toMatchObject({ devspaceId: null, plainDevspaceId: ID_A, state: 'active' });
    expect(isWindowStatus(readStatus(h))).toBe(true);
    h.clock.time = T0 + 20;
    await nextHeartbeat(coordinator);
    expect(readStatus(h)).toMatchObject({ devspaceId: null, plainDevspaceId: ID_A, updatedAt: iso(T0 + 20) });
    // The devspace of the window, which the heartbeats send (WindowHeartbeatsDeps.connected), stays none.
    expect(coordinator.devspaceId).toBeNull();
    await coordinator.setPlainDevspace(null);
    expect(readStatus(h)).not.toHaveProperty('plainDevspaceId');
    await coordinator.setPlainDevspace(ID_A);
    await coordinator.deactivate();
    expect(readStatus(h)?.state).toBe('closing');
    expect(await h.sessionFiles.readReopen()).toBeUndefined();
    expect(h.releases).toEqual([]);
  });

  it('a newer status write wins over an older one that is still running', async () => {
    await h.coordinator.start(null);
    const first = h.coordinator.setDevspace(ID_A);
    const second = h.coordinator.setDevspace(ID_B);
    await Promise.all([first, second]);
    expect(readStatus(h)?.devspaceId).toBe(ID_B);
    expect(sessionFileNames(h)).toEqual(['window-1.json']);
  });

  it('writePending writes the pending file with this window ID', async () => {
    await h.coordinator.writePending(ID_A);
    const [pending] = await h.sessionFiles.readPendings();
    expect(pending).toEqual({ devspaceId: ID_A, windowId: 'window-1', createdAt: iso(T0) });
  });

  it('deactivateSync writes closing and the reopen record when the window is connected', async () => {
    await h.coordinator.start(ID_A);
    h.clock.time = T0 + 5000;
    h.coordinator.deactivateSync();
    expect(readStatus(h)).toEqual({
      windowId: 'window-1',
      pid: OWN_PID,
      devspaceId: ID_A,
      state: 'closing',
      updatedAt: iso(T0 + 5000),
    });
    expect(await h.sessionFiles.readReopen()).toEqual({ devspaceId: ID_A, closedAt: iso(T0 + 5000) });
  });

  // The reopen at startup opens a devspace only when the window that closed last was connected to it: a window without
  // a devspace that closes after it removes the record.
  it('deactivateSync removes the reopen record of an earlier window when the window has no devspace', async () => {
    h.sessionFiles.writeReopenSync({ devspaceId: ID_A, closedAt: iso(T0 - 60_000) });
    await h.coordinator.start(null);
    h.coordinator.deactivateSync();
    expect(readStatus(h)?.state).toBe('closing');
    expect(await h.sessionFiles.readReopen()).toBeUndefined();
  });

  it('the window that closes last decides the reopen record', async () => {
    const connected = h.create({ windowId: 'window-2', pid: OTHER_PID });
    await connected.start(ID_A);
    await h.coordinator.start(null);
    // The window of the devspace closes first, the local window last: nothing is opened at the next start.
    h.clock.time = T0 + 1_000;
    connected.deactivateSync();
    expect(await h.sessionFiles.readReopen()).toEqual({ devspaceId: ID_A, closedAt: iso(T0 + 1_000) });
    h.clock.time = T0 + 2_000;
    h.coordinator.deactivateSync();
    expect(await h.sessionFiles.readReopen()).toBeUndefined();
    connected.dispose();

    // The local window closes first, the window of the devspace last: its devspace is opened at the next start.
    const local = h.create({ windowId: 'window-3' });
    const last = h.create({ windowId: 'window-4', pid: OTHER_PID });
    await local.start(null);
    await last.start(ID_B);
    h.clock.time = T0 + 3_000;
    local.deactivateSync();
    h.clock.time = T0 + 4_000;
    last.deactivateSync();
    expect(await h.sessionFiles.readReopen()).toEqual({ devspaceId: ID_B, closedAt: iso(T0 + 4_000) });
    local.dispose();
    last.dispose();
  });

  it('deactivateSync logs a reopen record that cannot be removed, and still ends', async () => {
    await h.coordinator.start(null);
    // A folder in place of the file cannot be removed without `recursive`.
    fs.mkdirSync(h.paths.reopen);
    fs.writeFileSync(path.join(h.paths.reopen, 'inside'), '');
    expect(() => h.coordinator.deactivateSync()).not.toThrow();
    expect(readStatus(h)?.state).toBe('closing');
    expect(h.logger.lines).toContain('error The reopen record could not be removed.');
  });

  it('deactivateSync does nothing for a window that never started', () => {
    h.sessionFiles.writeReopenSync({ devspaceId: ID_A, closedAt: iso(T0 - 60_000) });
    h.coordinator.deactivateSync();
    expect(fs.existsSync(h.paths.sessionFile('window-1'))).toBe(false);
    expect(fs.existsSync(h.paths.reopen)).toBe(true);
  });

  it('deactivateSync is not overtaken by a status write that is still running', async () => {
    // Different moments of the running write: before the temporary file exists, while it is written, and after.
    for (let delayTurns = 0; delayTurns < 12; delayTurns++) {
      const harness = createHarness();
      await harness.coordinator.start(ID_A);
      const running = harness.coordinator.setDevspace(ID_A);
      for (let turn = 0; turn < delayTurns; turn++) await new Promise((resolve) => setImmediate(resolve));
      harness.coordinator.deactivateSync();
      await running;
      // Give any leftover asynchronous work the chance to run.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(readStatus(harness)?.state).toBe('closing');
      expect(sessionFileNames(harness)).toEqual(['window-1.json']);
    }
  });

  it('deactivateSync stops the periodic updates', async () => {
    const coordinator = h.create({ heartbeatMs: 10 });
    h.coordinator.dispose();
    h.coordinator = coordinator;
    let beats = 0;
    coordinator.onDidHeartbeat(() => beats++);
    await coordinator.start(ID_A);
    coordinator.deactivateSync();
    const before = beats;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(beats).toBe(before);
    expect(readStatus(h)?.state).toBe('closing');
  });

  it('deactivateSync still writes closing after dispose()', async () => {
    await h.coordinator.start(ID_A);
    h.coordinator.dispose();
    h.coordinator.deactivateSync();
    expect(readStatus(h)?.state).toBe('closing');
  });

  it('start and setDevspace after deactivateSync do not write active again', async () => {
    await h.coordinator.start(ID_A);
    h.coordinator.deactivateSync();
    await h.coordinator.setDevspace(ID_B);
    await h.coordinator.start(ID_B);
    expect(readStatus(h)).toMatchObject({ state: 'closing', devspaceId: ID_A });
  });

  it('otherActiveWindows lists only other windows that are alive, active, and updated within 60 seconds', async () => {
    await h.coordinator.start(ID_A);
    const write = (windowId: string, pid: number, state: WindowStatus['state'], at: number) =>
      h.sessionFiles.writeWindowStatus({ windowId, pid, devspaceId: ID_B, state, updatedAt: iso(at) });
    await write('other-ok', OTHER_PID, 'active', T0 - 60_000);
    await write('other-dead', DEAD_PID, 'active', T0);
    await write('other-closing', OTHER_PID, 'closing', T0);
    await write('other-old', OTHER_PID, 'active', T0 - 60_001);
    await write('other-future', OTHER_PID, 'active', T0 + 120_000);
    const windows = await h.coordinator.otherActiveWindows();
    expect(windows.map((window) => window.windowId)).toEqual(['other-ok']);
  });

  it('a failing heartbeat listener does not stop the others', async () => {
    const coordinator = h.create({ heartbeatMs: 10 });
    h.coordinator.dispose();
    h.coordinator = coordinator;
    coordinator.onDidHeartbeat(() => {
      throw new Error('listener failed');
    });
    const disposables: Array<{ dispose(): unknown }> = [];
    let calls = 0;
    const receiver = { count(): void { calls++; } };
    coordinator.onDidHeartbeat(receiver.count, receiver, disposables);
    expect(disposables).toHaveLength(1);
    await coordinator.start(null);
    await nextHeartbeat(coordinator);
    expect(calls).toBeGreaterThan(0);
    disposables[0].dispose();
    const before = calls;
    await nextHeartbeat(coordinator);
    expect(calls).toBe(before);
    expect(h.logger.lines).toContain('error A listener of the window heartbeat failed.');
  });

  it('logs a failed status write and does not throw', async () => {
    fs.mkdirSync(h.root, { recursive: true });
    // A file where the sessions folder should be.
    fs.writeFileSync(h.paths.sessionsDir, 'not a folder');
    await expect(h.coordinator.start(ID_A)).resolves.toBeUndefined();
    expect(h.logger.lines.some((line) => line.startsWith('warn The window status file could not be written.'))).toBe(true);
  });
});

// The window releases the devspace it leaves (close, switch).
describe('SessionCoordinator: the release of the devspace the window leaves', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('releases the old devspace on a switch, with the bounds of a switch, after the new status is written', async () => {
    await h.coordinator.start(ID_A);
    let statusAtRelease: WindowStatus | undefined;
    h.releaseImpl = async () => {
      statusAtRelease = readStatus(h);
    };
    await h.coordinator.setDevspace(ID_B);
    await vi.waitFor(() => expect(h.releases).toHaveLength(1));
    expect(h.releases[0]).toEqual({ devspaceId: ID_A, bounds: SWITCH_RELEASE_BOUNDS });
    expect(statusAtRelease?.devspaceId).toBe(ID_B);
  });

  it('releases the old devspace when the window leaves it (no devspace) and on a second start with another one', async () => {
    await h.coordinator.start(ID_A);
    await h.coordinator.setDevspace(null);
    await h.coordinator.start(ID_B);
    await h.coordinator.start(ID_A);
    await vi.waitFor(() => expect(h.releases.map((release) => release.devspaceId)).toEqual([ID_A, ID_B]));
  });

  it('releases nothing when the devspace stays the same, when there was none, or before start', async () => {
    await h.coordinator.setDevspace(ID_A);
    await h.coordinator.start(ID_A);
    await h.coordinator.setDevspace(ID_A);
    await h.coordinator.start(ID_A);
    const other = h.create({ windowId: 'window-2' });
    await other.start(null);
    await other.setDevspace(ID_B);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.releases).toEqual([]);
    other.dispose();
  });

  it('deactivate writes closing synchronously, then releases the connected devspace with the bounds of a close', async () => {
    await h.coordinator.start(ID_A);
    let resolveRelease: () => void = () => {};
    let stateAtRelease: string | undefined;
    h.releaseImpl = () => {
      stateAtRelease = readStatus(h)?.state;
      return new Promise<void>((resolve) => (resolveRelease = resolve));
    };
    let done = false;
    const deactivated = h.coordinator.deactivate().then(() => (done = true));
    // Before any await: closing and the reopen record are written.
    expect(readStatus(h)?.state).toBe('closing');
    expect(stateAtRelease).toBe('closing');
    expect(h.releases).toEqual([{ devspaceId: ID_A, bounds: CLOSE_RELEASE_BOUNDS }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // deactivate (and so the disposal of the worker channels that waits for it) ends only after the release.
    expect(done).toBe(false);
    resolveRelease();
    await deactivated;
    expect(done).toBe(true);
    expect(await h.sessionFiles.readReopen()).toEqual({ devspaceId: ID_A, closedAt: iso(T0) });
  });

  it('deactivate ends after the bound of a close when the release hangs, and a second call releases nothing', async () => {
    await h.coordinator.start(ID_A);
    vi.useFakeTimers();
    h.releaseImpl = () => new Promise(() => {});
    let done = false;
    const deactivated = h.coordinator.deactivate().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(CLOSE_RELEASE_BOUNDS.totalMs - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await deactivated;
    expect(done).toBe(true);
    await h.coordinator.deactivate();
    expect(h.releases).toHaveLength(1);
  });

  it('deactivate tolerates a release that rejects or throws, and logs it', async () => {
    await h.coordinator.start(ID_A);
    h.releaseImpl = () => Promise.reject(new Error('engine gone'));
    await expect(h.coordinator.deactivate()).resolves.toBeUndefined();
    expect(h.logger.lines.some((line) => line.includes('engine gone'))).toBe(true);
    const throwing = h.create({
      windowId: 'window-3',
      release: () => {
        throw new Error('sync failure');
      },
    });
    await throwing.start(ID_B);
    await expect(throwing.deactivate()).resolves.toBeUndefined();
    expect(h.logger.lines.some((line) => line.includes('sync failure'))).toBe(true);
    throwing.dispose();
  });

  it('deactivate waits for the release of a switch that still runs, and releases no devspace for a window without one', async () => {
    await h.coordinator.start(ID_A);
    let resolveSwitch: () => void = () => {};
    h.releaseImpl = () => new Promise<void>((resolve) => (resolveSwitch = resolve));
    await h.coordinator.setDevspace(null);
    await vi.waitFor(() => expect(h.releases).toHaveLength(1));
    let done = false;
    const deactivated = h.coordinator.deactivate().then(() => (done = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(done).toBe(false);
    resolveSwitch();
    await deactivated;
    // Only the release of the switch: the window had no devspace when it closed.
    expect(h.releases.map((release) => release.devspaceId)).toEqual([ID_A]);
  });

  it('deactivate of a window that never started releases nothing', async () => {
    await h.coordinator.deactivate();
    expect(h.releases).toEqual([]);
  });
});

// The window cleans up the storage folder.
describe('SessionCoordinator: the cleanup of the storage folder', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });

  const writeStatusFile = (windowId: string, pid: number, at: number, state: WindowStatus['state'] = 'active') =>
    h.sessionFiles.writeWindowStatus({ windowId, pid, devspaceId: ID_B, state, updatedAt: iso(at) });

  it('at activation: removes the status files of other windows whose process ended and that are older than 60 s plus WINDOW_STATUS_SLACK_MS (30 s)', async () => {
    fs.mkdirSync(h.paths.sessionsDir, { recursive: true });
    // The slack is fixed (WINDOW_STATUS_SLACK_MS): 90 s.
    await writeStatusFile('dead-old', DEAD_PID, T0 - 90_001, 'closing');
    await writeStatusFile('dead-fresh', DEAD_PID, T0 - 90_000, 'closing');
    await writeStatusFile('alive-old', OTHER_PID, T0 - 3_600_000);
    await h.coordinator.start(ID_A);
    expect(sessionFileNames(h)).toEqual(['alive-old.json', 'dead-fresh.json', 'window-1.json']);
    expect(h.logger.lines).toContain('info Removed the status file of the closed window dead-old.');
  });

  it('at activation: sweeps the storage folder (an outdated pending connection file)', async () => {
    h.clock.time = T0 - STALE_PENDING_MAX_AGE_MS - 1;
    await h.sessionFiles.writePending(ID_B, 'window-0');
    h.clock.time = T0;
    await h.coordinator.start(ID_A);
    expect(await h.sessionFiles.readPendings()).toEqual([]);
  });

  it('runs again every interval, and not after the window closed', async () => {
    const coordinator = h.create({ cleanupMs: 20 });
    h.coordinator.dispose();
    h.coordinator = coordinator;
    await coordinator.start(ID_A);
    await writeStatusFile('dead-old', DEAD_PID, T0 - 3_600_000);
    await vi.waitFor(() => expect(sessionFileNames(h)).toEqual(['window-1.json']), { timeout: 2000 });
    coordinator.deactivateSync();
    await writeStatusFile('dead-later', DEAD_PID, T0 - 3_600_000);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(sessionFileNames(h)).toContain('dead-later.json');
  });

  // A run that is under way when the window closes must not remove a file written after it started.
  it('a run that is under way when the window closes removes nothing more', async () => {
    await h.coordinator.start(ID_A);
    await writeStatusFile('dead-old', DEAD_PID, T0 - 3_600_000);
    const running = h.coordinator.cleanUpStorage();
    h.coordinator.deactivateSync();
    await running;
    expect(sessionFileNames(h)).toContain('dead-old.json');
  });

  it('never throws when the status files cannot be read', async () => {
    fs.mkdirSync(h.root, { recursive: true });
    fs.writeFileSync(h.paths.sessionsDir, 'not a folder');
    await expect(h.coordinator.cleanUpStorage()).resolves.toBeUndefined();
  });
});

// The first heartbeat at once, the other windows that hold a devspace, and the bounds and failures of the close.
describe('SessionCoordinator: the first heartbeat, the other windows, and the bounds of the close', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function withTicks(): { ticks: () => number } {
    let ticks = 0;
    const coordinator = h.create({
      heartbeatMs: 60_000,
      windowHeartbeats: {
        tick: async () => {
          ticks += 1;
        },
      },
    });
    h.coordinator.dispose();
    h.coordinator = coordinator;
    return { ticks: () => ticks };
  }

  it('start sends the first heartbeat right after the first status write, not after the first interval', async () => {
    const counter = withTicks();
    let statusAtTick: WindowStatus | undefined;
    const coordinator = h.create({
      heartbeatMs: 60_000,
      windowHeartbeats: {
        tick: async () => {
          statusAtTick = readStatus(h);
        },
      },
    });
    await coordinator.start(ID_A);
    expect(statusAtTick?.devspaceId).toBe(ID_A);
    coordinator.dispose();
    // A window without a devspace has nothing to send.
    await h.coordinator.start(null);
    expect(counter.ticks()).toBe(0);
  });

  it('setDevspace and a second start to another devspace send its heartbeat at once; none for no devspace or the same one', async () => {
    const counter = withTicks();
    await h.coordinator.start(ID_A);
    expect(counter.ticks()).toBe(1);
    await h.coordinator.setDevspace(ID_B);
    expect(counter.ticks()).toBe(2);
    await h.coordinator.setDevspace(ID_B);
    await h.coordinator.setDevspace(null);
    expect(counter.ticks()).toBe(2);
    await h.coordinator.start(ID_A);
    expect(counter.ticks()).toBe(3);
    await h.coordinator.start(ID_A);
    expect(counter.ticks()).toBe(3);
    // Not after the window closed.
    h.coordinator.deactivateSync();
    await h.coordinator.setDevspace(ID_B);
    expect(counter.ticks()).toBe(3);
  });

  it('otherWindowUses counts a status file, a fresh pending connection file, and a live busy mark of another window', async () => {
    await h.coordinator.start(null);
    const env = (extra: Partial<Devspace> = {}): Devspace => ({ id: ID_B, repository: 'acme/web', ...extra }) as Devspace;
    expect(await h.coordinator.otherWindowUses(env())).toBe(false);
    // A pending connection file of another window.
    await h.sessionFiles.writePending(ID_B, 'window-2');
    expect(await h.coordinator.otherWindowUses(env())).toBe(true);
    await h.sessionFiles.removePending(ID_B);
    // A status file of another live window.
    await h.sessionFiles.writeWindowStatus({ windowId: 'window-2', pid: OTHER_PID, devspaceId: ID_B, state: 'active', updatedAt: iso(T0) });
    expect(await h.coordinator.otherWindowUses(env())).toBe(true);
    // A live busy mark of another window (its status file names another devspace).
    await h.sessionFiles.writeWindowStatus({ windowId: 'window-2', pid: OTHER_PID, devspaceId: null, state: 'active', updatedAt: iso(T0) });
    expect(await h.coordinator.otherWindowUses(env())).toBe(false);
    expect(await h.coordinator.otherWindowUses(env({ busy: { operation: 'rebuild', since: iso(T0), pid: OTHER_PID, windowId: 'window-2' } }))).toBe(true);
    // Not a busy mark of this window.
    expect(await h.coordinator.otherWindowUses(env({ busy: { operation: 'rebuild', since: iso(T0), pid: OWN_PID, windowId: 'window-1' } }))).toBe(false);
  });

  it('otherWindowUses says yes when the files cannot be read (nothing is released), and logs it', async () => {
    await h.coordinator.start(null);
    h.sessionFiles.readPendings = async () => {
      throw new Error('pending unreadable');
    };
    expect(await h.coordinator.otherWindowUses({ id: ID_B, repository: 'acme/web' } as Devspace)).toBe(true);
    expect(h.logger.lines.some((line) => line.startsWith('warn') && line.includes('pending unreadable'))).toBe(true);
  });

  // The bound of a close holds also for a switch release that still runs (its own bound is longer).
  it('deactivate ends after the bound of a close also while the release of a switch hangs', async () => {
    await h.coordinator.start(ID_A);
    h.releaseImpl = () => new Promise(() => {});
    await h.coordinator.setDevspace(ID_B);
    await vi.waitFor(() => expect(h.releases).toHaveLength(1));
    vi.useFakeTimers();
    let done = false;
    const deactivated = h.coordinator.deactivate().then(() => (done = true));
    expect(h.releases.map((release) => release.bounds)).toEqual([SWITCH_RELEASE_BOUNDS, CLOSE_RELEASE_BOUNDS]);
    await vi.advanceTimersByTimeAsync(CLOSE_RELEASE_BOUNDS.totalMs - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await deactivated;
    expect(done).toBe(true);
    expect(CLOSE_RELEASE_BOUNDS.totalMs).toBeLessThan(SWITCH_RELEASE_BOUNDS.totalMs);
  });

  // A failed sweep is logged, start() still resolves, and the status files are still cleaned up.
  it('a failed sweep of the storage folder does not reject start(); it is logged and the status cleanup still runs', async () => {
    fs.mkdirSync(h.paths.sessionsDir, { recursive: true });
    await h.sessionFiles.writeWindowStatus({ windowId: 'dead-old', pid: DEAD_PID, devspaceId: ID_B, state: 'closing', updatedAt: iso(T0 - 3_600_000) });
    Object.defineProperty(h.paths, 'disconnectDir', {
      get: () => {
        throw new Error('sweep broken');
      },
    });
    await expect(h.coordinator.start(ID_A)).resolves.toBeUndefined();
    expect(h.logger.lines).toContain('warn The storage folder could not be cleaned up. sweep broken');
    expect(sessionFileNames(h)).toEqual(['window-1.json']);
  });
});

// The last use for Delete's note, and the start tick that never waits for the cleanup of the storage folder.
describe('SessionCoordinator: the last use and the start tick', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });

  it('the first heartbeat of start does not wait for the cleanup of the storage folder (it never ends here)', async () => {
    let ticks = 0;
    const coordinator = h.create({
      heartbeatMs: 60_000,
      windowHeartbeats: {
        tick: async () => {
          ticks += 1;
        },
      },
    });
    h.coordinator.dispose();
    h.coordinator = coordinator;
    // cleanUpStorage reads the status files of the other windows; that read never ends.
    vi.spyOn(h.sessionFiles, 'readWindowStatuses').mockImplementation(() => new Promise(() => {}));
    let started = false;
    void coordinator.start(ID_A).then(() => (started = true));
    await vi.waitFor(() => expect(ticks).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ticks).toBe(1);
    // The start itself still waits for the cleanup.
    expect(started).toBe(false);
  });

  it('start records that the window was seen using its devspace (a reload), not for no devspace, nor after the close', async () => {
    const seen: Array<{ devspaceId: string; at: string }> = [];
    const coordinator = h.create({
      heartbeatMs: 60_000,
      markSeenInUse: async (devspaceId, at) => {
        seen.push({ devspaceId, at });
      },
    });
    h.coordinator.dispose();
    h.coordinator = coordinator;
    await coordinator.start(ID_A);
    await vi.waitFor(() => expect(seen).toEqual([{ devspaceId: ID_A, at: iso(T0) }]));
    // A second start to another devspace (as a reload of the folder) records that one.
    h.clock.time = T0 + 1_000;
    await coordinator.start(ID_B);
    await vi.waitFor(() => expect(seen).toEqual([{ devspaceId: ID_A, at: iso(T0) }, { devspaceId: ID_B, at: iso(T0 + 1_000) }]));
    // No devspace: nothing.
    await coordinator.start(null);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen).toHaveLength(2);
    coordinator.deactivateSync();
    await coordinator.start(ID_A);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen).toHaveLength(2);
  });

  it('a window disposed during the first status write of its start records nothing', async () => {
    const seen: string[] = [];
    let ticks = 0;
    const coordinator: SessionCoordinator = h.create({
      heartbeatMs: 60_000,
      // Runs within the first status write: the window is disposed there.
      windowDockerContext: () => {
        coordinator.dispose();
        return undefined;
      },
      windowHeartbeats: {
        tick: async () => {
          ticks += 1;
        },
      },
      markSeenInUse: async (devspaceId) => {
        seen.push(devspaceId);
      },
    });
    h.coordinator.dispose();
    h.coordinator = coordinator;
    await coordinator.start(ID_A);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen).toEqual([]);
    expect(ticks).toBe(0);
  });

  it('a window without a devspace at its first start records nothing; a failure is logged and the start goes on', async () => {
    const calls: string[] = [];
    const idle = h.create({
      windowId: 'window-2',
      markSeenInUse: async (devspaceId) => {
        calls.push(devspaceId);
      },
    });
    await idle.start(null);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toEqual([]);
    idle.dispose();
    const failing = h.create({
      markSeenInUse: async () => {
        throw new Error('registry locked');
      },
    });
    h.coordinator.dispose();
    h.coordinator = failing;
    await failing.start(ID_A);
    expect(readStatus(h)?.devspaceId).toBe(ID_A);
    await vi.waitFor(() => expect(h.logger.lines.some((line) => line.includes('last use') && line.includes('registry locked'))).toBe(true));
  });
});
