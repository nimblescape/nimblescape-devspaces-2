// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The probe names the engine behind the socket of the worker. The probe and the sweep go over the port of the engine
// (DockerEngine), no Docker CLI of the worker.
import { describe, expect, it } from 'vitest';
import {
  parseProbeValue,
  parseRefreshValue,
  parseSweepValue,
  parseWindowStateValue,
  type EngineIdentity,
  MAX_PROBE_DETAIL_LENGTH,
} from '../core/helperChannel/protocol';
import { LABEL_HELPER_CHANNEL, LABEL_HELPER_RUN } from '../core/names';
import { LABEL_MONITOR } from '../core/remoteMonitor/protocol';
import { ENV_API, EXPECTED_STATES, REFRESH_DEVSPACES, fixtureContainerId, fixtureEngine } from '../core/pipeline/refreshStates.testkit';
import { EngineError, type DockerEngine, type EngineFilters } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import { abortError } from '../core/ports';
import { windowStateOperation } from './flowOperations';
import { probeOperation, refreshOperation, sweepOperation } from './operations';
import { OperationError, type OperationContext } from './server';
import { contextSecrets } from './operationContext.testkit';

const IDENTITY: EngineIdentity = { id: '7b1c7a44-2f0e-4d38-9d1d-3a8f7b0e8c11', rootDir: '/var/lib/docker' };

/**
 * The context of an operation of the probe or the sweep, with its progress and log lines.
 */
function context(secrets: Record<string, string> = {}): { context: OperationContext; progress: string[]; logs: string[]; controller: AbortController } {
  const progress: string[] = [];
  const logs: string[] = [];
  const controller = new AbortController();
  const value: OperationContext = {
    signal: controller.signal,
    ...contextSecrets(secrets),
    progress: (step) => progress.push(step),
    log: (text, level = 'info') => logs.push(`${level} ${text}`),
    output: () => {},
  };
  return { context: value, progress, logs, controller };
}

/** An engine of the probe: its version and identity as given, and the requests with their signals. */
function probeEngine(answers: { version?: () => Promise<{ apiVersion: string; version: string }>; identity?: () => Promise<EngineIdentity> } = {}) {
  const requests: Array<{ request: string; signal?: AbortSignal }> = [];
  const engine: DockerEngine = {
    ...unusedEngine(),
    version: async (signal) => (requests.push({ request: 'version', signal }), (answers.version ?? (async () => ({ apiVersion: '1.47', version: '27.1.0' })))()),
    identity: async (signal) => (requests.push({ request: 'identity', signal }), (answers.identity ?? (async () => IDENTITY))()),
  };
  return { engine, requests };
}

