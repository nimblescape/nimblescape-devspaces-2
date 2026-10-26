// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { GitHubRateLimitError } from '../core/discovery/githubApi';
import { LOCAL_DOCKER_TARGET } from '../core/docker/dockerHost';
import { operationDockerTarget, runWithDockerTarget } from '../core/docker/dockerTargets';
import { Actions, Messages, StateTexts } from '../core/messages';
import { StoragePaths } from '../core/storage/paths';
import { DevspaceRegistry } from '../core/storage/registry';
import { SessionFiles } from '../core/storage/sessionFiles';
import type { DiscoveryData, Devspace, ExtensionSettings, GitHubAccount, RepositoryInfo, WindowStatus } from '../core/types';
import { Commands } from './commands';
import {
  LOADED_CONTEXT_KEY,
  LOAD_FAILED_CONTEXT_KEY,
  RATE_LIMIT_MARGIN_MS,
  Sidebar,
  viewProgressLocation,
  type SidebarDeps,
} from './sidebar';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';
import type { GroupMatchRun } from './groupMatcher';
import { inThreadGroupMatcher, type InThreadGroupMatcher } from './testing/inThreadGroupMatcher';
import { parseRepositoryGroups } from './repositoryGroups';
import { buildGroupsPreview, entriesFromSetting } from './repositoryGroupsEditorModel';
import { TreeTexts, buildTreeModel, repositoryRows, type DevspaceRuntime, type OwnerGroup, type RepositoryRow } from './treeModel';

const NOW = Date.parse('2026-09-25T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

const SETTINGS: ExtensionSettings = {
  reopenLastOnStartup: true,
  stopOnClose: true,
  updateImagesOnConnect: true,
  respectShutdownActionNone: false,
  owners: [],
  includeArchived: false,
  includeForks: true,
  refreshIntervalMinutes: 60,
  hostAccessChecksOff: [],
};

const OCTO: GitHubAccount = { id: '1001', login: 'octo' };
const OTHER: GitHubAccount = { id: '2002', login: 'someone' };

/** A devspace of the signed-in account OCTO, unless `overrides` names another owner. */
function devspace(id: string, repository: string, overrides: Partial<Devspace> = {}): Devspace {
  const name = `devspaces-${repository.replace('/', '-')}`;
  return {
    id,
    repository,
    configPath: '.devcontainer/devcontainer.json',
    volumeName: name,
    containerName: name,
    createdAt: iso(NOW - 86_400_000),
    lastUsedAt: iso(NOW - 3_600_000),
    owner: OCTO,
    ...overrides,
  };
}

function info(nameWithOwner: string): RepositoryInfo {
  const [owner, name] = nameWithOwner.split('/');
  return {
    nameWithOwner,
    owner,
    name,
    url: `https://github.com/${nameWithOwner}`,
    isArchived: false,
    isFork: false,
    isPrivate: false,
    pushedAt: iso(NOW),
    defaultBranch: 'main',
    configPaths: ['.devcontainer/devcontainer.json'],
  };
}

function data(repositories: RepositoryInfo[]): DiscoveryData {
  return { version: 1, fetchedAt: iso(NOW), viewerLogin: 'octo', organizations: ['acme'], repositories, hints: [], scope: [], withoutConfiguration: [] };
}

const API = '11111111-1111-4111-8111-111111111111';
const OLD = '22222222-2222-4222-8222-222222222222';
const GONE = '33333333-3333-4333-8333-333333333333';
const FAILS = '44444444-4444-4444-8444-444444444444';

interface Harness {
  root: string;
  registry: DevspaceRegistry;
  sessionFiles: SessionFiles;
  sidebar: Sidebar;
  models: OwnerGroup[][];
  signedInFlags: boolean[];
  /** The Docker setup is required (the view gets an empty model). */
  setupRequired: { value: boolean };
  coordinator: { devspaceId: string | null; otherActiveWindows: ReturnType<typeof vi.fn<() => Promise<WindowStatus[]>>> };
  // The sidebar reads the states and the branches with one call (refreshStates).
  service: { refreshStates: ReturnType<typeof vi.fn> };
  docker: { isInstalled: ReturnType<typeof vi.fn>; isRunning: ReturnType<typeof vi.fn> };
  discovery: { loadStored: ReturnType<typeof vi.fn>; refresh: ReturnType<typeof vi.fn>; getRepository: ReturnType<typeof vi.fn> };
  auth: {
    getToken: ReturnType<typeof vi.fn>;
    getSession: ReturnType<typeof vi.fn>;
    getAccount: ReturnType<typeof vi.fn>;
    isSignedIn: ReturnType<typeof vi.fn>;
    updateContextKey: ReturnType<typeof vi.fn>;
  };
  /** The settings that the sidebar reads; a test can change them. */
  settings: ExtensionSettings;
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  clock: { now: () => number };
  /** The Docker host of the current Docker context ('' = the local Docker). */
  dockerHost: { value: string };
  /** The registered tree view of the repositories; a test can show it. */
  view: { visible: boolean };
  /** DockerTargets.withOperation (on the local Docker). */
  dockerTargets: { withOperation: ReturnType<typeof vi.fn> };
  /** MissingHelperBuild.status. */
  helperBuilds: { status: ReturnType<typeof vi.fn> };
  /** The matcher of the repository groups (on this thread). */
  groupMatcher: InThreadGroupMatcher;
}

function createHarness(): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-test-'));
  const clock = { now: () => NOW };
  const paths = new StoragePaths(root);
  paths.ensureDirectoriesSync();
  const registry = new DevspaceRegistry(paths, clock);
  const sessionFiles = new SessionFiles(paths, clock);
  const models: OwnerGroup[][] = [];
  const setupRequired = { value: false };
  const dockerHost = { value: '' };
  const view = { visible: false };
  const signedInFlags: boolean[] = [];
  const tree = {
    setModel: (groups: OwnerGroup[], options: { signedIn?: boolean }) => {
      models.push(groups);
      signedInFlags.push(options.signedIn ?? true);
    },
    getModel: () => models[models.length - 1] ?? [],
  };
  const coordinator = { devspaceId: null as string | null, otherActiveWindows: vi.fn(async (): Promise<WindowStatus[]> => []) };
  // One call for the states and the branches.
  const service = {
    refreshStates: vi.fn(async (_branchIds: ReadonlySet<string>): Promise<{ runtime: Map<string, DevspaceRuntime> | undefined; branches: Map<string, string> }> => ({
      runtime: undefined,
      branches: new Map(),
    })),
  };
  const docker = { isInstalled: vi.fn(() => true), isRunning: vi.fn(async () => true) };
  const dockerTargets = { withOperation: vi.fn(async <T>(fn: () => Promise<T>) => runWithDockerTarget(LOCAL_DOCKER_TARGET, fn)) };
  const discovery = {
    loadStored: vi.fn(async () => undefined),
    refresh: vi.fn(async () => data([info('acme/api')])),
    getRepository: vi.fn(async () => undefined),
  };
  const auth = {
    getToken: vi.fn(async () => 'gho_token'),
    // One session: the token and the account that getToken and getAccount give.
    getSession: vi.fn(async (): Promise<{ token: string; account: GitHubAccount } | undefined> => {
      const token = (await auth.getToken()) as string | undefined;
      const account = await auth.getAccount();
      return token !== undefined && account !== undefined ? { token, account } : undefined;
    }),
    getAccount: vi.fn(async (): Promise<GitHubAccount | undefined> => OCTO),
    isSignedIn: vi.fn(async () => true),
    updateContextKey: vi.fn(async () => true),
    renewToken: vi.fn(async () => undefined),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };
  const settings: ExtensionSettings = { ...SETTINGS, owners: [...SETTINGS.owners] };
  const helperBuilds = { status: vi.fn((_dockerHost: string): 'building' | 'failed' | undefined => undefined) };
  const groupMatcher = inThreadGroupMatcher();
  const sidebar = new Sidebar({
    logger,
    registry,
    sessionFiles,
    coordinator,
    service,
    docker,
    discovery,
    auth,
    tree,
    settings: () => settings,
    groupMatcher,
    dockerSetupRequired: () => setupRequired.value,
    dockerHost: async () => dockerHost.value,
    dockerTargets,
    view,
    helperBuilds,
    clock,
    isAlive: (pid: number) => pid === process.pid,
  } as unknown as SidebarDeps);
  return {
    root,
    registry,
    sessionFiles,
    sidebar,
    models,
    signedInFlags,
    setupRequired,
    coordinator,
    service,
    docker,
    discovery,
    auth,
    settings,
    logger,
    clock,
    dockerHost,
    view,
    dockerTargets,
    helperBuilds,
    groupMatcher,
  };
}

let h: Harness;

beforeEach(() => {
  resetFakeVscode();
  fakeVscode.window.withProgress.mockImplementation(async (_options: unknown, task: () => Promise<unknown>) => task());
  h = createHarness();
});

afterEach(() => {
  h.sidebar.dispose();
  fs.rmSync(h.root, { recursive: true, force: true });
});

function rows(): RepositoryRow[] {
  return repositoryRows(h.models[h.models.length - 1] ?? []);
}

/** The sidebar knows the signed-in account (activation) and has loaded its list. */
async function signedIn(): Promise<void> {
  await h.sidebar.initialize();
  await h.sidebar.refreshDiscovery();
}

