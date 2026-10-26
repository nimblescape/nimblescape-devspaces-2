// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Messages, StateTexts } from '../core/messages';
import type { DiscoveryData, Devspace, DevspaceSource, DevspaceState, GitSummary, RepositoryInfo } from '../core/types';
import {
  buildTreeModel,
  contextValue,
  devspaceState,
  recentDevspaces,
  repositoriesForPicker,
  repositoryEntriesOf,
  repositoryRows,
  rootNodes,
  rowActions,
  rowStateText,
  stateIcon,
  stateText,
  TreeTexts,
  type DevspaceRuntime,
  type GroupNode,
  type HintRow,
  type OwnerGroup,
  type RepositoryEntry,
  type RepositoryNode,
  type RepositoryRow,
  type TreeInput,
} from './treeModel';
import { parseRepositoryGroups } from './repositoryGroups';

const T0 = Date.parse('2026-09-24T17:00:00.000Z');
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
    pushedAt: iso(T0),
    defaultBranch: 'main',
    configPaths: ['.devcontainer/devcontainer.json'],
    ...overrides,
  };
}

function summary(overrides: Partial<GitSummary> = {}): GitSummary {
  return { branch: 'main', uncommittedFiles: 0, unpushedCommits: 0, stashes: 0, recordedAt: iso(T0), ...overrides };
}

function devspace(id: string, repository: string, overrides: Partial<Devspace> = {}): Devspace {
  return {
    id,
    repository,
    configPath: '.devcontainer/devcontainer.json',
    volumeName: `devspaces-${id}`,
    containerName: `devspaces-${id}`,
    createdAt: iso(T0 - 3_600_000),
    lastUsedAt: iso(T0),
    owner: { id: '1001', login: 'me' },
    gitSummary: summary(),
    ...overrides,
  };
}

function discovery(repositories: RepositoryInfo[], overrides: Partial<DiscoveryData> = {}): DiscoveryData {
  return {
    version: 1,
    fetchedAt: iso(T0),
    viewerLogin: 'me',
    organizations: ['acme-university'],
    repositories,
    hints: [],
    scope: [],
    withoutConfiguration: [],
    ...overrides,
  };
}

function input(overrides: Partial<TreeInput> = {}): TreeInput {
  return {
    discovery: undefined,
    settings: { owners: [], includeArchived: false, includeForks: true },
    devspaces: [],
    runtime: undefined,
    currentDevspaceId: null,
    otherWindowDevspaceIds: new Set(),
    busyDevspaceIds: new Set(),
    liveBranches: new Map(),
    signedIn: true,
    formatTime: (value) => `T(${value})`,
    ...overrides,
  };
}

function runtime(entries: Record<string, DevspaceRuntime>): Map<string, DevspaceRuntime> {
  return new Map(Object.entries(entries));
}

function rows(groups: OwnerGroup[]): RepositoryRow[] {
  return repositoryRows(groups);
}

/** The repository entries (single rows and nodes with child rows) in display order. */
function entries(groups: OwnerGroup[]): RepositoryEntry[] {
  return repositoryEntriesOf(groups);
}

/** The node of a repository with child rows (`owner/name`, case-insensitive). */
function node(groups: OwnerGroup[], repository: string): RepositoryNode {
  const key = repository.toLowerCase();
  const found = repositoryEntriesOf(groups).find((entry) => entry.kind === 'repositoryNode' && entry.repository.toLowerCase() === key);
  if (!found || found.kind !== 'repositoryNode') throw new Error(`No node for ${repository}`);
  return found;
}

/** The child row of a source of a repository with child rows. */
function childRow(groups: OwnerGroup[], repository: string, label: string): RepositoryRow {
  const found = node(groups, repository).children.find((child) => child.label === label);
  if (!found) throw new Error(`No child row ${label} of ${repository}`);
  return found;
}

const IMAGE = 'ghcr.io/majikmate/devcontainer-base:latest';
const DEFAULT_SOURCE: DevspaceSource = { kind: 'defaultImage', image: IMAGE };
const ROOT_SOURCE: DevspaceSource = { kind: 'configuration', configPath: '.devcontainer/devcontainer.json' };

/** The row of a devspace (only the tests use it). */
function findRowByDevspaceId(groups: readonly OwnerGroup[], devspaceId: string): RepositoryRow | undefined {
  return repositoryRows(groups).find((entry) => entry.devspace?.id === devspaceId);
}

/** The row of a repository (`owner/name`, case-insensitive; only the tests use it). */
function findRowByRepository(groups: readonly OwnerGroup[], repository: string): RepositoryRow | undefined {
  const key = repository.toLowerCase();
  return repositoryRows(groups).find((entry) => entry.repository.toLowerCase() === key);
}

function row(groups: OwnerGroup[], repository: string): RepositoryRow {
  const found = findRowByRepository(groups, repository);
  if (!found) throw new Error(`No row for ${repository}`);
  return found;
}

function flags(value: string): string[] {
  return value.split(';');
}

describe('devspaceState', () => {
  const env = devspace('e1', 'acme-university/api');
  const state = (overrides: Partial<TreeInput>): DevspaceState => devspaceState(env, input(overrides));

  it('is updating while a live busy mark exists, before every other state', () => {
    expect(
      state({
        busyDevspaceIds: new Set(['e1']),
        currentDevspaceId: 'e1',
        runtime: runtime({ e1: { container: 'missing', volume: false } }),
      }),
    ).toBe('updating');
  });

  it('is files missing when Docker reports no volume, also for the connected devspace', () => {
    expect(state({ runtime: runtime({ e1: { container: 'running', volume: false } }), currentDevspaceId: 'e1' })).toBe(
      'filesMissing',
    );
  });

  it('is connected for this window and connected · other window for another window', () => {
    expect(state({ currentDevspaceId: 'e1', otherWindowDevspaceIds: new Set(['e1']) })).toBe('connected');
    expect(state({ otherWindowDevspaceIds: new Set(['e1']) })).toBe('connectedOtherWindow');
    expect(state({ currentDevspaceId: 'e1', runtime: runtime({ e1: { container: 'running', volume: true } }) })).toBe(
      'connected',
    );
  });

  it('shows the container state when a referenced container does not run (connection lost)', () => {
    expect(state({ currentDevspaceId: 'e1', runtime: runtime({ e1: { container: 'stopped', volume: true } }) })).toBe(
      'stopped',
    );
    expect(
      state({ otherWindowDevspaceIds: new Set(['e1']), runtime: runtime({ e1: { container: 'missing', volume: true } }) }),
    ).toBe('noContainer');
  });

  it('maps the container state', () => {
    expect(state({ runtime: runtime({ e1: { container: 'running', volume: true } }) })).toBe('running');
    expect(state({ runtime: runtime({ e1: { container: 'stopped', volume: true } }) })).toBe('stopped');
    expect(state({ runtime: runtime({ e1: { container: 'missing', volume: true } }) })).toBe('noContainer');
  });

  it('is stopped without runtime data, or when the runtime data lacks the devspace', () => {
    expect(state({ runtime: undefined })).toBe('stopped');
    expect(state({ runtime: runtime({ other: { container: 'running', volume: true } }) })).toBe('stopped');
  });

  it('ignores busy marks and windows of other devspaces', () => {
    expect(
      state({
        busyDevspaceIds: new Set(['e2']),
        currentDevspaceId: 'e2',
        otherWindowDevspaceIds: new Set(['e3']),
        runtime: runtime({ e1: { container: 'running', volume: true } }),
      }),
    ).toBe('running');
  });
});

describe('running side services of Docker Compose', () => {
  const env = devspace('e1', 'acme-university/api');
  const info = repo('acme-university/api');
  const rowWith = (entry: DevspaceRuntime, overrides: Partial<TreeInput> = {}) =>
    row(buildTreeModel(input({ devspaces: [env], runtime: runtime({ e1: entry }), ...overrides })), 'acme-university/api');

  it('shows the state of the dev container, offers Start, and keeps Stop while a side service runs', () => {
    const stopped = rowWith({ container: 'stopped', volume: true, servicesRunning: true });
    expect(stopped.state).toBe('stopped');
    expect(stopped.actions.canStart).toBe(true);
    expect(stopped.actions.canStop).toBe(true);
    expect(stopped.description).toContain(`${StateTexts.stopped} · ${StateTexts.servicesRunning}`);
    expect(stopped.tooltip).toContain(TreeTexts.servicesRunning);
    const missing = rowWith({ container: 'missing', volume: true, servicesRunning: true });
    expect(missing.state).toBe('noContainer');
    expect(missing.actions.canStop).toBe(true);
  });

  it('is not connected while only a side service runs', () => {
    expect(rowWith({ container: 'stopped', volume: true, servicesRunning: true }, { currentDevspaceId: 'e1' }).state).toBe('stopped');
    expect(rowWith({ container: 'stopped', volume: true, servicesRunning: true }, { otherWindowDevspaceIds: new Set(['e1']) }).state).toBe('stopped');
  });

  it('adds nothing without running side services, or while the dev container runs', () => {
    const stopped = rowWith({ container: 'stopped', volume: true });
    expect(stopped.actions.canStop).toBe(false);
    expect(stopped.description).not.toContain(StateTexts.servicesRunning);
    const running = rowWith({ container: 'running', volume: true, servicesRunning: true });
    expect(running.state).toBe('running');
    expect(running.description).not.toContain(StateTexts.servicesRunning);
    expect(running.tooltip).not.toContain(TreeTexts.servicesRunning);
  });

  it('offers Stop for running side services, but not while the devspace is updating', () => {
    expect(rowActions('stopped', info, undefined, true).canStop).toBe(true);
    expect(rowActions('noContainer', info, undefined, true).canStop).toBe(true);
    expect(rowActions('updating', info, 'rebuild', true).canStop).toBe(false);
    expect(rowActions('stopped', info, undefined, false).canStop).toBe(false);
  });
});