describe('the probe operation', () => {
  // The version and the identity of the port, each with the signal of the operation; the identity as its values.
  it('names the engine identity after the server version', async () => {
    const { engine, requests } = probeEngine();
    const { context: ctx, progress } = context();
    const value = parseProbeValue(await probeOperation(() => engine)({}, ctx));
    expect(value).toEqual({ serverVersion: '27.1.0', detail: 'Docker 27.1.0', engine: IDENTITY });
    expect(requests).toEqual([
      { request: 'version', signal: ctx.signal },
      { request: 'identity', signal: ctx.signal },
    ]);
    expect(progress).toEqual(['probe']);
  });

  // An identity that the port cannot read (it rejects for an answer without one, engineClient.ts); the log says why.
  it('names no engine when its identity cannot be read, and logs why', async () => {
    const { engine } = probeEngine({ identity: async () => Promise.reject(new EngineError('The engine answered /info without its ID and root folder.', 200)) });
    const { context: ctx, logs } = context();
    expect(parseProbeValue(await probeOperation(() => engine)({}, ctx))).toEqual({ serverVersion: '27.1.0', detail: 'Docker 27.1.0' });
    expect(logs).toEqual(['warn The identity of the Docker engine could not be read: The engine answered /info without its ID and root folder.']);
  });

  // The reason of the port as the detail, its end within MAX_PROBE_DETAIL_LENGTH; an empty version is no version.
  it('does not ask for the engine when the version cannot be read', async () => {
    const failing = probeEngine({ version: async () => Promise.reject(new Error('connect ENOENT /var/run/docker.sock')) });
    expect(parseProbeValue(await probeOperation(() => failing.engine)({}, context().context))).toEqual({ detail: 'connect ENOENT /var/run/docker.sock' });
    expect(failing.requests.map((entry) => entry.request)).toEqual(['version']);
    const long = probeEngine({ version: async () => Promise.reject(new Error(`${'x'.repeat(MAX_PROBE_DETAIL_LENGTH)} the end`)) });
    const detail = parseProbeValue(await probeOperation(() => long.engine)({}, context().context))?.detail;
    expect(detail).toHaveLength(MAX_PROBE_DETAIL_LENGTH);
    expect(detail?.endsWith(' the end')).toBe(true);
    const empty = probeEngine({ version: async () => ({ apiVersion: '1.47', version: '' }) });
    expect(parseProbeValue(await probeOperation(() => empty.engine)({}, context().context))).toEqual({ detail: 'The Docker engine did not name its version.' });
    expect(empty.requests.map((entry) => entry.request)).toEqual(['version']);
  });

  // The parameters by the schema of both sides (parseProbeParams): none; an empty list is refused too. And no secret,
  // as every operation that takes none.
  it('refuses parameters and a secret before it asks the engine; the secret is not echoed', async () => {
    let asked = 0;
    const engineOf = () => (asked++, probeEngine().engine);
    for (const params of [{ x: 1 }, [], 'probe', 0]) {
      await expect(probeOperation(engineOf)(params, context().context)).rejects.toMatchObject({ name: 'OperationError', code: 'invalid', message: 'The probe operation takes no parameters.' });
    }
    const error = await probeOperation(engineOf)({}, context({ token: 'ghs_secretvalue' }).context).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ name: 'OperationError', code: 'invalid', message: 'The probe operation takes no secret.' });
    expect(String((error as Error).message)).not.toContain('ghs_secretvalue');
    expect(asked).toBe(0);
    for (const params of [null, undefined, {}]) expect(parseProbeValue(await probeOperation(engineOf)(params, context().context))).toMatchObject({ serverVersion: '27.1.0' });
  });

  it('a cancel is `cancelled`, never a detail or an engine', async () => {
    const { context: ctx, controller } = context();
    const cancelledVersion = probeEngine({ version: async () => (controller.abort(), Promise.reject(abortError())) });
    await expect(probeOperation(() => cancelledVersion.engine)({}, ctx)).rejects.toMatchObject({ name: 'OperationError', code: 'cancelled' });
    const second = context();
    const cancelledIdentity = probeEngine({ identity: async () => (second.controller.abort(), Promise.reject(abortError())) });
    await expect(probeOperation(() => cancelledIdentity.engine)({}, second.context)).rejects.toMatchObject({ name: 'OperationError', code: 'cancelled' });
  });
});

// The sweep over the port of the engine.
describe('the sweep operation', () => {
  function sweepEngine(prune: (filters: EngineFilters) => Promise<string[]>) {
    const requests: Array<{ filters: EngineFilters; signal?: AbortSignal }> = [];
    const engine: DockerEngine = { ...unusedEngine(), pruneContainers: async (filters, signal) => (requests.push({ filters, signal }), prune(filters)) };
    return { engine, requests };
  }

  // Exactly the labels and the age (no wider filter), and the number removed.
  it('prunes only the stopped helper containers older than 10 minutes, never the Monitor, and answers how many it removed', async () => {
    const { engine, requests } = sweepEngine(async () => ['a'.repeat(64), 'b'.repeat(64)]);
    const { context: ctx, logs } = context();
    const value = await sweepOperation(() => engine)({}, ctx);
    expect(parseSweepValue(value)).toEqual({ removed: 2 });
    // Every stopped helper container (the label of the helper runs, which the channels carry too), never the Session
    // Monitor.
    expect(requests).toEqual([{ filters: { label: [LABEL_HELPER_RUN], 'label!': [LABEL_MONITOR], until: ['10m'] }, signal: ctx.signal }]);
    expect(LABEL_HELPER_RUN).toBe('nimblescape.devspaces.worker-run');
    expect(LABEL_MONITOR).toBe('nimblescape.devspaces.monitor');
    expect(LABEL_HELPER_CHANNEL).toBe('nimblescape.devspaces.worker-channel');
    // The log line names the helper containers.
    expect(logs).toContain('info The sweep removed 2 stopped helper container(s) older than 10 minutes.');
    const none = sweepEngine(async () => []);
    expect(parseSweepValue(await sweepOperation(() => none.engine)(null, context().context))).toEqual({ removed: 0 });
  });

  it('fails with the reason of the engine; a cancel is `cancelled`', async () => {
    const busy = sweepEngine(async () => Promise.reject(new EngineError('a prune operation is already running', 409)));
    await expect(sweepOperation(() => busy.engine)({}, context().context)).rejects.toMatchObject({ name: 'OperationError', code: 'failed', message: 'a prune operation is already running' });
    const { context: ctx, controller } = context();
    const cancelled = sweepEngine(async () => (controller.abort(), Promise.reject(abortError())));
    await expect(sweepOperation(() => cancelled.engine)({}, ctx)).rejects.toMatchObject({ name: 'OperationError', code: 'cancelled' });
  });

  // The parameters by the schema of both sides (parseSweepParams), and no secret.
  it('refuses parameters and a secret before it asks the engine', async () => {
    let asked = 0;
    const engineOf = () => (asked++, sweepEngine(async () => []).engine);
    for (const params of [{ all: true }, [], 'sweep']) {
      await expect(sweepOperation(engineOf)(params, context().context)).rejects.toMatchObject({ name: 'OperationError', code: 'invalid', message: 'The sweep operation takes no parameters.' });
    }
    await expect(sweepOperation(engineOf)({}, context({ token: 'ghs_secretvalue' }).context)).rejects.toMatchObject({ code: 'invalid', message: 'The sweep operation takes no secret.' });
    expect(asked).toBe(0);
  });
});