function rowOf(repository: string): RepositoryRow {
  const found = rows().find((candidate) => candidate.repository === repository);
  if (!found) throw new Error(`No row for ${repository}: ${rows().map((candidate) => candidate.repository).join(', ')}`);
  return found;
}

describe('Sidebar', () => {
  // When no remote Docker host is configured and the local Docker is not available, the repositories are not shown; the
  // sidebar shows the Docker setup instead.
  it('gives the view an empty model while the Docker setup is required, and the full model once Docker is found', async () => {
    h.setupRequired.value = true;
    await signedIn();
    await h.sidebar.render();
    // The discovery ran in the background, but the view has no rows at all: VS Code shows the welcome view.
    expect(h.discovery.refresh).toHaveBeenCalled();
    expect(h.models.length).toBeGreaterThan(0);
    expect(h.models.every((groups) => groups.length === 0)).toBe(true);
    // The Command Palette (switcher) still gets the repositories.
    expect(repositoryRows(h.sidebar.model()).map((row) => row.repository)).toEqual(['acme/api']);
    // Docker is found: DockerSetup calls render (onDidChangeInstalled), and the list appears at once.
    h.setupRequired.value = false;
    await h.sidebar.render();
    expect(rows().map((row) => row.repository)).toEqual(['acme/api']);
    // Lost again: the view is empty again.
    h.setupRequired.value = true;
    await h.sidebar.render();
    expect(h.models[h.models.length - 1]).toEqual([]);
    expect(h.docker.isRunning).not.toHaveBeenCalled();
    expect(h.docker.isInstalled).not.toHaveBeenCalled();
  });

  // A freshly opened or reconnecting window refreshes before the view is shown; VS Code rejects the view location then
  // ("Bad progress location").
  it('shows the refresh progress in the status bar while the view is not visible, and in the view once it is', async () => {
    const locations: unknown[] = [];
    fakeVscode.window.withProgress.mockImplementation(async (options: { location: unknown }, task: () => Promise<unknown>) => {
      locations.push(options.location);
      return task();
    });
    await signedIn();
    expect(locations.length).toBeGreaterThan(0);
    expect(locations.every((location) => location === fakeVscode.ProgressLocation.Window)).toBe(true);
    locations.length = 0;
    h.view.visible = true;
    await h.sidebar.refreshDiscovery({ again: true });
    expect(locations).toEqual([{ viewId: 'devspaces.repositories' }]);
  });

  it('uses the status bar for the progress while no view is registered', () => {
    expect(viewProgressLocation(undefined)).toBe(fakeVscode.ProgressLocation.Window);
    expect(viewProgressLocation({ visible: false })).toBe(fakeVscode.ProgressLocation.Window);
    expect(viewProgressLocation({ visible: true })).toEqual({ viewId: 'devspaces.repositories' });
  });

  it('shows the stored list at once and marks the view as loaded, then refreshes in the background', async () => {
    h.discovery.loadStored.mockResolvedValue(data([info('acme/web')]));
    await h.sidebar.initialize();
    expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith('setContext', LOADED_CONTEXT_KEY, true);
    expect(rows().map((row) => row.repository)).toEqual(['acme/web']);
    await h.sidebar.refreshDiscovery();
    await h.sidebar.render();
    expect(h.discovery.refresh).toHaveBeenCalledTimes(1);
    expect(rows().map((row) => row.repository)).toEqual(['acme/api']);
  });

  it('keeps the stored list when the refresh fails, and still ends "Loading"', async () => {
    h.discovery.refresh.mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.github.com'));
    h.discovery.loadStored.mockResolvedValue(data([info('acme/web')]));
    await h.sidebar.initialize();
    await h.sidebar.refreshDiscovery();
    await h.sidebar.render();
    expect(rows().map((row) => row.repository)).toEqual(['acme/web']);
    expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith('setContext', LOADED_CONTEXT_KEY, true);
    // A stored list is shown: the view does not say that the list could not be loaded.
    expect(fakeVscode.commands.executeCommand).not.toHaveBeenCalledWith('setContext', LOAD_FAILED_CONTEXT_KEY, true);
  });

  it('says that the list could not be loaded when the first refresh fails without a stored list', async () => {
    h.discovery.refresh.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND api.github.com'));
    await h.sidebar.initialize();
    await h.sidebar.refreshDiscovery();
    expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith('setContext', LOADED_CONTEXT_KEY, true);
    expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith('setContext', LOAD_FAILED_CONTEXT_KEY, true);

    // The next refresh succeeds: the view shows the list (or "No repository … was found").
    await h.sidebar.refreshDiscovery({ again: true });
    expect(fakeVscode.commands.executeCommand).toHaveBeenLastCalledWith('setContext', LOAD_FAILED_CONTEXT_KEY, false);
    await h.sidebar.render();
    expect(rows().map((row) => row.repository)).toEqual(['acme/api']);
  });

  it('runs one refresh at a time and reuses the running one', async () => {
    let finish!: (value: DiscoveryData) => void;
    h.discovery.refresh.mockImplementation(() => new Promise<DiscoveryData>((resolve) => (finish = resolve)));
    const first = h.sidebar.refreshDiscovery();
    const second = h.sidebar.refreshDiscovery();
    await vi.waitFor(() => expect(h.discovery.refresh).toHaveBeenCalledTimes(1));
    finish(data([]));
    await Promise.all([first, second]);
    expect(h.discovery.refresh).toHaveBeenCalledTimes(1);
  });

  it('asks GitHub for the repositories of devspaces that the list lacks, and marks only missing ones', async () => {
    await h.registry.add(devspace(API, 'acme/api'));
    await h.registry.add(devspace(OLD, 'acme/old'));
    await h.registry.add(devspace(GONE, 'acme/gone'));
    await h.registry.add(devspace(FAILS, 'acme/fails'));
    h.discovery.getRepository.mockImplementation(async (repository: string) => {
      if (repository === 'acme/old') return info('acme/old');
      if (repository === 'acme/fails') throw new Error('timeout');
      return undefined;
    });
    await h.sidebar.initialize();
    await h.sidebar.refreshDiscovery();
    await h.sidebar.render();

    expect(h.discovery.getRepository.mock.calls.map((call) => call[0]).sort()).toEqual(['acme/fails', 'acme/gone', 'acme/old']);
    expect(rowOf('acme/api').notOnGitHub).toBe(false);
    expect(rowOf('acme/old').notOnGitHub).toBe(false);
    expect(rowOf('acme/old').contextValue).toContain('onGitHub');
    expect(h.sidebar.repositoryInfo('ACME/old')?.url).toBe('https://github.com/acme/old');
    expect(rowOf('acme/gone').notOnGitHub).toBe(true);
    expect(rowOf('acme/gone').description).toContain(StateTexts.notOnGitHub);
    expect(rowOf('acme/fails').notOnGitHub).toBe(false);
  });

  it('shows every devspace as stopped when Docker does not run, so a lost connection is not shown as Connected', async () => {
    await h.registry.add(devspace(API, 'acme/api'));
    h.coordinator.devspaceId = API;
    await signedIn();
    await h.sidebar.render();
    expect(rowOf('acme/api').state).toBe('connected');

    h.service.refreshStates.mockResolvedValue({ runtime: undefined, branches: new Map() });
    h.docker.isRunning.mockResolvedValue(false);
    await h.sidebar.refreshStates();
    expect(rowOf('acme/api').state).toBe('stopped');
    expect(rowOf('acme/api').contextValue).toContain('canStart');
  });

  it('falls back to the states of the registry when Docker runs but its answer could not be read', async () => {
    await h.registry.add(devspace(API, 'acme/api'));
    await signedIn();
    h.service.refreshStates.mockResolvedValueOnce({ runtime: new Map([[API, { container: 'running', volume: true }]]), branches: new Map() });
    await h.sidebar.refreshStates();
    expect(rowOf('acme/api').state).toBe('running');
    h.service.refreshStates.mockResolvedValueOnce({ runtime: undefined, branches: new Map() });
    await h.sidebar.refreshStates();
    expect(rowOf('acme/api').state).toBe('stopped');
  });

  // A refresh that could not read the states shows them as unknown, with the reason, until a refresh reads them again;
  // the registry is not changed, and the actions stay.
  it('shows the state as unknown while Docker runs but the states could not be read, until a refresh reads them', async () => {
    await h.registry.add(devspace(API, 'acme/api'));
    await signedIn();
    const entriesBefore = await h.registry.list();
    h.service.refreshStates.mockResolvedValueOnce({ runtime: undefined, branches: new Map() });
    h.helperBuilds.status.mockReturnValue('building');
    await h.sidebar.refreshStates();
    expect(rowOf('acme/api').stateUnknown).toBe(true);
    expect(rowOf('acme/api').description).toContain(`${StateTexts.unknown} (Docker not ready)`);
    expect(rowOf('acme/api').tooltip).toContain('Docker not ready: the helper image is being built.');
    expect(h.helperBuilds.status).toHaveBeenCalledWith('');
    expect(rowOf('acme/api').contextValue).toContain('canStart');
    // The background build ended without success: the next render names that (no Docker call).
    h.helperBuilds.status.mockReturnValue('failed');
    await h.sidebar.render();
    expect(rowOf('acme/api').tooltip).toContain('Docker not ready: the helper image could not be built');
    h.helperBuilds.status.mockReturnValue(undefined);
    await h.sidebar.render();
    expect(rowOf('acme/api').tooltip).toContain('Docker not ready: the state could not be read');
    // Nothing of the registry was changed by the failed read.
    expect(await h.registry.list()).toEqual(entriesBefore);
    // A refresh that reads the states shows them again.
    h.service.refreshStates.mockResolvedValueOnce({ runtime: new Map([[API, { container: 'missing', volume: false }]]), branches: new Map() });
    await h.sidebar.refreshStates();
    expect(rowOf('acme/api').stateUnknown).toBeUndefined();
    expect(rowOf('acme/api').state).toBe('filesMissing');
    expect(rowOf('acme/api').description).toContain(StateTexts.filesMissing);
  });

  // "Remove Devspaces from This Docker Engine…": refreshStates asked Docker nothing there, and the sidebar does not ask
  // `docker info` after it. Mutation: the second isRunning() fails it.
  it('an engine with the removal mark: the states are unknown with the reason, and Docker is not asked', async () => {
    await h.registry.add(devspace(API, 'acme/api'));
    await signedIn();
    h.docker.isRunning.mockClear();
    h.service.refreshStates.mockResolvedValue({ runtime: undefined, branches: new Map(), engineRemoved: true });
    await h.sidebar.refreshStates();
    expect(h.docker.isRunning).not.toHaveBeenCalled();
    expect(h.helperBuilds.status).not.toHaveBeenCalled();
    expect(rowOf('acme/api').stateUnknown).toBe(true);
    expect(rowOf('acme/api').description).toContain(`${StateTexts.unknown} (Devspaces removed from Docker)`);
    expect(rowOf('acme/api').tooltip).toContain('Devspaces was removed from Docker, so the state of the devspace is not read. A Start of the devspace sets Devspaces up there again.');
    // The actions stay (Start sets Devspaces up there again).
    expect(rowOf('acme/api').contextValue).toContain('canStart');
  });

  it('a remote engine that does not answer is unknown (its containers may run); the local Docker that does not run is Stopped', async () => {
    h.dockerHost.value = 'devspace';
    await h.registry.add(devspace(API, 'acme/api', { dockerHost: 'devspace' }));
    await signedIn();
    h.service.refreshStates.mockResolvedValue({ runtime: undefined, branches: new Map() });
    h.docker.isRunning.mockResolvedValue(false);
    await h.sidebar.refreshStates();
    expect(rowOf('acme/api').stateUnknown).toBe(true);
    expect(rowOf('acme/api').description).toContain(`${StateTexts.unknown} (devspace cannot be reached)`);
    // The actions of the state that Docker that does not run gives (Start reconnects), as before.
    expect(rowOf('acme/api').state).toBe('stopped');
    expect(rowOf('acme/api').contextValue).toContain('canStart');
    expect(h.helperBuilds.status).not.toHaveBeenCalled();
    // The local Docker that does not run: nothing runs, so Stopped, never unknown.
    h.dockerHost.value = '';
    await h.registry.add(devspace(OLD, 'acme/web'));
    await h.sidebar.refreshStates();
    expect(rowOf('acme/web').stateUnknown).toBeUndefined();
    expect(rowOf('acme/web').description).toContain(StateTexts.stopped);
  });

  it('reads the branch of running containers when it refreshes the states', async () => {
    await h.registry.add(devspace(API, 'acme/api', { gitSummary: { branch: 'main', uncommittedFiles: 0, unpushedCommits: 0, stashes: 0, recordedAt: iso(NOW) } }));
    await signedIn();
    // The branch comes with the states from one refreshStates call.
    h.service.refreshStates.mockResolvedValue({ runtime: new Map([[API, { container: 'running', volume: true }]]), branches: new Map([[API, 'feature-x']]) });
    const refreshed = vi.fn();
    h.sidebar.onDidRefreshStates(refreshed);
    await h.sidebar.refreshStates();
    expect(h.service.refreshStates).toHaveBeenCalledTimes(1);
    expect(h.service.refreshStates).toHaveBeenCalledWith(new Set([API]));
    expect(rowOf('acme/api').branch).toBe('feature-x');
    expect(h.sidebar.liveBranch(API)).toBe('feature-x');
    expect(refreshed).toHaveBeenCalled();
  });

  it('reads the states and branches with one call, within one operation of the Docker target', async () => {
    await h.registry.add(devspace(API, 'acme/api'));
    await signedIn();
    const targets: unknown[] = [];
    h.service.refreshStates.mockClear();
    h.service.refreshStates.mockImplementation(async () => {
      targets.push(operationDockerTarget());
      return { runtime: new Map([[API, { container: 'running', volume: true }]]), branches: new Map([[API, 'feature-y']]) };
    });
    h.dockerTargets.withOperation.mockClear();
    await h.sidebar.refreshStates();
    expect(h.service.refreshStates).toHaveBeenCalledTimes(1);
    expect(h.dockerTargets.withOperation).toHaveBeenCalledTimes(1);
    expect(targets).toEqual([LOCAL_DOCKER_TARGET]);
    expect(rowOf('acme/api').state).toBe('running');
    expect(h.sidebar.liveBranch(API)).toBe('feature-y');
  });

  it('shows Updating only for busy marks of live windows with a recent status file', async () => {
    await h.registry.add(
      devspace(API, 'acme/api', { busy: { operation: 'rebuild', since: iso(NOW - 1000), pid: process.pid, windowId: 'w1' } }),
    );
    await h.registry.add(
      devspace(OLD, 'acme/old', { busy: { operation: 'rebuild', since: iso(NOW - 1000), pid: 999_999, windowId: 'w2' } }),
    );
    await h.sessionFiles.writeWindowStatus({ windowId: 'w1', pid: process.pid, devspaceId: null, state: 'active', updatedAt: iso(NOW) });
    await signedIn();
    await h.sidebar.render();
    expect(rowOf('acme/api').state).toBe('updating');
    expect(rowOf('acme/api').contextValue).not.toContain('canStop');
    expect(rowOf('acme/old').state).toBe('stopped');
  });

  it('shows nothing but the sign-in when the user is not signed in: no devspace is available', async () => {
    await h.registry.add(devspace(API, 'acme/api'));
    h.auth.updateContextKey.mockResolvedValue(false);
    h.auth.getAccount.mockResolvedValue(undefined);
    await h.sidebar.initialize();
    expect(h.signedInFlags[h.signedInFlags.length - 1]).toBe(false);
    expect(rows()).toEqual([]);
    h.auth.getAccount.mockResolvedValue(OCTO);
    await h.sidebar.onSessionChanged();
    await h.sidebar.render();
    expect(h.signedInFlags[h.signedInFlags.length - 1]).toBe(true);
    expect(rows().map((row) => row.repository)).toContain('acme/api');
  });

  it('trusts an owner only with a list of the current account', async () => {
    h.discovery.loadStored.mockResolvedValue({ ...data([]), viewerLogin: 'someone-else' });
    await h.sidebar.initialize();
    h.discovery.refresh.mockResolvedValue(data([]));
    expect(await h.sidebar.trustedOwner('acme')).toBe(true);
    expect(await h.sidebar.trustedOwner('stranger')).toBe(false);
  });

  // The devspaces of another Docker host are hidden and never acted on.
  it('shows only the devspaces of the current Docker host', async () => {
    await h.registry.add(devspace(API, 'acme/api'));
    await h.registry.add(devspace(OLD, 'acme/web', { dockerHost: 'build-box' }));
    h.discovery.refresh.mockResolvedValue(data([info('acme/api'), info('acme/web')]));
    await h.sidebar.initialize();
    await h.sidebar.refreshDiscovery();
    await h.sidebar.render();
    const withDevspace = (): string[] => rows().filter((row) => row.devspace).map((row) => row.devspace!.id);
    expect(withDevspace()).toEqual([API]);
    expect((await h.sidebar.availableDevspaces()).map((entry) => entry.id)).toEqual([API]);
    // After a switch to build-box, the next render shows its devspace only.
    h.dockerHost.value = 'build-box';
    await h.sidebar.render();
    expect(withDevspace()).toEqual([OLD]);
    expect((await h.sidebar.availableDevspaces()).map((entry) => entry.id)).toEqual([OLD]);
  });

  it('shows only the devspaces of the signed-in account, and names no other', async () => {
    await h.registry.add(devspace(API, 'acme/api'));
    await h.registry.add(devspace(OLD, 'majikmate/module-ts', { owner: OTHER }));
    await h.registry.add(devspace(GONE, 'majikmate/legacy', { owner: { id: '3003', login: 'third' } }));
    h.discovery.refresh.mockResolvedValue(data([info('acme/api')]));
    await h.sidebar.initialize();
    await h.sidebar.refreshDiscovery();
    await h.sidebar.render();
    expect(rows().map((row) => row.repository)).toEqual(['acme/api']);
    const shown = JSON.stringify(h.models);
    expect(shown).not.toContain('module-ts');
    expect(shown).not.toContain('majikmate');
    // Search and the switcher list the same.
    expect((await h.sidebar.repositoriesForPicker()).map((repository) => repository.nameWithOwner)).toEqual(['acme/api']);
    expect((await h.sidebar.availableDevspaces()).map((entry) => entry.id)).toEqual([API]);
    // No lookup on GitHub for a hidden devspace, and no branch read in its container.
    expect(h.discovery.getRepository).not.toHaveBeenCalled();
    // The branches are asked for the devspaces of the account only; the service reads a branch only for the IDs it
    // gets (devspaceService.test.ts).
    h.service.refreshStates.mockClear();
    h.service.refreshStates.mockResolvedValue({
      runtime: new Map([[OLD, { container: 'running', volume: true }], [API, { container: 'running', volume: true }]]),
      branches: new Map(),
    });
    await h.sidebar.refreshStates();
    expect(h.service.refreshStates.mock.calls.map((call) => [...(call[0] as ReadonlySet<string>)])).toEqual([[API]]);
  });

  it('offers Start for a listed repository that has a devspace of another account, and names it nowhere', async () => {
    await h.registry.add(devspace(OLD, 'majikmate/module-ts', { owner: OTHER }));
    h.discovery.refresh.mockResolvedValue(data([info('majikmate/module-ts'), info('acme/legacy'), info('acme/api')]));
    await signedIn();
    await h.sidebar.render();
    expect(rows().map((row) => row.repository)).toEqual(['acme/api', 'acme/legacy', 'majikmate/module-ts']);
    expect(rowOf('majikmate/module-ts').devspace).toBeUndefined();
    expect(rowOf('majikmate/module-ts').actions.canStart).toBe(true);
    expect(rowOf('majikmate/module-ts').description).toBe('');
    expect(rowOf('majikmate/module-ts').tooltip).toContain(TreeTexts.noDevspace);
    expect(JSON.stringify(h.models)).not.toContain(OLD);
    expect(rowOf('acme/legacy').actions.canStart).toBe(true);
    expect(rowOf('acme/api').actions.canStart).toBe(true);
  });

  it('shows the list and the devspaces of the new account after an account change, never those of the previous one', async () => {
    await h.registry.add(devspace(API, 'acme/api'));
    await h.registry.add(devspace(OLD, 'staussh/tools', { owner: OTHER }));
    h.discovery.loadStored.mockImplementation(async (accountId: string) =>
      accountId === OCTO.id ? data([info('scalarion/private')]) : data([info('staussh/public')]),
    );
    h.discovery.refresh.mockImplementation(() => new Promise(() => undefined));
    await h.sidebar.initialize();
    expect(rows().map((row) => row.repository).sort()).toEqual(['acme/api', 'scalarion/private']);

    h.auth.getAccount.mockResolvedValue(OTHER);
    void h.sidebar.onSessionChanged();
    await vi.waitFor(() => expect(h.sidebar.currentAccount).toEqual(OTHER));
    await h.sidebar.render();
    expect(h.discovery.loadStored).toHaveBeenLastCalledWith(OTHER.id);
    expect(rows().map((row) => row.repository).sort()).toEqual(['staussh/public', 'staussh/tools']);
    expect(JSON.stringify(h.models[h.models.length - 1])).not.toContain('scalarion');
  });

  it('refreshes with the token and the account of one session', async () => {
    await h.sidebar.initialize();
    await h.sidebar.refreshDiscovery();
    // Separate reads would give OCTO's token with OTHER's account after a switch between them.
    h.auth.getSession.mockResolvedValue({ token: 'gho_other', account: OTHER });
    await h.sidebar.refreshDiscovery({ again: true });
    expect(h.discovery.refresh).toHaveBeenLastCalledWith('gho_other', OTHER.id);
  });

  it('refreshes with the ID of the account, so the list is stored for that account', async () => {
    await h.sidebar.initialize();
    await h.sidebar.refreshDiscovery();
    expect(h.discovery.refresh).toHaveBeenCalledWith('gho_token', OCTO.id);
  });
});