describe('row actions and contextValue', () => {
  const info = repo('acme-university/api');
  const multi = repo('acme-university/api', {
    configPaths: ['.devcontainer/devcontainer.json', '.devcontainer/python/devcontainer.json'],
  });

  it.each<[DevspaceState | undefined, string]>([
    [undefined, 'repository;canStart;onGitHub'],
    ['connected', 'repository;canStop;canDelete;canRebuild;onGitHub'],
    ['connectedOtherWindow', 'repository;canStart;canStop;canDelete;canRebuild;onGitHub'],
    ['running', 'repository;canStart;canStop;canDelete;canRebuild;onGitHub'],
    ['stopped', 'repository;canStart;canDelete;canRebuild;onGitHub'],
    ['noContainer', 'repository;canStart;canDelete;canRebuild;onGitHub'],
    ['filesMissing', 'repository;canStart;canDelete;canRebuild;onGitHub'],
    ['updating', 'repository;canDelete;onGitHub'],
  ])('state %s → %s', (state, expected) => {
    expect(contextValue(rowActions(state, info))).toBe(expected);
  });

  it('offers Delete while the devspace is updating, except while it is being deleted', () => {
    for (const operation of ['create', 'update', 'rebuild'] as const) {
      expect(contextValue(rowActions('updating', info, operation))).toBe('repository;canDelete;onGitHub');
    }
    expect(contextValue(rowActions('updating', info, 'delete'))).toBe('repository;onGitHub');
    // The operation of a mark matters only while the state is updating.
    expect(flags(contextValue(rowActions('stopped', info, 'delete')))).toContain('canDelete');
  });

  it('takes the operation of the busy mark of the devspace for the row', () => {
    const mark = (operation: 'rebuild' | 'delete') =>
      devspace('e1', 'acme/api', { busy: { operation, since: iso(T0), pid: 4242, windowId: 'window-2' } });
    const rowFor = (env: Devspace) =>
      row(buildTreeModel(input({ devspaces: [env], busyDevspaceIds: new Set(['e1']) })), 'acme/api');
    expect(rowFor(mark('rebuild')).actions.canDelete).toBe(true);
    expect(rowFor(mark('delete')).actions.canDelete).toBe(false);
    expect(rowFor(mark('rebuild')).actions.canStart).toBe(false);
  });

  it('adds onGitHub only with discovery data; the number of configurations changes no flag (the sources are rows)', () => {
    expect(flags(contextValue(rowActions('stopped', undefined)))).not.toContain('onGitHub');
    expect(contextValue(rowActions('stopped', multi))).toBe(contextValue(rowActions('stopped', info)));
  });

  it('matches the when clauses of package.json', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: { menus: Record<string, Array<{ command?: string; submenu?: string; when?: string }>> };
    };
    const menus = manifest.contributes.menus;
    const whenOf = (menu: string, command: string) =>
      menus[menu].filter((item) => item.command === command).map((item) => item.when ?? '');
    const matches = (when: string, value: string) => {
      const regex = /viewItem =~ \/(.+?)\//.exec(when);
      return regex ? new RegExp(regex[1]).test(value) : true;
    };
    const cases: Array<[string, keyof ReturnType<typeof rowActions>]> = [
      ['devspaces.start', 'canStart'],
      ['devspaces.stop', 'canStop'],
      ['devspaces.delete', 'canDelete'],
      ['devspaces.rebuild', 'canRebuild'],
      ['devspaces.showOnGitHub', 'onGitHub'],
    ];
    const states: Array<DevspaceState | undefined> = [
      undefined,
      'connected',
      'connectedOtherWindow',
      'running',
      'stopped',
      'noContainer',
      'filesMissing',
      'updating',
    ];
    for (const state of states) {
      for (const information of [info, multi, undefined]) {
        const actions = rowActions(state, information);
        const value = contextValue(actions);
        for (const [command, flag] of cases) {
          const clauses = [...whenOf('view/item/context', command), ...whenOf('devspaces.more', command)];
          expect(clauses.length).toBeGreaterThan(0);
          for (const when of clauses) {
            expect(matches(when, value), `${command} for ${state ?? 'no devspace'}: ${value}`).toBe(actions[flag]);
          }
        }
        // The ⋯ submenu appears on every repository row.
        const submenu = menus['view/item/context'].find((item) => item.submenu === 'devspaces.more');
        expect(matches(submenu?.when ?? '', value)).toBe(true);
      }
    }
  });
});

