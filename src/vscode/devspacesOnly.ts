// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// "Show Only Devspaces" / "Show All Repositories" in the title bar of the view: the setting `showOnlyDevspaces`, which
// limits the list to the repositories that have a devspace (buildTreeModel). The configuration change handler of
// extension.ts then draws the list again.
import * as vscode from 'vscode';
import { errorMessage } from '../core/errors';
import type { Logger } from '../core/ports';
import { SETTINGS_SECTION, settingTarget } from './settings';

/** Context key of the view title bar (package.json): the setting `showOnlyDevspaces` is on. */
export const DEVSPACES_ONLY_CONTEXT_KEY = 'devspaces.devspacesOnly';

/** Writes the setting `showOnlyDevspaces` where its value applies: the workspace or the user settings (settingTarget). */
export async function setShowOnlyDevspaces(on: boolean): Promise<void> {
  const configuration = vscode.workspace.getConfiguration(SETTINGS_SECTION);
  await configuration.update('showOnlyDevspaces', on, settingTarget(configuration, 'showOnlyDevspaces'));
}

/** Sets the context key of the title bar icon from the setting `showOnlyDevspaces`. */
export function updateDevspacesOnlyContextKey(on: boolean, logger: Logger): void {
  vscode.commands.executeCommand('setContext', DEVSPACES_ONLY_CONTEXT_KEY, on).then(undefined, (error: unknown) => {
    logger.warn(`Could not set the context key ${DEVSPACES_ONLY_CONTEXT_KEY}: ${errorMessage(error)}`);
  });
}