describe('Sidebar: the time until the list is shown', () => {
  it('shows the complete list at once, before GitHub answered about the repositories that the list lacks', async () => {
    await h.registry.add(devspace(API, 'acme/api'));
    await h.registry.add(devspace(OLD, 'acme/old'));
    h.discovery.loadStored.mockResolvedValue(data([info('acme/stored')]));
    let answer: (value: RepositoryInfo | undefined) => void = () => undefined;
    h.discovery.getRepository.mockImplementation(() => new Promise<RepositoryInfo | undefined>((resolve) => (answer = resolve)));
    await h.sidebar.initialize();
    const refresh = h.sidebar.refreshDiscovery();
    await vi.waitFor(() => expect(h.discovery.getRepository).toHaveBeenCalledWith('acme/old', 'gho_token'));
    // The view renders the new list by itself (no render call of the test), while the question is open.
    await vi.waitFor(() => expect(rows().map((row) => row.repository).sort()).toEqual(['acme/api', 'acme/old']));
    expect(h.sidebar.discoveryData?.repositories.map((repository) => repository.nameWithOwner)).toEqual(['acme/api']);
    // Not known yet: no `not on GitHub` until GitHub answered.
    expect(rowOf('acme/old').notOnGitHub).toBe(false);
    answer(undefined);
    await refresh;
    await h.sidebar.render();
    expect(rowOf('acme/old').notOnGitHub).toBe(true);
  });

  it('asks GitHub about the repositories that the list lacks, at most 4 at the same time', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'].map((letter) => `${letter.repeat(8)}-1111-4111-8111-111111111111`);
    for (const [index, id] of ids.entries()) await h.registry.add(devspace(id, `acme/unlisted${index}`));
    let open = 0;
    let peak = 0;
    h.discovery.getRepository.mockImplementation(async (repository: string) => {
      open++;
      peak = Math.max(peak, open);
      await new Promise((resolve) => setTimeout(resolve, 5));
      open--;
      return info(repository);
    });
    await signedIn();
    expect(h.discovery.getRepository).toHaveBeenCalledTimes(6);
    expect(peak).toBe(4);
    await h.sidebar.render();
    expect(rows().every((row) => !row.notOnGitHub)).toBe(true);
  });

  it('reuses a running refresh when VS Code reports a session change of the same account with the same token', async () => {
    let finish: (value: DiscoveryData) => void = () => undefined;
    h.discovery.refresh.mockImplementation(() => new Promise<DiscoveryData>((resolve) => (finish = resolve)));
    await h.sidebar.initialize();
    await vi.waitFor(() => expect(h.discovery.refresh).toHaveBeenCalledTimes(1));
    const changed = h.sidebar.onSessionChanged();
    finish(data([info('acme/api')]));
    await changed;
    expect(h.discovery.refresh).toHaveBeenCalledTimes(1);
  });

  it('starts one more refresh after a session change with a new token, a new sign-in, or another account', async () => {
    let finish: (value: DiscoveryData) => void = () => undefined;
    h.discovery.refresh.mockImplementation(() => new Promise<DiscoveryData>((resolve) => (finish = resolve)));
    await h.sidebar.initialize();
    await vi.waitFor(() => expect(h.discovery.refresh).toHaveBeenCalledTimes(1));
    h.auth.getToken.mockResolvedValue('gho_new');
    const changed = h.sidebar.onSessionChanged();
    finish(data([info('acme/api')]));
    await vi.waitFor(() => expect(h.discovery.refresh).toHaveBeenCalledTimes(2));
    expect(h.discovery.refresh).toHaveBeenLastCalledWith('gho_new', OCTO.id);
    finish(data([info('acme/api')]));
    await changed;

    // Signed out, then signed in again: the sign-in loads the list, whatever runs.
    h.auth.isSignedIn.mockResolvedValue(false);
    await h.sidebar.onSessionChanged();
    h.auth.isSignedIn.mockResolvedValue(true);
    const signedInAgain = h.sidebar.onSessionChanged();
    await vi.waitFor(() => expect(h.discovery.refresh).toHaveBeenCalledTimes(3));
    finish(data([info('acme/api')]));
    await signedInAgain;
  });
});

