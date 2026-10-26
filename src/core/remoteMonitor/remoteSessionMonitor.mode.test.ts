// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The container of the Monitor by its mode, the same on every engine: a permanent monitor (stopMonitorWhenIdle off, the
// default) has the restart policy `unless-stopped`, its part of the label and the ID of the computer that created it
// (LABEL_MONITOR_OWNER); one that ends when idle `on-failure` and no owner; both have the default network and the shared
// VS Code server store of the worker. A change of the mode replaces the container, except that an ensure of a monitor
// that ends when idle takes a running permanent one of the same version that another computer owns as current.
import { describe, expect, it } from 'vitest';
import type { Logger } from '../ports';
import type { MonitorCreated, MonitorRunSpec } from '../worker/dockerEngine';
import type { MonitorEngine, MonitorInspected } from './monitorEngine';
import { LABEL_MONITOR_OWNER, PERMANENT_LABEL_PART, remoteMonitorLabelValue, vscodeStoreLabelPart } from './protocol';
import { RemoteSessionMonitor, monitorLabel } from './remoteSessionMonitor';

const SCRIPT = 'console.log("monitor")';
const TAG = 'devspaces-worker:0123456789ab';
const SOCKET = '/var/run/docker.sock';
const ID = 'feed'.padEnd(64, '1');
const IMAGES = { schedule: '17', timeZone: 'UTC' };
const IDLE = monitorLabel(SCRIPT, TAG, 'idle');
const PERMANENT = monitorLabel(SCRIPT, TAG, 'permanent');
/** This computer, and another one that uses the same engine. */
const ME = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);

const logger = (): Logger => ({ info: () => {}, warn: () => {}, error: () => {}, output: () => {} });

/** A MonitorEngine in memory: the container of the name (`found`, one per inspect, the last one repeats), and its calls. */
function fakeEngine(found: MonitorInspected[], created: MonitorCreated[] = [{ kind: 'ready' }]) {
  const calls: string[] = [];
  const specs: MonitorRunSpec[] = [];
  let looks = 0;
  let creates = 0;
  const engine: MonitorEngine = {
    inspect: async () => {
      calls.push('inspect');
      return found[Math.min(looks++, found.length - 1)];
    },
    daemonTime: async () => Date.now(),
    remove: async (id) => void calls.push(`remove ${id}`),
    start: async (id) => void calls.push(`start ${id}`),
    storedScript: async () => 'unknown',
    idsWithLabel: async () => [],
    create: async (spec) => {
      calls.push('create');
      specs.push(spec);
      return created[Math.min(creates++, created.length - 1)];
    },
  };
  return { engine, calls, specs };
}

const running = (label: string, owner?: string): MonitorInspected => ({ exists: true, status: 'running', exitCode: 0, label, restartCount: 0, id: ID, createdAt: undefined, ...(owner !== undefined ? { owner } : {}) });
const exited = (label: string, owner?: string): MonitorInspected => ({ exists: true, status: 'exited', exitCode: 0, label, restartCount: 0, id: ID, createdAt: undefined, ...(owner !== undefined ? { owner } : {}) });

/** A monitor of this computer (`computer`: its ID; null: none known). */
function monitorOf(engine: MonitorEngine, permanent: boolean | undefined, store?: string, computer: string | null = ME): RemoteSessionMonitor {
  return new RemoteSessionMonitor({
    engine,
    logger: logger(),
    script: async () => SCRIPT,
    imageMaintenance: () => ({ ...IMAGES, ...(permanent !== undefined ? { permanent } : {}), ...(computer !== null ? { computer } : {}) }),
    ...(store !== undefined ? { vscodeStoreVolume: store } : {}),
  });
}

