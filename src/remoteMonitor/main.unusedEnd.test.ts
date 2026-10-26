// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// A permanent monitor ends itself after 30 days in which no window used the engine: the subcommands of the windows
// record the use (last-use.json, at most once an hour), a new container is a use and a restart is none, and the loop
// looks again after an hour before it sets the restart policy of its own container to `no` and exits with 0; a use
// that comes meanwhile ends the wait, and one that comes while it ends sets the policy back. The volume is a temporary
// folder; the engine is a fake.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LAST_USE_FILE, RUN_NOW_FILE, UNUSED_END_MS, parseLastUse, type LastUse } from '../core/remoteMonitor/protocol';
import { EngineError, type EngineContainerSummary, type EngineFilters } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import type { MonitorEngineParts } from './engine';
import { EXIT_INVALID, IMAGE_CHECK_MS, STATE_TEMPORARY_FILE, UNUSED_END_RECHECK_MS, main, recordStart, recordUse, spanText, unusedEndFromEnv, vscodeBackgroundDeps } from './main';
import { REMOTE_TICK_MS } from './rules';

const T0 = Date.parse('2026-10-16T10:00:00Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SOURCE = '0123456789abcdef0123456789abcdef';
const A = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
/** The nonce of the create of this monitor container, and of another (newer) one. */
const CREATE = '0f0f0f0f-0000-4000-8000-000000000001';
const NEWER = '0f0f0f0f-0000-4000-8000-000000000002';
const OWN_ID = 'feed'.padEnd(64, '1');
/** The container of a permanent monitor whose first background run is a day away (none runs in these tests). */
const PERMANENT_ENV = { DEVSPACE_MONITOR_PERMANENT: '1', DEVSPACE_MONITOR_CREATE_ID: CREATE, DEVSPACE_IMAGE_FIRST_MS: '86400000' };

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-monitor-unused-'));
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function lastUse(): LastUse | undefined {
  const file = path.join(stateDir, LAST_USE_FILE);
  return fs.existsSync(file) ? parseLastUse(fs.readFileSync(file, 'utf8')) : undefined;
}

function writeLastUse(use: LastUse): void {
  fs.writeFileSync(path.join(stateDir, LAST_USE_FILE), JSON.stringify(use));
}

const heartbeat = JSON.stringify({ source: SOURCE, limitSeconds: 600, devspaces: [{ id: A, keepRunning: false, seq: 1 }] });

describe('the use of the engine', () => {
  it('is 30 days by default; the Docker tests can set a shorter time', () => {
    expect(UNUSED_END_MS).toBe(30 * DAY);
    expect(unusedEndFromEnv({})).toBe(UNUSED_END_MS);
    expect(unusedEndFromEnv({ DEVSPACE_MONITOR_UNUSED_MS: '3000' })).toBe(3000);
    for (const value of ['99', '-1', 'x', String(UNUSED_END_MS + 1)]) expect(unusedEndFromEnv({ DEVSPACE_MONITOR_UNUSED_MS: value })).toBe(UNUSED_END_MS);
    expect([spanText(30 * DAY), spanText(HOUR), spanText(2 * MINUTE), spanText(3000)]).toEqual(['30 days', '1 hour', '2 minutes', '3 s']);
  });

  it('a subcommand of a window records it at most once an hour; a clock that went back never moves it earlier', async () => {
    const env = { DEVSPACE_MONITOR_CREATE_ID: CREATE };
    const run = (argv: string[], now: number, input = '') => main(argv, { env, stateDir, now: () => now, readStdin: async () => input, err: () => {} });
    expect(await run(['heartbeat', heartbeat], T0)).toBe(0);
    expect(lastUse()).toEqual({ at: T0, createId: CREATE });
    // Within the hour, nothing is written (the heartbeats come every 30 s).
    expect(await run(['heartbeat', heartbeat], T0 + 59 * MINUTE)).toBe(0);
    expect(lastUse()).toEqual({ at: T0, createId: CREATE });
    expect(await run(['run-now'], T0 + HOUR)).toBe(0);
    expect(lastUse()).toEqual({ at: T0 + HOUR, createId: CREATE });
    expect(await run(['settings', '-'], T0 + 2 * HOUR, JSON.stringify({ schedule: '17', timeZone: 'UTC' }))).toBe(0);
    expect(lastUse()?.at).toBe(T0 + 2 * HOUR);
    expect(await run(['images', '-'], T0 + 3 * HOUR, JSON.stringify({ source: SOURCE, references: ['node:20'] }))).toBe(0);
    expect(lastUse()?.at).toBe(T0 + 3 * HOUR);
    // A time before the stored one: the clock went back. The stored time stays (only the loop replaces it, when the
    // clock is still behind at its second look), so a clock that is set right again finds the last use.
    expect(await run(['heartbeat', heartbeat], T0 - 40 * DAY)).toBe(0);
    expect(lastUse()).toEqual({ at: T0 + 3 * HOUR, createId: CREATE });
    // The forget of a Delete comes from a window.
    expect(await run(['forget', SOURCE, A], T0 + 4 * HOUR)).toBe(0);
    expect(lastUse()?.at).toBe(T0 + 4 * HOUR);
  });

  it('the forget of the loop and a call that is refused record no use', async () => {
    const env = { DEVSPACE_MONITOR_CREATE_ID: CREATE };
    const run = (argv: string[]) => main(argv, { env, stateDir, now: () => T0, out: () => {}, err: () => {} });
    expect(await run(['forget', SOURCE, A, String(T0 - DAY)])).toBe(0);
    expect(await run(['heartbeat', '{'])).toBe(EXIT_INVALID);
    expect(await run(['run-now', 'x'])).toBe(EXIT_INVALID);
    expect(lastUse()).toBeUndefined();
  });

  it('is written atomically, and a leftover temporary file of it is removed at the start of run', async () => {
    expect(STATE_TEMPORARY_FILE.test('last-use.json.12.1.tmp')).toBe(true);
    await recordUse(stateDir, {}, T0);
    expect(fs.readdirSync(stateDir)).toEqual([LAST_USE_FILE]);
    // Without the nonce of a create (an older container), the stored one stays.
    writeLastUse({ at: T0 - 2 * HOUR, createId: CREATE });
    await recordUse(stateDir, {}, T0);
    expect(lastUse()).toEqual({ at: T0, createId: CREATE });
  });

  it('a new monitor container is a use; a restart of the same container is none', async () => {
    await recordStart(stateDir, { DEVSPACE_MONITOR_CREATE_ID: CREATE }, T0);
    expect(lastUse()).toEqual({ at: T0, createId: CREATE });
    // Docker started the same container again (a restart of the engine).
    await recordStart(stateDir, { DEVSPACE_MONITOR_CREATE_ID: CREATE }, T0 + 10 * DAY);
    expect(lastUse()).toEqual({ at: T0, createId: CREATE });
    // An open created a new container.
    await recordStart(stateDir, { DEVSPACE_MONITOR_CREATE_ID: NEWER }, T0 + 11 * DAY);
    expect(lastUse()).toEqual({ at: T0 + 11 * DAY, createId: NEWER });
    // A new container while the clock is behind the stored time: its nonce, and the later time.
    await recordStart(stateDir, { DEVSPACE_MONITOR_CREATE_ID: CREATE }, T0 - 30 * DAY);
    expect(lastUse()).toEqual({ at: T0 + 11 * DAY, createId: CREATE });
    await recordStart(stateDir, { DEVSPACE_MONITOR_CREATE_ID: NEWER }, T0 + 11 * DAY);
    // A container without a nonce keeps a valid time; a file that is not valid counts as a use now.
    await recordStart(stateDir, {}, T0 + 12 * DAY);
    expect(lastUse()).toEqual({ at: T0 + 11 * DAY, createId: NEWER });
    fs.writeFileSync(path.join(stateDir, LAST_USE_FILE), '{"at":"yesterday"}');
    await recordStart(stateDir, {}, T0 + 13 * DAY);
    expect(lastUse()).toEqual({ at: T0 + 13 * DAY });
  });
});

describe('the end of a permanent monitor after 30 days without use', () => {
  interface Started {
    result: Promise<number>;
    out: () => string;
    events: string[];
    mono: () => number;
    ticks: () => number;
  }

  /**
   * `run` with a fake engine that knows its own container (OWN_ID). `now` gives the clock of the host by the monotonic
   * time; `onTick` runs at each wait between two ticks; at `maxTicks` the loop waits forever.
   */
  function startRun(options: {
    env?: NodeJS.ProcessEnv;
    now?: (mono: number) => number;
    updateRestartPolicy?: (policy: string) => Promise<void>;
    onTick?: (mono: number) => Promise<void> | void;
    maxTicks?: number;
    engine?: Partial<MonitorEngineParts>;
    vscodeBackground?: () => ReturnType<typeof vscodeBackgroundDeps>;
  }): Started {
    let mono = 0;
    let ticks = 0;
    let out = '';
    const events: string[] = [];
    const now = options.now ?? ((time: number) => T0 + time);
    const result = main(['run'], {
      env: options.env ?? PERMANENT_ENV,
      stateDir,
      engine: {
        ...unusedEngine(),
        containerSummaries: async (): Promise<EngineContainerSummary[]> => [],
        containerIds: async (filters: EngineFilters) => {
          events.push(`list ${JSON.stringify(filters)}`);
          return [OWN_ID];
        },
        updateRestartPolicy: async (id, policy) => {
          events.push(`policy ${id === OWN_ID ? 'own' : id} ${policy}`);
          await options.updateRestartPolicy?.(policy);
        },
        ...options.engine,
      },
      vscodeBackground: options.vscodeBackground ?? (() => undefined),
      lockDevspace: async () => ({ kind: 'locked', release: () => {} }),
      exec: (_file, _args, _options, callback) => callback(null, 'removed\n', ''),
      monotonic: () => mono,
      now: () => now(mono),
      sleep: async (ms) => {
        ticks += 1;
        mono += ms;
        await options.onTick?.(mono);
        if (ticks >= (options.maxTicks ?? 10_000)) await new Promise(() => {});
        await new Promise<void>((resolve) => setImmediate(resolve));
      },
      out: (text) => {
        out += text;
        if (text.includes('the Monitor ends itself')) events.push('exit');
      },
    });
    return { result, out: () => out, events, mono: () => mono, ticks: () => ticks };
  }

  const pending = async (promise: Promise<unknown>) =>
    (await Promise.race([promise.then(() => 'ended'), new Promise((resolve) => setTimeout(() => resolve('pending'), 200))])) as string;

  /** With fake timers (the timeout of `pending` would never come): still pending after some turns of the event loop. */
  const stillPending = async (promise: Promise<unknown>) => {
    let ended = false;
    void promise.then(() => (ended = true));
    for (let turn = 0; turn < 50; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
    return !ended;
  };

  /** The VS Code part of the background run, which counts the runs (each asks for the architecture first). */
  function countedVscode(onRun: () => Promise<string> | string): NonNullable<ReturnType<typeof vscodeBackgroundDeps>> {
    const store = path.join(stateDir, 'store');
    fs.mkdirSync(store, { recursive: true });
    return {
      store: { root: store },
      storeVolume: 'devspaces-vscode',
      extensionStateDir: stateDir,
      engine: { ...unusedEngine(), architecture: async () => onRun() },
      tryLock: async () => ({ kind: 'busy' as const }),
    } as unknown as NonNullable<ReturnType<typeof vscodeBackgroundDeps>>;
  }

  const LIST = `list ${JSON.stringify({ label: [`nimblescape.devspaces.monitor-create=${CREATE}`] })}`;

  it('looks again after an hour, sets the restart policy of its own container to "no", then exits with 0', async () => {
    writeLastUse({ at: T0 - UNUSED_END_MS, createId: CREATE });
    const monitor = startRun({});
    expect(await monitor.result).toBe(0);
    expect(monitor.events).toEqual([`list ${JSON.stringify({ label: [`nimblescape.devspaces.monitor-create=${CREATE}`] })}`, 'policy own no', 'exit']);
    // The second look comes an hour after the first.
    expect(monitor.mono()).toBeGreaterThanOrEqual(UNUSED_END_RECHECK_MS);
    expect(monitor.mono()).toBeLessThan(UNUSED_END_RECHECK_MS + 2 * REMOTE_TICK_MS);
    expect(monitor.out()).toContain('runs permanently. It ends itself when no window used Devspaces on this engine for 30 days.');
    expect(monitor.out()).toContain('No window used Devspaces on this Docker engine for 30 days. The Monitor looks again in 1 hour; then it ends itself.');
    expect(monitor.out()).toContain('No window used Devspaces on this Docker engine for 30 days; the Monitor ends itself. Its restart policy is now "no". The next open starts a new one.');
    // The restart of the same container was no use.
    expect(lastUse()).toEqual({ at: T0 - UNUSED_END_MS, createId: CREATE });
  });

  it('a new container counts as a use: it runs on', async () => {
    writeLastUse({ at: T0 - UNUSED_END_MS, createId: NEWER });
    const monitor = startRun({ maxTicks: Math.ceil((2 * UNUSED_END_RECHECK_MS) / REMOTE_TICK_MS) });
    await vi.waitFor(() => expect(monitor.ticks()).toBe(Math.ceil((2 * UNUSED_END_RECHECK_MS) / REMOTE_TICK_MS)), { timeout: 10_000 });
    expect(await pending(monitor.result)).toBe('pending');
    expect(monitor.events).toEqual([]);
    expect(lastUse()).toEqual({ at: T0, createId: CREATE });
  }, 20_000);

  it('a use of a window during the hour keeps it running', async () => {
    writeLastUse({ at: T0 - UNUSED_END_MS, createId: CREATE });
    let used = false;
    const monitor = startRun({
      onTick: async (mono) => {
        // A heartbeat of a window half an hour after the first look.
        if (!used && mono >= 30 * MINUTE) {
          used = true;
          await recordUse(stateDir, PERMANENT_ENV, T0 + mono);
        }
      },
      maxTicks: Math.ceil((3 * UNUSED_END_RECHECK_MS) / REMOTE_TICK_MS),
    });
    await vi.waitFor(() => expect(monitor.ticks()).toBe(Math.ceil((3 * UNUSED_END_RECHECK_MS) / REMOTE_TICK_MS)), { timeout: 10_000 });
    expect(await pending(monitor.result)).toBe('pending');
    expect(monitor.events).toEqual([]);
    expect(monitor.out()).toContain('The Monitor looks again in 1 hour');
  }, 20_000);

  it('a clock that jumped ahead and is set right again within the hour ends nothing', async () => {
    writeLastUse({ at: T0, createId: CREATE });
    // 40 days ahead for the first ten minutes.
    const monitor = startRun({
      now: (mono) => T0 + mono + (mono < 10 * MINUTE ? 40 * DAY : 0),
      maxTicks: Math.ceil((3 * UNUSED_END_RECHECK_MS) / REMOTE_TICK_MS),
    });
    await vi.waitFor(() => expect(monitor.ticks()).toBe(Math.ceil((3 * UNUSED_END_RECHECK_MS) / REMOTE_TICK_MS)), { timeout: 10_000 });
    expect(await pending(monitor.result)).toBe('pending');
    expect(monitor.events).toEqual([]);
    expect(lastUse()?.at).toBe(T0);
  }, 20_000);

  // The clock went back for good, or the stored time was written by a clock that was ahead: a use now, written only
  // when the clock is still behind at the second look an hour later.
  it('a stored time later than the clock counts as a use now, and is replaced when the clock is still behind an hour later', async () => {
    writeLastUse({ at: T0 + 400 * DAY, createId: CREATE });
    let halfway: LastUse | undefined;
    const monitor = startRun({
      onTick: (mono) => {
        if (halfway === undefined && mono >= 30 * MINUTE) halfway = lastUse();
      },
      maxTicks: Math.ceil((2 * UNUSED_END_RECHECK_MS) / REMOTE_TICK_MS),
    });
    await vi.waitFor(() => expect(monitor.ticks()).toBe(Math.ceil((2 * UNUSED_END_RECHECK_MS) / REMOTE_TICK_MS)), { timeout: 10_000 });
    // Half an hour after the first look, the stored time is still there.
    expect(halfway).toEqual({ at: T0 + 400 * DAY, createId: CREATE });
    const replaced = lastUse();
    expect(replaced?.createId).toBe(CREATE);
    expect(replaced?.at).toBeGreaterThanOrEqual(T0 + UNUSED_END_RECHECK_MS);
    expect(replaced?.at).toBeLessThan(T0 + UNUSED_END_RECHECK_MS + 2 * REMOTE_TICK_MS);
    expect(monitor.events).toEqual([]);
  }, 20_000);

  // A clock set back by more than the time without use and set right again within the hour: the heartbeats and the loop
  // keep the stored time of the last use, so the Monitor does not end. Mutation: the old time written at once fails it.
  it('a clock that went back and is set right again within the hour keeps the last use and ends nothing', async () => {
    writeLastUse({ at: T0, createId: CREATE });
    let used = false;
    const back = (mono: number): number => T0 + mono - (mono < 10 * MINUTE ? 40 * DAY : 0);
    const monitor = startRun({
      now: back,
      onTick: async (mono) => {
        // A heartbeat of a window while the clock is behind.
        if (!used && mono >= 5 * MINUTE) {
          used = true;
          await recordUse(stateDir, PERMANENT_ENV, back(mono));
        }
      },
      maxTicks: Math.ceil((3 * UNUSED_END_RECHECK_MS) / REMOTE_TICK_MS),
    });
    await vi.waitFor(() => expect(monitor.ticks()).toBe(Math.ceil((3 * UNUSED_END_RECHECK_MS) / REMOTE_TICK_MS)), { timeout: 10_000 });
    expect(used).toBe(true);
    expect(await pending(monitor.result)).toBe('pending');
    expect(monitor.events).toEqual([]);
    expect(monitor.out()).not.toContain('No window used Devspaces');
    expect(lastUse()?.at).toBe(T0);
  }, 20_000);

  it('a failure is logged once and does not end it; it tries again an hour later', async () => {
    writeLastUse({ at: T0 - UNUSED_END_MS, createId: CREATE });
    let failures = 2;
    const monitor = startRun({
      updateRestartPolicy: async () => {
        if (failures-- > 0) throw new EngineError('the daemon is busy', 500);
      },
    });
    expect(await monitor.result).toBe(0);
    expect(monitor.events.filter((event) => event === 'policy own no')).toHaveLength(3);
    expect(monitor.events.at(-1)).toBe('exit');
    // The first look, the second look an hour later, and two tries again, an hour apart.
    expect(monitor.mono()).toBeGreaterThanOrEqual(3 * UNUSED_END_RECHECK_MS);
    expect(monitor.mono()).toBeLessThan(3 * UNUSED_END_RECHECK_MS + 4 * REMOTE_TICK_MS);
    const failed = 'The Monitor could not end itself (its restart policy could not be changed: the daemon is busy). It tries again in 1 hour.';
    expect(monitor.out().split(failed)).toHaveLength(2);
  });

  // A use ends the wait for the next try, so the end that is found 30 days later starts afresh. Mutation: without the
  // reset, the old wait for the next try holds back the first look, and the failure of that end is not logged.
  it('a use after a failed end starts afresh: the next end is found at once, and its failure is logged again', async () => {
    writeLastUse({ at: T0 - UNUSED_END_MS, createId: CREATE });
    let failures = 2;
    let usedAt: number | undefined;
    let foundAgainAt: number | undefined;
    // The clock of the host: 30 days on from 20 minutes after the use (the days between pass without ticks).
    const now = (mono: number): number => T0 + mono + (usedAt !== undefined && mono >= usedAt + 20 * MINUTE ? UNUSED_END_MS : 0);
    const found = 'No window used Devspaces on this Docker engine for 30 days. The Monitor looks again in 1 hour; then it ends itself.';
    const monitor = startRun({
      now,
      updateRestartPolicy: async (policy) => {
        if (policy === 'no' && failures-- > 0) throw new EngineError('the daemon is busy', 500);
      },
      onTick: async (mono) => {
        // A heartbeat of a window ten minutes after the failed end.
        if (usedAt === undefined && mono >= UNUSED_END_RECHECK_MS + 10 * MINUTE) {
          usedAt = mono;
          await recordUse(stateDir, PERMANENT_ENV, now(mono));
        }
        // The tick after the check that found the time without use again.
        if (foundAgainAt === undefined && monitor.out().split(found).length === 3) foundAgainAt = mono;
      },
    });
    expect(await monitor.result).toBe(0);
    expect(monitor.out()).toContain('A window used Devspaces on this Docker engine again; the Monitor does not end itself.');
    // The first check after the 30 days found them, not the next try an hour after the failure.
    expect(foundAgainAt).toBe(usedAt! + 20 * MINUTE + REMOTE_TICK_MS);
    const failed = 'The Monitor could not end itself (its restart policy could not be changed: the daemon is busy). It tries again in 1 hour.';
    expect(monitor.out().split(failed)).toHaveLength(3);
    expect(monitor.events.filter((event) => event === 'policy own no')).toHaveLength(3);
    expect(monitor.events.at(-1)).toBe('exit');
  }, 20_000);

  it('does not end without the nonce of its create, or when the list does not name one container', async () => {
    writeLastUse({ at: T0 - UNUSED_END_MS });
    const ticks = Math.ceil((3 * UNUSED_END_RECHECK_MS) / REMOTE_TICK_MS);
    const without = startRun({ env: { DEVSPACE_MONITOR_PERMANENT: '1', DEVSPACE_IMAGE_FIRST_MS: '86400000' }, maxTicks: ticks });
    await vi.waitFor(() => expect(without.ticks()).toBe(ticks), { timeout: 10_000 });
    expect(await pending(without.result)).toBe('pending');
    expect(without.out()).toContain('The Monitor could not end itself (it does not know its container: the nonce of its create is missing). It tries again in 1 hour.');
    expect(without.events).toEqual([]);

    writeLastUse({ at: T0 - UNUSED_END_MS, createId: CREATE });
    const none = startRun({ engine: { containerIds: async () => [] }, maxTicks: ticks });
    await vi.waitFor(() => expect(none.ticks()).toBe(ticks), { timeout: 10_000 });
    expect(await pending(none.result)).toBe('pending');
    expect(none.out()).toContain('The Monitor could not end itself (0 containers have the nonce of its create). It tries again in 1 hour.');
    expect(none.events).toEqual([]);
  }, 20_000);

  it('a monitor that ends when idle never ends itself by the time without use', async () => {
    writeLastUse({ at: T0 - UNUSED_END_MS, createId: CREATE });
    const idle = startRun({ env: { DEVSPACE_MONITOR_CREATE_ID: CREATE, DEVSPACE_IMAGE_FIRST_MS: '86400000' } });
    expect(await idle.result).toBe(0);
    expect(idle.out()).toContain('it does not run permanently; the Monitor exits.');
    expect(idle.out()).not.toContain('No window used Devspaces');
    expect(idle.events).toEqual([]);
  });

  // A run that "Update All Images Now" asked for (a due run waits after the time without use was found, below).
  it('waits for a background run that runs, and ends after it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    writeLastUse({ at: T0 - UNUSED_END_MS, createId: CREATE });
    fs.writeFileSync(path.join(stateDir, RUN_NOW_FILE), JSON.stringify({ requestedAt: T0 - UNUSED_END_MS }));
    let started!: () => void;
    const runStarted = new Promise<void>((resolve) => (started = resolve));
    let finish!: () => void;
    const gate = new Promise<string>((_resolve, reject) => (finish = () => reject(new Error('ended by the test'))));
    const store = path.join(stateDir, 'store');
    fs.mkdirSync(store);
    const vscode = {
      store: { root: store },
      storeVolume: 'devspaces-vscode',
      extensionStateDir: stateDir,
      engine: {
        ...unusedEngine(),
        architecture: async () => {
          started();
          return gate;
        },
      },
      tryLock: async () => ({ kind: 'busy' as const }),
    } as unknown as NonNullable<ReturnType<typeof vscodeBackgroundDeps>>;
    let first = true;
    const monitor = startRun({
      env: { ...PERMANENT_ENV, DEVSPACE_IMAGE_FIRST_MS: '1000' },
      vscodeBackground: () => vscode,
      onTick: async () => {
        if (!first) return;
        first = false;
        await runStarted;
      },
    });
    await vi.waitFor(() => expect(monitor.out()).toContain('first check in 1 s'));
    await vi.advanceTimersByTimeAsync(1_000);
    // Well past the second look: the run holds the end back.
    await vi.waitFor(() => expect(monitor.mono()).toBeGreaterThan(2 * UNUSED_END_RECHECK_MS), { timeout: 10_000 });
    expect(monitor.events).toEqual([]);
    finish();
    expect(await monitor.result).toBe(0);
    expect(monitor.events).toEqual([expect.stringMatching(/^list /), 'policy own no', 'exit']);
    expect(monitor.out().indexOf('the Monitor ends itself')).toBeGreaterThan(monitor.out().indexOf('The background run ended.'));
  }, 20_000);

  // Typical after Docker was off for a month: at the first check after the start the run is due, but the time without
  // use was found first. Mutation: a schedule without the pause starts the run, and the end waits for it.
  it('starts no background run that is only due after it found the time without use, and ends without one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    writeLastUse({ at: T0 - UNUSED_END_MS, createId: CREATE });
    const store = path.join(stateDir, 'store');
    fs.mkdirSync(store);
    let runs = 0;
    const vscode = {
      store: { root: store },
      storeVolume: 'devspaces-vscode',
      extensionStateDir: stateDir,
      engine: {
        ...unusedEngine(),
        architecture: async () => {
          runs += 1;
          return 'amd64';
        },
      },
      tryLock: async () => ({ kind: 'busy' as const }),
    } as unknown as NonNullable<ReturnType<typeof vscodeBackgroundDeps>>;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    const monitor = startRun({
      env: { ...PERMANENT_ENV, DEVSPACE_IMAGE_FIRST_MS: '1000' },
      vscodeBackground: () => vscode,
      onTick: async () => {
        if (!first) return;
        first = false;
        await held;
      },
    });
    // The first look found the time without use; then the first check of the schedule comes.
    await vi.waitFor(() => expect(monitor.out()).toContain('The Monitor looks again in 1 hour'));
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(monitor.out()).toContain('The background run is due, but it does not start'));
    release();
    expect(await monitor.result).toBe(0);
    expect(runs).toBe(0);
    expect(monitor.out()).not.toContain('The background run starts.');
    expect(monitor.events).toEqual([expect.stringMatching(/^list /), 'policy own no', 'exit']);
  });

  // The ensure of a window can accept the monitor while it is still "unless-stopped", just before it ends; the window
  // then uses it ("Update All Images Now" here). Mutation: the exit without the look at the use loses the request.
  it('a use that comes while it ends sets the restart policy back, and it goes on; the request waits for the schedule', async () => {
    writeLastUse({ at: T0 - UNUSED_END_MS, createId: CREATE });
    let mono = 0;
    const monitor = startRun({
      updateRestartPolicy: async (policy) => {
        if (policy !== 'no') return;
        expect(await main(['run-now'], { env: PERMANENT_ENV, stateDir, now: () => T0 + mono, err: () => {} })).toBe(0);
      },
      onTick: (now) => void (mono = now),
      maxTicks: Math.ceil((3 * UNUSED_END_RECHECK_MS) / REMOTE_TICK_MS),
    });
    await vi.waitFor(() => expect(monitor.ticks()).toBe(Math.ceil((3 * UNUSED_END_RECHECK_MS) / REMOTE_TICK_MS)), { timeout: 10_000 });
    expect(await pending(monitor.result)).toBe('pending');
    expect(monitor.events).toEqual([LIST, 'policy own no', LIST, 'policy own unless-stopped']);
    expect(monitor.out()).toContain('A window used Devspaces on this Docker engine while the Monitor was ending; the Monitor goes on. Its restart policy is "unless-stopped" again.');
    expect(monitor.out()).not.toContain('the Monitor ends itself');
    // The request stays for the next check of the schedule (a request runs whether a run is due or not).
    expect(fs.existsSync(path.join(stateDir, RUN_NOW_FILE))).toBe(true);
  }, 20_000);

  // With the restart policy "no", Docker would not start it again, so it exits, and the next open creates it again.
  // Mutation: a monitor that goes on after the failed change never exits (and tries the change again and again).
  it('a use that comes while it ends, when the restart policy cannot be set back: it says why and exits with 0', async () => {
    writeLastUse({ at: T0 - UNUSED_END_MS, createId: CREATE });
    let mono = 0;
    const monitor = startRun({
      updateRestartPolicy: async (policy) => {
        if (policy === 'no') await recordUse(stateDir, PERMANENT_ENV, T0 + mono);
        else throw new EngineError('the daemon is busy', 500);
      },
      onTick: (now) => void (mono = now),
    });
    expect(await monitor.result).toBe(0);
    expect(monitor.events).toEqual([LIST, 'policy own no', LIST, 'policy own unless-stopped', 'exit']);
    const out = monitor.out();
    expect(out).toContain('A window used Devspaces on this Docker engine while the Monitor was ending, but the Monitor cannot go on (its restart policy could not be changed: the daemon is busy).');
    expect(out).not.toContain('the Monitor goes on');
    expect(out.indexOf('the Monitor ends itself')).toBeGreaterThan(out.indexOf('cannot go on'));
  });

  it('a request of "Update All Images Now" that comes while it ends, without a use, runs before the exit', async () => {
    writeLastUse({ at: T0 - UNUSED_END_MS, createId: CREATE });
    let runs = 0;
    const monitor = startRun({
      vscodeBackground: () =>
        countedVscode(() => {
          runs += 1;
          return 'amd64';
        }),
      updateRestartPolicy: async (policy) => {
        if (policy === 'no') fs.writeFileSync(path.join(stateDir, RUN_NOW_FILE), JSON.stringify({ requestedAt: T0 }));
      },
      // From the end on, each tick takes a moment, so that the run ends within the ticks of the test.
      onTick: async () => {
        if (monitor.events.includes('policy own no')) await new Promise((resolve) => setTimeout(resolve, 2));
      },
    });
    expect(await monitor.result).toBe(0);
    expect(runs).toBe(1);
    expect(fs.existsSync(path.join(stateDir, RUN_NOW_FILE))).toBe(false);
    expect(monitor.events).toEqual([LIST, 'policy own no', 'exit']);
    expect(monitor.out().indexOf('the Monitor ends itself')).toBeGreaterThan(monitor.out().indexOf('The background run ended.'));
  });

  // The timer of the schedule starts a run between the end and the exit. Mutation: the exit without the second look
  // at a run that runs cuts that run.
  it('a run that starts while it ends holds the exit back until the run ended', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    writeLastUse({ at: T0 - UNUSED_END_MS, createId: CREATE });
    let started!: () => void;
    const runStarted = new Promise<void>((resolve) => (started = resolve));
    let finish!: () => void;
    const gate = new Promise<string>((resolve) => (finish = () => resolve('amd64')));
    const monitor = startRun({
      env: { ...PERMANENT_ENV, DEVSPACE_IMAGE_FIRST_MS: '1000' },
      vscodeBackground: () =>
        countedVscode(() => {
          started();
          return gate;
        }),
      updateRestartPolicy: async (policy) => {
        if (policy !== 'no') return;
        // A request, and the first check of the schedule: the run starts while the policy changes.
        fs.writeFileSync(path.join(stateDir, RUN_NOW_FILE), JSON.stringify({ requestedAt: T0 }));
        await vi.advanceTimersByTimeAsync(1_000);
        await runStarted;
      },
    });
    await vi.waitFor(() => expect(monitor.events).toContain('policy own no'));
    const endedAt = monitor.mono();
    await vi.waitFor(() => expect(monitor.mono()).toBeGreaterThan(endedAt + 10 * REMOTE_TICK_MS));
    expect(await stillPending(monitor.result)).toBe(true);
    expect(monitor.events).toEqual([LIST, 'policy own no']);
    finish();
    expect(await monitor.result).toBe(0);
    expect(monitor.events).toEqual([LIST, 'policy own no', 'exit']);
    expect(monitor.out().indexOf('the Monitor ends itself')).toBeGreaterThan(monitor.out().indexOf('The background run ended.'));
  });

  // Typical after a month without use: the first Start of the user comes while the Monitor waits for its second look.
  // Mutation: without the reads during the wait, the due run waits for the second look an hour later.
  it('a use that comes while it waits for the second look ends the pause at the next check: a due run starts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    writeLastUse({ at: T0 - UNUSED_END_MS, createId: CREATE });
    let runs = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let releaseUsed!: () => void;
    const heldAfterUse = new Promise<void>((resolve) => (releaseUsed = resolve));
    let first = true;
    let usedAt: number | undefined;
    const monitor = startRun({
      env: { ...PERMANENT_ENV, DEVSPACE_IMAGE_FIRST_MS: '1000' },
      vscodeBackground: () =>
        countedVscode(() => {
          runs += 1;
          return 'amd64';
        }),
      onTick: async (mono) => {
        if (first) {
          first = false;
          await held;
        }
        // A heartbeat of the window of the Start ten minutes after the first look; the test holds the loop two ticks later.
        if (usedAt === undefined && mono >= 10 * MINUTE) {
          usedAt = mono;
          await recordUse(stateDir, PERMANENT_ENV, T0 + mono);
        }
        if (usedAt !== undefined && mono >= usedAt + 2 * REMOTE_TICK_MS) await heldAfterUse;
      },
    });
    await vi.waitFor(() => expect(monitor.out()).toContain('The Monitor looks again in 1 hour'));
    // The first check of the schedule: the run is due, but it waits.
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(monitor.out()).toContain('The background run is due, but it does not start'));
    release();
    await vi.waitFor(() => expect(monitor.mono()).toBe(usedAt! + 2 * REMOTE_TICK_MS), { timeout: 10_000 });
    expect(monitor.out()).toContain('A window used Devspaces on this Docker engine again; the Monitor does not end itself.');
    // The next check of the schedule starts the due run, long before the second look.
    await vi.advanceTimersByTimeAsync(IMAGE_CHECK_MS);
    await vi.waitFor(() => expect(runs).toBe(1));
    expect(monitor.mono()).toBeLessThan(UNUSED_END_RECHECK_MS);
    releaseUsed();
    expect(await stillPending(monitor.result)).toBe(true);
    expect(monitor.events).toEqual([]);
  }, 20_000);

  // After a failed end it tries again an hour later; a use meanwhile ends the pause as during the wait for the second
  // look. Mutation: without the reads while it waits for the next try, the due run waits for that try.
  it('a use that comes while it waits to try a failed end again ends the pause at the next check: a due run starts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    writeLastUse({ at: T0 - UNUSED_END_MS, createId: CREATE });
    let runs = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let releaseUsed!: () => void;
    const heldAfterUse = new Promise<void>((resolve) => (releaseUsed = resolve));
    let first = true;
    let usedAt: number | undefined;
    const monitor = startRun({
      env: { ...PERMANENT_ENV, DEVSPACE_IMAGE_FIRST_MS: '1000' },
      vscodeBackground: () =>
        countedVscode(() => {
          runs += 1;
          return 'amd64';
        }),
      // No container has the nonce of its create, so the end fails.
      engine: { containerIds: async () => [] },
      onTick: async (mono) => {
        if (first) {
          first = false;
          await held;
        }
        // A heartbeat of the window of a Start ten minutes after the failed end; the test holds the loop two ticks later.
        if (usedAt === undefined && mono >= UNUSED_END_RECHECK_MS + 10 * MINUTE) {
          usedAt = mono;
          await recordUse(stateDir, PERMANENT_ENV, T0 + mono);
        }
        if (usedAt !== undefined && mono >= usedAt + 2 * REMOTE_TICK_MS) await heldAfterUse;
      },
      maxTicks: Math.ceil((UNUSED_END_RECHECK_MS + 20 * MINUTE) / REMOTE_TICK_MS),
    });
    await vi.waitFor(() => expect(monitor.out()).toContain('The Monitor looks again in 1 hour'));
    // The first check of the schedule: the run is due, but it waits.
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(monitor.out()).toContain('The background run is due, but it does not start'));
    release();
    await vi.waitFor(() => expect(monitor.mono()).toBe(usedAt! + 2 * REMOTE_TICK_MS), { timeout: 10_000 });
    expect(monitor.out()).toContain('The Monitor could not end itself (0 containers have the nonce of its create). It tries again in 1 hour.');
    expect(monitor.out()).toContain('A window used Devspaces on this Docker engine again; the Monitor does not end itself.');
    // The next check of the schedule starts the due run, long before the next try.
    await vi.advanceTimersByTimeAsync(IMAGE_CHECK_MS);
    await vi.waitFor(() => expect(runs).toBe(1));
    expect(monitor.mono()).toBeLessThan(2 * UNUSED_END_RECHECK_MS);
    releaseUsed();
    expect(await stillPending(monitor.result)).toBe(true);
  }, 20_000);
});
