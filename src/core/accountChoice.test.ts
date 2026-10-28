// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { chooseAccount, listedCandidates, permissionRank, permissionText, rankAccounts, type AccountCandidate } from './accountChoice';
import type { GitHubAccount, RepositoryPermission } from './types';

// Two accounts of the examples of the proposal: a teacher who owns a course organization, and a student account.
const SCALARION: GitHubAccount = { id: '1001', login: 'scalarion' };
const STAUSSH: GitHubAccount = { id: '2002', login: 'staussh' };
const ALPHA: GitHubAccount = { id: '3003', login: 'Alpha' };

const candidate = (account: GitHubAccount, permission?: RepositoryPermission, organizations?: string[]): AccountCandidate => ({
  account,
  ...(permission !== undefined ? { permission } : {}),
  ...(organizations !== undefined ? { organizations } : {}),
});
const logins = (candidates: readonly AccountCandidate[]) => candidates.map((each) => each.account.login);

describe('permissionRank and permissionText', () => {
  it('orders ADMIN > MAINTAIN > WRITE > TRIAGE > READ > unknown', () => {
    const ranks = (['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ', undefined] as const).map((permission) => permissionRank(permission));
    expect(ranks).toEqual([0, 1, 2, 3, 4, 5]);
    // A value that GitHub may add later counts as unknown.
    expect(permissionRank('OWNER' as RepositoryPermission)).toBe(5);
  });

  it('names a permission in lower case, and nothing for an unknown one', () => {
    expect(permissionText('MAINTAIN')).toBe('maintain');
    expect(permissionText(undefined)).toBeUndefined();
  });
});

describe('rankAccounts and chooseAccount (rules 4 to 7)', () => {
  it('rule 4: the highest permission wins, whatever the order of the accounts', () => {
    const candidates = [candidate(STAUSSH, 'WRITE'), candidate(SCALARION, 'ADMIN')];
    expect(chooseAccount('course-org/task-staussh', candidates)?.account).toEqual(SCALARION);
    expect(chooseAccount('course-org/task-staussh', [...candidates].reverse())?.account).toEqual(SCALARION);
  });

  it('rule 4: a known permission comes before an unknown one (a list of an older version)', () => {
    expect(logins(rankAccounts('acme/api', [candidate(SCALARION), candidate(STAUSSH, 'READ')]))).toEqual(['staussh', 'scalarion']);
  });

  it('rule 5: with equal permission, the account whose login owns the repository (any case)', () => {
    expect(chooseAccount('StaussH/tools', [candidate(SCALARION, 'WRITE'), candidate(STAUSSH, 'WRITE')])?.account).toEqual(STAUSSH);
  });

  it('rule 6: still equal, a member of the owning organization', () => {
    const candidates = [candidate(SCALARION, 'READ', ['other-org']), candidate(STAUSSH, 'READ', ['Course-Org'])];
    expect(chooseAccount('course-org/notes', candidates)?.account).toEqual(STAUSSH);
  });

  it('rule 7: still equal, the login first in alphabetical order (any case), then the ID', () => {
    expect(logins(rankAccounts('someone/public-lib', [candidate(STAUSSH, 'READ'), candidate(SCALARION, 'READ'), candidate(ALPHA, 'READ')]))).toEqual([
      'Alpha',
      'scalarion',
      'staussh',
    ]);
    const twin: GitHubAccount = { id: '0999', login: 'scalarion' };
    expect(rankAccounts('x/y', [candidate(SCALARION), candidate(twin)]).map((each) => each.account.id)).toEqual(['0999', '1001']);
  });

  it('a lower rule never beats a higher one', () => {
    // The owner of the repository with READ loses against an ADMIN of another account.
    expect(chooseAccount('staussh/tools', [candidate(STAUSSH, 'READ', ['staussh']), candidate(SCALARION, 'ADMIN')])?.account).toEqual(SCALARION);
    // The owner beats a member of the organization of the same name.
    expect(chooseAccount('staussh/tools', [candidate(SCALARION, 'WRITE', ['staussh']), candidate(STAUSSH, 'WRITE')])?.account).toEqual(STAUSSH);
  });

  it('chooses nothing without a candidate, and keeps the given list unchanged', () => {
    expect(chooseAccount('acme/api', [])).toBeUndefined();
    const candidates = [candidate(STAUSSH, 'READ'), candidate(SCALARION, 'ADMIN')];
    rankAccounts('acme/api', candidates);
    expect(logins(candidates)).toEqual(['staussh', 'scalarion']);
  });
});

describe('listedCandidates (rule 3)', () => {
  it('takes the accounts of Devspaces whose list has the repository, with their permission and organizations', () => {
    const info = { access: [{ account: STAUSSH, permission: 'WRITE' as const }, { account: SCALARION }] };
    const listings = [{ account: SCALARION, organizations: ['course-org'] }];
    expect(listedCandidates(info, [SCALARION, STAUSSH], listings)).toEqual([
      { account: STAUSSH, permission: 'WRITE' },
      { account: SCALARION, organizations: ['course-org'] },
    ]);
  });

  it('ignores an account that Devspaces does not use, and an account named twice', () => {
    const info = { access: [{ account: ALPHA, permission: 'ADMIN' as const }, { account: SCALARION, permission: 'READ' as const }, { account: SCALARION }] };
    expect(listedCandidates(info, [SCALARION])).toEqual([{ account: SCALARION, permission: 'READ' }]);
  });

  it('is empty for a repository that no list has', () => {
    expect(listedCandidates(undefined, [SCALARION])).toEqual([]);
    expect(listedCandidates({}, [SCALARION])).toEqual([]);
  });
});