describe('the container of the Monitor by its mode', () => {
  it('a permanent monitor: unless-stopped, its variable, its label part, its owner; one that ends when idle: on-failure, none of them', () => {
    const { engine } = fakeEngine([{ exists: false }]);
    const permanent = monitorOf(engine, true).runSpec(TAG, SOCKET, PERMANENT, SCRIPT, { ...IMAGES, permanent: true, computer: ME });
    expect(permanent.restartPolicy).toBe('unless-stopped');
    expect(permanent.env.DEVSPACE_MONITOR_PERMANENT).toBe('1');
    expect(permanent.labels[LABEL_MONITOR_OWNER]).toBe(ME);
    expect(LABEL_MONITOR_OWNER).toBe('nimblescape.devspaces.monitor-owner');
    expect(PERMANENT).toBe(remoteMonitorLabelValue(SCRIPT, TAG, [PERMANENT_LABEL_PART]));
    expect(IDLE).toBe(remoteMonitorLabelValue(SCRIPT, TAG, []));
    expect(PERMANENT).not.toBe(IDLE);
    // Without a known computer: no owner.
    expect(monitorOf(engine, true).runSpec(TAG, SOCKET, PERMANENT, SCRIPT, { ...IMAGES, permanent: true }).labels).not.toHaveProperty(LABEL_MONITOR_OWNER);
    for (const images of [{ ...IMAGES, permanent: false, computer: ME }, IMAGES, undefined]) {
      const idle = monitorOf(engine, false).runSpec(TAG, SOCKET, IDLE, SCRIPT, images);
      expect(idle.restartPolicy).toBe('on-failure');
      expect(idle.env).not.toHaveProperty('DEVSPACE_MONITOR_PERMANENT');
      expect(idle.labels).not.toHaveProperty(LABEL_MONITOR_OWNER);
    }
  });

  it('always has the default network, with or without prefixes, in either mode', () => {
    const { engine } = fakeEngine([{ exists: false }]);
    for (const images of [undefined, IMAGES, { ...IMAGES, prefixes: ['ghcr.io/acme/base'] }, { ...IMAGES, permanent: true }]) {
      expect(monitorOf(engine, undefined).runSpec(TAG, SOCKET, IDLE, SCRIPT, images).network).toBe('default');
    }
  });

  it('mounts the store of the worker read-write at /vscode and names it; without one, no store', () => {
    const { engine } = fakeEngine([{ exists: false }]);
    const spec = monitorOf(engine, false, 'devspaces-test-vscode').runSpec(TAG, SOCKET, IDLE, SCRIPT, IMAGES);
    expect(spec.mounts).toEqual({ socket: SOCKET, volume: 'devspaces-monitor', volumeTarget: '/state', store: { volume: 'devspaces-test-vscode', target: '/vscode' } });
    expect(spec.env.DEVSPACE_VSCODE_STORE).toBe('devspaces-test-vscode');
    const without = monitorOf(engine, false).runSpec(TAG, SOCKET, IDLE, SCRIPT, IMAGES);
    expect(without.mounts).toEqual({ socket: SOCKET, volume: 'devspaces-monitor', volumeTarget: '/state' });
    expect(without.env).not.toHaveProperty('DEVSPACE_VSCODE_STORE');
  });

  it('creates a missing monitor with the label of its mode, a permanent one with this computer as its owner', async () => {
    for (const [permanent, label] of [
      [true, PERMANENT],
      [false, IDLE],
    ] as const) {
      const { engine, specs } = fakeEngine([{ exists: false }]);
      expect(await monitorOf(engine, permanent).ensureOrThrow(TAG, SOCKET)).toBe('created');
      expect(specs[0].labels['nimblescape.devspaces.monitor']).toBe(label);
      expect(specs[0].labels[LABEL_MONITOR_OWNER]).toBe(permanent ? ME : undefined);
      expect(specs[0].restartPolicy).toBe(permanent ? 'unless-stopped' : 'on-failure');
    }
  });
});

describe('the change of the mode at the next ensure', () => {
  it('keeps a running monitor of the same mode', async () => {
    for (const [permanent, found] of [
      [true, running(PERMANENT, ME)],
      [false, running(IDLE)],
    ] as const) {
      const { engine, calls } = fakeEngine([found]);
      expect(await monitorOf(engine, permanent).ensureOrThrow(TAG, SOCKET)).toBe('running');
      expect(calls).toEqual(['inspect']);
    }
  });

  it('replaces a running monitor that ends when idle by a permanent one (the setting turned off)', async () => {
    const { engine, calls, specs } = fakeEngine([running(IDLE)]);
    expect(await monitorOf(engine, true).ensureOrThrow(TAG, SOCKET)).toBe('created');
    expect(calls).toEqual(['inspect', `remove ${ID}`, 'create']);
    expect(specs[0].restartPolicy).toBe('unless-stopped');
  });

  it('a permanent monitor of another version, or one that does not run, is replaced by one that ends when idle', async () => {
    const other = fakeEngine([running(monitorLabel('console.log("older")', TAG, 'permanent'), OTHER)]);
    expect(await monitorOf(other.engine, false).ensureOrThrow(TAG, SOCKET)).toBe('created');
    expect(other.specs[0].restartPolicy).toBe('on-failure');
    const stopped = fakeEngine([exited(PERMANENT, OTHER)]);
    expect(await monitorOf(stopped.engine, false).ensureOrThrow(TAG, SOCKET)).toBe('created');
    expect(stopped.calls).toEqual(['inspect', `remove ${ID}`, 'create']);
  });

  it('a name conflict of the create: a running permanent monitor of another computer counts as current for one that ends when idle', async () => {
    const conflict: MonitorCreated = { kind: 'exited', detail: 'Conflict. The container name "/devspaces-monitor" is already in use', conflict: true };
    const { engine, calls } = fakeEngine([{ exists: false }, running(PERMANENT, OTHER)], [conflict]);
    expect(await monitorOf(engine, false).ensureOrThrow(TAG, SOCKET)).toBe('running');
    expect(calls).toEqual(['inspect', 'create', 'inspect']);
    // A permanent ensure does not take one that ends when idle there.
    const other = fakeEngine([{ exists: false }, running(IDLE)], [conflict]);
    await expect(monitorOf(other.engine, true).ensureOrThrow(TAG, SOCKET)).rejects.toThrow(/docker run failed/);
  });
});

