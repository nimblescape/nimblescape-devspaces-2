// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { spawn } from 'child_process';
import { buildSync } from 'esbuild';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clock, Logger } from '../ports';
import type { Devspace, DevspaceSource, GitHubAccount, RegistryFile } from '../types';
import { StoragePaths } from './paths';
import { DevspaceRegistry, REGISTRY_NEWER_VERSION_MESSAGE, RegistryVersionError, isDevspaceOf } from './registry';

const ID_A = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const ID_B = '7c1d2e3f-0000-4000-8000-000000000002';
const ID_C = 'c0ffee00-0000-4000-8000-000000000003';
const ID_D = 'd00dfeed-0000-4000-8000-000000000004';
const T0 = Date.parse('2026-09-24T15:40:00.000Z');
const OCTO: GitHubAccount = { id: '1001', login: 'octo' };
const STAUSSH: GitHubAccount = { id: '2002', login: 'staussh' };
const CONFIG = '.devcontainer/devcontainer.json';

function devspace(id: string, repository: string, extra: Partial<Devspace> = {}): Devspace {
  const name = `devspaces-${repository.replace('/', '-').toLowerCase()}-${id.slice(0, 8)}`;
  return {
    id,
    repository,
    configPath: '.devcontainer/devcontainer.json',
    volumeName: name,
    containerName: name,
    createdAt: '2026-09-24T15:40:00.000Z',
    lastUsedAt: '2026-09-24T17:10:00.000Z',
    owner: OCTO,
    ...extra,
  };
}

function fixedClock(ms = T0): Clock {
  return { now: () => ms };
}

function recordingLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return { warnings, info() {}, warn: (message) => warnings.push(message), error() {}, output() {} };
}

let root: string;
let paths: StoragePaths;

function writeRaw(value: unknown): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(paths.registry, typeof value === 'string' ? value : JSON.stringify(value));
}

