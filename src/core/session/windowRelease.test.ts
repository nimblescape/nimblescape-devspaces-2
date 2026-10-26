// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The release of a devspace that a window leaves.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_LIMIT_SECONDS, MIN_LIMIT_SECONDS } from '../remoteMonitor/protocol';
import type { Devspace, ExtensionSettings, PendingConnection, PendingOperation, WindowStatus } from '../types';
import { HEARTBEAT_ATTEMPT_DEADLINE_MS, WINDOW_HEARTBEAT_INTERVAL_MS } from './windowHeartbeats';
import {
  CLOSE_RELEASE_BOUNDS,
  RELEASE_MARGIN_SECONDS,
  SWITCH_RELEASE_BOUNDS,
  isHandedOffStop,
  otherWindowHoldsDevspace,
  releaseDevspace,
  RELEASE_LIMIT_SECONDS,
  type ReleaseBounds,
  type WindowReleaseDeps,
} from './windowRelease';

const ID_A = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';

function devspace(extra: Partial<Devspace> = {}): Devspace {
  return {
    id: ID_A,
    repository: 'acme/api',
    configPath: '.devcontainer/devcontainer.json',
    volumeName: `devspaces-${ID_A}`,
    containerName: `devspaces-${ID_A}`,
    owner: { id: '1', login: 'octo' },
    createdAt: '2026-10-01T10:00:00.000Z',
    ...extra,
  } as Devspace;
}

function harness(env: Devspace | null = devspace()) {
  const events: string[] = [];
  const logs: string[] = [];
  const settings: Pick<ExtensionSettings, 'stopOnClose' | 'respectShutdownActionNone'> = {
    stopOnClose: true,
    respectShutdownActionNone: false,
  };
  const state = {
    otherWindow: false,
    git: async (_signal: AbortSignal): Promise<unknown> => undefined,
    send: async (_signal: AbortSignal): Promise<{ ok: true } | { ok: false; detail: string }> => ({ ok: true }),
  };
  const sends: Array<{ id: string; limitSeconds: number; signal: AbortSignal }> = [];
  const gitSignals: AbortSignal[] = [];
  const deps: WindowReleaseDeps = {
    registry: { list: async () => (env === null ? [] : [structuredClone(env)]) },
    settings: () => settings,
    otherWindowUses: async () => state.otherWindow,
    recordGitState: async (devspace, signal) => {
      events.push(`git ${devspace.id}`);
      gitSignals.push(signal);
      return state.git(signal);
    },
    send: async (id, limitSeconds, signal) => {
      events.push(`release ${id}`);
      sends.push({ id, limitSeconds, signal });
      return state.send(signal);
    },
    logger: {
      info: (message) => logs.push(`info ${message}`),
      warn: (message) => logs.push(`warn ${message}`),
      error: (message) => logs.push(`error ${message}`),
      output: () => {},
    },
  };
  return { deps, events, logs, settings, state, sends, gitSignals };
}

const BOUNDS: ReleaseBounds = { totalMs: 2_000, gitMs: 1_000 };

afterEach(() => {
  vi.useRealTimers();
});

describe('RELEASE_LIMIT_SECONDS', () => {
  it('is a fixed 5 minutes, within the limits of the protocol', () => {
    expect(RELEASE_LIMIT_SECONDS).toBe(300);
    expect(RELEASE_LIMIT_SECONDS).toBeLessThanOrEqual(MAX_LIMIT_SECONDS);
    expect(RELEASE_MARGIN_SECONDS).toBe((WINDOW_HEARTBEAT_INTERVAL_MS + HEARTBEAT_ATTEMPT_DEADLINE_MS) / 1000);
  });

  it('the release outlasts a reload whose first heartbeat takes a whole attempt and one retry', () => {
    expect(RELEASE_LIMIT_SECONDS).toBeGreaterThanOrEqual(MIN_LIMIT_SECONDS + RELEASE_MARGIN_SECONDS);
    expect(RELEASE_LIMIT_SECONDS * 1000).toBeGreaterThanOrEqual(60_000 + HEARTBEAT_ATTEMPT_DEADLINE_MS + WINDOW_HEARTBEAT_INTERVAL_MS);
  });

  it('the bounds of a close are about 2 s, the Git state within them', () => {
    expect(CLOSE_RELEASE_BOUNDS.totalMs).toBeLessThanOrEqual(2_000);
    expect(CLOSE_RELEASE_BOUNDS.gitMs).toBeLessThan(CLOSE_RELEASE_BOUNDS.totalMs);
    expect(SWITCH_RELEASE_BOUNDS.gitMs).toBeLessThan(SWITCH_RELEASE_BOUNDS.totalMs);
  });
});

