// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The open from the extension's side: it signs in and starts the local Docker here, sends `open` to the worker of the
// Docker host of the operation with the settings, the image maintenance and the image references in use, shows the
// steps of the worker, and answers with the entry of the devspace that the worker opened (the window connects after
// the lock is released). A worker that ended without its answer could not clean up here: this window does (it marks the
// lifecycle as unknown).
import type { DevspaceOperationsDeps } from './devspaceOperations';
import type { OperationFlow } from './devspaceOperations';
import { describe, expect, it } from 'vitest';
import { UserFacingError } from '../errors';
import { HelperChannelError } from '../helperChannel/helperChannel';
import { OP_OPEN, OPEN_PROGRESS_DETAIL } from '../helperChannel/protocol';
import { type DevspaceServiceDeps } from './devspacePorts';
import { OPEN_FLOW_TIMEOUT_MS } from './operationBase';
import { DIGEST_NEW, ENV_ID, OTHER_ACCOUNT, OTHER_ID, PID, REPO, WINDOW_ID, createHarness, seedDevspace } from './devspaceService.testkit';
import { LIFECYCLE_UNKNOWN, windowLifecycleMemory } from './lifecycleMemory';
import type { BusyMark } from '../types';

type FlowOptions = Parameters<OperationFlow>[2];

const SOURCE = '0123456789abcdef0123456789abcdef';
const IMAGES = { schedule: '7 6 * * *', timeZone: 'UTC' };
const OPENED = { devspaceId: ENV_ID, containerName: 'devspaces-acme-api-c', remoteWorkspaceFolder: '/workspaces/api' };

function harness(answer: (op: string, params: unknown, options: FlowOptions) => Promise<unknown>, overrides: Partial<DevspaceServiceDeps & DevspaceOperationsDeps> = {}) {
  const sent: { op: string; params: Record<string, unknown>; timeoutMs?: number; signal?: AbortSignal }[] = [];
  const memory = windowLifecycleMemory();
  const h = createHarness({
    monitorSource: () => SOURCE,
    // The image maintenance of the open; there is no image list.
    openMonitor: () => ({ images: IMAGES }),
    lifecycleMemory: memory,
    ...overrides,
    flow: async (op, params, options) => {
      sent.push({ op, params: params as Record<string, unknown>, timeoutMs: options.timeoutMs, signal: options.signal });
      return answer(op, params, options);
    },
  });
  return { h, sent, memory };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (value) => ({ resolved: value }),
    (error: unknown) => error,
  );
}

const own = (operation: BusyMark['operation']): BusyMark => ({ operation, since: new Date().toISOString(), pid: PID, windowId: WINDOW_ID });