describe('buildTreeModel', () => {
  it('shows the mockup of the sidebar', () => {
    const multi = ['.devcontainer/devcontainer.json', '.devcontainer/python/devcontainer.json'];
    const groups = buildTreeModel(
      input({
        discovery: discovery([
          repo('acme-university/api', { configPaths: multi }),
          repo('acme-university/docs'),
          repo('acme-university/web'),
          repo('acme-university/infra'),
          repo('me/dotfiles'),
          repo('me/website'),
        ]),
        devspaces: [
          devspace('e-api', 'acme-university/api', { configPath: '.devcontainer/python/devcontainer.json' }),
          devspace('e-docs', 'acme-university/docs'),
          devspace('e-web', 'acme-university/web', {
            gitSummary: summary({ branch: 'feature-x', unpushedCommits: 3 }),
          }),
          devspace('e-dot', 'me/dotfiles'),
        ],
        runtime: runtime({
          'e-api': { container: 'running', volume: true },
          'e-docs': { container: 'running', volume: true },
          'e-web': { container: 'stopped', volume: true },
          'e-dot': { container: 'stopped', volume: true },
        }),
        currentDevspaceId: 'e-api',
        liveBranches: new Map([
          ['e-api', 'main'],
          ['e-docs', 'main'],
        ]),
      }),
    );

    expect(groups.map((group) => group.owner)).toEqual(['acme-university', 'me']);
    // A repository with two configurations is a node with a child row per configuration; its devspace is on the row
    // of its configuration.
    expect(groups[0].children.map((child) => (child.kind === 'repositoryNode' ? [child.label, child.children.map((row) => row.label)] : child.label))).toEqual([
      ['api', ['config', 'python']],
      'docs',
      'infra',
      'web',
    ]);
    const view = groups.map((group) => ({
      owner: group.owner,
      rows: rows([group]).map((entry) => [entry.label, entry.state, entry.description, entry.contextValue]),
    }));
    // Every repository row has the flag of its host access checks (on by default: hostAccessChecked). Every row with a
    // devspace has the flag of Keep Running When Closed (off by default: canKeepRunning). The row of this window's
    // devspace has the flag of Close and Keep Running.
    expect(view).toEqual([
      {
        owner: 'acme-university',
        rows: [
          ['config', undefined, '', 'repository;canStart;onGitHub;hostAccessChecked'],
          ['python', 'connected', 'main   Connected', 'repository;canStop;canDelete;canRebuild;onGitHub;hostAccessChecked;canKeepRunning;canCloseAndKeepRunning'],
          ['docs', 'running', 'main   Running', 'repository;canStart;canStop;canDelete;canRebuild;onGitHub;hostAccessChecked;canKeepRunning'],
          ['infra', undefined, '', 'repository;canStart;onGitHub;hostAccessChecked'],
          ['web', 'stopped', 'feature-x   Stopped · 3 unpushed', 'repository;canStart;canDelete;canRebuild;onGitHub;hostAccessChecked;canKeepRunning'],
        ],
      },
      {
        owner: 'me',
        rows: [
          ['dotfiles', 'stopped', 'main   Stopped', 'repository;canStart;canDelete;canRebuild;onGitHub;hostAccessChecked;canKeepRunning'],
          ['website', undefined, '', 'repository;canStart;onGitHub;hostAccessChecked'],
        ],
      },
    ]);
  });

  it('uses stable IDs and fills the row fields', () => {
    const info = repo('Acme/API');
    const env = devspace('e1', 'Acme/API');
    const groups = buildTreeModel(input({ discovery: discovery([info]), devspaces: [env] }));
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: 'owner', id: 'owner:acme', owner: 'Acme' });
    const entry = row(groups, 'acme/api');
    expect(entry).toMatchObject({
      kind: 'repository',
      id: 'repo:acme/api',
      repository: 'Acme/API',
      owner: 'Acme',
      name: 'API',
      label: 'API',
      info,
      devspace: env,
      state: 'stopped',
      branch: 'main',
      notOnGitHub: false,
    });
  });

  // A repository with a devspace keeps its alphabetical place.
  it('sorts groups by owner and rows alphabetically, with or without a devspace, case-insensitive and natural', () => {
    const groups = buildTreeModel(
      input({
        discovery: discovery([
          repo('zeta/one'),
          repo('Alpha/zulu'),
          repo('alpha-2/x'),
          repo('Alpha/beta'),
          repo('Alpha/repo10'),
          repo('Alpha/repo2'),
          repo('Alpha/Charlie'),
          repo('Alpha/yankee'),
        ]),
        devspaces: [devspace('e1', 'Alpha/yankee'), devspace('e2', 'Alpha/Charlie')],
      }),
    );
    expect(groups.map((group) => group.owner)).toEqual(['Alpha', 'alpha-2', 'zeta']);
    expect(rows([groups[0]]).map((entry) => entry.name)).toEqual(['beta', 'Charlie', 'repo2', 'repo10', 'yankee', 'zulu']);
  });

  it('lists a devspace whose repository GitHub does not list, with "not on GitHub"', () => {
    const groups = buildTreeModel(
      input({
        discovery: discovery([repo('acme/api')]),
        devspaces: [
          devspace('e1', 'acme/old', { gitSummary: summary({ branch: 'dev', uncommittedFiles: 2 }) }),
          devspace('e2', 'lost/repo'),
        ],
      }),
    );
    const old = row(groups, 'acme/old');
    expect(old.notOnGitHub).toBe(true);
    expect(old.description).toBe('dev   Stopped · 2 uncommitted · not on GitHub');
    // The flag of the host access checks (on by default).
    expect(old.contextValue).toBe('repository;canStart;canDelete;canRebuild;hostAccessChecked;canKeepRunning');
    expect(old.tooltip).toContain(TreeTexts.notListedOnGitHub);
    expect(row(groups, 'lost/repo').description).toBe('main   Stopped · not on GitHub');
    expect(groups.map((group) => group.owner)).toEqual(['acme', 'lost']);
  });

  describe('repositories without a Dev Container configuration (the setting defaultImage)', () => {
    const empty = repo('acme/empty', { configPaths: [] });
    const withImage = { owners: [], includeArchived: false, includeForks: true, defaultImage: IMAGE };

    it('lists them only with a default image, as one row that starts from it; a repository with a configuration gets child rows', () => {
      const without = buildTreeModel(input({ discovery: discovery([repo('acme/api')], { withoutConfiguration: [empty] }) }));
      expect(entries(without).map((entry) => [entry.kind, entry.repository])).toEqual([['repository', 'acme/api']]);

      const groups = buildTreeModel(input({ discovery: discovery([repo('acme/api')], { withoutConfiguration: [empty] }), settings: withImage }));
      expect(entries(groups).map((entry) => [entry.kind, entry.repository])).toEqual([
        ['repositoryNode', 'acme/api'],
        ['repository', 'acme/empty'],
      ]);
      const entry = row(groups, 'acme/empty');
      expect(entry.info).toBe(empty);
      expect(entry.child).toBe(false);
      expect(entry.source).toEqual(DEFAULT_SOURCE);
      expect(entry.label).toBe('empty');
      expect(entry.tooltip).toContain(TreeTexts.noConfiguration);
      expect(entry.tooltip).toContain(TreeTexts.sourceDefaultImage(IMAGE));
      expect(flags(entry.contextValue)).toEqual(['repository', 'canStart', 'onGitHub', 'hostAccessChecked']);
      expect(node(groups, 'acme/api').children.map((child) => child.label)).toEqual(['default', 'config']);
      expect(childRow(groups, 'acme/api', 'config').tooltip).not.toContain(TreeTexts.noConfiguration);
    });

    it('filters them like the other repositories (settings owners, includeArchived, includeForks)', () => {
      const groups = buildTreeModel(
        input({
          discovery: discovery([repo('acme/api')], { withoutConfiguration: [empty, repo('acme/old', { configPaths: [], isArchived: true }), repo('beta/tool', { configPaths: [] })] }),
          settings: { owners: ['acme'], includeArchived: false, includeForks: true, defaultImage: IMAGE },
        }),
      );
      expect(entries(groups).map((entry) => entry.repository)).toEqual(['acme/api', 'acme/empty']);
    });

    it('gives the row of a devspace of such a repository its GitHub data, with or without a default image', () => {
      const groups = buildTreeModel(input({ discovery: discovery([repo('acme/api')], { withoutConfiguration: [empty] }), devspaces: [devspace('e1', 'acme/empty', { defaultImage: IMAGE })] }));
      const entry = row(groups, 'acme/empty');
      expect(entry.info).toBe(empty);
      expect(entry.notOnGitHub).toBe(false);
      expect(entry.child).toBe(false);
      expect(entry.source).toEqual(DEFAULT_SOURCE);
      expect(entry.description).toBe('main (default image)   Stopped');
      expect(flags(entry.contextValue)).toContain('onGitHub');
    });
  });

  describe('the child rows of a repository with several sources', () => {
    const withImage = { owners: [], includeArchived: false, includeForks: true, defaultImage: IMAGE };
    const python = '.devcontainer/python/devcontainer.json';

    it('makes a node with one child row per source: the default image first, then the configurations (the root one first)', () => {
      const groups = buildTreeModel(
        input({
          discovery: discovery([repo('acme/api', { configPaths: ['.devcontainer/devcontainer.json', python] })]),
          devspaces: [devspace('e1', 'acme/api', { defaultImage: IMAGE }), devspace('e2', 'acme/api', { configPath: python })],
          settings: withImage,
          currentDevspaceId: 'e2',
        }),
      );
      const api = node(groups, 'acme/api');
      expect(api).toMatchObject({ kind: 'repositoryNode', id: 'repo:acme/api', repository: 'acme/api', owner: 'acme', name: 'api', label: 'api', expanded: true });
      expect(api.tooltip).toBe(`acme/api\n${TreeTexts.sources(3)}`);
      expect(api.children.map((child) => [child.id, child.label, child.source, child.child, child.devspace?.id])).toEqual([
        ['repo:acme/api:default', 'default', DEFAULT_SOURCE, true, 'e1'],
        ['repo:acme/api:config', 'config', ROOT_SOURCE, true, undefined],
        ['repo:acme/api:config:python', 'python', { kind: 'configuration', configPath: python }, true, 'e2'],
      ]);
      // A child row names its source in its label, not in the description; the tooltip names the devspace with it.
      expect(childRow(groups, 'acme/api', 'default').description).toBe('main   Stopped');
      expect(childRow(groups, 'acme/api', 'default').tooltip.split('\n')[0]).toBe('acme/api · default');
      expect(childRow(groups, 'acme/api', 'default').tooltip).toContain(TreeTexts.sourceDefaultImage(IMAGE));
      expect(childRow(groups, 'acme/api', 'python').tooltip.split('\n')[0]).toBe('acme/api · python');
      expect(childRow(groups, 'acme/api', 'python').tooltip).toContain(TreeTexts.sourceConfiguration(python));
      expect(childRow(groups, 'acme/api', 'python').contextValue).toBe('repository;canStop;canDelete;canRebuild;onGitHub;hostAccessChecked;canKeepRunning;canCloseAndKeepRunning');
      expect(childRow(groups, 'acme/api', 'config').contextValue).toBe('repository;canStart;onGitHub;hostAccessChecked');
      expect(childRow(groups, 'acme/api', 'config').tooltip).toContain(TreeTexts.noDevspace);
    });

    it('is collapsed while no child row has a devspace', () => {
      const groups = buildTreeModel(
        input({
          discovery: discovery([repo('acme/api', { configPaths: ['.devcontainer/devcontainer.json', python] })]),
          settings: withImage,
        }),
      );
      const api = node(groups, 'acme/api');
      expect(api.expanded).toBe(false);
      expect(api.children.map((child) => [child.label, child.devspace])).toEqual([
        ['default', undefined],
        ['config', undefined],
        ['python', undefined],
      ]);
    });

    it('reads the host access checks of every child row under the registry name of the devspaces of the repository', () => {
      // The repository alice/tool was renamed to bob/tool on GitHub; its devspace keeps the old name, which the switch
      // names (the name the pipeline reads): every row of the repository shows the same switch.
      const moved = repo('bob/tool', { configPaths: ['.devcontainer/devcontainer.json', python] });
      const groups = buildTreeModel(
        input({
          discovery: discovery([repo('acme/api')]),
          devspaces: [devspace('e2', 'alice/tool', { configPath: python })],
          repositoryLookups: new Map([['alice/tool', moved]]),
          settings: { ...withImage, hostAccessChecksOff: ['alice/tool'] },
        }),
      );
      const tool = node(groups, 'bob/tool');
      expect(tool.children.map((child) => [child.label, child.devspace?.id, child.hostAccessChecks])).toEqual([
        ['default', undefined, 'off'],
        ['config', undefined, 'off'],
        ['python', 'e2', 'off'],
      ]);
    });

    it('puts the default row last while the setting startWithDefaultImage is off', () => {
      const groups = buildTreeModel(
        input({ discovery: discovery([repo('acme/api')]), settings: { ...withImage, startWithDefaultImage: false } }),
      );
      expect(node(groups, 'acme/api').children.map((child) => child.label)).toEqual(['config', 'default']);
      const first = buildTreeModel(input({ discovery: discovery([repo('acme/api')]), settings: { ...withImage, startWithDefaultImage: true } }));
      expect(node(first, 'acme/api').children.map((child) => child.label)).toEqual(['default', 'config']);
    });

    it('makes child rows for the configurations of a repository also without a default image', () => {
      const groups = buildTreeModel(input({ discovery: discovery([repo('acme/api', { configPaths: ['.devcontainer/devcontainer.json', python] }), repo('acme/web')]) }));
      expect(entries(groups).map((entry) => [entry.kind, entry.label])).toEqual([
        ['repositoryNode', 'api'],
        ['repository', 'web'],
      ]);
      expect(node(groups, 'acme/api').children.map((child) => child.label)).toEqual(['config', 'python']);
      expect(row(groups, 'acme/web')).toMatchObject({ child: false, label: 'web', source: ROOT_SOURCE });
    });

    it('adds the default row for a default-image devspace that exists after the setting was cleared, with its image', () => {
      const groups = buildTreeModel(input({ discovery: discovery([repo('acme/api')]), devspaces: [devspace('e1', 'acme/api', { defaultImage: 'ghcr.io/acme/old:1' })] }));
      expect(node(groups, 'acme/api').children.map((child) => [child.label, child.source, child.devspace?.id])).toEqual([
        ['default', { kind: 'defaultImage', image: 'ghcr.io/acme/old:1' }, 'e1'],
        ['config', ROOT_SOURCE, undefined],
      ]);
    });

    it('shows a default-image devspace of a repository that GitHub does not list as one row, without the default image of the settings', () => {
      // A source without devspace would need the clone of a repository that cannot be found.
      const groups = buildTreeModel(input({ discovery: discovery([repo('acme/api')]), devspaces: [devspace('e1', 'acme/gone', { defaultImage: IMAGE })], settings: withImage }));
      const gone = row(groups, 'acme/gone');
      expect(gone).toMatchObject({ child: false, label: 'gone', source: DEFAULT_SOURCE });
      expect(gone.description).toBe('main (default image)   Stopped · not on GitHub');
      const config = buildTreeModel(input({ discovery: discovery([repo('acme/api')]), devspaces: [devspace('e1', 'acme/gone')], settings: withImage }));
      expect(row(config, 'acme/gone')).toMatchObject({ child: false, label: 'gone', source: ROOT_SOURCE });
    });

    it('gives a source with several devspaces (one per Docker host) a child row per devspace', () => {
      const groups = buildTreeModel(
        input({
          discovery: discovery([repo('acme/api')]),
          devspaces: [
            devspace('local', 'acme/api', { lastUsedAt: iso(T0) }),
            devspace('remote', 'acme/api', { lastUsedAt: iso(T0 - 1000), dockerHost: 'ssh://build' }),
          ],
          settings: withImage,
        }),
      );
      expect(node(groups, 'acme/api').children.map((child) => [child.id, child.label, child.devspace?.id])).toEqual([
        ['repo:acme/api:default', 'default', undefined],
        ['repo:acme/api:config', 'config', 'local'],
        ['repo:acme/api:config#remote', 'config', 'remote'],
      ]);
    });

    it('lists the child rows in repositoryRows, finds them by devspace, and names the devspaces with their source in the switcher', () => {
      const devspaces = [devspace('e1', 'acme/api', { defaultImage: IMAGE, lastUsedAt: iso(T0 + 1000) }), devspace('e2', 'acme/api', { lastUsedAt: iso(T0) })];
      const groups = buildTreeModel(input({ discovery: discovery([repo('acme/api'), repo('acme/web')]), devspaces, settings: withImage }));
      expect(rows(groups).map((entry) => entry.label)).toEqual(['default', 'config', 'default', 'config']);
      expect(findRowByDevspaceId(groups, 'e2')?.id).toBe('repo:acme/api:config');
      expect(recentDevspaces(groups, devspaces).map((entry) => [entry.devspaceId, entry.name, entry.state])).toEqual([
        ['e1', 'acme/api · default', 'stopped'],
        ['e2', 'acme/api · config', 'stopped'],
      ]);
      const single = buildTreeModel(input({ discovery: discovery([repo('acme/api')]), devspaces: [devspaces[1]] }));
      expect(recentDevspaces(single, [devspaces[1]]).map((entry) => entry.name)).toEqual(['acme/api']);
    });
  });

  describe('with single repository lookups (repositories without a configuration on the default branch)', () => {
    it('uses a found repository: no "not on GitHub", Show on GitHub, and its configurations', () => {
      const found = repo('acme/old', { configPaths: [], defaultBranch: 'trunk', url: 'https://github.com/Acme/old' });
      const groups = buildTreeModel(
        input({
          discovery: discovery([repo('acme/api')]),
          devspaces: [devspace('e1', 'acme/old')],
          repositoryLookups: new Map([['acme/old', found]]),
        }),
      );
      const entry = row(groups, 'acme/old');
      expect(entry.notOnGitHub).toBe(false);
      expect(entry.info).toBe(found);
      expect(entry.description).toBe('main   Stopped');
      expect(flags(entry.contextValue)).toContain('onGitHub');
      expect(entry.child).toBe(false);
    });

    it('shows "not on GitHub" only for a repository that the lookup did not find', () => {
      const groups = buildTreeModel(
        input({
          discovery: discovery([repo('acme/api')]),
          devspaces: [devspace('e1', 'acme/gone'), devspace('e2', 'acme/unknown')],
          repositoryLookups: new Map([['acme/gone', null]]),
        }),
      );
      expect(row(groups, 'acme/gone').notOnGitHub).toBe(true);
      expect(row(groups, 'acme/gone').description).toBe('main   Stopped · not on GitHub');
      // Not looked up yet, or the lookup failed: unknown, so no claim.
      expect(row(groups, 'acme/unknown').notOnGitHub).toBe(false);
      expect(row(groups, 'acme/unknown').description).toBe('main   Stopped');
      expect(flags(row(groups, 'acme/unknown').contextValue)).not.toContain('onGitHub');
    });

    it('prefers the discovery over a lookup and adds no rows for looked-up repositories without devspace', () => {
      const listed = repo('acme/api', { configPaths: ['.devcontainer/a/devcontainer.json', '.devcontainer/b/devcontainer.json'] });
      const groups = buildTreeModel(
        input({
          discovery: discovery([listed]),
          devspaces: [devspace('e1', 'acme/api')],
          repositoryLookups: new Map([
            ['acme/api', repo('acme/api')],
            ['acme/extra', repo('acme/extra')],
          ]),
        }),
      );
      expect(node(groups, 'acme/api').info).toBe(listed);
      expect(node(groups, 'acme/api').children.map((child) => child.label)).toEqual(['config', 'a', 'b']);
      expect(entries(groups).map((entry) => entry.repository)).toEqual(['acme/api']);
    });
  });

  describe('rootNodes', () => {
    it('adds the sign-in row first when not signed in and the view is not empty', () => {
      const groups = buildTreeModel(input({ signedIn: false, devspaces: [devspace('e1', 'acme/api')] }));
      const nodes = rootNodes(groups, false);
      expect(nodes[0]).toEqual({ kind: 'signIn', id: 'signIn', label: TreeTexts.signIn, tooltip: TreeTexts.signInTooltip });
      expect(nodes.slice(1)).toEqual(groups);
    });

    it('adds no sign-in row when signed in or when the view is empty', () => {
      const groups = buildTreeModel(input({ devspaces: [devspace('e1', 'acme/api')] }));
      expect(rootNodes(groups, true)).toEqual(groups);
      expect(rootNodes([], false)).toEqual([]);
    });

    // Without a remote Docker host and without a local Docker, the repositories are not shown; the sidebar shows the
    // Docker setup. The sidebar passes an empty model then (sidebar.test.ts), so the view shows the welcome view with
    // the setup (package.json, controller.test.ts); the rows never contain a Docker row, not even above a list.
    it('never adds a Docker row: the Docker setup is the welcome view of the empty view', () => {
      const groups = buildTreeModel(input({ signedIn: false, devspaces: [devspace('e1', 'acme/api')] }));
      const signIn = { kind: 'signIn', id: 'signIn', label: TreeTexts.signIn, tooltip: TreeTexts.signInTooltip };
      expect(rootNodes(groups, false)).toEqual([signIn, ...groups]);
      expect(rootNodes(groups, true)).toEqual(groups);
      expect(rootNodes([], false)).toEqual([]);
      expect(rootNodes([], true)).toEqual([]);
      expect(Object.keys(TreeTexts)).not.toContain('installDocker');
    });
  });

  it('shows only the devspaces when the user is not signed in, without "not on GitHub"', () => {
    const groups = buildTreeModel(
      input({
        signedIn: false,
        discovery: discovery([repo('acme/api'), repo('acme/web')], {
          hints: [{ organization: 'acme', kind: 'saml', url: 'https://github.com/orgs/acme/sso' }],
        }),
        devspaces: [devspace('e1', 'acme/api'), devspace('e2', 'gone/repo')],
      }),
    );
    expect(rows(groups).map((entry) => entry.repository)).toEqual(['acme/api', 'gone/repo']);
    expect(groups.flatMap((group) => group.children).some((child) => child.kind === 'hint')).toBe(false);
    expect(row(groups, 'gone/repo').notOnGitHub).toBe(false);
    expect(row(groups, 'gone/repo').description).toBe('main   Stopped');
    // The stored list still knows the repository, so Show on GitHub works.
    expect(flags(row(groups, 'acme/api').contextValue)).toContain('onGitHub');
  });

  it('shows the devspaces without "not on GitHub" while no repository list is loaded', () => {
    const groups = buildTreeModel(input({ discovery: undefined, devspaces: [devspace('e1', 'acme/api')] }));
    // The flag of the host access checks (on by default).
    expect(rows(groups).map((entry) => [entry.repository, entry.description, entry.contextValue])).toEqual([
      ['acme/api', 'main   Stopped', 'repository;canStart;canDelete;canRebuild;hostAccessChecked;canKeepRunning'],
    ]);
  });

  it('returns no groups without devspaces and without a repository list', () => {
    expect(buildTreeModel(input())).toEqual([]);
    expect(buildTreeModel(input({ discovery: discovery([]) }))).toEqual([]);
  });

  it('applies the settings filters to repositories without devspace only', () => {
    const groups = buildTreeModel(
      input({
        settings: { owners: [' ACME '], includeArchived: false, includeForks: false },
        discovery: discovery([
          repo('acme/api'),
          repo('acme/archived', { isArchived: true }),
          repo('acme/fork', { isFork: true }),
          repo('other/lib'),
          repo('other/tool'),
          repo('acme/archived-env', { isArchived: true }),
        ]),
        devspaces: [devspace('e1', 'other/tool'), devspace('e2', 'acme/archived-env')],
      }),
    );
    expect(rows(groups).map((entry) => entry.repository)).toEqual(['acme/api', 'acme/archived-env', 'other/tool']);
    expect(row(groups, 'other/tool').notOnGitHub).toBe(false);
    expect(row(groups, 'acme/archived-env').tooltip).toContain(TreeTexts.archived);
  });

  it('shows archived repositories and forks when the settings include them', () => {
    const groups = buildTreeModel(
      input({
        settings: { owners: [], includeArchived: true, includeForks: true },
        discovery: discovery([repo('acme/archived', { isArchived: true }), repo('acme/fork', { isFork: true })]),
      }),
    );
    expect(rows(groups).map((entry) => entry.repository)).toEqual(['acme/archived', 'acme/fork']);
  });

  it('matches devspaces to discovered repositories case-insensitively and uses the GitHub case', () => {
    const groups = buildTreeModel(
      input({ discovery: discovery([repo('Acme-University/API')]), devspaces: [devspace('e1', 'acme-university/api')] }),
    );
    expect(rows(groups)).toHaveLength(1);
    const entry = rows(groups)[0];
    expect(entry.repository).toBe('Acme-University/API');
    expect(entry.devspace?.id).toBe('e1');
    expect(entry.notOnGitHub).toBe(false);
    expect(groups[0].owner).toBe('Acme-University');
  });

  it('puts organization hints into the group of their organization, first, and respects the owners filter', () => {
    const hints = [
      { organization: 'acme', kind: 'saml' as const, url: 'https://github.com/orgs/acme/sso' },
      { organization: 'ACME', kind: 'saml' as const, url: 'https://github.com/orgs/acme/sso' },
      { organization: 'secret-org', kind: 'oauthRestricted' as const, url: 'https://github.com/settings/connections/applications/x' },
    ];
    const groups = buildTreeModel(input({ discovery: discovery([repo('acme/api')], { hints }) }));
    expect(groups.map((group) => group.owner)).toEqual(['acme', 'secret-org']);
    const acme = groups[0].children;
    expect(acme.map((child) => child.kind)).toEqual(['hint', 'repository']);
    const hint = acme[0] as HintRow;
    expect(hint).toEqual({
      kind: 'hint',
      id: 'hint:acme',
      organization: 'acme',
      label: 'Access to the organization acme is not authorized.',
      url: 'https://github.com/orgs/acme/sso',
    });
    expect(groups[1].children).toEqual([
      {
        kind: 'hint',
        id: 'hint:secret-org',
        organization: 'secret-org',
        label: 'Access to the organization secret-org is not authorized.',
        url: 'https://github.com/settings/connections/applications/x',
      },
    ]);

    const filtered = buildTreeModel(
      input({
        settings: { owners: ['acme'], includeArchived: false, includeForks: true },
        discovery: discovery([repo('acme/api')], { hints }),
      }),
    );
    expect(filtered.map((group) => group.owner)).toEqual(['acme']);
  });

  it('shows the devspace of an alternative configuration on the child row of that configuration', () => {
    const configs = ['.devcontainer/devcontainer.json', '.devcontainer.json', '.devcontainer/node/devcontainer.json'];
    const groups = buildTreeModel(
      input({
        discovery: discovery([repo('acme/multi', { configPaths: configs }), repo('acme/single')]),
        devspaces: [
          devspace('e1', 'acme/multi', { configPath: '.devcontainer/node/devcontainer.json' }),
          devspace('e2', 'acme/single', { configPath: '.devcontainer/devcontainer.json' }),
          devspace('e3', 'acme/root', { configPath: '.devcontainer.json' }),
        ],
      }),
    );
    // `.devcontainer/devcontainer.json` and `.devcontainer.json` are the one configuration at the root: one row.
    expect(node(groups, 'acme/multi').children.map((child) => [child.label, child.devspace?.id])).toEqual([
      ['config', undefined],
      ['node', 'e1'],
    ]);
    expect(childRow(groups, 'acme/multi', 'node').description).toBe('main   Stopped');
    expect(childRow(groups, 'acme/multi', 'node').tooltip).toContain(TreeTexts.sourceConfiguration('.devcontainer/node/devcontainer.json'));
    expect(row(groups, 'acme/single')).toMatchObject({ child: false, label: 'single', description: 'main   Stopped' });
    expect(row(groups, 'acme/root')).toMatchObject({ child: false, label: 'root', description: 'main   Stopped · not on GitHub' });

    const defaultConfig = buildTreeModel(
      input({
        discovery: discovery([repo('acme/multi', { configPaths: configs })]),
        devspaces: [devspace('e1', 'acme/multi', { configPath: '.devcontainer.json' })],
      }),
    );
    expect(node(defaultConfig, 'acme/multi').children.map((child) => [child.label, child.devspace?.id])).toEqual([
      ['config', 'e1'],
      ['node', undefined],
    ]);
  });

  it('uses the live branch while the container runs, and the recorded branch otherwise', () => {
    const env = devspace('e1', 'acme/api', { gitSummary: summary({ branch: 'recorded', unpushedCommits: 1 }) });
    const base = { discovery: discovery([repo('acme/api')]), devspaces: [env], liveBranches: new Map([['e1', 'live']]) };

    const running = buildTreeModel(input({ ...base, runtime: runtime({ e1: { container: 'running', volume: true } }) }));
    expect(row(running, 'acme/api').description).toBe('live   Running');
    const connected = buildTreeModel(input({ ...base, currentDevspaceId: 'e1' }));
    expect(row(connected, 'acme/api').description).toBe('live   Connected');
    const other = buildTreeModel(input({ ...base, otherWindowDevspaceIds: new Set(['e1']) }));
    expect(row(other, 'acme/api').description).toBe('live   Connected · other window');
    const stopped = buildTreeModel(input({ ...base, runtime: runtime({ e1: { container: 'stopped', volume: true } }) }));
    expect(row(stopped, 'acme/api').description).toBe('recorded   Stopped · 1 unpushed');

    const noLive = buildTreeModel(
      input({ ...base, liveBranches: new Map(), runtime: runtime({ e1: { container: 'running', volume: true } }) }),
    );
    expect(row(noLive, 'acme/api').description).toBe('recorded   Running');
  });

  it('shows no branch when none is known (detached HEAD or no summary)', () => {
    const groups = buildTreeModel(
      input({
        devspaces: [
          devspace('e1', 'acme/detached', { gitSummary: summary({ branch: null }) }),
          devspace('e2', 'acme/new', { gitSummary: undefined }),
        ],
      }),
    );
    expect(row(groups, 'acme/detached').description).toBe('Stopped');
    expect(row(groups, 'acme/detached').branch).toBeUndefined();
    expect(row(groups, 'acme/new').description).toBe('Stopped');
  });

  it('shows the change counts only while the container does not run and the files exist', () => {
    const env = devspace('e1', 'acme/api', {
      gitSummary: summary({ uncommittedFiles: 2, unpushedCommits: 3, stashes: 1 }),
    });
    const description = (overrides: Partial<TreeInput>) =>
      row(buildTreeModel(input({ devspaces: [env], ...overrides })), 'acme/api').description;
    expect(description({ runtime: runtime({ e1: { container: 'stopped', volume: true } }) })).toBe(
      'main   Stopped · 2 uncommitted · 3 unpushed · 1 stashed',
    );
    expect(description({ runtime: runtime({ e1: { container: 'missing', volume: true } }) })).toBe(
      'main   No container · 2 uncommitted · 3 unpushed · 1 stashed',
    );
    expect(description({ runtime: runtime({ e1: { container: 'running', volume: true } }) })).toBe('main   Running');
    expect(description({ runtime: runtime({ e1: { container: 'missing', volume: false } }) })).toBe('main   Files missing');
    expect(description({ busyDevspaceIds: new Set(['e1']) })).toBe('main   Updating');
  });

  it('writes the tooltip with the time of the last use', () => {
    const env = devspace('e1', 'acme/api', {
      lastUsedAt: '2026-09-24T17:10:00.000Z',
      gitSummary: summary({ branch: 'main', unpushedCommits: 3 }),
    });
    const groups = buildTreeModel(input({ discovery: discovery([repo('acme/api')]), devspaces: [env] }));
    expect(row(groups, 'acme/api').tooltip).toBe(
      ['acme/api', 'Source: the configuration .devcontainer/devcontainer.json', 'Stopped · 3 unpushed', 'Branch: main', 'Last used: T(2026-09-24T17:10:00.000Z)'].join('\n'),
    );
  });

  it('formats the time of the last use with the default formatter when none is given', () => {
    const groups = buildTreeModel({ ...input({ devspaces: [devspace('e1', 'acme/api')] }), formatTime: undefined });
    expect(row(groups, 'acme/api').tooltip).toContain(`Last used: ${new Date(T0).toLocaleString()}`);
  });

  it('leaves out an unknown time of the last use', () => {
    const groups = buildTreeModel(
      input({ devspaces: [devspace('e1', 'acme/api', { lastUsedAt: new Date(0).toISOString() })] }),
    );
    expect(row(groups, 'acme/api').tooltip).not.toContain('Last used');
  });

  it('names the configuration of the devspace itself in the tooltip, not the path that the list names for the same configuration', () => {
    // The devspace was created from `.devcontainer.json`; the list of GitHub names `.devcontainer/devcontainer.json`
    // (the same configuration, so the row is the devspace's).
    const groups = buildTreeModel(input({ discovery: discovery([repo('acme/api')]), devspaces: [devspace('e1', 'acme/api', { configPath: '.devcontainer.json' })] }));
    const entry = row(groups, 'acme/api');
    expect(entry.devspace?.id).toBe('e1');
    expect(entry.tooltip.split('\n')[1]).toBe('Source: the configuration .devcontainer.json');
  });

  it('describes a repository without devspace in its tooltip', () => {
    const groups = buildTreeModel(input({ discovery: discovery([repo('acme/api', { defaultBranch: 'trunk' })]) }));
    const entry = row(groups, 'acme/api');
    expect(entry.state).toBeUndefined();
    expect(entry.devspace).toBeUndefined();
    expect(entry.description).toBe('');
    expect(entry.tooltip).toBe(['acme/api', 'Source: the configuration .devcontainer/devcontainer.json', TreeTexts.noDevspace, 'Default branch: trunk'].join('\n'));
  });

  it('keeps tree item IDs unique if the registry holds two devspaces of one repository', () => {
    const groups = buildTreeModel(
      input({
        discovery: discovery([repo('acme/api')]),
        devspaces: [
          devspace('older', 'acme/api', { lastUsedAt: iso(T0 - 1000) }),
          devspace('newer', 'ACME/api', { lastUsedAt: iso(T0) }),
        ],
      }),
    );
    const ids = rows(groups).map((entry) => entry.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(findRowByDevspaceId(groups, 'newer')?.id).toBe('repo:acme/api');
    expect(findRowByDevspaceId(groups, 'older')?.id).toBe('repo:acme/api#older');
  });

  it('never repeats a tree item ID, also with duplicate discovery entries', () => {
    const groups = buildTreeModel(
      input({
        discovery: discovery([repo('acme/api'), repo('ACME/API'), repo('acme/web')], {
          hints: [{ organization: 'acme', kind: 'other', url: 'https://github.com/acme' }],
        }),
        devspaces: [devspace('e1', 'acme/web')],
      }),
    );
    const ids = groups.flatMap((group) => [group.id, ...group.children.map((child) => child.id)]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(rows(groups).map((entry) => entry.repository)).toEqual(['acme/api', 'acme/web']);
  });

  it('tolerates an invalid repository name in the registry', () => {
    const groups = buildTreeModel(input({ devspaces: [devspace('e1', 'broken')] }));
    expect(rows(groups)).toHaveLength(1);
    expect(rows(groups)[0]).toMatchObject({ owner: 'broken', name: 'broken', id: 'repo:broken' });
  });
});