describe('releaseDevspace', () => {
  it('records the Git state first, then sends the release with the fixed limit of 5 minutes', async () => {
    const h = harness();
    expect(await releaseDevspace(h.deps, ID_A, BOUNDS)).toBe('released');
    expect(h.events).toEqual([`git ${ID_A}`, `release ${ID_A}`]);
    expect(h.sends[0].limitSeconds).toBe(RELEASE_LIMIT_SECONDS);
    expect(h.logs.some((line) => line.includes('Released acme/api'))).toBe(true);
  });

  it.each([
    ['Keep Running When Closed', { keepRunning: true }, {}],
    ['Close and Keep Running', { keepRunningOnce: true }, {}],
    ['stopOnClose off', {}, { stopOnClose: false }],
    ['a respected "shutdownAction": "none"', { shutdownActionNone: true }, { respectShutdownActionNone: true }],
  ] as const)('sends nothing and records nothing for a kept devspace: %s', async (_name, flags, settings) => {
    const h = harness(devspace(flags));
    Object.assign(h.settings, settings);
    expect(await releaseDevspace(h.deps, ID_A, BOUNDS)).toBe('kept');
    expect(h.events).toEqual([]);
  });

  it('a "shutdownAction": "none" that is not respected is released', async () => {
    const h = harness(devspace({ shutdownActionNone: true }));
    expect(await releaseDevspace(h.deps, ID_A, BOUNDS)).toBe('released');
  });

  it('sends nothing while another live window of this computer shows the devspace, nor for one that is gone', async () => {
    const h = harness();
    h.state.otherWindow = true;
    expect(await releaseDevspace(h.deps, ID_A, BOUNDS)).toBe('inUse');
    const gone = harness(null);
    expect(await releaseDevspace(gone.deps, ID_A, BOUNDS)).toBe('unknown');
    expect([...h.events, ...gone.events]).toEqual([]);
  });

  it('goes on with the release when the Git record fails, and logs it', async () => {
    const h = harness();
    h.state.git = async () => {
      throw new Error('git is missing');
    };
    expect(await releaseDevspace(h.deps, ID_A, BOUNDS)).toBe('released');
    expect(h.events).toEqual([`git ${ID_A}`, `release ${ID_A}`]);
    expect(h.logs.some((line) => line.includes('git is missing'))).toBe(true);
  });

  it('stops waiting for the Git record at its bound (its signal aborts) and still sends the release', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.state.git = () => new Promise(() => {});
    const result = releaseDevspace(h.deps, ID_A, BOUNDS);
    await vi.advanceTimersByTimeAsync(BOUNDS.gitMs);
    expect(await result).toBe('released');
    expect(h.gitSignals[0].aborted).toBe(true);
    expect(h.events).toEqual([`git ${ID_A}`, `release ${ID_A}`]);
  });

  it('ends at the total bound when the release hangs: a failure, and the signal of the send aborts (the long limit applies)', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.state.send = () => new Promise(() => {});
    let outcome: string | undefined;
    const result = releaseDevspace(h.deps, ID_A, BOUNDS).then((value) => (outcome = value));
    await vi.advanceTimersByTimeAsync(BOUNDS.totalMs - 1);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(outcome).toBe('failed');
    expect(h.sends[0].signal.aborted).toBe(true);
  });

  it('a failed release is logged as such and never throws, also when the registry cannot be read', async () => {
    const h = harness();
    h.state.send = async () => ({ ok: false, detail: 'no answer in time' });
    expect(await releaseDevspace(h.deps, ID_A, BOUNDS)).toBe('failed');
    expect(h.logs.some((line) => line.includes('the long limit applies') && line.includes('no answer in time'))).toBe(true);
    h.deps.registry.list = async () => {
      throw new Error('unreadable');
    };
    expect(await releaseDevspace(h.deps, ID_A, BOUNDS)).toBe('failed');
  });
});

