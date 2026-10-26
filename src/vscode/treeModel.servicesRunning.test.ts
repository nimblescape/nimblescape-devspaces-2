// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Mutation tests of the sidebar texts of `servicesRunning`. The other tests compare the row with the constants
// (StateTexts, TreeTexts), so a wrong text such as "services of Docker Compose" passes them; these name the words that
// the sidebar shows. Kills X01 (src/core/messages.ts StateTexts.servicesRunning set to 'services running') and X02
// (src/vscode/treeModel.ts TreeTexts.servicesRunning set to 'Other services of Docker Compose run. Stop stops them.').
import { describe, expect, it } from 'vitest';
import type { Devspace } from '../core/types';
import { buildTreeModel, repositoryRows, type DevspaceRuntime, type TreeInput } from './treeModel';

const T0 = Date.parse('2026-10-08T12:00:00.000Z');

const DEVSPACE: Devspace = {
  id: 'e1',
  repository: 'acme-university/api',
  configPath: '.devcontainer/devcontainer.json',
  volumeName: 'devspaces-e1',
  containerName: 'devspaces-e1',
  createdAt: new Date(T0 - 3_600_000).toISOString(),
  lastUsedAt: new Date(T0).toISOString(),
  owner: { id: '1001', login: 'me' },
};

function rowOf(entry: DevspaceRuntime) {
  const input: TreeInput = {
    discovery: undefined,
    settings: { owners: [], includeArchived: false, includeForks: true },
    devspaces: [DEVSPACE],
    runtime: new Map([[DEVSPACE.id, entry]]),
    currentDevspaceId: null,
    otherWindowDevspaceIds: new Set(),
    busyDevspaceIds: new Set(),
    liveBranches: new Map(),
    signedIn: true,
    formatTime: (value) => `T(${value})`,
  };
  const row = repositoryRows(buildTreeModel(input)).find((each) => each.devspace?.id === DEVSPACE.id);
  if (row === undefined) throw new Error('No row of the devspace');
  return row;
}

describe('the sidebar names the other running containers of the devspace', () => {
  // Kills X01 and X02: the words of the state text and of the tooltip line (another dev container may be what runs, so
  // they must not say "services of Docker Compose").
  it('a stopped dev container while another container of the devspace runs: `Stopped · containers running`, and the tooltip line', () => {
    const row = rowOf({ container: 'stopped', volume: true, servicesRunning: true });
    expect(row.description).toContain('Stopped · containers running');
    expect(row.tooltip).toContain('Other containers of the devspace run. Stop stops them.');
    expect(`${row.description}\n${row.tooltip}`).not.toMatch(/services of Docker Compose|services running/);
  });
});