describe('the open in the worker, from the extension', () => {
  it('sends the devspace with the settings and the image maintenance, and answers with its entry', async () => {
    const { h, sent } = harness(async () => ({ opened: OPENED }));
    const seeded = await seedDevspace(h, { container: 'stopped' });
    const controller = new AbortController();
    const result = await h.operations.openDevspaceInWorker(ENV_ID, { progress: h.progress, signal: controller.signal, forceRebuild: true });
    expect(result).toEqual({ devspace: await h.registry.get(ENV_ID), containerName: OPENED.containerName, remoteWorkspaceFolder: OPENED.remoteWorkspaceFolder });
    expect(result.devspace.id).toBe(seeded.id);
    expect(sent).toEqual([
      {
        op: OP_OPEN,
        params: {
          dockerHost: '',
          owner: { windowId: WINDOW_ID, pid: PID },
          monitorSource: SOURCE,
          settings: { updateImagesOnConnect: true, hostAccessChecks: 'on', stopOnClose: true, respectShutdownActionNone: false },
          images: IMAGES,
          // The image references in use of the build records on this engine.
          references: ['mcr.microsoft.com/devcontainers/base:ubuntu'],
          // With the digest that the open recorded for it.
          referenceDigests: { 'mcr.microsoft.com/devcontainers/base:ubuntu': [DIGEST_NEW] },
          repository: REPO,
          devspaceId: ENV_ID,
          forceRebuild: true,
        },
        timeoutMs: OPEN_FLOW_TIMEOUT_MS,
        signal: controller.signal,
      },
    ]);
    // Nothing of the pipeline ran here.
    expect(h.helper.calls).toEqual([]);
    expect(h.lock.acquired).toEqual([]);
  });

  it('the open of a repository: its target, and the devspace that the worker found or created for the account', async () => {
    let answer: unknown = { opened: OPENED };
    const { h, sent } = harness(async () => answer);
    await seedDevspace(h, { container: 'stopped' });
    const target = { repository: REPO, defaultBranch: null, configPaths: ['.devcontainer/devcontainer.json'], trusted: true };
    expect((await h.operations.openInWorker(target, { progress: h.progress })).devspace.id).toBe(ENV_ID);
    expect(sent[0].params).toMatchObject({ repository: REPO, target: { defaultBranch: null, configPaths: ['.devcontainer/devcontainer.json'], trusted: true } });
    expect(sent[0].params).not.toHaveProperty('devspaceId');
    // An answer that names a devspace that is not the one of the repository of the account is refused.
    await seedDevspace(h, { id: OTHER_ID, repository: 'acme/web', container: 'stopped' });
    answer = { opened: { ...OPENED, devspaceId: OTHER_ID } };
    expect(((await rejection(h.operations.openInWorker(target, { progress: h.progress }))) as Error).message).toContain('not the one of the open');
  });

  it('never answers with a devspace of another account or Docker host', async () => {
    const { h } = harness(async () => ({ opened: OPENED }));
    await seedDevspace(h, { container: 'stopped', owner: OTHER_ACCOUNT });
    expect(await rejection(h.operations.openDevspaceInWorker(ENV_ID, { progress: h.progress }))).toBeInstanceOf(Error);
    const elsewhere = harness(async () => ({ opened: OPENED }));
    await seedDevspace(elsewhere.h, { container: 'stopped', extra: { dockerHost: 'ssh://box' } });
    // The entry of another Docker host is refused before anything is sent.
    expect(await rejection(elsewhere.h.operations.openDevspaceInWorker(ENV_ID, { progress: elsewhere.h.progress }))).toBeInstanceOf(UserFacingError);
    expect(elsewhere.sent).toEqual([]);
  });

  it('the host access checks of the repository only, and the time limit of the heartbeats', async () => {
    const { h, sent } = harness(async () => ({ opened: OPENED }));
    await seedDevspace(h, { container: 'stopped' });
    h.settings = { ...h.settings, hostAccessChecksOff: ['acme/other', REPO.toUpperCase()], stopAfterMinutes: 30, stopOnClose: false, respectShutdownActionNone: true };
    await h.operations.openDevspaceInWorker(ENV_ID, { progress: h.progress });
    expect(sent[0].params.settings).toEqual({ updateImagesOnConnect: true, hostAccessChecks: 'off', stopOnClose: false, respectShutdownActionNone: true, stopAfterMinutes: 30 });
  });

  it('waits for the Monitor settings of the Docker host of the open (its mode follows the answer of that engine)', async () => {
    const hosts: string[] = [];
    const { h, sent } = harness(async () => ({ opened: OPENED }), {
      openMonitor: async (dockerHost) => {
        hosts.push(dockerHost);
        return { images: { ...IMAGES, permanent: false } };
      },
    });
    await seedDevspace(h, { container: 'stopped' });
    await h.operations.openDevspaceInWorker(ENV_ID, { progress: h.progress });
    expect(hosts).toEqual(['']);
    expect(sent[0].params.images).toEqual({ ...IMAGES, permanent: false });
  });

  it('shows the steps of the worker and their details; other steps of the operation are not shown', async () => {
    const { h } = harness(async (_op, _params, options) => {
      options.onProgress?.('open', ENV_ID);
      options.onProgress?.('checkingImage');
      options.onProgress?.(OPEN_PROGRESS_DETAIL, 'A newer image is available.');
      options.onProgress?.(OPEN_PROGRESS_DETAIL, 'x'.repeat(5000));
      options.onProgress?.('starting');
      options.onProgress?.('notAStep');
      return { opened: OPENED };
    });
    await seedDevspace(h, { container: 'stopped' });
    await h.operations.openDevspaceInWorker(ENV_ID, { progress: h.progress });
    expect(h.progress.steps).toEqual(['checkingImage', 'starting']);
    expect(h.progress.details[0]).toBe('A newer image is available.');
    expect(h.progress.details[1]).toHaveLength(1000);
  });

  it('signs in and starts Docker here first; without a sign-in nothing is sent', async () => {
    const { h, sent } = harness(async () => ({ opened: OPENED }));
    await seedDevspace(h, { container: 'stopped' });
    h.dockerStopped = true;
    await h.operations.openDevspaceInWorker(ENV_ID, { progress: h.progress });
    expect(h.dockerStarts).toBe(1);
    expect(h.progress.steps[0]).toBe('startingDocker');
    h.token = undefined;
    expect(await rejection(h.operations.openDevspaceInWorker(ENV_ID, { progress: h.progress }))).toMatchObject({ code: 'signInRequired' });
    expect(sent).toHaveLength(1);
  });

  it('without the computer or the image maintenance nothing is sent', async () => {
    for (const overrides of [{ monitorSource: undefined }, { openMonitor: undefined }] as Partial<DevspaceServiceDeps & DevspaceOperationsDeps>[]) {
      const { h, sent } = harness(async () => ({ opened: OPENED }), overrides);
      await seedDevspace(h, { container: 'stopped' });
      expect(((await rejection(h.operations.openDevspaceInWorker(ENV_ID, { progress: h.progress }))) as Error).message).toContain('cannot be sent to the worker');
      expect(sent).toEqual([]);
    }
  });

  it('throws the refusal of the worker as the UserFacingError it was', async () => {
    const { h } = harness(async () => ({ refused: { code: 'buildFailed', message: 'The devspace could not be prepared.', detail: 'log' } }));
    const mark = own('update');
    await seedDevspace(h, { container: 'stopped', extra: { busy: mark } });
    await h.sessionFiles.writePending(ENV_ID, WINDOW_ID);
    const error = await rejection(h.operations.openDevspaceInWorker(ENV_ID, { progress: h.progress }));
    expect(error).toBeInstanceOf(UserFacingError);
    expect(error).toMatchObject({ code: 'buildFailed', detail: 'log' });
    // The worker cleaned up itself (its requests were answered): nothing is changed here.
    expect((await h.registry.get(ENV_ID))?.busy).toEqual(mark);
    expect(await h.sessionFiles.readPendings()).toHaveLength(1);
  });
});

