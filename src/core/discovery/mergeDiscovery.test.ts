// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import type { DiscoveryData, GitHubAccount, OrganizationHint, RepositoryInfo, RepositoryPermission } from '../types';
import { mergeDiscovery } from './mergeDiscovery';

const SCALARION: GitHubAccount = { id: '1001', login: 'scalarion' };
const STAUSSH: GitHubAccount = { id: '2002', login: 'staussh' };

function info(nameWithOwner: string, overrides: Partial<RepositoryInfo> = {}): RepositoryInfo {
  const [owner, name] = nameWithOwner.split('/');
  return {
    nameWithOwner,
    owner,
    name,
    url: `https://github.com/${nameWithOwner}`,
    isArchived: false,
    isFork: false,
    isPrivate: true,
    pushedAt: '2026-10-27T10:00:00.000Z',
    defaultBranch: 'main',
    configPaths: ['.devcontainer/devcontainer.json'],
    ...overrides,
  };
}

const withPermission = (nameWithOwner: string, permission: RepositoryPermission, overrides: Partial<RepositoryInfo> = {}) => info(nameWithOwner, { permission, ...overrides });

function data(account: GitHubAccount, overrides: Partial<DiscoveryData> = {}): DiscoveryData {
  return {
    version: 1,
    fetchedAt: '2026-10-28T08:00:00.000Z',
    viewerLogin: account.login,
    organizations: [],
    repositories: [],
    hints: [],
    scope: [],
    withoutConfiguration: [],
    ...overrides,
  };
}

describe('mergeDiscovery', () => {
  it('gives nothing without a list', () => {
    expect(mergeDiscovery([])).toBeUndefined();
  });

  it('keeps one list as it is, with the access of its account and without the permission on the entry', () => {
    const merged = mergeDiscovery([{ account: SCALARION, data: data(SCALARION, { organizations: ['course-org'], repositories: [withPermission('scalarion/tools', 'ADMIN')] }) }]);
    expect(merged?.repositories).toEqual([{ ...info('scalarion/tools'), access: [{ account: SCALARION, permission: 'ADMIN' }] }]);
    expect(merged?.repositories[0]).not.toHaveProperty('permission');
    expect(merged?.accounts).toEqual([{ account: SCALARION, organizations: ['course-org'] }]);
    expect(merged?.viewerLogin).toBe('scalarion');
  });

  it('merges a repository that two accounts see once (name without case), with the permission of each account', () => {
    const merged = mergeDiscovery([
      { account: SCALARION, data: data(SCALARION, { repositories: [withPermission('Course-Org/task-staussh', 'ADMIN'), withPermission('scalarion/tools', 'ADMIN')] }) },
      { account: STAUSSH, data: data(STAUSSH, { repositories: [withPermission('course-org/task-staussh', 'WRITE')] }) },
    ]);
    expect(merged?.repositories.map((each) => each.nameWithOwner)).toEqual(['Course-Org/task-staussh', 'scalarion/tools']);
    expect(merged?.repositories[0]?.access).toEqual([
      { account: SCALARION, permission: 'ADMIN' },
      { account: STAUSSH, permission: 'WRITE' },
    ]);
    expect(merged?.repositories[1]?.access).toEqual([{ account: SCALARION, permission: 'ADMIN' }]);
  });

  it('takes the data of a repository from the list that was fetched last, and is as old as the oldest list', () => {
    const merged = mergeDiscovery([
      { account: SCALARION, data: data(SCALARION, { fetchedAt: '2026-10-28T07:00:00.000Z', repositories: [info('acme/api', { defaultBranch: 'old' })] }) },
      { account: STAUSSH, data: data(STAUSSH, { fetchedAt: '2026-10-28T09:00:00.000Z', repositories: [info('acme/api', { defaultBranch: 'main' })] }) },
    ]);
    expect(merged?.repositories[0]?.defaultBranch).toBe('main');
    expect(merged?.fetchedAt).toBe('2026-10-28T07:00:00.000Z');
  });

  it('counts a repository with a configuration in one list as one with a configuration', () => {
    const merged = mergeDiscovery([
      { account: SCALARION, data: data(SCALARION, { fetchedAt: '2026-10-28T09:00:00.000Z', withoutConfiguration: [info('acme/api', { configPaths: [] })] }) },
      { account: STAUSSH, data: data(STAUSSH, { repositories: [info('acme/api')], withoutConfiguration: [info('acme/plain', { configPaths: [] })] }) },
    ]);
    expect(merged?.repositories.map((each) => each.nameWithOwner)).toEqual(['acme/api']);
    expect(merged?.repositories[0]?.configPaths).toEqual(['.devcontainer/devcontainer.json']);
    expect(merged?.repositories[0]?.access?.map((access) => access.account.login)).toEqual(['scalarion', 'staussh']);
    expect(merged?.withoutConfiguration.map((each) => each.nameWithOwner)).toEqual(['acme/plain']);
  });

  it('joins the organizations and the uncertain repositories, each once', () => {
    const merged = mergeDiscovery([
      { account: SCALARION, data: data(SCALARION, { organizations: ['course-org', 'acme'], uncertain: ['acme/api'] }) },
      { account: STAUSSH, data: data(STAUSSH, { organizations: ['Course-Org', 'school'], uncertain: ['ACME/api', 'school/x'] }) },
    ]);
    expect(merged?.organizations).toEqual(['course-org', 'acme', 'school']);
    expect(merged?.uncertain).toEqual(['acme/api', 'school/x']);
  });

  it('names the account in a hint of an organization that refuses it, only with several lists', () => {
    const saml: OrganizationHint = { organization: 'acme', kind: 'saml', url: 'https://github.com/orgs/acme/sso' };
    expect(mergeDiscovery([{ account: SCALARION, data: data(SCALARION, { hints: [saml] }) }])?.hints).toEqual([saml]);
    const merged = mergeDiscovery([
      { account: SCALARION, data: data(SCALARION, { hints: [saml] }) },
      { account: STAUSSH, data: data(STAUSSH, { hints: [saml] }) },
    ]);
    expect(merged?.hints).toEqual([
      { ...saml, login: 'scalarion' },
      { ...saml, login: 'staussh' },
    ]);
  });

  it('says that an owner of the scan scope is not found only when no account sees it', () => {
    const notFound = (organization: string): OrganizationHint => ({ organization, kind: 'notFound', url: `https://github.com/${organization}` });
    const merged = mergeDiscovery([
      { account: SCALARION, data: data(SCALARION, { hints: [notFound('school'), notFound('gone')] }) },
      { account: STAUSSH, data: data(STAUSSH, { hints: [notFound('Gone')] }) },
    ]);
    expect(merged?.hints).toEqual([notFound('gone')]);
  });

  it('shows the repositories of a first load that still runs, but neither its account nor its hints', () => {
    const merged = mergeDiscovery([
      { account: SCALARION, data: data(SCALARION, { organizations: ['acme'], repositories: [info('acme/api')] }) },
      {
        account: STAUSSH,
        data: data(STAUSSH, { organizations: ['school'], repositories: [info('school/task')], hints: [{ organization: 'school', kind: 'saml', url: 'u' }] }),
        partial: true,
      },
    ]);
    expect(merged?.repositories.map((each) => each.nameWithOwner)).toEqual(['acme/api', 'school/task']);
    expect(merged?.repositories[1]?.access).toEqual([{ account: STAUSSH }]);
    // The trust of an owner waits for the complete list of the account (targets.ts ownerTrust).
    expect(merged?.accounts).toEqual([{ account: SCALARION, organizations: ['acme'] }]);
    expect(merged?.hints).toEqual([]);
  });
});
