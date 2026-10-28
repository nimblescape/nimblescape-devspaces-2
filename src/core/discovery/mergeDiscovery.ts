// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The one list of the sidebar for all accounts of Devspaces (docs/security.md "Accounts"): each account loads and
// stores its own list with its own token (repositories-<account ID>.json, DiscoveryService); the sidebar merges them in
// memory, one entry per repository, with the accounts that have access to it. No `vscode`.
import type { AccountAccess, AccountListing, DiscoveryData, GitHubAccount, OrganizationHint, RepositoryInfo } from '../types';

/** The list of one account. */
export interface AccountList {
  account: GitHubAccount;
  data: DiscoveryData;
  /**
   * The part of a first load that still runs (progressive display): its repositories count, but the account is not
   * named in DiscoveryData.accounts, because its organizations are not known yet.
   */
  partial?: boolean;
}

/**
 * The merged list of `lists` (in the order of the accounts), or `undefined` without one:
 * - a repository once (its key: `owner/name` without case, as the registry compares repositories), with the data of the
 *   list that was fetched last, and in `access` each account whose list has it, with its permission (in the order of
 *   `lists`); a repository with a configuration in one list is one with a configuration;
 * - the organizations of all accounts;
 * - an organization that refuses an account once per account, with the login of the account when there are several
 *   lists; an owner of the scan scope counts as not found only when every list says so (no account sees it);
 * - `accounts`: the accounts of the complete lists, with their organizations.
 * The lists must have the same scan scope (the sidebar shows no list of another scope).
 */
export function mergeDiscovery(lists: readonly AccountList[]): DiscoveryData | undefined {
  const first = lists[0];
  if (first === undefined) return undefined;
  const several = lists.length > 1;
  // The data of a repository from the list that was fetched last.
  const latestFirst = [...lists].sort((a, b) => timeOf(b.data.fetchedAt) - timeOf(a.data.fetchedAt));
  const withConfiguration = new Map<string, RepositoryInfo & { access: AccountAccess[] }>();
  const withoutConfiguration = new Map<string, RepositoryInfo & { access: AccountAccess[] }>();
  for (const { data } of latestFirst) {
    for (const info of data.repositories) {
      const key = keyOf(info);
      if (!withConfiguration.has(key)) withConfiguration.set(key, merged(info));
    }
  }
  for (const { data } of latestFirst) {
    for (const info of data.withoutConfiguration) {
      const key = keyOf(info);
      if (!withConfiguration.has(key) && !withoutConfiguration.has(key)) withoutConfiguration.set(key, merged(info));
    }
  }
  for (const { account, data } of lists) {
    for (const info of [...data.repositories, ...data.withoutConfiguration]) {
      const key = keyOf(info);
      const entry = withConfiguration.get(key) ?? withoutConfiguration.get(key);
      if (entry === undefined || entry.access.some((access) => access.account.id === account.id)) continue;
      entry.access.push({ account: { id: account.id, login: account.login }, ...(info.permission !== undefined ? { permission: info.permission } : {}) });
    }
  }
  const complete = lists.filter((list) => list.partial !== true);
  const uncertain = unique(lists.flatMap((list) => list.data.uncertain ?? []));
  return {
    version: 1,
    // The oldest list: the merged list is as old as that one.
    fetchedAt: latestFirst[latestFirst.length - 1]?.data.fetchedAt ?? first.data.fetchedAt,
    viewerLogin: first.data.viewerLogin,
    organizations: unique(lists.flatMap((list) => list.data.organizations)),
    repositories: [...withConfiguration.values()],
    hints: mergedHints(complete, several),
    scope: [...first.data.scope],
    withoutConfiguration: [...withoutConfiguration.values()],
    ...(uncertain.length > 0 ? { uncertain } : {}),
    accounts: complete.map((list): AccountListing => ({ account: { id: list.account.id, login: list.account.login }, organizations: [...list.data.organizations] })),
  };
}

/** The hints of the complete lists (see mergeDiscovery). */
function mergedHints(lists: readonly AccountList[], several: boolean): OrganizationHint[] {
  const hints: OrganizationHint[] = [];
  const seen = new Set<string>();
  for (const { account, data } of lists) {
    for (const hint of data.hints) {
      const organization = hint.organization.toLowerCase();
      if (hint.kind === 'notFound') {
        // Not found only when no account sees the owner.
        const everywhere = lists.every((list) => list.data.hints.some((other) => other.kind === 'notFound' && other.organization.toLowerCase() === organization));
        const key = `notFound ${organization}`;
        if (!everywhere || seen.has(key)) continue;
        seen.add(key);
        hints.push({ organization: hint.organization, kind: hint.kind, url: hint.url });
        continue;
      }
      const key = `${organization} ${several ? account.id : ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hints.push({ organization: hint.organization, kind: hint.kind, url: hint.url, ...(several ? { login: account.login } : {}) });
    }
  }
  return hints;
}

/** A copy of `info` for the merged list: without the permission of one account, with an empty `access`. */
function merged(info: RepositoryInfo): RepositoryInfo & { access: AccountAccess[] } {
  const { permission: _permission, access: _access, ...rest } = info;
  return { ...rest, configPaths: [...info.configPaths], access: [] };
}

function keyOf(info: RepositoryInfo): string {
  return info.nameWithOwner.toLowerCase();
}

/** Each login once, in the first spelling (logins ignore case). */
function unique(values: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function timeOf(isoTime: string): number {
  const time = Date.parse(isoTime);
  return Number.isNaN(time) ? 0 : time;
}
