// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.
// The bound of the build number as a literal, the dedupe of the volume names of a request, the cap of the additional
// volumes for a request that repeats a name, the count line of the log of the left-out volumes at exactly
// MAX_LEFT_OUT_LINES lines, and the case-insensitive clash with a volume that a Delete of another account kept.
import { describe, expect, it } from 'vitest';
import { resourceName } from '../names';
import type { BusyMarkView } from '../pipeline/busyMarks';
import { silentLogger, type Logger } from '../ports';
import type { DevspaceRegistry } from '../storage/registry';
import type { Devspace, GitHubAccount, KeptVolume, RegistryFile } from '../types';
import { checkedBuildChange, checkedConfigurationChange, requestOpenRecords } from './openRequests';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const NEW = '6b1f0c2e-1d4a-4f5e-9a8b-7c6d5e4f3a2b';
const REPOSITORY = 'acme/api';
const HOST = 'ssh://box';
const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const ACCOUNT: GitHubAccount = { id: '42', login: 'octo' };
const THEIRS: GitHubAccount = { id: '7', login: 'other' };
const DEFAULT = '.devcontainer/devcontainer.json';

const entryOf = (id: string, fields: Partial<Devspace> = {}): Devspace =>
  ({
    id,
    repository: REPOSITORY,
    configPath: DEFAULT,
    volumeName: resourceName(REPOSITORY, id),
    containerName: resourceName(REPOSITORY, id),
    createdAt: '2020-01-01T00:00:00.000Z',
    lastUsedAt: '2020-01-01T00:00:00.000Z',
    owner: ACCOUNT,
    dockerHost: HOST,
    ...fields,
  }) as Devspace;

/** requestOpenRecords of ACCOUNT on HOST over an in-memory registry file, with the warnings that it logs. */
function setup(entries: readonly Devspace[], kept: readonly KeptVolume[] = []) {
  let file: RegistryFile = { version: 1, devspaces: structuredClone([...entries]), ...(kept.length > 0 ? { keptVolumes: structuredClone([...kept]) } : {}) };
  const update = (async <T>(mutator: (file: RegistryFile) => T | Promise<T>) => {
    const copy = structuredClone(file);
    const result = await mutator(copy);
    file = copy;
    return structuredClone(result);
  }) as DevspaceRegistry['update'];
  const registry: Pick<DevspaceRegistry, 'update' | 'updateDevspace'> = {
    update,
    updateDevspace: (id, mutator) =>
      update(async (f) => {
        const found = f.devspaces.find((candidate) => candidate.id === id);
        if (!found) return undefined;
        await mutator(found);
        return found;
      }),
  };
  const warnings: string[] = [];
  const logger: Logger = { ...silentLogger, warn: (text) => warnings.push(text) };
  const view: BusyMarkView = { owner: { windowId: 'w1', pid: 100 }, clock: { now: () => NOW }, isAlive: () => true, windowStatuses: async () => [], logger };
  const records = requestOpenRecords(registry, view, { account: ACCOUNT, dockerHost: HOST });
  return { records, warnings, file: () => file };
}

