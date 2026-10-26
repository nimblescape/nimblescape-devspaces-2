// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// `monitor.js heartbeat` writes the record of a manual Stop (stopNow), and the loop stops the devspace at a tick
// soon after, under its lock, also in the grace of its start; the record stays, and a later open (a newer heartbeat) is
// never stopped by it. The volume is a temporary folder; nothing needs root.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LABEL_COMPOSE_SERVICE, LABEL_DEVSPACE_ID } from '../core/names';
import { heartbeatFileName } from '../core/remoteMonitor/protocol';
import type { EngineContainerSummary } from '../core/worker/dockerEngine';
import { EXIT_INVALID, RemoteMonitorLoop, heartbeatDir, main } from './main';
import { REMOTE_TICK_MS, STOP_NOW_HOLD_MS } from './rules';
import type { StopLockAttempt } from './stopLock';

const A = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const SOURCE = '0123456789abcdef0123456789abcdef';
const OTHER = 'fedcba9876543210fedcba9876543210';
const T0 = Date.parse('2026-10-11T12:00:00.000Z');
const MINUTE = 60_000;
const DEV_ID = 'a'.repeat(64);
const DB_ID = 'b'.repeat(64);

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-remote-monitor-11k4-'));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

async function heartbeat(source: string, entry: Record<string, unknown>, now: number): Promise<{ code: number; err: string }> {
  let err = '';
  const input = { source, limitSeconds: 600, devspaces: [{ id: A, keepRunning: false, seq: now, ...entry }] };
  const code = await main(['heartbeat', JSON.stringify(input)], { env: {}, stateDir, now: () => now, err: (text) => (err += text) });
  return { code, err };
}

function readRecord(source: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(heartbeatDir(stateDir), heartbeatFileName(source, A)), 'utf8'));
}

describe('monitor.js heartbeat with stopNow', () => {
  it('writes the record of the Stop, with the time of the host', async () => {
    expect(await heartbeat(SOURCE, { stopNow: true }, T0)).toEqual({ code: 0, err: '' });
    expect(readRecord(SOURCE)).toEqual({ at: T0, keepRunning: false, limitSeconds: 600, seq: T0, stopNow: true });
  });

  it('refuses a stopNow with keep, writing nothing', async () => {
    expect(await heartbeat(SOURCE, { stopNow: true, keepRunning: true }, T0)).toEqual({ code: EXIT_INVALID, err: 'Invalid heartbeat.\n' });
    expect(fs.existsSync(path.join(heartbeatDir(stateDir), heartbeatFileName(SOURCE, A)))).toBe(false);
  });

  // The window's tick that was under way when the Stop was chosen carries an older seq: it does not undo the Stop. A
  // newer heartbeat of the same computer (a later open) replaces it.
  it('a heartbeat of the same computer with an older seq leaves it; a newer one replaces it', async () => {
    await heartbeat(SOURCE, { stopNow: true, seq: T0 }, T0);
    await heartbeat(SOURCE, { keepRunning: true, seq: T0 - 1 }, T0 + 1_000);
    expect(readRecord(SOURCE)).toMatchObject({ at: T0, stopNow: true });
    await heartbeat(SOURCE, { seq: T0 + 5 * MINUTE }, T0 + 5 * MINUTE);
    expect(readRecord(SOURCE)).toEqual({ at: T0 + 5 * MINUTE, keepRunning: false, limitSeconds: 600, seq: T0 + 5 * MINUTE });
  });
});

describe('RemoteMonitorLoop with a stopNow record', () => {
  let now: number;
  let lines: string[];
  let events: string[];
  let state: string;
  let attempts: Array<() => StopLockAttempt>;
  let loop: RemoteMonitorLoop;

  const listed = (): EngineContainerSummary[] => [
    { id: DB_ID, name: 'devspaces-api-db-1', state, labels: { [LABEL_DEVSPACE_ID]: A, [LABEL_COMPOSE_SERVICE]: 'db' } },
    { id: DEV_ID, name: 'devspaces-api', state, labels: { [LABEL_DEVSPACE_ID]: A } },
  ];

  beforeEach(() => {
    now = T0;
    lines = [];
    events = [];
    state = 'running';
    attempts = [];
    loop = new RemoteMonitorLoop({
      engine: {
        containerSummaries: async () => listed(),
        stop: async (id) => {
          events.push(`stop ${id}`);
          // The engine stops the containers of the devspace.
          if (id === DB_ID) state = 'exited';
        },
      },
      removeRecord: async () => false,
      dir: heartbeatDir(stateDir),
      now: () => now,
      log: (message) => lines.push(message),
      lockDevspace: async (devspaceId) => {
        events.push(`lock ${devspaceId}`);
        return (attempts.shift() ?? ((): StopLockAttempt => ({ kind: 'locked', release: () => events.push('release') })))();
      },
    });
  });

  async function tickAt(time: number): Promise<string[]> {
    now = time;
    const stopped = await loop.tick();
    await loop.removals;
    return stopped;
  }

  // Mutation: without the stopNow rule, nothing is stopped in the grace of the start (5 minutes), nor within the limit.
  it('stops at the first tick after the hold, in the grace of its start and under the lock; the record stays; a later open is not stopped', async () => {
    // A keep of another computer from before, and the monitor starts now (its grace).
    await heartbeat(OTHER, { keepRunning: true }, T0 - 30 * MINUTE);
    expect(await tickAt(T0)).toEqual([]);
    await heartbeat(SOURCE, { stopNow: true }, T0 + 1_000);
    expect(await tickAt(T0 + REMOTE_TICK_MS)).toEqual([]);
    // The lock is busy (the window's own stop holds it): the next tick.
    attempts.push(() => ({ kind: 'busy' }));
    expect(await tickAt(T0 + 2 * REMOTE_TICK_MS)).toEqual([]);
    expect(events).toEqual([`lock ${A}`]);
    expect(await tickAt(T0 + 3 * REMOTE_TICK_MS)).toEqual([A]);
    expect(events.slice(1)).toEqual([`lock ${A}`, `stop ${DEV_ID}`, `stop ${DB_ID}`, 'release']);
    expect(lines).toContainEqual(expect.stringContaining('a computer asked to stop it (Stop)'));
    // Stopped: nothing more to do, and the record stays.
    events = [];
    expect(await tickAt(T0 + 4 * REMOTE_TICK_MS)).toEqual([]);
    expect(events).toEqual([]);
    expect(readRecord(SOURCE)).toMatchObject({ stopNow: true });

    // A later open of the same computer starts the containers again; its heartbeat replaces the record.
    await heartbeat(SOURCE, {}, T0 + 10 * MINUTE);
    state = 'running';
    for (let time = T0 + 10 * MINUTE; time <= T0 + 19 * MINUTE; time += REMOTE_TICK_MS) expect(await tickAt(time)).toEqual([]);
    expect(events).toEqual([]);
  });

  it('a later open of another computer: the newer record decides, the old Stop never stops it', async () => {
    await heartbeat(SOURCE, { stopNow: true }, T0);
    await heartbeat(OTHER, { keepRunning: true }, T0 + STOP_NOW_HOLD_MS - 1_000);
    for (let time = T0; time <= T0 + 30 * MINUTE; time += REMOTE_TICK_MS) expect(await tickAt(time)).toEqual([]);
    expect(events).toEqual([]);
  });
});
