// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The rows of the devspaces on an engine whose states the last refresh could not read show `State unknown` with the
// reason, not the state that the registry alone gives; the rows of another engine, a busy one (Updating) and every row
// after a refresh that read the states show their state; the actions stay those of the state (Start works).
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { Devspace } from '../core/types';
import { TreeTexts, buildTreeModel, repositoryRows, type DevspaceRuntime, type RepositoryRow, type StatesUnknown, type TreeInput } from './treeModel';

const T0 = Date.parse('2026-10-11T12:00:00.000Z');

function devspace(id: string, repository: string, overrides: Partial<Devspace> = {}): Devspace {
  return {
    id,
    repository,
    configPath: '.devcontainer/devcontainer.json',
    volumeName: `devspaces-${id}`,
    containerName: `devspaces-${id}`,
    createdAt: new Date(T0 - 3_600_000).toISOString(),
    lastUsedAt: new Date(T0).toISOString(),
    owner: { id: '1001', login: 'me' },
    gitSummary: { branch: 'main', uncommittedFiles: 0, unpushedCommits: 3, stashes: 0, recordedAt: new Date(T0).toISOString() },
    ...overrides,
  };
}

const ON_DEVSPACE = devspace('e1', 'acme/module-html-css-2', { dockerHost: 'devspace' });
const LOCAL = devspace('e2', 'acme/api');
const BUSY = devspace('e3', 'acme/busy', { dockerHost: 'devspace' });

function rows(options: { statesUnknown?: StatesUnknown; runtime?: ReadonlyMap<string, DevspaceRuntime>; currentDevspaceId?: string; kept?: boolean } = {}) {
  const input: TreeInput = {
    discovery: undefined,
    settings: { owners: [], includeArchived: false, includeForks: true },
    devspaces: [options.kept ? { ...ON_DEVSPACE, keepRunning: true } : ON_DEVSPACE, LOCAL, BUSY],
    runtime: options.runtime,
    ...(options.statesUnknown !== undefined ? { statesUnknown: options.statesUnknown } : {}),
    currentDevspaceId: options.currentDevspaceId ?? null,
    otherWindowDevspaceIds: new Set(),
    busyDevspaceIds: new Set([BUSY.id]),
    liveBranches: new Map(),
    signedIn: true,
    formatTime: (value) => `T(${value})`,
  };
  const all = repositoryRows(buildTreeModel(input));
  const of = (env: Devspace): RepositoryRow => {
    const row = all.find((each) => each.devspace?.id === env.id);
    if (row === undefined) throw new Error(`No row of ${env.id}`);
    return row;
  };
  return { remote: of(ON_DEVSPACE), local: of(LOCAL), busy: of(BUSY) };
}

describe('the state of the devspaces on an engine that the refresh could not read is unknown', () => {
  it('names the reason in the row and the tooltip, for the rows of that engine only; the actions stay', () => {
    const before = rows();
    expect(before.remote.description).toBe('main   Stopped · 3 unpushed');
    const { remote, local, busy } = rows({ statesUnknown: { dockerHost: 'devspace', reason: 'building' } });
    expect(remote.description).toBe('main   State unknown (devspace not ready)');
    expect(remote.tooltip.split('\n')).toEqual(expect.arrayContaining(['State unknown', 'devspace not ready: the helper image is being built.']));
    expect(remote.stateUnknown).toBe(true);
    // The state that the actions are made from, and the actions, as before (Start builds the helper image).
    expect(remote.state).toBe(before.remote.state);
    expect(remote.actions).toEqual(before.remote.actions);
    expect(remote.contextValue).toBe(before.remote.contextValue);
    expect(remote.contextValue).toContain('canStart');
    // Another engine: as before.
    expect(local.description).toBe(before.local.description);
    expect(local.stateUnknown).toBeUndefined();
    // A live busy mark is known without Docker: Updating.
    expect(busy.description).toBe(before.busy.description);
    expect(busy.description).toContain('Updating');
    expect(busy.stateUnknown).toBeUndefined();
  });

  it('the reasons: not reachable, being built, a failed build, another cause, the removal mark; the local Docker is named Docker', () => {
    expect(rows({ statesUnknown: { dockerHost: 'devspace', reason: 'unreachable' } }).remote.description).toBe('main   State unknown (devspace cannot be reached)');
    expect(rows({ statesUnknown: { dockerHost: 'devspace', reason: 'unreachable' } }).remote.tooltip).toContain('devspace cannot be reached, so the state of the devspace is not known.');
    expect(rows({ statesUnknown: { dockerHost: 'devspace', reason: 'buildFailed' } }).remote.tooltip).toContain(
      'devspace not ready: the helper image could not be built (see the Devspaces output). Start builds it.',
    );
    expect(rows({ statesUnknown: { dockerHost: 'devspace', reason: 'notReady' } }).remote.tooltip).toContain(
      'devspace not ready: the state could not be read (see the Devspaces output).',
    );
    expect(rows({ statesUnknown: { dockerHost: 'devspace', reason: 'removed' } }).remote.description).toBe('main   State unknown (Devspaces removed from devspace)');
    expect(rows({ statesUnknown: { dockerHost: 'devspace', reason: 'removed' } }).remote.tooltip).toContain(
      'Devspaces was removed from devspace, so the state of the devspace is not read. A Start of the devspace sets Devspaces up there again.',
    );
    const local = rows({ statesUnknown: { dockerHost: '', reason: 'building' } });
    expect(local.local.description).toBe('main   State unknown (Docker not ready)');
    expect(local.local.tooltip).toContain('Docker not ready: the helper image is being built.');
    expect(local.remote.stateUnknown).toBeUndefined();
  });

  // The user guide quotes the short reasons as a row shows them. Mutation: the examples with an engine named "devspace"
  // fail it.
  it('the user guide quotes the reasons as the rows show them: the local Docker is named Docker, a remote engine by its host', () => {
    const guide = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'guide.md'), 'utf8');
    const row = guide.split('\n').find((line) => line.startsWith('| `State unknown (…)` |')) ?? '';
    for (const [engine, reason] of [['Docker', 'notReady'], ['<host>', 'unreachable'], ['Docker', 'removed']] as const) {
      expect(row, reason).toContain(`(\`${TreeTexts.unknownShort(engine, reason)}\`)`);
    }
    expect(row).toContain('The local Docker is named `Docker`, a remote engine by its host.');
  });

  it('also over the state that the registry alone gives a connected window, with the suffix of a kept devspace', () => {
    const before = rows({ currentDevspaceId: ON_DEVSPACE.id, kept: true });
    expect(before.remote.description).toBe('main   Connected · kept');
    const { remote } = rows({ currentDevspaceId: ON_DEVSPACE.id, kept: true, statesUnknown: { dockerHost: 'devspace', reason: 'notReady' } });
    expect(remote.description).toBe('main   State unknown (devspace not ready) · kept');
    // The source line comes first, the state line second.
    expect(remote.tooltip.split('\n')[2]).toBe('State unknown · kept');
    expect(remote.state).toBe('connected');
    expect(remote.contextValue).toBe(before.remote.contextValue);
  });

  it('a refresh that read the states shows them again (no statesUnknown); a missing volume is Files missing', () => {
    const runtime = new Map<string, DevspaceRuntime>([[ON_DEVSPACE.id, { container: 'missing', volume: false }]]);
    const { remote } = rows({ runtime });
    expect(remote.stateUnknown).toBeUndefined();
    expect(remote.state).toBe('filesMissing');
    expect(remote.description).toBe('main   Files missing');
  });
});
