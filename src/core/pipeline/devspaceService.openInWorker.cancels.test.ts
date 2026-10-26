// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// A question that the user cancels in the worker is a cancel; a devspace of another account is never sent; the
// answer names the folder that the open recorded.
import type { OperationFlow } from './devspaceOperations';
import { describe, expect, it } from 'vitest';
import { UserFacingError } from '../errors';
import { HelperOperationError } from '../helperChannel/helperChannel';
import type { BusyMark } from '../types';
import { ENV_ID, OTHER_ACCOUNT, PID, WINDOW_ID, createHarness, seedDevspace } from './devspaceService.testkit';

const OPENED = { devspaceId: ENV_ID, containerName: 'devspaces-acme-api-c', remoteWorkspaceFolder: '/workspaces/api' };

function harness(answer: () => Promise<unknown>) {
  const sent: string[] = [];
  const h = createHarness({
    monitorSource: () => '0123456789abcdef0123456789abcdef',
    openMonitor: () => ({ images: { schedule: '7 6 * * *', timeZone: 'UTC' } }),
    flow: (async (op: string) => (sent.push(op), answer())) as OperationFlow,
  });
  return { h, sent };
}

const rejection = (promise: Promise<unknown>) => promise.then((value) => ({ resolved: value }), (error: unknown) => error);

describe('the open in the worker: cancels and refusals', () => {
  it('a question that the user cancelled in the worker is a cancel; the worker cleaned up, nothing is cleaned here', async () => {
    const { h } = harness(async () => {
      throw new HelperOperationError('cancelled', 'The operation was cancelled.', false);
    });
    const mark: BusyMark = { operation: 'update', since: new Date().toISOString(), pid: PID, windowId: WINDOW_ID };
    await seedDevspace(h, { container: 'stopped', extra: { busy: mark } });
    const error = await rejection(h.operations.openDevspaceInWorker(ENV_ID, { progress: h.progress }));
    expect(error).toBeInstanceOf(UserFacingError);
    expect(error).toMatchObject({ code: 'cancelled' });
    expect((await h.registry.get(ENV_ID))?.busy).toEqual(mark);
  });

  it('a time limit of the worker is no cancel of the user; this window cleans up', async () => {
    const { h } = harness(async () => {
      throw new HelperOperationError('cancelled', 'The operation ended at its time limit.', true);
    });
    await seedDevspace(h, { container: 'stopped', extra: { busy: { operation: 'update', since: new Date().toISOString(), pid: PID, windowId: WINDOW_ID } } });
    const error = await rejection(h.operations.openDevspaceInWorker(ENV_ID, { progress: h.progress }));
    expect(error).toBeInstanceOf(HelperOperationError);
    expect(error).not.toBeInstanceOf(UserFacingError);
    expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
  });

  it('a devspace of another account is refused before anything is sent', async () => {
    const { h, sent } = harness(async () => ({ opened: OPENED }));
    await seedDevspace(h, { container: 'stopped', owner: OTHER_ACCOUNT });
    expect(await rejection(h.operations.openDevspaceInWorker(ENV_ID, { progress: h.progress }))).toMatchObject({ code: 'otherAccount' });
    expect(sent).toEqual([]);
  });

  it('an answer whose folder is not the one that the open recorded is refused', async () => {
    const { h } = harness(async () => ({ opened: { ...OPENED, remoteWorkspaceFolder: '/workspaces/other' } }));
    await seedDevspace(h, { container: 'stopped' });
    expect(((await rejection(h.operations.openDevspaceInWorker(ENV_ID, { progress: h.progress }))) as Error).message).toContain('not the one of the open');
  });

  // A worker that ended the operation itself (its shutdown) is no cancel of the user.
  it('a cancel of the worker itself is no cancel of the user; this window cleans up', async () => {
    const { h } = harness(async () => {
      throw new HelperOperationError('cancelled', 'The worker ends.', false, true);
    });
    await seedDevspace(h, { container: 'stopped', extra: { busy: { operation: 'update', since: new Date().toISOString(), pid: PID, windowId: WINDOW_ID } } });
    const error = await rejection(h.operations.openDevspaceInWorker(ENV_ID, { progress: h.progress }));
    expect(error).not.toBeInstanceOf(UserFacingError);
    expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
  });
});
