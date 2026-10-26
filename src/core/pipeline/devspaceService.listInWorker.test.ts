// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The listing of the configurations from the extension's side: it sends `listConfigurations` to the worker of the
// Docker host of the operation and gives back its paths, or the refusal of the worker's pipeline as a UserFacingError.
// Nothing is listed here.
import type { DevspaceOperationsDeps } from './devspaceOperations';
import type { OperationFlow } from './devspaceOperations';
import { describe, expect, it, vi } from 'vitest';
import { HelperChannelError, HelperOperationError } from '../helperChannel/helperChannel';
import { LOCK_BUSY_CODE, OP_DELETE, OP_DELETE_CHECK, OP_WINDOW_STATE } from '../helperChannel/protocol';
import { DELETE_CHECK_FLOW_TIMEOUT_MS, DELETE_FLOW_TIMEOUT_MS, PipelineTexts, WINDOW_STATE_FLOW_TIMEOUT_MS } from './operationBase';
import { ENV_ID, PID, REPO, WINDOW_ID, createHarness, seedDevspace } from './devspaceService.testkit';
import type { DevspaceServiceDeps } from './devspacePorts';

type FlowOptions = Parameters<OperationFlow>[2];

function harness(answer: (op: string, params: unknown, options: FlowOptions) => Promise<unknown>, overrides: Partial<DevspaceServiceDeps & DevspaceOperationsDeps> = {}) {
  const sent: { op: string; params: unknown; timeoutMs?: number; signal?: AbortSignal; passive?: boolean }[] = [];
  const h = createHarness({
    ...overrides,
    flow: async (op, params, options) => {
      sent.push({ op, params, timeoutMs: options.timeoutMs, signal: options.signal, passive: options.passive });
      return answer(op, params, options);
    },
  });
  return { h, sent };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (value) => ({ resolved: value }),
    (error: unknown) => error,
  );
}

