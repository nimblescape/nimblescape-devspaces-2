// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The retry of a background run that did not reach the network (CacheSchedule): it does not count as a run, so the end
// of the last run stays; it is tried again after 2, 5, 10, 20, 30 minutes, then every hour, until a run reaches the
// network; the retry is kept in the volume, so a restart of the monitor keeps it.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CACHE_RUN_FILE } from '../core/remoteMonitor/protocol';
import { CacheSchedule, CurrentCacheSettings, cacheRunStore } from './main';

const MINUTE = 60_000;
/** 06:07 UTC, a time of the cron schedule of the tests. */
const T0 = Date.parse('2026-10-09T06:07:00Z');
const DAILY = { DEVSPACE_IMAGE_SCHEDULE: '7 6 * * *', DEVSPACE_IMAGE_TZ: 'UTC' };

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-monitor-retry-'));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const stored = () => JSON.parse(fs.readFileSync(path.join(stateDir, CACHE_RUN_FILE), 'utf8')) as Record<string, unknown>;
const store = (state: Record<string, unknown>) => fs.writeFileSync(path.join(stateDir, CACHE_RUN_FILE), JSON.stringify(state));

/**
 * A schedule over the volume of the test with a clock that the test moves; each run takes the next answer of `reached`
 * (true: it reached the network; a missing answer: true).
 */
function scheduleOf(env: NodeJS.ProcessEnv, start: number, reached: Array<boolean | 'throws'> = []) {
  let time = start;
  let passes = 0;
  const log: string[] = [];
  const schedule = new CacheSchedule({
    now: () => time,
    log: (message) => log.push(message),
    settings: new CurrentCacheSettings(env, stateDir, () => {}),
    pass: async () => {
      passes++;
      const answer = reached.shift() ?? true;
      if (answer === 'throws') throw new Error('a failure of the monitor');
      return answer;
    },
    state: cacheRunStore(stateDir),
  });
  return { schedule, log, passes: () => passes, at: (value: number) => (time = value) };
}