function readRaw(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(paths.registry, 'utf8')) as Record<string, unknown>;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-test-'));
  paths = new StoragePaths(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('isDevspaceOf: one devspace per repository, GitHub account and source', () => {
  it.each<[string, Pick<Devspace, 'repository' | 'owner' | 'configPath' | 'defaultImage'>, string, string, boolean]>([
    ['the repository of the account', { repository: 'acme/api', owner: OCTO, configPath: CONFIG }, 'acme/api', OCTO.id, true],
    ['the repository in another case', { repository: 'Acme/API', owner: OCTO, configPath: CONFIG }, 'acme/api', OCTO.id, true],
    ['the owner with another login (renamed on GitHub)', { repository: 'acme/api', owner: { id: OCTO.id, login: 'old' }, configPath: CONFIG }, 'acme/api', OCTO.id, true],
    ['the repository of another account', { repository: 'acme/api', owner: STAUSSH, configPath: CONFIG }, 'acme/api', OCTO.id, false],
    ['another repository of the account', { repository: 'acme/web', owner: OCTO, configPath: CONFIG }, 'acme/api', OCTO.id, false],
    ['a repository whose name starts the same', { repository: 'acme/api-2', owner: OCTO, configPath: CONFIG }, 'acme/api', OCTO.id, false],
  ])('%s', (_name, entry, repository, accountId, expected) => {
    expect(isDevspaceOf(entry, repository, accountId)).toBe(expected);
  });

  it('with a source: the default-image devspace, or the devspace of the configuration with the same name', () => {
    const configuration = { repository: 'acme/api', owner: OCTO, configPath: CONFIG };
    const alternative = { repository: 'acme/api', owner: OCTO, configPath: '.devcontainer/py/devcontainer.json' };
    const image = { repository: 'acme/api', owner: OCTO, configPath: CONFIG, defaultImage: 'ghcr.io/acme/base:1' };
    const ofConfiguration: DevspaceSource = { kind: 'configuration', configPath: CONFIG };
    const ofAlternative: DevspaceSource = { kind: 'configuration', configPath: '.devcontainer/py/devcontainer.json' };
    const ofImage: DevspaceSource = { kind: 'defaultImage', image: 'ghcr.io/acme/base:2' };
    // Without a source: any devspace of the repository and account.
    expect([configuration, alternative, image].map((entry) => isDevspaceOf(entry, 'acme/api', OCTO.id))).toEqual([true, true, true]);
    expect([configuration, alternative, image].map((entry) => isDevspaceOf(entry, 'acme/api', OCTO.id, '', ofConfiguration))).toEqual([true, false, false]);
    expect([configuration, alternative, image].map((entry) => isDevspaceOf(entry, 'acme/api', OCTO.id, '', ofAlternative))).toEqual([false, true, false]);
    // The image of the source does not count: a repository has one default-image devspace.
    expect([configuration, alternative, image].map((entry) => isDevspaceOf(entry, 'acme/api', OCTO.id, '', ofImage))).toEqual([false, false, true]);
    // `.devcontainer.json` and `.devcontainer/devcontainer.json` are the same configuration, the one at the root.
    expect(isDevspaceOf({ ...configuration, configPath: '.devcontainer.json' }, 'acme/api', OCTO.id, '', ofConfiguration)).toBe(true);
  });
});

describe('the Docker host in the key of a devspace: repository, account, Docker host', () => {
  it('matches the host exactly; a missing field is the local Docker', () => {
    expect(isDevspaceOf({ repository: 'acme/api', owner: OCTO, configPath: CONFIG }, 'acme/api', OCTO.id, '')).toBe(true);
    expect(isDevspaceOf({ repository: 'acme/api', owner: OCTO, configPath: CONFIG }, 'acme/api', OCTO.id, 'box')).toBe(false);
    expect(isDevspaceOf({ repository: 'acme/api', owner: OCTO, configPath: CONFIG, dockerHost: 'box' }, 'acme/api', OCTO.id, 'box')).toBe(true);
    expect(isDevspaceOf({ repository: 'acme/api', owner: OCTO, configPath: CONFIG, dockerHost: 'box' }, 'acme/api', OCTO.id)).toBe(false);
  });

  it('finds the devspace of the current host, and allows one per host', async () => {
    const registry = new DevspaceRegistry(paths);
    await registry.add(devspace(ID_A, 'acme/api', { owner: OCTO }));
    await registry.add(devspace(ID_B, 'acme/api', { owner: OCTO, dockerHost: 'box' }));
    await expect(registry.add(devspace(ID_C, 'acme/api', { owner: OCTO, dockerHost: 'box' }))).rejects.toThrow(
      'A devspace of acme/api of the GitHub account 1001 exists already.',
    );
    expect((await registry.findForAccount('acme/api', OCTO.id))?.id).toBe(ID_A);
    expect((await registry.findForAccount('acme/api', OCTO.id, 'box'))?.id).toBe(ID_B);
    expect(await registry.findForAccount('acme/api', OCTO.id, 'other')).toBeUndefined();
  });

  it('keeps the host through a read, and drops an invalid one (which then counts as local)', async () => {
    writeRaw({ version: 1, devspaces: [devspace(ID_A, 'o/r', { dockerHost: 'me@box:2222' }), { ...devspace(ID_B, 'o/s'), dockerHost: 7 }] });
    const registry = new DevspaceRegistry(paths);
    const [a, b] = await registry.list();
    expect(a.dockerHost).toBe('me@box:2222');
    expect(b).not.toHaveProperty('dockerHost');
  });
});

describe('DevspaceRegistry reading', () => {
  it('gives an empty registry for a missing file', async () => {
    const registry = new DevspaceRegistry(paths);
    await expect(registry.exists()).resolves.toBe(false);
    await expect(registry.read()).resolves.toEqual({ version: 1, devspaces: [] });
    await expect(registry.list()).resolves.toEqual([]);
    await expect(registry.get(ID_A)).resolves.toBeUndefined();
  });

  it.each([
    ['invalid JSON', '{"version": 1, "devspaces": ['],
    ['an empty file', ''],
    ['a list', '[]'],
    ['null', 'null'],
    ['version 0', { version: 0, devspaces: [devspace(ID_A, 'o/r')] }],
    // A file without a version is invalid.
    ['no version', { devspaces: [devspace(ID_A, 'o/r')] }],
    ['an object without a version', {}],
    ['a text version', { version: '1', devspaces: [devspace(ID_A, 'o/r')] }],
    ['devspaces that are not a list', { version: 1, devspaces: { a: 1 } }],
  ])('tolerates %s', async (_name, content) => {
    writeRaw(content);
    const registry = new DevspaceRegistry(paths);
    await expect(registry.exists()).resolves.toBe(true);
    await expect(registry.read()).resolves.toEqual({ version: 1, devspaces: [] });
  });

  // With a version, as every file of this extension has one (`{}` and `{ devspaces: [...] }` are invalid, see
  // "tolerates" above).
  it('normalizes missing parts', async () => {
    writeRaw({ version: 1 });
    const registry = new DevspaceRegistry(paths);
    await expect(registry.read()).resolves.toEqual({ version: 1, devspaces: [] });
    writeRaw({ version: 1, devspaces: [devspace(ID_A, 'o/r')] });
    await expect(registry.list()).resolves.toEqual([devspace(ID_A, 'o/r')]);
  });

  it('ignores a byte order mark', async () => {
    writeRaw(`﻿${JSON.stringify({ version: 1, devspaces: [devspace(ID_A, 'o/r')] })}`);
    await expect(new DevspaceRegistry(paths).list()).resolves.toHaveLength(1);
  });

  it('leaves out unusable entries, fills defaults, and removes invalid optional fields', async () => {
    const valid = devspace(ID_A, 'o/r', {
      gitSummary: { branch: null, uncommittedFiles: 1, unpushedCommits: 2, stashes: 0, recordedAt: 'x' },
      busy: { operation: 'rebuild', since: 'x', pid: 12, windowId: 'w' },
      owner: { id: '1001', login: 'octo' },
      refusedUpdate: { configPath: '.devcontainer/devcontainer.json', configHash: 'sha256:1', images: { 'node:20': 'sha256:a' }, features: {}, items: 'privileged mode' },
      serviceVolumes: ['myapp-db'],
      serviceFolders: ['/workspaces/r/data'],
    });
    writeRaw({
      version: 1,
      devspaces: [
        valid,
        { ...devspace(ID_A, 'o/r'), repository: 'other/one' }, // repeated ID
        { id: ID_B, repository: 'o/b', volumeName: 'v', containerName: 'c', owner: OCTO }, // defaults
        {
          ...devspace('e3', 'o/c'),
          gitSummary: { branch: 'main', uncommittedFiles: -1, unpushedCommits: 0, stashes: 0, recordedAt: 'x' },
          buildRecord: { devspaceImage: 'devspaces-e3:1' },
          busy: { operation: 'rebuild', since: 'x', pid: 0, windowId: 'w' },
          remoteUser: 5,
          shutdownActionNone: 'yes',
          additionalVolumes: ['a', 3],
          serviceVolumes: ['', 'b'],
          serviceFolders: ['/workspaces/c/data', 7],
          lastBuildNumber: 1.5,
          refusedUpdate: { configPath: '.devcontainer/devcontainer.json', configHash: 'sha256:1', images: { 'node:20': 1 }, features: {}, items: 'x' },
        },
        // An owner restored from a volume label has no login yet; it stays.
        { ...devspace('e7', 'o/d'), owner: { id: '1002', login: '' } },
        // An entry without a valid owner is left out.
        { ...devspace('e8', 'o/e'), owner: { login: 'octo' } },
        { ...devspace('e9', 'o/f'), owner: { id: '../1001', login: 'octo' } },
        { ...devspace('e10', 'o/g'), owner: undefined },
        { ...devspace('e4', 'no-slash') },
        { ...devspace('e5', 'o/r'), volumeName: '' },
        // An entry of version 0.2.1 or older, whose objects have the old names and labels.
        { ...devspace('e11', 'o/h'), volumeName: 'devspace-o-h-brave-noether', containerName: 'devspace-o-h-brave-noether' },
        { ...devspace('e12', 'o/i'), volumeName: 'DevSpace-o-i-brave-noether' },
        { ...devspace('e6', 'o/r'), containerName: 7 },
        { ...devspace('', 'o/r') },
        'text',
        null,
      ],
    });
    const list = await new DevspaceRegistry(paths).list();
    expect(list.map((entry) => entry.id)).toEqual([ID_A, ID_B, 'e3', 'e7']);
    expect(list[0]).toEqual(valid);
    expect(list[1]).toEqual({
      id: ID_B,
      repository: 'o/b',
      volumeName: 'v',
      containerName: 'c',
      configPath: '.devcontainer/devcontainer.json',
      createdAt: '1970-01-01T00:00:00.000Z',
      lastUsedAt: '1970-01-01T00:00:00.000Z',
      owner: OCTO,
    });
    expect(list[2]).toEqual(devspace('e3', 'o/c'));
    expect(list[3].owner).toEqual({ id: '1002', login: '' });
  });

  it('accepts busy marks with an operation of a newer version', async () => {
    const busy = { operation: 'migrate', since: 'x', pid: 12, windowId: 'w' };
    writeRaw({ version: 1, devspaces: [{ ...devspace(ID_A, 'o/r'), busy }] });
    await expect(new DevspaceRegistry(paths).get(ID_A)).resolves.toMatchObject({ busy });
  });

  // The switch Keep Running When Closed is stored with the devspace. An entry without the field means false. Close
  // and Keep Running is stored like keepRunning.
  it('reads keepRunningOnce with and without the field, and drops an invalid value', async () => {
    writeRaw({
      version: 1,
      devspaces: [
        devspace(ID_A, 'o/a', { keepRunningOnce: true }),
        devspace(ID_B, 'o/b'),
        { ...devspace(ID_C, 'o/c'), keepRunningOnce: 1 },
      ],
    });
    const registry = new DevspaceRegistry(paths);
    const list = await registry.list();
    expect(list.map((entry) => entry.keepRunningOnce)).toEqual([true, undefined, undefined]);
    expect('keepRunningOnce' in list[2]).toBe(false);
    await registry.updateDevspace(ID_B, (entry) => {
      entry.keepRunningOnce = true;
    });
    expect((await registry.get(ID_B))?.keepRunningOnce).toBe(true);
  });

  it('reads lifecycleIncomplete with and without the field, and drops an invalid value', async () => {
    writeRaw({
      version: 1,
      devspaces: [
        devspace(ID_A, 'o/a', { lifecycleIncomplete: 'abc123' }),
        devspace(ID_B, 'o/b'),
        { ...devspace(ID_C, 'o/c'), lifecycleIncomplete: '' },
      ],
    });
    const registry = new DevspaceRegistry(paths);
    const list = await registry.list();
    expect(list.map((entry) => entry.lifecycleIncomplete)).toEqual(['abc123', undefined, undefined]);
    expect('lifecycleIncomplete' in list[2]).toBe(false);
  });


  it('reads keepRunning with and without the field, drops an invalid value, and writes it under the lock', async () => {
    writeRaw({
      version: 1,
      devspaces: [
        devspace(ID_A, 'o/a', { keepRunning: true }),
        devspace(ID_B, 'o/b', { keepRunning: false }),
        devspace(ID_C, 'o/c'),
        { ...devspace(ID_D, 'o/d'), keepRunning: 'yes' },
      ],
    });
    const registry = new DevspaceRegistry(paths);
    const list = await registry.list();
    expect(list.map((entry) => entry.keepRunning)).toEqual([true, false, undefined, undefined]);
    expect(list[2]).toEqual(devspace(ID_C, 'o/c'));
    expect('keepRunning' in list[3]).toBe(false);

    await registry.updateDevspace(ID_C, (entry) => {
      entry.keepRunning = true;
    });
    await registry.updateDevspace(ID_A, (entry) => {
      delete entry.keepRunning;
    });
    const written = readRaw().devspaces as Array<Record<string, unknown>>;
    expect(written.find((entry) => entry.id === ID_C)?.keepRunning).toBe(true);
    expect(written.find((entry) => entry.id === ID_A)).not.toHaveProperty('keepRunning');
    // The lock folder is gone after the write.
    expect(fs.existsSync(paths.registryLock)).toBe(false);
  });

  it('finds the devspace of a repository and account, ignoring the case of the repository', async () => {
    writeRaw({
      version: 1,
      devspaces: [
        devspace(ID_A, 'Acme-University/API', { owner: OCTO }),
        devspace(ID_B, 'acme-university/api', { owner: STAUSSH }),
        devspace(ID_C, 'ACME-university/Api', { owner: { id: '4004', login: 'other' } }),
        devspace(ID_D, 'o/b', { owner: OCTO }),
      ],
    });
    const registry = new DevspaceRegistry(paths);
    await expect(registry.findForAccount('acme-university/api', OCTO.id)).resolves.toMatchObject({ id: ID_A });
    await expect(registry.findForAccount('ACME-UNIVERSITY/API', OCTO.id)).resolves.toMatchObject({ id: ID_A });
    await expect(registry.findForAccount('acme-university/api', STAUSSH.id)).resolves.toMatchObject({ id: ID_B });
    await expect(registry.findForAccount('acme-university/api', '3003')).resolves.toBeUndefined();
    await expect(registry.findForAccount('acme-university/web', OCTO.id)).resolves.toBeUndefined();
    await expect(registry.findForAccount('o/b', STAUSSH.id)).resolves.toBeUndefined();
    await expect(registry.get(ID_D)).resolves.toMatchObject({ repository: 'o/b' });
  });

  it('finds devspaces by container name, with or without the leading slash', async () => {
    const env = devspace(ID_A, 'o/r');
    writeRaw({ version: 1, devspaces: [env, { ...devspace(ID_B, 'o/b'), containerName: '/devspaces-b' }] });
    const registry = new DevspaceRegistry(paths);
    await expect(registry.findByContainerName(env.containerName)).resolves.toMatchObject({ id: ID_A });
    await expect(registry.findByContainerName(`/${env.containerName}`)).resolves.toMatchObject({ id: ID_A });
    await expect(registry.findByContainerName('devspaces-b')).resolves.toMatchObject({ id: ID_B });
    await expect(registry.findByContainerName('/devspaces-x')).resolves.toBeUndefined();
  });

  it('throws when the file exists but cannot be read', async () => {
    fs.mkdirSync(paths.registry, { recursive: true });
    await expect(new DevspaceRegistry(paths).read()).rejects.toMatchObject({ code: 'EISDIR' });
  });
});

describe('DevspaceRegistry.needsRestore: the registry lost content', () => {
  const ENTRY = devspace(ID_A, 'acme/api');
  const needsRestore = () => new DevspaceRegistry(paths, fixedClock()).needsRestore();

  it('is true when registry.json is missing', async () => {
    expect(await needsRestore()).toBe(true);
  });

  it('is true when registry.json is not valid JSON, empty, or not an object', async () => {
    for (const content of ['{ "version": 1, "devspaces": [ {', '', '[]', 'null', '42']) {
      writeRaw(content);
      expect(await needsRestore(), JSON.stringify(content)).toBe(true);
    }
  });

  it('is true for no version, an unknown version below 1, and for devspaces that are not a list', async () => {
    // A file without a version is invalid.
    writeRaw({ devspaces: [ENTRY] });
    expect(await needsRestore()).toBe(true);
    writeRaw({ version: 0, devspaces: [ENTRY] });
    expect(await needsRestore()).toBe(true);
    writeRaw({ version: 'one', devspaces: [ENTRY] });
    expect(await needsRestore()).toBe(true);
    writeRaw({ version: 1, devspaces: { [ENTRY.id]: ENTRY } });
    expect(await needsRestore()).toBe(true);
  });

  it('is true when the registry leaves out invalid entries', async () => {
    writeRaw({ version: 1, devspaces: [ENTRY, { id: 'broken' }] });
    expect(await needsRestore()).toBe(true);
    writeRaw({ version: 1, devspaces: [ENTRY, ENTRY] });
    expect(await needsRestore()).toBe(true);
  });

  it('is false when the registry leaves out only entries of version 0.2.1 or older, which no restore brings back', async () => {
    writeRaw({ version: 1, devspaces: [ENTRY, { ...ENTRY, id: ID_B, volumeName: 'devspace-o-r-brave-noether' }] });
    expect(await needsRestore()).toBe(false);
    writeRaw({ version: 1, devspaces: [{ ...ENTRY, volumeName: 'devspace-o-r-brave-noether' }, { id: 'broken' }] });
    expect(await needsRestore()).toBe(true);
  });

  it('is false for a valid registry, also an empty one', async () => {
    writeRaw({ version: 1, devspaces: [ENTRY] });
    expect(await needsRestore()).toBe(false);
    writeRaw({ version: 1, devspaces: [] });
    expect(await needsRestore()).toBe(false);
    writeRaw({ version: 1 });
    expect(await needsRestore()).toBe(false);
  });

  it('is false for a registry of a newer version, which this version must not change', async () => {
    writeRaw({ version: 2, devspaces: [] });
    expect(await needsRestore()).toBe(false);
  });

  it('is false again after the registry was written (the invalid file is replaced)', async () => {
    writeRaw('not json');
    expect(await needsRestore()).toBe(true);
    await new DevspaceRegistry(paths, fixedClock()).add({ ...ENTRY });
    expect(await needsRestore()).toBe(false);
  });
});

describe('DevspaceRegistry changes', () => {
  it('adds, changes, and removes devspaces', async () => {
    const registry = new DevspaceRegistry(paths);
    await registry.add(devspace(ID_A, 'o/a'));
    await registry.add(devspace(ID_B, 'o/b'));
    await expect(registry.exists()).resolves.toBe(true);
    expect(readRaw()).toEqual({ version: 1, devspaces: [devspace(ID_A, 'o/a'), devspace(ID_B, 'o/b')] });

    const changed = await registry.updateDevspace(ID_A, (entry) => {
      entry.lastUsedAt = '2026-09-25T08:00:00.000Z';
      entry.lastBuildNumber = 3;
    });
    expect(changed).toMatchObject({ id: ID_A, lastUsedAt: '2026-09-25T08:00:00.000Z', lastBuildNumber: 3 });
    await expect(registry.get(ID_A)).resolves.toEqual(changed);
    await expect(registry.updateDevspace('missing', () => {})).resolves.toBeUndefined();

    await registry.remove(ID_A);
    await registry.remove('missing');
    await expect(registry.list()).resolves.toEqual([devspace(ID_B, 'o/b')]);
    expect(fs.existsSync(paths.registryLock)).toBe(false);
  });

  it('refuses a second devspace with the same ID and leaves the file unchanged', async () => {
    const registry = new DevspaceRegistry(paths);
    await registry.add(devspace(ID_A, 'o/a'));
    const before = fs.readFileSync(paths.registry, 'utf8');
    await expect(registry.add(devspace(ID_A, 'o/other'))).rejects.toThrow(/exists already/);
    expect(fs.readFileSync(paths.registry, 'utf8')).toBe(before);
    expect(fs.existsSync(paths.registryLock)).toBe(false);
  });

  it('refuses a second devspace of the same repository and account, ignoring case (one per repository and account)', async () => {
    const registry = new DevspaceRegistry(paths);
    await registry.add(devspace(ID_A, 'Acme/API', { owner: OCTO }));
    await expect(registry.add(devspace(ID_B, 'acme/api', { owner: OCTO }))).rejects.toThrow(
      'A devspace of acme/api of the GitHub account 1001 exists already.',
    );
    // Another account gets a devspace of its own.
    await registry.add(devspace(ID_B, 'acme/api', { owner: STAUSSH }));
    await expect(registry.list()).resolves.toEqual([
      devspace(ID_A, 'Acme/API', { owner: OCTO }),
      devspace(ID_B, 'acme/api', { owner: STAUSSH }),
    ]);
  });

  it.each<[string, GitHubAccount, GitHubAccount, number]>([
    ['one account: one of them is added', OCTO, OCTO, 1],
    ['two accounts: both are added', OCTO, STAUSSH, 2],
  ])('adds devspaces of one repository from several windows at the same time: %s', async (_name, first, second, added) => {
    // Each window has its own registry instance; the lock decides.
    const add = (id: string, owner: GitHubAccount): Promise<void> => new DevspaceRegistry(paths).add(devspace(id, 'o/same', { owner }));
    const results = await Promise.allSettled([add(ID_B, first), add(ID_C, second)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(added);
    await expect(new DevspaceRegistry(paths).list()).resolves.toHaveLength(added);
  });

  it('awaits an async mutator of updateDevspace before it writes', async () => {
    const registry = new DevspaceRegistry(paths);
    await registry.add(devspace(ID_A, 'o/a'));
    await registry.updateDevspace(ID_A, async (entry) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      entry.lastBuildNumber = 7;
    });
    await expect(registry.get(ID_A)).resolves.toMatchObject({ lastBuildNumber: 7 });
  });

  it('writes nothing when a mutator throws', async () => {
    const registry = new DevspaceRegistry(paths);
    await registry.add(devspace(ID_A, 'o/a'));
    const before = fs.readFileSync(paths.registry, 'utf8');
    await expect(
      registry.update((file) => {
        file.devspaces = [];
        throw new Error('stop');
      }),
    ).rejects.toThrow('stop');
    expect(fs.readFileSync(paths.registry, 'utf8')).toBe(before);
  });

  it('does not write, or create, the file when nothing changed', async () => {
    const registry = new DevspaceRegistry(paths);
    await expect(registry.update(() => 42)).resolves.toBe(42);
    await registry.remove(ID_A);
    await registry.clearBusy(ID_A);
    await expect(registry.exists()).resolves.toBe(false);

    await registry.add(devspace(ID_A, 'o/a'));
    const mtime = fs.statSync(paths.registry).mtimeMs;
    const inode = fs.statSync(paths.registry).ino;
    await registry.updateDevspace(ID_A, (entry) => {
      entry.lastUsedAt = `${entry.lastUsedAt}`; // same value
    });
    expect(fs.statSync(paths.registry).mtimeMs).toBe(mtime);
    expect(fs.statSync(paths.registry).ino).toBe(inode);
  });

  it('keeps unknown fields at every level', async () => {
    writeRaw({
      version: 1,
      futureTopLevel: { a: 1 },
      devspaces: [
        {
          ...devspace(ID_A, 'o/a'),
          futureField: 'keep me',
          gitSummary: {
            branch: 'main',
            uncommittedFiles: 0,
            unpushedCommits: 0,
            stashes: 0,
            recordedAt: 'x',
            futureNested: true,
          },
        },
      ],
    });
    const registry = new DevspaceRegistry(paths);
    await registry.updateDevspace(ID_A, (entry) => {
      entry.lastBuildNumber = 1;
    });
    const raw = readRaw();
    expect(raw.futureTopLevel).toEqual({ a: 1 });
    const [entry] = raw.devspaces as Array<Record<string, unknown>>;
    expect(entry.futureField).toBe('keep me');
    expect(entry.lastBuildNumber).toBe(1);
    expect((entry.gitSummary as Record<string, unknown>).futureNested).toBe(true);
  });

  it('never overwrites a file of a newer version', async () => {
    const newer = { version: 2, devspaces: [{ id: ID_A, somethingNew: true }] };
    writeRaw(newer);
    const registry = new DevspaceRegistry(paths);
    await expect(registry.read()).resolves.toEqual({ version: 1, devspaces: [] });
    const error = await registry.add(devspace(ID_B, 'o/b')).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RegistryVersionError);
    expect((error as RegistryVersionError).version).toBe(2);
    expect((error as Error).message).toBe(REGISTRY_NEWER_VERSION_MESSAGE);
    await expect(registry.remove(ID_A)).rejects.toBeInstanceOf(RegistryVersionError);
    expect(readRaw()).toEqual(newer);
    expect(fs.existsSync(paths.registryLock)).toBe(false);
  });

  it('keeps a copy of an invalid file before it replaces it', async () => {
    writeRaw('{ broken');
    const logger = recordingLogger();
    const registry = new DevspaceRegistry(paths, fixedClock(1234), { logger });
    await registry.add(devspace(ID_A, 'o/a'));
    expect(readRaw()).toEqual({ version: 1, devspaces: [devspace(ID_A, 'o/a')] });
    expect(fs.readFileSync(`${paths.registry}.backup-1234`, 'utf8')).toBe('{ broken');
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]).toContain('was not valid');
  });

  it('keeps a copy when invalid entries would be lost', async () => {
    const content = { version: 1, devspaces: [devspace(ID_A, 'o/a'), { id: 'x' }] };
    writeRaw(content);
    const logger = recordingLogger();
    const registry = new DevspaceRegistry(paths, fixedClock(99), { logger });
    await registry.add(devspace(ID_B, 'o/b'));
    expect(JSON.parse(fs.readFileSync(`${paths.registry}.backup-99`, 'utf8'))).toEqual(content);
    expect(readRaw()).toEqual({ version: 1, devspaces: [devspace(ID_A, 'o/a'), devspace(ID_B, 'o/b')] });
    expect(logger.warnings[0]).toContain('1 invalid devspace entries');
  });

  it('keeps a copy when entries of version 0.2.1 or older would be lost', async () => {
    const old = { ...devspace(ID_C, 'o/c'), volumeName: 'devspace-o-c-brave-noether', containerName: 'devspace-o-c-brave-noether' };
    const content = { version: 1, devspaces: [devspace(ID_A, 'o/a'), old] };
    writeRaw(content);
    const logger = recordingLogger();
    const registry = new DevspaceRegistry(paths, fixedClock(99), { logger });
    await registry.add(devspace(ID_B, 'o/b'));
    expect(JSON.parse(fs.readFileSync(`${paths.registry}.backup-99`, 'utf8'))).toEqual(content);
    expect(readRaw()).toEqual({ version: 1, devspaces: [devspace(ID_A, 'o/a'), devspace(ID_B, 'o/b')] });
    expect(logger.warnings[0]).toContain('1 entries of version 0.2.1 or older');
  });

  it('does not change an invalid file when nothing is written', async () => {
    writeRaw('{ broken');
    await new DevspaceRegistry(paths).remove(ID_A);
    expect(fs.readFileSync(paths.registry, 'utf8')).toBe('{ broken');
    expect(fs.readdirSync(root).filter((name) => name.includes('backup'))).toEqual([]);
  });

  it('sets and clears the busy mark', async () => {
    const registry = new DevspaceRegistry(paths, fixedClock());
    await registry.add(devspace(ID_A, 'o/a'));
    await registry.setBusy(ID_A, 'rebuild', { windowId: 'window-1', pid: 4321 });
    await expect(registry.get(ID_A)).resolves.toMatchObject({
      busy: { operation: 'rebuild', since: '2026-09-24T15:40:00.000Z', pid: 4321, windowId: 'window-1' },
    });
    await registry.setBusy(ID_A, 'delete', { windowId: 'window-2', pid: 99 });
    await expect(registry.get(ID_A)).resolves.toMatchObject({ busy: { operation: 'delete', windowId: 'window-2' } });
    await registry.clearBusy(ID_A);
    const cleared = await registry.get(ID_A);
    expect(cleared).toBeDefined();
    expect(cleared && 'busy' in cleared).toBe(false);
    await registry.clearBusy('missing');
    await expect(registry.setBusy('missing', 'update', { windowId: 'w', pid: 1 })).rejects.toThrow(/does not exist/);
  });

  it('applies all of 20 parallel changes', async () => {
    const registry = new DevspaceRegistry(paths);
    await registry.add(devspace(ID_A, 'o/a', { lastBuildNumber: 0 }));
    await Promise.all(
      Array.from({ length: 20 }, () =>
        registry.updateDevspace(ID_A, (entry) => {
          entry.lastBuildNumber = (entry.lastBuildNumber ?? 0) + 1;
        }),
      ),
    );
    await expect(registry.get(ID_A)).resolves.toMatchObject({ lastBuildNumber: 20 });
  });

  it('applies parallel changes of several registry instances (several windows), also with async mutators', async () => {
    await new DevspaceRegistry(paths).add(devspace(ID_A, 'o/a', { additionalVolumes: [] }));
    const registries = Array.from({ length: 5 }, () => new DevspaceRegistry(paths));
    await Promise.all(
      registries.flatMap((registry, r) =>
        Array.from({ length: 4 }, (_, i) =>
          registry.update(async (file) => {
            const entry = file.devspaces[0];
            const volumes = [...(entry.additionalVolumes ?? [])];
            await new Promise((resolve) => setTimeout(resolve, 1));
            volumes.push(`v${r}-${i}`);
            entry.additionalVolumes = volumes;
          }),
        ),
      ),
    );
    const entry = await new DevspaceRegistry(paths).get(ID_A);
    expect(entry?.additionalVolumes).toHaveLength(20);
    expect(new Set(entry?.additionalVolumes).size).toBe(20);
  });

  it('removes a stale lock of a crashed process', async () => {
    fs.mkdirSync(paths.registryLock, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(paths.registryLock, old, old);
    const registry = new DevspaceRegistry(paths);
    const start = Date.now();
    await registry.add(devspace(ID_A, 'o/a'));
    expect(Date.now() - start).toBeLessThan(2_000);
    await expect(registry.list()).resolves.toHaveLength(1);
    expect(fs.existsSync(paths.registryLock)).toBe(false);
  });

  it('gives a stale lock to only one of two waiters, also when one of them is slow to remove it', async () => {
    await new DevspaceRegistry(paths).add(devspace(ID_A, 'o/a', { lastBuildNumber: 0 }));
    fs.mkdirSync(paths.registryLock);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(paths.registryLock, old, old);
    // The first removal of the lock folder is slow: without protection, the slow waiter removes the new lock of the
    // other waiter, and both hold the lock.
    const realRm = fs.promises.rm;
    let delayed = false;
    const rm = vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, options) => {
      if (!delayed && target === paths.registryLock) {
        delayed = true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return realRm(target, options);
    });
    let active = 0;
    let maxActive = 0;
    try {
      await Promise.all(
        Array.from({ length: 2 }, () =>
          new DevspaceRegistry(paths).update(async (file) => {
            active++;
            maxActive = Math.max(maxActive, active);
            const entry = file.devspaces[0];
            const value = entry.lastBuildNumber ?? 0;
            await new Promise((resolve) => setTimeout(resolve, 150));
            entry.lastBuildNumber = value + 1;
            active--;
          }),
        ),
      );
    } finally {
      rm.mockRestore();
    }
    expect(delayed).toBe(true);
    expect(maxActive).toBe(1);
    await expect(new DevspaceRegistry(paths).get(ID_A)).resolves.toMatchObject({ lastBuildNumber: 2 });
    expect(fs.readdirSync(root).filter((name) => name.includes('lock'))).toEqual([]);
  });

  it('removes a stale takeover guard of a process that crashed while it removed a stale lock', async () => {
    const old = new Date(Date.now() - 60_000);
    for (const dir of [paths.registryLock, `${paths.registryLock}.takeover`]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.utimesSync(dir, old, old);
    }
    await new DevspaceRegistry(paths).add(devspace(ID_A, 'o/a'));
    await expect(new DevspaceRegistry(paths).list()).resolves.toHaveLength(1);
    expect(fs.readdirSync(root).filter((name) => name.includes('lock'))).toEqual([]);
  });

  it('does not remove a stale lock while another waiter holds the takeover guard', async () => {
    fs.mkdirSync(paths.registryLock, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(paths.registryLock, old, old);
    fs.mkdirSync(`${paths.registryLock}.takeover`);
    const registry = new DevspaceRegistry(paths, undefined, { lockTimeoutMs: 200 });
    await expect(registry.add(devspace(ID_A, 'o/a'))).rejects.toThrow(/Timeout/);
    expect(fs.existsSync(paths.registryLock)).toBe(true);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'retries a lock folder that cannot be created for a moment, and reports a lasting error as it is',
    async () => {
      const registry = new DevspaceRegistry(paths);
      fs.chmodSync(root, 0o555);
      try {
        const lasting = await registry.add(devspace(ID_A, 'o/a')).catch((error: unknown) => error);
        expect(lasting).toMatchObject({ code: 'EACCES' });
        const added = registry.add(devspace(ID_A, 'o/a'));
        await new Promise((resolve) => setTimeout(resolve, 100));
        fs.chmodSync(root, 0o755);
        await added;
      } finally {
        fs.chmodSync(root, 0o755);
      }
      await expect(registry.list()).resolves.toHaveLength(1);
    },
  );

  it('waits for a fresh lock and times out', async () => {
    fs.mkdirSync(paths.registryLock, { recursive: true });
    const registry = new DevspaceRegistry(paths, undefined, { lockStaleMs: 60_000, lockTimeoutMs: 200 });
    await expect(registry.add(devspace(ID_A, 'o/a'))).rejects.toThrow(/Timeout/);
    await expect(registry.exists()).resolves.toBe(false);
  });

  it('keeps its lock fresh while a slow mutator runs, so no other writer takes it for stale', async () => {
    const options = { lockStaleMs: 150, lockTimeoutMs: 5_000 };
    const first = new DevspaceRegistry(paths, undefined, options);
    const second = new DevspaceRegistry(paths, undefined, options);
    await first.add(devspace(ID_A, 'o/a', { lastBuildNumber: 0 }));
    const order: string[] = [];
    const slow = first.update(async (file) => {
      order.push('slow start');
      const value = file.devspaces[0].lastBuildNumber ?? 0;
      await new Promise((resolve) => setTimeout(resolve, 600));
      file.devspaces[0].lastBuildNumber = value + 1;
      order.push('slow end');
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const fast = second.update((file) => {
      order.push('fast');
      file.devspaces[0].lastBuildNumber = (file.devspaces[0].lastBuildNumber ?? 0) + 10;
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(['slow start', 'slow end', 'fast']);
    await expect(first.get(ID_A)).resolves.toMatchObject({ lastBuildNumber: 11 });
  });

  it('stops a holder that stalled past the stale time from writing and from removing the new lock, and runs its change again', async () => {
    // The heartbeat of the first registry runs every 15 seconds only, so its lock folder gets old as that of a process
    // whose event loop stalls. The second registry takes a lock folder older than 100 ms for stale.
    const logger = recordingLogger();
    const first = new DevspaceRegistry(paths, undefined, { lockStaleMs: 60_000, lockTimeoutMs: 5_000, logger });
    const second = new DevspaceRegistry(paths, undefined, { lockStaleMs: 100, lockTimeoutMs: 5_000 });
    await first.add(devspace(ID_A, 'o/a', { lastBuildNumber: 0 }));
    const until = async (condition: () => boolean) => {
      while (!condition()) await new Promise((resolve) => setTimeout(resolve, 10));
    };
    let firstRuns = 0;
    let firstDone = false;
    let releaseFirst = false;
    const stalled = first.update(async (file) => {
      firstRuns++;
      const value = file.devspaces[0].lastBuildNumber ?? 0;
      if (firstRuns === 1) await until(() => releaseFirst);
      file.devspaces[0].lastBuildNumber = value + 1;
      firstDone = true;
    });
    await until(() => firstRuns === 1);
    let secondHolds = false;
    let releaseSecond = false;
    const takeover = second.update(async (file) => {
      secondHolds = true;
      const value = file.devspaces[0].lastBuildNumber ?? 0;
      await until(() => releaseSecond);
      file.devspaces[0].lastBuildNumber = value + 10;
    });
    await until(() => secondHolds);
    // The first registry ends its change while the second one holds the lock.
    releaseFirst = true;
    await until(() => firstDone);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fs.existsSync(paths.registryLock)).toBe(true);
    await expect(first.get(ID_A)).resolves.toMatchObject({ lastBuildNumber: 0 });
    releaseSecond = true;
    await Promise.all([stalled, takeover]);
    // The change of the first registry ran again after the second one: no change is lost.
    expect(firstRuns).toBe(2);
    await expect(first.get(ID_A)).resolves.toMatchObject({ lastBuildNumber: 11 });
    expect(logger.warnings).toEqual([expect.stringContaining('Another process took over the lock')]);
    expect(fs.readdirSync(root).filter((name) => name.includes('lock'))).toEqual([]);
  });

  it('checks the lock again right before the rename: a takeover while the temporary file is written writes nothing', async () => {
    const logger = recordingLogger();
    const first = new DevspaceRegistry(paths, undefined, { lockStaleMs: 60_000, lockTimeoutMs: 5_000, logger });
    const second = new DevspaceRegistry(paths, undefined, { lockStaleMs: 100, lockTimeoutMs: 5_000 });
    await first.add(devspace(ID_A, 'o/a', { lastBuildNumber: 0 }));
    const until = async (condition: () => boolean) => {
      while (!condition()) await new Promise((resolve) => setTimeout(resolve, 10));
    };
    const temporaryFiles = () => fs.readdirSync(root).filter((name) => name.endsWith('.tmp'));
    // The first registry stalls right after it wrote its temporary file, after its first check of the token.
    const realWriteFile = fs.promises.writeFile;
    let stalled = false;
    let releaseFirst = false;
    const writeFile = vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (file, data, options) => {
      await realWriteFile(file, data, options);
      if (!stalled && typeof file === 'string' && path.basename(file).startsWith('.registry.json.')) {
        stalled = true;
        await until(() => releaseFirst);
      }
    });
    try {
      let firstRuns = 0;
      let firstDone = false;
      const stalledChange = first
        .update((file) => {
          firstRuns++;
          file.devspaces[0].lastBuildNumber = (file.devspaces[0].lastBuildNumber ?? 0) + 1;
        })
        .finally(() => (firstDone = true));
      await until(() => stalled);
      expect(temporaryFiles()).toHaveLength(1);
      // The second registry takes the lock over as stale and holds it.
      let secondHolds = false;
      let releaseSecond = false;
      const takeover = second.update(async (file) => {
        secondHolds = true;
        const value = file.devspaces[0].lastBuildNumber ?? 0;
        await until(() => releaseSecond);
        file.devspaces[0].lastBuildNumber = value + 10;
      });
      await until(() => secondHolds);
      releaseFirst = true;
      // The first registry finds the lock lost before the rename: nothing written, its temporary file removed.
      await until(() => logger.warnings.length > 0 || firstDone);
      expect(logger.warnings).toEqual([expect.stringContaining('Another process took over the lock')]);
      expect(readRaw()).toMatchObject({ devspaces: [expect.objectContaining({ lastBuildNumber: 0 })] });
      expect(temporaryFiles()).toEqual([]);
      releaseSecond = true;
      await Promise.all([stalledChange, takeover]);
      // Its change ran again after the second one: no change is lost.
      expect(firstRuns).toBe(2);
      await expect(first.get(ID_A)).resolves.toMatchObject({ lastBuildNumber: 11 });
    } finally {
      writeFile.mockRestore();
    }
    expect(temporaryFiles()).toEqual([]);
    expect(fs.readdirSync(root).filter((name) => name.includes('lock'))).toEqual([]);
  });

  // The registry that took the lock over kept the copy of the file that was not valid, and wrote a valid one. Mutation:
  // without the check of the token before the copy, the stalled registry keeps a copy of that valid file, and warns
  // that the registry was not valid.
  it('a holder that lost the lock keeps no copy of a file that was not valid: the registry that took the lock over keeps it', async () => {
    writeRaw('{ broken');
    const logger = recordingLogger();
    const first = new DevspaceRegistry(paths, fixedClock(1111), { lockStaleMs: 60_000, lockTimeoutMs: 5_000, logger });
    const second = new DevspaceRegistry(paths, fixedClock(2222), { lockStaleMs: 100, lockTimeoutMs: 5_000 });
    const until = async (condition: () => boolean) => {
      while (!condition()) await new Promise((resolve) => setTimeout(resolve, 10));
    };
    // The first registry read the file under its lock, and stalls before it writes.
    let firstRuns = 0;
    let releaseFirst = false;
    const stalled = first.update(async (file) => {
      firstRuns++;
      if (firstRuns === 1) await until(() => releaseFirst);
      file.devspaces.push(devspace(ID_A, 'o/a'));
    });
    await until(() => firstRuns === 1);
    await second.add(devspace(ID_B, 'o/b'));
    expect(fs.readFileSync(`${paths.registry}.backup-2222`, 'utf8')).toBe('{ broken');
    releaseFirst = true;
    await stalled;
    expect(firstRuns).toBe(2);
    expect(readRaw()).toEqual({ version: 1, devspaces: [devspace(ID_B, 'o/b'), devspace(ID_A, 'o/a')] });
    // Only the copy of the second registry, of the file that was not valid.
    expect(fs.readdirSync(root).filter((name) => name.startsWith('registry.json.backup-'))).toEqual(['registry.json.backup-2222']);
    expect(logger.warnings).toEqual([expect.stringContaining('Another process took over the lock')]);
  });

  // For example EBUSY on Windows while a virus scanner reads the token file.
  it('takes a token file that cannot be read for an error, not for a lost lock', async () => {
    const logger = recordingLogger();
    const registry = new DevspaceRegistry(paths, undefined, { lockStaleMs: 200, lockTimeoutMs: 5_000, logger });
    await registry.add(devspace(ID_A, 'o/a', { lastBuildNumber: 0 }));
    const owner = path.join(paths.registryLock, 'owner');
    const realReadFile = fs.promises.readFile;
    let failures = 0;
    const readFile = vi.spyOn(fs.promises, 'readFile').mockImplementation(async (file, options) => {
      if (file === owner && failures > 0) {
        failures--;
        throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${owner}'`), { code: 'EBUSY' });
      }
      return realReadFile(file, options);
    });
    let runs = 0;
    const change = () =>
      registry.update((file) => {
        runs++;
        file.devspaces[0].lastBuildNumber = (file.devspaces[0].lastBuildNumber ?? 0) + 1;
      });
    try {
      // A short failure is tried again.
      failures = 2;
      await change();
      expect(runs).toBe(1);
      await expect(registry.get(ID_A)).resolves.toMatchObject({ lastBuildNumber: 1 });
      expect(fs.existsSync(paths.registryLock)).toBe(false);
      // A failure that stays fails the change with its error: nothing written, and the change does not run again.
      failures = Infinity;
      await expect(change()).rejects.toMatchObject({ code: 'EBUSY' });
      expect(runs).toBe(2);
      await expect(registry.get(ID_A)).resolves.toMatchObject({ lastBuildNumber: 1 });
      expect(logger.warnings).toEqual([]);
      // The folder whose token could not be read is left until it is stale.
      expect(fs.existsSync(paths.registryLock)).toBe(true);
    } finally {
      readFile.mockRestore();
    }
    await change();
    await expect(registry.get(ID_A)).resolves.toMatchObject({ lastBuildNumber: 2 });
    expect(fs.existsSync(paths.registryLock)).toBe(false);
  });

  it('lets a reader without the lock see complete content during many writes', async () => {
    const registry = new DevspaceRegistry(paths);
    await registry.add(devspace(ID_A, 'o/a', { lastBuildNumber: 0 }));
    let writing = true;
    const writer = (async () => {
      for (let i = 0; i < 30; i++) {
        await registry.updateDevspace(ID_A, (entry) => {
          entry.lastBuildNumber = i + 1;
          entry.additionalVolumes = Array.from({ length: 50 }, (_, n) => `volume-${i}-${n}`);
        });
      }
      writing = false;
    })();
    const reader = new DevspaceRegistry(paths);
    let reads = 0;
    while (writing) {
      const list = await reader.list();
      expect(list).toHaveLength(1);
      reads++;
    }
    await writer;
    expect(reads).toBeGreaterThan(0);
  });
});

// The last time a window was seen using the devspace, for Delete's note.
describe('DevspaceRegistry.markSeenInUse', () => {
  it('sets lastSeenInUseAt, only forward, and leaves a missing entry and an invalid time alone', async () => {
    const registry = new DevspaceRegistry(paths);
    await registry.add(devspace(ID_A, 'o/a'));
    await registry.markSeenInUse(ID_A, '2026-10-02T10:00:00.000Z');
    expect((await registry.get(ID_A))?.lastSeenInUseAt).toBe('2026-10-02T10:00:00.000Z');
    // Never back to an earlier time, nor the same one written again.
    await registry.markSeenInUse(ID_A, '2026-10-02T09:00:00.000Z');
    expect((await registry.get(ID_A))?.lastSeenInUseAt).toBe('2026-10-02T10:00:00.000Z');
    await registry.markSeenInUse(ID_A, '2026-10-02T11:00:00.000Z');
    expect((await registry.get(ID_A))?.lastSeenInUseAt).toBe('2026-10-02T11:00:00.000Z');
    await registry.markSeenInUse(ID_A, 'not a time');
    expect((await registry.get(ID_A))?.lastSeenInUseAt).toBe('2026-10-02T11:00:00.000Z');
    await expect(registry.markSeenInUse('missing', '2026-10-02T12:00:00.000Z')).resolves.toBeUndefined();
    await expect(registry.list()).resolves.toEqual([{ ...devspace(ID_A, 'o/a'), lastSeenInUseAt: '2026-10-02T11:00:00.000Z' }]);
    // The other fields stay.
    expect((await registry.get(ID_A))?.lastUsedAt).toBe(devspace(ID_A, 'o/a').lastUsedAt);
  });

  it('replaces an invalid stored time, and a non-string value is dropped when read', async () => {
    writeRaw({ version: 1, devspaces: [{ ...devspace(ID_A, 'o/a'), lastSeenInUseAt: 'garbage' }, { ...devspace(ID_B, 'o/b'), lastSeenInUseAt: 42 }] });
    const registry = new DevspaceRegistry(paths);
    expect((await registry.get(ID_B))?.lastSeenInUseAt).toBeUndefined();
    await registry.markSeenInUse(ID_A, '2026-10-02T10:00:00.000Z');
    expect((await registry.get(ID_A))?.lastSeenInUseAt).toBe('2026-10-02T10:00:00.000Z');
  });

  // The mark runs at activation, before the restore check; it must not drop the lost entries by normalizing the file.
  it('writes nothing while the file still needs its restore (an invalid entry)', async () => {
    writeRaw({ version: 1, devspaces: [{ id: 'broken' }, devspace(ID_A, 'o/a')] });
    const before = fs.readFileSync(paths.registry);
    const registry = new DevspaceRegistry(paths);
    await expect(registry.needsRestore()).resolves.toBe(true);
    await expect(registry.markSeenInUse(ID_A, '2026-10-02T10:00:00.000Z')).resolves.toBeUndefined();
    expect(fs.readFileSync(paths.registry).equals(before)).toBe(true);
    await expect(registry.needsRestore()).resolves.toBe(true);
    expect((await registry.get(ID_A))?.lastSeenInUseAt).toBeUndefined();
    expect(fs.readdirSync(root).filter((name) => name.includes('.backup-'))).toEqual([]);
  });

  it('writes nothing for an invalid record of a kept volume nor for an invalid file', async () => {
    writeRaw({ version: 1, devspaces: [devspace(ID_A, 'o/a')], keptVolumes: [{ name: 'x' }] });
    let before = fs.readFileSync(paths.registry);
    const registry = new DevspaceRegistry(paths);
    await registry.markSeenInUse(ID_A, '2026-10-02T10:00:00.000Z');
    expect(fs.readFileSync(paths.registry).equals(before)).toBe(true);
    writeRaw('{ not json');
    before = fs.readFileSync(paths.registry);
    await registry.markSeenInUse(ID_A, '2026-10-02T10:00:00.000Z');
    expect(fs.readFileSync(paths.registry).equals(before)).toBe(true);
    await expect(registry.needsRestore()).resolves.toBe(true);
  });

  it('writes for a clean file', async () => {
    writeRaw({ version: 1, devspaces: [devspace(ID_A, 'o/a')] });
    const registry = new DevspaceRegistry(paths);
    await expect(registry.needsRestore()).resolves.toBe(false);
    await registry.markSeenInUse(ID_A, '2026-10-02T10:00:00.000Z');
    expect(readRaw()).toEqual({ version: 1, devspaces: [{ ...devspace(ID_A, 'o/a'), lastSeenInUseAt: '2026-10-02T10:00:00.000Z' }] });
  });
});

describe('DevspaceRegistry: additional volumes that a Delete kept', () => {
  it('records the kept volumes with the owner of the removed entry, in the same change as the removal', async () => {
    const registry = new DevspaceRegistry(paths, fixedClock());
    await registry.add(devspace(ID_A, 'o/a', { owner: OCTO, additionalVolumes: ['a-data', 'a-cache'] }));
    await registry.remove(ID_A, { kept: ['a-data', 'a-data'], removed: ['a-cache'] });
    expect(readRaw()).toEqual({ version: 1, devspaces: [], keptVolumes: [{ name: 'a-data', owner: OCTO, keptAt: new Date(T0).toISOString() }] });
    await expect(registry.keptVolumes()).resolves.toEqual([{ name: 'a-data', owner: OCTO, keptAt: new Date(T0).toISOString() }]);
  });

  it('records nothing for a missing entry', async () => {
    const registry = new DevspaceRegistry(paths, fixedClock());
    await registry.remove('missing', { kept: ['b-data'] });
    await expect(registry.keptVolumes()).resolves.toEqual([]);
  });

  it('keeps one record per volume and owner, and drops all records of a removed volume', async () => {
    const registry = new DevspaceRegistry(paths, fixedClock());
    await registry.add(devspace(ID_A, 'o/a', { owner: OCTO }));
    await registry.add(devspace(ID_B, 'o/a', { owner: STAUSSH }));
    await registry.add(devspace(ID_C, 'o/c', { owner: OCTO }));
    await registry.remove(ID_A, { kept: ['shared'] });
    await registry.remove(ID_B, { kept: ['shared'] });
    await registry.add(devspace(ID_D, 'o/a', { owner: OCTO }));
    await registry.remove(ID_D, { kept: ['shared'] });
    expect((await registry.keptVolumes()).map((record) => [record.name, record.owner.login])).toEqual([
      ['shared', 'octo'],
      ['shared', 'staussh'],
    ]);
    await registry.remove(ID_C, { removed: ['shared'] });
    await expect(registry.keptVolumes()).resolves.toEqual([]);
    expect(readRaw()).toEqual({ version: 1, devspaces: [] });
  });

  it('keeps a copy of the file before a write drops invalid records, because dropping them loosens the policy', async () => {
    const logger = recordingLogger();
    const valid = { name: 'ok', owner: OCTO, keptAt: '2026-09-24T15:40:00.000Z' };
    // A record without owner is invalid too.
    writeRaw({ version: 1, devspaces: [devspace(ID_A, 'o/a')], keptVolumes: [valid, { name: 'bad', keptAt: 5 }, { name: 'no-owner', keptAt: valid.keptAt }] });
    const registry = new DevspaceRegistry(paths, fixedClock(), { logger });
    await expect(registry.needsRestore()).resolves.toBe(false);
    await registry.remove(ID_A);
    const copy = `${paths.registry}.backup-${T0}`;
    expect(JSON.parse(fs.readFileSync(copy, 'utf8')).keptVolumes).toHaveLength(3);
    expect(logger.warnings).toEqual([`The devspace registry contained 2 invalid records of kept volumes. A copy was saved as ${copy}.`]);
    expect(readRaw()).toEqual({ version: 1, devspaces: [], keptVolumes: [valid] });
  });

  it('forgets the records of volumes that no longer exist, of every owner', async () => {
    const registry = new DevspaceRegistry(paths, fixedClock());
    await registry.add(devspace(ID_A, 'o/a', { owner: OCTO }));
    await registry.add(devspace(ID_B, 'o/a', { owner: STAUSSH }));
    await registry.remove(ID_A, { kept: ['shared', 'other'] });
    await registry.remove(ID_B, { kept: ['shared'] });
    await registry.forgetKeptVolumes(['shared']);
    expect((await registry.keptVolumes()).map((record) => record.name)).toEqual(['other']);
    await registry.forgetKeptVolumes(['other']);
    expect(readRaw()).toEqual({ version: 1, devspaces: [] });
  });

  it('reads files without the list, and leaves out invalid records', async () => {
    writeRaw({ version: 1, devspaces: [], keptVolumes: 'no' });
    await expect(new DevspaceRegistry(paths).keptVolumes()).resolves.toEqual([]);
    const valid = { name: 'ok', owner: OCTO, keptAt: '2026-09-24T15:40:00.000Z' };
    writeRaw({ version: 1, devspaces: [], keptVolumes: [valid, { name: '', keptAt: 'x' }, { name: 'x' }, { name: 'y', keptAt: 'x', owner: { id: 1 } }] });
    await expect(new DevspaceRegistry(paths).keptVolumes()).resolves.toEqual([valid]);
  });
});

describe('DevspaceRegistry across processes', () => {
  it('applies every change of several processes', async () => {
    const script = path.join(root, 'worker.js');
    const entry = path.join(root, 'worker-entry.ts');
    fs.writeFileSync(
      entry,
      [
        `import { StoragePaths } from ${JSON.stringify(path.join(__dirname, 'paths'))};`,
        `import { DevspaceRegistry } from ${JSON.stringify(path.join(__dirname, 'registry'))};`,
        'const [storage, id, count] = process.argv.slice(2);',
        'const registry = new DevspaceRegistry(new StoragePaths(storage));',
        'Promise.all(Array.from({ length: Number(count) }, () => registry.updateDevspace(id, (e) => {',
        '  e.lastBuildNumber = (e.lastBuildNumber ?? 0) + 1;',
        '}))).catch((error) => { console.error(error); process.exitCode = 1; });',
      ].join('\n'),
    );
    buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', target: 'node24', outfile: script, logLevel: 'silent' });

    const storage = path.join(root, 'storage');
    const storagePaths = new StoragePaths(storage);
    await new DevspaceRegistry(storagePaths).add(devspace(ID_A, 'o/a', { lastBuildNumber: 0 }));

    const processes = 4;
    const perProcess = 10;
    const exitCodes = await Promise.all(
      Array.from(
        { length: processes },
        () =>
          new Promise<number | null>((resolve, reject) => {
            const child = spawn(process.execPath, [script, storage, ID_A, String(perProcess)], { stdio: 'inherit' });
            child.on('error', reject);
            child.on('exit', resolve);
          }),
      ),
    );
    expect(exitCodes).toEqual(Array.from({ length: processes }, () => 0));
    const result: RegistryFile = await new DevspaceRegistry(storagePaths).read();
    expect(result.devspaces[0].lastBuildNumber).toBe(processes * perProcess);
  }, 60_000);
});
