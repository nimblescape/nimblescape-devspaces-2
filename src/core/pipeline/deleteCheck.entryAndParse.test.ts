// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Probes of deleteCheck.ts and parseDeleteCheckValue.
import { describe, expect, it, vi } from 'vitest';
import { parseDeleteCheckValue } from '../helperChannel/protocol';
import type { Devspace, GitSummary } from '../types';
import { deleteCheck, type DeleteCheckDeps, type RemovableVolumes } from './deleteCheck';

const DEVSPACE = { id: 'e1', repository: 'acme/api', lastUsedAt: '2026-10-04T09:00:00.000Z' } as unknown as Devspace;
const SUMMARY = { branch: 'main', uncommittedFiles: 2, unpushedCommits: 1, recordedAt: '2026-10-04T10:00:00.000Z' } as GitSummary;

/** The one answer of the removable volumes (removableVolumes), empty lists unless given. */
const volumes = (lists: Partial<RemovableVolumes> = {}): RemovableVolumes => ({ additional: [], serviceData: [], possibly: [], ...lists });

function deps(overrides: Partial<DeleteCheckDeps> = {}) {
  const ui = {
    confirmDelete: vi.fn(async () => 'delete' as 'delete' | 'open' | undefined),
    deleteAdditionalVolumes: vi.fn(async () => 'remove' as 'remove' | 'keep' | undefined),
    deleteServiceData: vi.fn(async (volumes: readonly string[]) => [...volumes] as string[] | undefined),
  };
  const all: DeleteCheckDeps = {
    summary: async () => SUMMARY,
    devspace: async () => DEVSPACE,
    repositoryServiceData: async () => [],
    // The one read of the removable volumes.
    removableVolumes: async () => volumes(),
    ui,
    ...overrides,
  };
  return { all, ui };
}

describe('deleteCheck, probes', () => {
  it('a failed read of the registry before the confirmation names the entry of the start', async () => {
    let reads = 0;
    const { all, ui } = deps({ devspace: async () => (++reads === 1 ? Promise.reject(new Error('locked')) : DEVSPACE) });
    expect(await deleteCheck(all, DEVSPACE, 'acme/api', false)).toEqual({ decision: 'delete', additionalVolumesToRemove: [] });
    expect(ui.confirmDelete).toHaveBeenCalledWith('acme/api', expect.objectContaining({ lastSeenInUse: DEVSPACE.lastUsedAt }));
  });

  it('the volumes of the entry as it is after the confirmation are asked about', async () => {
    const later = { ...DEVSPACE, additionalVolumes: ['api-cache'] } as Devspace;
    let reads = 0;
    // The one read of the removable volumes.
    const { all, ui } = deps({ devspace: async () => (++reads === 1 ? DEVSPACE : later), removableVolumes: async () => volumes({ additional: ['api-cache'] }) });
    expect(await deleteCheck(all, DEVSPACE, 'acme/api', false)).toEqual({ decision: 'delete', additionalVolumesToRemove: ['api-cache'] });
    expect(ui.deleteAdditionalVolumes).toHaveBeenCalledWith(['api-cache']);
  });

  it('an entry without additional volumes asks nothing about data of services', async () => {
    // The one read of the removable volumes, which is not asked either.
    const removableVolumes = vi.fn(async () => volumes({ serviceData: ['api-db'] }));
    const { all, ui } = deps({ removableVolumes });
    expect(await deleteCheck(all, DEVSPACE, 'acme/api', false)).toEqual({ decision: 'delete', additionalVolumesToRemove: [] });
    expect(ui.deleteServiceData).not.toHaveBeenCalled();
    expect(removableVolumes).not.toHaveBeenCalled();
  });
});

describe('parseDeleteCheckValue, probes', () => {
  it('a refusal with other keys is invalid', () => {
    expect(parseDeleteCheckValue({ refused: { code: 'otherAccount', message: 'x' } })).toBeDefined();
    expect(parseDeleteCheckValue({ refused: { code: 'otherAccount', message: 'x' }, decision: 'delete' })).toBeUndefined();
  });
});
