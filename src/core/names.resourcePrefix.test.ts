// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// One `devspaces-` prefix of the names of a devspace, for the names, the list of the devspace images
// (EngineDocker) and the image-ownership check of the host access policy (policy/images.ts).
import { describe, expect, it } from 'vitest';
import { RESOURCE_NAME_PREFIX, isDevspaceResourceName, resourceName } from './names';
import { devspaceImageNames } from './policy/images';
import { unusedEngine } from './worker/dockerEngine.testkit';
import { EngineDocker } from './worker/engineDocker';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';

describe('the resource prefix', () => {
  it('is devspaces-, the start of every name of a devspace', () => {
    expect(RESOURCE_NAME_PREFIX).toBe('devspaces-');
    const name = resourceName('acme/api', ID);
    expect(name.startsWith(RESOURCE_NAME_PREFIX)).toBe(true);
    expect(isDevspaceResourceName(name)).toBe(true);
  });

  it('is the one of the image-ownership check of the policy: the same name with another start is no devspace image', () => {
    const name = resourceName('acme/api', ID);
    expect(devspaceImageNames(`${name}:2`)).toEqual([name]);
    expect(devspaceImageNames(`${name}-db:latest`)).toEqual([name]);
    const other = `devenx-${name.slice(RESOURCE_NAME_PREFIX.length)}`;
    expect(isDevspaceResourceName(other)).toBe(false);
    expect(devspaceImageNames(`${other}:2`)).toEqual([]);
  });

  it('is the one of the list of the devspace images', async () => {
    const filters: unknown[] = [];
    const docker = new EngineDocker({
      ...unusedEngine(),
      images: async (filter) => (filters.push(filter), [{ id: 'sha256:a', repoTags: [`${RESOURCE_NAME_PREFIX}a:1`, 'devenx-a:1'], repoDigests: [], labels: {}, created: 'c' }]),
    });
    expect(await docker.listDevspaceImages()).toEqual([{ id: 'sha256:a', tags: ['devspaces-a:1'], createdAt: 'c' }]);
    expect(filters).toEqual([{ reference: ['devspaces-*'] }]);
  });
});