// The owner of a permanent monitor: turning stopMonitorWhenIdle on takes effect at the next ensure of this computer,
// while a permanent monitor that another computer keeps on the same engine stays (no ping-pong between two computers
// with other settings).
describe('the owner of a permanent monitor', () => {
  it('an ensure with the setting on replaces this computer\'s own running permanent monitor', async () => {
    const { engine, calls, specs } = fakeEngine([running(PERMANENT, ME)]);
    expect(await monitorOf(engine, false).ensureOrThrow(TAG, SOCKET)).toBe('created');
    expect(calls).toEqual(['inspect', `remove ${ID}`, 'create']);
    expect(specs[0].restartPolicy).toBe('on-failure');
    expect(specs[0].labels['nimblescape.devspaces.monitor']).toBe(IDLE);
  });

  it('an ensure with the setting on keeps a running permanent monitor of another computer, or of no known owner', async () => {
    for (const found of [running(PERMANENT, OTHER), running(PERMANENT)]) {
      const { engine, calls } = fakeEngine([found]);
      expect(await monitorOf(engine, false).ensureOrThrow(TAG, SOCKET)).toBe('running');
      expect(calls).toEqual(['inspect']);
    }
    // An ensure that does not know its computer keeps any running permanent one; without the mode (an older wiring)
    // too.
    for (const permanent of [false, undefined]) {
      const { engine, calls } = fakeEngine([running(PERMANENT, ME)]);
      expect(await monitorOf(engine, permanent, undefined, null).ensureOrThrow(TAG, SOCKET)).toBe('running');
      expect(calls).toEqual(['inspect']);
    }
  });

  it('a permanent ensure keeps a running permanent monitor of another computer (it is not created again)', async () => {
    const { engine, calls } = fakeEngine([running(PERMANENT, OTHER)]);
    expect(await monitorOf(engine, true).ensureOrThrow(TAG, SOCKET)).toBe('running');
    expect(calls).toEqual(['inspect']);
  });

  it('two computers with other settings do not replace each other: the permanent monitor stays', async () => {
    // This computer wants it permanent and creates it; the other one, with the setting on, keeps it.
    const first = fakeEngine([{ exists: false }]);
    await monitorOf(first.engine, true).ensureOrThrow(TAG, SOCKET);
    const owner = first.specs[0].labels[LABEL_MONITOR_OWNER];
    const second = fakeEngine([running(first.specs[0].labels['nimblescape.devspaces.monitor'], owner)]);
    expect(await monitorOf(second.engine, false, undefined, OTHER).ensureOrThrow(TAG, SOCKET)).toBe('running');
    expect(second.calls).toEqual(['inspect']);
  });
});