describe('Sidebar and the scan scope (setting owners)', () => {
  const scoped = (repositories: RepositoryInfo[], scope: string[]): DiscoveryData => ({ ...data(repositories), scope });

  it('does not show a stored list of another scope, and shows the list of the refresh with the current scope', async () => {
    h.settings.owners = ['acme'];
    // A list without a scope: all repositories.
    h.discovery.loadStored.mockResolvedValue(data([info('acme/web'), info('octo/dotfiles')]));
    let finish: (value: DiscoveryData) => void = () => undefined;
    h.discovery.refresh.mockImplementation(() => new Promise<DiscoveryData>((resolve) => (finish = resolve)));
    await h.sidebar.initialize();
    await h.sidebar.render();
    expect(rows()).toEqual([]);
    expect(h.sidebar.discoveryData).toBeUndefined();
    expect(fakeVscode.commands.executeCommand).not.toHaveBeenCalledWith('setContext', LOADED_CONTEXT_KEY, true);
    expect(h.discovery.refresh).toHaveBeenCalledTimes(1);

    finish(scoped([info('acme/api')], ['acme']));
    await h.sidebar.refreshDiscovery();
    await h.sidebar.render();
    expect(rows().map((row) => row.repository)).toEqual(['acme/api']);
    expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith('setContext', LOADED_CONTEXT_KEY, true);
  });

  it('shows a stored list of the same scope at once, whatever the order and case of the setting', async () => {
    h.settings.owners = ['Beta', 'ACME'];
    h.discovery.loadStored.mockResolvedValue(scoped([info('acme/web')], ['acme', 'beta']));
    h.discovery.refresh.mockImplementation(() => new Promise(() => undefined));
    await h.sidebar.initialize();
    expect(rows().map((row) => row.repository)).toEqual(['acme/web']);
  });

  it('rescans at once after a change of the setting, and hides the list of the previous scope meanwhile', async () => {
    h.discovery.refresh.mockResolvedValue(scoped([info('acme/api'), info('octo/dotfiles')], []));
    await signedIn();
    await h.sidebar.render();
    expect(rows().map((row) => row.repository).sort()).toEqual(['acme/api', 'octo/dotfiles']);

    h.settings.owners = ['acme'];
    let finish: (value: DiscoveryData) => void = () => undefined;
    h.discovery.refresh.mockImplementation(() => new Promise<DiscoveryData>((resolve) => (finish = resolve)));
    const changed = h.sidebar.onScopeChanged();
    await vi.waitFor(() => expect(h.discovery.refresh).toHaveBeenCalledTimes(2));
    await h.sidebar.render();
    expect(rows()).toEqual([]);
    expect(fakeVscode.commands.executeCommand).toHaveBeenLastCalledWith('setContext', LOADED_CONTEXT_KEY, false);

    finish(scoped([info('acme/api')], ['acme']));
    await changed;
    await h.sidebar.render();
    expect(rows().map((row) => row.repository)).toEqual(['acme/api']);
  });

  it('does not show a list whose scope changed while it loaded', async () => {
    let finish: (value: DiscoveryData) => void = () => undefined;
    h.discovery.refresh.mockImplementation(() => new Promise<DiscoveryData>((resolve) => (finish = resolve)));
    await h.sidebar.initialize();
    await vi.waitFor(() => expect(h.discovery.refresh).toHaveBeenCalledTimes(1));
    h.settings.owners = ['acme'];
    finish(scoped([info('acme/api'), info('octo/dotfiles')], []));
    await h.sidebar.refreshDiscovery();
    await h.sidebar.render();
    expect(h.sidebar.discoveryData).toBeUndefined();
    expect(rows()).toEqual([]);
  });

  it('asks GitHub only about unlisted repositories of the scope, and keeps the others without `not on GitHub`', async () => {
    h.settings.owners = ['acme'];
    await h.registry.add(devspace(API, 'acme/api'));
    await h.registry.add(devspace(OLD, 'acme/unlisted'));
    await h.registry.add(devspace(GONE, 'octo/outside'));
    h.discovery.refresh.mockResolvedValue(scoped([info('acme/api')], ['acme']));
    await signedIn();
    await h.sidebar.render();
    expect(h.discovery.getRepository.mock.calls.map((call) => call[0])).toEqual(['acme/unlisted']);
    expect(rowOf('acme/unlisted').notOnGitHub).toBe(true);
    // Listed per the account rules, without a lookup and without the label.
    expect(rowOf('octo/outside').notOnGitHub).toBe(false);
    expect(rowOf('octo/outside').devspace?.id).toBe(GONE);
  });
});

