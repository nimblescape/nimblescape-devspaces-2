// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Devspaces belong to the GitHub account that created them (docs/security.md "Accounts"). An account never sees,
// starts, or connects to a devspace of another account; an account has at most one devspace per repository, Docker
// host and source (a Dev Container configuration, or the default image; devspaceSource.ts).
import type { Devspace, GitHubAccount } from './types';

/**
 * True if the signed-in `account` may use the devspace: it is the owner of the devspace. Without an account (not
 * signed in), no devspace is available.
 */
export function isAvailableTo(devspace: Pick<Devspace, 'owner'>, account: GitHubAccount | undefined): boolean {
  return account !== undefined && devspace.owner.id === account.id;
}

/** The devspaces that `account` may use, in their order. */
export function availableDevspaces<T extends Pick<Devspace, 'owner'>>(
  devspaces: readonly T[],
  account: GitHubAccount | undefined,
): T[] {
  return devspaces.filter((devspace) => isAvailableTo(devspace, account));
}

/** The owner entry of a devspace that `account` creates. */
export function ownerOf(account: GitHubAccount): GitHubAccount {
  return { id: account.id, login: account.login };
}