describe('the retry of a background run that did not reach the network', () => {
  it('keeps the end of the last run and tries again after 2, 5, 10, 20, 30 minutes, then every hour', async () => {
    const lastEnd = T0 - 24 * 60 * MINUTE;
    store({ lastEndAt: lastEnd });
    const s = scheduleOf(DAILY, T0, [false, false, false, false, false, false, false, false]);
    await s.schedule.check();
    expect(s.passes()).toBe(1);
    expect(stored()).toEqual({ lastEndAt: lastEnd, retryAt: T0 + 2 * MINUTE, retries: 1, lastAttemptAt: T0 });
    expect(s.log).toContain(`The background run did not reach the network; it is tried again at ${new Date(T0 + 2 * MINUTE).toISOString()}.`);
    let time = T0;
    for (const [retry, wait] of [2, 5, 10, 20, 30, 60, 60].entries()) {
      // Not before its time.
      s.at(time + wait * MINUTE - 1);
      await s.schedule.check();
      expect(s.passes()).toBe(retry + 1);
      time += wait * MINUTE;
      s.at(time);
      await s.schedule.check();
      expect(s.passes()).toBe(retry + 2);
      expect(s.log).toContain(`The background run is tried again (retry ${retry + 1}).`);
      const next = [5, 10, 20, 30, 60, 60, 60][retry];
      expect(stored()).toEqual({ lastEndAt: lastEnd, retryAt: time + next * MINUTE, retries: retry + 2, lastAttemptAt: time });
    }
  });

  it('a run that reaches the network ends the retries: its end is kept, and the next run comes by the schedule', async () => {
    store({ lastEndAt: T0 - 24 * 60 * MINUTE });
    const s = scheduleOf(DAILY, T0, [false, true]);
    await s.schedule.check();
    s.at(T0 + 2 * MINUTE);
    await s.schedule.check();
    expect(s.passes()).toBe(2);
    expect(stored()).toEqual({ lastEndAt: T0 + 2 * MINUTE });
    // No further retry; the next run at the next time of the schedule.
    s.at(T0 + 4 * 60 * MINUTE);
    await s.schedule.check();
    expect(s.passes()).toBe(2);
    s.at(T0 + 24 * 60 * MINUTE);
    await s.schedule.check();
    expect(s.passes()).toBe(3);
  });

  it('a restart of the monitor keeps the retry: no run before its time, one at it (also without the last attempt)', async () => {
    store({ lastEndAt: T0 - 24 * 60 * MINUTE, retryAt: T0 + 10 * MINUTE, retries: 3, lastAttemptAt: T0 });
    const s = scheduleOf(DAILY, T0 + 9 * MINUTE, [false]);
    await s.schedule.check();
    expect(s.passes()).toBe(0);
    s.at(T0 + 10 * MINUTE);
    await s.schedule.check();
    expect(s.passes()).toBe(1);
    // The fourth retry waits 20 minutes.
    expect(stored()).toMatchObject({ retryAt: T0 + 30 * MINUTE, retries: 4, lastAttemptAt: T0 + 10 * MINUTE });
    // A stored retry without its last attempt: the retry alone decides, not the schedule of the last run.
    store({ lastEndAt: T0 - 24 * 60 * MINUTE, retryAt: T0 + 10 * MINUTE, retries: 3 });
    const older = scheduleOf(DAILY, T0 + 9 * MINUTE);
    await older.schedule.check();
    expect(older.passes()).toBe(0);
  });

  it('a schedule shorter than the wait of the retry still runs at its times, counted from the last attempt', async () => {
    const s = scheduleOf({ DEVSPACE_IMAGE_SCHEDULE: '5', DEVSPACE_IMAGE_TZ: 'UTC' }, T0, [false, false, false, false, false, false, false]);
    await s.schedule.check();
    // Five retries later the wait is an hour; the schedule of 5 minutes still runs.
    let time = T0;
    for (const wait of [2, 5, 10, 20, 30]) {
      time += Math.min(wait, 5) * MINUTE;
      s.at(time);
      await s.schedule.check();
    }
    const runs = s.passes();
    expect(stored()).toMatchObject({ retries: runs, lastAttemptAt: time });
    s.at(time + 5 * MINUTE - 1);
    await s.schedule.check();
    expect(s.passes()).toBe(runs);
    s.at(time + 5 * MINUTE);
    await s.schedule.check();
    expect(s.passes()).toBe(runs + 1);
  });

  it('a retry comes after its wait, also when an interval of the schedule is longer', async () => {
    const s = scheduleOf({ DEVSPACE_IMAGE_SCHEDULE: '1440', DEVSPACE_IMAGE_TZ: 'UTC' }, T0, [false]);
    await s.schedule.check();
    s.at(T0 + 2 * MINUTE);
    await s.schedule.check();
    expect(s.passes()).toBe(2);
    expect(stored()).toEqual({ lastEndAt: T0 + 2 * MINUTE });
  });

  it('"Update All Images Now" runs while a retry waits, and ends the retries when it reaches the network', async () => {
    store({ lastEndAt: T0 - 24 * 60 * MINUTE, retryAt: T0 + 30 * MINUTE, retries: 2 });
    let requested = true;
    let passes = 0;
    const schedule = new CacheSchedule({
      now: () => T0,
      log: () => {},
      settings: new CurrentCacheSettings(DAILY, stateDir, () => {}),
      pass: async () => void passes++,
      state: cacheRunStore(stateDir),
      runRequest: {
        take: async () => {
          const taken = requested;
          requested = false;
          return taken;
        },
      },
    });
    await schedule.check();
    expect(passes).toBe(1);
    expect(stored()).toEqual({ lastEndAt: T0 });
  });

  it('a run that throws counts as a run: a failure of the monitor itself is not tried again', async () => {
    const s = scheduleOf(DAILY, T0, ['throws']);
    await s.schedule.check();
    expect(stored()).toEqual({ lastEndAt: T0 });
    s.at(T0 + 2 * MINUTE);
    await s.schedule.check();
    expect(s.passes()).toBe(1);
  });

  it('a retry whose time lies far ahead (a corrected clock) runs at once', async () => {
    store({ lastEndAt: T0 - 24 * 60 * MINUTE, retryAt: T0 + 3 * 60 * MINUTE, retries: 6 });
    const s = scheduleOf(DAILY, T0);
    await s.schedule.check();
    expect(s.passes()).toBe(1);
    expect(stored()).toEqual({ lastEndAt: T0 });
  });
});
