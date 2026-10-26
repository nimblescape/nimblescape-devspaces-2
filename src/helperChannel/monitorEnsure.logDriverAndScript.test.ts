// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The log driver of the spec reaches the create of the monitor container, and the operations of the worker that make
// sure of the Monitor (`monitorEnsure`, `monitorRunNow`, `open`) give it the worker's own script: the same file runs the
// Monitor (its entry startMonitor).
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import type { MonitorRunSpec } from '../core/worker/dockerEngine';
import type { EngineApi, EngineRequest } from './engineApi';
import { dockerEngine, type EngineHijack } from './engineClient';

/** The script of the Monitor that each operation got. */
const captured = vi.hoisted(() => ({ scripts: new Map<string, () => string>() }));
vi.mock('./flowOperations', async (original) => {
  const actual = await original<typeof import('./flowOperations')>();
  return {
    ...actual,
    monitorEnsureOperation: (...args: Parameters<typeof actual.monitorEnsureOperation>) => {
      captured.scripts.set('monitorEnsure', args[2]);
      return actual.monitorEnsureOperation(...args);
    },
    monitorRunNowOperation: (...args: Parameters<typeof actual.monitorRunNowOperation>) => {
      captured.scripts.set('monitorRunNow', args[2]);
      return actual.monitorRunNowOperation(...args);
    },
    openOperation: (...args: Parameters<typeof actual.openOperation>) => {
      captured.scripts.set('open', args[3]);
      return actual.openOperation(...args);
    },
  };
});

const SPEC: MonitorRunSpec = {
  name: 'devspaces-monitor',
  image: 'sha256:' + 'a'.repeat(64),
  labels: {},
  restartPolicy: 'on-failure',
  network: 'none',
  log: { driver: 'json-file', maxSize: '1m', maxFile: '2' },
  mounts: { socket: '/var/run/docker.sock', volume: 'devspaces-monitor', volumeTarget: '/state' },
  env: {},
  command: ['node'],
};

describe('the monitor ensure: the log driver and the script of the bundle', () => {
  it('the create takes the log driver of the spec', async () => {
    const requests: EngineRequest[] = [];
    const api: EngineApi = async (request) => {
      requests.push(request);
      return { status: 500, body: JSON.stringify({ message: 'refused' }), truncated: false };
    };
    const hijack = (() => {
      throw new Error('no attach expected');
    }) as unknown as EngineHijack;
    const spec = { ...SPEC, log: { ...SPEC.log, driver: 'local' } } as unknown as MonitorRunSpec;
    expect(await dockerEngine(api, hijack).createAttached(spec, { input: 'x\n', readyText: 'ready', timeoutMs: 5_000 })).toMatchObject({ kind: 'exited' });
    expect(requests[0].json).toMatchObject({ HostConfig: { LogConfig: { Type: 'local', Config: { 'max-size': '1m', 'max-file': '2' } } } });
  });

  it("the operations get the worker's own script", async () => {
    await import('./operations');
    // The file of ownScript.ts itself here (`__filename`; in the bundle: the bundle).
    const own = fs.readFileSync(path.join(__dirname, 'ownScript.ts'), 'utf8');
    expect([...captured.scripts.keys()].sort()).toEqual(['monitorEnsure', 'monitorRunNow', 'open']);
    for (const [operation, script] of captured.scripts) expect(script(), operation).toBe(own);
  });
});