// The reads of an attached window through the worker.
describe('the reads of an attached window through the worker, from the extension', () => {
  it('sends the container, the host access checks of the repository, and with `branch` the Git user and folder', async () => {
    const { h, sent } = harness(async () => ({ state: 'running', branch: 'main' }));
    const env = await seedDevspace(h, { container: 'running' });
    expect(await h.operations.windowStateInWorker(env, 'devspaces-x', { branch: true })).toEqual({ state: 'running', branch: 'main' });
    expect(sent[0]).toMatchObject({
      op: OP_WINDOW_STATE,
      params: { devspaceId: ENV_ID, containerName: 'devspaces-x', checks: 'on', branch: { folder: '/workspaces/api', user: 'vscode' } },
      timeoutMs: WINDOW_STATE_FLOW_TIMEOUT_MS,
    });
    await h.operations.windowStateInWorker(env, 'devspaces-x');
    expect(sent[1].params).toEqual({ devspaceId: ENV_ID, containerName: 'devspaces-x', checks: 'on' });
  });

  it('is unknown (undefined) when the worker cannot be reached, fails, or answers an invalid value; it never throws', async () => {
    let answer: () => Promise<unknown> = async () => {
      throw new HelperChannelError('unavailable', 'no worker');
    };
    const { h } = harness(() => answer());
    const env = await seedDevspace(h, { container: 'running' });
    expect(await h.operations.windowStateInWorker(env, 'devspaces-x')).toBeUndefined();
    answer = async () => ({ state: 'paused' });
    expect(await h.operations.windowStateInWorker(env, 'devspaces-x')).toBeUndefined();
    expect(h.logger.infos.some((line) => line.includes('The state of the container devspaces-x could not be read'))).toBe(true);
  });

  // A read makes the worker ready passively and within its time limit; a read with the signal of an operation of the
  // user makes the worker ready in full.
  it('a read with the signal of an operation is not passive and ends with that signal', async () => {
    const { h, sent } = harness(async () => ({ state: 'running' }));
    const env = await seedDevspace(h, { container: 'running' });
    const signal = new AbortController().signal;
    await h.operations.windowStateInWorker(env, 'devspaces-x', { signal });
    expect(sent[0]).toMatchObject({ timeoutMs: WINDOW_STATE_FLOW_TIMEOUT_MS });
    // That very signal, not one bounded by a time limit.
    expect(sent[0].signal).toBe(signal);
    expect(sent[0].passive).toBeUndefined();
  });

  it('a read is passive and bounded by its time limit, with and without the branch', async () => {
    const { h, sent } = harness(async () => ({ state: 'running' }));
    const env = await seedDevspace(h, { container: 'running' });
    await h.operations.windowStateInWorker(env, 'devspaces-x', { branch: true });
    await h.operations.windowStateInWorker(env, 'devspaces-x');
    for (const each of sent) {
      expect(each).toMatchObject({ passive: true, timeoutMs: WINDOW_STATE_FLOW_TIMEOUT_MS });
      expect(each.signal).toBeInstanceOf(AbortSignal);
    }
  });

  // The wait for the worker is bounded by the time limit of the read.
  it('the signal of a read ends at the time limit of the read', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      const { h } = harness(async () => ({ state: 'running' }));
      const env = await seedDevspace(h, { container: 'running' });
      const { h: h2, sent } = harness(async () => ({ state: 'running' }));
      await seedDevspace(h2, { container: 'running' });
      await h.operations.windowStateInWorker(env, 'devspaces-x');
      await h2.operations.windowStateInWorker(env, 'devspaces-x');
      expect(timeout).toHaveBeenCalledWith(WINDOW_STATE_FLOW_TIMEOUT_MS);
      // That signal is the one sent.
      expect(sent[0].signal).toBe(timeout.mock.results[1].value);
    } finally {
      timeout.mockRestore();
    }
  });

  // A devspace of another Docker host is unknown, and no flow is sent.
  it('a devspace of another Docker host than the current one is unknown, and nothing is sent', async () => {
    const { h, sent } = harness(async () => ({ state: 'running' }), { dockerTarget: async () => ({ kind: 'remote', host: 'build-box', endpoint: 'ssh://build-box' }) });
    await seedDevspace(h, { container: 'running' });
    const env = await h.registry.updateDevspace(ENV_ID, (entry) => {
      entry.dockerHost = 'other-box';
    });
    expect(await h.operations.windowStateInWorker(env ?? (await h.registry.get(ENV_ID))!, 'devspaces-x')).toBeUndefined();
    expect(sent).toEqual([]);
  });
});

// The parameters of the window reads.
describe('the reads of an attached window through the worker: the parameters', () => {
  it('sends the host access checks of the repository when they are off', async () => {
    const { h, sent } = harness(async () => ({ state: 'running' }));
    const env = await seedDevspace(h, { container: 'running' });
    h.settings = { ...h.settings, hostAccessChecksOff: [REPO] };
    await h.operations.windowStateInWorker(env, 'devspaces-x');
    expect((sent[0].params as { checks: string }).checks).toBe('off');
  });

  it('parameters that the worker would refuse are unknown, and nothing is sent', async () => {
    const { h, sent } = harness(async () => ({ state: 'running' }));
    const env = await seedDevspace(h, { container: 'running' });
    expect(await h.operations.windowStateInWorker(env, '-x')).toBeUndefined();
    expect(sent).toEqual([]);
    expect(h.logger.infos.some((line) => line.includes('The state of the container -x could not be read'))).toBe(true);
  });

  it('an empty remote user is not sent: the branch is read as the default user', async () => {
    const { h, sent } = harness(async () => ({ state: 'missing' }));
    const env = await seedDevspace(h, { container: 'running' });
    expect(await h.operations.windowStateInWorker({ ...env, remoteUser: '' }, 'devspaces-x', { branch: true })).toEqual({ state: 'missing' });
    expect((sent[0].params as { branch: unknown }).branch).toEqual({ folder: '/workspaces/api' });
  });
});

