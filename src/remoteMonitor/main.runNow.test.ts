// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Monitor side of "Update All Images Now" (`monitor.js run-now` writes RUN_NOW_FILE; the next check of the
// schedule takes it and runs the background run at once, once; a request that comes during a run waits for the check
// after it; a request that cannot be taken runs nothing), and the default schedule daily at 06:07 with its catch-up: a
// time that the monitor missed (it was down, the engine off, the computer asleep) runs once at the next check, never
// twice, also after many missed days or a clock that jumps. The volume is a temporary folder.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUN_NOW_FILE } from '../core/remoteMonitor/protocol';
import type { CacheRunState } from './backgroundRules';
import { CacheSchedule, CurrentCacheSettings, main, runRequestStore } from './main';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** 06:07 in Vienna on 2026-10-11 (summer time, UTC+2). */
const SIX_SEVEN = Date.parse('2026-10-11T04:07:00Z');

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-remote-monitor-11k6-'));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const requestFile = () => path.join(stateDir, RUN_NOW_FILE);

/** A schedule with the default setting (no DEVSPACE_IMAGE_SCHEDULE) in Vienna, a clock of the test, and a counted pass. */
function scheduleAt(start: number, lastEndAt?: number, pass?: () => Promise<void>, paused?: () => boolean) {
  let now = start;
  let passes = 0;
  const lines: string[] = [];
  let state: CacheRunState = lastEndAt === undefined ? {} : { lastEndAt };
  const log = (line: string) => void lines.push(line);
  const schedule = new CacheSchedule({
    now: () => now,
    log,
    settings: new CurrentCacheSettings({ DEVSPACE_IMAGE_TZ: 'Europe/Vienna' }, stateDir, () => {}),
    pass: async () => {
      passes += 1;
      await pass?.();
    },
    state: {
      read: async () => state,
      update: async (change) => {
        state = { ...state, ...change };
      },
    },
    runRequest: runRequestStore(stateDir, log),
    ...(paused !== undefined ? { paused } : {}),
  });
  return {
    schedule,
    lines,
    passes: () => passes,
    state: () => state,
    set: (time: number) => (now = time),
    /** One check every minute from now for `ms`; the number of passes in that time. */
    async minutes(ms: number): Promise<number> {
      const before = passes;
      for (const end = now + ms; now < end; now += MINUTE) await schedule.check();
      return passes - before;
    },
  };
}

describe('monitor.js run-now', () => {
  it('writes the request into the volume, and takes no argument', async () => {
    let err = '';
    expect(await main(['run-now'], { env: {}, stateDir, now: () => SIX_SEVEN, err: (text) => (err += text) })).toBe(0);
    expect(JSON.parse(fs.readFileSync(requestFile(), 'utf8'))).toEqual({ requestedAt: SIX_SEVEN });
    fs.rmSync(requestFile());
    expect(await main(['run-now', 'now'], { env: {}, stateDir, err: (text) => (err += text) })).toBe(2);
    expect(err).toBe('run-now takes no argument.\n');
    expect(fs.existsSync(requestFile())).toBe(false);
    // The usage names it.
    await main(['nonsense'], { env: {}, stateDir, err: (text) => (err += text) });
    expect(err).toContain('| run-now');
  });
});

