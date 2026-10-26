// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Mutation tests of DevspaceService.deleteCheck and deleteCheckInWorker.
import { describe, expect, it, vi } from 'vitest';
import { ENV_ID, createHarness, seedDevspace, type HarnessOverrides } from './devspaceService.testkit';

function harness(answer: (op: string, params: unknown) => Promise<unknown>, overrides: HarnessOverrides = {}) {
  const sent: { op: string; params: unknown }[] = [];
  const h = createHarness({ ...overrides, flow: async (op, params) => (sent.push({ op, params }), answer(op, params)) });
  return { h, sent };
}
const rejection = (p: Promise<unknown>) => p.then((value) => ({ resolved: value }), (error: unknown) => error);

describe('DevspaceService.deleteCheck (local, as the worker runs it)', () => {
  it('names the data folders that the containers of the other services mount', async () => {
    const h = createHarness();
    await seedDevspace(h, { container: 'stopped' });
    vi.spyOn(h.service, 'repositoryServiceData').mockResolvedValue(['data/db']);
    const confirm = vi.spyOn(h.ui, 'confirmDelete');
    await h.service.deleteCheck(ENV_ID, { progress: h.progress, repository: 'acme/api', otherWindow: false });
    expect(confirm.mock.calls[0][1]).toMatchObject({ repositoryData: ['data/db'] });
  });

  it('a check cancelled while the user answered is cancelled, not a decision', async () => {
    const h = createHarness();
    await seedDevspace(h, { container: 'stopped' });
    const controller = new AbortController();
    vi.spyOn(h.ui, 'confirmDelete').mockImplementation(async () => (controller.abort(), 'delete'));
    expect(await rejection(h.service.deleteCheck(ENV_ID, { progress: h.progress, signal: controller.signal, repository: 'acme/api', otherWindow: false }))).toMatchObject({ code: 'cancelled' });
  });
});

describe('DevspaceService.deleteCheckInWorker', () => {
  it('sends the remote Docker host of the operation', async () => {
    const { h, sent } = harness(async () => ({ decision: 'cancel' }), { dockerTarget: async () => ({ kind: 'remote', host: 'build-box', endpoint: 'ssh://build-box' }) });
    await seedDevspace(h, { container: 'stopped' });
    await h.registry.updateDevspace(ENV_ID, (entry) => {
      entry.dockerHost = 'build-box';
    });
    await h.operations.deleteCheckInWorker(ENV_ID, { progress: h.progress, repository: 'acme/api', otherWindow: false });
    expect((sent[0].params as { dockerHost: string }).dockerHost).toBe('build-box');
  });

  it('parameters that do not fit (an empty name) are not sent', async () => {
    const { h, sent } = harness(async () => ({ decision: 'cancel' }));
    await seedDevspace(h, { container: 'stopped' });
    expect(((await rejection(h.operations.deleteCheckInWorker(ENV_ID, { progress: h.progress, repository: '', otherWindow: false }))) as Error).message).toContain('cannot be sent');
    expect(sent).toEqual([]);
  });

  it('a failure after the cancel is the cancellation', async () => {
    const controller = new AbortController();
    const { h } = harness(async () => {
      controller.abort();
      throw new Error('the channel went away');
    });
    await seedDevspace(h, { container: 'stopped' });
    expect(await rejection(h.operations.deleteCheckInWorker(ENV_ID, { progress: h.progress, signal: controller.signal, repository: 'acme/api', otherWindow: false }))).toMatchObject({ code: 'cancelled' });
  });
});
