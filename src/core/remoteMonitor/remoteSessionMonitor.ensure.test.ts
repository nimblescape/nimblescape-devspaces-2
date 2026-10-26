// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Mutation probes: the ensure over MonitorEngine (runSpec, create, the clock of the daemon) and parseDockerTime.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../ports';
import { parseDockerTime, type MonitorEngine } from './monitorEngine';
import { REMOTE_MONITOR_READY_TEXT } from './protocol';
import { RemoteSessionMonitor } from './remoteSessionMonitor';

const SCRIPT = 'console.log("monitor")';
const unused = (): never => {
  throw new Error('not expected');
};

function logger(lines: string[]): Logger {
  return { info: (text) => lines.push(text), warn: (text) => lines.push(text), error: (text) => lines.push(text), output: () => {} };
}

function engine(methods: Partial<MonitorEngine>): MonitorEngine {
  return { inspect: unused, daemonTime: unused, remove: unused, start: unused, storedScript: unused, idsWithLabel: unused, create: unused, ...methods };
}

describe('the ensure over MonitorEngine, probes', () => {
  afterEach(() => vi.useRealTimers());

  it('the settings of the background run set the schedule and the time zone, no prefixes', () => {
    const monitor = new RemoteSessionMonitor({ engine: engine({}), logger: logger([]), script: async () => SCRIPT });
    // The schedule and the time zone of the background run always go to the container (the VS Code server and the
    // cleanup always run), and the nonce of the create, by which the monitor finds its own container.
    expect(monitor.runSpec('img', '/sock', 'label', SCRIPT, { schedule: '7 6 * * *', timeZone: 'UTC' }, 'n1').env).toEqual({
      DEVSPACE_IMAGE_SCHEDULE: '7 6 * * *',
      DEVSPACE_IMAGE_TZ: 'UTC',
      DEVSPACE_MONITOR_CREATE_ID: 'n1',
    });
  });

  it('the create waits for the ready text of the monitor', async () => {
    const create = vi.fn(async () => ({ kind: 'ready' as const }));
    const monitor = new RemoteSessionMonitor({ engine: engine({ inspect: async () => ({ exists: false }), create }), logger: logger([]), script: async () => SCRIPT });
    expect(await monitor.ensureOrThrow('devspaces-worker:0123456789ab', '/sock')).toBe('created');
    expect(create).toHaveBeenCalledWith(expect.anything(), expect.any(String), REMOTE_MONITOR_READY_TEXT, undefined);
  });

  it('logs why the clock of the daemon cannot be read', async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const created = { exists: true as const, status: 'created', exitCode: 0, label: 'x', restartCount: 0, id: 'feed'.padEnd(64, '1'), createdAt: 1 };
    const monitor = new RemoteSessionMonitor({ engine: engine({ inspect: async () => created, daemonTime: async () => ({ reason: 'clock gone' }) }), logger: logger(lines), script: async () => SCRIPT });
    const ensuring = monitor.ensureOrThrow('devspaces-worker:0123456789ab', '/sock');
    ensuring.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(ensuring).rejects.toThrow('its age cannot be read');
    expect(lines).toContain('The time of the Docker host cannot be read: clock gone');
  });

  it('parseDockerTime: no second 60', () => {
    expect(parseDockerTime('2026-10-04T12:00:60Z')).toBeUndefined();
  });
});