// Delete from the extension's side: it sends `delete` to the worker of the Docker host of the operation and throws its
// refusal. Nothing is removed here.
describe('the Delete in the worker, from the extension', () => {
  const SOURCE = '0123456789abcdef0123456789abcdef';

  it('sends the devspace, the Docker host, this window, the confirmed volumes and this computer; removes nothing here', async () => {
    const { h, sent } = harness(async () => ({ deleted: true }), { monitorSource: () => SOURCE });
    await seedDevspace(h, { container: 'running' });
    const changes = h.docker.log.length;
    await h.operations.deleteInWorker(ENV_ID, { progress: h.progress, additionalVolumesToRemove: ['api-db'] });
    expect(sent).toEqual([
      {
        op: OP_DELETE,
        params: { devspaceId: ENV_ID, dockerHost: '', owner: { windowId: WINDOW_ID, pid: PID }, additionalVolumesToRemove: ['api-db'], monitorSource: SOURCE },
        timeoutMs: DELETE_FLOW_TIMEOUT_MS,
        signal: undefined,
        passive: undefined,
      },
    ]);
    expect(h.docker.log.length).toBe(changes);
    expect(h.helper.calls).toEqual([]);
    expect(await h.registry.get(ENV_ID)).toBeDefined();
  });

  it('throws the refusal of the worker as the UserFacingError it was; a lock held elsewhere or no worker is refused as for Stop', async () => {
    let answer: () => Promise<unknown> = async () => ({ refused: { code: 'otherAccount', message: 'Another account.' } });
    const { h } = harness(() => answer(), { monitorSource: () => SOURCE });
    await seedDevspace(h, { container: 'stopped' });
    const remove = () => rejection(h.operations.deleteInWorker(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] }));
    expect(await remove()).toMatchObject({ code: 'otherAccount', message: 'Another account.' });
    answer = async () => {
      throw new HelperOperationError(LOCK_BUSY_CODE, 'held', false);
    };
    expect(await remove()).toMatchObject({ code: 'startFailed', message: PipelineTexts.devspaceLockBusy(REPO) });
    answer = async () => {
      throw new HelperChannelError('unavailable', 'no worker');
    };
    expect(await remove()).toMatchObject({ code: 'helperFailed' });
    answer = async () => ({ deleted: false });
    expect(((await remove()) as Error).message).toContain('with an invalid value');
  });

  it('a devspace that is not in the registry only loses its session files here; nothing is sent', async () => {
    const { h, sent } = harness(async () => ({ deleted: true }), { monitorSource: () => SOURCE });
    await h.operations.deleteInWorker('6b1f0c2e-1d4a-4f5e-9a8b-7c6d5e4f3a2b', { progress: h.progress, additionalVolumesToRemove: [] });
    expect(sent).toEqual([]);
  });

  // The extension takes no lock of a devspace (the worker takes it).
  it('never sends without this computer, or for another Docker host', async () => {
    const { h, sent } = harness(async () => ({ deleted: true }));
    await seedDevspace(h, { container: 'stopped' });
    expect(((await rejection(h.operations.deleteInWorker(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] }))) as Error).message).toContain('cannot be sent to the worker');
    const other = harness(async () => ({ deleted: true }), { monitorSource: () => SOURCE, dockerTarget: async () => ({ kind: 'remote', host: 'build-box', endpoint: 'ssh://build-box' }) });
    await seedDevspace(other.h, { container: 'stopped' });
    expect(await rejection(other.h.operations.deleteInWorker(ENV_ID, { progress: other.h.progress, additionalVolumesToRemove: [] }))).toMatchObject({ code: 'otherDockerHost' });
    expect([...sent, ...other.sent]).toEqual([]);
  });
});

