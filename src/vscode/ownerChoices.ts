// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Choices of "Select Organizations…": the owners that the setting `owners` can name. No `vscode` import, so the rules
// are unit-tested.
import { normalizeScope, scopeLogins } from '../core/discovery/scope';

// User-visible texts that messages.ts lacks; to be moved there.
export const OwnerTexts = {
  title: 'Select Organizations',
  placeholder: 'Select the organizations and accounts to scan for repositories. Select none to scan all repositories that you can access.',
  yourAccount: 'your account',
  /** With several accounts of Devspaces: the accounts that are members of an organization. */
  memberOf: (logins: readonly string[]) => `member: ${logins.join(', ')}`,
  /** An owner of the setting that is neither an account nor one of their organizations. */
  fromSettings: 'from your settings',
} as const;

export interface OwnerChoice {
  /** The login that the setting stores. */
  login: string;
  label: string;
  description?: string;
  /** Selected when the Quick Pick opens: the owner is in the setting. */
  picked: boolean;
}

/**
 * The choices: the accounts of Devspaces first (in their order), then their organizations in alphabetical order (with
 * several accounts, each names the accounts that are members), then the owners of the setting that are in neither list,
 * so that they can be removed. Each owner once (logins ignore case); the owners of the setting are selected.
 */
export function ownerChoices(input: {
  accounts: readonly { login: string; organizations: readonly string[] }[];
  owners: readonly string[];
}): OwnerChoice[] {
  const selected = new Set(normalizeScope(input.owners));
  const seen = new Set<string>();
  const choices: OwnerChoice[] = [];
  const add = (login: string, description?: string): void => {
    const key = login.trim().toLowerCase();
    if (key === '' || seen.has(key)) return;
    seen.add(key);
    choices.push({ login: login.trim(), label: login.trim(), ...(description ? { description } : {}), picked: selected.has(key) });
  };
  for (const account of input.accounts) add(account.login, OwnerTexts.yourAccount);
  const several = input.accounts.length > 1;
  const organizations = input.accounts
    .flatMap((account) => account.organizations)
    .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  for (const organization of organizations) {
    const key = organization.trim().toLowerCase();
    const members = input.accounts.filter((account) => account.organizations.some((each) => each.trim().toLowerCase() === key)).map((account) => account.login);
    add(organization, several ? OwnerTexts.memberOf(members) : undefined);
  }
  for (const owner of scopeLogins(input.owners)) add(owner, OwnerTexts.fromSettings);
  return choices;
}

/** The value of the setting `owners` for the selected choices. No selection: `[]`, which scans all repositories. */
export function selectedOwners(choices: readonly Pick<OwnerChoice, 'login'>[]): string[] {
  return scopeLogins(choices.map((choice) => choice.login));
}

/** True if the setting limits the scan (the filled filter icon of the view title). */
export function ownersFiltered(owners: readonly unknown[]): boolean {
  return scopeLogins(owners).length > 0;
}