describe('state texts and icons', () => {
  it('uses the state texts', () => {
    expect(stateText('connected')).toBe('Connected');
    expect(stateText('connectedOtherWindow')).toBe('Connected · other window');
    expect(stateText('running')).toBe('Running');
    expect(stateText('stopped')).toBe('Stopped');
    expect(stateText('updating')).toBe('Updating');
    expect(stateText('noContainer')).toBe('No container');
    expect(stateText('filesMissing')).toBe('Files missing');
  });

  it('maps every state to a monitor of the extension', () => {
    // A switched-on monitor with the connection sign in this window, a switched-on monitor in another window, the
    // silhouette of a monitor when stopped (the icon font of the extension).
    expect(stateIcon('connected')).toEqual({ id: 'devspaces-monitor-connected' });
    // Not colored; the filled screen tells that another window uses it.
    expect(stateIcon('connectedOtherWindow')).toEqual({ id: 'devspaces-monitor-on' });
    // Not a switched-on monitor, which would look like a connected window: the switched-off monitor with a play sign
    // (no window uses it), a clock, a ring, and a warning sign.
    expect(stateIcon('running')).toEqual({ id: 'devspaces-monitor-running' });
    expect(stateIcon('stopped')).toEqual({ id: 'devspaces-monitor-off' });
    expect(stateIcon('updating').id).toBe('devspaces-monitor-updating');
    // The switched-off monitor with a ring: No container.
    expect(stateIcon('noContainer').id).toBe('devspaces-monitor-no-container');
    expect(stateIcon('filesMissing')).toEqual({ id: 'devspaces-monitor-warning', color: 'list.warningForeground' });
  });

  // A Quick Pick cannot color icons, so every state needs a shape of its own there. The icons of the extension are
  // shapes (switched off, switched on, with the sign), so the icon of the state is enough.
  it('gives every state an icon of its own shape, also without color', () => {
    const states = ['connected', 'connectedOtherWindow', 'running', 'stopped', 'updating', 'noContainer', 'filesMissing'] as const;
    expect(new Set(states.map((state) => stateIcon(state).id)).size).toBe(states.length);
  });
});