describe('the request of "Update All Images Now" in the schedule', () => {
  it('runs the background run at the next check although it is not due, once', async () => {
    // The run of 06:07 today is done; the next time is tomorrow.
    const s = scheduleAt(SIX_SEVEN + 4 * HOUR, SIX_SEVEN + 10 * MINUTE);
    await s.schedule.check();
    expect(s.passes()).toBe(0);
    expect(await main(['run-now'], { env: {}, stateDir, now: () => SIX_SEVEN + 4 * HOUR })).toBe(0);
    await s.schedule.check();
    expect(s.passes()).toBe(1);
    expect(s.lines).toContain('"Update All Images Now" asked for the background run; it runs now.');
    expect(fs.existsSync(requestFile())).toBe(false);
    expect(s.state().lastEndAt).toBe(SIX_SEVEN + 4 * HOUR);
    // No second run: the request is taken, and the schedule's next time is tomorrow.
    expect(await s.minutes(2 * HOUR)).toBe(0);
  });

  // A permanent monitor that found the time without use (UnusedEnd.paused) starts no run that is only due: it would hold
  // the end back, and pull, download and build for an engine that nobody uses. Mutation: a schedule without the pause
  // fails it.
  it('a due run waits while the monitor found the time without use; a request still runs', async () => {
    let paused = true;
    // The run of 06:07 yesterday was the last one: the run of today is due.
    const s = scheduleAt(SIX_SEVEN + HOUR, SIX_SEVEN - DAY + 10 * MINUTE, undefined, () => paused);
    expect(await s.minutes(10 * MINUTE)).toBe(0);
    expect(s.lines.filter((line) => line.startsWith('The background run is due, but it does not start'))).toEqual([
      'The background run is due, but it does not start: no window used Devspaces on this Docker engine for a long time.',
    ]);
    // "Update All Images Now" is a use, and its run runs.
    expect(await main(['run-now'], { env: {}, stateDir, now: () => SIX_SEVEN + HOUR })).toBe(0);
    await s.schedule.check();
    expect(s.passes()).toBe(1);
    // Another schedule whose run is due: it waits while paused, and runs at the next check once a use came again.
    paused = false;
    const t = scheduleAt(SIX_SEVEN + 2 * HOUR, SIX_SEVEN - DAY + 10 * MINUTE, undefined, () => paused);
    paused = true;
    await t.schedule.check();
    expect(t.passes()).toBe(0);
    paused = false;
    await t.schedule.check();
    expect(t.passes()).toBe(1);
  });

  it('a request during a run waits for the check after it, then runs once more; many requests are one', async () => {
    let release!: () => void;
    let gate: Promise<void> | undefined = new Promise<void>((resolve) => (release = resolve));
    const s = scheduleAt(SIX_SEVEN + HOUR, SIX_SEVEN + 10 * MINUTE, async () => {
      const waiting = gate;
      gate = undefined;
      await waiting;
    });
    fs.writeFileSync(requestFile(), '{}');
    const first = s.schedule.check();
    await vi.waitFor(() => expect(s.passes()).toBe(1));
    expect(s.schedule.busy).toBe(true);
    // Two clicks during the run: one file.
    await main(['run-now'], { env: {}, stateDir });
    await main(['run-now'], { env: {}, stateDir });
    // A check during the run takes nothing (and the run that runs is never joined by a second one).
    await s.schedule.check();
    expect(await s.schedule.runIfRequested()).toBe(false);
    expect(fs.existsSync(requestFile())).toBe(true);
    release();
    await first;
    expect(s.passes()).toBe(1);
    await s.schedule.check();
    expect(s.passes()).toBe(2);
    expect(fs.existsSync(requestFile())).toBe(false);
    await s.schedule.check();
    expect(s.passes()).toBe(2);
  });

  it('a request that cannot be taken runs nothing, and is logged once', async () => {
    fs.mkdirSync(requestFile());
    const s = scheduleAt(SIX_SEVEN + HOUR, SIX_SEVEN + 10 * MINUTE);
    expect(await s.minutes(10 * MINUTE)).toBe(0);
    expect(s.lines.filter((line) => line.startsWith('The request of "Update All Images Now" could not be taken')).length).toBe(1);
  });

  it('runIfRequested (the idle exit of a monitor that ends when idle) starts a requested run, and nothing without a request', async () => {
    const s = scheduleAt(SIX_SEVEN + HOUR, SIX_SEVEN + 10 * MINUTE);
    expect(await s.schedule.runIfRequested()).toBe(false);
    expect(s.passes()).toBe(0);
    fs.writeFileSync(requestFile(), '{}');
    expect(await s.schedule.runIfRequested()).toBe(true);
    expect(s.schedule.busy).toBe(true);
    await vi.waitFor(() => expect(s.schedule.busy).toBe(false));
    expect(s.passes()).toBe(1);
    expect(fs.existsSync(requestFile())).toBe(false);
    expect(await s.schedule.runIfRequested()).toBe(false);
  });
});

// Each test checks once a simulated minute for up to two days, and each check reads the request file: a few seconds,
// more while the other test files run.
describe('the default schedule, daily at 06:07, and a missed time', { timeout: 30_000 }, () => {
  it('runs at 06:07 in the computer time zone, once a day', async () => {
    const s = scheduleAt(SIX_SEVEN - HOUR, SIX_SEVEN - 23 * HOUR);
    expect(await s.minutes(HOUR)).toBe(0);
    expect(await s.minutes(DAY)).toBe(1);
    expect(s.state().lastEndAt).toBe(SIX_SEVEN);
    expect(await s.minutes(DAY)).toBe(1);
    expect(s.state().lastEndAt).toBe(SIX_SEVEN + DAY);
  });

  it('a monitor that missed 06:07 (down, engine off, computer asleep) runs once at its next check, also after many days', async () => {
    for (const missedDays of [1, 5]) {
      // The last run was on the day before the first missed 06:07; the monitor runs again at 09:30 today.
      const s = scheduleAt(SIX_SEVEN + 3 * HOUR + 23 * MINUTE, SIX_SEVEN - missedDays * DAY + 10 * MINUTE);
      expect(await s.minutes(MINUTE), String(missedDays)).toBe(1);
      // Exactly once: no further run until 06:07 tomorrow.
      expect(await s.minutes(20 * HOUR), String(missedDays)).toBe(0);
      expect(await s.minutes(2 * HOUR), String(missedDays)).toBe(1);
    }
  });

  it('a clock that jumps ahead runs once; one that goes back far starts from now, without a storm', async () => {
    const ahead = scheduleAt(SIX_SEVEN + HOUR, SIX_SEVEN + 10 * MINUTE);
    expect(await ahead.minutes(10 * MINUTE)).toBe(0);
    ahead.set(SIX_SEVEN + 7 * DAY + 5 * HOUR);
    expect(await ahead.minutes(HOUR)).toBe(1);
    // Back to the true time: far behind the stored end, so the schedule goes on from now (logged), and runs no
    // catch-up.
    ahead.set(SIX_SEVEN + 2 * HOUR);
    expect(await ahead.minutes(HOUR)).toBe(0);
    expect(ahead.lines.some((line) => line.startsWith('The clock of the host went back'))).toBe(true);
    expect(ahead.state().lastEndAt).toBe(SIX_SEVEN + 2 * HOUR);
    // The next 06:07 runs as usual.
    expect(await ahead.minutes(DAY)).toBe(1);
  });

  it('a restart of the monitor after the run of the day does not run again (the end is in the volume)', async () => {
    const before = scheduleAt(SIX_SEVEN - MINUTE, SIX_SEVEN - DAY + 10 * MINUTE);
    expect(await before.minutes(10 * MINUTE)).toBe(1);
    // A new monitor (a new schedule) with the stored end.
    const after = scheduleAt(SIX_SEVEN + HOUR, before.state().lastEndAt);
    expect(await after.minutes(10 * HOUR)).toBe(0);
  });
});