// Every release records first that the window was seen using the devspace (for Delete's note), before the Git step,
// so a state that the release records is never older than it.
describe('releaseDevspace: the last use', () => {
  function withSeen(env: Devspace | null = devspace()) {
    const h = harness(env);
    const seen: string[] = [];
    let gitAt = Number.NaN;
    const git = h.deps.recordGitState;
    h.deps.recordGitState = async (devspace, signal) => {
      gitAt = Date.now();
      return git(devspace, signal);
    };
    h.deps.markSeenInUse = async (devspace, at) => {
      h.events.push(`seen ${devspace.id}`);
      seen.push(at);
    };
    return { ...h, seen, gitAt: () => gitAt };
  }

  it('records the last use at the start, before the Git step, with a time not after it', async () => {
    const h = withSeen();
    const before = Date.now();
    expect(await releaseDevspace(h.deps, ID_A, BOUNDS)).toBe('released');
    expect(h.events).toEqual([`seen ${ID_A}`, `git ${ID_A}`, `release ${ID_A}`]);
    expect(h.seen).toHaveLength(1);
    const at = Date.parse(h.seen[0]);
    expect(new Date(at).toISOString()).toBe(h.seen[0]);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(h.gitAt());
  });

  it('also for a kept devspace and one that another window uses (nothing else is sent), not for one that is gone', async () => {
    const kept = withSeen(devspace({ keepRunning: true }));
    expect(await releaseDevspace(kept.deps, ID_A, BOUNDS)).toBe('kept');
    expect(kept.events).toEqual([`seen ${ID_A}`]);
    const inUse = withSeen();
    inUse.state.otherWindow = true;
    expect(await releaseDevspace(inUse.deps, ID_A, BOUNDS)).toBe('inUse');
    expect(inUse.events).toEqual([`seen ${ID_A}`]);
    const gone = withSeen(null);
    expect(await releaseDevspace(gone.deps, ID_A, BOUNDS)).toBe('unknown');
    expect(gone.events).toEqual([]);
  });

  it('goes on when the last use cannot be recorded, and logs it', async () => {
    const h = withSeen();
    h.deps.markSeenInUse = async () => {
      throw new Error('registry locked');
    };
    expect(await releaseDevspace(h.deps, ID_A, BOUNDS)).toBe('released');
    expect(h.events).toEqual([`git ${ID_A}`, `release ${ID_A}`]);
    expect(h.logs.some((line) => line.includes('last use of acme/api') && line.includes('registry locked'))).toBe(true);
    // Also when it throws at once (not as a rejected promise).
    const sync = withSeen();
    sync.deps.markSeenInUse = () => {
      throw new Error('registry gone');
    };
    expect(await releaseDevspace(sync.deps, ID_A, BOUNDS)).toBe('released');
    expect(sync.events).toEqual([`git ${ID_A}`, `release ${ID_A}`]);
    expect(sync.logs.some((line) => line.includes('last use of acme/api') && line.includes('registry gone'))).toBe(true);
  });

  it('a hanging record of the last use neither holds the Git step and the release back nor turns the outcome into a failure', async () => {
    vi.useFakeTimers();
    const h = withSeen();
    h.deps.markSeenInUse = () => new Promise(() => {});
    let outcome: string | undefined;
    const result = releaseDevspace(h.deps, ID_A, BOUNDS).then((value) => (outcome = value));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.events).toEqual([`git ${ID_A}`, `release ${ID_A}`]);
    await vi.advanceTimersByTimeAsync(BOUNDS.totalMs - 1);
    await result;
    expect(outcome).toBe('released');
  });
});

