// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { Actions, Messages } from '../core/messages';
import type { DiscoveryData, ExtensionSettings, GitHubAccount } from '../core/types';
import { Commands } from './commands';
import { OwnerTexts } from './ownerChoices';
import { OWNERS_FILTERED_CONTEXT_KEY, selectOwners, updateOwnersContextKey, type OwnerSelectorDeps } from './ownerSelector';
import { DEFAULT_SETTINGS, SETTINGS_SECTION } from './settings';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';

const OCTO: GitHubAccount = { id: '1001', login: 'octo' };

interface Harness {
  deps: OwnerSelectorDeps;
  settings: ExtensionSettings;
  update: ReturnType<typeof vi.fn>;
  /** The value of `owners` in the workspace settings, as `inspect` gives it. */
  workspaceOwners: { value: unknown };
  signedIn: { value: boolean };
  viewerOrganizations: ReturnType<typeof vi.fn>;
  signIn: ReturnType<typeof vi.fn>;
  data: { value: DiscoveryData | undefined };
}

function listOf(viewerLogin: string, organizations: string[]): DiscoveryData {
  return { version: 1, fetchedAt: '', viewerLogin, organizations, repositories: [], hints: [], scope: [], withoutConfiguration: [] };
}

function harness(): Harness {
  const settings: ExtensionSettings = { ...DEFAULT_SETTINGS, owners: [] };
  const update = vi.fn(async () => undefined);
  const workspaceOwners: { value: unknown } = { value: undefined };
  fakeVscode.workspace.getConfiguration.mockImplementation((section: string) => {
    expect(section).toBe(SETTINGS_SECTION);
    return { get: vi.fn(), update, inspect: (key: string) => (key === 'owners' ? { key, workspaceValue: workspaceOwners.value } : undefined) };
  });
  const signedIn = { value: true };
  const data = { value: listOf('octo', ['beta', 'acme']) as DiscoveryData | undefined };
  const viewerOrganizations = vi.fn(async () => ({ login: 'octo', organizations: ['from-github'] }));
  const signIn = vi.fn(async () => undefined);
  const deps: OwnerSelectorDeps = {
    auth: {
      isSignedIn: async () => signedIn.value,
      getToken: async () => (signedIn.value ? 'gho_token' : undefined),
      getAccount: async () => (signedIn.value ? OCTO : undefined),
    },
    discoveryData: () => data.value,
    discovery: { viewerOrganizations },
    settings: () => settings,
    signIn,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() },
  };
  return { deps, settings, update, workspaceOwners, signedIn, viewerOrganizations, signIn, data };
}

interface PickItem {
  label: string;
  description?: string;
  picked?: boolean;
  login: string;
}

/** The items and options of the last Quick Pick. */
function lastPick(): { items: PickItem[]; options: Record<string, unknown> } {
  const call = fakeVscode.window.showQuickPick.mock.calls.at(-1) as [PickItem[], Record<string, unknown>];
  return { items: call[0], options: call[1] };
}

let h: Harness;

beforeEach(() => {
  resetFakeVscode();
  h = harness();
});