// A permanent monitor that ended itself after 30 days without use has the restart policy `no`
// (src/remoteMonitor/main.ts): the next ensure replaces it, so Docker starts it again after a restart of the engine. The
// policy is that of the mode of its own label, so a permanent monitor of another computer stays.
describe('the restart policy of the monitor', () => {
  const withPolicy = (found: MonitorInspected, restartPolicy: string): MonitorInspected => ({ ...found, restartPolicy }) as MonitorInspected;

  it('replaces a monitor that ended itself (policy "no"), exited or running, instead of starting it', async () => {
    for (const found of [withPolicy(exited(PERMANENT, ME), 'no'), withPolicy(running(PERMANENT, ME), 'no')]) {
      const { engine, calls, specs } = fakeEngine([found]);
      expect(await monitorOf(engine, true).ensureOrThrow(TAG, SOCKET)).toBe('created');
      expect(calls).toEqual(['inspect', `remove ${ID}`, 'create']);
      expect(specs[0].restartPolicy).toBe('unless-stopped');
    }
    // One that ends when idle with another policy than `on-failure` too.
    const idle = fakeEngine([withPolicy(exited(IDLE), 'no')]);
    expect(await monitorOf(idle.engine, false).ensureOrThrow(TAG, SOCKET)).toBe('created');
    expect(idle.calls).toEqual(['inspect', `remove ${ID}`, 'create']);
  });

  it('keeps a monitor with the policy of its mode, and one whose policy cannot be read', async () => {
    for (const [permanent, found] of [
      [true, withPolicy(running(PERMANENT, ME), 'unless-stopped')],
      [false, withPolicy(running(IDLE), 'on-failure')],
      [true, running(PERMANENT, ME)],
    ] as const) {
      const { engine, calls } = fakeEngine([found]);
      expect(await monitorOf(engine, permanent).ensureOrThrow(TAG, SOCKET)).toBe('running');
      expect(calls).toEqual(['inspect']);
    }
    // An exited one that ends when idle is started again, as before.
    const stopped = fakeEngine([withPolicy(exited(IDLE), 'on-failure')]);
    await monitorOf(stopped.engine, false).ensureOrThrow(TAG, SOCKET);
    expect(stopped.calls.slice(0, 2)).toEqual(['inspect', `start ${ID}`]);
  });

  it('an ensure that wants one that ends when idle keeps the permanent monitor of another computer by the policy of its label', async () => {
    const kept = fakeEngine([withPolicy(running(PERMANENT, OTHER), 'unless-stopped')]);
    expect(await monitorOf(kept.engine, false).ensureOrThrow(TAG, SOCKET)).toBe('running');
    expect(kept.calls).toEqual(['inspect']);
    // That one with the policy `no` is replaced.
    const ended = fakeEngine([withPolicy(running(PERMANENT, OTHER), 'no')]);
    expect(await monitorOf(ended.engine, false).ensureOrThrow(TAG, SOCKET)).toBe('created');
    expect(ended.specs[0].restartPolicy).toBe('on-failure');
  });
});

// The store that the monitor mounts is part of its label.
describe('the store in the label of the monitor', () => {
  const WITH_STORE = monitorLabel(SCRIPT, TAG, 'permanent', 'devspaces-vscode');

  it('the label names the store; without one, none', () => {
    expect(WITH_STORE).toBe(remoteMonitorLabelValue(SCRIPT, TAG, [PERMANENT_LABEL_PART, vscodeStoreLabelPart('devspaces-vscode')]));
    expect(monitorLabel(SCRIPT, TAG, 'idle', 'devspaces-vscode')).toBe(remoteMonitorLabelValue(SCRIPT, TAG, [vscodeStoreLabelPart('devspaces-vscode')]));
    expect(new Set([WITH_STORE, PERMANENT, monitorLabel(SCRIPT, TAG, 'permanent', 'devspaces-other')]).size).toBe(3);
  });

  it('an ensure with the store replaces a running monitor created without it (and the other way round); the same one stays', async () => {
    const without = fakeEngine([running(PERMANENT, ME)]);
    expect(await monitorOf(without.engine, true, 'devspaces-vscode').ensureOrThrow(TAG, SOCKET)).toBe('created');
    expect(without.specs[0].labels['nimblescape.devspaces.monitor']).toBe(WITH_STORE);
    expect(without.specs[0].mounts.store).toEqual({ volume: 'devspaces-vscode', target: '/vscode' });
    const withStore = fakeEngine([running(WITH_STORE, ME)]);
    expect(await monitorOf(withStore.engine, true).ensureOrThrow(TAG, SOCKET)).toBe('created');
    const same = fakeEngine([running(WITH_STORE, ME)]);
    expect(await monitorOf(same.engine, true, 'devspaces-vscode').ensureOrThrow(TAG, SOCKET)).toBe('running');
    // An ensure with the setting on and the store keeps the running permanent one of another computer with that store.
    const idle = fakeEngine([running(WITH_STORE, OTHER)]);
    expect(await monitorOf(idle.engine, false, 'devspaces-vscode').ensureOrThrow(TAG, SOCKET)).toBe('running');
  });
});