// The windows of one computer share its record of the devspace; a release must not shorten it while another window
// uses the devspace.
describe('otherWindowHoldsDevspace', () => {
  const NOW = Date.parse('2026-10-02T12:00:00.000Z');
  const iso = (ms: number) => new Date(ms).toISOString();
  const alive = (pid: number) => pid === 11 || pid === 22;
  const status = (windowId: string, pid: number, extra: Partial<WindowStatus> = {}): WindowStatus => ({
    windowId,
    pid,
    devspaceId: null,
    state: 'active',
    updatedAt: iso(NOW - 5_000),
    ...extra,
  });

  it('a status file of another live window that shows the devspace', () => {
    const input = { now: NOW, isAlive: alive, windowStatuses: [status('own', 11), status('other', 22, { devspaceId: ID_A })] };
    expect(otherWindowHoldsDevspace(devspace(), 'own', input)).toBe(true);
    // Not the own one, not a closing one, not one of an ended process.
    expect(otherWindowHoldsDevspace(devspace(), 'other', input)).toBe(false);
    expect(otherWindowHoldsDevspace(devspace(), 'own', { ...input, windowStatuses: [status('other', 22, { devspaceId: ID_A, state: 'closing' })] })).toBe(false);
    expect(otherWindowHoldsDevspace(devspace(), 'own', { ...input, windowStatuses: [status('other', 33, { devspaceId: ID_A })] })).toBe(false);
  });

  // Mutation: a release rule that looks at devspaceId only lets the Monitor stop the devspace under that window.
  it('a status file of another live window that works without Devspaces on the devspace (an engine with the removal mark)', () => {
    const input = { now: NOW, isAlive: alive, windowStatuses: [status('own', 11), status('other', 22, { plainDevspaceId: ID_A })] };
    expect(otherWindowHoldsDevspace(devspace(), 'own', input)).toBe(true);
    expect(otherWindowHoldsDevspace(devspace(), 'own', { ...input, windowStatuses: [status('other', 33, { plainDevspaceId: ID_A })] })).toBe(false);
  });

  it('a fresh pending connection file of another window (it opens the devspace)', () => {
    const pending = (windowId: string, at: number): PendingConnection => ({ devspaceId: ID_A, windowId, createdAt: iso(at) });
    const input = { now: NOW, isAlive: alive, windowStatuses: [], pendings: [pending('other', NOW - 10_000)] };
    expect(otherWindowHoldsDevspace(devspace(), 'own', input)).toBe(true);
    expect(otherWindowHoldsDevspace(devspace(), 'own', { ...input, pendings: [pending('own', NOW - 10_000)] })).toBe(false);
    expect(otherWindowHoldsDevspace(devspace(), 'own', { ...input, pendings: [pending('other', NOW - 10 * 60_000)] })).toBe(false);
  });

  it('a live busy mark of another window (an open or a rebuild runs there), not the own one nor one that ended', () => {
    const busy = (windowId: string, pid: number, since = NOW - 60_000) => devspace({ busy: { operation: 'rebuild', since: iso(since), pid, windowId } });
    const windowStatuses = [status('own', 11), status('other', 22)];
    const input = { now: NOW, isAlive: alive, windowStatuses };
    expect(otherWindowHoldsDevspace(busy('other', 22), 'own', input)).toBe(true);
    expect(otherWindowHoldsDevspace(busy('own', 11), 'own', input)).toBe(false);
    // Its process ended, it ended (since = the epoch), or its window has no recent status file.
    expect(otherWindowHoldsDevspace(busy('other', 33), 'own', input)).toBe(false);
    expect(otherWindowHoldsDevspace(busy('other', 22, 0), 'own', input)).toBe(false);
    expect(otherWindowHoldsDevspace(busy('other', 22), 'own', { ...input, windowStatuses: [status('own', 11)] })).toBe(false);
  });

  it('nothing else', () => {
    expect(otherWindowHoldsDevspace(devspace(), 'own', { now: NOW, isAlive: alive })).toBe(false);
  });

  it('releaseDevspace asks with the devspace from the registry, and sends nothing while another window holds it', async () => {
    const h = harness(devspace({ busy: { operation: 'rebuild', since: iso(NOW), pid: 22, windowId: 'other' } }));
    const asked: Devspace[] = [];
    h.deps.otherWindowUses = async (env) => {
      asked.push(env);
      return env.busy?.windowId === 'other';
    };
    expect(await releaseDevspace(h.deps, ID_A, BOUNDS)).toBe('inUse');
    expect(asked.map((env) => env.id)).toEqual([ID_A]);
    expect(h.events).toEqual([]);
  });
});