describe('the source of a devspace in a change of the configuration', () => {
  const PYTHON = '.devcontainer/python/devcontainer.json';
  const IMAGE = 'ghcr.io/acme/base:latest';

  it('a selected configuration of the source of the devspace: the root configuration under either file name, the folder of an alternative one', async () => {
    const { records } = setup([entryOf(ID), entryOf(NEW, { configPath: PYTHON })]);
    expect((await records.configuration(ID, { select: '.devcontainer.json' }))?.configPath).toBe('.devcontainer.json');
    expect((await records.configuration(ID, { select: DEFAULT }))?.configPath).toBe(DEFAULT);
    expect((await records.configuration(NEW, { select: PYTHON }))?.configPath).toBe(PYTHON);
  });

  it('refuses a selected configuration of another source, and writes nothing', async () => {
    const { records, file } = setup([entryOf(ID), entryOf(NEW, { configPath: PYTHON })]);
    await expect(records.configuration(ID, { select: PYTHON, shutdownActionNone: true })).rejects.toThrow('not the source of the devspace');
    await expect(records.configuration(NEW, { select: DEFAULT })).rejects.toThrow('not the source of the devspace');
    expect(file().devspaces.map((entry) => [entry.configPath, entry.shutdownActionNone])).toEqual([
      [DEFAULT, undefined],
      [PYTHON, undefined],
    ]);
  });

  it('a default image only for a default-image devspace (its configuration is the root one)', async () => {
    const { records, file } = setup([entryOf(ID), entryOf(NEW, { defaultImage: IMAGE })]);
    expect((await records.configuration(NEW, { select: DEFAULT, defaultImage: 'ghcr.io/acme/base:2' }))?.defaultImage).toBe('ghcr.io/acme/base:2');
    await expect(records.configuration(ID, { defaultImage: IMAGE })).rejects.toThrow('no default-image devspace');
    await expect(records.configuration(NEW, { select: PYTHON })).rejects.toThrow('not the source of the devspace');
    expect(file().devspaces.find((entry) => entry.id === ID)).not.toHaveProperty('defaultImage');
  });
});

describe('the registry writes of an open: build numbers and volume names', () => {
  // There is no build change `checked`.
  it('a check of the images is no build change', () => {
    expect(() => checkedBuildChange('checked', [])).toThrow();
  });

  it('a build number of 1000000000 is taken, one above it is refused (MAX_BUILD_NUMBER)', () => {
    expect(checkedBuildChange('number', [1_000_000_000])).toEqual({ kind: 'number', buildNumber: 1_000_000_000 });
    expect(() => checkedBuildChange('number', [1_000_000_001])).toThrow();
  });

  it('a request names each volume once: the checked change drops the repeats', () => {
    expect(checkedConfigurationChange({ addVolumes: ['a', 'b', 'a', 'a'], addServiceVolumes: ['b', 'b', 'a'] })).toEqual({ addVolumes: ['a', 'b'], addServiceVolumes: ['b', 'a'] });
  });

  it('a refused name that a request repeats is logged once, without a count line', async () => {
    const { records, warnings } = setup([entryOf(ID)]);
    const workspace = resourceName(REPOSITORY, ID);
    await records.configuration(ID, checkedConfigurationChange({ addVolumes: Array.from({ length: 20 }, () => workspace) }));
    expect(warnings).toEqual([`The worker recorded the volume ${workspace} for ${REPOSITORY}, which is left out: it is the workspace volume of the devspace.`]);
  });

  it('the cap counts a name that the request repeats once', async () => {
    const recorded = Array.from({ length: 999 }, (_, i) => `v${i}`);
    const { records, warnings } = setup([entryOf(ID, { additionalVolumes: recorded })]);
    const updated = await records.configuration(ID, { addVolumes: ['n', 'n'] });
    expect(updated?.additionalVolumes).toEqual([...recorded, 'n']);
    expect(warnings).toEqual([]);
  });

  it('exactly MAX_LEFT_OUT_LINES left-out volumes: ten lines, no count line', async () => {
    const { records, warnings } = setup([entryOf(ID)]);
    await records.configuration(ID, { addServiceVolumes: Array.from({ length: 10 }, (_, i) => `s${i}`) });
    expect(warnings).toHaveLength(10);
    expect(warnings.some((text) => text.includes('more volumes'))).toBe(false);
  });

  it('a volume that a Delete of another account kept is a clash in any case', async () => {
    const name = resourceName(REPOSITORY, NEW, 'config');
    const { records, file } = setup([], [{ name: name.toUpperCase(), owner: THEIRS, keptAt: '2026-10-01T00:00:00.000Z' }]);
    await expect(records.createDevspace({ id: NEW, repository: REPOSITORY, configPath: DEFAULT })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('another account') });
    expect(file().devspaces).toEqual([]);
  });
});
