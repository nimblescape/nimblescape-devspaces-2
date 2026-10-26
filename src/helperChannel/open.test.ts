// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The operation `open` of the worker: its checks before anything runs, its refusals as values (with a fake extension
// behind its handler), the settings of its pipeline, its progress, and its Monitor (the image maintenance of
// its parameters; the signal of the operation when the pipeline gives none).
import { describe, expect, it, vi } from 'vitest';
import { LOCK_UNAVAILABLE_CODE, OP_OPEN, OPEN_PROGRESS_DETAIL, type AskKind } from '../core/helperChannel/protocol';
import { PipelineTexts } from '../core/pipeline/operationBase';
import { silentLogger } from '../core/ports';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import { FLOW_REQUESTS, type HostSide } from '../core/worker/hostSide';
import { hostSideHandler } from '../core/worker/hostSideHandler';
import type { OwnHelper } from '../core/worker/ownHelper';
import type { DockerEngine } from '../core/worker/dockerEngine';
import { openMonitor, openOperation, openSettingsOf, operationProgress } from './flowOperations';
import { contextSecrets } from './operationContext.testkit';
import type { OperationContext } from './server';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const OWN: OwnHelper = { image: { tag: 'devspaces-worker:abc', id: `sha256:${'a'.repeat(64)}` }, socket: '/run/user/1000/docker.sock' };
const IMAGES = { schedule: '7 6 * * *', timeZone: 'UTC' };
const SETTINGS = { updateImagesOnConnect: true, hostAccessChecks: 'off' as const, stopOnClose: false, respectShutdownActionNone: true };
const PARAMS = {
  dockerHost: '',
  owner: { windowId: 'window-1', pid: 4242 },
  monitorSource: '0123456789abcdef0123456789abcdef',
  settings: SETTINGS,
  images: IMAGES,
  repository: 'acme/api',
  devspaceId: ID,
};

function contextOf(ask: OperationContext['ask'] = async () => undefined, secrets: Record<string, string> = {}) {
  const controller = new AbortController();
  const progress: [string, string | undefined][] = [];
  const context: OperationContext = {
    signal: controller.signal,
    ...contextSecrets(secrets, ask),
    progress: (step, detail) => void progress.push([step, detail]),
    log: () => {},
    output: () => {},
  };
  return { context, controller, progress };
}

/** The operation with a fake extension behind the handler of its requests (FLOW_REQUESTS of `open`). */
function run(params: unknown, host: Partial<HostSide>, ownHelperOf: () => Promise<OwnHelper> = async () => OWN) {
  const asks: string[] = [];
  const handler = hostSideHandler({ questions: {}, state: {}, records: {}, secrets: {}, ...host } as HostSide, silentLogger, FLOW_REQUESTS[OP_OPEN], {
    devspaceId: ID,
    repository: 'acme/api',
    dockerHost: '',
  });
  const { context } = contextOf(async (kind: AskKind, payload) => {
    asks.push(`${kind} ${(payload as { call: string }).call}`);
    const answer = await handler(kind, payload, new AbortController().signal);
    return answer.value;
  });
  const operation = openOperation(
    () => unusedEngine(),
    ownHelperOf,
    async () => {
      throw new Error('No batch helper in this test.');
    },
    () => 'monitor script',
  );
  return { result: operation(params, context), asks, context };
}

