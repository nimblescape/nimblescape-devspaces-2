// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { availableDevspaces, isAvailableTo, ownerOf } from './ownership';
import type { Devspace, GitHubAccount } from './types';

const SCALARION: GitHubAccount = { id: '1001', login: 'scalarion' };
const STAUSSH: GitHubAccount = { id: '2002', login: 'staussh' };
const OTHER: GitHubAccount = { id: '3003', login: 'other' };

function devspace(id: string, repository: string, owner: GitHubAccount): Devspace {
  return {
    id,
    repository,
    configPath: '.devcontainer/devcontainer.json',
    volumeName: `devspaces-${id}`,
    containerName: `devspaces-${id}`,
    createdAt: '2026-09-24T10:00:00.000Z',
    lastUsedAt: '2026-09-24T10:00:00.000Z',
    owner,
  };
}

describe('isAvailableTo', () => {
  it.each([
    ['the owner', { owner: SCALARION }, SCALARION, true],
    ['the owner with another login (renamed on GitHub)', { owner: { id: '1001', login: 'old-name' } }, SCALARION, true],
    ['an owner restored from a volume label (no login yet)', { owner: { id: '1001', login: '' } }, SCALARION, true],
    ['another account', { owner: SCALARION }, STAUSSH, false],
    ['another account with the same login', { owner: SCALARION }, { id: '3003', login: 'scalarion' }, false],
    ['nobody signed in', { owner: SCALARION }, undefined, false],
  ])('%s', (_name, devspace: Pick<Devspace, 'owner'>, account: GitHubAccount | undefined, expected) => {
    expect(isAvailableTo(devspace, account)).toBe(expected);
  });

  it('keeps only the devspaces of the account, in their order', () => {
    const list = [devspace('a', 'o/a', SCALARION), devspace('b', 'o/b', STAUSSH), devspace('c', 'o/c', OTHER), devspace('d', 'o/d', SCALARION)];
    expect(availableDevspaces(list, SCALARION).map((entry) => entry.id)).toEqual(['a', 'd']);
    expect(availableDevspaces(list, STAUSSH).map((entry) => entry.id)).toEqual(['b']);
    expect(availableDevspaces(list, undefined)).toEqual([]);
  });

  it('stores the ID and the login of the account as the owner', () => {
    expect(ownerOf({ ...SCALARION, extra: 1 } as GitHubAccount)).toEqual(SCALARION);
  });
});
