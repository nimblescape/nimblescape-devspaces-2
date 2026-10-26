// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The open carries the image references in use on its engine (those of the build records of all devspaces of this
// computer there) for the Monitor, which keeps them up to date.
import { describe, expect, it, vi } from 'vitest';
import { MAX_IMAGE_REFERENCES } from '../remoteMonitor/protocol';
import type { DevspaceOperationsDeps, OperationFlow } from './devspaceOperations';
import { ENV_ID, OTHER_ACCOUNT, OTHER_ID, createHarness, seedDevspace } from './devspaceService.testkit';

const SOURCE = '0123456789abcdef0123456789abcdef';
const IMAGES = { schedule: '7 6 * * *', timeZone: 'UTC' };
const OPENED = { devspaceId: ENV_ID, containerName: 'devspaces-acme-api-c', remoteWorkspaceFolder: '/workspaces/api' };
const DIGEST = `sha256:${'a'.repeat(64)}`;

function harness(overrides: Pick<DevspaceOperationsDeps, 'imageReferencesInUse'> = {}) {
  const sent: Record<string, unknown>[] = [];
  const flow: OperationFlow = async (_op, params) => {
    sent.push(params as Record<string, unknown>);
    return { opened: OPENED };
  };
  const h = createHarness({ monitorSource: () => SOURCE, openMonitor: () => ({ images: IMAGES }), ...overrides, flow });
  return { h, sent };
}

describe('the image references in use of an open', () => {
  it('sends the references of the build records of every devspace of this computer on the engine of the open', async () => {
    const { h, sent } = harness();
    await seedDevspace(h, { container: 'stopped', record: { images: { 'node:20': DIGEST, [`ghcr.io/acme/pinned@${DIGEST}`]: DIGEST } } });
    // Another account on the same engine counts (when in doubt, an image stays); a Compose service image counts.
    await seedDevspace(h, {
      id: OTHER_ID,
      repository: 'acme/web',
      container: 'stopped',
      owner: OTHER_ACCOUNT,
      record: { images: { 'mcr.microsoft.com/devcontainers/base:ubuntu': DIGEST, 'not a reference': DIGEST }, compose: { service: 'app', images: [], serviceImages: ['postgres:16'], version: '2', inputsHash: 'h' } },
    });
    // A devspace of another engine and one without a build record do not.
    await seedDevspace(h, { id: '33333333-3333-4333-8333-333333333333', repository: 'acme/far', container: null, extra: { dockerHost: 'ssh://box' }, record: { images: { 'far:1': DIGEST } } });
    await seedDevspace(h, { id: '44444444-4444-4444-8444-444444444444', repository: 'acme/new', container: null, record: null });
    await h.operations.openDevspaceInWorker(ENV_ID, { progress: h.progress });
    expect(sent[0].references).toEqual([`ghcr.io/acme/pinned@${DIGEST}`, 'mcr.microsoft.com/devcontainers/base:ubuntu', 'node:20', 'postgres:16']);
    // With the digests that the opens recorded (not those of the other engine).
    expect(sent[0].referenceDigests).toEqual({ [`ghcr.io/acme/pinned@${DIGEST}`]: [DIGEST], 'mcr.microsoft.com/devcontainers/base:ubuntu': [DIGEST], 'node:20': [DIGEST] });
    expect(sent[0].monitorSource).toBe(SOURCE);
  });

  it('sends none when the registry cannot be read (the monitor keeps what this computer sent before)', async () => {
    const { h, sent } = harness();
    await seedDevspace(h, { container: 'stopped' });
    // Only the read of the references fails (the other reads of the open stay as they are).
    const original = h.registry.list.bind(h.registry);
    let failed = 0;
    vi.spyOn(h.registry, 'list').mockImplementation(async () => {
      if (!(new Error().stack ?? '').includes('referencesInUse')) return original();
      failed++;
      throw new Error('the registry is locked');
    });
    await h.operations.openDevspaceInWorker(ENV_ID, { progress: h.progress });
    expect(failed).toBe(1);
    expect(h.logger.warnings).toContain('The images in use could not be read for the Monitor: the registry is locked');
    expect(sent[0]).not.toHaveProperty('references');
  });

  // The injection point that the Docker tests use (no reference, so the Monitor of their engine manages none of
  // its images), and one that gives its own.
  it('takes the references of imageReferencesInUse when it is given', async () => {
    const none = harness({ imageReferencesInUse: async () => undefined });
    await seedDevspace(none.h, { container: 'stopped' });
    await none.h.operations.openDevspaceInWorker(ENV_ID, { progress: none.h.progress });
    expect(none.sent[0]).not.toHaveProperty('references');
    const given = harness({ imageReferencesInUse: async (dockerHost) => ({ references: dockerHost === '' ? ['node:20'] : [], digests: {} }) });
    await seedDevspace(given.h, { container: 'stopped' });
    await given.h.operations.openDevspaceInWorker(ENV_ID, { progress: given.h.progress });
    expect(given.sent[0].references).toEqual(['node:20']);
  });

  it(`sends at most ${MAX_IMAGE_REFERENCES} references`, async () => {
    const { h, sent } = harness();
    const images = Object.fromEntries(Array.from({ length: MAX_IMAGE_REFERENCES + 5 }, (_, index) => [`ghcr.io/acme/image-${String(index).padStart(3, '0')}:1`, DIGEST]));
    await seedDevspace(h, { container: 'stopped', record: { images } });
    await h.operations.openDevspaceInWorker(ENV_ID, { progress: h.progress });
    expect(sent[0].references).toHaveLength(MAX_IMAGE_REFERENCES);
  });
});
