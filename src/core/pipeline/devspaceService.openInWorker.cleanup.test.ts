// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Mutation probes: the open in the worker. A missing devspace is never sent; only a cancel of a question (code
// `cancelled`) that the window did not abort itself skips the cleanup of this window.
import type { OperationFlow } from './devspaceOperations';
import { describe, expect, it } from 'vitest';
import { UserFacingError } from '../errors';
import { HelperOperationError } from '../helperChannel/helperChannel';
import { ENV_ID, PID, WINDOW_ID, createHarness, seedDevspace } from './devspaceService.testkit';

function harness(answer: (signal: AbortSignal | undefined) => Promise<unknown>) {
  const sent: string[] = [];
  const h = createHarness({
    monitorSource: () => '0123456789abcdef0123456789abcdef',
    openMonitor: () => ({ images: { schedule: '7 6 * * *', timeZone: 'UTC' } }),
    flow: (async (op: string, _params: unknown, options: { signal?: AbortSignal }) => (sent.push(op), answer(options.signal))) as OperationFlow,
  });
  return { h, sent };
}

const rejection = (promise: Promise<unknown>) => promise.then((value) => ({ resolved: value }), (error: unknown) => error);
const busyMark = () => ({ operation: 'update' as const, since: new Date().toISOString(), pid: PID, windowId: WINDOW_ID });

describe('the open in the worker: missing devspace and cleanup', () => {
  it('a devspace that is not in the registry is never sent', async () => {
    const { h, sent } = harness(async () => ({ opened: { devspaceId: ENV_ID, containerName: 'c', remoteWorkspaceFolder: '/workspaces/api' } }));
    const error = await rejection(h.operations.openDevspaceInWorker(ENV_ID, { progress: h.progress }));
    expect(error).toBeInstanceOf(UserFacingError);
    expect(error).toMatchObject({ code: 'startFailed' });
    expect(sent).toEqual([]);
  });

  it('a cancel after this window aborted the open is no cancel of a question; this window cleans up', async () => {
    const controller = new AbortController();
    const { h } = harness(async () => {
      controller.abort();
      throw new HelperOperationError('cancelled', 'The operation was cancelled.', false);
    });
    await seedDevspace(h, { container: 'stopped', extra: { busy: busyMark() } });
    await rejection(h.operations.openDevspaceInWorker(ENV_ID, { progress: h.progress, signal: controller.signal }));
    expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
  });

  it('another failure of the worker is no cancel; this window cleans up', async () => {
    const { h } = harness(async () => {
      throw new HelperOperationError('failed', 'The open failed.', false);
    });
    await seedDevspace(h, { container: 'stopped', extra: { busy: busyMark() } });
    const error = await rejection(h.operations.openDevspaceInWorker(ENV_ID, { progress: h.progress }));
    expect(error).toBeInstanceOf(HelperOperationError);
    expect(error).toMatchObject({ code: 'failed' });
    expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
  });
});
