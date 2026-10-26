// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The background run of `run` prepares the devspaces of the engine after its other parts, the most recently used
// first by the heartbeat records in the volume; and without the hash of a worker script (a monitor created without
// one), it says so and prepares none.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LABEL_DEVSPACE_ID, LABEL_REPOSITORY, resourceName } from '../core/names';
import type { DockerEngine, EngineContainerSummary } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import { heartbeatDir, lastUsedTimes, main, writeHeartbeat, type MainDeps } from './main';
import type { PrepareWorker } from './prepares';

const T0 = Date.parse('2026-10-11T06:07:00Z');
const SOURCE = '0123456789abcdef0123456789abcdef';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-remote-monitor-11k2c-'));
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const VOLUMES: Record<string, Record<string, string>> = {
  [resourceName('acme/app', A)]: { [LABEL_DEVSPACE_ID]: A, [LABEL_REPOSITORY]: 'acme/app' },
  [resourceName('acme/api', B)]: { [LABEL_DEVSPACE_ID]: B, [LABEL_REPOSITORY]: 'acme/api' },
};

function engine(): DockerEngine {
  return {
    ...unusedEngine(),
    containerSummaries: async (): Promise<EngineContainerSummary[]> => [],
    images: async () => [],
    inspect: async (kind, name) => (kind === 'volume' && VOLUMES[name] !== undefined ? { Name: name, Labels: VOLUMES[name] } : undefined),
    volumeNames: async () => Object.keys(VOLUMES),
    proxy: async () => ({}),
  };
}

async function backgroundRun(extra: Partial<MainDeps>): Promise<string> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
  let mono = 0;
  let out = '';
  void main(['run'], {
    env: { DEVSPACE_MONITOR_PERMANENT: '1', DEVSPACE_IMAGE_FIRST_MS: '1000' },
    stateDir,
    engine: engine(),
    vscodeBackground: () => undefined,
    lockDevspace: async () => ({ kind: 'locked', release: () => {} }),
    exec: (_file, _args, _options, callback) => callback(null, 'removed\n', ''),
    monotonic: () => mono,
    now: () => T0 + mono,
    sleep: async (ms) => {
      mono += ms;
      await new Promise(() => {});
    },
    out: (text) => (out += text),
    ...extra,
  });
  await vi.waitFor(() => expect(out).toContain('first check in 1 s'));
  await vi.advanceTimersByTimeAsync(1_000);
  await vi.waitFor(() => expect(out).toContain('The background run ended.'), { timeout: 4_000 });
  return out;
}

describe('the prepares of the background run of `run`', () => {
  it('prepare each devspace after the other parts, the most recently used first', async () => {
    await writeHeartbeat(heartbeatDir(stateDir), { source: SOURCE, limitSeconds: 600, devspaces: [{ id: B, keepRunning: false, seq: 1 }] }, T0 - 60_000);
    const prepared: string[] = [];
    const worker: PrepareWorker = {
      open: async () => ({
        prepare: async (id) => {
          prepared.push(id);
          return { outcome: 'skipped', detail: 'its images are current (no update)', seconds: 0 };
        },
        close: async () => {},
      }),
    };
    const out = await backgroundRun({ prepareWorker: () => worker });
    expect(prepared).toEqual([B, A]);
    const lines = out.split('\n').map((line) => line.replace(/^\S+ /, ''));
    const api = lines.indexOf('acme/api: no prepare (0 s): its images are current (no update).');
    expect(api).toBeGreaterThan(lines.indexOf('The background run starts.'));
    expect(lines[api + 1]).toBe('acme/app: no prepare (0 s): its images are current (no update).');
    expect(lines[api + 2]).toBe('The background run ended.');
  });

  it('without the hash of a worker script, one line and no prepare', async () => {
    const out = await backgroundRun({});
    expect(out).toContain('No devspace image is prepared: the Monitor was created without the hash of a worker script.');
  });

  it('the last use of each devspace is the time of its newest heartbeat record', async () => {
    await writeHeartbeat(heartbeatDir(stateDir), { source: SOURCE, limitSeconds: 600, devspaces: [{ id: A, keepRunning: false, seq: 1 }] }, T0);
    await writeHeartbeat(heartbeatDir(stateDir), { source: 'f'.repeat(32), limitSeconds: 600, devspaces: [{ id: A, keepRunning: false, seq: 1 }] }, T0 + 5);
    expect(await lastUsedTimes(heartbeatDir(stateDir))).toEqual(new Map([[A, T0 + 5]]));
    expect(await lastUsedTimes(path.join(stateDir, 'missing'))).toEqual(new Map());
  });
});