describe('switcher helpers', () => {
  it('lists the devspaces most recently used first, with the state and description of their row', () => {
    const devspaces = [
      devspace('old', 'acme/web', { lastUsedAt: iso(T0 - 60_000) }),
      devspace('new', 'acme/api', { lastUsedAt: iso(T0) }),
      devspace('gone', 'lost/repo', { lastUsedAt: iso(T0 - 120_000) }),
    ];
    const groups = buildTreeModel(
      input({
        discovery: discovery([repo('acme/api'), repo('acme/web')]),
        devspaces,
        currentDevspaceId: 'new',
        liveBranches: new Map([['new', 'dev']]),
      }),
    );
    expect(recentDevspaces(groups, devspaces)).toEqual([
      { devspaceId: 'new', repository: 'acme/api', name: 'acme/api', state: 'connected', description: 'dev   Connected' },
      { devspaceId: 'old', repository: 'acme/web', name: 'acme/web', state: 'stopped', description: 'main   Stopped' },
      { devspaceId: 'gone', repository: 'lost/repo', name: 'lost/repo', state: 'stopped', description: 'main   Stopped · not on GitHub' },
    ]);
  });

  it('falls back to the registry entry when the model has no row', () => {
    const devspaces = [devspace('e1', 'acme/api')];
    expect(recentDevspaces([], devspaces)).toEqual([
      { devspaceId: 'e1', repository: 'acme/api', name: 'acme/api', state: undefined, description: '' },
    ]);
    expect(recentDevspaces([], [])).toEqual([]);
  });

  it('orders the repositories of the picker by the last push, then by name', () => {
    const ordered = repositoriesForPicker([
      repo('acme/b', { pushedAt: iso(T0 - 1000) }),
      repo('acme/none', { pushedAt: null }),
      repo('acme/a', { pushedAt: iso(T0 - 1000) }),
      repo('acme/new', { pushedAt: iso(T0) }),
    ]);
    expect(ordered.map((entry) => entry.nameWithOwner)).toEqual(['acme/new', 'acme/a', 'acme/b', 'acme/none']);
  });
});

describe('hint of an owner of the scan scope that GitHub does not return', () => {
  it('names the owner with the not-found text and opens its page', () => {
    const hints = [{ organization: 'Nobody-Here', kind: 'notFound' as const, url: 'https://github.com/Nobody-Here' }];
    const groups = buildTreeModel(
      input({
        settings: { owners: ['nobody-here', 'acme'], includeArchived: false, includeForks: true },
        discovery: discovery([repo('acme/api')], { hints }),
      }),
    );
    const group = groups.find((candidate) => candidate.owner === 'Nobody-Here');
    expect(group?.children).toEqual([
      {
        kind: 'hint',
        id: 'hint:nobody-here',
        organization: 'Nobody-Here',
        notFound: true,
        label: 'The organization Nobody-Here was not found or is not accessible.',
        url: 'https://github.com/Nobody-Here',
      },
    ]);
  });
});

describe('setting showOnlyDevspaces', () => {
  const settings = { owners: [], includeArchived: false, includeForks: true, showOnlyDevspaces: true };
  const hints = [{ organization: 'Nobody-Here', kind: 'notFound' as const, url: 'https://github.com/Nobody-Here' }];

  it('lists only the repositories with a devspace, in every state, without the hints', () => {
    const groups = buildTreeModel(
      input({
        settings,
        discovery: discovery([repo('acme/api'), repo('acme/web'), repo('other/site'), repo('acme/docs')], { hints }),
        devspaces: [devspace('d1', 'acme/web'), devspace('d2', 'acme/docs')],
        runtime: runtime({ d1: { container: 'running', volume: true }, d2: { container: 'stopped', volume: true } }),
      }),
    );
    expect(groups.map((group) => group.owner)).toEqual(['acme']);
    expect(rows(groups).map((entry) => [entry.repository, entry.state])).toEqual([
      ['acme/docs', 'stopped'],
      ['acme/web', 'running'],
    ]);
  });

  it('is empty without a devspace; off lists every repository again', () => {
    const base = { discovery: discovery([repo('acme/api')], { hints }) };
    expect(buildTreeModel(input({ ...base, settings }))).toEqual([]);
    expect(rows(buildTreeModel(input({ ...base, settings: { ...settings, showOnlyDevspaces: false } }))).map((entry) => entry.repository)).toEqual([
      'acme/api',
    ]);
  });

  it('keeps the groups of the setting repositoryGroups for the devspaces', () => {
    const groups = buildTreeModel(
      input({
        settings,
        discovery: discovery([repo('acme/2026-web-a'), repo('acme/2026-web-b')]),
        devspaces: [devspace('d1', 'acme/2026-web-b')],
        repositoryGroups: parseRepositoryGroups(['^(2026)-(.+)$']).patterns,
      }),
    );
    expect(rows(groups).map((entry) => entry.repository)).toEqual(['acme/2026-web-b']);
    expect(groups[0].children[0]).toMatchObject({ kind: 'group', label: '2026' });
  });
});