// A worker that ended without an answer may have left the busy mark of this window.
describe('the Delete in the worker: the busy mark of this window', () => {
  const SOURCE = '0123456789abcdef0123456789abcdef';
  const OWN_MARK = { operation: 'delete' as const, since: '2026-10-04T10:00:00.000Z', pid: PID, windowId: WINDOW_ID };
  const OTHER_MARK = { operation: 'update' as const, since: '2026-10-04T10:00:00.000Z', pid: PID + 1, windowId: 'window-2' };

  it('clears the busy mark of this window when the worker ended without an answer, never the mark of another window', async () => {
    let mark = OWN_MARK as typeof OWN_MARK | typeof OTHER_MARK;
    let failure: Error = new HelperChannelError('lost', 'the channel was lost while the operation ran');
    const { h } = harness(
      async () => {
        // As the worker: it marked the devspace, then its channel ended.
        await h.registry.updateDevspace(ENV_ID, (entry) => {
          entry.busy = mark;
        });
        throw failure;
      },
      { monitorSource: () => SOURCE },
    );
    await seedDevspace(h, { container: 'stopped' });
    expect(await rejection(h.operations.deleteInWorker(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] }))).toBeInstanceOf(Error);
    expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
    mark = OTHER_MARK;
    failure = new HelperChannelError('lost', 'lost again');
    await rejection(h.operations.deleteInWorker(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] }));
    expect((await h.registry.get(ENV_ID))?.busy).toEqual(OTHER_MARK);
  });

  // A cancel and the time limit of the worker clear it too.
  it('clears the busy mark of this window after a cancel and after the time limit of the worker', async () => {
    const controller = new AbortController();
    let failure: () => Error = () => (controller.abort(), Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const { h } = harness(
      async () => {
        await h.registry.updateDevspace(ENV_ID, (entry) => {
          entry.busy = OWN_MARK;
        });
        throw failure();
      },
      { monitorSource: () => SOURCE },
    );
    await seedDevspace(h, { container: 'stopped' });
    expect(await rejection(h.operations.deleteInWorker(ENV_ID, { progress: h.progress, signal: controller.signal, additionalVolumesToRemove: [] }))).toMatchObject({ code: 'cancelled' });
    expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
    failure = () => new HelperOperationError('timeout', 'The operation did not end in time.', false);
    await rejection(h.operations.deleteInWorker(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] }));
    expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
  });

  it('leaves the mark to the worker when it answered with a refusal', async () => {
    const { h } = harness(
      async () => {
        await h.registry.updateDevspace(ENV_ID, (entry) => {
          entry.busy = OWN_MARK;
        });
        return { refused: { code: 'startFailed', message: 'm' } };
      },
      { monitorSource: () => SOURCE },
    );
    await seedDevspace(h, { container: 'stopped' });
    expect(await rejection(h.operations.deleteInWorker(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] }))).toMatchObject({ code: 'startFailed' });
    expect((await h.registry.get(ENV_ID))?.busy).toEqual(OWN_MARK);
  });
});