describe('a worker open that ended without its answer', () => {
  it('this window removes its pending file and its busy mark; a create mark stays as ended', async () => {
    for (const operation of ['update', 'rebuild', 'create'] as const) {
      const { h } = harness(async () => {
        throw new HelperChannelError('closed', 'The worker ended.');
      });
      await seedDevspace(h, { container: 'stopped', extra: { busy: own(operation) } });
      await h.sessionFiles.writePending(ENV_ID, WINDOW_ID);
      const error = await rejection(h.operations.openDevspaceInWorker(ENV_ID, { progress: h.progress }));
      expect(error, operation).toBeInstanceOf(UserFacingError);
      expect(await h.sessionFiles.readPendings(), operation).toEqual([]);
      const busy = (await h.registry.get(ENV_ID))?.busy;
      if (operation === 'create') expect(busy).toMatchObject({ operation: 'create', since: new Date(0).toISOString(), pid: PID, windowId: WINDOW_ID });
      else expect(busy, operation).toBeUndefined();
    }
  });

  it('never the mark of another window', async () => {
    const { h } = harness(async () => {
      throw new HelperChannelError('closed', 'The worker ended.');
    });
    const other: BusyMark = { operation: 'update', since: new Date().toISOString(), pid: PID + 1, windowId: 'window-2' };
    await seedDevspace(h, { container: 'stopped', extra: { busy: other } });
    await rejection(h.operations.openDevspaceInWorker(ENV_ID, { progress: h.progress }));
    expect((await h.registry.get(ENV_ID))?.busy).toEqual(other);
  });

  it('after the worker began `up`, the lifecycle of the devspace is unknown to this window', async () => {
    const before = harness(async (_op, _params, options) => {
      options.onProgress?.('checkingImage');
      throw new HelperChannelError('closed', 'The worker ended.');
    });
    await seedDevspace(before.h, { container: 'stopped' });
    await rejection(before.h.operations.openDevspaceInWorker(ENV_ID, { progress: before.h.progress }));
    expect(await before.memory.get(ENV_ID)).toBeUndefined();
    const after = harness(async (_op, _params, options) => {
      options.onProgress?.('starting');
      throw new HelperChannelError('closed', 'The worker ended.');
    });
    await seedDevspace(after.h, { container: 'stopped' });
    await rejection(after.h.operations.openDevspaceInWorker(ENV_ID, { progress: after.h.progress }));
    expect(await after.memory.get(ENV_ID)).toBe(LIFECYCLE_UNKNOWN);
    expect(after.h.logger.warnings.join('\n')).toContain('the next open of this window runs its lifecycle commands again');
  });

  it('the same for a cancel, and for an answer that does not fit; the open of a repository cleans up its devspace', async () => {
    const controller = new AbortController();
    const cancelled = harness(async (_op, _params, options) => {
      options.onProgress?.('starting');
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    await seedDevspace(cancelled.h, { container: 'stopped', extra: { busy: own('update') } });
    await rejection(cancelled.h.operations.openInWorker({ repository: REPO, configPaths: [], trusted: true }, { progress: cancelled.h.progress, signal: controller.signal }));
    expect((await cancelled.h.registry.get(ENV_ID))?.busy).toBeUndefined();
    expect(await cancelled.memory.get(ENV_ID)).toBe(LIFECYCLE_UNKNOWN);
    const odd = harness(async () => ({ opened: { ...OPENED, containerName: '-' } }));
    await seedDevspace(odd.h, { container: 'stopped', extra: { busy: own('update') } });
    expect(((await rejection(odd.h.operations.openDevspaceInWorker(ENV_ID, { progress: odd.h.progress }))) as Error).message).toContain('with an invalid value');
    expect((await odd.h.registry.get(ENV_ID))?.busy).toBeUndefined();
  });

  it('an open of a repository without a devspace cleans up nothing', async () => {
    const { h } = harness(async () => {
      throw new HelperChannelError('closed', 'The worker ended.');
    });
    expect(await rejection(h.operations.openInWorker({ repository: REPO, configPaths: [], trusted: true }, { progress: h.progress }))).toBeInstanceOf(UserFacingError);
    expect(await h.registry.list()).toEqual([]);
  });
});