describe('the switch of the host access checks in the rows', () => {
  const settings = (hostAccessChecksOff: string[]) => ({ owners: [], includeArchived: false, includeForks: true, hostAccessChecksOff });

  it('marks a repository whose checks are off, with a warning in the tooltip, and offers Turn On', () => {
    const groups = buildTreeModel(
      input({
        discovery: discovery([repo('acme/api'), repo('acme/web'), repo('acme/docs')]),
        devspaces: [devspace('e1', 'acme/api', { gitSummary: summary({ uncommittedFiles: 2 }) })],
        runtime: new Map<string, DevspaceRuntime>([['e1', { container: 'stopped', volume: true }]]),
        settings: settings([' ACME/API ', 'acme/web']),
      }),
    );
    const api = findRowByRepository(groups, 'acme/api');
    expect(api?.hostAccessChecks).toBe('off');
    expect(api?.description).toBe(`main   Stopped · 2 uncommitted · ${StateTexts.hostAccessUnrestricted}`);
    expect(api?.tooltip.split('\n')).toContain(Messages.hostAccessUnrestrictedTooltip);
    expect(api?.contextValue.split(';')).toContain('hostAccessUnrestricted');
    expect(api?.contextValue.split(';')).not.toContain('hostAccessChecked');
    // A repository without devspace.
    const web = findRowByRepository(groups, 'acme/web');
    expect(web?.description).toBe(StateTexts.hostAccessUnrestricted);
    expect(web?.tooltip.split('\n')).toContain(Messages.hostAccessUnrestrictedTooltip);
    expect(web?.contextValue).toBe('repository;canStart;onGitHub;hostAccessUnrestricted');
    // The checks of other repositories stay on: no marker, and Turn Off.
    const docs = findRowByRepository(groups, 'acme/docs');
    expect(docs?.hostAccessChecks).toBe('on');
    expect(docs?.description).toBe('');
    expect(docs?.tooltip).not.toContain(Messages.hostAccessUnrestrictedTooltip);
    expect(docs?.contextValue).toBe('repository;canStart;onGitHub;hostAccessChecked');
  });

  // The row shows the switch as the pipeline applies it, under the registry name only (either name could show the
  // checks off while the pipeline has them on).
  it('marks a renamed or transferred repository by its registry name, the name the pipeline reads', () => {
    // The registry keeps alice/tool (the name the open pipeline reads the switch under); GitHub answers bob/tool.
    const moved = repo('bob/tool', { configPaths: [] });
    const build = (listed: string) =>
      buildTreeModel(
        input({
          discovery: discovery([repo('acme/api')]),
          devspaces: [devspace('e1', 'alice/tool')],
          repositoryLookups: new Map([['alice/tool', moved]]),
          settings: settings([listed]),
        }),
      );
    const off = row(build('alice/tool'), 'bob/tool');
    expect(off.hostAccessChecks).toBe('off');
    expect(off.description).toBe(`main   Stopped · ${StateTexts.hostAccessUnrestricted}`);
    expect(off.tooltip.split('\n')).toContain(Messages.hostAccessUnrestrictedTooltip);
    expect(flags(off.contextValue)).toContain('hostAccessUnrestricted');
    expect(flags(off.contextValue)).not.toContain('hostAccessChecked');

    const on = row(build('bob/tool'), 'bob/tool');
    expect(on.hostAccessChecks).toBe('on');
    expect(on.description).not.toContain(StateTexts.hostAccessUnrestricted);
    expect(flags(on.contextValue)).toContain('hostAccessChecked');
  });

  it('adds no flag of the switch to contextValue without it', () => {
    const actions = rowActions('stopped', repo('acme/api'));
    expect(contextValue(actions)).toBe('repository;canStart;canDelete;canRebuild;onGitHub');
    expect(contextValue(actions, 'on')).toBe('repository;canStart;canDelete;canRebuild;onGitHub;hostAccessChecked');
    expect(contextValue(actions, 'off')).toBe('repository;canStart;canDelete;canRebuild;onGitHub;hostAccessUnrestricted');
    // The when clauses of package.json tell the two flags apart.
    expect(/hostAccessChecked/.test('hostAccessUnrestricted')).toBe(false);
    expect(/hostAccessUnrestricted/.test('hostAccessChecked')).toBe(false);
  });
});