describe('the operation open of the worker', () => {
  it('refuses parameters that do not fit, and a secret, before anything runs', async () => {
    for (const params of [{ ...PARAMS, monitorSource: undefined }, { ...PARAMS, extra: 1 }, undefined]) {
      const { result, asks } = run(params, {});
      await expect(result).rejects.toMatchObject({ code: 'invalid' });
      expect(asks).toEqual([]);
    }
    const ownHelperOf = vi.fn(async () => OWN);
    const operation = openOperation(() => unusedEngine(), ownHelperOf, async () => Promise.reject(new Error('no')), () => '');
    await expect(operation(PARAMS, contextOf(undefined, { token: 'gho_x' }).context)).rejects.toMatchObject({ code: 'invalid' });
    expect(ownHelperOf).not.toHaveBeenCalled();
  });

  it('a helper image of the worker that cannot be read changed nothing (as a lock that could not be taken)', async () => {
    const { result, asks } = run(PARAMS, {}, async () => Promise.reject(new Error('no such container')));
    await expect(result).rejects.toMatchObject({ code: LOCK_UNAVAILABLE_CODE, message: expect.stringContaining('no such container') });
    expect(asks).toEqual([]);
  });

  it("the refusal of the worker's pipeline is its value: a devspace that is not there", async () => {
    const { result, asks } = run(PARAMS, { records: { get: async () => undefined } as unknown as HostSide['records'] });
    expect(await result).toEqual({ refused: { code: 'startFailed', message: PipelineTexts.devspaceMissing } });
    expect(asks).toEqual(['record get']);
  });

  it('the open of a repository asks for the sign-in of the extension; without one it is refused', async () => {
    const { devspaceId: _id, ...rest } = PARAMS;
    const { result, asks } = run({ ...rest, target: { configPaths: [], trusted: true } }, { secrets: { token: async () => undefined } as unknown as HostSide['secrets'] });
    expect(await result).toMatchObject({ refused: { code: 'signInRequired' } });
    expect(asks).toEqual(['secret token']);
  });

  it('the settings of its pipeline: the host access checks of its repository only', () => {
    expect(openSettingsOf('acme/api', SETTINGS)).toEqual({
      reopenLastOnStartup: false,
      stopOnClose: false,
      updateImagesOnConnect: true,
      respectShutdownActionNone: true,
      owners: [],
      includeArchived: false,
      includeForks: false,
      refreshIntervalMinutes: 0,
      hostAccessChecksOff: ['acme/api'],
    });
    expect(openSettingsOf('acme/api', { ...SETTINGS, hostAccessChecks: 'on', stopAfterMinutes: 30 })).toMatchObject({ hostAccessChecksOff: [], stopAfterMinutes: 30 });
  });

  it('its progress: the steps, and the details as OPEN_PROGRESS_DETAIL', () => {
    const { context, progress } = contextOf();
    const reporter = operationProgress(context);
    reporter.step('checkingImage');
    reporter.detail('A newer image is available.');
    expect(progress).toEqual([
      ['checkingImage', undefined],
      [OPEN_PROGRESS_DETAIL, 'A newer image is available.'],
    ]);
  });
});

describe('the Monitor of an open', () => {
  const ok = async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false });

  it('the ensure with the image maintenance of the parameters, and the signal of the operation when the pipeline gives none', async () => {
    const ensure = vi.fn(async () => 'running' as const);
    const operation = new AbortController();
    const engine = unusedEngine();
    const monitor = openMonitor(engine, OWN, silentLogger, () => 'script', { images: IMAGES }, operation.signal, ensure);
    await monitor.monitorEnsure(undefined);
    expect(ensure).toHaveBeenLastCalledWith(engine, OWN, silentLogger, expect.any(Function), IMAGES, operation.signal, undefined);
    const own = new AbortController();
    await monitor.monitorEnsure(own.signal);
    expect(ensure).toHaveBeenLastCalledWith(engine, OWN, silentLogger, expect.any(Function), IMAGES, own.signal, undefined);
  });

  // The open gives no image list; the settings and the references in use go with the signal of the operation when the
  // pipeline gives none.
  it('gives the settings and the references in use with the signal of the operation', async () => {
    const execs: { signal?: AbortSignal; input?: string }[] = [];
    const engine: DockerEngine = { ...unusedEngine(), exec: async (_container, _command, options) => (execs.push({ signal: options?.signal, input: options?.input }), ok()) };
    const operation = new AbortController();
    const source = '0123456789abcdef0123456789abcdef';
    const monitor = openMonitor(engine, OWN, silentLogger, () => 'script', { images: IMAGES, references: ['node:20'], monitorSource: source }, operation.signal);
    await monitor.monitorImages(undefined);
    expect(execs.map((exec) => exec.signal)).toEqual([operation.signal, operation.signal]);
    // The settings go first, also without prefixes (they hold the schedule of the whole background run).
    expect(execs.map((exec) => exec.input)).toEqual([JSON.stringify(IMAGES), JSON.stringify({ source, references: ['node:20'] })]);
    expect(Object.keys(monitor).sort()).toEqual(['monitorEnsure', 'monitorImages']);
  });
});