// The operations of the window reads and of the refresh, over the port of the engine (EngineDocker).
describe('the operations windowState and refresh over the port of the engine', () => {
  function engineContext(secrets: Record<string, string> = {}): { context: OperationContext; progress: string[]; controller: AbortController } {
    const progress: string[] = [];
    const controller = new AbortController();
    const value: OperationContext = {
      signal: controller.signal,
      ...contextSecrets(secrets),
      progress: (step) => progress.push(step),
      log: () => {},
      output: () => {},
    };
    return { context: value, progress, controller };
  }

  const PARAMS = { devspaceId: ENV_API, containerName: 'devspaces-api', checks: 'on', branch: { folder: '/workspaces/api', user: 'node' } };

  it('refresh: the states and branches of the fixture, with its progress', async () => {
    const { engine } = fixtureEngine();
    const { context: ctx, progress } = engineContext();
    const value = parseRefreshValue(await refreshOperation(() => engine)({ devspaces: REFRESH_DEVSPACES }, ctx), { devspaces: REFRESH_DEVSPACES });
    expect(value).toEqual(EXPECTED_STATES);
    expect(progress).toEqual(['refresh']);
  });

  it('windowState: the state and branch of the container, the signal of the operation passed to the read of the branch', async () => {
    const { engine, execs } = fixtureEngine();
    const { context: ctx } = engineContext();
    expect(parseWindowStateValue(await windowStateOperation(() => engine)(PARAMS, ctx))).toEqual({ state: 'running', outdated: 'version', branch: 'feature/x' });
    // The branch is read from the dev container of the rule by its ID, not by the name of the request.
    expect(execs).toEqual([{ container: fixtureContainerId('devspaces-api'), user: 'node', signal: ctx.signal }]);
  });

  it('windowState: invalid parameters or a secret are invalid, before the engine is asked; the secret is not echoed', async () => {
    let asked = 0;
    const engineOf = () => {
      asked++;
      return fixtureEngine().engine;
    };
    for (const [params, secrets] of [
      [{ ...PARAMS, containerName: '-x' }, {}],
      [PARAMS, { token: 'ghs_secretvalue' }],
    ] as const) {
      const error = await windowStateOperation(engineOf)(params, engineContext(secrets).context).then(
        () => undefined,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(OperationError);
      expect(error).toMatchObject({ code: 'invalid' });
      expect(String((error as Error).message)).not.toContain('ghs_secretvalue');
    }
    expect(asked).toBe(0);
  });

  it('windowState: an engine that fails is `failed` (never a state), a cancel is `cancelled`', async () => {
    const failing = { ...fixtureEngine().engine, container: async () => Promise.reject(new Error('socket closed')), containers: async () => Promise.reject(new Error('socket closed')) };
    const { context: ctx, controller } = engineContext();
    await expect(windowStateOperation(() => failing)(PARAMS, ctx)).rejects.toMatchObject({ code: 'failed' });
    controller.abort();
    await expect(windowStateOperation(() => failing)(PARAMS, ctx)).rejects.toMatchObject({ code: 'cancelled' });
  });
});