describe('setting repositoryGroups', () => {
  const EXAMPLE = String.raw`^(\d{4}-[^-]+-[^-]+)-([^-]+-[^-]+)-(.+)$`;
  const patterns = (...entries: unknown[]) => parseRepositoryGroups(entries).patterns;

  type Shape = string | [string, Shape[]];
  /** The tree as labels: a row is its label, a node is [label, children]; hints are `hint:<organization>`. */
  function shape(children: ReadonlyArray<OwnerGroup['children'][number]>): Shape[] {
    return children.map((child) => {
      if (child.kind === 'group') return [child.label, shape(child.children)];
      if (child.kind === 'hint') return `hint:${child.organization}`;
      if (child.kind === 'repositoryNode') return [child.label, child.children.map((row) => row.label)];
      return child.label;
    });
  }
  function tree(groups: OwnerGroup[]): Shape[] {
    return groups.map((group) => [group.owner, shape(group.children)]);
  }
  function allNodes(groups: OwnerGroup[]): Array<{ id: string; kind: string }> {
    const nodes: Array<{ id: string; kind: string }> = [];
    const walk = (children: ReadonlyArray<OwnerGroup['children'][number]>) => {
      for (const child of children) {
        nodes.push(child);
        if (child.kind === 'group') walk(child.children);
      }
    };
    for (const group of groups) {
      nodes.push(group);
      walk(group.children);
    }
    return nodes;
  }
  function node(groups: OwnerGroup[], id: string): GroupNode {
    const found = allNodes(groups).find((candidate) => candidate.id === id);
    if (!found || found.kind !== 'group') throw new Error(`No group node ${id}`);
    return found as GroupNode;
  }

  const STUDENTS = [
    repo('school/2026-3cWI-SWP-module-oop-student-b-021'),
    repo('school/2025-3bWI-SWP-module-oop-student-c'),
    repo('school/2026-3cWI-SWP-module-oop-Student-A81'),
  ];

  it('a repository with several sources is a node with its child rows inside its group, labelled like its row', () => {
    const python = '.devcontainer/python/devcontainer.json';
    const groups = buildTreeModel(
      input({
        discovery: discovery([repo('school/2026-3cWI-SWP-module-oop-student-c', { configPaths: ['.devcontainer/devcontainer.json', python] }), repo('school/2026-3cWI-SWP-module-oop-student-b')]),
        devspaces: [devspace('e1', 'school/2026-3cWI-SWP-module-oop-student-c', { configPath: python })],
        repositoryGroups: patterns(EXAMPLE),
      }),
    );
    expect(tree(groups)).toEqual([['school', [['2026-3cWI-SWP', [['module-oop', ['student-b', ['student-c', ['config', 'python']]]]]]]]]);
    const rowsOfNode = rows(groups).filter((row) => row.repository === 'school/2026-3cWI-SWP-module-oop-student-c');
    expect(rowsOfNode.map((row) => [row.id, row.child, row.devspace?.id])).toEqual([
      ['repo:school/2026-3cwi-swp-module-oop-student-c:config', true, undefined],
      ['repo:school/2026-3cwi-swp-module-oop-student-c:config:python', true, 'e1'],
    ]);
    expect(findRowByDevspaceId(groups, 'e1')?.id).toBe('repo:school/2026-3cwi-swp-module-oop-student-c:config:python');
  });

  it('shows the example of the user: the first group is the top level under the owner, the last group labels the row', () => {
    const groups = buildTreeModel(input({ discovery: discovery(STUDENTS), repositoryGroups: patterns(EXAMPLE) }));
    expect(tree(groups)).toEqual([
      [
        'school',
        [
          ['2025-3bWI-SWP', [['module-oop', ['student-c']]]],
          ['2026-3cWI-SWP', [['module-oop', ['Student-A81', 'student-b-021']]]],
        ],
      ],
    ]);
    expect(row(groups, 'school/2026-3cWI-SWP-module-oop-Student-A81').label).toBe('Student-A81');
    expect(node(groups, 'group:school:-:2026-3cWI-SWP')).toMatchObject({ level: 1, owner: 'school', expanded: false });
    expect(node(groups, 'group:school:-:2026-3cWI-SWP/module-oop')).toMatchObject({ level: 2, label: 'module-oop' });
  });

  it('gives an entry with a name its own root node, expanded, with the pattern as tooltip', () => {
    const groups = buildTreeModel(
      input({ discovery: discovery(STUDENTS), repositoryGroups: patterns({ name: 'Courses', pattern: EXAMPLE }) }),
    );
    expect(tree(groups)).toEqual([
      [
        'school',
        [
          [
            'Courses',
            [
              ['2025-3bWI-SWP', [['module-oop', ['student-c']]]],
              ['2026-3cWI-SWP', [['module-oop', ['Student-A81', 'student-b-021']]]],
            ],
          ],
        ],
      ],
    ]);
    expect(node(groups, 'group:school:0:')).toMatchObject({ level: 0, label: 'Courses', tooltip: EXAMPLE, expanded: true });
    expect(node(groups, 'group:school:0:2025-3bWI-SWP/module-oop').children).toHaveLength(1);
  });

  it('keeps the row fields except the label, with owner/name in the tooltip', () => {
    const plain = buildTreeModel(input({ discovery: discovery(STUDENTS), devspaces: [devspace('e1', STUDENTS[0].nameWithOwner)] }));
    const grouped = buildTreeModel(
      input({
        discovery: discovery(STUDENTS),
        devspaces: [devspace('e1', STUDENTS[0].nameWithOwner)],
        repositoryGroups: patterns(EXAMPLE),
      }),
    );
    for (const before of rows(plain)) {
      const after = row(grouped, before.repository);
      expect({ ...after, label: before.label }).toEqual(before);
      expect(after.tooltip.split('\n')[0]).toBe(before.repository);
    }
    expect(row(grouped, STUDENTS[0].nameWithOwner)).toMatchObject({
      id: 'repo:school/2026-3cwi-swp-module-oop-student-b-021',
      label: 'student-b-021',
      state: 'stopped',
    });
  });

  it('merges equal label paths of unnamed patterns into one node; a repository goes under the first matching pattern', () => {
    const groups = buildTreeModel(
      input({
        discovery: discovery([repo('o/web-shop'), repo('o/web-blog'), repo('o/api-core'), repo('o/lib-x')]),
        repositoryGroups: patterns('^(web)-(shop)$', '^(web|api)-(.+)$', { name: 'Libraries', pattern: '^lib-(.+)$' }, '^(web)-(.+)$'),
      }),
    );
    // The nodes follow the order of the patterns in the setting. The merged node web counts from its first pattern (0),
    // and in it shop (pattern 0) comes before blog (pattern 1).
    expect(tree(groups)).toEqual([['o', [['web', ['shop', 'blog']], ['api', ['core']], ['Libraries', ['x']]]]]);
    expect(allNodes(groups).filter((entry) => entry.id === 'group:o:-:web')).toHaveLength(1);
  });

  it('does not merge a named root with the nodes of other patterns', () => {
    const groups = buildTreeModel(
      input({
        discovery: discovery([repo('o/web-shop'), repo('o/web-blog')]),
        repositoryGroups: patterns({ name: 'Shop', pattern: '^(web)-(shop)$' }, '^(web)-(.+)$'),
      }),
    );
    expect(tree(groups)).toEqual([['o', [['Shop', [['web', ['shop']]]], ['web', ['blog']]]]]);
    expect(node(groups, 'group:o:0:web').label).toBe('web');
    expect(node(groups, 'group:o:-:web').label).toBe('web');
  });

  it('filters: hides repositories without devspace that match no pattern in an owner with a match', () => {
    const groups = buildTreeModel(
      input({
        discovery: discovery([repo('a/web-shop'), repo('a/other'), repo('b/other')]),
        repositoryGroups: patterns('^(web)-(.+)$'),
      }),
    );
    // b has no match: its list is the plain list of today.
    expect(tree(groups)).toEqual([
      ['a', [['web', ['shop']]]],
      ['b', ['other']],
    ]);
  });

  describe('patterns apply per owner group', () => {
    const hint = (organization: string) => ({ organization, kind: 'saml' as const, url: `https://github.com/orgs/${organization}/sso` });

    it('groups an organization with a match and hides its repositories that match no pattern', () => {
      const groups = buildTreeModel(
        input({
          discovery: discovery([repo('a/web-x'), repo('a/other'), repo('a/more')], { hints: [hint('a')] }),
          repositoryGroups: patterns('^(web)-(.+)$'),
        }),
      );
      expect(tree(groups)).toEqual([['a', ['hint:a', ['web', ['x']]]]]);
    });

    it('keeps the plain list of today, with its hints, for an organization without any match', () => {
      const repositories = [repo('b/zeta'), repo('b/Alpha'), repo('b/other')];
      const devspaces = [devspace('e1', 'b/zeta'), devspace('e2', 'b/gone')];
      const today = buildTreeModel(input({ discovery: discovery(repositories, { hints: [hint('b')] }), devspaces }));
      const grouped = buildTreeModel(
        input({ discovery: discovery(repositories, { hints: [hint('b')] }), devspaces, repositoryGroups: patterns('^web-') }),
      );
      expect(grouped).toEqual(today);
      expect(tree(grouped)).toEqual([['b', ['hint:b', 'Alpha', 'gone', 'other', 'zeta']]]);
    });

    it('never hides an organization because of the patterns, also one with only a hint', () => {
      const data = discovery([repo('a/web-x')], { hints: [hint('c')] });
      const groups = buildTreeModel(input({ discovery: data, repositoryGroups: patterns('^(web)-(.+)$') }));
      expect(tree(groups)).toEqual([
        ['a', [['web', ['x']]]],
        ['c', ['hint:c']],
      ]);
    });

    it('treats each organization on its own in a setting with several patterns', () => {
      const groups = buildTreeModel(
        input({
          discovery: discovery([
            repo('a/web-shop'),
            repo('a/lib-core'),
            repo('a/misc'),
            repo('b/lib-util'),
            repo('b/tools'),
            repo('c/misc'),
            repo('c/tools'),
          ]),
          devspaces: [devspace('e1', 'a/misc'), devspace('e2', 'c/tools')],
          repositoryGroups: patterns('^(web)-(.+)$', { name: 'Libraries', pattern: '^lib-(.+)$' }),
        }),
      );
      expect(tree(groups)).toEqual([
        // In the order of the patterns, rows that match no pattern last.
        ['a', [['web', ['shop']], ['Libraries', ['core']], 'misc']],
        ['b', [['Libraries', ['util']]]],
        ['c', ['misc', 'tools']],
      ]);
      expect(row(groups, 'a/misc').devspace?.id).toBe('e1');
      expect(findRowByRepository(groups, 'b/tools')).toBeUndefined();
    });

    it('groups an organization whose only match is a repository with a devspace', () => {
      const groups = buildTreeModel(
        input({
          discovery: discovery([repo('a/other')]),
          devspaces: [devspace('e1', 'a/web-x')],
          repositoryGroups: patterns('^(web)-(.+)$'),
        }),
      );
      expect(tree(groups)).toEqual([['a', [['web', ['x']]]]]);
    });
  });

  it('lists repositories with a devspace that match no pattern directly under the owner, after the nodes', () => {
    const groups = buildTreeModel(
      input({
        discovery: discovery([repo('a/web-shop'), repo('a/zeta'), repo('a/Beta'), repo('a/other')]),
        devspaces: [devspace('e1', 'a/zeta'), devspace('e2', 'a/Beta'), devspace('e3', 'a/gone')],
        repositoryGroups: patterns({ name: 'Named', pattern: '^web-shop$' }, '^(web)-(.+)$'),
      }),
    );
    expect(tree(groups)).toEqual([['a', [['Named', ['web-shop']], 'Beta', 'gone', 'zeta']]]);
    expect(row(groups, 'a/gone').notOnGitHub).toBe(true);
  });

  it('puts hints first, then the nodes and rows in the order of their patterns, then the rows that match no pattern', () => {
    const hints = [{ organization: 'a', kind: 'saml' as const, url: 'https://github.com/orgs/a/sso' }];
    const groups = buildTreeModel(
      input({
        discovery: discovery([repo('a/z-1'), repo('a/y-1'), repo('a/b-1'), repo('a/a-1'), repo('a/solo'), repo('a/keep')], { hints }),
        devspaces: [devspace('e1', 'a/keep')],
        repositoryGroups: patterns({ name: 'Zulu', pattern: '^z-' }, { name: 'Alpha', pattern: '^y-' }, '^(\\w)-(\\d)$', '^solo$'),
      }),
    );
    // The order of the patterns in the setting; within one pattern nodes first, then by name.
    expect(tree(groups)).toEqual([
      ['a', ['hint:a', ['Zulu', ['z-1']], ['Alpha', ['y-1']], ['a', ['1']], ['b', ['1']], 'solo', 'keep']],
    ]);
  });

  it('orders the nodes by the order of the patterns in the setting (templates and student repositories)', () => {
    const groups = buildTreeModel(
      input({
        discovery: discovery([
          repo('o/2026-3cWI-SWP-module-oop-Student-A81'),
          repo('o/2026-3cWI-SWP-module-oop'),
          repo('o/2026-3cWI-SWP-module-oop-student-b'),
          repo('o/2026-3cWI-SWP-module-io'),
        ]),
        repositoryGroups: patterns('^(\\d{4}-[^-]+-[^-]+)-([^-]+-[^-]+)$', '^(\\d{4}-[^-]+-[^-]+)-([^-]+-[^-]+)-(.+)$'),
      }),
    );
    // Pattern 1 (the templates) before pattern 2 (the student repositories), also where the labels are equal.
    expect(tree(groups)).toEqual([
      ['o', [['2026-3cWI-SWP', ['module-io', 'module-oop', ['module-oop', ['Student-A81', 'student-b']]]]]],
    ]);
  });

  it('shows a named root only in the owner groups where a repository matches it', () => {
    const groups = buildTreeModel(
      input({
        discovery: discovery([repo('a/lib-x'), repo('b/web-y')]),
        repositoryGroups: patterns({ name: 'Libraries', pattern: '^lib-(.+)$' }, { name: 'Web', pattern: '^web-(.+)$' }),
      }),
    );
    expect(tree(groups)).toEqual([
      ['a', [['Libraries', ['x']]]],
      ['b', [['Web', ['y']]]],
    ]);
    expect(node(groups, 'group:a:0:').id).not.toBe(node(groups, 'group:b:1:').id);
  });

  it('sorts at each level: nodes first in natural, case-insensitive order, then rows by label and repository', () => {
    const groups = buildTreeModel(
      input({
        discovery: discovery([
          repo('o/c10-b'),
          repo('o/zz'),
          repo('o/c2-b'),
          repo('o/C1-a'),
          repo('o/c2-A'),
          repo('o/c2'),
          repo('o/aa'),
          repo('p/c2-a'),
        ]),
        repositoryGroups: patterns({ pattern: '^(c\\d+)(?:-(\\w))?$', flags: 'i' }, '^(?:aa|zz)$'),
      }),
    );
    // o/c2: the last group did not take part, so the row keeps its name under the node of its first group.
    expect(tree(groups)).toEqual([
      ['o', [['C1', ['a']], ['c2', ['A', 'b', 'c2']], ['c10', ['b']], 'aa', 'zz']],
      ['p', [['c2', ['a']]]],
    ]);
  });

  it('breaks ties between rows with the same label by the repository name', () => {
    const groups = buildTreeModel(
      input({
        discovery: discovery([repo('o/y-x-same'), repo('o/a-x-same')]),
        repositoryGroups: patterns('^\\w-(x)-(same)$'),
      }),
    );
    expect(rows(groups).map((entry) => entry.repository)).toEqual(['o/a-x-same', 'o/y-x-same']);
  });

  it('skips a level that did not take part or is empty (the row moves up one level)', () => {
    const groups = buildTreeModel(
      input({
        discovery: discovery([repo('o/2026-x-a'), repo('o/x-b')]),
        repositoryGroups: patterns('^(?:(\\d{4})-)?(\\w+)-(\\w+)$'),
      }),
    );
    expect(tree(groups)).toEqual([['o', [['2026', [['x', ['a']]]], ['x', ['b']]]]]);
  });

  it('uses unique, stable IDs with URI-encoded level values', () => {
    const groups = buildTreeModel(
      input({
        discovery: discovery([repo('Org/a b-x'), repo('Org/a%b-y'), repo('org2/a b-x')]),
        repositoryGroups: patterns('^(.+)-(.+)$'),
      }),
    );
    const ids = allNodes(groups).map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining(['owner:org', 'group:org:-:a%20b', 'group:org:-:a%25b', 'group:org2:-:a%20b', 'repo:org/a b-x']),
    );
    // The same input gives the same IDs.
    const again = buildTreeModel(
      input({
        discovery: discovery([repo('Org/a b-x'), repo('Org/a%b-y'), repo('org2/a b-x')]),
        repositoryGroups: patterns('^(.+)-(.+)$'),
      }),
    );
    expect(allNodes(again).map((entry) => entry.id)).toEqual(ids);
  });

  it('expands the nodes that hold the row of the devspace of this window, and collapses the others', () => {
    const groups = buildTreeModel(
      input({
        discovery: discovery(STUDENTS),
        devspaces: [devspace('e1', STUDENTS[1].nameWithOwner), devspace('e2', STUDENTS[0].nameWithOwner)],
        currentDevspaceId: 'e1',
        repositoryGroups: patterns({ name: 'Courses', pattern: EXAMPLE }),
      }),
    );
    expect(node(groups, 'group:school:0:').expanded).toBe(true);
    expect(node(groups, 'group:school:0:2025-3bWI-SWP').expanded).toBe(true);
    expect(node(groups, 'group:school:0:2025-3bWI-SWP/module-oop').expanded).toBe(true);
    expect(node(groups, 'group:school:0:2026-3cWI-SWP').expanded).toBe(false);
    expect(node(groups, 'group:school:0:2026-3cWI-SWP/module-oop').expanded).toBe(false);
  });

  it('applies the owners, archived, and forks filters first', () => {
    const groups = buildTreeModel(
      input({
        settings: { owners: ['a'], includeArchived: false, includeForks: false },
        discovery: discovery([
          repo('a/web-shop'),
          repo('a/web-old', { isArchived: true }),
          repo('a/web-fork', { isFork: true }),
          repo('b/web-x'),
        ]),
        repositoryGroups: patterns('^(web)-(.+)$'),
      }),
    );
    expect(tree(groups)).toEqual([['a', [['web', ['shop']]]]]);
  });

  it('finds the nested rows: repositoryRows, findRowByRepository, findRowByDevspaceId, recentDevspaces', () => {
    const devspaces = [
      devspace('e1', STUDENTS[1].nameWithOwner, { lastUsedAt: iso(T0 + 1000) }),
      devspace('e2', 'other/kept'),
    ];
    const groups = buildTreeModel(
      input({ discovery: discovery(STUDENTS), devspaces, repositoryGroups: patterns({ name: 'C', pattern: EXAMPLE }) }),
    );
    // Owner groups in alphabetical order (other, school), then the rows in display order.
    expect(rows(groups).map((entry) => entry.label)).toEqual(['kept', 'student-c', 'Student-A81', 'student-b-021']);
    expect(findRowByDevspaceId(groups, 'e1')?.label).toBe('student-c');
    expect(findRowByRepository(groups, STUDENTS[0].nameWithOwner.toUpperCase())?.label).toBe('student-b-021');
    expect(findRowByRepository(groups, 'school/none')).toBeUndefined();
    expect(recentDevspaces(groups, devspaces).map((entry) => [entry.devspaceId, entry.repository, entry.state])).toEqual([
      ['e1', STUDENTS[1].nameWithOwner, 'stopped'],
      ['e2', 'other/kept', 'stopped'],
    ]);
  });

  it('builds the same model as today with an empty setting, a missing one, or only invalid entries', () => {
    const base = input({
      discovery: discovery(STUDENTS, { hints: [{ organization: 'school', kind: 'saml', url: 'https://github.com/orgs/school/sso' }] }),
      devspaces: [devspace('e1', STUDENTS[0].nameWithOwner), devspace('e2', 'x/y')],
    });
    const today = JSON.stringify(buildTreeModel(base));
    expect(JSON.stringify(buildTreeModel({ ...base, repositoryGroups: [] }))).toBe(today);
    expect(JSON.stringify(buildTreeModel({ ...base, repositoryGroups: patterns('(', 3, { name: 'x' }) }))).toBe(today);
  });

  it('handles thousands of repositories', () => {
    const many = Array.from({ length: 5000 }, (_, i) => repo(`o/${2020 + (i % 7)}-c${i % 13}-SWP-module-m${i % 5}-student${i}`));
    const started = Date.now();
    const groups = buildTreeModel(input({ discovery: discovery(many), repositoryGroups: patterns(EXAMPLE) }));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(rows(groups)).toHaveLength(5000);
    expect(groups[0].children).toHaveLength(7 * 13);
  });
});

