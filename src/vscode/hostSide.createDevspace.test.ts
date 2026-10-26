// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.
// The HostSide of this window records the configuration path and the default image of the request of a first open as
// they are (`record createDevspace`): the kind of the devspace is in its entry from the start.
import { expect, it } from 'vitest';
import { resourceName } from '../core/names';
import { silentLogger } from '../core/ports';
import type { DevspaceRegistry } from '../core/storage/registry';
import type { RegistryFile } from '../core/types';
import { extensionHostSide, type HostSideDeps } from './hostSide';

const NEW = '6b1f0c2e-1d4a-4f5e-9a8b-7c6d5e4f3a2b';

function depsOf(): { deps: HostSideDeps; file: () => RegistryFile } {
  let file: RegistryFile = { version: 1, devspaces: [] };
  const update = (async <T>(mutator: (file: RegistryFile) => T | Promise<T>) => {
    const copy = structuredClone(file);
    const result = await mutator(copy);
    file = copy;
    return structuredClone(result);
  }) as DevspaceRegistry['update'];
  const deps = {
    registry: { update, updateDevspace: async () => undefined },
    sessionFiles: { readWindowStatuses: async () => [] },
    ui: {},
    auth: { getAccount: async () => ({ id: '42', login: 'octo' }) },
    credentials: {},
    settings: () => ({}),
    windowId: 'w1',
    pid: 100,
    clock: { now: () => Date.parse('2026-10-05T12:00:00.000Z') },
    isProcessAlive: () => true,
    logger: silentLogger,
  } as unknown as HostSideDeps;
  return { deps, file: () => file };
}

it('the entry of a first open of a default-image devspace keeps the default image of the request, and is named with its source', async () => {
  const { deps, file } = depsOf();
  const image = 'ghcr.io/acme/base:latest';
  const created = await extensionHostSide(deps).records.createDevspace(NEW, 'acme/api', '.devcontainer/devcontainer.json', { dockerHost: 'ssh://box' }, image);
  expect(created).toMatchObject({ defaultImage: image, configPath: '.devcontainer/devcontainer.json', volumeName: resourceName('acme/api', NEW, 'default') });
  expect(file().devspaces[0]).toMatchObject({ defaultImage: image });
  // A configuration devspace of the same repository next to it: another source.
  const other = '7c1d2e3f-0000-4000-8000-000000000002';
  const configuration = await extensionHostSide(deps).records.createDevspace(other, 'acme/api', '.devcontainer/devcontainer.json', { dockerHost: 'ssh://box' });
  expect(configuration).toMatchObject({ id: other, volumeName: resourceName('acme/api', other, 'config') });
  expect(configuration).not.toHaveProperty('defaultImage');
  expect(file().devspaces.map((entry) => entry.id)).toEqual([NEW, other]);
  // A second default-image devspace of the repository: the answer is the existing one.
  const third = '8d2e3f40-0000-4000-8000-000000000003';
  expect((await extensionHostSide(deps).records.createDevspace(third, 'acme/api', '.devcontainer/devcontainer.json', { dockerHost: 'ssh://box' }, 'ghcr.io/acme/base:2')).id).toBe(NEW);
  expect(file().devspaces).toHaveLength(2);
});

it('the entry of a first open keeps the configuration path of the request', async () => {
  for (const configPath of ['.devcontainer/devcontainer.json', '.devcontainer/python/devcontainer.json']) {
    let file: RegistryFile = { version: 1, devspaces: [] };
    const update = (async <T>(mutator: (file: RegistryFile) => T | Promise<T>) => {
      const copy = structuredClone(file);
      const result = await mutator(copy);
      file = copy;
      return structuredClone(result);
    }) as DevspaceRegistry['update'];
    const deps = {
      registry: { update, updateDevspace: async () => undefined },
      sessionFiles: { readWindowStatuses: async () => [] },
      ui: {},
      auth: { getAccount: async () => ({ id: '42', login: 'octo' }) },
      credentials: {},
      settings: () => ({}),
      windowId: 'w1',
      pid: 100,
      clock: { now: () => Date.parse('2026-10-05T12:00:00.000Z') },
      isProcessAlive: () => true,
      logger: silentLogger,
    } as unknown as HostSideDeps;
    const created = await extensionHostSide(deps).records.createDevspace(NEW, 'acme/api', configPath, { dockerHost: 'ssh://box' });
    expect(created.configPath).toBe(configPath);
    expect(file.devspaces[0]?.configPath).toBe(configPath);
  }
});