// A window that handed off a manual Stop sends the stopNow heartbeat instead of its release, once its connection really
// closes (its deactivate()).
describe('releaseDevspace of a handed-off Stop', () => {
  function withStop(env: Devspace = devspace(), handedOff: () => Promise<boolean> = async () => true) {
    const h = harness(env);
    const stop = { answer: async (): Promise<{ ok: true } | { ok: false; detail: string }> => ({ ok: true }) };
    h.deps.stop = {
      handedOff,
      send: async (id) => {
        h.events.push(`stop ${id}`);
        return stop.answer();
      },
    };
    return { ...h, stop };
  }

  // Mutations: without the stop branch, the release goes (or nothing, for a kept one); the Git state after the stopNow.
  it.each([
    ['not kept', {}],
    ['Keep Running When Closed', { keepRunning: true }],
    ['Close and Keep Running', { keepRunningOnce: true }],
  ] as const)('sends the stopNow first, then records the Git state, and no release: %s', async (_name, flags) => {
    const h = withStop(devspace(flags));
    expect(await releaseDevspace(h.deps, ID_A, BOUNDS)).toBe('stopSent');
    expect(h.events).toEqual([`stop ${ID_A}`, `git ${ID_A}`]);
    expect(h.logs.some((line) => line.includes('The Stop of acme/api was sent to the Monitor'))).toBe(true);
  });

  it('also while another window of this computer shows the devspace (the Stop stops it there too)', async () => {
    const h = withStop();
    h.state.otherWindow = true;
    expect(await releaseDevspace(h.deps, ID_A, BOUNDS)).toBe('stopSent');
    expect(h.events).toEqual([`stop ${ID_A}`, `git ${ID_A}`]);
  });

  // Older monitors: a refused stopNow (or one without an answer) is followed by the release.
  it('a stopNow that fails (an older monitor refuses it) is followed by the release, and logged', async () => {
    const h = withStop();
    h.stop.answer = async () => ({ ok: false, detail: 'Invalid heartbeat.' });
    expect(await releaseDevspace(h.deps, ID_A, BOUNDS)).toBe('released');
    expect(h.events).toEqual([`stop ${ID_A}`, `git ${ID_A}`, `release ${ID_A}`]);
    expect(h.logs.some((line) => line.includes('could not be sent to the Monitor') && line.includes('Invalid heartbeat.'))).toBe(true);
  });

  it('a window without a handed-off Stop, or one that cannot tell, releases as before', async () => {
    const none = withStop(devspace(), async () => false);
    expect(await releaseDevspace(none.deps, ID_A, BOUNDS)).toBe('released');
    expect(none.events).toEqual([`git ${ID_A}`, `release ${ID_A}`]);
    const unknown = withStop(devspace(), async () => {
      throw new Error('EACCES');
    });
    expect(await releaseDevspace(unknown.deps, ID_A, BOUNDS)).toBe('released');
    expect(unknown.events).toEqual([`git ${ID_A}`, `release ${ID_A}`]);
    expect(unknown.logs.some((line) => line.includes('EACCES'))).toBe(true);
  });
});

describe('isHandedOffStop', () => {
  const operation = (extra: Partial<PendingOperation> = {}): PendingOperation => ({
    devspaceId: ID_A,
    operation: 'stop',
    requestedAt: '2026-10-11T10:00:00.000Z',
    requestedBy: 'window-1',
    reason: 'manual',
    ...extra,
  });

  it('only a pending stop of this window', () => {
    expect(isHandedOffStop(operation(), 'window-1')).toBe(true);
    expect(isHandedOffStop(operation({ requestedBy: 'window-2' }), 'window-1')).toBe(false);
    expect(isHandedOffStop(operation({ operation: 'rebuild' }), 'window-1')).toBe(false);
    expect(isHandedOffStop(operation({ operation: 'delete' }), 'window-1')).toBe(false);
    expect(isHandedOffStop(undefined, 'window-1')).toBe(false);
  });
});
