// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Mutation probes: the open in the worker from the extension's side. The trust of the repository is sent as it is; the
// answer of the worker is checked against this window's registry on each of its own terms: the devspace of the open,
// of the signed-in account and of the Docker host of the operation, each with all other terms fitting; the default of
// stopOnClose is on.
import type { OperationFlow } from './devspaceOperations';
import { describe, expect, it } from 'vitest';
import { ENV_ID, OTHER_ACCOUNT, OTHER_ID, REPO, createHarness, seedDevspace } from './devspaceService.testkit';

const OPENED = { devspaceId: ENV_ID, containerName: 'devspaces-acme-api-c', remoteWorkspaceFolder: '/workspaces/api' };
const TARGET = { repository: REPO, defaultBranch: null, configPaths: ['.devcontainer/devcontainer.json'], trusted: true };

function harness(answer: (h: ReturnType<typeof createHarness>) => Promise<unknown>) {
  const sent: Record<string, unknown>[] = [];
  const h: ReturnType<typeof createHarness> = createHarness({
    monitorSource: () => '0123456789abcdef0123456789abcdef',
    openMonitor: () => ({ images: { schedule: '7 6 * * *', timeZone: 'UTC' } }),
    flow: (async (_op: string, params: unknown) => (sent.push(params as Record<string, unknown>), answer(h))) as OperationFlow,
  });
  return { h, sent };
}

const rejection = (promise: Promise<unknown>) => promise.then((value) => ({ resolved: value }), (error: unknown) => error);
const notTheOne = (error: unknown) => expect((error as Error).message).toContain('not the one of the open');

describe('the open in the worker: trust, answer and defaults', () => {
  it('the trust of an untrusted repository is sent as it is (the worker asks the confirmation)', async () => {
    const { h, sent } = harness(async () => ({ opened: OPENED }));
    await seedDevspace(h, { container: 'stopped' });
    await h.operations.openInWorker({ ...TARGET, trusted: false }, { progress: h.progress });
    expect(sent[0]).toMatchObject({ target: { trusted: false } });
  });

  it('an answer with another devspace of the same account, host and folder is refused', async () => {
    const { h } = harness(async () => ({ opened: { ...OPENED, devspaceId: OTHER_ID } }));
    await seedDevspace(h, { container: 'stopped' });
    await seedDevspace(h, { id: OTHER_ID, repository: 'acme/web', container: 'stopped', extra: { remoteWorkspaceFolder: OPENED.remoteWorkspaceFolder } });
    notTheOne(await rejection(h.operations.openDevspaceInWorker(ENV_ID, { progress: h.progress })));
  });

  it('the open of a repository is answered with the devspace of that repository for the account only', async () => {
    const { h } = harness(async () => ({ opened: { ...OPENED, devspaceId: OTHER_ID } }));
    await seedDevspace(h, { container: 'stopped' });
    // Of another repository, but with the same folder: only the expected devspace tells them apart.
    await seedDevspace(h, { id: OTHER_ID, repository: 'acme/web', container: 'stopped', extra: { remoteWorkspaceFolder: OPENED.remoteWorkspaceFolder } });
    notTheOne(await rejection(h.operations.openInWorker(TARGET, { progress: h.progress })));
  });

  it('a devspace that belongs to another account by the time of the answer is refused', async () => {
    const { h } = harness(async (hh) => {
      await hh.registry.updateDevspace(ENV_ID, (entry) => void (entry.owner = OTHER_ACCOUNT));
      return { opened: OPENED };
    });
    await seedDevspace(h, { container: 'stopped' });
    notTheOne(await rejection(h.operations.openDevspaceInWorker(ENV_ID, { progress: h.progress })));
  });

  it('a devspace that is on another Docker host by the time of the answer is refused', async () => {
    const { h } = harness(async (hh) => {
      await hh.registry.updateDevspace(ENV_ID, (entry) => void (entry.dockerHost = 'ssh://box'));
      return { opened: OPENED };
    });
    await seedDevspace(h, { container: 'stopped' });
    notTheOne(await rejection(h.operations.openDevspaceInWorker(ENV_ID, { progress: h.progress })));
  });

  it('without the setting stopOnClose, the open stops the container on close (its default)', async () => {
    const { h, sent } = harness(async () => ({ opened: OPENED }));
    await seedDevspace(h, { container: 'stopped' });
    const { stopOnClose: _unset, ...settings } = h.settings;
    h.settings = settings as typeof h.settings;
    await h.operations.openDevspaceInWorker(ENV_ID, { progress: h.progress });
    expect(sent[0]).toMatchObject({ settings: { stopOnClose: true } });
  });
});
