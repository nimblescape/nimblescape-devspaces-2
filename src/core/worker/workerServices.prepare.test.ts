// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The deps of a headless prepare in the worker (headlessServiceDeps) know no computer: every part of one throws when it
// is used, the devspace lock is never taken, the settings have the host access checks on, and the devspaces come
// from the labels of the volumes (engineDevspaceStore).
import { describe, expect, it } from 'vitest';
import { DevspaceLockError } from '../docker/devspaceLock';
import { LABEL_DEVSPACE_ID, LABEL_OWNER_ID, LABEL_REPOSITORY, LABEL_VOLUME, resourceName } from '../names';
import { silentLogger } from '../ports';
import { unusedEngine } from './dockerEngine.testkit';
import { engineDevspaceStore, headlessServiceDeps } from './workerServices';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const REPO = 'acme/api';
const NAME = resourceName(REPO, ID);

describe('the devspaces of a prepare (engineDevspaceStore)', () => {
  const labels = { [LABEL_DEVSPACE_ID]: ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: '42' };
  const store = engineDevspaceStore(
    {
      listDevspaceVolumes: async () => [
        { name: NAME, labels },
        // An additional volume, a volume with the labels but not the name, and invalid labels are no devspaces.
        { name: `${NAME}-data`, labels: { ...labels, [LABEL_VOLUME]: 'additional' } },
        { name: 'other', labels },
        { name: resourceName('acme/web', ID), labels: { ...labels, [LABEL_REPOSITORY]: 'acme/web', [LABEL_OWNER_ID]: '../x' } },
      ],
    },
    () => '2026-10-11T10:00:00.000Z',
  );

  it('has one entry per workspace volume, with the owner of its label', async () => {
    expect(await store.list()).toEqual([
      {
        id: ID,
        repository: REPO,
        configPath: '.devcontainer/devcontainer.json',
        volumeName: NAME,
        containerName: NAME,
        createdAt: '2026-10-11T10:00:00.000Z',
        lastUsedAt: '2026-10-11T10:00:00.000Z',
        owner: { id: '42', login: '' },
      },
    ]);
    expect((await store.get(ID))?.volumeName).toBe(NAME);
    expect(await store.get('7c1d2e3f-0000-4000-8000-000000000002')).toBeUndefined();
    expect((await store.read()).devspaces).toHaveLength(1);
    expect(await store.findForAccount(REPO, '42', '')).toBeUndefined();
  });

  it('writes nothing', async () => {
    await expect(store.remove(ID)).rejects.toThrow('The operation gives the worker no registry of a computer (a prepare writes no record).');
    await expect(store.forgetKeptVolumes([NAME])).rejects.toThrow();
    await expect(store.restore([])).rejects.toThrow();
  });
});

describe('the deps of a headless prepare (headlessServiceDeps)', () => {
  const deps = headlessServiceDeps({
    engine: unusedEngine(),
    logger: silentLogger,
    ownHelper: { image: { tag: 'devspaces-worker:abc', id: `sha256:${'a'.repeat(64)}` }, socket: '/var/run/docker.sock' },
    analyzer: { analyze: async () => Promise.reject(new Error('no analysis')) },
  });

  it('use no token, account, question, record, busy mark, session file, or window of a computer', async () => {
    await expect(deps.auth.getToken({ interactive: false } as never)).rejects.toThrow('in a prepare');
    await expect(deps.auth.getAccount({ interactive: false })).rejects.toThrow('in a prepare');
    await expect(deps.ui.updateContainer(REPO, true)).rejects.toThrow('in a prepare');
    await expect(deps.ui.configurationChanged(REPO)).rejects.toThrow('in a prepare');
    expect(() => deps.busyMarks.mark(ID, 'update')).toThrow('in a prepare');
    expect(() => deps.openRecords.build(ID, { kind: 'number', buildNumber: 2 })).toThrow('in a prepare');
    expect(() => deps.sessionFiles.writePending(ID, 'w')).toThrow('in a prepare');
    await expect(deps.recordGitSummary(ID, { branch: null, uncommittedFiles: 0, unpushedCommits: 0, stashes: 0, recordedAt: '' })).rejects.toThrow('in a prepare');
    await expect(deps.windowStatuses!()).rejects.toThrow('in a prepare');
    expect(deps.configChecks).toBeUndefined();
    expect(deps.sessionMonitor).toBeUndefined();
    expect(deps.prepareLock).toBeUndefined();
  });

  it('never take the lock of a devspace', async () => {
    await expect(deps.devspaceLock(ID, 10, undefined)).rejects.toBeInstanceOf(DevspaceLockError);
  });

  it('check with the host access checks on, and the images', () => {
    expect(deps.settings().hostAccessChecksOff).toEqual([]);
    expect(deps.settings().updateImagesOnConnect).toBe(true);
  });
});
