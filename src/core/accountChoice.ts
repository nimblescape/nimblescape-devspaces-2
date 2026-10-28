// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Which GitHub account a Start uses (docs/security.md "Accounts"), when Devspaces uses several accounts. The rules, in
// this order:
// 1. An existing devspace of the source of the repository opens with its owner account (the one used last, when two
//    accounts have one). Docker cannot change the owner of its volumes and images, and the clone belongs to that
//    account. The caller finds it in the registry (DevspaceRegistry.findForAccounts).
// 2. A devspace of an account that is not signed in: the Start asks (the controller).
// 3. A new devspace: only the accounts that have access to the repository count (their list has it, or GitHub
//    shows it to them).
// 4. The highest permission: ADMIN, MAINTAIN, WRITE, TRIAGE, READ, then unknown.
// 5. Equal permission: the account whose login is the owner of the repository.
// 6. Still equal: an account that is a member of the organization that owns the repository.
// 7. Still equal: the login that comes first in alphabetical order, so that the choice is stable.
// This module holds the rules 4 to 7 (rankAccounts) and the candidates of rule 3 from the merged list. No `vscode`.
import type { AccountListing, GitHubAccount, RepositoryInfo, RepositoryPermission } from './types';

/** The permissions of GitHub, highest first (rule 4). */
export const REPOSITORY_PERMISSIONS: readonly RepositoryPermission[] = ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'];

/** An account that may create the devspace of a repository (rule 3). */
export interface AccountCandidate {
  account: GitHubAccount;
  /** Its permission on the repository; missing: not known. */
  permission?: RepositoryPermission;
  /** Logins of the organizations where the account is a member (rule 6); missing: not known. */
  organizations?: readonly string[];
}

/** The place of a permission in the order of rule 4: 0 for ADMIN; an unknown permission comes last. */
export function permissionRank(permission: RepositoryPermission | undefined): number {
  const index = permission === undefined ? -1 : REPOSITORY_PERMISSIONS.indexOf(permission);
  return index < 0 ? REPOSITORY_PERMISSIONS.length : index;
}

/** The permission as the texts name it: `admin`, `maintain`, `write`, `triage`, `read`; `undefined` when unknown. */
export function permissionText(permission: RepositoryPermission | undefined): string | undefined {
  return permission?.toLowerCase();
}

/** `candidates` in the order of the rules 4 to 7 for the repository `owner/name`: the account that a Start uses first. */
export function rankAccounts<T extends AccountCandidate>(repository: string, candidates: readonly T[]): T[] {
  const owner = repository.slice(0, Math.max(0, repository.indexOf('/'))).toLowerCase();
  const isOwner = (candidate: AccountCandidate) => candidate.account.login.toLowerCase() === owner;
  const isMember = (candidate: AccountCandidate) => (candidate.organizations ?? []).some((organization) => organization.toLowerCase() === owner);
  return [...candidates].sort(
    (a, b) =>
      permissionRank(a.permission) - permissionRank(b.permission) ||
      Number(isOwner(b)) - Number(isOwner(a)) ||
      Number(isMember(b)) - Number(isMember(a)) ||
      a.account.login.localeCompare(b.account.login, 'en', { sensitivity: 'base' }) ||
      a.account.id.localeCompare(b.account.id),
  );
}

/**
 * The candidates of rule 3 from the merged list: each of `accounts` whose list has the repository (`info.access`), with
 * its permission and the organizations of its list (`listings`). Empty when no list of these accounts has it.
 */
export function listedCandidates(
  info: Pick<RepositoryInfo, 'access'> | undefined,
  accounts: readonly GitHubAccount[],
  listings: readonly AccountListing[] = [],
): AccountCandidate[] {
  const candidates: AccountCandidate[] = [];
  for (const access of info?.access ?? []) {
    const account = accounts.find((each) => each.id === access.account.id);
    if (account === undefined || candidates.some((candidate) => candidate.account.id === account.id)) continue;
    const organizations = listings.find((listing) => listing.account.id === account.id)?.organizations;
    candidates.push({ account, ...(access.permission !== undefined ? { permission: access.permission } : {}), ...(organizations !== undefined ? { organizations } : {}) });
  }
  return candidates;
}

/** The account that a Start of a new devspace uses (rules 4 to 7) among `candidates`; `undefined` without one. */
export function chooseAccount<T extends AccountCandidate>(repository: string, candidates: readonly T[]): T | undefined {
  return rankAccounts(repository, candidates)[0];
}
