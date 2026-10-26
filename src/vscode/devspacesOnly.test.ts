// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Show Only Devspaces / Show All Repositories: the setting showOnlyDevspaces in the user or workspace settings, the
// context key of the view title bar, and the entries of package.json.
import * as fs from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { Commands } from './commands';
import { DEVSPACES_ONLY_CONTEXT_KEY, setShowOnlyDevspaces, updateDevspacesOnlyContextKey } from './devspacesOnly';
import { DEFAULT_SETTINGS, SETTINGS_SECTION, normalizeSettings } from './settings';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';

beforeEach(() => {
  resetFakeVscode();
});

describe('Show Only Devspaces', () => {
  it('writes the setting showOnlyDevspaces to the user settings, or to the workspace settings when they hold it', async () => {
    const update = vi.fn(async () => undefined);
    let workspaceValue: unknown;
    const inspect = vi.fn(() => ({ key: 'devspaces.showOnlyDevspaces', globalValue: true, workspaceValue }));
    fakeVscode.workspace.getConfiguration.mockImplementation((section: string) => {
      expect(section).toBe(SETTINGS_SECTION);
      return { get: vi.fn(), update, inspect };
    });
    await setShowOnlyDevspaces(true);
    await setShowOnlyDevspaces(false);
    // A value in the workspace settings wins over the user settings: the button changes that value.
    workspaceValue = false;
    await setShowOnlyDevspaces(true);
    expect(inspect).toHaveBeenCalledWith('showOnlyDevspaces');
    expect(update.mock.calls).toEqual([
      ['showOnlyDevspaces', true, fakeVscode.ConfigurationTarget.Global],
      ['showOnlyDevspaces', false, fakeVscode.ConfigurationTarget.Global],
      ['showOnlyDevspaces', true, fakeVscode.ConfigurationTarget.Workspace],
    ]);
  });

  it('is off by default and only for a boolean true', () => {
    expect(DEFAULT_SETTINGS.showOnlyDevspaces).toBe(false);
    expect(normalizeSettings(() => undefined).showOnlyDevspaces).toBe(false);
    expect(normalizeSettings((key) => (key === 'showOnlyDevspaces' ? 'yes' : undefined)).showOnlyDevspaces).toBe(false);
    expect(normalizeSettings((key) => (key === 'showOnlyDevspaces' ? true : undefined)).showOnlyDevspaces).toBe(true);
  });

  it.each([true, false])('sets the context key for %s', (on) => {
    updateDevspacesOnlyContextKey(on, { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() });
    expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith('setContext', DEVSPACES_ONLY_CONTEXT_KEY, on);
  });

  it('package.json: one of the two in the title bar, the setting, and the empty view while it is on', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: {
        commands: Array<{ command: string; title: string; icon?: string }>;
        menus: Record<string, Array<{ command: string; when: string; group?: string }>>;
        viewsWelcome: Array<{ contents: string; when: string }>;
        configuration: { properties: Record<string, { type: string; default: unknown }> };
      };
    };
    const command = (id: string) => manifest.contributes.commands.find((entry) => entry.command === id);
    expect(command(Commands.showOnlyDevspaces)).toMatchObject({ title: 'Show Only Devspaces', icon: '$(vm)' });
    expect(command(Commands.showAllRepositories)).toMatchObject({ title: 'Show All Repositories', icon: '$(vm-active)' });
    const title = manifest.contributes.menus['view/title'];
    expect(title.find((entry) => entry.command === Commands.showOnlyDevspaces)?.when).toBe(
      `view == devspaces.repositories && !${DEVSPACES_ONLY_CONTEXT_KEY}`,
    );
    expect(title.find((entry) => entry.command === Commands.showAllRepositories)?.when).toBe(
      `view == devspaces.repositories && ${DEVSPACES_ONLY_CONTEXT_KEY}`,
    );
    expect(manifest.contributes.configuration.properties['devspaces.showOnlyDevspaces']).toMatchObject({ type: 'boolean', default: false });
    const empty = manifest.contributes.viewsWelcome.filter((entry) => entry.when.includes(DEVSPACES_ONLY_CONTEXT_KEY));
    expect(empty.map((entry) => entry.contents)).toEqual([
      'No repository with a Dev Container configuration was found.\n[Refresh](command:devspaces.refresh)',
      `You have no devspace on this Docker engine yet.\n[Show All Repositories](command:${Commands.showAllRepositories})`,
    ]);
  });
});
