// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// "Select Organizations…" in the title bar of the view: a multi-select Quick Pick that writes the setting `owners`, the
// scan scope of the repository list. The configuration change handler of extension.ts then loads the list of the new
// scope.
import * as vscode from 'vscode';
import type { DiscoveryService } from '../core/discovery/discoveryService';
import { errorMessage } from '../core/errors';
import { Actions, Messages } from '../core/messages';
import type { Logger } from '../core/ports';
import type { DiscoveryData, ExtensionSettings, GitHubAccount } from '../core/types';
import { showInformationMessage } from './notifications';
import { ownerChoices, ownersFiltered, OwnerTexts, selectedOwners } from './ownerChoices';
import { SETTINGS_SECTION, settingTarget } from './settings';

/** Context key of the view title bar (package.json): the setting `owners` limits the scan (icon `$(filter-filled)`). */
export const OWNERS_FILTERED_CONTEXT_KEY = 'devspaces.ownersFiltered';

export interface OwnerSelectorDeps {
  auth: {
    isSignedIn(): Promise<boolean>;
    /** The accounts of Devspaces. */
    accounts(): Promise<GitHubAccount[]>;
    getToken(options: { interactive: boolean; account?: GitHubAccount }): Promise<string | undefined>;
  };
  /** The list of an account that the view shows (Sidebar.accountList), whose organizations are used when it is loaded. */
  accountList: (accountId: string) => DiscoveryData | undefined;
  discovery: Pick<DiscoveryService, 'viewerOrganizations'>;
  settings: () => ExtensionSettings;
  /** Sign in with GitHub (the command of the view). */
  signIn: () => Promise<void>;
  logger: Logger;
}

interface OwnerItem extends vscode.QuickPickItem {
  login: string;
}

/**
 * Asks for the owners to scan and writes them to the setting `owners`, where its value applies (settingTarget). The
 * setting applies to every account of Devspaces, so the choices are the logins and organizations of all of them. Not
 * signed in: asks to sign in first. Cancel changes nothing; an empty selection writes `[]` (all repositories).
 */
export async function selectOwners(deps: OwnerSelectorDeps): Promise<void> {
  if (!(await deps.auth.isSignedIn())) {
    const choice = await showInformationMessage(Messages.signInRequired, Actions.signIn);
    if (choice !== Actions.signIn) return;
    await deps.signIn();
    if (!(await deps.auth.isSignedIn())) return;
  }
  const accounts = await deps.auth.accounts();
  if (accounts.length === 0) return;

  const owners = deps.settings().owners;
  const listed = await Promise.all(accounts.map((account) => accountOrganizations(deps, account)));
  const items: OwnerItem[] = ownerChoices({ accounts: listed, owners }).map((choice) => ({
    label: choice.label,
    ...(choice.description ? { description: choice.description } : {}),
    picked: choice.picked,
    login: choice.login,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: OwnerTexts.title,
    placeHolder: OwnerTexts.placeholder,
    matchOnDescription: true,
  });
  if (!picked) return;
  // Where the value applies: the workspace or the user settings.
  const configuration = vscode.workspace.getConfiguration(SETTINGS_SECTION);
  await configuration.update('owners', selectedOwners(picked), settingTarget(configuration, 'owners'));
}

/** Sets the context key of the filter icon from the setting `owners`. */
export function updateOwnersContextKey(owners: readonly unknown[], logger: Logger): void {
  vscode.commands.executeCommand('setContext', OWNERS_FILTERED_CONTEXT_KEY, ownersFiltered(owners)).then(undefined, (error: unknown) => {
    logger.warn(`Could not set the context key ${OWNERS_FILTERED_CONTEXT_KEY}: ${errorMessage(error)}`);
  });
}

/**
 * The organizations of an account: from its list in the view when it is loaded, otherwise from GitHub (a request
 * without repositories). When GitHub cannot be asked, only the account is offered (and the owners of the setting).
 */
async function accountOrganizations(deps: OwnerSelectorDeps, account: GitHubAccount): Promise<{ login: string; organizations: string[] }> {
  const data = deps.accountList(account.id);
  if (data && data.viewerLogin.toLowerCase() === account.login.toLowerCase()) {
    return { login: data.viewerLogin, organizations: data.organizations };
  }
  try {
    const token = await deps.auth.getToken({ interactive: false, account });
    if (!token) return { login: account.login, organizations: [] };
    return await deps.discovery.viewerOrganizations(token);
  } catch (error) {
    deps.logger.warn(`The organizations of ${account.login} could not be read: ${errorMessage(error)}`);
    return { login: account.login, organizations: [] };
  }
}