// The check of Delete and its questions from the extension's side: it sends `deleteCheck` to the worker and gives back
// the decision of the user, or throws the refusal.
describe('the check of Delete in the worker, from the extension', () => {
  it('sends the devspace, the Docker host, this window, the name that the user sees and the other window; gives back the decision', async () => {
    // The fake worker asks the user (onAnswer) before its decision.
    const { h, sent } = harness(async (_op, _params, options) => {
      options.onAnswer?.('confirmDelete', ['Acme/API', {}], 'delete');
      options.onAnswer?.('deleteAdditionalVolumes', [['api-cache']], 'remove');
      return { decision: 'delete', additionalVolumesToRemove: ['api-cache'] };
    });
    await seedDevspace(h, { container: 'running' });
    const controller = new AbortController();
    expect(await h.operations.deleteCheckInWorker(ENV_ID, { progress: h.progress, signal: controller.signal, repository: 'Acme/API', otherWindow: true })).toEqual({
      decision: 'delete',
      additionalVolumesToRemove: ['api-cache'],
    });
    expect(sent).toEqual([
      {
        op: OP_DELETE_CHECK,
        params: { devspaceId: ENV_ID, dockerHost: '', owner: { windowId: WINDOW_ID, pid: PID }, repository: 'Acme/API', otherWindow: true },
        timeoutMs: DELETE_CHECK_FLOW_TIMEOUT_MS,
        signal: controller.signal,
        passive: undefined,
      },
    ]);
  });

  // The decision of the worker counts only as far as the user gave it.
  it('refuses a decision that the user did not give, and volumes that the user did not choose', async () => {
    let answer: (options: FlowOptions) => unknown = () => ({ decision: 'delete', additionalVolumesToRemove: [] });
    const { h } = harness(async (_op, _params, options) => answer(options));
    await seedDevspace(h, { container: 'stopped' });
    const check = () => rejection(h.operations.deleteCheckInWorker(ENV_ID, { progress: h.progress, repository: 'acme/api', otherWindow: false }));
    // Never asked.
    expect(((await check()) as Error).message).toContain('a decision that the user did not give');
    // Asked, the user chose Open: Delete is not the answer.
    answer = (options) => (options.onAnswer?.('confirmDelete', ['acme/api', {}], 'open'), { decision: 'delete', additionalVolumesToRemove: [] });
    expect(((await check()) as Error).message).toContain('a decision that the user did not give');
    answer = (options) => (options.onAnswer?.('confirmDelete', ['acme/api', {}], 'delete'), { decision: 'open' });
    expect(((await check()) as Error).message).toContain('a decision that the user did not give');
    // Volumes: Keep, or not offered, or not picked.
    answer = (options) => {
      options.onAnswer?.('confirmDelete', ['acme/api', {}], 'delete');
      options.onAnswer?.('deleteAdditionalVolumes', [['api-cache']], 'keep');
      options.onAnswer?.('deleteServiceData', [['api-db', 'api-logs']], ['api-db']);
      return { decision: 'delete', additionalVolumesToRemove: ['api-db', 'api-cache'] };
    };
    expect(((await check()) as Error).message).toContain('volumes that the user did not choose: api-cache');
    answer = (options) => {
      options.onAnswer?.('confirmDelete', ['acme/api', {}], 'delete');
      options.onAnswer?.('deleteServiceData', [['api-db', 'api-logs']], ['api-db']);
      return { decision: 'delete', additionalVolumesToRemove: ['api-logs'] };
    };
    expect(((await check()) as Error).message).toContain('volumes that the user did not choose: api-logs');
    // Escape at a later question cancels, so a Delete is refused then.
    for (const [call, args] of [
      ['deleteAdditionalVolumes', [['api-cache']]],
      ['deleteServiceData', [['api-db']]],
    ] as const) {
      answer = (options) => {
        options.onAnswer?.('confirmDelete', ['acme/api', {}], 'delete');
        options.onAnswer?.(call, [...args], null);
        return { decision: 'delete', additionalVolumesToRemove: [] };
      };
      expect(((await check()) as Error).message, call).toContain('a decision that the user did not give');
    }
    // The cancel stays, the last confirmation counts, the last answer about the volumes counts.
    const gate = [
      [['confirmDelete', 'delete'], ['deleteAdditionalVolumes', null], ['confirmDelete', 'delete']],
      [['confirmDelete', 'delete'], ['deleteAdditionalVolumes', null], ['deleteAdditionalVolumes', 'remove']],
      [['confirmDelete', 'delete'], ['confirmDelete', null]],
    ] as const;
    for (const steps of gate) {
      answer = (options) => {
        for (const [call, value] of steps) options.onAnswer?.(call, call === 'confirmDelete' ? ['acme/api', {}] : [['api-cache']], value);
        return { decision: 'delete', additionalVolumesToRemove: [] };
      };
      expect(((await check()) as Error).message, JSON.stringify(steps)).toContain('a decision that the user did not give');
    }
    answer = (options) => {
      options.onAnswer?.('confirmDelete', ['acme/api', {}], 'delete');
      options.onAnswer?.('deleteAdditionalVolumes', [['api-cache']], 'remove');
      options.onAnswer?.('deleteAdditionalVolumes', [['api-other']], 'keep');
      return { decision: 'delete', additionalVolumesToRemove: ['api-cache'] };
    };
    expect(((await check()) as Error).message).toContain('volumes that the user did not choose: api-cache');
    // A decision while a question is still open is refused.
    answer = (options) => {
      options.onAnswer?.('confirmDelete', ['acme/api', {}], 'delete');
      options.onQuestion?.('asked');
      return { decision: 'delete', additionalVolumesToRemove: [] };
    };
    expect(((await check()) as Error).message).toContain('a decision that the user did not give');
    // What the user gave passes; a cancel always does.
    answer = (options) => {
      options.onAnswer?.('confirmDelete', ['acme/api', {}], 'delete');
      options.onAnswer?.('deleteAdditionalVolumes', [['api-cache']], 'remove');
      options.onAnswer?.('deleteServiceData', [['api-db', 'api-logs']], ['api-db']);
      return { decision: 'delete', additionalVolumesToRemove: ['api-cache', 'api-db'] };
    };
    expect(await h.operations.deleteCheckInWorker(ENV_ID, { progress: h.progress, repository: 'acme/api', otherWindow: false })).toEqual({
      decision: 'delete',
      additionalVolumesToRemove: ['api-cache', 'api-db'],
    });
    answer = () => ({ decision: 'cancel' });
    expect(await h.operations.deleteCheckInWorker(ENV_ID, { progress: h.progress, repository: 'acme/api', otherWindow: false })).toEqual({ decision: 'cancel' });
    answer = (options) => (options.onAnswer?.('confirmDelete', ['acme/api', {}], 'open'), { decision: 'open' });
    expect(await h.operations.deleteCheckInWorker(ENV_ID, { progress: h.progress, repository: 'acme/api', otherWindow: false })).toEqual({ decision: 'open' });
    // Nothing is read here: no helper step, no Docker call.
    expect(h.helper.calls).toEqual([]);
  });

  it('throws the refusal of the worker, refuses as for Stop without a worker, and an answer that is not a decision', async () => {
    let answer: () => Promise<unknown> = async () => ({ refused: { code: 'otherAccount', message: 'Another account.' } });
    const { h } = harness(() => answer());
    await seedDevspace(h, { container: 'stopped' });
    const check = () => rejection(h.operations.deleteCheckInWorker(ENV_ID, { progress: h.progress, repository: 'acme/api', otherWindow: false }));
    expect(await check()).toMatchObject({ code: 'otherAccount', message: 'Another account.' });
    answer = async () => {
      throw new HelperChannelError('unavailable', 'no worker');
    };
    expect(await check()).toMatchObject({ code: 'helperFailed' });
    answer = async () => ({ decision: 'maybe' });
    expect(((await check()) as Error).message).toContain('with an invalid value');
  });

  it('a devspace that is not in the registry, or of another Docker host, sends nothing', async () => {
    const { h, sent } = harness(async () => ({ decision: 'delete', additionalVolumesToRemove: [] }));
    expect(await h.operations.deleteCheckInWorker('6b1f0c2e-1d4a-4f5e-9a8b-7c6d5e4f3a2b', { progress: h.progress, repository: 'acme/api', otherWindow: false })).toEqual({ decision: 'cancel' });
    const other = harness(async () => ({ decision: 'delete', additionalVolumesToRemove: [] }), { dockerTarget: async () => ({ kind: 'remote', host: 'build-box', endpoint: 'ssh://build-box' }) });
    await seedDevspace(other.h, { container: 'stopped' });
    expect(await rejection(other.h.operations.deleteCheckInWorker(ENV_ID, { progress: other.h.progress, repository: 'acme/api', otherWindow: false }))).toMatchObject({ code: 'otherDockerHost' });
    expect([...sent, ...other.sent]).toEqual([]);
  });
});