describe('Sidebar progressive display', () => {
  const part = (repositories: RepositoryInfo[], accountId = OCTO.id) => ({ accountId, data: { ...data(repositories), scope: [] } });

  it('shows the repositories as they arrive during the first load, then the complete list', async () => {
    let finish: (value: DiscoveryData) => void = () => undefined;
    h.discovery.refresh.mockImplementation(() => new Promise<DiscoveryData>((resolve) => (finish = resolve)));
    await h.sidebar.initialize();
    await vi.waitFor(() => expect(h.discovery.refresh).toHaveBeenCalledTimes(1));

    h.sidebar.onPartialResult(part([info('acme/api')]));
    await h.sidebar.render();
    expect(rows().map((row) => row.repository)).toEqual(['acme/api']);
    expect(h.sidebar.repositoryInfo('acme/api')?.nameWithOwner).toBe('acme/api');
    h.sidebar.onPartialResult(part([info('acme/api'), info('acme/web')]));
    await h.sidebar.render();
    expect(rows().map((row) => row.repository)).toEqual(['acme/api', 'acme/web']);
    // The trust of an owner still waits for the complete list.
    expect(h.sidebar.discoveryData).toBeUndefined();

    finish(data([info('acme/api'), info('acme/web'), info('acme/zeta')]));
    await h.sidebar.refreshDiscovery();
    await h.sidebar.render();
    expect(rows().map((row) => row.repository)).toEqual(['acme/api', 'acme/web', 'acme/zeta']);
  });

  it('replaces a shown list only when the refresh is complete', async () => {
    h.discovery.loadStored.mockResolvedValue(data([info('acme/old')]));
    let finish: (value: DiscoveryData) => void = () => undefined;
    h.discovery.refresh.mockImplementation(() => new Promise<DiscoveryData>((resolve) => (finish = resolve)));
    await h.sidebar.initialize();
    await vi.waitFor(() => expect(h.discovery.refresh).toHaveBeenCalledTimes(1));
    h.sidebar.onPartialResult(part([info('acme/api')]));
    await h.sidebar.render();
    expect(rows().map((row) => row.repository)).toEqual(['acme/old']);
    finish(data([info('acme/api')]));
    await h.sidebar.refreshDiscovery();
    await h.sidebar.render();
    expect(rows().map((row) => row.repository)).toEqual(['acme/api']);
  });

  it('never shows the part of the first load of one account to another account', async () => {
    h.discovery.refresh.mockImplementation(() => new Promise<DiscoveryData>(() => undefined));
    await h.sidebar.initialize();
    await vi.waitFor(() => expect(h.discovery.refresh).toHaveBeenCalledTimes(1));
    h.sidebar.onPartialResult(part([info('octo/private-a')]));
    await h.sidebar.render();
    expect(rows().map((row) => row.repository)).toEqual(['octo/private-a']);
    // Another account signs in while the first load of OCTO still runs; it has no stored list.
    h.auth.getAccount.mockResolvedValue(OTHER);
    // The refresh of OTHER waits behind the running one; the view changes at once.
    void h.sidebar.onSessionChanged();
    await vi.waitFor(() => expect(h.sidebar.currentAccount?.id).toBe(OTHER.id));
    await h.sidebar.render();
    expect(rows()).toEqual([]);
    expect(h.sidebar.repositoryInfo('octo/private-a')).toBeUndefined();
  });

  it('stops showing the part of the first load when the scope changes', async () => {
    h.discovery.refresh.mockImplementation(() => new Promise<DiscoveryData>(() => undefined));
    await h.sidebar.initialize();
    await vi.waitFor(() => expect(h.discovery.refresh).toHaveBeenCalledTimes(1));
    h.sidebar.onPartialResult(part([info('octo/private-a'), info('acme/api')]));
    h.settings.owners = ['acme'];
    void h.sidebar.onScopeChanged();
    await h.sidebar.render();
    expect(rows()).toEqual([]);
    expect(h.sidebar.repositoryInfo('octo/private-a')).toBeUndefined();
    expect(h.sidebar.repositoryInfo('acme/api')).toBeUndefined();
  });

  // A rate limit of GitHub stops the refresh: what the view shows stays, the message says when the list loads again,
  // and one refresh runs at that time.
  it('keeps the part of the first load on a rate limit, says when it loads again, and tries once at that time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const resetAt = NOW + 30 * 60_000;
      const limited = new GitHubRateLimitError('GitHub refused the request for its rate limit: API rate limit exceeded', 200, resetAt);
      let fail: (error: unknown) => void = () => undefined;
      h.discovery.refresh.mockImplementationOnce(() => new Promise<DiscoveryData>((_resolve, reject) => (fail = reject)));
      h.discovery.refresh.mockRejectedValueOnce(limited);
      await h.sidebar.initialize();
      await vi.waitFor(() => expect(h.discovery.refresh).toHaveBeenCalledTimes(1));
      h.sidebar.onPartialResult(part([info('acme/api')]));
      fail(limited);
      await h.sidebar.refreshDiscovery();
      await h.sidebar.render();
      expect(rows().map((row) => row.repository)).toEqual(['acme/api']);
      // The time of the message and of the refresh: rounded up to the next full minute.
      const at = Math.ceil((resetAt + RATE_LIMIT_MARGIN_MS) / 60_000) * 60_000;
      const date = new Date(at);
      const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
      const warnings = () => fakeVscode.window.showWarningMessage.mock.calls.map((call: unknown[]) => call[0]);
      expect(warnings()).toEqual([Messages.gitHubRateLimited(time, true)]);
      // One refresh at that time, not before.
      await vi.advanceTimersByTimeAsync(at - NOW - 1);
      expect(h.discovery.refresh).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(h.discovery.refresh).toHaveBeenCalledTimes(2));
      // It meets the rate limit too: no further refresh of its own, and the message says from when Refresh works.
      await vi.waitFor(() => expect(warnings()).toHaveLength(2));
      expect(warnings()[1]).toBe(Messages.gitHubRateLimited(time, false));
      await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
      expect(h.discovery.refresh).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the part of the first load when the next refreshes meet the rate limit at once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const resetAt = NOW + 30 * 60_000;
      const limited = new GitHubRateLimitError('GitHub refused the request for its rate limit: API rate limit exceeded', 200, resetAt);
      let fail: (error: unknown) => void = () => undefined;
      h.discovery.refresh.mockImplementationOnce(() => new Promise<DiscoveryData>((_resolve, reject) => (fail = reject)));
      h.discovery.refresh.mockRejectedValue(limited);
      await h.sidebar.initialize();
      await vi.waitFor(() => expect(h.discovery.refresh).toHaveBeenCalledTimes(1));
      h.sidebar.onPartialResult(part([info('acme/api'), info('acme/web')]));
      fail(limited);
      await h.sidebar.refreshDiscovery();
      await h.sidebar.render();
      const shown = ['acme/api', 'acme/web'];
      expect(rows().map((row) => row.repository)).toEqual(shown);
      // The Refresh command before that time: GitHub refuses it at once.
      await h.sidebar.refreshDiscovery({ again: true });
      await h.sidebar.render();
      expect(h.discovery.refresh).toHaveBeenCalledTimes(2);
      expect(rows().map((row) => row.repository)).toEqual(shown);
      // The refresh at that time (the next full minute): GitHub refuses it at once too.
      await vi.advanceTimersByTimeAsync(Math.ceil((resetAt + RATE_LIMIT_MARGIN_MS) / 60_000) * 60_000 - NOW);
      await vi.waitFor(() => expect(h.discovery.refresh).toHaveBeenCalledTimes(3));
      await h.sidebar.refreshDiscovery();
      await h.sidebar.render();
      expect(rows().map((row) => row.repository)).toEqual(shown);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('one refresh after a rate limit', () => {
    const limitedUntil = (resetAt: number) =>
      new GitHubRateLimitError('GitHub refused the request for its rate limit: API rate limit exceeded', 200, resetAt);
    /** The local hour and minute of `time`. */
    const clock = (time: number) => {
      const date = new Date(time);
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    };
    /** The time of the refresh for a limit until `limitResetAt`, which the message names: the next full minute. */
    const plannedAt = (limitResetAt: number) => Math.ceil((limitResetAt + RATE_LIMIT_MARGIN_MS) / 60_000) * 60_000;
    const shownTime = (limitResetAt: number) => clock(plannedAt(limitResetAt));
    const warnings = () => fakeVscode.window.showWarningMessage.mock.calls.map((call: unknown[]) => call[0]);
    const resetAt = NOW + 30 * 60_000;

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('plans no second one when its time comes while another refresh runs that GitHub refuses too', async () => {
      let fail: (error: unknown) => void = () => undefined;
      const answeredLater = () => new Promise<DiscoveryData>((_resolve, reject) => (fail = reject));
      h.discovery.refresh
        .mockImplementationOnce(answeredLater)
        .mockImplementationOnce(answeredLater)
        .mockRejectedValue(limitedUntil(resetAt));
      await h.sidebar.initialize();
      await vi.waitFor(() => expect(h.discovery.refresh).toHaveBeenCalledTimes(1));
      fail(limitedUntil(resetAt));
      await h.sidebar.refreshDiscovery();
      // A Refresh of the user still waits for GitHub when that time comes.
      const other = h.sidebar.refreshDiscovery({ again: true, byUser: true });
      await vi.waitFor(() => expect(h.discovery.refresh).toHaveBeenCalledTimes(2));
      await vi.advanceTimersByTimeAsync(plannedAt(resetAt) - NOW);
      fail(limitedUntil(resetAt));
      await other;
      // The refresh of that time runs after it, and GitHub refuses it too.
      await vi.waitFor(() => expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Refresh can work again')));
      await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
      expect(h.discovery.refresh).toHaveBeenCalledTimes(3);
      expect(warnings()).toEqual([
        Messages.gitHubRateLimited(shownTime(resetAt), true),
        Messages.gitHubRateLimited(shownTime(resetAt), false),
      ]);
    });

    it('moves to a later time that GitHub names when another refresh meets the rate limit, never to an earlier one', async () => {
      const later = resetAt + 15 * 60_000;
      const earlier = resetAt - 15 * 60_000;
      let fail: (error: unknown) => void = () => undefined;
      h.discovery.refresh
        .mockImplementationOnce(() => new Promise<DiscoveryData>((_resolve, reject) => (fail = reject)))
        .mockRejectedValueOnce(limitedUntil(later))
        .mockRejectedValueOnce(limitedUntil(earlier))
        .mockRejectedValue(limitedUntil(later));
      await h.sidebar.initialize();
      await vi.waitFor(() => expect(h.discovery.refresh).toHaveBeenCalledTimes(1));
      fail(limitedUntil(resetAt));
      await h.sidebar.refreshDiscovery();
      // Two automatic refreshes, for example after changes of the setting owners.
      // GitHub names a later time: the planned refresh moves to it.
      await h.sidebar.refreshDiscovery({ again: true });
      // GitHub names an earlier time: the planned refresh stays at the later time, which a message named already.
      await h.sidebar.refreshDiscovery({ again: true });
      expect(h.discovery.refresh).toHaveBeenCalledTimes(3);
      expect(warnings()).toEqual([Messages.gitHubRateLimited(shownTime(resetAt), true), Messages.gitHubRateLimited(shownTime(later), true)]);
      // No refresh before the later time, then the one refresh.
      await vi.advanceTimersByTimeAsync(plannedAt(later) - NOW - 1);
      expect(h.discovery.refresh).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(warnings()).toHaveLength(3));
      expect(h.discovery.refresh).toHaveBeenCalledTimes(4);
      expect(warnings()[2]).toBe(Messages.gitHubRateLimited(shownTime(later), false));
      await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
      expect(h.discovery.refresh).toHaveBeenCalledTimes(4);
    });

    it('names the time again when GitHub refuses a Refresh of the user, but not when it refuses an automatic refresh', async () => {
      const earlier = resetAt - 15 * 60_000;
      let fail: (error: unknown) => void = () => undefined;
      h.discovery.refresh
        .mockImplementationOnce(() => new Promise<DiscoveryData>((_resolve, reject) => (fail = reject)))
        .mockRejectedValueOnce(limitedUntil(resetAt))
        .mockRejectedValueOnce(limitedUntil(resetAt))
        .mockRejectedValueOnce(limitedUntil(earlier))
        .mockRejectedValue(limitedUntil(resetAt));
      await h.sidebar.initialize();
      await vi.waitFor(() => expect(h.discovery.refresh).toHaveBeenCalledTimes(1));
      fail(limitedUntil(resetAt));
      await h.sidebar.refreshDiscovery();
      const named = Messages.gitHubRateLimited(shownTime(resetAt), true);
      expect(warnings()).toEqual([named]);
      // An automatic refresh, for example after a change of the setting owners: the same time, only the log says it.
      await h.sidebar.refreshDiscovery({ again: true });
      expect(warnings()).toEqual([named]);
      // The Refresh command: the same time, and the message again, so that the user sees why the list did not change.
      await h.sidebar.refreshDiscovery({ again: true, byUser: true });
      expect(warnings()).toEqual([named, named]);
      // An earlier time: the message names the time of the planned refresh.
      await h.sidebar.refreshDiscovery({ again: true, byUser: true });
      expect(warnings()).toEqual([named, named, named]);
      // The next automatic refresh is not one of the user.
      await h.sidebar.refreshDiscovery({ again: true });
      expect(h.discovery.refresh).toHaveBeenCalledTimes(5);
      expect(warnings()).toEqual([named, named, named]);
    });

    it('names a time rounded up to the next full minute, so that it is never too early', async () => {
      // The refresh at exactly 12:30:00 (UTC), then at one second after it.
      const exact = NOW + 30 * 60_000 - RATE_LIMIT_MARGIN_MS;
      let fail: (error: unknown) => void = () => undefined;
      h.discovery.refresh
        .mockImplementationOnce(() => new Promise<DiscoveryData>((_resolve, reject) => (fail = reject)))
        .mockRejectedValue(limitedUntil(exact + 1_000));
      await h.sidebar.initialize();
      await vi.waitFor(() => expect(h.discovery.refresh).toHaveBeenCalledTimes(1));
      fail(limitedUntil(exact));
      await h.sidebar.refreshDiscovery();
      await h.sidebar.refreshDiscovery({ again: true });
      expect(warnings()).toEqual([Messages.gitHubRateLimited(clock(NOW + 30 * 60_000), true), Messages.gitHubRateLimited(clock(NOW + 31 * 60_000), true)]);
    });

    it('plans the refresh at the minute that the message names, and names that minute once', async () => {
      // GitHub names 12:30:00 and then 12:30:30 (UTC): with RATE_LIMIT_MARGIN_MS, both times are before 12:31.
      let fail: (error: unknown) => void = () => undefined;
      h.discovery.refresh
        .mockImplementationOnce(() => new Promise<DiscoveryData>((_resolve, reject) => (fail = reject)))
        .mockRejectedValue(limitedUntil(resetAt + 30_000));
      await h.sidebar.initialize();
      await vi.waitFor(() => expect(h.discovery.refresh).toHaveBeenCalledTimes(1));
      fail(limitedUntil(resetAt));
      await h.sidebar.refreshDiscovery();
      await h.sidebar.refreshDiscovery({ again: true });
      const minute = NOW + 31 * 60_000;
      expect(warnings()).toEqual([Messages.gitHubRateLimited(clock(minute), true)]);
      expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining(`The list is loaded again at ${new Date(minute).toISOString()}.`));
      // The refresh at 12:31:00, not before.
      await vi.advanceTimersByTimeAsync(minute - NOW - 1);
      expect(h.discovery.refresh).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(h.discovery.refresh).toHaveBeenCalledTimes(3));
    });

    it('shows nothing and plans nothing for a refusal that comes after the view was closed', async () => {
      let fail: (error: unknown) => void = () => undefined;
      h.discovery.refresh.mockImplementationOnce(() => new Promise<DiscoveryData>((_resolve, reject) => (fail = reject)));
      await h.sidebar.initialize();
      await vi.waitFor(() => expect(h.discovery.refresh).toHaveBeenCalledTimes(1));
      const running = h.sidebar.refreshDiscovery();
      h.sidebar.dispose();
      fail(limitedUntil(resetAt));
      await running;
      await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
      expect(warnings()).toEqual([]);
      expect(h.logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('GitHub refused the update'));
    });

    // refreshIntervalMinutes 5 and a time in 50 minutes: without the wait, 10 more requests that GitHub refuses.
    it('asks GitHub nothing in the background while it waits', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      h.settings.refreshIntervalMinutes = 5;
      const reset = NOW + 50 * 60_000;
      let limited = true;
      let fail: (error: unknown) => void = () => undefined;
      h.discovery.refresh
        .mockImplementationOnce(() => new Promise<DiscoveryData>((_resolve, reject) => (fail = reject)))
        .mockImplementation(async () => {
          if (limited) throw limitedUntil(reset);
          return data([info('acme/api')]);
        });
      const refusals = () => h.logger.warn.mock.calls.filter(([text]) => String(text).startsWith('GitHub refused the update')).length;
      await h.sidebar.initialize();
      await vi.waitFor(() => expect(h.discovery.refresh).toHaveBeenCalledTimes(1));
      fail(limitedUntil(reset));
      await h.sidebar.refreshDiscovery();
      // The refreshes every 5 minutes wait for the planned one.
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      expect(h.discovery.refresh).toHaveBeenCalledTimes(1);
      // A Refresh that the user chooses still asks GitHub. Its refusal names the same time again.
      await h.sidebar.refreshDiscovery({ again: true, byUser: true });
      expect(h.discovery.refresh).toHaveBeenCalledTimes(2);
      expect(refusals()).toBe(2);
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(h.discovery.refresh).toHaveBeenCalledTimes(2);
      const named = Messages.gitHubRateLimited(shownTime(reset), true);
      expect(warnings()).toEqual([named, named]);
      // The planned refresh loads the list; after it, the refreshes every 5 minutes run again.
      limited = false;
      let load: (value: DiscoveryData) => void = () => undefined;
      h.discovery.refresh.mockImplementationOnce(() => new Promise<DiscoveryData>((resolve) => (load = resolve)));
      await vi.advanceTimersByTimeAsync(plannedAt(reset) - NOW - 50 * 60_000);
      await vi.waitFor(() => expect(h.discovery.refresh).toHaveBeenCalledTimes(3));
      // A refresh without `again` joins the planned one while it runs, so the test waits for its end. After the list is
      // shown, it still reads the registry (real files), and a refresh every 5 minutes would join it during that time.
      const planned = h.sidebar.refreshDiscovery();
      load(data([info('acme/api')]));
      await planned;
      expect(h.sidebar.discoveryData).toBeDefined();
      expect(h.discovery.refresh).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(h.discovery.refresh).toHaveBeenCalledTimes(4);
      expect(warnings()).toHaveLength(2);
    });
  });

  it('ignores a part of another account, of another scope, and after the refresh', async () => {
    let finish: (value: DiscoveryData) => void = () => undefined;
    h.discovery.refresh.mockImplementation(() => new Promise<DiscoveryData>((resolve) => (finish = resolve)));
    await h.sidebar.initialize();
    await vi.waitFor(() => expect(h.discovery.refresh).toHaveBeenCalledTimes(1));
    h.sidebar.onPartialResult(part([info('staussh/secret')], OTHER.id));
    h.sidebar.onPartialResult({ accountId: OCTO.id, data: { ...data([info('acme/api')]), scope: ['acme'] } });
    await h.sidebar.render();
    expect(rows()).toEqual([]);

    finish(data([]));
    await h.sidebar.refreshDiscovery();
    h.sidebar.onPartialResult(part([info('acme/late')]));
    await h.sidebar.render();
    expect(rows()).toEqual([]);
  });

  it('groups the rows with the setting repositoryGroups, and warns once per session about each invalid entry', async () => {
    h.discovery.refresh.mockResolvedValue(data([info('acme/web-shop'), info('acme/api')]));
    h.settings.repositoryGroups = ['(', { pattern: '^(web)-(.+)$', flags: 'g' }];
    await signedIn();
    await h.sidebar.render();
    const [group] = h.models[h.models.length - 1];
    expect(group.children.map((child) => [child.kind, child.label])).toEqual([['group', 'web']]);
    expect(rows().map((row) => [row.repository, row.label])).toEqual([['acme/web-shop', 'shop']]);

    const warnings = fakeVscode.window.showWarningMessage.mock.calls.map((call: unknown[]) => call[0] as string);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('The repository group "(" in the setting devspaces.repositoryGroups is ignored');
    expect(warnings[1]).toContain('uses the flags "g", which are ignored');
    for (const warning of warnings) expect(h.logger.warn).toHaveBeenCalledWith(warning);
    // Each warning has the button Edit Repository Groups…, which opens the editor of the setting.
    for (const call of fakeVscode.window.showWarningMessage.mock.calls) expect(call.slice(1)).toEqual([Actions.editRepositoryGroups]);

    // Each render compiles the patterns again, but a problem is shown only once.
    await h.sidebar.render();
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledTimes(2);
    // Another invalid entry is a new problem.
    h.settings.repositoryGroups = ['(', '['];
    await h.sidebar.render();
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledTimes(3);
    // Without valid entries, the view lists the repositories as without the setting.
    expect(rows().map((row) => row.label)).toEqual(['api', 'web-shop']);
  });

  it('gives the input of its last render, so the preview of the groups editor equals the view', async () => {
    const example = String.raw`^(\d{4}-[^-]+-[^-]+)-([^-]+-[^-]+)-(.+)$`;
    h.discovery.refresh.mockResolvedValue(
      data([
        info('school/2026-3cWI-SWP-module-oop-Student-A81'),
        info('school/2026-3cWI-SWP-module-oop-student-b-021'),
        info('school/2025-3bWI-SWP-module-oop-student-c'),
        info('school/website'),
      ]),
    );
    expect(h.sidebar.groupingInput()).toBeUndefined();
    const rendered = vi.fn();
    h.sidebar.onDidRender(rendered);
    h.settings.repositoryGroups = [example];
    await signedIn();
    await h.sidebar.render();
    expect(rendered).toHaveBeenCalled();
    const input = h.sidebar.groupingInput();
    expect(input?.repositoryGroups).toBeUndefined();
    const shown = h.models[h.models.length - 1];
    // The view is buildTreeModel of that input with the patterns of the setting.
    expect(buildTreeModel({ ...input!, repositoryGroups: parseRepositoryGroups(h.settings.repositoryGroups).patterns })).toEqual(shown);
    // The preview of the editor for the same setting shows the same tree and hides what the view hides.
    const preview = buildGroupsPreview(input, entriesFromSetting(h.settings.repositoryGroups).entries);
    const labels = (nodes: ReadonlyArray<{ label: string; children?: unknown }>): unknown[] =>
      nodes.map((node) => (Array.isArray(node.children) ? [node.label, labels(node.children as never)] : node.label));
    expect(preview.owners.map((owner) => [owner.owner, labels(owner.tree)])).toEqual(shown.map((group) => [group.owner, labels(group.children as never)]));
    expect(preview.owners[0].hidden).toEqual(['website']);
  });

  // Show Only Devspaces: the view lists the devspaces only; the preview of the groups editor still has every repository.
  it('with showOnlyDevspaces, shows no repository without a devspace, and gives the editor all of them', async () => {
    h.discovery.refresh.mockResolvedValue(data([info('acme/web'), info('acme/api')]));
    h.settings.showOnlyDevspaces = true;
    await signedIn();
    await h.sidebar.render();
    expect(h.models[h.models.length - 1]).toEqual([]);
    const input = h.sidebar.groupingInput();
    expect(input?.settings.showOnlyDevspaces).toBe(false);
    expect(repositoryRows(buildTreeModel(input!)).map((row) => row.repository)).toEqual(['acme/api', 'acme/web']);
  });

  // An entry that throws while it is matched does not break the view, and is logged once.
  it('renders when an entry of repositoryGroups throws while it is matched, and logs that once', async () => {
    h.discovery.refresh.mockResolvedValue(data([info('acme/web-shop'), info('acme/aaaa')]));
    h.settings.repositoryGroups = ['(?:(?:a?){10000}){3000}', '^(web)-(.+)$'];
    // The stack overflow of that pattern, without the time it takes; already for the first render.
    const original = RegExp.prototype.exec;
    const exec = vi.spyOn(RegExp.prototype, 'exec').mockImplementation(function (this: RegExp, text: string) {
      if (this.source.startsWith('(?:(?:a?)')) throw new RangeError('Maximum call stack size exceeded');
      return original.call(this, text);
    });
    try {
      await signedIn();
      await h.sidebar.render();
      await h.sidebar.render();
    } finally {
      exec.mockRestore();
    }
    expect(rows().map((row) => [row.repository, row.label])).toEqual([['acme/web-shop', 'shop']]);
    const failed = h.logger.warn.mock.calls.filter((call: unknown[]) => String(call[0]).includes('failed while it was matched'));
    expect(failed).toHaveLength(1);
    expect(String(failed[0][0])).toContain('Maximum call stack size exceeded');
  });

  it('runs the patterns of repositoryGroups in the worker only for names without a place, until the setting changes', async () => {
    h.discovery.refresh.mockResolvedValue(data([info('acme/web-shop'), info('acme/api')]));
    await signedIn();
    // Without patterns, nothing runs.
    expect(h.groupMatcher.runs).toEqual([]);
    h.settings.repositoryGroups = ['^(web)-(.+)$'];
    await h.sidebar.render();
    expect(h.groupMatcher.runs.map((run) => run.names)).toEqual([['api', 'web-shop']]);
    expect(rows().map((row) => [row.repository, row.label])).toEqual([['acme/web-shop', 'shop']]);
    // The places are kept: a render with the same names runs nothing.
    await h.sidebar.render();
    expect(h.groupMatcher.runs).toHaveLength(1);
    // A new repository: only its name runs.
    h.discovery.refresh.mockResolvedValue(data([info('acme/web-shop'), info('acme/api'), info('acme/web-blog')]));
    await h.sidebar.refreshDiscovery({ again: true });
    await h.sidebar.render();
    expect(h.groupMatcher.runs.map((run) => run.names)).toEqual([['api', 'web-shop'], ['web-blog']]);
    expect(rows().map((row) => row.label)).toEqual(['blog', 'shop']);
    // Another value of the setting: all names run again.
    h.settings.repositoryGroups = ['^(web)-(shop)$'];
    await h.sidebar.render();
    expect(h.groupMatcher.runs.at(-1)).toEqual({ entries: ['^(web)-(shop)$'], names: ['api', 'web-blog', 'web-shop'] });
    expect(rows().map((row) => row.label)).toEqual(['shop']);
  });

  it('places a repository with several sources (a node with a child row per source) by its name', async () => {
    const shop = { ...info('acme/web-shop'), configPaths: ['.devcontainer/devcontainer.json', '.devcontainer/python/devcontainer.json'] };
    h.discovery.refresh.mockResolvedValue(data([shop, info('acme/api')]));
    await signedIn();
    h.settings.repositoryGroups = ['^(web)-(.+)$'];
    await h.sidebar.render();
    expect(h.groupMatcher.runs.map((run) => run.names)).toEqual([['api', 'web-shop']]);
    const [group] = h.models[h.models.length - 1];
    expect(group.children.map((child) => [child.kind, child.label])).toEqual([['group', 'web']]);
    const [web] = group.children;
    const placed = web.kind === 'group' ? web.children : [];
    expect(placed.map((child) => [child.kind, child.label])).toEqual([['repositoryNode', 'shop']]);
    expect(rows().map((row) => [row.repository, row.label])).toEqual([
      ['acme/web-shop', 'config'],
      ['acme/web-shop', 'python'],
    ]);
  });

  it('lists the repositories without groups when the patterns take too long, says so once, and tries again after a change of the setting', async () => {
    h.discovery.refresh.mockResolvedValue(data([info('acme/web-shop'), info('acme/api')]));
    await signedIn();
    h.settings.repositoryGroups = ['^(web)-(.+)$', String.raw`^(\w+)+$`];
    h.groupMatcher.result = { tooSlow: true, slowEntry: 1 };
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.editRepositoryGroups);
    await h.sidebar.render();
    expect(rows().map((row) => row.label)).toEqual(['api', 'web-shop']);
    const warnings = () => fakeVscode.window.showWarningMessage.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(warnings()).toEqual([
      // The entry as JSON, as it is written in settings.json.
      'The repository group "^(\\\\w+)+$" in the setting devspaces.repositoryGroups took longer than 1 second for the names of your repositories, for example because of a nested repetition such as (a+)+. The view lists the repositories without groups until you change the setting.',
    ]);
    expect(h.logger.warn).toHaveBeenCalledWith(warnings()[0]);
    // The warning has the button Edit Repository Groups…, which opens the editor of the setting.
    expect(fakeVscode.window.showWarningMessage.mock.calls.map((call: unknown[]) => call.slice(1))).toEqual([[Actions.editRepositoryGroups]]);
    await vi.waitFor(() => expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith(Commands.editRepositoryGroups));
    // The view does not ask the worker again for this value of the setting.
    await h.sidebar.render();
    expect(h.groupMatcher.runs).toHaveLength(1);
    expect(warnings()).toHaveLength(1);
    // A changed setting runs again.
    h.groupMatcher.result = undefined;
    h.settings.repositoryGroups = ['^(web)-(.+)$'];
    await h.sidebar.render();
    expect(h.groupMatcher.runs).toHaveLength(2);
    expect(rows().map((row) => row.label)).toEqual(['shop']);
  });

  it('lists the repositories without groups when the worker fails, and says so once', async () => {
    h.discovery.refresh.mockResolvedValue(data([info('acme/web-shop'), info('acme/api')]));
    await signedIn();
    h.settings.repositoryGroups = ['^(web)-(.+)$'];
    h.groupMatcher.result = { failed: true };
    await h.sidebar.render();
    await h.sidebar.render();
    expect(rows().map((row) => row.label)).toEqual(['api', 'web-shop']);
    const warnings = fakeVscode.window.showWarningMessage.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(warnings).toEqual([
      'The repository groups of the setting devspaces.repositoryGroups could not be applied, because the separate thread that runs their regular expressions failed. The view lists the repositories without groups until you change the setting or reload the window.',
    ]);
    // The warning has the button Edit Repository Groups….
    expect(fakeVscode.window.showWarningMessage.mock.calls.map((call: unknown[]) => call.slice(1))).toEqual([[Actions.editRepositoryGroups]]);
  });

  it('runs a value of repositoryGroups again when it is set again after a value without entries', async () => {
    h.discovery.refresh.mockResolvedValue(data([info('acme/web-shop')]));
    await signedIn();
    const value = ['^(web)-(.+)$', String.raw`^(\w+)+$`];
    h.settings.repositoryGroups = value;
    h.groupMatcher.result = { tooSlow: true, slowEntry: 1 };
    await h.sidebar.render();
    expect(rows().map((row) => row.label)).toEqual(['web-shop']);
    h.settings.repositoryGroups = [];
    await h.sidebar.render();
    h.groupMatcher.result = undefined;
    h.settings.repositoryGroups = value;
    await h.sidebar.render();
    expect(h.groupMatcher.runs).toHaveLength(2);
    expect(rows().map((row) => row.label)).toEqual(['shop']);
  });

  it('shows no warning about the groups when the view ends while the worker runs', async () => {
    h.discovery.refresh.mockResolvedValue(data([info('acme/web-shop')]));
    await signedIn();
    let answer: (run: GroupMatchRun) => void = () => undefined;
    vi.spyOn(h.groupMatcher, 'run').mockImplementation(() => new Promise<GroupMatchRun>((resolve) => (answer = resolve)));
    h.settings.repositoryGroups = ['^(web)-(.+)$'];
    const rendered = h.sidebar.render();
    await vi.waitFor(() => expect(h.groupMatcher.run).toHaveBeenCalled());
    h.sidebar.dispose();
    answer({ failed: true });
    await rendered;
    expect(fakeVscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(h.logger.warn).not.toHaveBeenCalled();
  });

  it('shows no warning for a value of repositoryGroups that changed while the worker ran, and runs the new value', async () => {
    h.discovery.refresh.mockResolvedValue(data([info('acme/web-shop')]));
    await signedIn();
    let answer: (run: GroupMatchRun) => void = () => undefined;
    // The first job waits for the answer of the test; the later jobs run as before.
    const run = vi.spyOn(h.groupMatcher, 'run').mockImplementationOnce(() => new Promise<GroupMatchRun>((resolve) => (answer = resolve)));
    h.settings.repositoryGroups = [String.raw`^(\w+)+$`];
    const rendered = h.sidebar.render();
    await vi.waitFor(() => expect(run).toHaveBeenCalled());
    // The user fixes the value while its job runs; then the job of the old value ends as too slow.
    h.settings.repositoryGroups = ['^(web)-(.+)$'];
    answer({ tooSlow: true, slowEntry: 0 });
    await rendered;
    await h.sidebar.render();
    expect(fakeVscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(h.logger.warn).not.toHaveBeenCalled();
    expect(run.mock.calls.map(([entries]) => entries)).toEqual([[String.raw`^(\w+)+$`], ['^(web)-(.+)$']]);
    expect(rows().map((row) => row.label)).toEqual(['shop']);
  });

  it('shows no part of a first load that failed', async () => {
    let fail: (error: Error) => void = () => undefined;
    h.discovery.refresh.mockImplementation(() => new Promise<DiscoveryData>((_resolve, reject) => (fail = reject)));
    await h.sidebar.initialize();
    await vi.waitFor(() => expect(h.discovery.refresh).toHaveBeenCalledTimes(1));
    h.sidebar.onPartialResult(part([info('acme/api')]));
    await h.sidebar.render();
    expect(rows()).toHaveLength(1);
    fail(new Error('getaddrinfo ENOTFOUND api.github.com'));
    await h.sidebar.refreshDiscovery();
    await h.sidebar.render();
    expect(rows()).toEqual([]);
    expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith('setContext', LOAD_FAILED_CONTEXT_KEY, true);
  });
});
