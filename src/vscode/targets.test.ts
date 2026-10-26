// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import type { DiscoveryData, Devspace, RepositoryInfo } from '../core/types';
import { ControllerTexts } from './controllerTexts';
import { dockerStoppedRuntime, devspaceIdsOf, liveBusyDevspaceIds } from './sidebarData';
import { findRepositoryInfo, gitHubUrl, listedRepositories, ownerTrust, parseCommandArgument, pickerRepositories, placeholderRepositoryInfo, repositoriesToLookUp, repositoryKey, repositoryTarget, sourceChoices } from './targets';
import { buildTreeModel, type RepositoryRow } from './treeModel';

const NOW = Date.parse('2026-09-25T08:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

function repo(nameWithOwner: string, overrides: Partial<RepositoryInfo> = {}): RepositoryInfo {
  const [owner, name] = nameWithOwner.split('/');
  return {
    nameWithOwner,
    owner,
    name,
    url: `https://github.com/${nameWithOwner}`,
    isArchived: false,
    isFork: false,
    isPrivate: false,
    pushedAt: iso(NOW),
    defaultBranch: 'main',
    configPaths: ['.devcontainer/devcontainer.json'],
    ...overrides,
  };
}

function devspace(id: string, repository: string, overrides: Partial<Devspace> = {}): Devspace {
  return {
    id,
    repository,
    configPath: '.devcontainer/devcontainer.json',
    volumeName: `devspaces-${id}`,
    containerName: `devspaces-${id}`,
    createdAt: iso(NOW),
    lastUsedAt: iso(NOW),
    owner: { id: '1001', login: 'me' },
    ...overrides,
  };
}

function discovery(repositories: RepositoryInfo[], overrides: Partial<DiscoveryData> = {}): DiscoveryData {
  return { version: 1, fetchedAt: iso(NOW), viewerLogin: 'me', organizations: ['acme'], repositories, hints: [], scope: [], withoutConfiguration: [], ...overrides };
}

const settings = { owners: [], includeArchived: false, includeForks: true };

describe('parseCommandArgument', () => {
  it('reads a row of the sidebar', () => {
    const groups = buildTreeModel({
      discovery: discovery([repo('acme/api'), repo('acme/web')]),
      settings,
      devspaces: [devspace('e1', 'acme/api')],
      runtime: undefined,
      currentDevspaceId: null,
      otherWindowDevspaceIds: new Set(),
      busyDevspaceIds: new Set(),
      liveBranches: new Map(),
      signedIn: true,
    });
    const rows = groups[0].children as RepositoryRow[];
    const source = { kind: 'configuration', configPath: '.devcontainer/devcontainer.json' };
    expect(parseCommandArgument(rows[0])).toEqual({ kind: 'row', repository: 'acme/api', info: rows[0].info, devspaceId: 'e1', source });
    expect(parseCommandArgument(rows[1])).toEqual({ kind: 'row', repository: 'acme/web', info: rows[1].info, devspaceId: undefined, source });
  });

  it('reads the argument of the status bar item Reconnect', () => {
    expect(parseCommandArgument({ devspaceId: 'e1' })).toEqual({ kind: 'devspace', devspaceId: 'e1' });
  });

  it.each([undefined, null, 'acme/api', 42, [], {}, { devspaceId: '' }, { kind: 'owner', id: 'owner:acme' }, { kind: 'hint' }, { kind: 'repository', repository: 'noslash' }])(
    'treats %j as no argument',
    (value) => {
      expect(parseCommandArgument(value)).toEqual({ kind: 'none' });
    },
  );
});

describe('repositoryTarget', () => {
  it('takes the default branch and the configurations from the discovery', () => {
    const info = repo('Acme/API', { configPaths: ['.devcontainer/a/devcontainer.json', '.devcontainer/b/devcontainer.json'] });
    expect(repositoryTarget('acme/api', info, true)).toEqual({
      repository: 'Acme/API',
      defaultBranch: 'main',
      configPaths: ['.devcontainer/a/devcontainer.json', '.devcontainer/b/devcontainer.json'],
      trusted: true,
    });
  });

  it('works for an unknown repository: the pipeline finds the configuration after the clone', () => {
    expect(repositoryTarget('x/y', undefined, false)).toEqual({ repository: 'x/y', defaultBranch: null, configPaths: [], trusted: false });
  });
});

describe('ownerTrust', () => {
  const data = discovery([], { viewerLogin: 'Me', organizations: ['Acme'] });

  it('trusts the account and its organizations when the data belongs to the account', () => {
    expect(ownerTrust(data, 'me', 'ME')).toBe('trusted');
    expect(ownerTrust(data, 'me', 'acme')).toBe('trusted');
    expect(ownerTrust(data, 'me', 'stranger')).toBe('untrusted');
  });

  it('is unknown without data, without an account, or when the data belongs to another account', () => {
    expect(ownerTrust(undefined, 'me', 'me')).toBe('unknown');
    expect(ownerTrust(data, undefined, 'me')).toBe('unknown');
    expect(ownerTrust(data, 'someone-else', 'acme')).toBe('unknown');
  });
});

describe('repository lists', () => {
  it('builds a placeholder for a repository that only the registry knows', () => {
    expect(placeholderRepositoryInfo('lost/repo')).toEqual({
      nameWithOwner: 'lost/repo',
      owner: 'lost',
      name: 'repo',
      url: 'https://github.com/lost/repo',
      isArchived: false,
      isFork: false,
      isPrivate: false,
      pushedAt: null,
      defaultBranch: null,
      configPaths: [],
    });
    expect(gitHubUrl('a b/c')).toBe('https://github.com/a%20b/c');
    expect(repositoryKey('Acme/API')).toBe('acme/api');
  });

  it('finds a repository in the discovery, then in the lookups (case-insensitive)', () => {
    const listed = repo('Acme/API');
    const looked = repo('acme/old', { configPaths: [] });
    const lookups = new Map<string, RepositoryInfo | null>([
      ['acme/old', looked],
      ['acme/gone', null],
    ]);
    const empty = repo('acme/empty', { configPaths: [] });
    expect(findRepositoryInfo('acme/api', discovery([listed]), lookups)).toBe(listed);
    expect(findRepositoryInfo('ACME/old', discovery([listed]), lookups)).toBe(looked);
    // Also the repositories without a configuration that the discovery stores.
    expect(findRepositoryInfo('acme/EMPTY', discovery([listed], { withoutConfiguration: [empty] }), lookups)).toBe(empty);
    expect(listedRepositories(discovery([listed], { withoutConfiguration: [empty] }))).toEqual([listed, empty]);
    expect(listedRepositories(undefined)).toEqual([]);
    expect(findRepositoryInfo('acme/gone', discovery([listed]), lookups)).toBeUndefined();
    expect(findRepositoryInfo('acme/api', undefined, new Map())).toBeUndefined();
  });

  it('lists the filtered discovery plus the repository of every devspace, once each', () => {
    const result = pickerRepositories({
      data: discovery([repo('acme/api'), repo('acme/archived', { isArchived: true }), repo('acme/archived-env', { isArchived: true })]),
      settings,
      devspaces: [
        devspace('e1', 'ACME/api'),
        devspace('e2', 'acme/archived-env'),
        devspace('e3', 'acme/old'),
        devspace('e4', 'lost/repo'),
      ],
      lookups: new Map([['acme/old', repo('acme/old', { configPaths: [] })]]),
    });
    expect(result.map((info) => info.nameWithOwner)).toEqual(['acme/api', 'acme/archived-env', 'acme/old', 'lost/repo']);
    expect(result[3].defaultBranch).toBeNull();
  });

  it('lists the repositories without a configuration only with a default image (they start from it)', () => {
    const data = discovery([repo('acme/api')], { withoutConfiguration: [repo('acme/empty', { configPaths: [] }), repo('acme/fork', { configPaths: [], isFork: true })] });
    const names = (result: RepositoryInfo[]) => result.map((info) => info.nameWithOwner);
    expect(names(pickerRepositories({ data, settings, devspaces: [], lookups: new Map() }))).toEqual(['acme/api']);
    const withImage = { ...settings, includeForks: false, defaultImage: 'ghcr.io/majikmate/devcontainer-base:latest' };
    expect(names(pickerRepositories({ data, settings: withImage, devspaces: [], lookups: new Map() }))).toEqual(['acme/api', 'acme/empty']);
    // The devspace of such a repository is listed either way, with its GitHub data.
    const result = pickerRepositories({ data, settings, devspaces: [devspace('e1', 'acme/empty')], lookups: new Map() });
    expect(result.map((info) => [info.nameWithOwner, info.defaultBranch])).toEqual([['acme/api', 'main'], ['acme/empty', 'main']]);
  });

  it('looks up the repositories of devspaces that the discovery does not list, each once', () => {
    const devspaces = [
      devspace('e1', 'acme/api'),
      devspace('e2', 'acme/old'),
      devspace('e3', 'ACME/OLD'),
      devspace('e4', 'lost/repo'),
    ];
    expect(repositoriesToLookUp(devspaces, [repo('Acme/Api')])).toEqual(['acme/old', 'lost/repo']);
    // A repository that the discovery lists without a configuration needs no lookup.
    expect(repositoriesToLookUp(devspaces, listedRepositories(discovery([repo('Acme/Api')], { withoutConfiguration: [repo('acme/old', { configPaths: [] })] })))).toEqual(['lost/repo']);
    expect(repositoriesToLookUp([], [repo('acme/api')])).toEqual([]);
  });

  it.each<[string, string[], string[]]>([
    ['the empty scope looks up every unlisted repository', [], ['acme/old', 'lost/repo']],
    ['a scope looks up only repositories of its owners', ['ACME'], ['acme/old']],
    ['a scope without these owners looks up nothing', ['beta'], []],
  ])('with a scan scope: %s', (_name, owners, expected) => {
    const devspaces = [devspace('e1', 'acme/api'), devspace('e2', 'acme/old'), devspace('e4', 'lost/repo')];
    expect(repositoriesToLookUp(devspaces, [repo('acme/api')], owners)).toEqual(expected);
  });
});

describe('sourceChoices', () => {
  it('names each source by its word, shows its image or path, and marks the sources that have a devspace', () => {
    const sources = [
      { kind: 'defaultImage' as const, image: 'ghcr.io/acme/base:latest' },
      { kind: 'configuration' as const, configPath: '.devcontainer/devcontainer.json' },
      { kind: 'configuration' as const, configPath: '.devcontainer/python/devcontainer.json' },
    ];
    expect(sourceChoices(sources, [devspace('e1', 'acme/api', { configPath: '.devcontainer/python/devcontainer.json' })])).toEqual([
      { source: sources[0], label: 'default', description: 'ghcr.io/acme/base:latest', hasDevspace: false },
      { source: sources[1], label: 'config', description: '.devcontainer/devcontainer.json', hasDevspace: false },
      {
        source: sources[2],
        label: 'python',
        description: `.devcontainer/python/devcontainer.json · ${ControllerTexts.devspaceExists}`,
        hasDevspace: true,
      },
    ]);
  });

  it('marks the default-image source when a default-image devspace exists, whatever image it was built from', () => {
    const source = { kind: 'defaultImage' as const, image: 'ghcr.io/acme/base:2' };
    expect(sourceChoices([source], [devspace('e1', 'acme/api', { defaultImage: 'ghcr.io/acme/base:1' })])).toEqual([
      { source, label: 'default', description: `ghcr.io/acme/base:2 · ${ControllerTexts.devspaceExists}`, hasDevspace: true },
    ]);
  });
});

describe('sidebar data', () => {
  it('marks every devspace as stopped with its volume when Docker does not run', () => {
    expect(dockerStoppedRuntime([devspace('e1', 'a/b'), devspace('e2', 'c/d')])).toEqual(
      new Map([
        ['e1', { container: 'stopped', volume: true }],
        ['e2', { container: 'stopped', volume: true }],
      ]),
    );
  });

  it('keeps only live busy marks', () => {
    const since = iso(NOW - 60_000);
    const devspaces = [
      devspace('live', 'a/live', { busy: { operation: 'update', since, pid: 1, windowId: 'w1' } }),
      devspace('dead', 'a/dead', { busy: { operation: 'update', since, pid: 2, windowId: 'w2' } }),
      devspace('old', 'a/old', { busy: { operation: 'update', since: iso(NOW - 7 * 3_600_000), pid: 1, windowId: 'w1' } }),
      devspace('other', 'a/other', { busy: { operation: 'update', since, pid: 1, windowId: 'w-gone' } }),
      devspace('idle', 'a/idle'),
    ];
    const windowStatuses = [{ windowId: 'w1', pid: 1, devspaceId: null, state: 'active' as const, updatedAt: iso(NOW) }];
    expect(liveBusyDevspaceIds(devspaces, { now: NOW, isAlive: (pid) => pid === 1 })).toEqual(new Set(['live', 'other']));
    expect(liveBusyDevspaceIds(devspaces, { now: NOW, isAlive: (pid) => pid === 1, windowStatuses })).toEqual(new Set(['live']));
  });

  it('collects the devspaces of windows', () => {
    const status = (windowId: string, devspaceId: string | null) => ({
      windowId,
      pid: 1,
      devspaceId,
      state: 'active' as const,
      updatedAt: iso(NOW),
    });
    expect(devspaceIdsOf([status('w1', 'e1'), status('w2', null), status('w3', 'e1'), status('w4', 'e2')])).toEqual(
      new Set(['e1', 'e2']),
    );
  });
});
