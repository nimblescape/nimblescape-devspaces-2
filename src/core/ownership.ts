// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Devspaces belong to the GitHub account that created them (docs/security.md "Accounts"). Devspaces can use several
// accounts at once (the accounts of Devspaces, src/vscode/auth.ts): the view shows the devspaces of all of them, and
// each devspace is used only with its own account. A devspace of an account that Devspaces does not use is never seen,
// started, or connected to; an account has at most one devspace per repository, Docker host and source (a Dev
// Container configuration, or the default image; devspaceSource.ts).
import type { Devspace, GitHubAccount } from './types';

/**
 * True if `account` may use the devspace: it is the owner of the devspace. Without an account (not signed in), no
 * devspace is available.
 */
export function isAvailableTo(devspace: Pick<Devspace, 'owner'>, account: GitHubAccount | undefined): boolean {
  return account !== undefined && devspace.owner.id === account.id;
}

/** The account of `accounts` that owns the devspace; `undefined` when it belongs to none of them. */
export function ownerAmong(devspace: Pick<Devspace, 'owner'>, accounts: readonly GitHubAccount[]): GitHubAccount | undefined {
  return accounts.find((account) => isAvailableTo(devspace, account));
}

/** The devspaces that one of `accounts` may use, in their order. */
export function availableDevspaces<T extends Pick<Devspace, 'owner'>>(devspaces: readonly T[], accounts: readonly GitHubAccount[]): T[] {
  return devspaces.filter((devspace) => ownerAmong(devspace, accounts) !== undefined);
}

/** The owner entry of a devspace that `account` creates. */
export function ownerOf(account: GitHubAccount): GitHubAccount {
  return { id: account.id, login: account.login };
}

/** The IDs of `accounts` as one text, to compare two reads of the set of accounts (in any order). */
export function accountIds(accounts: readonly GitHubAccount[]): string {
  return accounts
    .map((account) => account.id)
    .sort()
    .join(' ');
}
