// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The worker's operation `monitorRunNow` ("Update All Images Now"): first the ensure of the Monitor with the
// parameters (so the monitor of this version runs), then `monitor.js run-now` in it (the entry monitorRunNow of the
// registry, no argument, no input); a failure of either fails the operation, and a failed ensure runs no command. It
// asks nothing of the extension; its answer is checked strictly.
import { describe, expect, it, vi } from 'vitest';
import { FLOW_REQUESTS } from '../core/worker/hostSide';
import { OP_MONITOR_RUN_NOW, parseMonitorRunNowValue } from '../core/helperChannel/protocol';
import { REMOTE_MONITOR_CONTAINER, REMOTE_MONITOR_SCRIPT_PATH } from '../core/remoteMonitor/protocol';
import { CONTAINER_SCRIPTS, scriptCommand } from '../core/worker/containerScripts';
import type { DockerEngine, EngineExecResult } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import { requestBackgroundRun } from '../core/worker/monitorFlow';
import type { OwnHelper } from '../core/worker/ownHelper';
import { monitorRunNowOperation, type ensureWorkerMonitor } from './flowOperations';
import { contextSecrets } from './operationContext.testkit';
import type { OperationContext } from './server';

const IMAGES = { schedule: '7 6 * * *', timeZone: 'Europe/Vienna', permanent: true, computer: 'c'.repeat(32) };
const OWN = { image: { tag: 'devspaces-worker:1', id: `sha256:${'a'.repeat(64)}` }, socket: '/var/run/docker.sock' } as unknown as OwnHelper;

const result = (exitCode: number | null, stdout = '', stderr = ''): EngineExecResult => ({ exitCode, stdout, stderr, timedOut: false });

function setup(execResult: () => Promise<EngineExecResult>, ensureFails = false) {
  const order: string[] = [];
  const execs: { container: string; command: readonly string[]; input?: unknown }[] = [];
  const engine: DockerEngine = {
    ...unusedEngine(),
    exec: async (container, command, options) => {
      order.push('exec');
      execs.push({ container, command, input: options?.input });
      return execResult();
    },
  };
  const ensure = vi.fn(async (..._args: Parameters<typeof ensureWorkerMonitor>) => {
    order.push('ensure');
    if (ensureFails) throw new Error('docker run failed: No such image');
    return 'running' as const;
  });
  const operation = monitorRunNowOperation(() => engine, async () => OWN, () => 'the script', ensure);
  const context: OperationContext = { signal: new AbortController().signal, ...contextSecrets(), progress: () => {}, log: () => {}, output: () => {} };
  return { operation, context, ensure, execs, order };
}

describe('the operation monitorRunNow', () => {
  it('makes sure of the monitor with the parameters, then asks it for the run, and answers { requested: true }', async () => {
    const { operation, context, ensure, execs, order } = setup(async () => result(0));
    expect(await operation({ images: IMAGES }, context)).toEqual({ requested: true });
    expect(order).toEqual(['ensure', 'exec']);
    expect(ensure.mock.calls[0][1]).toBe(OWN);
    expect(ensure.mock.calls[0][4]).toEqual(IMAGES);
    expect(execs).toEqual([{ container: REMOTE_MONITOR_CONTAINER, command: ['node', REMOTE_MONITOR_SCRIPT_PATH, 'run-now'], input: undefined }]);
  });

  it('a failed ensure runs no command and fails the operation with its cause', async () => {
    const { operation, context, execs } = setup(async () => result(0), true);
    await expect(operation({ images: IMAGES }, context)).rejects.toMatchObject({ code: 'failed', message: 'docker run failed: No such image' });
    expect(execs).toEqual([]);
  });

  it('a monitor that refuses the command fails the operation with its detail', async () => {
    const { operation, context } = setup(async () => result(2, '', 'Usage: monitor.js run | …'));
    await expect(operation({ images: IMAGES }, context)).rejects.toMatchObject({ code: 'failed', message: 'The Monitor did not take the request: Usage: monitor.js run | …' });
  });

  it('refuses parameters beyond the schema before it does anything', async () => {
    const { operation, context, order } = setup(async () => result(0));
    await expect(operation({ images: { ...IMAGES, schedule: 'daily' } }, context)).rejects.toMatchObject({ code: 'invalid' });
    await expect(operation({ images: IMAGES, now: true }, context)).rejects.toMatchObject({ code: 'invalid' });
    expect(order).toEqual([]);
  });

  it('asks nothing of the extension, and the extension takes only { requested: true }', () => {
    expect(FLOW_REQUESTS[OP_MONITOR_RUN_NOW]).toEqual([]);
    expect(parseMonitorRunNowValue({ requested: true })).toEqual({ requested: true });
    for (const value of [{ requested: false }, { requested: 'true' }, { requested: true, more: 1 }, {}, null, [true]]) {
      expect(parseMonitorRunNowValue(value), JSON.stringify(value)).toBeUndefined();
    }
  });

  it('the command is the entry monitorRunNow: no lock of the records, no argument, no input', async () => {
    expect(scriptCommand('monitorRunNow', [])).toEqual(['node', REMOTE_MONITOR_SCRIPT_PATH, 'run-now']);
    expect('plainInput' in CONTAINER_SCRIPTS.monitorRunNow).toBe(false);
    const execs: string[][] = [];
    const engine: DockerEngine = { ...unusedEngine(), exec: async (_container, command) => (execs.push([...command]), result(0)) };
    expect(await requestBackgroundRun(engine)).toEqual({ ok: true });
    expect(execs).toEqual([['node', REMOTE_MONITOR_SCRIPT_PATH, 'run-now']]);
  });
});