describe('selectOwners (Select Organizations…)', () => {
  it('offers the account and its organizations in a multi-select Quick Pick, with the current setting selected', async () => {
    h.settings.owners = ['acme'];
    await selectOwners(h.deps);
    const { items, options } = lastPick();
    expect(items.map((item) => [item.label, item.description, item.picked])).toEqual([
      ['octo', 'your account', false],
      ['acme', undefined, true],
      ['beta', undefined, false],
    ]);
    expect(options).toMatchObject({ canPickMany: true, title: OwnerTexts.title, placeHolder: OwnerTexts.placeholder });
    // The list of the view names the organizations: no request to GitHub.
    expect(h.viewerOrganizations).not.toHaveBeenCalled();
    // Cancel changes nothing.
    expect(h.update).not.toHaveBeenCalled();
  });

  it('keeps owners of the setting that are not in the lists as items', async () => {
    h.settings.owners = ['torvalds', 'beta'];
    await selectOwners(h.deps);
    expect(lastPick().items.map((item) => [item.label, item.description, item.picked])).toEqual([
      ['octo', 'your account', false],
      ['acme', undefined, false],
      ['beta', undefined, true],
      ['torvalds', OwnerTexts.fromSettings, true],
    ]);
  });

  it('writes the selection to the global user setting', async () => {
    fakeVscode.window.showQuickPick.mockImplementation(async (items: PickItem[]) => items.filter((item) => item.label !== 'beta'));
    await selectOwners(h.deps);
    expect(h.update).toHaveBeenCalledWith('owners', ['octo', 'acme'], fakeVscode.ConfigurationTarget.Global);
  });

  it('writes the selection to the workspace settings when they hold the value of owners, which wins there', async () => {
    h.workspaceOwners.value = ['acme'];
    h.settings.owners = ['acme'];
    fakeVscode.window.showQuickPick.mockImplementation(async (items: PickItem[]) => items.filter((item) => item.label === 'octo'));
    await selectOwners(h.deps);
    expect(h.update).toHaveBeenCalledWith('owners', ['octo'], fakeVscode.ConfigurationTarget.Workspace);
  });

  it('writes an empty list for an empty selection: all repositories', async () => {
    h.settings.owners = ['acme'];
    fakeVscode.window.showQuickPick.mockResolvedValue([]);
    await selectOwners(h.deps);
    expect(h.update).toHaveBeenCalledWith('owners', [], fakeVscode.ConfigurationTarget.Global);
  });

  it('asks GitHub for the organizations when no list of the account is shown', async () => {
    h.data.value = undefined;
    await selectOwners(h.deps);
    expect(h.viewerOrganizations).toHaveBeenCalledWith('gho_token');
    expect(lastPick().items.map((item) => item.label)).toEqual(['octo', 'from-github']);

    // A list of another account is not used either.
    h.data.value = listOf('someone', ['their-org']);
    await selectOwners(h.deps);
    expect(lastPick().items.map((item) => item.label)).toEqual(['octo', 'from-github']);
  });

  it('still offers the account and the setting when GitHub cannot be asked', async () => {
    h.data.value = undefined;
    h.settings.owners = ['acme'];
    h.viewerOrganizations.mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.github.com'));
    await selectOwners(h.deps);
    expect(lastPick().items.map((item) => [item.label, item.picked])).toEqual([
      ['octo', false],
      ['acme', true],
    ]);
  });

  it('asks to sign in first when nobody is signed in', async () => {
    h.signedIn.value = false;
    await selectOwners(h.deps);
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(Messages.signInRequired, Actions.signIn);
    expect(h.signIn).not.toHaveBeenCalled();
    expect(fakeVscode.window.showQuickPick).not.toHaveBeenCalled();

    fakeVscode.window.showInformationMessage.mockResolvedValue(Actions.signIn);
    h.signIn.mockImplementation(async () => {
      h.signedIn.value = true;
    });
    await selectOwners(h.deps);
    expect(h.signIn).toHaveBeenCalledTimes(1);
    expect(fakeVscode.window.showQuickPick).toHaveBeenCalledTimes(1);
  });
});

describe('the filter icon of the view title bar', () => {
  it.each<[string[], boolean]>([
    [[], false],
    [['acme'], true],
  ])('sets the context key for the setting %j to %s', (owners, expected) => {
    updateOwnersContextKey(owners, { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() });
    expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith('setContext', OWNERS_FILTERED_CONTEXT_KEY, expected);
  });

  it('shows $(filter) without a scope and $(filter-filled) with one, before Search (package.json)', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: {
        commands: Array<{ command: string; title: string; icon?: string; category?: string }>;
        menus: Record<string, Array<{ command: string; when: string; group?: string }>>;
      };
    };
    const command = (id: string) => manifest.contributes.commands.find((entry) => entry.command === id);
    expect(command(Commands.selectOwners)).toEqual({
      command: Commands.selectOwners,
      title: 'Select Organizations…',
      category: 'Devspaces',
      icon: '$(filter)',
    });
    expect(command(Commands.selectOwnersFiltered)).toMatchObject({ title: 'Select Organizations…', icon: '$(filter-filled)' });
    const title = manifest.contributes.menus['view/title'];
    expect(title.map((entry) => [entry.command, entry.group])).toEqual([
      [Commands.selectOwners, 'navigation@0'],
      [Commands.selectOwnersFiltered, 'navigation@0'],
      // Show Only Devspaces, or Show All Repositories while the setting showOnlyDevspaces is on.
      [Commands.showOnlyDevspaces, 'navigation@1'],
      [Commands.showAllRepositories, 'navigation@1'],
      [Commands.search, 'navigation@2'],
      [Commands.refresh, 'navigation@3'],
      // Expand All, before VS Code's own Collapse All.
      [Commands.expandAll, 'navigation@4'],
      // Edit Repository Groups… in the "…" menu of the view.
      [Commands.editRepositoryGroups, '1_settings@1'],
      // Update All Images Now in the "…" menu of the view; "Remove Devspaces from This Docker Engine…" last, in a group of
      // its own, as Delete in the ⋯ menu of a row.
      [Commands.updateImagesNow, '2_maintenance@1'],
      [Commands.removeFromDockerEngine, '3_remove@1'],
      // No icon of the Docker host; the first row of the list chooses it.
    ]);
    expect(title[0].when).toBe(`view == devspaces.repositories && !${OWNERS_FILTERED_CONTEXT_KEY}`);
    expect(title[1].when).toBe(`view == devspaces.repositories && ${OWNERS_FILTERED_CONTEXT_KEY}`);
    // The twin with the filled icon is not a second entry of the Command Palette.
    // (The Docker setup adds hidden commands of its own to the same list.)
    const palette = manifest.contributes.menus.commandPalette as Array<{ command: string; when: string }>;
    expect(palette.filter((entry) => entry.command === Commands.selectOwnersFiltered)).toEqual([{ command: Commands.selectOwnersFiltered, when: 'false' }]);
    expect(palette.some((entry) => entry.command === Commands.selectOwners)).toBe(false);
  });
});