// Keep Running When Closed per devspace. A kept, running devspace shows "Running · kept"; the icon stays the one
// of the state (a tree item has one icon only).
describe('Keep Running When Closed in the sidebar', () => {
  it('adds " · kept" to the state text while the container runs', () => {
    expect(rowStateText('running', true)).toBe('Running · kept');
    expect(rowStateText('connected', true)).toBe('Connected · kept');
    expect(rowStateText('connectedOtherWindow', true)).toBe('Connected · other window · kept');
    // Also "Stopped · kept" (below), and in every state, as the menu offers Stop When Closed in every state (below).
    for (const state of ['updating', 'noContainer', 'filesMissing'] as DevspaceState[]) {
      expect(rowStateText(state, true)).toBe(`${stateText(state)} · kept`);
    }
    for (const state of ['running', 'connected', 'connectedOtherWindow', 'stopped', 'updating', 'noContainer', 'filesMissing'] as DevspaceState[]) {
      expect(rowStateText(state, false)).toBe(stateText(state));
    }
  });

  // The row shows `kept` also while the devspace is stopped; the state text says so, clearer than the tooltip alone.
  it('shows "Stopped · kept" for a stopped kept devspace, with the grey stopped icon', () => {
    expect(rowStateText('stopped', true)).toBe('Stopped · kept');
    const groups = buildTreeModel(
      input({
        discovery: discovery([repo('acme/api'), repo('acme/web')]),
        devspaces: [devspace('e1', 'acme/api', { keepRunning: true }), devspace('e2', 'acme/web')],
        runtime: new Map<string, DevspaceRuntime>([
          ['e1', { container: 'stopped', volume: true }],
          ['e2', { container: 'stopped', volume: true }],
        ]),
      }),
    );
    const api = row(groups, 'acme/api');
    expect(api.state).toBe('stopped');
    expect(api.description).toBe('main   Stopped · kept');
    expect(api.tooltip.split('\n')).toEqual(expect.arrayContaining(['Stopped · kept', TreeTexts.kept]));
    expect(stateIcon(api.state!)).toEqual(stateIcon('stopped'));
    expect(row(groups, 'acme/web').description).toBe('main   Stopped');
  });

  it('shows "Running · kept", keeps the running icon, and offers Stop When Closed instead of Keep Running When Closed', () => {
    const groups = buildTreeModel(
      input({
        discovery: discovery([repo('acme/api'), repo('acme/web')]),
        devspaces: [devspace('e1', 'acme/api', { keepRunning: true }), devspace('e2', 'acme/web')],
        runtime: new Map<string, DevspaceRuntime>([
          ['e1', { container: 'running', volume: true }],
          ['e2', { container: 'running', volume: true }],
        ]),
      }),
    );
    const api = row(groups, 'acme/api');
    expect(api.state).toBe('running');
    expect(api.description).toBe('main   Running · kept');
    expect(api.tooltip.split('\n')).toEqual(expect.arrayContaining(['Running · kept', TreeTexts.kept]));
    // The running monitor.
    expect(stateIcon(api.state!)).toEqual({ id: 'devspaces-monitor-running' });
    expect(flags(api.contextValue)).toContain('kept');
    expect(flags(api.contextValue)).not.toContain('canKeepRunning');

    const web = row(groups, 'acme/web');
    expect(web.description).toBe('main   Running');
    expect(web.tooltip).not.toContain(TreeTexts.kept);
    expect(flags(web.contextValue)).toContain('canKeepRunning');
    expect(flags(web.contextValue)).not.toContain('kept');
  });

  it('shows "Connected · kept" in this window, and a stopped kept devspace as "Stopped · kept" with the tooltip line', () => {
    const groups = buildTreeModel(
      input({
        discovery: discovery([repo('acme/api'), repo('acme/web')]),
        devspaces: [devspace('e1', 'acme/api', { keepRunning: true }), devspace('e2', 'acme/web', { keepRunning: true })],
        runtime: new Map<string, DevspaceRuntime>([
          ['e1', { container: 'running', volume: true }],
          ['e2', { container: 'stopped', volume: true }],
        ]),
        currentDevspaceId: 'e1',
      }),
    );
    expect(row(groups, 'acme/api').description).toBe('main   Connected · kept');
    const web = row(groups, 'acme/web');
    // Stop keeps the flag: the row offers Stop When Closed. The state text shows it too ("Stopped · kept"), not only
    // the tooltip.
    expect(web.description).toBe('main   Stopped · kept');
    expect(web.tooltip.split('\n')).toContain(TreeTexts.kept);
    expect(flags(web.contextValue)).toContain('kept');
  });

  // The row text matches the menu, which offers Stop When Closed for a kept devspace in every state, also without a
  // container and while it is updating.
  it('shows " · kept" also without a container and while updating, as the menu offers Stop When Closed there', () => {
    const groups = buildTreeModel(
      input({
        discovery: discovery([repo('acme/api'), repo('acme/web'), repo('acme/lib')]),
        devspaces: [
          devspace('e1', 'acme/api', { keepRunning: true }),
          devspace('e2', 'acme/web', { keepRunning: true }),
          devspace('e3', 'acme/lib'),
        ],
        runtime: new Map<string, DevspaceRuntime>([
          ['e1', { container: 'missing', volume: true }],
          ['e2', { container: 'running', volume: true }],
          ['e3', { container: 'missing', volume: true }],
        ]),
        busyDevspaceIds: new Set(['e2']),
      }),
    );
    const api = row(groups, 'acme/api');
    expect(api.state).toBe('noContainer');
    expect(api.description).toContain('No container · kept');
    expect(api.tooltip.split('\n')).toEqual(expect.arrayContaining([expect.stringMatching(/^No container · kept/), TreeTexts.kept]));
    expect(flags(api.contextValue)).toContain('kept');
    const web = row(groups, 'acme/web');
    expect(web.state).toBe('updating');
    expect(web.description).toContain('Updating · kept');
    expect(flags(web.contextValue)).toContain('kept');
    const lib = row(groups, 'acme/lib');
    expect(lib.description).not.toContain('kept');
    expect(flags(lib.contextValue)).toContain('canKeepRunning');
  });

  it('adds the flag only for a row with a devspace', () => {
    const actions = rowActions('running', repo('acme/api'));
    expect(contextValue(actions, 'on', true)).toBe('repository;canStart;canStop;canDelete;canRebuild;onGitHub;hostAccessChecked;kept');
    expect(contextValue(actions, 'on', false)).toBe('repository;canStart;canStop;canDelete;canRebuild;onGitHub;hostAccessChecked;canKeepRunning');
    expect(contextValue(rowActions(undefined, repo('acme/api')), 'on')).toBe('repository;canStart;onGitHub;hostAccessChecked');
    // The when clauses of package.json tell the two flags apart.
    expect(/;kept(;|$)/.test('repository;canKeepRunning')).toBe(false);
    expect(/;canKeepRunning(;|$)/.test('repository;kept')).toBe(false);
  });

  // Close and Keep Running.
  it('shows a devspace closed with Close and Keep Running as kept, and keeps the menu of Keep Running When Closed', () => {
    const groups = buildTreeModel(
      input({
        discovery: discovery([repo('acme/api')]),
        devspaces: [devspace('e1', 'acme/api', { keepRunningOnce: true })],
        runtime: new Map<string, DevspaceRuntime>([['e1', { container: 'running', volume: true }]]),
      }),
    );
    const api = row(groups, 'acme/api');
    expect(api.description).toContain('Running · kept');
    expect(api.tooltip.split('\n')).toContain(TreeTexts.keptOnce);
    expect(api.tooltip.split('\n')).not.toContain(TreeTexts.kept);
    expect(flags(api.contextValue)).toContain('canKeepRunning');
    expect(flags(api.contextValue)).not.toContain('canCloseAndKeepRunning');
  });

  // The keeps of the settings show in the row as the heartbeats send them (keptWhenClosed), with their reason.
  describe('a devspace that a setting keeps running when closed', () => {
    const settings = { owners: [], includeArchived: false, includeForks: true };
    const model = (overrides: Partial<TreeInput['settings']>, extra: Partial<Devspace> = {}) =>
      row(
        buildTreeModel(
          input({
            discovery: discovery([repo('acme/api')]),
            settings: { ...settings, ...overrides },
            devspaces: [devspace('e1', 'acme/api', extra)],
            runtime: new Map<string, DevspaceRuntime>([['e1', { container: 'running', volume: true }]]),
            currentDevspaceId: 'e1',
          }),
        ),
        'acme/api',
      );

    it('shows it as kept when stopOnClose is off, names the setting, and offers no keep action', () => {
      const api = model({ stopOnClose: false });
      expect(api.description).toContain('Connected · kept');
      expect(api.tooltip.split('\n')).toContain(TreeTexts.keptByStopOnClose);
      expect(api.tooltip.split('\n')).not.toContain(TreeTexts.kept);
      for (const flag of ['canKeepRunning', 'kept', 'canCloseAndKeepRunning']) expect(flags(api.contextValue)).not.toContain(flag);
      // Without the setting, the connected row offers both again.
      const plain = model({ stopOnClose: true });
      expect(flags(plain.contextValue)).toContain('canKeepRunning');
      expect(flags(plain.contextValue)).toContain('canCloseAndKeepRunning');
    });

    it('shows it as kept for "shutdownAction": "none" only while respectShutdownActionNone is on', () => {
      const kept = model({ respectShutdownActionNone: true }, { shutdownActionNone: true });
      expect(kept.description).toContain('Connected · kept');
      expect(kept.tooltip.split('\n')).toContain(TreeTexts.keptByShutdownAction);
      expect(flags(kept.contextValue)).not.toContain('canCloseAndKeepRunning');
      for (const api of [model({ respectShutdownActionNone: false }, { shutdownActionNone: true }), model({ respectShutdownActionNone: true }), model({ stopOnClose: true })]) {
        expect(api.description).not.toContain('kept');
        expect(api.tooltip).not.toContain('Keeps running');
      }
    });

    it('names only the switch of the row when the row keeps it too', () => {
      const api = model({ stopOnClose: false }, { keepRunning: true });
      expect(api.tooltip.split('\n')).toContain(TreeTexts.kept);
      expect(api.tooltip.split('\n')).not.toContain(TreeTexts.keptByStopOnClose);
      expect(flags(api.contextValue)).toContain('kept');
    });
  });

  it('offers Close and Keep Running only in the row of the devspace of this window', () => {
    const groups = buildTreeModel(
      input({
        discovery: discovery([repo('acme/api'), repo('acme/web')]),
        devspaces: [devspace('e1', 'acme/api'), devspace('e2', 'acme/web')],
        runtime: new Map<string, DevspaceRuntime>([
          ['e1', { container: 'running', volume: true }],
          ['e2', { container: 'running', volume: true }],
        ]),
        currentDevspaceId: 'e1',
        otherWindowDevspaceIds: new Set(['e2']),
      }),
    );
    expect(flags(row(groups, 'acme/api').contextValue)).toContain('canCloseAndKeepRunning');
    expect(flags(row(groups, 'acme/web').contextValue)).not.toContain('canCloseAndKeepRunning');
    expect(contextValue(rowActions('connected', repo('acme/api')), 'on', false, true).split(';').at(-1)).toBe('canCloseAndKeepRunning');
  });
});
