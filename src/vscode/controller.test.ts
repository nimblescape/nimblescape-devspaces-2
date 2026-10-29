// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { deleteCheck as runDeleteCheck, type DeleteDecision } from '../core/pipeline/deleteCheck';
import { VsCodePipelineUi } from './pipelineUi';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import type { ContainerInfo } from '../core/docker/dockerObjects';
import { containerIsCurrent, isUnrestrictedContainer } from '../core/pipeline/pipelineRules';
import { hostAccessChecks } from '../core/policy/hostAccessChecks';
import type { TokenRemoveValue, WindowStateValue } from '../core/helperChannel/protocol';
import { DockerContextKeys } from '../core/docker/dockerSetup';
import { UserFacingError } from '../core/errors';
import { GitHubApiError } from '../core/discovery/githubApi';
import { Actions, Messages, dockerHostReason } from '../core/messages';
import { removalEndedNote } from '../core/docker/engineRemoval';
import { CONTAINER_VERSION, HOST_ACCESS_UNRESTRICTED, LABEL_CONTAINER_VERSION, LABEL_HOST_ACCESS } from '../core/names';
import { OP_TOKEN_REMOVE } from '../core/helperChannel/protocol';
import type { OpenOptions, OpenResult, OperationOptions, RepositoryTarget } from '../core/pipeline/operationBase';
import { PipelineTexts } from '../core/pipeline/operationBase';
import { removeTokenThroughWorker } from '../core/pipeline/devspaceOperations';
import { DockerEngineRecords, type EngineRemoval } from '../core/storage/dockerEngineRecords';
import { StoragePaths } from '../core/storage/paths';
import { DevspaceRegistry } from '../core/storage/registry';
import { SessionFiles } from '../core/storage/sessionFiles';
import { isHandedOffStop } from '../core/session/windowRelease';
import { PENDING_MAX_AGE_MS } from '../core/busy';
import { availableDevspaces } from '../core/ownership';
import { dockerTargetOf, remoteDockerTarget, type DockerTarget } from '../core/docker/dockerHost';
import { DockerTargets, operationDockerTarget, runWithDockerTarget } from '../core/docker/dockerTargets';
import { silentLogger } from '../core/ports';
import type { AccountListing, Devspace, DevspaceSource, DiscoveryData, ExtensionSettings, GitHubAccount, GitSummary, RepositoryInfo, WindowStatus } from '../core/types';
import { GITHUB_ENTERPRISE_CONTEXT_KEY, SIGNED_IN_CONTEXT_KEY } from './auth';
import { Commands } from './commands';
import { CONNECTED_CONTEXT_KEY, Controller, HELPER_BUILDS_STOP_WAIT_MS, type ControllerDeps } from './controller';
import { placeholderRepositoryInfo } from './targets';
import { ControllerTexts } from './controllerTexts';
import { DisconnectRequests } from './disconnectRequests';
import { DOUBLE_CLICK_INTERVAL_MS, type ListOpenMode } from './rowActivation';
import { DEFAULT_SETTINGS, SETTINGS_SECTION } from './settings';
import { LOADED_CONTEXT_KEY, LOAD_FAILED_CONTEXT_KEY } from './sidebar';
import { DEVSPACES_ONLY_CONTEXT_KEY } from './devspacesOnly';
import { SwitcherTexts } from './switcher';
import { contextValue as treeContextValue, REPOSITORY_NODE_CONTEXT, rowActions, type OwnerGroup } from './treeModel';
import type { RemoteDockerCommands } from './remoteDockerCommands';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';

const NOW = Date.parse('2026-09-25T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const WINDOW_ID = 'window-1';
const OTHER_WINDOW_ID = 'window-2';
const OTHER_PID = 4242;
const ENV_ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
/** The default image of the setting devspaces.defaultImage in these tests. */
const DEFAULT_IMAGE = 'ghcr.io/majikmate/devcontainer-base:latest';
const OTHER_ENV_ID = '7c1d2e3f-0000-4000-8000-000000000002';
const CONTAINER = 'devspaces-acme-api-3f2a9c1e';
/** The signed-in account; the devspaces of the tests belong to it unless a test names another owner. */
const ACCOUNT: GitHubAccount = { id: '1001', login: 'octo' };
const OTHER_ACCOUNT: GitHubAccount = { id: '2002', login: 'someone' };

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

function devspace(overrides: Partial<Devspace> = {}): Devspace {
  return {
    id: ENV_ID,
    repository: 'acme/api',
    configPath: '.devcontainer/devcontainer.json',
    volumeName: CONTAINER,
    containerName: CONTAINER,
    createdAt: iso(NOW - 86_400_000),
    lastUsedAt: iso(NOW - 3_600_000),
    remoteWorkspaceFolder: '/workspaces/api',
    gitSummary: { branch: 'main', uncommittedFiles: 0, unpushedCommits: 0, stashes: 0, recordedAt: iso(NOW - 3_600_000) },
    owner: ACCOUNT,
    ...overrides,
  };
}

function repositoryInfo(nameWithOwner: string, overrides: Partial<RepositoryInfo> = {}): RepositoryInfo {
  const [owner, name] = nameWithOwner.split('/');
  return {
    nameWithOwner,
    owner,
    name,
    url: `https://github.com/${nameWithOwner}`,
    isArchived: false,
    isFork: false,
    isPrivate: true,
    pushedAt: iso(NOW - 1000),
    defaultBranch: 'main',
    configPaths: ['.devcontainer/devcontainer.json'],
    ...overrides,
  };
}

/**
 * The container of the devspace as `docker.findContainer` gives it; `version` is its label
 * nimblescape.devspaces.container-version.
 */
/**
 * The token removal is a flow of the worker, so the controller sends the operation `tokenRemove`.
 */
function tokenRemovals(): number {
  return h.flow.mock.calls.filter((call) => call[0] === OP_TOKEN_REMOVE).length;
}

function containerInfo(version: string | undefined): ContainerInfo {
  return {
    id: 'c0ffee',
    name: CONTAINER,
    state: 'running',
    rawState: 'running',
    image: 'devspaces-acme-api:1',
    labels: version === undefined ? {} : { [LABEL_CONTAINER_VERSION]: version },
  };
}

function openResult(env: Devspace): OpenResult {
  return { devspace: env, containerName: env.containerName, remoteWorkspaceFolder: env.remoteWorkspaceFolder ?? '/workspaces/api' };
}

/** A row of the sidebar as the menus pass it: the one row of a repository, or a child row with its source. */
function row(repository: string, env?: Devspace, info?: RepositoryInfo, source?: DevspaceSource): unknown {
  return { kind: 'repository', id: `repo:${repository}`, repository, info, devspace: env, ...(source !== undefined ? { source } : {}) };
}

const ROOT_SOURCE: DevspaceSource = { kind: 'configuration', configPath: '.devcontainer/devcontainer.json' };
const PYTHON_SOURCE: DevspaceSource = { kind: 'configuration', configPath: '.devcontainer/python/devcontainer.json' };
const DEFAULT_SOURCE: DevspaceSource = { kind: 'defaultImage', image: DEFAULT_IMAGE };

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Waits until the pending promise callbacks (file I/O included) have run. */
async function settle(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Harness {
  /** The flows that the controller sends to the worker (the token removal). */
  flow: ReturnType<typeof vi.fn>;
  root: string;
  paths: StoragePaths;
  registry: DevspaceRegistry;
  sessionFiles: SessionFiles;
  disconnectRequests: DisconnectRequests;
  controller: Controller;
  commands: Map<string, (argument?: unknown) => Promise<void>>;
  docker: {
    isInstalled: ReturnType<typeof vi.fn>;
    isRunning: ReturnType<typeof vi.fn>;
    containerState: ReturnType<typeof vi.fn>;
    findContainer: ReturnType<typeof vi.fn>;
    exec: ReturnType<typeof vi.fn>;
    volumeExists: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn>;
    processEnv: ReturnType<typeof vi.fn>;
  };
  service: {
    openInWorker: ReturnType<typeof vi.fn<(target: RepositoryTarget, options: OpenOptions) => Promise<OpenResult>>>;
    openDevspaceInWorker: ReturnType<typeof vi.fn<(id: string, options: OpenOptions) => Promise<OpenResult>>>;
    stop: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>;
    safetyCheck: ReturnType<typeof vi.fn<(id: string, options: OperationOptions) => Promise<GitSummary | undefined>>>;
    /** The paths in the repository that the containers of the services mount. */
    repositoryServiceData: ReturnType<typeof vi.fn<(id: string) => Promise<string[]>>>;
    deleteInWorker: ReturnType<typeof vi.fn<(id: string, options: OperationOptions & { additionalVolumesToRemove: readonly string[] }) => Promise<void>>>;
    /** The check of Delete and its questions in the worker (the fake runs deleteCheck.ts, below). */
    deleteCheckInWorker: ReturnType<typeof vi.fn<(id: string, options: OperationOptions & { repository: string; otherWindow: boolean }) => Promise<DeleteDecision>>>;
    // The controller lists through the worker (listConfigurationsInWorker).
    listConfigurationsInWorker: ReturnType<typeof vi.fn<(id: string, options: OperationOptions) => Promise<string[]>>>;
    /** The branch that the fake worker reads (windowStateInWorker with `branch`). */
    currentBranch: ReturnType<typeof vi.fn<(id: string) => Promise<string | undefined>>>;
    windowStateInWorker: ReturnType<typeof vi.fn<(devspace: Devspace, containerName: string, options?: { branch?: boolean; signal?: AbortSignal }) => Promise<WindowStateValue | undefined>>>;
    // The restore runs in the worker (reconcileInWorker).
    reconcileInWorker: ReturnType<typeof vi.fn<(options: { passive: boolean }) => Promise<number>>>;
    /** The token removal, sent by the operations of the window over `flow`. */
    removeTokenInWorker: ReturnType<typeof vi.fn<(devspaceId: string, containerName: string) => Promise<TokenRemoveValue>>>;
    // The three reads of this fake service are its own fixtures (the tests of the dialogs of Delete give each list),
    // which its deleteCheckInWorker joins into the one read of the removable volumes (removableVolumes);
    // DevspaceService has only removableVolumesOf.
    removableAdditionalVolumes: ReturnType<typeof vi.fn<(id: string) => Promise<string[]>>>;
    removableServiceDataVolumes: ReturnType<typeof vi.fn<(id: string) => Promise<string[]>>>;
    possibleServiceDataVolumes: ReturnType<typeof vi.fn<(id: string) => Promise<string[]>>>;
  };
  connection: {
    open: ReturnType<typeof vi.fn<(containerName: string, folder: string) => Promise<void>>>;
    openInNewWindow: ReturnType<typeof vi.fn<(containerName: string, folder: string) => Promise<void>>>;
    closeRemoteConnection: ReturnType<typeof vi.fn<() => Promise<void>>>;
    closeWindow: ReturnType<typeof vi.fn<() => Promise<void>>>;
    isEmptyWindow: ReturnType<typeof vi.fn<() => boolean>>;
    currentContainerName: ReturnType<typeof vi.fn<() => string | undefined>>;
    currentDockerContext: ReturnType<typeof vi.fn<() => string | undefined>>;
  };
  coordinator: {
    windowId: string;
    writePending: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>;
    otherActiveWindows: ReturnType<typeof vi.fn<() => Promise<WindowStatus[]>>>;
    setDevspace: ReturnType<typeof vi.fn>;
    setPlainDevspace: ReturnType<typeof vi.fn>;
  };
  auth: {
    getToken: ReturnType<typeof vi.fn>;
    getAccount: ReturnType<typeof vi.fn>;
    getSession: ReturnType<typeof vi.fn>;
    isSignedIn: ReturnType<typeof vi.fn>;
    updateContextKey: ReturnType<typeof vi.fn>;
    renewToken: ReturnType<typeof vi.fn>;
    accounts: ReturnType<typeof vi.fn>;
    addAccount: ReturnType<typeof vi.fn>;
  };
  dockerSetup: Record<'install' | 'start' | 'installWsl' | 'show', ReturnType<typeof vi.fn>>;
  /** The single lookup of a repository on GitHub; by default GitHub does not show it. */
  discovery: { getRepository: Mock<(repository: string, token: string) => Promise<RepositoryInfo | undefined>> };
  repositoryGroupsEditor: { open: ReturnType<typeof vi.fn> };
  sidebar: {
    infos: Map<string, RepositoryInfo>;
    render: ReturnType<typeof vi.fn>;
    refreshStates: ReturnType<typeof vi.fn>;
    repositoriesForPicker: ReturnType<typeof vi.fn>;
    model: () => OwnerGroup[];
    trustedOwner: ReturnType<typeof vi.fn>;
    onSessionChanged: ReturnType<typeof vi.fn>;
    refreshDiscovery: ReturnType<typeof vi.fn>;
    availableDevspaces: Mock<() => Promise<Devspace[]>>;
    accountListings: Mock<() => AccountListing[]>;
  };
  statusBar: Record<'showConnected' | 'showNotConnected' | 'showBusy' | 'clearBusy' | 'showConnectionLost' | 'showStateUnknown', ReturnType<typeof vi.fn>>;
  logger: Record<'info' | 'warn' | 'error' | 'output' | 'show', ReturnType<typeof vi.fn>>;
  progressTitles: string[];
  alive: Set<number>;
  settings: ExtensionSettings;
  /** The clock of the controller, the registry and the session files; a test may replace `now`. */
  clock: { now: () => number };
  /** The VS Code setting workbench.list.openMode (double-click on a row); a test may change it. */
  listOpenMode: { value: ListOpenMode };
  /** Shows a row of the view (treeView.ts revealRow). */
  revealRow: Mock<(rowId: string) => Promise<void>>;
  /** The question about the Monitor of an engine (MonitorQuestion); by default the engine has its answer. */
  monitorQuestion: { askIfNeeded: Mock<(host: string, removalRuns?: () => Promise<(removal: EngineRemoval) => boolean>) => Promise<string>> };
  /** docker-engines.json of the storage folder of the test (the removal mark). */
  engineRecords: DockerEngineRecords;
}

function createHarness(
  options: {
    handOffCheckMs?: number;
    leaveCheckMs?: number;
    tokenRemoveWaitMs?: number;
    disconnectAnswerMs?: number;
    /** The current Docker host and the remote Docker commands. Default: none (the local Docker). */
    dockerTargets?: ControllerDeps['dockerTargets'];
    remoteDocker?: ControllerDeps['remoteDocker'];
    /** The Docker pipe of the window of a devspace. Default: none. */
    windowDockerHost?: ControllerDeps['windowDockerHost'];
    /** The heartbeat of Close and Keep Running (on every engine). */
    sessionMonitor?: ControllerDeps['sessionMonitor'];
    /** The pause between the checks of the container (default 0). */
    readyPollMs?: number;
    /** "Remove Devspaces from This Docker Engine…". Default: none (the command does nothing). */
    engineRemoval?: ControllerDeps['engineRemoval'];
    /** "Update All Images Now". Default: none (the command does nothing). */
    updateImagesNow?: ControllerDeps['updateImagesNow'];
    /** The step "Docker start" that "Update All Images Now" runs in its progress. Default: none. */
    startDocker?: ControllerDeps['startDocker'];
    /** The longest wait of a removal for the background builds of the helper image (default 60 s). */
    helperBuildsStopWaitMs?: number;
  } = {},
): Harness {
  const monitorQuestion = { askIfNeeded: vi.fn(async (_host: string, _removalRuns?: () => Promise<(removal: EngineRemoval) => boolean>): Promise<string> => 'notNeeded') };
  const listOpenMode: Harness['listOpenMode'] = { value: 'singleClick' };
  const revealRow = vi.fn(async (_rowId: string): Promise<void> => {});
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-test-'));
  const clock = { now: () => NOW };
  const paths = new StoragePaths(root);
  paths.ensureDirectoriesSync();
  const registry = new DevspaceRegistry(paths, clock);
  const engineRecords = new DockerEngineRecords(paths.dockerEngines);
  const sessionFiles = new SessionFiles(paths, clock);
  const disconnectRequests = new DisconnectRequests(root);
  const alive = new Set<number>([process.pid]);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn(), show: vi.fn() };
  const docker = {
    isInstalled: vi.fn(() => true),
    isRunning: vi.fn(async () => true),
    containerState: vi.fn(async (_name: string) => 'running'),
    // A container of the current setup, unless a test gives another label.
    findContainer: vi.fn(async (_id: string) => containerInfo(String(CONTAINER_VERSION))),
    exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false })),
    volumeExists: vi.fn(async (_name: string) => true),
    // The Docker calls of the attach diagnostics: answered, never failing.
    run: vi.fn(async (_args: readonly string[]) => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false })),
    processEnv: vi.fn(() => ({})),
  };
  const service: Harness['service'] = {
    openInWorker: vi.fn(async () => openResult(devspace())),
    openDevspaceInWorker: vi.fn(async (id: string) => openResult((await registry.get(id)) ?? devspace())),
    stop: vi.fn(async () => {}),
    safetyCheck: vi.fn(async () => undefined),
    repositoryServiceData: vi.fn(async () => []),
    // The controller sends Delete to the worker (deleteInWorker).
    deleteInWorker: vi.fn(async () => {}),
    listConfigurationsInWorker: vi.fn(async () => ['.devcontainer/devcontainer.json']),
    currentBranch: vi.fn(async () => undefined),
    // The token removal of the operations of the window (removeTokenThroughWorker, the production code) over the fake
    // flow of this harness, so that the tests below see the flow it sends.
    removeTokenInWorker: vi.fn((devspaceId: string, containerName: string) => removeTokenThroughWorker(flow, devspaceId, containerName)),
    // The reads of the window as the worker answers them, over the Docker fakes of this harness; a read that fails is
    // unknown (undefined).
    windowStateInWorker: vi.fn(async (env: Devspace, containerName: string, options: { branch?: boolean } = {}) => {
      try {
        const state = (await docker.containerState(containerName)) as WindowStateValue['state'];
        const value: WindowStateValue = { state };
        const container = (await (docker.findContainer as (id: string, name: string) => Promise<unknown>)(env.id, env.containerName)) as ContainerInfo | undefined;
        const checks = hostAccessChecks(env.repository, settings);
        if (container !== undefined && !containerIsCurrent(container.labels, true, checks)) {
          value.outdated = containerIsCurrent(container.labels, true, 'off') && isUnrestrictedContainer(container.labels) ? 'hostAccess' : 'version';
        }
        if (options.branch) {
          const branch = await service.currentBranch(env.id);
          if (branch !== undefined) value.branch = branch;
        }
        return value;
      } catch {
        return undefined;
      }
    }),
    reconcileInWorker: vi.fn(async (_options: { passive: boolean }) => 0),
    // By default, Delete could remove every recorded volume (their labels make them the devspace's own).
    removableAdditionalVolumes: vi.fn(async (id: string) => (await registry.get(id))?.additionalVolumes ?? []),
    // No volumes of a Docker Compose project, unless a test gives them.
    removableServiceDataVolumes: vi.fn(async () => []),
    // The check of Delete runs in the worker; this fake runs the same function there (deleteCheck.ts) over the reads of
    // this fake service and the questions of VsCodePipelineUi, so the tests below cover the dialogs of Delete.
    deleteCheckInWorker: vi.fn(async (id: string, options: OperationOptions & { repository: string; otherWindow: boolean }): Promise<DeleteDecision> => {
      const entry = await registry.get(id);
      if (!entry) return { decision: 'cancel' };
      return runDeleteCheck(
        {
          summary: () => service.safetyCheck(id, options),
          devspace: () => registry.get(id),
          repositoryServiceData: () => service.repositoryServiceData(id),
          // The one dep of the removable volumes (removableVolumes), here from the reads of this fake service, so the
          // tests below cover the dialogs of Delete.
          removableVolumes: async () => ({
            additional: await service.removableAdditionalVolumes(id),
            serviceData: await service.removableServiceDataVolumes(id),
            possibly: await service.possibleServiceDataVolumes(id),
          }),
          ui: new VsCodePipelineUi({} as never, silentLogger, () => {}),
        },
        entry,
        options.repository,
        options.otherWindow,
      );
    }),
    // None of a devspace whose services are not known, unless a test gives them.
    possibleServiceDataVolumes: vi.fn(async () => []),
  };
  const connection: Harness['connection'] = {
    open: vi.fn(async () => {}),
    openInNewWindow: vi.fn(async () => {}),
    closeRemoteConnection: vi.fn(async () => {}),
    closeWindow: vi.fn(async () => {}),
    isEmptyWindow: vi.fn(() => false),
    currentContainerName: vi.fn(() => undefined),
    currentDockerContext: vi.fn(() => undefined),
  };
  const coordinator: Harness['coordinator'] = {
    windowId: WINDOW_ID,
    writePending: vi.fn((id: string) => sessionFiles.writePending(id, WINDOW_ID)),
    otherActiveWindows: vi.fn(async () => []),
    setDevspace: vi.fn(async () => {}),
    setPlainDevspace: vi.fn(async () => {}),
  };
  const auth = {
    getToken: vi.fn(async () => 'gho_token'),
    getAccount: vi.fn(async (): Promise<GitHubAccount | undefined> => ACCOUNT),
    // One session: the token and the account that getToken and getAccount give, unless a test changes it.
    getSession: vi.fn(async (): Promise<{ token: string; account: GitHubAccount } | undefined> => {
      const [token, account] = [await auth.getToken(), await auth.getAccount()];
      return token && account ? { token, account } : undefined;
    }),
    isSignedIn: vi.fn(async () => true),
    updateContextKey: vi.fn(async () => true),
    // The new sign-in after GitHub rejected the token; by default the user cancels it.
    renewToken: vi.fn(async (): Promise<string | undefined> => undefined),
    // The accounts of Devspaces: by default the one account of getAccount (a test of several accounts sets them).
    accounts: vi.fn(async (): Promise<GitHubAccount[]> => {
      const account = await auth.getAccount();
      return account ? [account] : [];
    }),
    // Add GitHub Account…: by default the user cancels the picker.
    addAccount: vi.fn(async (): Promise<GitHubAccount | undefined> => undefined),
  };
  const dockerSetup = {
    install: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    installWsl: vi.fn(async () => {}),
    show: vi.fn(async () => {}),
  };
  const repositoryGroupsEditor = { open: vi.fn(async () => {}) };
  const discovery = { getRepository: vi.fn(async (_repository: string, _token: string): Promise<RepositoryInfo | undefined> => undefined) };
  const infos = new Map<string, RepositoryInfo>();
  const sidebar = {
    infos,
    render: vi.fn(async () => {}),
    refreshStates: vi.fn(async () => {}),
    repositoryInfo: (repository: string) => infos.get(repository.toLowerCase()),
    liveBranch: () => undefined,
    repositoriesForPicker: vi.fn(async () => [...infos.values()]),
    availableDevspaces: vi.fn(async () => availableDevspaces(await registry.list(), await auth.accounts())),
    accountListings: vi.fn((): AccountListing[] => []),
    accountList: vi.fn((_accountId: string): DiscoveryData | undefined => undefined),
    model: () => [],
    trustedOwner: vi.fn(async () => true),
    refreshDiscovery: vi.fn(async () => undefined),
    onSessionChanged: vi.fn(async () => {}),
  };
  const statusBar = {
    showConnected: vi.fn(),
    showNotConnected: vi.fn(),
    showBusy: vi.fn(),
    clearBusy: vi.fn(),
    showConnectionLost: vi.fn(),
    showStateUnknown: vi.fn(),
  };
  const settings = { ...SETTINGS };
  const flow = vi.fn(async (op: string, _params: unknown): Promise<unknown> => (op === OP_TOKEN_REMOVE ? { outcome: 'removed', container: 'c0ffeec0ffee' } : {}));
  const deps = {
    logger,
    registry,
    registryNeedsRestore: () => registry.needsRestore(),
    sessionFiles,
    disconnectRequests,
    docker,
    // The flows that run in the worker (the token removal; the flow itself is tested in
    // src/core/worker/tokenRemoveFlow.test.ts): `flow` goes to the controller through `service` (removeTokenInWorker)
    // only.
    service,
    discovery,
    auth,
    connection,
    coordinator,
    sidebar,
    statusBar,
    settings: () => settings,
    dockerSetup,
    repositoryGroupsEditor,
    viewVisible: () => false,
    dockerTargets: options.dockerTargets,
    remoteDocker: options.remoteDocker,
    windowDockerHost: options.windowDockerHost,
    sessionMonitor: options.sessionMonitor,
    monitorQuestion,
    engineRecords,
    engineRemoval: options.engineRemoval,
    updateImagesNow: options.updateImagesNow,
    startDocker: options.startDocker,
    listOpenMode: () => listOpenMode.value,
    // A promise of its own: vitest handles the promises that a mock returns, so a rejection would never be unhandled.
    revealRow: async (rowId: string) => revealRow(rowId),
    clock,
    isAlive: (pid: number) => alive.has(pid),
    timing: {
      handOffCheckMs: options.handOffCheckMs ?? 60_000,
      leaveCheckMs: options.leaveCheckMs ?? 60_000,
      tokenRemoveWaitMs: options.tokenRemoveWaitMs ?? 60_000,
      helperBuildsStopWaitMs: options.helperBuildsStopWaitMs ?? 60_000,
      reopenCheckDelayMs: 0,
      disconnectAnswerMs: options.disconnectAnswerMs ?? 60_000,
      busyPollMs: 5,
      readyPollMs: options.readyPollMs ?? 0,
    },
  } as unknown as ControllerDeps;
  const controller = new Controller(deps);

  const commands = new Map<string, (argument?: unknown) => Promise<void>>();
  fakeVscode.commands.registerCommand.mockImplementation((id: string, handler: (argument?: unknown) => Promise<void>) => {
    commands.set(id, handler);
    return { dispose() {} };
  });
  controller.registerCommands();

  const progressTitles: string[] = [];
  fakeVscode.window.withProgress.mockImplementation(async (_options: unknown, task: (...args: unknown[]) => Promise<unknown>) =>
    task(
      { report: (value: { message?: string }) => progressTitles.push(value.message ?? '') },
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
    ),
  );

  return {
    root,
    paths,
    registry,
    sessionFiles,
    disconnectRequests,
    controller,
    commands,
    docker,
    flow,
    service,
    connection,
    coordinator,
    auth,
    dockerSetup,
    discovery,
    repositoryGroupsEditor,
    sidebar,
    statusBar,
    logger,
    progressTitles,
    alive,
    settings,
    clock,
    listOpenMode,
    revealRow,
    monitorQuestion,
    engineRecords,
  };
}

let h: Harness;

beforeEach(() => {
  resetFakeVscode();
  h = createHarness();
});

afterEach(() => {
  h.controller.dispose();
  fs.rmSync(h.root, { recursive: true, force: true });
});

function run(command: keyof typeof Commands, argument?: unknown): Promise<void> {
  const handler = h.commands.get(Commands[command]);
  if (!handler) throw new Error(`Command ${command} is not registered`);
  return handler(argument);
}

/** Makes this window the window of `env` (role A after our own Start: the pipeline has just run). */
async function connectHere(env: Devspace): Promise<void> {
  const reads = h.service.currentBranch.mock.calls.length;
  await h.controller.openAttachedWindow(env, env.containerName, { devspaceId: env.id, windowId: WINDOW_ID, createdAt: iso(NOW - 5000) });
  // The window reads its connection state and branch in the background; wait for it, so tests start from a quiet state.
  await settle(() => h.service.currentBranch.mock.calls.length > reads, 'the branch of the window');
  h.service.openDevspaceInWorker.mockClear();
}

/** A live window 2 that holds a busy mark on `env`. */
async function otherWindowBusy(env: Devspace): Promise<void> {
  h.alive.add(OTHER_PID);
  await h.sessionFiles.writeWindowStatus({
    windowId: OTHER_WINDOW_ID,
    pid: OTHER_PID,
    devspaceId: null,
    state: 'active',
    updatedAt: iso(NOW - 5000),
  });
  await h.registry.updateDevspace(env.id, (entry) => {
    entry.busy = { operation: 'update', since: iso(NOW - 60_000), pid: OTHER_PID, windowId: OTHER_WINDOW_ID };
  });
}

/**
 * The pipeline starts the container: after openDevspaceInWorker, Docker reports it as running (the window connects
 * only to a container that runs).
 */
function pipelineStartsContainer(): void {
  const start = h.service.openDevspaceInWorker.getMockImplementation();
  h.service.openDevspaceInWorker.mockImplementation(async (id: string, options: OpenOptions) => {
    const result = await start!(id, options);
    h.docker.containerState.mockResolvedValue('running');
    return result;
  });
}

/** Window 2 is connected to `env` (its status file references it). */
function otherWindowConnected(devspaceId = ENV_ID): void {
  h.coordinator.otherActiveWindows.mockResolvedValue([
    { windowId: OTHER_WINDOW_ID, pid: OTHER_PID, devspaceId, state: 'active', updatedAt: iso(NOW) },
  ]);
}

/** Lets the next progress notifications record their Cancel listener, so that a test can press Cancel. */
function cancellableProgress(): { cancel(): void } {
  const listeners: Array<() => void> = [];
  fakeVscode.window.withProgress.mockImplementation(async (_options: unknown, task: (...args: unknown[]) => Promise<unknown>) =>
    task(
      { report: (value: { message?: string }) => h.progressTitles.push(value.message ?? '') },
      {
        isCancellationRequested: false,
        onCancellationRequested: (listener: () => void) => {
          listeners.push(listener);
          return { dispose() {} };
        },
      },
    ),
  );
  return {
    cancel: () => {
      for (const listener of listeners) listener();
    },
  };
}

/** The sign-ins of the account picker of VS Code (getAccount with a dialog and without a named account). */
function interactiveSignIns(): number {
  return h.auth.getAccount.mock.calls.filter((call: unknown[]) => {
    const options = call[0] as { interactive?: boolean; account?: GitHubAccount } | undefined;
    return options?.interactive === true && options.account === undefined;
  }).length;
}

function warningMessages(): string[] {
  return fakeVscode.window.showWarningMessage.mock.calls.map((call: unknown[]) => String(call[0]));
}

/** A new harness with other timings. */
function recreateHarness(options: Parameters<typeof createHarness>[0]): void {
  h.controller.dispose();
  fs.rmSync(h.root, { recursive: true, force: true });
  resetFakeVscode();
  h = createHarness(options);
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function welcomeManifest(): {
  contributes: {
    commands: Array<{ command: string; title: string; category: string }>;
    viewsWelcome: Array<{ view: string; contents: string; when: string }>;
  };
} {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
}

/**
 * The contents of the welcome view entries that VS Code shows, in order. A small evaluator for the `when` clauses:
 * `&&` of keys (context keys and the platform keys isMac, isWindows, isLinux), each optionally negated.
 */
function shownWelcome(context: Record<string, boolean>): string[] {
  return welcomeManifest()
    .contributes.viewsWelcome.filter((view) =>
      view.when.split('&&').every((term) => {
        const text = term.trim();
        return text.startsWith('!') ? !context[text.slice(1)] : context[text] === true;
      }),
    )
    .map((view) => view.contents);
}

describe('Controller commands', () => {
  it('registers exactly the commands of package.json', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: { commands: Array<{ command: string }> };
    };
    const declared = manifest.contributes.commands.map((command) => command.command).sort();
    expect([...h.commands.keys()].sort()).toEqual(declared);
    // 38 commands, among them hidden ones: Show Docker Setup (the action Install Docker… of an error: it looks for the
    // CLI, then shows the view), the command of a repository row (a double-click runs Start), Enter on a row (Enter
    // runs Start), and the choice of the Docker host (the command of the first row of the view). The last two that were
    // added: "Start with Account…" and "Add GitHub Account…".
    expect(declared).toHaveLength(38);
    expect(declared).toEqual(expect.arrayContaining([Commands.removeFromDockerEngine, Commands.rowEnter, Commands.startWithAccount, Commands.addAccount]));
  });

  it('uses the settings and the context keys of package.json', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: {
        configuration: { properties: Record<string, { default: unknown }> };
        viewsWelcome: Array<{ when: string }>;
      };
    };
    const defaults = Object.fromEntries(
      Object.entries(manifest.contributes.configuration.properties).map(([key, value]) => [
        key.replace(`${SETTINGS_SECTION}.`, ''),
        value.default,
      ]),
    );
    expect(defaults).toEqual({ ...DEFAULT_SETTINGS });
    const keys = new Set(manifest.contributes.viewsWelcome.flatMap((view) => view.when.match(/devspaces\.\w+/g) ?? []));
    // Exactly the keys that the extension sets.
    expect([...keys].sort()).toEqual(
      [
        DockerContextKeys.setupRequired,
        DockerContextKeys.wslReady,
        LOADED_CONTEXT_KEY,
        LOAD_FAILED_CONTEXT_KEY,
        SIGNED_IN_CONTEXT_KEY,
        GITHUB_ENTERPRISE_CONTEXT_KEY,
        DEVSPACES_ONLY_CONTEXT_KEY,
      ].sort(),
    );
    // The other terms are the platform keys of VS Code.
    const others = new Set(
      manifest.contributes.viewsWelcome.flatMap((view) =>
        view.when.split('&&').map((term) => term.trim().replace(/^!/, '')).filter((term) => !term.startsWith('devspaces.')),
      ),
    );
    expect([...others].sort()).toEqual(['isLinux', 'isMac', 'isWindows']);
  });

  it('shows "could not be loaded", not "no repository was found", after a failed first load (package.json)', () => {
    const shown = (context: Record<string, boolean>): string[] => shownWelcome(context).map((contents) => contents.split('\n')[0]);
    const signedIn = { [SIGNED_IN_CONTEXT_KEY]: true };
    expect(shown({ ...signedIn, [LOADED_CONTEXT_KEY]: true, [LOAD_FAILED_CONTEXT_KEY]: true })).toEqual([
      'The repository list could not be loaded. Check the internet connection and try again.',
    ]);
    expect(shown({ ...signedIn, [LOADED_CONTEXT_KEY]: true, [LOAD_FAILED_CONTEXT_KEY]: false })).toEqual([
      'No repository with a Dev Container configuration was found.',
    ]);
    expect(shown({ ...signedIn })).toEqual(['Loading your repositories…']);
    expect(shown({ [LOAD_FAILED_CONTEXT_KEY]: true })).toEqual([
      'Sign in with GitHub to see your repositories that have a Dev Container configuration.',
    ]);
    // A missing CLI alone (a remote Docker host) does not show the setup: the list entries as usual.
    expect(shown({ ...signedIn, [DockerContextKeys.missing]: true, isMac: true })).toEqual(['Loading your repositories…']);
  });

  // When no remote Docker is configured and the local Docker is not available, the repositories are not shown; the
  // sidebar then has no rows (sidebar.test.ts), so the view shows these entries: the steps of the Docker setup, each
  // with its button, then the sign-in while not signed in.
  describe('Docker setup in the sidebar (package.json viewsWelcome)', () => {
    const setup = { [DockerContextKeys.missing]: true, [DockerContextKeys.setupRequired]: true };
    const intro = 'Devspaces needs Docker, which is not installed on this computer.';
    const after = 'Your repositories appear here once Docker is installed. Devspaces starts Docker when needed.';
    // Docker Engine on Linux is not started by the extension: it needs administrator rights.
    const afterLinux =
      'Your repositories appear here once Docker is installed. Devspaces asks to start Docker Engine when needed.';
    const signIn =
      'Sign in with GitHub to see your repositories that have a Dev Container configuration.\n' +
      'Devspaces asks for the scopes repo (read and change the repositories that you can access, also the private ones) and read:org (read your organization memberships). It works only with accounts on github.com.\n' +
      '[Sign in with GitHub](command:devspaces.signIn)';
    const githubEnterprise =
      'Your VS Code is set up for GitHub Enterprise Server or GHE.com. Devspaces cannot use an account there. Sign in with an account on github.com.';
    const installWsl =
      '1. Install WSL 2, which Docker Desktop needs. Windows asks for administrator permission; restart afterwards.\n[Install WSL 2](command:devspaces.dockerSetup.installWsl)';
    const wslInstalled = '1. ✓ WSL 2 is installed.';
    const installMac =
      'Install Docker Desktop with Homebrew or Docker\'s installer. You see the commands before anything runs. Docker Desktop is free for personal use, education, non-commercial open source, and small businesses; larger companies need a [paid subscription](https://www.docker.com/legal/docker-subscription-service-agreement/).\n[Install Docker](command:devspaces.dockerSetup.install)';
    const installWindows =
      '2. Install Docker Desktop with winget or Docker\'s installer. You see the commands before anything runs. Docker Desktop is free for personal use, education, non-commercial open source, and small businesses; larger companies need a [paid subscription](https://www.docker.com/legal/docker-subscription-service-agreement/).\n[Install Docker](command:devspaces.dockerSetup.install)';
    const installLinux =
      'Install Docker Engine from Docker\'s package repository. You see the commands before anything runs.\n[Install Docker](command:devspaces.dockerSetup.install)';
    // The last step on every platform: Docker on another computer, without Docker on this one.
    const remote =
      'Or use Docker on another computer that you reach over SSH, without Docker on this computer. Devspaces downloads the Docker CLI that it needs into its own folder; this needs no administrator permission.\n[Use a Remote Docker Host…](command:devspaces.useRemoteDockerHost)';

    it('shows the steps of macOS, then the sign-in', () => {
      expect(shownWelcome({ ...setup, isMac: true })).toEqual([intro, installMac, after, remote, signIn]);
    });

    it('shows the steps of Windows with WSL 2 first, and a check mark instead of its button once WSL 2 is ready', () => {
      expect(shownWelcome({ ...setup, isWindows: true })).toEqual([intro, installWsl, installWindows, after, remote, signIn]);
      expect(shownWelcome({ ...setup, isWindows: true, [DockerContextKeys.wslReady]: true })).toEqual([
        intro,
        wslInstalled,
        installWindows,
        after,
        remote,
        signIn,
      ]);
    });

    it('shows the steps of Linux', () => {
      expect(shownWelcome({ ...setup, isLinux: true })).toEqual([intro, installLinux, afterLinux, remote, signIn]);
    });

    // The settings of VS Code name a GitHub Enterprise instance (devspaces.githubEnterprise): a note after the sign-in.
    it('shows the note on GitHub Enterprise after the sign-in, only while not signed in, also under the setup', () => {
      const enterprise = { [GITHUB_ENTERPRISE_CONTEXT_KEY]: true };
      expect(shownWelcome({ ...enterprise })).toEqual([signIn, githubEnterprise]);
      expect(shownWelcome({ ...setup, isMac: true, ...enterprise })).toEqual([intro, installMac, after, remote, signIn, githubEnterprise]);
      expect(shownWelcome({})).toEqual([signIn]);
      expect(shownWelcome({ ...enterprise, [SIGNED_IN_CONTEXT_KEY]: true })).toEqual(['Loading your repositories…']);
      expect(shownWelcome({ ...enterprise, ...setup, isMac: true, [SIGNED_IN_CONTEXT_KEY]: true })).toEqual([intro, installMac, after, remote]);
    });

    // Numbers only where there is more than one step (Windows: WSL 2, then Docker Desktop).
    it('numbers the steps 1, 2, … only on the platform with two steps', () => {
      const cases = <Array<[Record<string, boolean>, number]>>[
        [{ isMac: true }, 0],
        [{ isLinux: true }, 0],
        [{ isWindows: true }, 2],
        [{ isWindows: true, [DockerContextKeys.wslReady]: true }, 2],
      ];
      for (const [platform, count] of cases) {
        const numbers = shownWelcome({ ...setup, ...platform })
          .map((contents) => /^(\d+)\. /.exec(contents)?.[1])
          .filter((number) => number !== undefined)
          .map(Number);
        expect(numbers).toEqual(numbers.map((_number, index) => index + 1));
        expect(numbers).toHaveLength(count);
      }
    });

    it('shows no list entry under the setup, also when signed in, loaded, or after a failed load', () => {
      const signedIn = { ...setup, isMac: true, [SIGNED_IN_CONTEXT_KEY]: true };
      expect(shownWelcome(signedIn)).toEqual([intro, installMac, after, remote]);
      expect(shownWelcome({ ...signedIn, [LOADED_CONTEXT_KEY]: true })).toEqual([intro, installMac, after, remote]);
      expect(shownWelcome({ ...signedIn, [LOADED_CONTEXT_KEY]: true, [LOAD_FAILED_CONTEXT_KEY]: true })).toEqual([intro, installMac, after, remote]);
      expect(shownWelcome({ ...signedIn, [LOAD_FAILED_CONTEXT_KEY]: true })).toEqual([intro, installMac, after, remote]);
      // Every entry but the sign-in and its note on GitHub Enterprise either belongs to the setup or is hidden under it.
      for (const view of welcomeManifest().contributes.viewsWelcome) {
        if (view.when === `!${SIGNED_IN_CONTEXT_KEY}` || view.when === `!${SIGNED_IN_CONTEXT_KEY} && ${GITHUB_ENTERPRISE_CONTEXT_KEY}`) continue;
        const terms = view.when.split('&&').map((term) => term.trim());
        expect(terms.includes(DockerContextKeys.setupRequired) || terms.includes(`!${DockerContextKeys.setupRequired}`)).toBe(true);
      }
    });

    it('uses only commands of contributes.commands in the welcome view', () => {
      const manifest = welcomeManifest();
      const declared = new Set(manifest.contributes.commands.map((command) => command.command));
      const used = manifest.contributes.viewsWelcome.flatMap((view) => [...view.contents.matchAll(/\(command:([\w.]+)\)/g)].map((match) => match[1]));
      expect(used).toEqual(
        expect.arrayContaining([
          'devspaces.dockerSetup.install',
          'devspaces.dockerSetup.installWsl',
          'devspaces.signIn',
        ]),
      );
      for (const command of used) expect(declared.has(command), command).toBe(true);
    });
  });

  it('shows the log', async () => {
    await run('showLog');
    expect(h.logger.show).toHaveBeenCalled();
  });

});

describe('Start', () => {
  it('creates the devspace of a repository, then connects this window after the pending connection file', async () => {
    const info = repositoryInfo('acme/api', { configPaths: ['.devcontainer/devcontainer.json', '.devcontainer/python/devcontainer.json'] });
    h.sidebar.infos.set('acme/api', info);
    h.service.openInWorker.mockImplementation(async () => {
      const env = devspace();
      await h.registry.add(env);
      return openResult(env);
    });

    await run('start', row('acme/api', undefined, info, ROOT_SOURCE));

    expect(h.service.openInWorker).toHaveBeenCalledTimes(1);
    expect(h.service.openInWorker.mock.calls[0][0]).toEqual({
      repository: 'acme/api',
      defaultBranch: 'main',
      configPaths: ['.devcontainer/devcontainer.json', '.devcontainer/python/devcontainer.json'],
      trusted: true,
    });
    expect(h.sidebar.trustedOwner).toHaveBeenCalledWith('acme');
    expect(h.coordinator.writePending).toHaveBeenCalledWith(ENV_ID);
    expect((await h.sessionFiles.readPendings()).map((pending) => pending.devspaceId)).toEqual([ENV_ID]);
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
    // The repository has two configurations, so its rows are child rows: the texts name the source too.
    expect(h.progressTitles[0]).toContain(Messages.opening('acme/api · config'));
    expect(h.progressTitles.some((message) => message.includes('Connecting.'))).toBe(true);
  });

  it('lets the pipeline ask about a repository of another owner at its first open', async () => {
    h.sidebar.infos.set('other/api', repositoryInfo('other/api'));
    h.sidebar.trustedOwner.mockResolvedValue(false);
    await run('start', row('other/api', undefined, h.sidebar.infos.get('other/api'), ROOT_SOURCE));
    expect(h.sidebar.trustedOwner).toHaveBeenCalledWith('other');
    expect(h.service.openInWorker).toHaveBeenCalledWith(expect.objectContaining({ repository: 'other/api', trusted: false }), expect.anything());
  });

  it('opens an existing devspace with the pipeline and connects this window (switch)', async () => {
    await h.registry.add(devspace());
    await run('start', row('acme/api', devspace()));
    expect(h.service.openInWorker).not.toHaveBeenCalled();
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledWith(ENV_ID, expect.objectContaining({ source: ROOT_SOURCE }));
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
  });

  it('opens an existing devspace with its own source, whatever the settings say', async () => {
    await h.registry.add(devspace());
    h.settings.defaultImage = DEFAULT_IMAGE;
    await run('start', row('acme/api', devspace()));
    expect(h.service.openDevspaceInWorker).toHaveBeenLastCalledWith(ENV_ID, expect.objectContaining({ source: ROOT_SOURCE }));
    h.settings.startWithDefaultImage = false;
    await run('startInNewWindow', row('acme/api', devspace()));
    expect(h.service.openDevspaceInWorker).toHaveBeenLastCalledWith(ENV_ID, expect.objectContaining({ source: ROOT_SOURCE }));
    // A row that names another source changes nothing for an existing devspace: the devspace keeps its source.
    await run('start', row('acme/api', devspace(), undefined, DEFAULT_SOURCE));
    expect(h.service.openDevspaceInWorker).toHaveBeenLastCalledWith(ENV_ID, expect.objectContaining({ source: ROOT_SOURCE }));
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledTimes(3);
  });

  it('opens a default-image devspace with the default image of the settings now; the pipeline asks Rebuild now / Later', async () => {
    await h.registry.add(devspace({ defaultImage: 'node:22' }));
    h.settings.defaultImage = DEFAULT_IMAGE;
    await run('start', row('acme/api', devspace({ defaultImage: 'node:22' })));
    expect(h.service.openDevspaceInWorker).toHaveBeenLastCalledWith(ENV_ID, expect.objectContaining({ source: DEFAULT_SOURCE }));
    expect(h.service.openDevspaceInWorker.mock.calls[0][1]).not.toHaveProperty('forceRebuild');
    // The setting cleared: the devspace keeps starting from the image it was built from.
    h.settings.defaultImage = '';
    await run('start', row('acme/api', devspace({ defaultImage: 'node:22' })));
    expect(h.service.openDevspaceInWorker).toHaveBeenLastCalledWith(ENV_ID, expect.objectContaining({ source: { kind: 'defaultImage', image: 'node:22' } }));
    expect(h.connection.open).toHaveBeenCalledTimes(2);
  });

  it('Start on the default row of a repository creates its default-image devspace', async () => {
    const info = repositoryInfo('acme/api');
    h.sidebar.infos.set('acme/api', info);
    h.settings.defaultImage = DEFAULT_IMAGE;
    h.service.openInWorker.mockImplementation(async () => {
      const env = devspace({ defaultImage: DEFAULT_IMAGE });
      await h.registry.add(env);
      return openResult(env);
    });
    await run('start', row('acme/api', undefined, info, DEFAULT_SOURCE));
    expect(h.service.openInWorker).toHaveBeenCalledWith(expect.objectContaining({ repository: 'acme/api' }), expect.objectContaining({ source: DEFAULT_SOURCE }));
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
    expect(h.progressTitles[0]).toContain(Messages.opening('acme/api · default'));
  });

  it('Start on the row of an alternative configuration creates the devspace of that configuration', async () => {
    const info = repositoryInfo('acme/api', { configPaths: ['.devcontainer/devcontainer.json', '.devcontainer/python/devcontainer.json'] });
    h.sidebar.infos.set('acme/api', info);
    h.service.openInWorker.mockImplementation(async () => {
      const env = devspace({ configPath: '.devcontainer/python/devcontainer.json' });
      await h.registry.add(env);
      return openResult(env);
    });
    await run('start', row('acme/api', undefined, info, PYTHON_SOURCE));
    expect(h.service.openInWorker).toHaveBeenCalledWith(expect.objectContaining({ repository: 'acme/api' }), expect.objectContaining({ source: PYTHON_SOURCE }));
    expect(h.progressTitles[0]).toContain(Messages.opening('acme/api · python'));
  });

  it('Start on a row of a source that has a devspace already opens that devspace (the row was built before it existed)', async () => {
    await h.registry.add(devspace({ defaultImage: DEFAULT_IMAGE }));
    h.settings.defaultImage = DEFAULT_IMAGE;
    await run('start', row('acme/api', undefined, repositoryInfo('acme/api'), DEFAULT_SOURCE));
    expect(h.service.openInWorker).not.toHaveBeenCalled();
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledWith(ENV_ID, expect.objectContaining({ source: DEFAULT_SOURCE }));
    // The configuration row of the same repository has no devspace: a first open.
    h.service.openInWorker.mockImplementation(async () => {
      const env = devspace({ id: OTHER_ENV_ID, containerName: 'devspaces-acme-api-config-7c1d2e3f', volumeName: 'devspaces-acme-api-config-7c1d2e3f' });
      await h.registry.add(env);
      return openResult(env);
    });
    await run('start', row('acme/api', undefined, repositoryInfo('acme/api'), ROOT_SOURCE));
    expect(h.service.openInWorker).toHaveBeenCalledWith(expect.objectContaining({ repository: 'acme/api' }), expect.objectContaining({ source: ROOT_SOURCE }));
  });

  it('a repository without a Dev Container configuration starts from the default image (its only row)', async () => {
    const info = repositoryInfo('acme/api', { configPaths: [] });
    h.sidebar.infos.set('acme/api', info);
    h.settings.defaultImage = DEFAULT_IMAGE;
    h.settings.startWithDefaultImage = false;
    h.service.openInWorker.mockImplementation(async () => {
      const env = devspace({ defaultImage: DEFAULT_IMAGE });
      await h.registry.add(env);
      return openResult(env);
    });
    await run('start', row('acme/api', undefined, info, DEFAULT_SOURCE));
    expect(h.service.openInWorker).toHaveBeenCalledWith(expect.objectContaining({ repository: 'acme/api' }), expect.objectContaining({ source: DEFAULT_SOURCE }));
    // The one row of a repository: the progress names the repository alone.
    expect(h.progressTitles[0]).toContain(Messages.opening('acme/api'));
  });

  it('runs the operations of two devspaces of one repository next to each other, and those of one devspace one after the other', async () => {
    const config = devspace();
    const image = devspace({ id: OTHER_ENV_ID, defaultImage: DEFAULT_IMAGE, containerName: 'devspaces-acme-api-default-7c1d2e3f', volumeName: 'devspaces-acme-api-default-7c1d2e3f' });
    await h.registry.add(config);
    await h.registry.add(image);
    h.settings.defaultImage = DEFAULT_IMAGE;
    const first = deferred<OpenResult>();
    h.service.openDevspaceInWorker.mockImplementationOnce(() => first.promise);
    const configStart = run('start', row('acme/api', config));
    await settle(() => h.service.openDevspaceInWorker.mock.calls.length === 1, 'the first open');
    // The default-image devspace of the same repository starts while the configuration devspace is opening.
    await run('stop', row('acme/api', image));
    expect(h.service.stop).toHaveBeenCalledWith(OTHER_ENV_ID);
    // A second operation of the configuration devspace waits for the first one: refused with a message.
    await run('stop', row('acme/api', config));
    expect(h.service.stop).toHaveBeenCalledTimes(1);
    first.resolve(openResult(config));
    await configStart;
  });

  it('names the devspace with the word of its source when this window is connected to it', async () => {
    const env = devspace({ defaultImage: DEFAULT_IMAGE });
    await h.registry.add(env);
    await connectHere(env);
    // The repository has a configuration and the default image: child rows, so the texts name the source.
    h.sidebar.infos.set('acme/api', repositoryInfo('acme/api'));
    h.settings.defaultImage = DEFAULT_IMAGE;
    await run('start', row('acme/api', env));
    expect(await h.sessionFiles.readOperations()).toEqual([]);
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(ControllerTexts.alreadyConnected('acme/api · default'));
  });

  it('names a devspace by its repository alone when the repository has one row (GitHub does not list it)', async () => {
    const env = devspace({ defaultImage: DEFAULT_IMAGE });
    await h.registry.add(env);
    await connectHere(env);
    h.settings.defaultImage = DEFAULT_IMAGE;
    await run('start', row('acme/api', env));
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(ControllerTexts.alreadyConnected('acme/api'));
  });

  it('only shows a message when this window is connected to the devspace and its container runs', async () => {
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    await run('start', row('acme/api', env));
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    expect(h.connection.open).not.toHaveBeenCalled();
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(ControllerTexts.alreadyConnected('acme/api'));
  });

  it('reconnects when this window is connected but its container does not run (status bar Reconnect)', async () => {
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    h.docker.containerState.mockResolvedValue('stopped');
    pipelineStartsContainer(); // The window connects only to a running container.
    // Reconnect opens with the source of the devspace: the default image of the settings does not change the devspace.
    h.settings.defaultImage = DEFAULT_IMAGE;
    await run('start', { devspaceId: ENV_ID });
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledTimes(1);
    expect(h.service.openDevspaceInWorker.mock.calls[0][1].source).toEqual(ROOT_SOURCE);
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
  });

  it('shows the other window instead of running the pipeline when another window is connected', async () => {
    const env = devspace();
    await h.registry.add(env);
    h.coordinator.otherActiveWindows.mockResolvedValue([
      { windowId: OTHER_WINDOW_ID, pid: OTHER_PID, devspaceId: ENV_ID, state: 'active', updatedAt: iso(NOW) },
    ]);
    await run('start', row('acme/api', env));
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    expect(h.coordinator.writePending).not.toHaveBeenCalled();
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
  });

  // A local devspace never names a context, also when the other window's status has one.
  it('shows the other window of a local devspace without a context', async () => {
    await h.registry.add(devspace());
    h.coordinator.otherActiveWindows.mockResolvedValue([
      { windowId: OTHER_WINDOW_ID, pid: OTHER_PID, devspaceId: ENV_ID, state: 'active', updatedAt: iso(NOW), dockerContext: 'devspaces-remote-11111111' },
    ]);
    await run('start', row('acme/api', devspace()));
    expect(h.connection.open.mock.calls).toEqual([[CONTAINER, '/workspaces/api']]);
  });

  it('starts the devspace when the other window has lost its connection (the row shows Stopped)', async () => {
    const env = devspace();
    await h.registry.add(env);
    otherWindowConnected();
    h.docker.containerState.mockResolvedValue('stopped');
    pipelineStartsContainer(); // The window connects only to a running container.
    await run('start', row('acme/api', env));
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledTimes(1);
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledWith(ENV_ID, expect.anything());
    expect(h.coordinator.writePending).toHaveBeenCalledWith(ENV_ID);
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
  });

  it('starts the devspace when another window references it while Docker does not run', async () => {
    const env = devspace();
    await h.registry.add(env);
    otherWindowConnected();
    h.docker.containerState.mockRejectedValue(new Error('Cannot connect to the Docker daemon'));
    pipelineStartsContainer(); // The window connects only to a running container.
    await run('start', row('acme/api', env));
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledTimes(1);
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
  });

  it('stays in this window when the user cancels after the pipeline finished its last step', async () => {
    const env = devspace();
    await h.registry.add(env);
    const progress = cancellableProgress();
    h.service.openDevspaceInWorker.mockImplementation(async (id: string) => {
      // The pipeline wrote the pending connection file in its last step; then the user pressed Cancel.
      await h.sessionFiles.writePending(id, WINDOW_ID);
      progress.cancel();
      return openResult(env);
    });
    await run('start', row('acme/api', env));
    expect(h.connection.open).not.toHaveBeenCalled();
    expect(h.coordinator.writePending).not.toHaveBeenCalled();
    expect(await h.sessionFiles.readPendings()).toEqual([]);
    expect(fakeVscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(fakeVscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  // Cancel while the container is checked before the window connects.
  it('stays in this window when the user cancels while the container is checked', async () => {
    const env = devspace();
    await h.registry.add(env);
    const progress = cancellableProgress();
    h.service.openDevspaceInWorker.mockImplementation(async (id: string) => {
      await h.sessionFiles.writePending(id, WINDOW_ID);
      return openResult(env);
    });
    h.docker.containerState.mockImplementation(async () => {
      progress.cancel();
      return 'stopped';
    });
    await run('start', row('acme/api', env));
    expect(h.docker.containerState).toHaveBeenCalledTimes(1);
    expect(h.connection.open).not.toHaveBeenCalled();
    expect(h.coordinator.writePending).not.toHaveBeenCalled();
    expect(await h.sessionFiles.readPendings()).toEqual([]);
    expect(fakeVscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(fakeVscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  // Cancel ends a pause between the checks of the container (not only the checks themselves).
  it('stays in this window when the user cancels during a pause between the checks of the container', async () => {
    recreateHarness({ readyPollMs: 60_000 });
    const env = devspace();
    await h.registry.add(env);
    const progress = cancellableProgress();
    h.docker.containerState.mockImplementation(async () => {
      setTimeout(() => progress.cancel(), 10);
      return 'stopped';
    });
    await run('start', row('acme/api', env));
    expect(h.docker.containerState).toHaveBeenCalledTimes(1);
    expect(h.connection.open).not.toHaveBeenCalled();
    expect(h.coordinator.writePending).not.toHaveBeenCalled();
  });

  // A Cancel during the check itself skips the following pause.
  it('does not wait for the next pause when the user cancels during a check of the container', async () => {
    recreateHarness({ readyPollMs: 60_000 });
    const env = devspace();
    await h.registry.add(env);
    const progress = cancellableProgress();
    h.docker.containerState.mockImplementation(async () => {
      progress.cancel();
      return 'stopped';
    });
    await run('start', row('acme/api', env));
    expect(h.docker.containerState).toHaveBeenCalledTimes(1);
    expect(h.connection.open).not.toHaveBeenCalled();
  });

  // The newest request wins also when it arrives while the container of the older one is checked.
  it('does not connect an older request whose container check ends after a newer request started', async () => {
    const web = devspace({ id: 'b1c2d3e4-0000-4000-8000-000000000002', repository: 'acme/web', containerName: 'web', volumeName: 'web', remoteWorkspaceFolder: '/workspaces/web' });
    await h.registry.add(devspace());
    await h.registry.add(web);
    const webPipeline = deferred<OpenResult>();
    h.service.openDevspaceInWorker.mockImplementation(async (id: string) => (id === ENV_ID ? openResult(devspace()) : webPipeline.promise));
    const apiState = deferred<string>();
    h.docker.containerState.mockImplementation(async (name: string) => (name === CONTAINER ? apiState.promise : 'running'));
    const first = run('start', row('acme/api', devspace()));
    await settle(() => h.docker.containerState.mock.calls.some(([name]) => name === CONTAINER), 'the check of the first container');
    const second = run('start', row('acme/web', web));
    await settle(() => h.service.openDevspaceInWorker.mock.calls.length === 2, 'the second pipeline');
    apiState.resolve('running');
    await first;
    expect(h.connection.open).not.toHaveBeenCalled();
    webPipeline.resolve(openResult(web));
    await second;
    expect(h.connection.open).toHaveBeenCalledTimes(1);
    expect(h.connection.open).toHaveBeenCalledWith('web', '/workspaces/web');
  });

  // The lines about the Docker of the attach are in the log before the window switches.
  it('logs the Docker of the attach before the window connects', async () => {
    await h.registry.add(devspace());
    h.docker.run.mockImplementation(async () => {
      await pause(20);
      return { exitCode: 0, stdout: 'x', stderr: '', timedOut: false };
    });
    let loggedAtOpen: string[] = [];
    h.connection.open.mockImplementation(async () => {
      loggedAtOpen = h.logger.info.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith('Before the window connects:'));
    });
    await run('start', row('acme/api', devspace()));
    expect(h.connection.open).toHaveBeenCalledTimes(1);
    expect(loggedAtOpen.length).toBeGreaterThanOrEqual(4);
  });

  it('runs one operation per devspace at a time; a second Start is ignored', async () => {
    await h.registry.add(devspace());
    const pipeline = deferred<OpenResult>();
    h.service.openDevspaceInWorker.mockReturnValueOnce(pipeline.promise);
    const first = run('start', row('acme/api', devspace()));
    await settle(() => h.service.openDevspaceInWorker.mock.calls.length === 1, 'the first pipeline');
    await run('start', row('acme/api', devspace()));
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledTimes(1);
    pipeline.resolve(openResult(devspace()));
    await first;
    expect(h.connection.open).toHaveBeenCalledTimes(1);
  });

  it('connects the devspace that was selected last when two pipelines run in this window', async () => {
    const web = devspace({
      id: 'b1c2d3e4-0000-4000-8000-000000000002',
      repository: 'acme/web',
      containerName: 'web',
      volumeName: 'web',
      remoteWorkspaceFolder: '/workspaces/web',
    });
    await h.registry.add(devspace());
    await h.registry.add(web);
    const pipelines = new Map([
      [ENV_ID, deferred<OpenResult>()],
      [web.id, deferred<OpenResult>()],
    ]);
    h.service.openDevspaceInWorker.mockImplementation((id: string) => pipelines.get(id)!.promise);
    // For example the automatic reopen of acme/api, then the user's Start of acme/web.
    const first = run('start', row('acme/api', devspace()));
    await settle(() => h.service.openDevspaceInWorker.mock.calls.length === 1, 'the first pipeline');
    const second = run('start', row('acme/web', web));
    await settle(() => h.service.openDevspaceInWorker.mock.calls.length === 2, 'the second pipeline');

    pipelines.get(ENV_ID)!.resolve(openResult(devspace()));
    await first;
    expect(h.connection.open).not.toHaveBeenCalled();
    pipelines.get(web.id)!.resolve(openResult(web));
    await second;
    expect(h.connection.open).toHaveBeenCalledTimes(1);
    expect(h.connection.open).toHaveBeenCalledWith('web', '/workspaces/web');
  });

  it('still connects the first devspace when the newer pipeline was cancelled', async () => {
    const web = devspace({ id: 'b1c2d3e4-0000-4000-8000-000000000002', repository: 'acme/web', containerName: 'web', volumeName: 'web' });
    await h.registry.add(devspace());
    await h.registry.add(web);
    const api = deferred<OpenResult>();
    h.service.openDevspaceInWorker.mockImplementation(async (id: string) => {
      if (id === ENV_ID) return api.promise;
      throw new UserFacingError('cancelled', PipelineTexts.cancelled);
    });
    const first = run('start', row('acme/api', devspace()));
    await settle(() => h.service.openDevspaceInWorker.mock.calls.length === 1, 'the first pipeline');
    await run('start', row('acme/web', web));
    api.resolve(openResult(devspace()));
    await first;
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
  });

  it('shows a failed pipeline with Show details and Try again, and does not connect', async () => {
    await h.registry.add(devspace());
    h.service.openDevspaceInWorker.mockRejectedValueOnce(new UserFacingError('buildFailed', Messages.buildFailed, 'log'));
    await run('start', row('acme/api', devspace()));
    expect(h.connection.open).not.toHaveBeenCalled();
    expect(fakeVscode.window.showErrorMessage).toHaveBeenCalledWith(Messages.buildFailed, Actions.showDetails, Actions.tryAgain);
  });

  it('shows nothing when the user cancels', async () => {
    await h.registry.add(devspace());
    h.service.openDevspaceInWorker.mockRejectedValueOnce(new UserFacingError('cancelled', PipelineTexts.cancelled));
    await run('start', row('acme/api', devspace()));
    expect(fakeVscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(fakeVscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('asks with a Quick Pick when the Command Palette gives no repository', async () => {
    h.sidebar.infos.set('acme/web', repositoryInfo('acme/web'));
    fakeVscode.window.showQuickPick.mockImplementationOnce(async (items: Array<{ repository: RepositoryInfo }>) => items[0]);
    await run('start');
    expect(h.service.openInWorker.mock.calls[0][0].repository).toBe('acme/web');
    expect(fakeVscode.window.showQuickPick.mock.calls[0][1]).toMatchObject({ placeHolder: SwitcherTexts.repositoryPlaceholder });
  });

  it('names the window that the Start uses in the Quick Pick of the repository, as the switcher does', async () => {
    h.sidebar.infos.set('acme/web', repositoryInfo('acme/web'));
    const placeholders: unknown[] = [];
    fakeVscode.window.showQuickPick.mockImplementation(async (_items: unknown, options: { placeHolder?: string }) => {
      placeholders.push(options.placeHolder);
      return undefined;
    });
    await run('startInNewWindow');
    h.settings.openInNewWindow = true;
    await run('start');
    await run('search');
    await run('startInCurrentWindow');
    // An empty window has nothing to keep, so a plain Start uses it.
    h.connection.isEmptyWindow.mockReturnValue(true);
    await run('start');
    expect(placeholders).toEqual([
      SwitcherTexts.newWindowRepositoryPlaceholder,
      SwitcherTexts.newWindowRepositoryPlaceholder,
      SwitcherTexts.newWindowRepositoryPlaceholder,
      SwitcherTexts.repositoryPlaceholder,
      SwitcherTexts.repositoryPlaceholder,
    ]);
    expect(h.service.openInWorker).not.toHaveBeenCalled();
  });
});

describe('Stop', () => {
  it('closes the remote connection and leaves a stop operation when this window is connected', async () => {
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    await run('stop', row('acme/api', env));
    expect(h.service.stop).not.toHaveBeenCalled();
    expect(h.connection.closeRemoteConnection).toHaveBeenCalled();
    const operations = await h.sessionFiles.readOperations();
    expect(operations).toEqual([
      expect.objectContaining({ devspaceId: ENV_ID, operation: 'stop', reason: 'manual', requestedBy: WINDOW_ID }),
    ]);
    expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
  });

  // A manual Stop removes the reopen record of its devspace, so the next start of VS Code does not reconnect to it.
  it('stops a devspace of no window at once, and removes its reopen record', async () => {
    await h.registry.add(devspace());
    h.sessionFiles.writeReopenSync({ devspaceId: ENV_ID, closedAt: iso(NOW - 10_000) });
    await run('stop', row('acme/api', devspace()));
    expect(h.service.stop).toHaveBeenCalledWith(ENV_ID);
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
    expect(await h.sessionFiles.readReopen()).toBeUndefined();
  });

  it('keeps the reopen record of another devspace when it stops one', async () => {
    await h.registry.add(devspace());
    h.sessionFiles.writeReopenSync({ devspaceId: OTHER_ENV_ID, closedAt: iso(NOW - 10_000) });
    await run('stop', row('acme/api', devspace()));
    expect(h.service.stop).toHaveBeenCalledWith(ENV_ID);
    expect(await h.sessionFiles.readReopen()).toEqual({ devspaceId: OTHER_ENV_ID, closedAt: iso(NOW - 10_000) });
  });

  it('asks before it stops a devspace that another window is connected to, and stops nothing on Cancel', async () => {
    await h.registry.add(devspace());
    otherWindowConnected();
    await run('stop', row('acme/api', devspace()));
    expect(warningMessages()).toEqual([ControllerTexts.otherWindowClosesConnection('acme/api')]);
    expect(h.service.stop).not.toHaveBeenCalled();
    expect(await h.disconnectRequests.read(ENV_ID)).toBeUndefined();
  });

  // Window status files that cannot be read are not "no other window"; for Start too.
  it('refuses Start, Stop, Rebuild and Delete when the other windows cannot be read, and changes nothing', async () => {
    await h.registry.add(devspace());
    h.coordinator.otherActiveWindows.mockRejectedValue(Object.assign(new Error("EACCES: permission denied, scandir 'sessions'"), { code: 'EACCES' }));
    await run('stop', row('acme/api', devspace()));
    expect(h.service.stop).not.toHaveBeenCalled();
    expect(fakeVscode.window.showErrorMessage).toHaveBeenCalledWith(ControllerTexts.otherWindowsUnknown, Actions.showDetails);
    await run('rebuild', row('acme/api', devspace()));
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    // An Open never replaces a container under a window that cannot be read.
    await run('start', row('acme/api', devspace()));
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    fakeVscode.window.showWarningMessage.mockResolvedValue(Actions.delete);
    await run('delete', row('acme/api', devspace()));
    expect(h.service.deleteInWorker).not.toHaveBeenCalled();
    expect(fakeVscode.window.showErrorMessage).toHaveBeenCalledWith(ControllerTexts.otherWindowsUnknown, Actions.showDetails, Actions.tryAgain);
    expect(await h.disconnectRequests.read(ENV_ID)).toBeUndefined();
  });

  // Delete reads the other windows again after the confirmation; when they cannot be read then, nothing is deleted.
  it('deletes nothing when the other windows cannot be read at the check after the confirmation', async () => {
    await h.registry.add(devspace());
    h.coordinator.otherActiveWindows
      .mockResolvedValueOnce([])
      .mockRejectedValue(Object.assign(new Error("EACCES: permission denied, scandir 'sessions'"), { code: 'EACCES' }));
    fakeVscode.window.showWarningMessage.mockResolvedValue(Actions.delete);
    await run('delete', row('acme/api', devspace()));
    expect(h.coordinator.otherActiveWindows.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(h.service.deleteInWorker).not.toHaveBeenCalled();
    expect(fakeVscode.window.showErrorMessage).toHaveBeenCalledWith(ControllerTexts.otherWindowsUnknown, Actions.showDetails, Actions.tryAgain);
    expect(await h.disconnectRequests.read(ENV_ID)).toBeUndefined();
  });

  it('asks the other window to close its connection first; the stop continues there', async () => {
    await h.registry.add(devspace());
    otherWindowConnected();
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(ControllerTexts.stop);
    await run('stop', row('acme/api', devspace()));
    expect(h.service.stop).not.toHaveBeenCalled();
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
    expect(await h.disconnectRequests.read(ENV_ID)).toEqual({
      devspaceId: ENV_ID,
      operation: 'stop',
      reason: 'manual',
      requestedAt: iso(NOW),
      requestedBy: WINDOW_ID,
    });
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(ControllerTexts.otherWindowContinues('acme/api'));
  });

  it('removes a request that the other window does not answer, and says that nothing was changed', async () => {
    h.controller.dispose();
    fs.rmSync(h.root, { recursive: true, force: true });
    resetFakeVscode();
    h = createHarness({ disconnectAnswerMs: 20 });
    await h.registry.add(devspace());
    otherWindowConnected();
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(ControllerTexts.stop);
    await run('stop', row('acme/api', devspace()));
    expect(await h.disconnectRequests.read(ENV_ID)).toBeDefined();
    await settle(() => warningMessages().includes(ControllerTexts.otherWindowNoAnswer('acme/api')), 'the message');
    expect(await h.disconnectRequests.read(ENV_ID)).toBeUndefined();
    expect(h.service.stop).not.toHaveBeenCalled();
  });

  it('says that a repository without devspace has nothing to stop', async () => {
    await run('stop', row('acme/web'));
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(Messages.noDevspace('acme/web'));
  });

  it('names the child row of a repository with several sources when it has no devspace', async () => {
    h.settings.defaultImage = DEFAULT_IMAGE;
    h.sidebar.infos.set('acme/api', repositoryInfo('acme/api'));
    await run('stop', row('acme/api', undefined, undefined, DEFAULT_SOURCE));
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(Messages.noDevspace('acme/api · default'));
  });
});

// Keep Running When Closed per devspace, stored in the registry. The Monitor never stops a kept devspace;
// only the user's Stop or Delete does. Every manual Stop first tells the Monitor of the engine "stop now"
// (sendStop), so the engine stops the devspace even when VS Code quits before the window's own stop reaches Docker.
describe('Stop through the Monitor', () => {
  function withMonitor(answer: { ok: true } | { ok: false; detail: string } = { ok: true }) {
    const order: string[] = [];
    const sendStop = vi.fn(async (id: string) => {
      order.push(`monitor ${id}`);
      return answer;
    });
    recreateHarness({ sessionMonitor: { sendHeartbeat: vi.fn(async () => ({ ok: true as const })), sendStop } });
    h.service.stop.mockImplementation(async (id: string) => {
      order.push(`stop ${id}`);
    });
    return { order, sendStop };
  }

  const infoMessages = (): string[] => fakeVscode.window.showInformationMessage.mock.calls.map((call: unknown[]) => String(call[0]));

  // Mutations: no sendStop, or after the window's stop; no message at the end.
  it('a Stop of no window: the monitor first, then the stop of this window with its progress, then "stopped."', async () => {
    const { order } = withMonitor();
    await h.registry.add(devspace());
    await run('stop', row('acme/api', devspace()));
    expect(order).toEqual([`monitor ${ENV_ID}`, `stop ${ENV_ID}`]);
    expect(h.progressTitles.some((title) => title.startsWith(ControllerTexts.stopping('acme/api')))).toBe(true);
    expect(infoMessages()).toEqual([ControllerTexts.stopped('acme/api')]);
  });

  it('a monitor that cannot be told (an older one refuses it): logged, and the window stops it itself', async () => {
    const { order } = withMonitor({ ok: false, detail: 'Invalid heartbeat.' });
    await h.registry.add(devspace());
    await run('stop', row('acme/api', devspace()));
    expect(order).toEqual([`monitor ${ENV_ID}`, `stop ${ENV_ID}`]);
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Invalid heartbeat.'));
    expect(warningMessages()).toEqual([]);
    expect(infoMessages()).toEqual([ControllerTexts.stopped('acme/api')]);
  });

  it('a failed stop: no "stopped." message', async () => {
    withMonitor();
    await h.registry.add(devspace());
    h.service.stop.mockRejectedValueOnce(new Error('cannot stop'));
    await run('stop', row('acme/api', devspace()));
    expect(infoMessages()).toEqual([]);
  });

  // Mutation: without the check of the host, the monitor of the devspace's host would stop what the window refuses.
  it('nothing to the monitor for a devspace of another Docker host (the stop refuses it)', async () => {
    const { sendStop } = withMonitor();
    const remote = devspace({ dockerHost: 'build-box' });
    await h.registry.add(remote);
    await run('stop', row('acme/api', remote));
    expect(sendStop).not.toHaveBeenCalled();
  });

  // Mutation: without the check of the busy mark, the monitor could stop the container in the middle of that operation.
  it('nothing to the monitor while another window works on the devspace (the stop waits for it)', async () => {
    const { sendStop } = withMonitor();
    await h.registry.add(devspace());
    await otherWindowBusy(devspace());
    await run('stop', row('acme/api', devspace()));
    expect(sendStop).not.toHaveBeenCalled();
  });

  // A Cancel in the dialog about unsaved files keeps the connection: the monitor must not stop it. The connected window
  // sends the stopNow from its deactivate() in place of its release (windowRelease.ts, isHandedOffStop).
  it('a connected window sends nothing at the click; its pending stop is the one its deactivate() turns into the stopNow', async () => {
    const { sendStop } = withMonitor();
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    await run('stop', row('acme/api', env));
    expect(h.connection.closeRemoteConnection).toHaveBeenCalled();
    expect(sendStop).not.toHaveBeenCalled();
    const [operation] = await h.sessionFiles.readOperations();
    expect(isHandedOffStop(operation, WINDOW_ID)).toBe(true);
  });

  it('role B: the reloaded empty window tells the monitor first, then stops with its progress, then "stopped."', async () => {
    const { order } = withMonitor();
    await h.registry.add(devspace());
    h.connection.isEmptyWindow.mockReturnValue(true);
    await h.sessionFiles.writeOperation({ devspaceId: ENV_ID, operation: 'stop', requestedAt: iso(NOW - 5000), requestedBy: 'old-window', reason: 'manual' });
    await h.controller.runEmptyWindowTasks();
    expect(order).toEqual([`monitor ${ENV_ID}`, `stop ${ENV_ID}`]);
    expect(infoMessages()).toEqual([ControllerTexts.stopped('acme/api')]);
  });
});

describe('Keep Running When Closed and Stop When Closed', () => {
  it('Keep Running When Closed writes the switch into the registry, renders the sidebar, and says so', async () => {
    await h.registry.add(devspace());
    await run('keepRunning', row('acme/api', devspace()));
    expect((await h.registry.get(ENV_ID))?.keepRunning).toBe(true);
    expect(h.sidebar.render).toHaveBeenCalled();
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(ControllerTexts.keptRunning('acme/api'));
    expect(h.service.stop).not.toHaveBeenCalled();
  });

  it('Keep Running When Closed names the child row of a repository with several sources', async () => {
    h.settings.defaultImage = DEFAULT_IMAGE;
    h.sidebar.infos.set('acme/api', repositoryInfo('acme/api'));
    await h.registry.add(devspace());
    await run('keepRunning', row('acme/api', devspace(), undefined, ROOT_SOURCE));
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(ControllerTexts.keptRunning('acme/api · config'));
  });

  it('Stop When Closed removes the switch, renders the sidebar, and says so', async () => {
    await h.registry.add(devspace({ keepRunning: true }));
    await run('stopWhenClosed', row('acme/api', devspace({ keepRunning: true })));
    const stored = await h.registry.get(ENV_ID);
    expect(stored).toBeDefined();
    expect(stored).not.toHaveProperty('keepRunning');
    expect(h.sidebar.render).toHaveBeenCalled();
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(ControllerTexts.stopsWhenClosed('acme/api'));
    expect(h.service.stop).not.toHaveBeenCalled();
  });

  it('Stop When Closed says that all devspaces keep running while the setting stopOnClose is off', async () => {
    await h.registry.add(devspace({ keepRunning: true }));
    h.settings.stopOnClose = false;
    await run('stopWhenClosed', row('acme/api', devspace({ keepRunning: true })));
    expect((await h.registry.get(ENV_ID))?.keepRunning).toBeUndefined();
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(ControllerTexts.keepAllRunning);
  });

  it('Stop still stops a kept devspace, and the switch stays set', async () => {
    await h.registry.add(devspace({ keepRunning: true }));
    await run('stop', row('acme/api', devspace({ keepRunning: true })));
    expect(h.service.stop).toHaveBeenCalledWith(ENV_ID);
    expect((await h.registry.get(ENV_ID))?.keepRunning).toBe(true);
  });

  it('says that a repository without devspace has nothing to keep running, and changes nothing', async () => {
    await run('keepRunning', row('acme/web'));
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(Messages.noDevspace('acme/web'));
    expect(await h.registry.list()).toEqual([]);
  });

  // The Monitor of the engine (here the local Docker) learns the choice at once.
  it('sends a heartbeat for the devspace after the switch was stored, on the local Docker too', async () => {
    const flags: Array<boolean | undefined> = [];
    const sendHeartbeat = vi.fn(async (id: string) => {
      flags.push((await h.registry.get(id))?.keepRunning);
      return { ok: true as const };
    });
    recreateHarness({ sessionMonitor: { sendHeartbeat, sendStop: vi.fn(async () => ({ ok: true as const })) } });
    await h.registry.add(devspace());
    await run('keepRunning', row('acme/api', devspace()));
    await run('stopWhenClosed', row('acme/api', devspace({ keepRunning: true })));
    expect(sendHeartbeat.mock.calls).toEqual([[ENV_ID], [ENV_ID]]);
    expect(flags).toEqual([true, undefined]);
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(ControllerTexts.keptRunning('acme/api'));
  });

  it('keeps the switch and warns when the Monitor cannot be told', async () => {
    const sendHeartbeat = vi.fn(async () => ({ ok: false as const, detail: 'No such container: devspaces-monitor' }));
    recreateHarness({ sessionMonitor: { sendHeartbeat, sendStop: vi.fn(async () => ({ ok: true as const })) } });
    await h.registry.add(devspace());
    await run('keepRunning', row('acme/api', devspace()));
    expect((await h.registry.get(ENV_ID))?.keepRunning).toBe(true);
    expect(warningMessages()).toContain(ControllerTexts.keepRunningNotSent('acme/api'));
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining('No such container'));
    // No message of success after the warning.
    expect(fakeVscode.window.showInformationMessage).not.toHaveBeenCalledWith(ControllerTexts.keptRunning('acme/api'));
  });

  it('offers exactly one of the two commands in the context menu, by the flag of the row, and both with a picker in the Command Palette', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: {
        commands: Array<{ command: string; title: string }>;
        menus: Record<string, Array<{ command?: string; when?: string }>>;
      };
    };
    const title = (command: string) => manifest.contributes.commands.find((entry) => entry.command === command)?.title;
    expect(title(Commands.keepRunning)).toBe('Keep Running When Closed');
    expect(title(Commands.stopWhenClosed)).toBe('Stop When Closed');
    const menus = manifest.contributes.menus;
    const when = (menu: string, command: string) => menus[menu].filter((item) => item.command === command).map((item) => item.when);
    expect(when('view/item/context', Commands.keepRunning)).toEqual(['view == devspaces.repositories && viewItem =~ /;canKeepRunning(;|$)/']);
    expect(when('view/item/context', Commands.stopWhenClosed)).toEqual(['view == devspaces.repositories && viewItem =~ /;kept(;|$)/']);
    expect(when('devspaces.more', Commands.keepRunning)).toEqual(['viewItem =~ /;canKeepRunning(;|$)/']);
    expect(when('devspaces.more', Commands.stopWhenClosed)).toEqual(['viewItem =~ /;kept(;|$)/']);
    // Like Stop: in the Command Palette, with a picker of the devspaces.
    expect(when('commandPalette', Commands.keepRunning)).toEqual([]);
    expect(when('commandPalette', Commands.stopWhenClosed)).toEqual([]);
    expect(when('commandPalette', Commands.stop)).toEqual([]);

    // The when clauses against the contextValue of rows (treeModel.contextValue): exactly one of the two matches a row with
    // a devspace, and none a row without one.
    const matches = (clause: string, value: string) => new RegExp(clause.match(/viewItem =~ \/(.*)\/$/)![1]).test(value);
    const keepClause = when('devspaces.more', Commands.keepRunning)[0]!;
    const stopClause = when('devspaces.more', Commands.stopWhenClosed)[0]!;
    const actions = rowActions('running', undefined);
    const notKept = treeContextValue(actions, 'on', false);
    const kept = treeContextValue(actions, 'on', true);
    const none = treeContextValue(rowActions(undefined, undefined), 'on');
    expect([matches(keepClause, notKept), matches(stopClause, notKept)]).toEqual([true, false]);
    expect([matches(keepClause, kept), matches(stopClause, kept)]).toEqual([false, true]);
    expect([matches(keepClause, none), matches(stopClause, none)]).toEqual([false, false]);
  });

  it('picks the devspace in the Command Palette, as Stop does', async () => {
    await h.registry.add(devspace());
    fakeVscode.window.showQuickPick.mockImplementationOnce(async (items: unknown) => {
      const list = (await items) as Array<{ devspaceId?: string }>;
      return list[0];
    });
    await run('keepRunning');
    expect(fakeVscode.window.showQuickPick).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ placeHolder: ControllerTexts.selectDevspaceToKeepRunning }),
    );
    expect((await h.registry.get(ENV_ID))?.keepRunning).toBe(true);
  });
});

describe('Delete', () => {
  // Delete runs no Git: it may name uncommitted changes, but they do not hinder the deletion. The dialog names the
  // numbers of the recorded (possibly refreshed) state and always lets the user delete.
  it('names recorded changes with their numbers, and Delete anyway deletes', async () => {
    await h.registry.add(devspace());
    h.service.safetyCheck.mockResolvedValue({ branch: 'main', uncommittedFiles: 2, unpushedCommits: 1, stashes: 3, recordedAt: iso(NOW) });
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.deleteAnyway);
    await run('delete', row('acme/api', devspace()));
    expect(fakeVscode.window.showWarningMessage.mock.calls[0]).toEqual([
      Messages.deleteUnsaved('acme/api', '2 uncommitted · 1 unpushed · 3 stashed'),
      { modal: true },
      Actions.openDevspace,
      Actions.deleteAnyway,
    ]);
    expect(h.service.deleteInWorker).toHaveBeenCalledWith(ENV_ID, expect.anything());
  });

  it('with nothing recorded, the plain confirmation follows and Delete deletes', async () => {
    await h.registry.add(devspace());
    h.service.safetyCheck.mockResolvedValue(undefined);
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.delete);
    await run('delete', row('acme/api', devspace()));
    const call = fakeVscode.window.showWarningMessage.mock.calls[0];
    expect(call).toEqual([Messages.deleteConfirm('acme/api'), { modal: true }, Actions.delete]);
    expect(call).not.toContain(Actions.deleteAnyway);
    expect(h.service.deleteInWorker).toHaveBeenCalledWith(ENV_ID, expect.anything());
  });

  it('names the unsaved changes, and deletes after Delete anyway while keeping the additional volumes on Keep', async () => {
    await h.registry.add(devspace({ additionalVolumes: ['api-db'] }));
    h.service.safetyCheck.mockResolvedValue({ branch: 'main', uncommittedFiles: 2, unpushedCommits: 3, stashes: 0, recordedAt: iso(NOW) });
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.deleteAnyway).mockResolvedValueOnce(Actions.keep);
    await run('delete', row('acme/api', devspace()));
    const calls = fakeVscode.window.showWarningMessage.mock.calls;
    expect(calls[0]).toEqual([
      Messages.deleteUnsaved('acme/api', '2 uncommitted · 3 unpushed'),
      { modal: true },
      Actions.openDevspace,
      Actions.deleteAnyway,
    ]);
    expect(calls[1]).toEqual([Messages.deleteAdditionalVolumes('api-db'), { modal: true }, Actions.remove, Actions.keep]);
    expect(h.service.deleteInWorker).toHaveBeenCalledWith(ENV_ID, expect.objectContaining({ additionalVolumesToRemove: [] }));
  });

  it('names every folder that the containers of the services may mount in the confirmation of Delete', async () => {
    const record = {
      builtAt: iso(NOW),
      devspaceImage: 'devspaces-3f2a9c1e:1',
      buildNumber: 1,
      configPath: '.devcontainer/devcontainer.json',
      configHash: 'sha256:x',
      images: {},
      features: {},
    };
    const env = devspace({ buildRecord: record, serviceFolders: ['/workspaces/api/pgdata', '/workspaces/api/data/postgres'] });
    await h.registry.add(env);
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.delete);
    await run('delete', row('acme/api', env));
    expect(fakeVscode.window.showWarningMessage.mock.calls[0][0]).toBe(
      `${Messages.deleteConfirm('acme/api')} ${Messages.deleteRepositoryServiceData('./pgdata, ./data/postgres')}`,
    );
  });

  it('names the service data in folders of the repository in the confirmation', async () => {
    const record = {
      builtAt: iso(NOW),
      devspaceImage: 'devspaces-3f2a9c1e:1',
      buildNumber: 1,
      configPath: '.devcontainer/devcontainer.json',
      configHash: 'sha256:x',
      images: {},
      features: {},
    };
    const serviceFolders = ['/workspaces/api/data/postgres', '/workspaces/api/init.sql', '/workspaces/other/x'];
    await h.registry.add(devspace({ buildRecord: record, serviceFolders }));
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.delete);
    await run('delete', row('acme/api', devspace({ buildRecord: record, serviceFolders })));
    // Not only Messages.deleteConfirm: the data of the database would go with the volume without a word.
    expect(fakeVscode.window.showWarningMessage.mock.calls[0]).toEqual([
      `${Messages.deleteConfirm('acme/api')} ${Messages.deleteRepositoryServiceData('./data/postgres, ./init.sql')}`,
      { modal: true },
      Actions.delete,
    ]);
    expect(Messages.deleteRepositoryServiceData('./data/postgres')).toBe('Service data in the repository will be deleted: ./data/postgres.');
    expect(h.service.deleteInWorker).toHaveBeenCalled();

    // With unsaved changes too.
    fakeVscode.window.showWarningMessage.mockReset();
    h.service.safetyCheck.mockResolvedValueOnce({ branch: 'main', uncommittedFiles: 1, unpushedCommits: 0, stashes: 0, recordedAt: iso(NOW) });
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(undefined);
    await run('delete', row('acme/api', devspace({ buildRecord: record, serviceFolders })));
    expect(fakeVscode.window.showWarningMessage.mock.calls[0][0]).toBe(
      `${Messages.deleteUnsaved('acme/api', '1 uncommitted')} ${Messages.deleteRepositoryServiceData('./data/postgres, ./init.sql')}`,
    );
  });

  it('names the paths that the containers of the services mount also without a record', async () => {
    const env = devspace({ serviceFolders: ['/workspaces/api/pgdata'] });
    await h.registry.add(env);
    // For example an entry restored from its volumes, whose db container mounts ./data/pg (DevspaceService.repositoryServiceData).
    h.service.repositoryServiceData.mockResolvedValueOnce(['./pgdata', './data/pg']);
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.delete);
    await run('delete', row('acme/api', env));
    // Not only the recorded ./pgdata.
    expect(h.service.repositoryServiceData).toHaveBeenCalledWith(ENV_ID);
    expect(fakeVscode.window.showWarningMessage.mock.calls[0][0]).toBe(
      `${Messages.deleteConfirm('acme/api')} ${Messages.deleteRepositoryServiceData('./pgdata, ./data/pg')}`,
    );
    // Without an answer of Docker, the recorded paths.
    fakeVscode.window.showWarningMessage.mockReset();
    h.service.repositoryServiceData.mockRejectedValueOnce(new Error('Docker is not running'));
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(undefined);
    await run('delete', row('acme/api', env));
    expect(fakeVscode.window.showWarningMessage.mock.calls[0][0]).toBe(`${Messages.deleteConfirm('acme/api')} ${Messages.deleteRepositoryServiceData('./pgdata')}`);
  });

  it('offers only the additional volumes that Delete would remove, and asks nothing when there are none', async () => {
    await h.registry.add(devspace({ additionalVolumes: ['api-db', 'legacy-cache'] }));
    h.service.removableAdditionalVolumes.mockResolvedValueOnce(['api-db']);
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.delete).mockResolvedValueOnce(Actions.remove);
    await run('delete', row('acme/api', devspace()));
    expect(h.service.removableAdditionalVolumes).toHaveBeenCalledWith(ENV_ID);
    expect(fakeVscode.window.showWarningMessage.mock.calls[1]).toEqual([Messages.deleteAdditionalVolumes('api-db'), { modal: true }, Actions.remove, Actions.keep]);
    expect(h.service.deleteInWorker).toHaveBeenCalledWith(ENV_ID, expect.objectContaining({ additionalVolumesToRemove: ['api-db'] }));

    fakeVscode.window.showWarningMessage.mockReset();
    h.service.deleteInWorker.mockClear();
    h.service.removableAdditionalVolumes.mockResolvedValueOnce([]);
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.delete);
    await run('delete', row('acme/api', devspace()));
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(h.service.deleteInWorker).toHaveBeenCalledWith(ENV_ID, expect.objectContaining({ additionalVolumesToRemove: [] }));
  });

  // The volumes of a Docker Compose project (the data of its services) are asked about apart, none ticked.
  describe('the data of the services of a Docker Compose devspace', () => {
    const DATA = ['devspaces-3f2a9c1e_pgdata', 'devspaces-3f2a9c1e_cache'];

    async function deleteWithServiceData(pick: (items: Array<{ label: string; picked?: boolean }>) => unknown): Promise<void> {
      await h.registry.add(devspace({ additionalVolumes: ['api-db', ...DATA] }));
      h.service.removableAdditionalVolumes.mockResolvedValueOnce(['api-db']);
      h.service.removableServiceDataVolumes.mockResolvedValueOnce([...DATA]);
      fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.delete).mockResolvedValueOnce(Actions.remove);
      fakeVscode.window.showQuickPick.mockImplementationOnce(async (items: Array<{ label: string; picked?: boolean }>) => pick(items));
      await run('delete', row('acme/api', devspace()));
    }

    it('lists them with nothing ticked and keeps them when none is ticked', async () => {
      await deleteWithServiceData((items) => {
        expect(items.map((item) => item.label)).toEqual(DATA);
        expect(items.every((item) => item.picked === false)).toBe(true);
        return [];
      });
      expect(fakeVscode.window.showQuickPick).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ canPickMany: true, title: Messages.deleteServiceDataTitle, placeHolder: Messages.deleteServiceDataPlaceholder }),
      );
      expect(h.service.removableServiceDataVolumes).toHaveBeenCalledWith(ENV_ID);
      expect(h.service.deleteInWorker).toHaveBeenCalledWith(ENV_ID, expect.objectContaining({ additionalVolumesToRemove: ['api-db'] }));
    });

    it('names the volumes of a devspace whose services are not known as possible data', async () => {
      h.service.possibleServiceDataVolumes.mockResolvedValueOnce([DATA[1]]);
      await deleteWithServiceData((items) => {
        expect(items).toEqual([
          { label: DATA[0], description: Messages.deleteServiceDataItem, picked: false },
          { label: DATA[1], description: Messages.deleteServiceDataPossibleItem, picked: false },
        ]);
        return [];
      });
      expect(fakeVscode.window.showQuickPick).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ placeHolder: Messages.deleteServiceDataPossiblePlaceholder }),
      );
      expect(h.service.possibleServiceDataVolumes).toHaveBeenCalledWith(ENV_ID);
      expect(h.service.deleteInWorker).toHaveBeenCalledWith(ENV_ID, expect.objectContaining({ additionalVolumesToRemove: ['api-db'] }));
    });

    it('removes the ticked ones', async () => {
      await deleteWithServiceData((items) => [items[0]]);
      expect(h.service.deleteInWorker).toHaveBeenCalledWith(ENV_ID, expect.objectContaining({ additionalVolumesToRemove: ['api-db', DATA[0]] }));
    });

    it('cancels the Delete on Escape', async () => {
      await deleteWithServiceData(() => undefined);
      expect(h.service.deleteInWorker).not.toHaveBeenCalled();
    });

    it('asks nothing when the devspace has none', async () => {
      await h.registry.add(devspace());
      fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.delete);
      await run('delete', row('acme/api', devspace()));
      expect(fakeVscode.window.showQuickPick).not.toHaveBeenCalled();
      expect(h.service.deleteInWorker).toHaveBeenCalled();
    });
  });

  it('opens the devspace instead when the user selects Open devspace', async () => {
    await h.registry.add(devspace());
    h.service.safetyCheck.mockResolvedValue({ branch: 'main', uncommittedFiles: 1, unpushedCommits: 0, stashes: 0, recordedAt: iso(NOW) });
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.openDevspace);
    await run('delete', row('acme/api', devspace()));
    expect(h.service.deleteInWorker).not.toHaveBeenCalled();
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledWith(ENV_ID, expect.anything());
    expect(h.connection.open).toHaveBeenCalled();
  });

  // Only Delete anyway deletes after the warning about changes; Escape (undefined) and any other answer cancel the
  // Delete without opening the devspace.
  it('Escape on the warning about changes neither deletes nor opens the devspace', async () => {
    await h.registry.add(devspace());
    h.service.safetyCheck.mockResolvedValue({ branch: 'main', uncommittedFiles: 1, unpushedCommits: 0, stashes: 0, recordedAt: iso(NOW) });
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(undefined);
    await run('delete', row('acme/api', devspace()));
    expect(warningMessages()).toHaveLength(1);
    expect(warningMessages()[0]).toBe(Messages.deleteUnsaved('acme/api', '1 uncommitted'));
    expect(h.service.deleteInWorker).not.toHaveBeenCalled();
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    expect(h.connection.open).not.toHaveBeenCalled();
  });

  it('an answer other than Delete anyway on the warning about changes does not delete', async () => {
    await h.registry.add(devspace());
    h.service.safetyCheck.mockResolvedValue({ branch: 'main', uncommittedFiles: 0, unpushedCommits: 2, stashes: 0, recordedAt: iso(NOW) });
    for (const answer of [Actions.delete, 'Something else']) {
      fakeVscode.window.showWarningMessage.mockResolvedValueOnce(answer);
      await run('delete', row('acme/api', devspace()));
    }
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledTimes(2);
    expect(h.service.deleteInWorker).not.toHaveBeenCalled();
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
  });

  it('asks for the plain confirmation when there are no changes or the volume is missing, and stops on Cancel', async () => {
    await h.registry.add(devspace());
    await run('delete', row('acme/api', devspace()));
    expect(warningMessages()).toEqual([Messages.deleteConfirm('acme/api')]);
    expect(h.service.deleteInWorker).not.toHaveBeenCalled();
  });

  it('asks the connected other window to close its connection first; the delete continues there', async () => {
    await h.registry.add(devspace({ additionalVolumes: ['api-db'] }));
    otherWindowConnected();
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.delete).mockResolvedValueOnce(Actions.remove);
    await run('delete', row('acme/api', devspace()));
    expect(warningMessages()[0]).toBe(
      `${Messages.deleteConfirm('acme/api')} ${ControllerTexts.otherWindowClosesConnection('acme/api')}`,
    );
    expect(h.service.deleteInWorker).not.toHaveBeenCalled();
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
    expect(await h.disconnectRequests.read(ENV_ID)).toEqual(
      expect.objectContaining({ operation: 'delete', reason: 'manual', additionalVolumesToRemove: ['api-db'], requestedBy: WINDOW_ID }),
    );
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(ControllerTexts.otherWindowContinues('acme/api'));
  });

  it('waits for the update of another window, then deletes (Delete in every state)', async () => {
    const env = devspace();
    await h.registry.add(env);
    await otherWindowBusy(env);
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.delete);
    const command = run('delete', row('acme/api', env));
    await settle(() => h.progressTitles.some((title) => title.includes(ControllerTexts.waitingForOtherWindow('acme/api'))), 'the wait');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.service.deleteInWorker).not.toHaveBeenCalled();
    // The other window finishes its update.
    await h.registry.updateDevspace(ENV_ID, (entry) => {
      delete entry.busy;
    });
    await command;
    expect(h.service.deleteInWorker).toHaveBeenCalledWith(ENV_ID, expect.objectContaining({ additionalVolumesToRemove: [] }));
  });

  it('does not wait and deletes nothing when the user cancels the wait', async () => {
    const env = devspace();
    await h.registry.add(env);
    await otherWindowBusy(env);
    const progress = cancellableProgress();
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.delete);
    const command = run('delete', row('acme/api', env));
    await settle(() => h.progressTitles.some((title) => title.includes(ControllerTexts.waitingForOtherWindow('acme/api'))), 'the wait');
    progress.cancel();
    await command;
    expect(h.service.deleteInWorker).not.toHaveBeenCalled();
    expect((await h.registry.get(ENV_ID))?.busy?.windowId).toBe(OTHER_WINDOW_ID);
  });

  it('says that another window deletes the devspace already', async () => {
    const env = devspace();
    await h.registry.add(env);
    await otherWindowBusy(env);
    await h.registry.updateDevspace(ENV_ID, (entry) => {
      entry.busy = { operation: 'delete', since: iso(NOW - 1000), pid: OTHER_PID, windowId: OTHER_WINDOW_ID };
    });
    await run('delete', row('acme/api', env));
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(ControllerTexts.alreadyDeleting('acme/api'));
    expect(h.service.safetyCheck).not.toHaveBeenCalled();
    expect(h.service.deleteInWorker).not.toHaveBeenCalled();
  });

  it('hands the delete of the connected devspace to the reloaded window', async () => {
    const env = devspace({ additionalVolumes: ['api-db'] });
    await h.registry.add(env);
    await connectHere(env);
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.delete).mockResolvedValueOnce(Actions.remove);
    await run('delete', row('acme/api', env));
    expect(h.service.deleteInWorker).not.toHaveBeenCalled();
    expect(await h.sessionFiles.readOperations()).toEqual([
      expect.objectContaining({ devspaceId: ENV_ID, operation: 'delete', additionalVolumesToRemove: ['api-db'] }),
    ]);
    expect((await h.registry.get(ENV_ID))?.busy).toEqual(
      expect.objectContaining({ operation: 'delete', windowId: WINDOW_ID, pid: process.pid }),
    );
    expect(h.connection.closeRemoteConnection).toHaveBeenCalled();
  });
});

describe('Rebuild', () => {
  it('marks the connected devspace as busy, leaves a rebuild operation, and closes the remote connection', async () => {
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    await run('rebuild', row('acme/api', env));
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    expect(await h.sessionFiles.readOperations()).toEqual([
      expect.objectContaining({ devspaceId: ENV_ID, operation: 'rebuild', reason: 'manual' }),
    ]);
    expect((await h.registry.get(ENV_ID))?.busy?.operation).toBe('rebuild');
    expect(h.connection.closeRemoteConnection).toHaveBeenCalled();
  });

  it('asks the connected other window to close its connection; it rebuilds and connects again', async () => {
    await h.registry.add(devspace());
    otherWindowConnected();
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.rebuildNow);
    await run('rebuild', row('acme/api', devspace()));
    expect(warningMessages()).toEqual([ControllerTexts.otherWindowClosesConnection('acme/api')]);
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    expect(await h.disconnectRequests.read(ENV_ID)).toEqual(
      expect.objectContaining({ operation: 'rebuild', reason: 'manual', requestedBy: WINDOW_ID }),
    );
  });

  it('passes the rebuild of a default-image devspace to the other window as a plain rebuild (the devspace keeps its source)', async () => {
    await h.registry.add(devspace({ defaultImage: DEFAULT_IMAGE }));
    otherWindowConnected();
    h.sidebar.infos.set('acme/api', repositoryInfo('acme/api'));
    h.settings.defaultImage = DEFAULT_IMAGE;
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.rebuildNow);
    await run('rebuild', row('acme/api', devspace({ defaultImage: DEFAULT_IMAGE })));
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    expect(warningMessages()).toEqual([ControllerTexts.otherWindowClosesConnection('acme/api · default')]);
    const request = await h.disconnectRequests.read(ENV_ID);
    expect(request).toEqual(expect.objectContaining({ operation: 'rebuild', reason: 'manual', requestedBy: WINDOW_ID }));
    expect(request).not.toHaveProperty('source');
    expect(request).not.toHaveProperty('configPath');
  });

  it('rebuilds a devspace of no window without connecting this window', async () => {
    await h.registry.add(devspace());
    await run('rebuild', row('acme/api', devspace()));
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledWith(ENV_ID, expect.objectContaining({ forceRebuild: true, source: ROOT_SOURCE }));
    expect(h.connection.open).not.toHaveBeenCalled();
  });

  it('rebuilds a default-image devspace from the default image of the settings now', async () => {
    await h.registry.add(devspace({ defaultImage: 'node:22' }));
    h.settings.defaultImage = DEFAULT_IMAGE;
    await run('rebuild', row('acme/api', devspace({ defaultImage: 'node:22' })));
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledWith(ENV_ID, expect.objectContaining({ forceRebuild: true, source: DEFAULT_SOURCE }));
  });

  it('refuses to hand off while another live window changes the devspace', async () => {
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    await otherWindowBusy(env);
    await run('rebuild', row('acme/api', env));
    expect(fakeVscode.window.showErrorMessage).toHaveBeenCalledWith(
      PipelineTexts.devspaceBusy('acme/api'),
      Actions.showDetails,
    );
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
    expect(await h.sessionFiles.readOperations()).toEqual([]);
    expect((await h.registry.get(ENV_ID))?.busy?.windowId).toBe(OTHER_WINDOW_ID);
  });

  it('takes over a mark of a window that does not run anymore', async () => {
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    await otherWindowBusy(env);
    h.alive.delete(OTHER_PID);
    await run('rebuild', row('acme/api', env));
    expect(h.connection.closeRemoteConnection).toHaveBeenCalled();
    expect((await h.registry.get(ENV_ID))?.busy?.windowId).toBe(WINDOW_ID);
  });

  it('cancels the hand-off when the window keeps its connection', async () => {
    h.controller.dispose();
    fs.rmSync(h.root, { recursive: true, force: true });
    resetFakeVscode();
    h = createHarness({ handOffCheckMs: 20 });
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    await run('rebuild', row('acme/api', env));
    expect(await h.sessionFiles.readOperations()).toHaveLength(1);
    await settle(() => h.logger.info.mock.calls.some((call) => String(call[0]).includes('pending operation is cancelled')), 'the cancel');
    await settle(() => fs.readdirSync(h.paths.operationsDir).length === 0, 'the removal');
    await settle(() => h.sidebar.render.mock.calls.length > 0, 'the render');
    expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
  });

  // An operation file of another devspace that cannot be read does not keep the hand-off; this devspace's own
  // file that cannot be read keeps it and the busy mark (its owner is not known).
  it('cancels the hand-off when an operation file of another devspace cannot be read', async () => {
    const env = await handOffWithUnreadable(() => h.paths.operationFile(OTHER_ENV_ID), async () => {
      await settle(() => h.logger.info.mock.calls.some((call) => String(call[0]).includes('pending operation is cancelled')), 'the cancel');
      await settle(() => h.sidebar.render.mock.calls.length > 0, 'the render');
    });
    expect(fs.existsSync(h.paths.operationFile(ENV_ID))).toBe(false);
    expect(fs.existsSync(h.paths.operationFile(OTHER_ENV_ID))).toBe(true);
    expect((await h.registry.get(env.id))?.busy).toBeUndefined();
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  it('keeps the hand-off and its busy mark when its own operation file cannot be read', async () => {
    const env = await handOffWithUnreadable(() => h.paths.operationFile(ENV_ID), async () => {
      await settle(() => h.logger.error.mock.calls.some((call) => String(call[0]).includes('check the pending operation')), 'the failed check');
    });
    expect(fs.existsSync(h.paths.operationFile(ENV_ID))).toBe(true);
    expect((await h.registry.get(env.id))?.busy).toMatchObject({ operation: 'rebuild', windowId: WINDOW_ID });
  });

  async function handOffWithUnreadable(unreadable: () => string, waitFor: () => Promise<void>): Promise<Devspace> {
    h.controller.dispose();
    fs.rmSync(h.root, { recursive: true, force: true });
    resetFakeVscode();
    h = createHarness({ handOffCheckMs: 20 });
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    fs.mkdirSync(h.paths.operationsDir, { recursive: true });
    fs.writeFileSync(h.paths.operationFile(OTHER_ENV_ID), '{}');
    const denied = unreadable();
    const readFile = fs.promises.readFile;
    const spy = vi.spyOn(fs.promises, 'readFile').mockImplementation((async (file: fs.PathLike, ...rest: unknown[]) => {
      if (String(file) === denied) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return (readFile as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
    }) as typeof fs.promises.readFile);
    try {
      await run('rebuild', row('acme/api', env));
      h.sidebar.render.mockClear();
      await waitFor();
    } finally {
      spy.mockRestore();
    }
    return env;
  }
});

describe('the pick of the source of a repository with several sources', () => {
  const info = () => repositoryInfo('acme/api', { configPaths: ['.devcontainer/devcontainer.json', '.devcontainer/python/devcontainer.json'] });

  it('asks for the source when the switcher opens a repository with several sources, and starts the picked one', async () => {
    h.sidebar.infos.set('acme/api', info());
    h.settings.defaultImage = DEFAULT_IMAGE;
    const picks: unknown[][] = [];
    fakeVscode.window.showQuickPick.mockImplementation(async (items: Array<{ choice?: { kind: string }; repository?: RepositoryInfo; label: string; description?: string; source?: DevspaceSource }>) => {
      picks.push(items.map((item) => [item.label, item.description]));
      const open = items.find((item) => item.choice?.kind === 'openRepository');
      if (open) return open;
      const repository = items.find((item) => item.repository?.nameWithOwner === 'acme/api');
      if (repository) return repository;
      return items.find((item) => item.source?.kind === 'configuration' && item.source.configPath === '.devcontainer/python/devcontainer.json');
    });
    await run('switchDevspace');
    expect(picks[picks.length - 1]).toEqual([
      ['default', DEFAULT_IMAGE],
      ['config', '.devcontainer/devcontainer.json'],
      ['python', '.devcontainer/python/devcontainer.json'],
    ]);
    expect(h.service.openInWorker).toHaveBeenCalledWith(expect.objectContaining({ repository: 'acme/api' }), expect.objectContaining({ source: PYTHON_SOURCE }));
  });

  it('marks the sources that have a devspace, and opens that devspace for its source', async () => {
    h.sidebar.infos.set('acme/api', info());
    await h.registry.add(devspace({ configPath: '.devcontainer/python/devcontainer.json' }));
    let sources: unknown[] = [];
    fakeVscode.window.showQuickPick.mockImplementation(async (items: Array<{ choice?: { kind: string }; repository?: RepositoryInfo; label: string; description?: string; source?: DevspaceSource }>) => {
      const open = items.find((item) => item.choice?.kind === 'openRepository');
      if (open) return open;
      const repository = items.find((item) => item.repository?.nameWithOwner === 'acme/api');
      if (repository) return repository;
      sources = items.map((item) => [item.label, item.description]);
      return items.find((item) => item.label === 'python');
    });
    await run('switchDevspace');
    expect(sources).toEqual([
      ['config', '.devcontainer/devcontainer.json'],
      ['python', `.devcontainer/python/devcontainer.json · ${ControllerTexts.devspaceExists}`],
    ]);
    expect(h.service.openInWorker).not.toHaveBeenCalled();
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledWith(ENV_ID, expect.objectContaining({ source: PYTHON_SOURCE }));
  });

  it('does nothing when the pick of the source is cancelled', async () => {
    h.sidebar.infos.set('acme/api', info());
    fakeVscode.window.showQuickPick.mockImplementation(async (items: Array<{ choice?: { kind: string }; repository?: RepositoryInfo; source?: DevspaceSource }>) => {
      const open = items.find((item) => item.choice?.kind === 'openRepository');
      if (open) return open;
      const repository = items.find((item) => item.repository?.nameWithOwner === 'acme/api');
      if (repository) return repository;
      return undefined;
    });
    await run('switchDevspace');
    expect(h.service.openInWorker).not.toHaveBeenCalled();
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
  });

  it('asks nothing for a repository with one source', async () => {
    h.sidebar.infos.set('acme/api', repositoryInfo('acme/api'));
    let asked = 0;
    fakeVscode.window.showQuickPick.mockImplementation(async (items: Array<{ choice?: { kind: string }; repository?: RepositoryInfo }>) => {
      asked += 1;
      return items.find((item) => item.choice?.kind === 'openRepository') ?? items.find((item) => item.repository?.nameWithOwner === 'acme/api');
    });
    await run('switchDevspace');
    expect(asked).toBe(1);
    expect(h.service.openInWorker).toHaveBeenCalledWith(expect.objectContaining({ repository: 'acme/api' }), expect.objectContaining({ source: ROOT_SOURCE }));
  });
});

describe('the source of a repository that GitHub does not list', () => {
  it('asks nothing: the devspace of the repository is its only source, also with a default image set', async () => {
    h.settings.defaultImage = DEFAULT_IMAGE;
    await h.registry.add(devspace());
    // The switcher lists the repository of the devspace (pickerRepositories); the sidebar has no information on it.
    h.sidebar.repositoriesForPicker.mockResolvedValue([placeholderRepositoryInfo('acme/api')]);
    let asked = 0;
    fakeVscode.window.showQuickPick.mockImplementation(async (items: Array<{ choice?: { kind: string }; repository?: RepositoryInfo }>) => {
      asked += 1;
      return items.find((item) => item.choice?.kind === 'openRepository') ?? items.find((item) => item.repository?.nameWithOwner === 'acme/api');
    });
    await run('switchDevspace');
    // The switcher (its devspaces and Open repository…), then the repositories; no pick of a source.
    expect(asked).toBe(2);
    expect(h.service.openInWorker).not.toHaveBeenCalled();
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledWith(ENV_ID, expect.objectContaining({ source: ROOT_SOURCE }));
  });

  it('asks for the source when the repository has a default-image devspace too', async () => {
    h.settings.defaultImage = DEFAULT_IMAGE;
    await h.registry.add(devspace());
    await h.registry.add(devspace({ id: OTHER_ENV_ID, defaultImage: DEFAULT_IMAGE, volumeName: 'other', containerName: 'other' }));
    h.sidebar.repositoriesForPicker.mockResolvedValue([placeholderRepositoryInfo('acme/api')]);
    let sources: unknown[] = [];
    fakeVscode.window.showQuickPick.mockImplementation(async (items: Array<{ choice?: { kind: string }; repository?: RepositoryInfo; label: string; description?: string }>) => {
      const open = items.find((item) => item.choice?.kind === 'openRepository');
      if (open) return open;
      const repository = items.find((item) => item.repository?.nameWithOwner === 'acme/api');
      if (repository) return repository;
      sources = items.map((item) => item.label);
      return items.find((item) => item.label === 'default');
    });
    await run('switchDevspace');
    expect(sources).toEqual(['default', 'config']);
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledWith(OTHER_ENV_ID, expect.objectContaining({ source: DEFAULT_SOURCE }));
  });
});

describe('Show on GitHub', () => {
  it('opens the page of the repository', async () => {
    h.sidebar.infos.set('acme/api', repositoryInfo('acme/api'));
    await run('showOnGitHub', row('acme/api'));
    expect(fakeVscode.env.openExternal).toHaveBeenCalledWith(expect.objectContaining({ toString: expect.any(Function) }));
    expect(String(fakeVscode.env.openExternal.mock.calls[0][0])).toBe('https://github.com/acme/api');
  });

  it('from the Command Palette: picks the repository only, never a source, also for a repository with several sources', async () => {
    h.settings.defaultImage = DEFAULT_IMAGE;
    h.sidebar.infos.set('acme/api', repositoryInfo('acme/api', { configPaths: ['.devcontainer/devcontainer.json', '.devcontainer/python/devcontainer.json'] }));
    let asked = 0;
    fakeVscode.window.showQuickPick.mockImplementation(async (items: Array<{ repository?: RepositoryInfo }>) => {
      asked += 1;
      return items.find((item) => item.repository?.nameWithOwner === 'acme/api');
    });
    await run('showOnGitHub');
    expect(asked).toBe(1);
    expect(String(fakeVscode.env.openExternal.mock.calls[0][0])).toBe('https://github.com/acme/api');
    expect(h.service.openInWorker).not.toHaveBeenCalled();
  });
});

describe('Sign in and Refresh', () => {
  it('signs in, updates the context key, and loads the list', async () => {
    await run('signIn');
    expect(h.auth.getToken).toHaveBeenCalledWith({ interactive: true });
    expect(h.auth.updateContextKey).toHaveBeenCalled();
    expect(h.sidebar.onSessionChanged).toHaveBeenCalledWith({ again: false });
  });

  it('refreshes the list, restores a lost registry while Docker runs, and reads the states', async () => {
    await run('refresh');
    // As the Refresh of the user: a rate limit of GitHub that refuses it always gets a message.
    expect(h.sidebar.refreshDiscovery).toHaveBeenCalledWith({ again: true, byUser: true });
    // By the worker, made ready in full (the user asked for the refresh).
    expect(h.service.reconcileInWorker).toHaveBeenCalledWith({ passive: false });
    expect(h.sidebar.refreshStates).toHaveBeenCalled();
  });

  it('restores the devspaces from the volumes when registry.json exists but cannot be read as a registry', async () => {
    fs.writeFileSync(h.paths.registry, '{ "version": 1, "devspaces": [ { "id": ');
    await run('refresh');
    expect(h.service.reconcileInWorker).toHaveBeenCalledTimes(1);
  });

  it('leaves the check of the Docker target and of a running Docker to the restore itself', async () => {
    // The controller does not ask `docker info` first, on any endpoint (also one that is neither local nor SSH).
    fs.writeFileSync(h.paths.registry, '{ "version": 1, "devspaces": [ { "id": ');
    h.docker.isRunning.mockClear();
    let runningAsked = 0;
    h.service.reconcileInWorker.mockImplementation(async () => {
      runningAsked = h.docker.isRunning.mock.calls.length;
      return 0;
    });
    await run('refresh');
    expect(h.service.reconcileInWorker).toHaveBeenCalledTimes(1);
    expect(runningAsked).toBe(0);
  });

  it('does not restore from the volumes while registry.json is valid', async () => {
    await h.registry.add(devspace());
    await run('refresh');
    expect(h.service.reconcileInWorker).not.toHaveBeenCalled();
  });

  it('signs in on Refresh when the user is not signed in', async () => {
    h.auth.isSignedIn.mockResolvedValue(false);
    await run('refresh');
    expect(h.auth.getToken).toHaveBeenCalledWith({ interactive: true });
    expect(h.sidebar.refreshDiscovery).not.toHaveBeenCalled();
  });
});

describe('Window roles', () => {
  it('role A: runs the open pipeline before the restored window connects', async () => {
    const env = devspace();
    await h.registry.add(env);
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledWith(ENV_ID, expect.not.objectContaining({ forceRebuild: true }));
    expect(h.connection.open).not.toHaveBeenCalled();
    expect(h.statusBar.showConnected).toHaveBeenCalledWith('acme/api', 'main');
  });

  it('role A: a restored window of a default-image devspace runs the pipeline with the image of the settings now, named with its source', async () => {
    const env = devspace({ defaultImage: 'ghcr.io/majikmate/devcontainer-base:old' });
    await h.registry.add(env);
    h.settings.defaultImage = DEFAULT_IMAGE;
    h.sidebar.infos.set('acme/api', repositoryInfo('acme/api'));
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledWith(ENV_ID, expect.objectContaining({ source: DEFAULT_SOURCE }));
    expect(h.progressTitles[0]).toContain(Messages.opening('acme/api · default'));
    expect(h.statusBar.showConnected).toHaveBeenCalledWith('acme/api · default', 'main');
  });

  it('role A: the status bar takes the name of the devspace as the sidebar shows it when the states are refreshed', async () => {
    const env = devspace();
    await h.registry.add(env);
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    expect(h.statusBar.showConnected).toHaveBeenLastCalledWith('acme/api', 'main');
    // A default image is set: the repository has two sources now, and its rows are the child rows `default` and `config`.
    h.settings.defaultImage = DEFAULT_IMAGE;
    h.sidebar.infos.set('acme/api', repositoryInfo('acme/api'));
    h.controller.onStatesRefreshed();
    expect(h.statusBar.showConnected).toHaveBeenLastCalledWith('acme/api · config', 'main');
  });

  it('role A: a restored window of a configuration devspace runs the pipeline with its configuration', async () => {
    const env = devspace({ configPath: '.devcontainer/python/devcontainer.json' });
    await h.registry.add(env);
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledWith(ENV_ID, expect.objectContaining({ source: PYTHON_SOURCE }));
    // A repository that GitHub does not list, with one devspace: one row, named by the repository alone.
    expect(h.statusBar.showConnected).toHaveBeenCalledWith('acme/api', 'main');
  });

  it('role A: does not run the pipeline again when it has just run for this window', async () => {
    const env = devspace();
    await h.registry.add(env);
    await h.controller.openAttachedWindow(env, CONTAINER, { devspaceId: ENV_ID, windowId: 'old', createdAt: iso(NOW - 30_000) });
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
  });

  it('role A: does not show Reconnect for a container that the running pipeline has not started yet', async () => {
    const env = devspace();
    await h.registry.add(env);
    const pipeline = deferred<OpenResult>();
    h.service.openDevspaceInWorker.mockImplementationOnce(() => pipeline.promise);
    h.docker.containerState.mockResolvedValue('stopped');
    const opening = h.controller.openAttachedWindow(env, CONTAINER, undefined);
    await settle(() => h.service.openDevspaceInWorker.mock.calls.length === 1, 'the pipeline');
    // Heartbeats while the pipeline starts Docker and the container.
    h.controller.onHeartbeat();
    h.controller.onHeartbeat();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.docker.containerState).not.toHaveBeenCalled();

    h.docker.containerState.mockResolvedValue('running');
    pipeline.resolve(openResult(env));
    await opening;
    await settle(() => h.service.currentBranch.mock.calls.length > 0, 'the branch of the window');
    expect(h.statusBar.showConnectionLost).not.toHaveBeenCalled();
    expect(h.statusBar.showConnected).toHaveBeenLastCalledWith('acme/api', 'main');
  });

  it('role A: shows Reconnect when the pipeline fails', async () => {
    const env = devspace();
    await h.registry.add(env);
    h.service.openDevspaceInWorker.mockRejectedValueOnce(new UserFacingError('dockerStartFailed', Messages.dockerStartFailed));
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    expect(h.statusBar.showConnectionLost).toHaveBeenCalledWith('acme/api', ENV_ID);
    expect(fakeVscode.window.showErrorMessage).toHaveBeenCalledWith(Messages.dockerStartFailed, Actions.showDetails, Actions.tryAgain);
  });

  it('role A: leaves the devspace and closes the connection when "Delete devspace" removed it', async () => {
    const env = devspace();
    await h.registry.add(env);
    h.service.openDevspaceInWorker.mockImplementationOnce(async () => {
      // The files are missing, and the user selected "Delete devspace".
      await h.registry.remove(ENV_ID);
      throw new UserFacingError('cancelled', PipelineTexts.cancelled);
    });
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
    expect(h.coordinator.setDevspace).toHaveBeenCalledWith(null);
    expect(h.statusBar.showNotConnected).toHaveBeenCalled();
    expect(h.statusBar.showConnectionLost).not.toHaveBeenCalled();
    expect(h.service.currentBranch).not.toHaveBeenCalled();
  });

  it('role A: still shows Reconnect after a plain cancel', async () => {
    const env = devspace();
    await h.registry.add(env);
    h.service.openDevspaceInWorker.mockRejectedValueOnce(new UserFacingError('cancelled', PipelineTexts.cancelled));
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    expect(h.statusBar.showConnectionLost).toHaveBeenCalledWith('acme/api', ENV_ID);
    expect(h.coordinator.setDevspace).not.toHaveBeenCalled();
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
  });

  it('role A: keeps a container of the current version attached when the host access policy refuses the configuration', async () => {
    // The container passed the policy when it was made; the user can change the configuration in it.
    const env = devspace();
    await h.registry.add(env);
    h.service.openDevspaceInWorker.mockRejectedValueOnce(new UserFacingError('hostAccess', Messages.hostAccess('privileged mode')));
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    expect(h.statusBar.showConnectionLost).toHaveBeenCalledWith('acme/api', ENV_ID);
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
  });

  for (const [code, message] of [
    ['hostAccess', Messages.hostAccess('privileged mode')],
    ['cancelled', PipelineTexts.cancelled],
    ['helperFailed', Messages.helperFailed],
  ] as const) {
    it(`role A: closes the connection to a container of an older version that the failed pipeline did not make again (${code})`, async () => {
      // That container lacks the current setup; the window must not attach to it. An older setup is a label below the
      // current version, or none.
      const env = devspace();
      await h.registry.add(env);
      h.docker.findContainer.mockResolvedValue(containerInfo(code === 'cancelled' ? undefined : '0'));
      h.service.openDevspaceInWorker.mockRejectedValueOnce(new UserFacingError(code, message));
      await h.controller.openAttachedWindow(env, CONTAINER, undefined);
      await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
      // The lookup gets the name of the devspace too.
      expect(h.docker.findContainer).toHaveBeenCalledWith(ENV_ID, env.containerName);
      expect(h.coordinator.setDevspace).toHaveBeenCalledWith(null);
      expect(h.statusBar.showNotConnected).toHaveBeenCalled();
      expect(h.statusBar.showConnectionLost).not.toHaveBeenCalled();
      expect(warningMessages()).toContain(ControllerTexts.outdatedContainerClosed('acme/api'));
      expect(h.service.currentBranch).not.toHaveBeenCalled();
      // Start from the status bar does not say "already connected" to the old container.
      await run('start', { devspaceId: ENV_ID });
      expect(fakeVscode.window.showInformationMessage).not.toHaveBeenCalledWith(ControllerTexts.alreadyConnected('acme/api'));
    });
  }

  // Unknown: the window never leaves its container because the worker could not read it; an outdated state that could
  // not be read leaves nothing.
  it('role A: keeps the window attached with Reconnect when the failed pipeline is followed by a read that is unknown', async () => {
    const env = devspace();
    await h.registry.add(env);
    h.docker.findContainer.mockResolvedValue(containerInfo('0'));
    h.service.windowStateInWorker.mockResolvedValue(undefined);
    h.service.openDevspaceInWorker.mockRejectedValueOnce(new UserFacingError('helperFailed', Messages.helperFailed));
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    expect(h.statusBar.showConnectionLost).toHaveBeenCalledWith('acme/api', ENV_ID);
    await pause(20);
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
    expect(warningMessages()).not.toContain(ControllerTexts.outdatedContainerClosed('acme/api'));
  });

  it('Start: leaves a running container of an older version instead of saying that the window is connected', async () => {
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    // A version below the current one.
    h.docker.findContainer.mockResolvedValue(containerInfo('0'));
    await run('start', row('acme/api', env));
    expect(fakeVscode.window.showInformationMessage).not.toHaveBeenCalledWith(ControllerTexts.alreadyConnected('acme/api'));
    // The pipeline does not replace the container under this window; a Start from the empty window makes a new one.
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
    expect(h.coordinator.setDevspace).toHaveBeenLastCalledWith(null);
    expect(warningMessages()).toEqual([ControllerTexts.outdatedContainerClosed('acme/api')]);
  });

  it('Reconnect: leaves the devspace and closes the connection when "Delete devspace" removed it', async () => {
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    h.docker.containerState.mockResolvedValue('stopped');
    h.service.openDevspaceInWorker.mockImplementationOnce(async () => {
      await h.registry.remove(ENV_ID);
      throw new UserFacingError('cancelled', PipelineTexts.cancelled);
    });
    await run('start', { devspaceId: ENV_ID });
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
    expect(h.coordinator.setDevspace).toHaveBeenCalledWith(null);
    expect(h.statusBar.showNotConnected).toHaveBeenCalled();
    expect(h.connection.open).not.toHaveBeenCalled();
  });

  it('role B: an unreadable operation file of another devspace is reported and does not block this one', async () => {
    await h.registry.add(devspace());
    h.connection.isEmptyWindow.mockReturnValue(true);
    h.sessionFiles.writeReopenSync({ devspaceId: ENV_ID, closedAt: iso(NOW - 60_000) });
    await h.sessionFiles.writeOperation({ devspaceId: ENV_ID, operation: 'stop', requestedAt: iso(NOW - 5000), requestedBy: 'old-window', reason: 'manual' });
    const denied = h.paths.operationFile(OTHER_ENV_ID);
    fs.writeFileSync(denied, '{}');
    const readFile = fs.promises.readFile;
    const spy = vi.spyOn(fs.promises, 'readFile').mockImplementation((async (file: fs.PathLike, ...rest: unknown[]) => {
      if (String(file) === denied) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return (readFile as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
    }) as typeof fs.promises.readFile);
    try {
      await h.controller.runEmptyWindowTasks();
    } finally {
      spy.mockRestore();
    }
    expect(h.service.stop).toHaveBeenCalledWith(ENV_ID);
    expect(fs.existsSync(h.paths.operationFile(ENV_ID))).toBe(false);
    expect(fs.existsSync(denied)).toBe(true);
    expect(warningMessages()).toContainEqual(expect.stringContaining(`${OTHER_ENV_ID}.json: EACCES`));
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
  });

  it('role B: an unreadable operation file alone is reported, not dropped, and the window is not reopened', async () => {
    await h.registry.add(devspace());
    h.connection.isEmptyWindow.mockReturnValue(true);
    h.sessionFiles.writeReopenSync({ devspaceId: ENV_ID, closedAt: iso(NOW - 60_000) });
    await h.sessionFiles.writeOperation({ devspaceId: ENV_ID, operation: 'stop', requestedAt: iso(NOW - 5000), requestedBy: 'old-window', reason: 'manual' });
    const denied = h.paths.operationFile(ENV_ID);
    const readFile = fs.promises.readFile;
    const spy = vi.spyOn(fs.promises, 'readFile').mockImplementation((async (file: fs.PathLike, ...rest: unknown[]) => {
      if (String(file) === denied) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return (readFile as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
    }) as typeof fs.promises.readFile);
    try {
      await h.controller.runEmptyWindowTasks();
    } finally {
      spy.mockRestore();
    }
    expect(h.service.stop).not.toHaveBeenCalled();
    expect(fs.existsSync(denied)).toBe(true);
    expect(warningMessages()).toContainEqual(expect.stringContaining(`${ENV_ID}.json: EACCES`));
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    expect(h.connection.open).not.toHaveBeenCalled();
  });

  it('role B: a pending-operations folder that cannot be read is reported, runs nothing, and the window is not reopened', async () => {
    await h.registry.add(devspace());
    h.connection.isEmptyWindow.mockReturnValue(true);
    h.sessionFiles.writeReopenSync({ devspaceId: ENV_ID, closedAt: iso(NOW - 60_000) });
    await h.sessionFiles.writeOperation({ devspaceId: ENV_ID, operation: 'stop', requestedAt: iso(NOW - 5000), requestedBy: 'old-window', reason: 'manual' });
    const readdir = fs.promises.readdir;
    const spy = vi.spyOn(fs.promises, 'readdir').mockImplementation((async (dir: fs.PathLike, ...rest: unknown[]) => {
      if (String(dir) === h.paths.operationsDir) throw Object.assign(new Error('EIO: i/o error, scandir'), { code: 'EIO' });
      return (readdir as (...args: unknown[]) => Promise<unknown>)(dir, ...rest);
    }) as typeof fs.promises.readdir);
    try {
      await expect(h.controller.runEmptyWindowTasks()).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    expect(h.service.stop).not.toHaveBeenCalled();
    expect(fs.existsSync(h.paths.operationFile(ENV_ID))).toBe(true);
    expect(warningMessages()).toContainEqual(expect.stringContaining('EIO'));
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    expect(h.connection.open).not.toHaveBeenCalled();
  });

  // The Stop removes the reopen record that the closing window wrote, so a later start of VS Code does not reconnect to
  // the stopped devspace.
  it('role B: runs a pending stop and removes the reopen record; a later start does not reopen the devspace', async () => {
    await h.registry.add(devspace());
    h.connection.isEmptyWindow.mockReturnValue(true);
    // The window that closed its connection for the Stop wrote the reopen record in its deactivate().
    h.sessionFiles.writeReopenSync({ devspaceId: ENV_ID, closedAt: iso(NOW - 5000) });
    await h.sessionFiles.writeOperation({
      devspaceId: ENV_ID,
      operation: 'stop',
      requestedAt: iso(NOW - 5000),
      requestedBy: 'old-window',
      reason: 'manual',
    });
    await h.controller.runEmptyWindowTasks();
    expect(h.service.stop).toHaveBeenCalledWith(ENV_ID);
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    expect(await h.sessionFiles.readReopen()).toBeUndefined();

    // The next start of VS Code, later: nothing to reopen.
    await h.controller.runEmptyWindowTasks();
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    expect(h.connection.open).not.toHaveBeenCalled();
  });

  it('role B: runs a pending rebuild, removes the operation, and connects the window again', async () => {
    await h.registry.add(devspace());
    await h.sessionFiles.writeOperation({
      devspaceId: ENV_ID,
      operation: 'rebuild',
      requestedAt: iso(NOW - 5000),
      requestedBy: 'old-window',
      reason: 'configChanged',
    });
    h.connection.isEmptyWindow.mockReturnValue(true);
    let operationsAtConnect: number | undefined;
    h.connection.open.mockImplementation(async () => {
      operationsAtConnect = fs.readdirSync(h.paths.operationsDir).length;
    });
    await h.controller.runEmptyWindowTasks();
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledWith(ENV_ID, expect.objectContaining({ forceRebuild: true, source: ROOT_SOURCE }));
    expect(operationsAtConnect).toBe(0);
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
  });

  it('role B: runs a pending rebuild of a default-image devspace from the default image of the settings now', async () => {
    await h.registry.add(devspace({ defaultImage: 'node:22' }));
    h.settings.defaultImage = DEFAULT_IMAGE;
    await h.sessionFiles.writeOperation({
      devspaceId: ENV_ID,
      operation: 'rebuild',
      requestedAt: iso(NOW - 5000),
      requestedBy: 'old-window',
      reason: 'manual',
    });
    h.connection.isEmptyWindow.mockReturnValue(true);
    await h.controller.runEmptyWindowTasks();
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledWith(ENV_ID, expect.objectContaining({ forceRebuild: true, source: DEFAULT_SOURCE }));
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
  });

  it('role B: runs a pending delete and a pending stop', async () => {
    await h.registry.add(devspace());
    await h.registry.add(devspace({ id: 'b1c2d3e4-0000-4000-8000-000000000002', repository: 'acme/web', containerName: 'web', volumeName: 'web' }));
    await h.sessionFiles.writeOperation({
      devspaceId: ENV_ID,
      operation: 'delete',
      requestedAt: iso(NOW - 5000),
      requestedBy: 'old-window',
      reason: 'manual',
      additionalVolumesToRemove: ['api-db'],
    });
    await h.sessionFiles.writeOperation({
      devspaceId: 'b1c2d3e4-0000-4000-8000-000000000002',
      operation: 'stop',
      requestedAt: iso(NOW - 4000),
      requestedBy: 'old-window',
      reason: 'manual',
    });
    await h.controller.runEmptyWindowTasks();
    expect(h.service.deleteInWorker).toHaveBeenCalledWith(ENV_ID, expect.objectContaining({ additionalVolumesToRemove: ['api-db'] }));
    expect(h.service.stop).toHaveBeenCalledWith('b1c2d3e4-0000-4000-8000-000000000002');
    expect(fs.readdirSync(h.paths.operationsDir)).toEqual([]);
    expect(h.connection.open).not.toHaveBeenCalled();
  });

  it('role B: drops a pending operation older than 10 minutes without running it', async () => {
    await h.registry.add(devspace());
    await h.sessionFiles.writeOperation({
      devspaceId: ENV_ID,
      operation: 'rebuild',
      requestedAt: iso(NOW - 11 * 60_000),
      requestedBy: 'old-window',
      reason: 'manual',
    });
    h.connection.isEmptyWindow.mockReturnValue(true);
    await h.controller.runEmptyWindowTasks();
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    expect(await h.sessionFiles.readOperations()).toEqual([]);
  });

  it('role B: opens the last devspace when the reopen rule allows it', async () => {
    await h.registry.add(devspace());
    h.sessionFiles.writeReopenSync({ devspaceId: ENV_ID, closedAt: iso(NOW - 60_000) });
    h.connection.isEmptyWindow.mockReturnValue(true);
    await h.controller.runEmptyWindowTasks();
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledWith(ENV_ID, expect.anything());
    expect(h.progressTitles[0]).toContain(Messages.opening('acme/api'));
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
  });

  // A reopen from the macOS Dock a few seconds after the quit: with the 5-second guard, 6 seconds reopen and 4 seconds
  // do not.
  it('role B: reopens a record older than 5 seconds, and not one of 4 seconds', async () => {
    await h.registry.add(devspace());
    h.connection.isEmptyWindow.mockReturnValue(true);
    h.sessionFiles.writeReopenSync({ devspaceId: ENV_ID, closedAt: iso(NOW - 4_000) });
    await h.controller.runEmptyWindowTasks();
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    h.sessionFiles.writeReopenSync({ devspaceId: ENV_ID, closedAt: iso(NOW - 6_000) });
    await h.controller.runEmptyWindowTasks();
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledWith(ENV_ID, expect.anything());
  });

  // The age of the reopen record is measured at activation, not after the awaits (ready, the stale claims, the
  // operations, the GitHub account) and the pause of REOPEN_CHECK_DELAY_MS. Otherwise a Close Remote Connection whose
  // empty window activates 3 seconds later is checked at about 6 seconds and reconnects.
  it('role B: measures the age of the reopen record at activation, not after the awaits and the pause', async () => {
    await h.registry.add(devspace());
    h.connection.isEmptyWindow.mockReturnValue(true);
    let now = NOW;
    h.clock.now = () => now;
    const advancing = (): void => {
      // The status file (ready), the GitHub account, and the pause before the check each take time.
      h.controller.setReady(Promise.resolve().then(() => (now += 500)));
      h.auth.getAccount.mockImplementationOnce(async () => {
        now += 1_000;
        return ACCOUNT;
      });
      h.coordinator.otherActiveWindows.mockImplementationOnce(async () => {
        now += 1_500;
        return [];
      });
    };

    // 3 seconds old at activation (Close Remote Connection), 6 seconds old at the check: no reopen.
    advancing();
    h.sessionFiles.writeReopenSync({ devspaceId: ENV_ID, closedAt: iso(now - 3_000) });
    await h.controller.runEmptyWindowTasks();
    expect(now - Date.parse((await h.sessionFiles.readReopen())!.closedAt)).toBe(6_000);
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();

    // 6 seconds old at activation: a reopen.
    advancing();
    h.sessionFiles.writeReopenSync({ devspaceId: ENV_ID, closedAt: iso(now - 6_000) });
    await h.controller.runEmptyWindowTasks();
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledWith(ENV_ID, expect.anything());
  });

  it('role B: does not reopen after Close Remote Connection, with another window, or when the setting is off', async () => {
    await h.registry.add(devspace());
    h.connection.isEmptyWindow.mockReturnValue(true);
    // Close Remote Connection brings up the empty window within 1 to 3 seconds. The guard is 5 seconds.
    h.sessionFiles.writeReopenSync({ devspaceId: ENV_ID, closedAt: iso(NOW - 3_000) });
    await h.controller.runEmptyWindowTasks();

    h.sessionFiles.writeReopenSync({ devspaceId: ENV_ID, closedAt: iso(NOW - 60_000) });
    h.coordinator.otherActiveWindows.mockResolvedValueOnce([
      { windowId: OTHER_WINDOW_ID, pid: OTHER_PID, devspaceId: null, state: 'active', updatedAt: iso(NOW) },
    ]);
    await h.controller.runEmptyWindowTasks();

    h.settings.reopenLastOnStartup = false;
    await h.controller.runEmptyWindowTasks();
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
  });
});

// The question about the Monitor of an engine (monitorQuestion.ts): a Start, a Rebuild and "Update All Images Now" that
// the user started ask it before they run on the engine (the fake here records the hosts); the flows that run by
// themselves never ask, so the Monitor that they make sure of stops when idle until the engine has an answer.
describe('the question about the Monitor of the engine', () => {
  const asked = (): string[] => h.monitorQuestion.askIfNeeded.mock.calls.map((call) => call[0]);
  /** The question came before the first call of `open`. */
  const askedBefore = (open: Mock): boolean => h.monitorQuestion.askIfNeeded.mock.invocationCallOrder[0] < open.mock.invocationCallOrder[0];

  it('a Start of the user asks about the engine of the operation before its open; a closed question goes on', async () => {
    const info = repositoryInfo('acme/api');
    h.sidebar.infos.set('acme/api', info);
    h.monitorQuestion.askIfNeeded.mockResolvedValue('closed');
    h.service.openInWorker.mockImplementation(async () => {
      const env = devspace();
      await h.registry.add(env);
      return openResult(env);
    });
    await run('start', row('acme/api', undefined, info));
    expect(asked()).toEqual(['']);
    expect(askedBefore(h.service.openInWorker)).toBe(true);
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
    // A Start of an existing devspace too.
    await run('startInNewWindow', row('acme/api', devspace()));
    expect(asked()).toEqual(['', '']);
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledTimes(1);
  });

  it('a Start asks about the engine of its devspace', async () => {
    const target = remoteDockerTarget('build-box');
    recreateHarness({
      dockerTargets: {
        resolve: async () => target,
        current: async () => operationDockerTarget() ?? target,
        withOperation: <T,>(fn: () => Promise<T>) => runWithDockerTarget(target, fn),
        ofHost: async (host: string) => (host === '' ? dockerTargetOf('unix:///var/run/docker.sock', 'default') : remoteDockerTarget(host)),
      } as unknown as ControllerDeps['dockerTargets'],
    });
    const remote = devspace({ dockerHost: 'build-box' });
    await h.registry.add(remote);
    await run('start', row('acme/api', remote));
    expect(asked()).toEqual(['build-box']);
    // A local devspace, while Devspaces uses build-box: its Start runs on the local Docker and asks about that engine.
    const local = devspace({ id: OTHER_ENV_ID, repository: 'acme/web', containerName: 'devspaces-acme-web-7c1d2e3f' });
    await h.registry.add(local);
    await run('start', row('acme/web', local));
    expect(asked()).toEqual(['build-box', '']);
  });

  // Mutation: a Try again that runs in the ended scope of the failed Start takes the host that Devspaces uses (build-box).
  it('Try again of a failed Start runs on the Docker host of its devspace', async () => {
    const target = remoteDockerTarget('build-box');
    recreateHarness({
      dockerTargets: {
        resolve: async () => target,
        current: async () => operationDockerTarget() ?? target,
        withOperation: <T,>(fn: () => Promise<T>) => (operationDockerTarget() ? fn() : runWithDockerTarget(target, fn)),
        ofHost: async (host: string) => (host === '' ? dockerTargetOf('unix:///var/run/docker.sock', 'default') : remoteDockerTarget(host)),
      } as unknown as ControllerDeps['dockerTargets'],
    });
    const local = devspace();
    await h.registry.add(local);
    const hosts: Array<string | undefined> = [];
    h.service.openDevspaceInWorker.mockImplementation(async () => {
      hosts.push(operationDockerTarget()?.host);
      if (hosts.length === 1) throw new UserFacingError('buildFailed', Messages.buildFailed, 'log');
      return openResult(local);
    });
    fakeVscode.window.showErrorMessage.mockResolvedValueOnce(Actions.tryAgain);
    await run('start', row('acme/api', local));
    await settle(() => hosts.length === 2, 'Try again');
    expect(hosts).toEqual(['', '']);
  });

  // The newest request wins (connect): a Start of the user takes its connect request before its question, so the
  // automatic reopen, whose pipeline ends while the question is open, does not take the window. Mutation: a Start that
  // takes its request only after the question fails it.
  it('the automatic reopen does not connect while the question of a newer Start of the user is open', async () => {
    const web = devspace({ id: OTHER_ENV_ID, repository: 'acme/web', containerName: 'web', volumeName: 'web', remoteWorkspaceFolder: '/workspaces/web' });
    await h.registry.add(devspace());
    await h.registry.add(web);
    h.sessionFiles.writeReopenSync({ devspaceId: ENV_ID, closedAt: iso(NOW - 60_000) });
    h.connection.isEmptyWindow.mockReturnValue(true);
    const reopenPipeline = deferred<OpenResult>();
    h.service.openDevspaceInWorker.mockImplementation(async (id: string) => (id === ENV_ID ? reopenPipeline.promise : openResult(web)));
    const answer = deferred<string>();
    h.monitorQuestion.askIfNeeded.mockReturnValueOnce(answer.promise);
    const reopen = h.controller.runEmptyWindowTasks();
    await settle(() => h.service.openDevspaceInWorker.mock.calls.length === 1, 'the pipeline of the reopen');
    const start = run('start', row('acme/web', web));
    await settle(() => asked().length === 1, 'the question');
    reopenPipeline.resolve(openResult(devspace()));
    await reopen;
    expect(h.connection.open).not.toHaveBeenCalled();
    expect(h.logger.info).toHaveBeenCalledWith('acme/api is not connected: another devspace is opening in this window.');
    answer.resolve('keepRunning');
    await start;
    expect(h.connection.open.mock.calls).toEqual([['web', '/workspaces/web']]);
  });

  // The reopen rule runs a few seconds after the start of the window: a Start of the user in that time, also while its
  // question is open, is not overtaken by the reopen. Mutation: a reopen that does not look at the requests fails it.
  it('the automatic reopen does not start while a Start of the user in this window asks or runs', async () => {
    const web = devspace({ id: OTHER_ENV_ID, repository: 'acme/web', containerName: 'web', volumeName: 'web', remoteWorkspaceFolder: '/workspaces/web' });
    await h.registry.add(devspace());
    await h.registry.add(web);
    h.sessionFiles.writeReopenSync({ devspaceId: ENV_ID, closedAt: iso(NOW - 60_000) });
    h.connection.isEmptyWindow.mockReturnValue(true);
    h.service.openDevspaceInWorker.mockImplementation(async () => openResult(web));
    const answer = deferred<string>();
    h.monitorQuestion.askIfNeeded.mockReturnValueOnce(answer.promise);
    const start = run('start', row('acme/web', web));
    await settle(() => asked().length === 1, 'the question');
    await h.controller.runEmptyWindowTasks();
    expect(h.logger.info).toHaveBeenCalledWith('The last devspace is not opened: another devspace is opening in this window.');
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    answer.resolve('keepRunning');
    await start;
    expect(h.service.openDevspaceInWorker.mock.calls.map(([id]) => id)).toEqual([OTHER_ENV_ID]);
    expect(h.connection.open.mock.calls).toEqual([['web', '/workspaces/web']]);
  });

  it('the reopen at startup asks nothing; its Try again is a Start of the user', async () => {
    await h.registry.add(devspace());
    h.sessionFiles.writeReopenSync({ devspaceId: ENV_ID, closedAt: iso(NOW - 60_000) });
    h.connection.isEmptyWindow.mockReturnValue(true);
    h.service.openDevspaceInWorker.mockRejectedValueOnce(new UserFacingError('buildFailed', Messages.buildFailed, 'log'));
    fakeVscode.window.showErrorMessage.mockResolvedValueOnce(Actions.tryAgain);
    await h.controller.runEmptyWindowTasks();
    // The reopen runs in the background.
    await settle(() => h.service.openDevspaceInWorker.mock.calls.length >= 1, 'the reopen');
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledWith(ENV_ID, expect.anything());
    await settle(() => h.service.openDevspaceInWorker.mock.calls.length === 2, 'the Try again');
    expect(asked()).toEqual(['']);
    expect(h.monitorQuestion.askIfNeeded.mock.invocationCallOrder[0]).toBeGreaterThan(h.service.openDevspaceInWorker.mock.invocationCallOrder[0]);
  });

  it('a restored window and a pending Rebuild ask nothing', async () => {
    const env = devspace();
    await h.registry.add(env);
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledTimes(1);
    h.connection.isEmptyWindow.mockReturnValue(true);
    await h.sessionFiles.writeOperation({ devspaceId: OTHER_ENV_ID, operation: 'rebuild', requestedAt: iso(NOW - 5000), requestedBy: 'old-window', reason: 'manual' });
    await h.registry.add(devspace({ id: OTHER_ENV_ID, repository: 'acme/web', containerName: 'devspaces-acme-web-7c1d2e3f' }));
    await h.controller.runEmptyWindowTasks();
    expect(h.service.openDevspaceInWorker).toHaveBeenLastCalledWith(OTHER_ENV_ID, expect.objectContaining({ forceRebuild: true }));
    expect(asked()).toEqual([]);
  });

  it('a Rebuild of the user asks first, also before the hand-off of the connected window', async () => {
    await h.registry.add(devspace());
    await run('rebuild', row('acme/api', devspace()));
    expect(asked()).toEqual(['']);
    expect(askedBefore(h.service.openDevspaceInWorker)).toBe(true);
    const env = devspace();
    await connectHere(env);
    await run('rebuild', row('acme/api', env));
    expect(asked()).toEqual(['', '']);
    expect(h.connection.closeRemoteConnection).toHaveBeenCalled();
    expect(h.monitorQuestion.askIfNeeded.mock.invocationCallOrder[1]).toBeLessThan(h.connection.closeRemoteConnection.mock.invocationCallOrder[0]);
  });

  it('Stop and Delete ask nothing', async () => {
    await h.registry.add(devspace());
    await run('stop', row('acme/api', devspace()));
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.delete);
    await run('delete', row('acme/api', devspace()));
    expect(h.service.stop).toHaveBeenCalled();
    expect(h.service.deleteInWorker).toHaveBeenCalledWith(ENV_ID, expect.anything());
    expect(asked()).toEqual([]);
  });
});

/** The Docker engine that "Remove Devspaces from This Docker Engine…" sees through the Docker CLI of the extension. */
interface RemovalEngine {
  containers: Array<{ id: string; name: string; labels: string }>;
  /** The shared volumes that exist. */
  volumes: string[];
  images: Array<{ id: string; tags: string[]; createdAt: string }>;
  /** Volumes whose removal Docker refuses, as in use. */
  inUse: string[];
  /** The containers and volumes of devspaces (the label nimblescape.devspaces.id with its ID). */
  devspaceVolumes: Array<{ name: string; id: string }>;
}

function removalFake(options: { answers?: boolean; engine?: Partial<RemovalEngine> } = {}) {
  const engine: RemovalEngine = {
    containers: [
      { id: 'm1', name: 'devspaces-monitor', labels: 'nimblescape.devspaces.monitor=0123456789ab' },
      { id: 'w1', name: 'devspaces-api-worker1', labels: 'nimblescape.devspaces.worker-run=true' },
    ],
    volumes: ['devspaces-monitor', 'devspaces-worker-cache', 'devspaces-vscode'],
    images: [{ id: 'sha256:1', tags: ['devspaces-monitor:0123456789ab', 'devspaces-worker:0123456789ab'], createdAt: 'x' }],
    inUse: [],
    devspaceVolumes: [],
    ...options.engine,
  };
  /** What happened, in order: the Docker calls that change something, the end of the worker, and the deletes. */
  const order: string[] = [];
  const result = (stdout: string, exitCode = 0, stderr = '') => ({ exitCode, stdout, stderr, timedOut: false });
  const lines = (values: unknown[]) => values.map((value) => `${JSON.stringify(value)}\n`).join('');
  const run = vi.fn(async (args: readonly string[]) => {
    const filter = args[args.indexOf('--filter') + 1] ?? '';
    if (args[0] === 'ps') {
      const label = filter.replace(/^label=/, '');
      return result(lines(engine.containers.filter((c) => c.labels.split(',').some((pair) => pair.split('=')[0] === label)).map((c) => ({ ID: c.id, Names: c.name, Labels: c.labels }))));
    }
    if (args[0] === 'volume' && args[1] === 'ls') {
      if (filter.startsWith('label=')) return result(lines(engine.devspaceVolumes.map((v) => ({ Name: v.name, Labels: `nimblescape.devspaces.id=${v.id}` }))));
      return result(lines(engine.volumes.map((name) => ({ Name: name, Labels: '' }))));
    }
    order.push(`docker ${args.join(' ')}`);
    if (args[0] === 'rm') {
      engine.containers = engine.containers.filter((c) => c.id !== args[2]);
      return result('');
    }
    if (args[0] === 'image' && args[1] === 'rm') {
      for (const image of engine.images) image.tags = image.tags.filter((tag) => tag !== args[2]);
      engine.images = engine.images.filter((image) => image.tags.length > 0 && image.id !== args[2]);
      return result('');
    }
    if (args[0] === 'volume' && args[1] === 'rm') {
      if (engine.inUse.includes(args[2])) return result('', 1, `Error response from daemon: remove ${args[2]}: volume is in use - [d1]`);
      if (!engine.volumes.includes(args[2])) return result('', 1, `Error response from daemon: get ${args[2]}: no such volume`);
      engine.volumes = engine.volumes.filter((name) => name !== args[2]);
      return result('');
    }
    return result('', 1, `unexpected call: docker ${args.join(' ')}`);
  });
  const deps = {
    engineAnswers: vi.fn(async (_target: DockerTarget, _signal: AbortSignal) => options.answers ?? true),
    docker: { run, listImagesByLabel: vi.fn(async () => engine.images.map((image) => ({ ...image, tags: [...image.tags] }))) },
    closeWorker: vi.fn((target: DockerTarget) => void order.push(`close the worker on ${target.host || 'the local Docker'}`)),
    stopHelperBuilds: vi.fn(async (target: DockerTarget) => void order.push(`stop the helper builds on ${target.host || 'the local Docker'}`)),
    computerId: () => 'c'.repeat(32),
  };
  return { engine, order, deps };
}

describe('Remove Devspaces from This Docker Engine…', () => {
  const BUILD_BOX = remoteDockerTarget('build-box');
  /** A harness on the engine build-box with the removal `fake` (and `options`). */
  function onBuildBox(fake: ReturnType<typeof removalFake>, target: DockerTarget = BUILD_BOX, options: Parameters<typeof createHarness>[0] = {}): void {
    recreateHarness({
      dockerTargets: {
        resolve: async () => target,
        current: async () => operationDockerTarget() ?? target,
        withOperation: <T,>(fn: () => Promise<T>) => runWithDockerTarget(target, fn),
        ofHost: async (host: string) => (host === '' ? dockerTargetOf('unix:///var/run/docker.sock', 'default') : remoteDockerTarget(host)),
      } as unknown as ControllerDeps['dockerTargets'],
      engineRemoval: fake.deps as unknown as ControllerDeps['engineRemoval'],
      ...options,
    });
    h.service.deleteInWorker.mockImplementation(async (id: string) => {
      fake.order.push(`delete ${id}`);
      await h.registry.remove(id);
    });
  }
  /** The devspace of the signed-in account on build-box, with recorded changes and an additional volume. */
  const ownRemote = (): Devspace =>
    devspace({
      dockerHost: 'build-box',
      additionalVolumes: ['acme-api-data'],
      gitSummary: { branch: 'main', uncommittedFiles: 2, unpushedCommits: 1, stashes: 0, recordedAt: iso(NOW - 3_600_000) },
    });
  const otherAccountRemote = (): Devspace =>
    devspace({ id: OTHER_ENV_ID, repository: 'acme/web', containerName: 'devspaces-acme-web-7c1d2e3f', volumeName: 'devspaces-acme-web-7c1d2e3f', dockerHost: 'build-box', owner: OTHER_ACCOUNT });
  const modals = () => fakeVscode.window.showWarningMessage.mock.calls.filter((call: unknown[]) => (call[1] as { modal?: boolean } | undefined)?.modal === true);
  const changing = (fake: ReturnType<typeof removalFake>) => fake.order.filter((step) => !step.startsWith('docker ps') && !step.startsWith('docker volume ls'));
  /** The removal that window 2 runs (its entry in docker-engines.json). */
  const OTHER_REMOVAL = { windowId: OTHER_WINDOW_ID, pid: OTHER_PID, since: iso(NOW - 30_000) };
  /** Window 2 removes Devspaces from `host`: its entry with the mark, its process, and its status file. */
  async function otherWindowRemoves(host = 'build-box'): Promise<void> {
    h.alive.add(OTHER_PID);
    await h.sessionFiles.writeWindowStatus({ windowId: OTHER_WINDOW_ID, pid: OTHER_PID, devspaceId: null, state: 'active', updatedAt: iso(NOW - 5000) });
    await h.engineRecords.startRemoval(host, OTHER_REMOVAL, NOW - 30_000, () => true);
  }
  const infoMessages = (): string[] => fakeVscode.window.showInformationMessage.mock.calls.map((call: unknown[]) => String(call[0]));

  it('asks twice, then deletes the devspaces of the account, ends the worker, and removes the Monitor, the helpers and the volumes', async () => {
    const fake = removalFake({ engine: { inUse: ['devspaces-vscode'] } });
    onBuildBox(fake);
    await h.registry.add(ownRemote());
    await h.registry.add(otherAccountRemote());
    // A devspace of the local Docker is not on this engine.
    await h.registry.add(devspace({ id: '7c1d2e3f-0000-4000-8000-000000000003', repository: 'acme/local', containerName: 'devspaces-acme-local-1', volumeName: 'devspaces-acme-local-1' }));
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(ControllerTexts.remove).mockResolvedValueOnce(ControllerTexts.deleteDevspacesToo);
    await run('removeFromDockerEngine');
    expect(modals()).toEqual([
      [
        'Remove Devspaces from build-box?',
        { modal: true, detail: `${ControllerTexts.removeDetail} The devspaces of GitHub accounts that are not signed in to Devspaces stay: acme/web.` },
        'Remove',
      ],
      [
        'Also delete your devspace on build-box?',
        {
          modal: true,
          detail:
            'Each one is deleted with its container and all its volumes, also the clone of the repository. Changes that you did not push are lost. ' +
            'Recorded changes: acme/api (2 uncommitted · 1 unpushed). If you keep the devspaces, the volume devspaces-vscode stays while they use it.',
        },
        'Delete Devspaces Too',
        'Keep Devspaces',
      ],
    ]);
    // Each with all its volumes; never the devspace of the other account, never the one of another engine.
    expect(h.service.deleteInWorker).toHaveBeenCalledTimes(1);
    expect(h.service.deleteInWorker).toHaveBeenCalledWith(ENV_ID, expect.objectContaining({ additionalVolumesToRemove: ['acme-api-data'] }));
    // The background builds of the helper image stop before the images are removed.
    expect(changing(fake)).toEqual([
      `delete ${ENV_ID}`,
      'stop the helper builds on build-box',
      'close the worker on build-box',
      'docker rm -f m1',
      'docker rm -f w1',
      'docker image rm devspaces-monitor:0123456789ab',
      'docker image rm devspaces-worker:0123456789ab',
      'docker volume rm devspaces-monitor',
      'docker volume rm devspaces-worker-cache',
      'docker volume rm devspaces-vscode',
    ]);
    expect(fake.deps.closeWorker).toHaveBeenCalledWith(BUILD_BOX);
    // Docker was never started: only asked whether it answers, on this engine.
    expect(fake.deps.engineAnswers).toHaveBeenCalledWith(BUILD_BOX, expect.any(AbortSignal));
    expect(await h.engineRecords.removed('build-box')).toBe(true);
    expect(await h.engineRecords.removed('')).toBe(false);
    // The other account's devspace still uses the store of the VS Code Server.
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(
      'Devspaces was removed from build-box. The volume devspaces-vscode stays because devspaces still use it.',
    );
    expect(h.progressTitles.some((title) => title.startsWith('Removing Devspaces from build-box…'))).toBe(true);
    expect(h.progressTitles.some((title) => title.includes('Removing the container devspaces-monitor.'))).toBe(true);
  });

  it('with several accounts, deletes the devspaces of all accounts of Devspaces and names the accounts', async () => {
    const fake = removalFake({ engine: { inUse: ['devspaces-vscode'] } });
    onBuildBox(fake);
    h.auth.accounts.mockResolvedValue([ACCOUNT, OTHER_ACCOUNT]);
    await h.registry.add(ownRemote());
    await h.registry.add(otherAccountRemote());
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(ControllerTexts.remove).mockResolvedValueOnce(ControllerTexts.deleteDevspacesToo);
    await run('removeFromDockerEngine');
    const [first, second] = modals();
    // No devspace of an account that is not signed in stays.
    expect(first?.[1]).toEqual({ modal: true, detail: ControllerTexts.removeDetail });
    expect(second?.[0]).toBe('Also delete the 2 devspaces of your GitHub accounts octo, someone on build-box?');
    expect(h.service.deleteInWorker.mock.calls.map((call) => call[0]).sort()).toEqual([ENV_ID, OTHER_ENV_ID].sort());
  });

  it('Keep Devspaces deletes none; Cancel of either question removes nothing and sets no mark', async () => {
    const kept = removalFake({ engine: { inUse: ['devspaces-vscode'] } });
    onBuildBox(kept);
    await h.registry.add(ownRemote());
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(ControllerTexts.remove).mockResolvedValueOnce(ControllerTexts.keepDevspaces);
    await run('removeFromDockerEngine');
    expect(h.service.deleteInWorker).not.toHaveBeenCalled();
    expect(changing(kept).slice(0, 2)).toEqual(['stop the helper builds on build-box', 'close the worker on build-box']);
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(
      'Devspaces was removed from build-box. The volume devspaces-vscode stays because devspaces still use it.',
    );

    for (const answers of [[undefined], [ControllerTexts.remove, undefined]]) {
      const cancelled = removalFake();
      onBuildBox(cancelled);
      await h.registry.add(ownRemote());
      for (const answer of answers) fakeVscode.window.showWarningMessage.mockResolvedValueOnce(answer);
      await run('removeFromDockerEngine');
      expect(modals()).toHaveLength(answers.length);
      expect(changing(cancelled)).toEqual([]);
      expect(h.service.deleteInWorker).not.toHaveBeenCalled();
      expect(await h.engineRecords.removed('build-box')).toBe(false);
    }
  });

  it('warns on a shared engine (devspaces that this computer does not know), and without a sign-in keeps the devspaces', async () => {
    const fake = removalFake({ engine: { devspaceVolumes: [{ name: 'devspaces-other-1', id: '99999999-0000-4000-8000-000000000009' }] } });
    onBuildBox(fake);
    await h.registry.add(ownRemote());
    h.auth.getAccount.mockResolvedValue(undefined);
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(ControllerTexts.remove);
    await run('removeFromDockerEngine');
    expect(modals()).toEqual([
      [
        'Remove Devspaces from build-box?',
        { modal: true, detail: `${ControllerTexts.removeDetail} ${ControllerTexts.removeUnknownDevspaces} ${ControllerTexts.removeSignedOut}` },
        'Remove',
      ],
    ]);
    expect(h.service.deleteInWorker).not.toHaveBeenCalled();
    expect(changing(fake)).toContain('docker rm -f m1');
  });

  it('refuses while a window is connected to a devspace on the engine, or an operation runs, and asks Docker nothing then', async () => {
    const fake = removalFake();
    onBuildBox(fake);
    const env = ownRemote();
    await h.registry.add(env);
    otherWindowConnected(ENV_ID);
    await run('removeFromDockerEngine');
    expect(warningMessages()).toEqual(['Close the windows of your devspaces on build-box first: acme/api. Nothing was removed.']);
    h.coordinator.otherActiveWindows.mockResolvedValue([]);

    await otherWindowBusy(env);
    await run('removeFromDockerEngine');
    expect(warningMessages().at(-1)).toBe('Update of acme/api is still running. Try again after it ends. Nothing was removed.');
    await h.registry.updateDevspace(ENV_ID, (entry) => {
      delete entry.busy;
    });

    // An operation of this window: the check of a Delete that waits.
    const check = deferred<DeleteDecision>();
    h.service.deleteCheckInWorker.mockReturnValueOnce(check.promise);
    const deleting = run('delete', row('acme/api', env));
    await settle(() => h.service.deleteCheckInWorker.mock.calls.length === 1, 'the check of the Delete');
    await run('removeFromDockerEngine');
    expect(warningMessages().at(-1)).toBe('Delete of acme/api is still running. Try again after it ends. Nothing was removed.');
    check.resolve({ decision: 'cancel' });
    await deleting;
    expect(fake.deps.engineAnswers).not.toHaveBeenCalled();
    expect(fake.order).toEqual([]);
    expect(await h.engineRecords.removed('build-box')).toBe(false);
  });

  // A window that works without Devspaces on a kept devspace is attached to its container, so "Delete Devspaces Too"
  // would delete the devspace under it. Mutation: a check that sees only the connected devspaces fails it.
  it('refuses while a window works without Devspaces on a devspace there: this window or another one', async () => {
    const plain: WindowStatus = { windowId: OTHER_WINDOW_ID, pid: OTHER_PID, devspaceId: null, plainDevspaceId: ENV_ID, state: 'active', updatedAt: iso(NOW) };
    const closeFirst = 'Close the windows of your devspaces on build-box first: acme/api. Nothing was removed.';
    const here = removalFake();
    onBuildBox(here);
    await h.engineRecords.setRemoved('build-box', NOW - 1000);
    const env = ownRemote();
    await h.registry.add(env);
    await h.controller.workWithoutDevspaces(env, CONTAINER);
    // Its status file names the devspace apart from the devspace of the window (no heartbeat goes to it).
    expect(h.coordinator.setPlainDevspace.mock.calls).toEqual([[ENV_ID]]);
    expect(h.coordinator.setDevspace).not.toHaveBeenCalled();
    await run('removeFromDockerEngine');
    expect(warningMessages()).toEqual([closeFirst]);
    expect(here.deps.engineAnswers).not.toHaveBeenCalled();
    expect(here.order).toEqual([]);

    const other = removalFake();
    onBuildBox(other);
    await h.registry.add(ownRemote());
    h.coordinator.otherActiveWindows.mockResolvedValue([plain]);
    await run('removeFromDockerEngine');
    expect(warningMessages()).toEqual([closeFirst]);
    expect(other.deps.engineAnswers).not.toHaveBeenCalled();
    expect(other.order).toEqual([]);
    expect(h.service.deleteInWorker).not.toHaveBeenCalled();
  });

  it('refuses an engine that does not answer and an unsupported endpoint; with nothing to remove it only sets the mark', async () => {
    const silent = removalFake({ answers: false });
    onBuildBox(silent);
    await run('removeFromDockerEngine');
    expect(warningMessages()).toEqual(['Devspaces cannot reach build-box. Nothing was removed. Start Docker there, then try again.']);
    expect(silent.order).toEqual([]);
    expect(await h.engineRecords.removed('build-box')).toBe(false);

    const tcp = removalFake();
    onBuildBox(tcp, dockerTargetOf('tcp://build-box:2375', 'tcp-box'));
    await run('removeFromDockerEngine');
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledWith(Messages.dockerEndpointUnsupported('tcp://build-box:2375'), Actions.showDetails);
    expect(tcp.deps.engineAnswers).not.toHaveBeenCalled();

    const empty = removalFake({ engine: { containers: [], volumes: [], images: [] } });
    onBuildBox(empty);
    await run('removeFromDockerEngine');
    expect(modals()).toEqual([]);
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith('Devspaces has nothing on build-box to remove.');
    expect(empty.order).toEqual([]);
    expect(await h.engineRecords.removed('build-box')).toBe(true);
  });

  it('warns with Show details when items are left, or a devspace could not be deleted', async () => {
    const fake = removalFake({ engine: { inUse: ['devspaces-worker-cache'] } });
    onBuildBox(fake);
    await h.registry.add(ownRemote());
    h.service.deleteInWorker.mockRejectedValueOnce(new UserFacingError('helperFailed', 'The worker could not be reached.'));
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(ControllerTexts.remove).mockResolvedValueOnce(ControllerTexts.deleteDevspacesToo);
    await run('removeFromDockerEngine');
    // The cache of the worker in use, and the devspace: the store of the VS Code Server stays for that devspace.
    expect(fakeVscode.window.showWarningMessage).toHaveBeenLastCalledWith(
      '2 items of Devspaces could not be removed from build-box. The log names each one and the command to remove it.',
      Actions.showDetails,
    );
    const warnings = h.logger.warn.mock.calls.map((call) => String(call[0]));
    expect(warnings.some((line) => line.startsWith('The devspace of acme/api could not be deleted: The worker could not be reached.'))).toBe(true);
    expect(warnings).toContain(
      'The volume devspaces-worker-cache is in use and was not removed (Error response from daemon: remove devspaces-worker-cache: volume is in use - [d1]). Remove it later with: docker -H ssh://build-box volume rm devspaces-worker-cache',
    );
  });

  // The message of a removal that stopped early says that the log names the commands that remove the rest; a Cancel
  // while the devspaces are deleted removed nothing else yet. Mutation: the early returns without the commands fail it.
  it('Cancel while the devspaces are deleted: the log names the commands that remove the rest, and the mark stays', async () => {
    const note = removalEndedNote('cancelled', 'build-box');
    expect(note).toContain('docker -H ssh://build-box rm -f $(docker -H ssh://build-box ps -aq --filter label=nimblescape.devspaces.monitor)');
    expect(note).toContain('docker -H ssh://build-box volume rm devspaces-monitor devspaces-worker-cache devspaces-vscode');
    // One devspace: Cancel during its delete; two: Cancel before the second one.
    for (const count of [1, 2]) {
      const fake = removalFake();
      onBuildBox(fake);
      const progress = cancellableProgress();
      await h.registry.add(ownRemote());
      if (count === 2) await h.registry.add(devspace({ id: OTHER_ENV_ID, repository: 'acme/web', containerName: 'devspaces-acme-web-7c1d2e3f', volumeName: 'devspaces-acme-web-7c1d2e3f', dockerHost: 'build-box' }));
      h.service.deleteInWorker.mockImplementation(async (id: string) => {
        fake.order.push(`delete ${id}`);
        progress.cancel();
        await h.registry.remove(id);
      });
      fakeVscode.window.showWarningMessage.mockResolvedValueOnce(ControllerTexts.remove).mockResolvedValueOnce(ControllerTexts.deleteDevspacesToo);
      await run('removeFromDockerEngine');
      expect(changing(fake), `${count}`).toEqual([`delete ${ENV_ID}`]);
      expect(fakeVscode.window.showWarningMessage).toHaveBeenLastCalledWith(ControllerTexts.removalEnded('build-box'), Actions.showDetails);
      expect(h.logger.warn.mock.calls.map((call) => String(call[0])), `${count}`).toContain(note);
      expect(await h.engineRecords.removed('build-box')).toBe(true);
    }
  });

  // A background build that does not end after its stop (a Docker call that hangs) never holds the removal. Mutations:
  // without the limit, the removal waits for that build (the test times out); without Cancel, it waits for the limit.
  it('waits for the background builds of the helper image at most HELPER_BUILDS_STOP_WAIT_MS, and not after Cancel', async () => {
    expect(HELPER_BUILDS_STOP_WAIT_MS).toBe(30_000);
    const hangs = (fake: ReturnType<typeof removalFake>) =>
      fake.deps.stopHelperBuilds.mockImplementation(async (target: DockerTarget) => {
        fake.order.push(`stop the helper builds on ${target.host}`);
        await new Promise<void>(() => {});
      });
    const limited = removalFake();
    onBuildBox(limited, BUILD_BOX, { helperBuildsStopWaitMs: 20 });
    hangs(limited);
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(ControllerTexts.remove);
    await run('removeFromDockerEngine');
    expect(h.logger.warn).toHaveBeenCalledWith(
      'A background build of the helper image on build-box did not end after it was stopped. The removal goes on; that build may make the image again, and a new run of the command removes it.',
    );
    expect(changing(limited)).toEqual([
      'stop the helper builds on build-box',
      'close the worker on build-box',
      'docker rm -f m1',
      'docker rm -f w1',
      'docker image rm devspaces-monitor:0123456789ab',
      'docker image rm devspaces-worker:0123456789ab',
      'docker volume rm devspaces-monitor',
      'docker volume rm devspaces-worker-cache',
      'docker volume rm devspaces-vscode',
    ]);
    // The last message says what the removal did not wait for, as a warning. Mutation: the plain message of a removal
    // that removed everything.
    expect(infoMessages()).not.toContain(ControllerTexts.removedFromEngine('build-box'));
    expect(fakeVscode.window.showWarningMessage).toHaveBeenLastCalledWith(
      'Devspaces was removed from build-box. The removal did not wait for the end of a background build of the helper image in this window; if that build makes the image again, run the command again.',
      Actions.showDetails,
    );
    // So do the other last messages.
    const left = removalFake({ engine: { inUse: ['devspaces-worker-cache'] } });
    onBuildBox(left, BUILD_BOX, { helperBuildsStopWaitMs: 20 });
    hangs(left);
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(ControllerTexts.remove);
    await run('removeFromDockerEngine');
    expect(fakeVscode.window.showWarningMessage).toHaveBeenLastCalledWith(
      `${ControllerTexts.removalLeftItems(1, 'build-box')} ${ControllerTexts.helperBuildNotWaitedFor}`,
      Actions.showDetails,
    );

    // Cancel while it waits (the limit is 60 seconds here): the removal ends, and the log names the commands.
    const cancelled = removalFake();
    onBuildBox(cancelled);
    const progress = cancellableProgress();
    hangs(cancelled);
    const stopping = cancelled.deps.stopHelperBuilds.getMockImplementation()!;
    cancelled.deps.stopHelperBuilds.mockImplementation(async (target: DockerTarget) => {
      setTimeout(() => progress.cancel(), 10);
      return stopping(target);
    });
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(ControllerTexts.remove);
    await run('removeFromDockerEngine');
    expect(changing(cancelled)).toEqual(['stop the helper builds on build-box']);
    // Cancel ended the wait: nothing was given up on.
    expect(fakeVscode.window.showWarningMessage).toHaveBeenLastCalledWith(ControllerTexts.removalEnded('build-box'), Actions.showDetails);
    expect(h.logger.warn).toHaveBeenCalledWith(removalEndedNote('cancelled', 'build-box'));
    expect(h.logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('did not end after it was stopped'));
  });

  // Mutation: removingFrom set only around the removal itself fails it.
  it('refuses a second run and a Start while it looks for Devspaces on the engine and asks', async () => {
    const fake = removalFake();
    onBuildBox(fake);
    const env = ownRemote();
    await h.registry.add(env);
    const answers = deferred<boolean>();
    fake.deps.engineAnswers.mockReturnValueOnce(answers.promise);
    const removing = run('removeFromDockerEngine');
    await settle(() => fake.deps.engineAnswers.mock.calls.length === 1, 'the look at the engine');
    await run('removeFromDockerEngine');
    await run('start', row('acme/api', env));
    expect(fakeVscode.window.showInformationMessage.mock.calls).toEqual([[ControllerTexts.removalRunning('build-box')], [ControllerTexts.removalRunning('build-box')]]);
    expect(fake.deps.engineAnswers).toHaveBeenCalledTimes(1);
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    // While the question is open, too.
    const question = deferred<string | undefined>();
    fakeVscode.window.showWarningMessage.mockReturnValueOnce(question.promise);
    answers.resolve(true);
    await settle(() => modals().length === 1, 'the question');
    await run('start', row('acme/api', env));
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledTimes(3);
    question.resolve(undefined);
    await removing;
    // After the removal (here: cancelled at its question), a Start runs again.
    await run('start', row('acme/api', env));
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledTimes(1);
  });

  // Update All Images Now keeps the order of Start: the refusal while this window removes Devspaces comes first, before
  // the question about the Monitor and before the step "Docker start". Mutation: a Docker start or a question before
  // the check fails it.
  it('refuses Update All Images Now while it looks for Devspaces on the engine, before the question and the Docker start', async () => {
    const update = vi.fn(async (_target: DockerTarget, _signal: AbortSignal) => {});
    const startDocker = vi.fn(async () => {});
    const fake = removalFake();
    onBuildBox(fake, BUILD_BOX, { updateImagesNow: update, startDocker });
    const answers = deferred<boolean>();
    fake.deps.engineAnswers.mockReturnValueOnce(answers.promise);
    const removing = run('removeFromDockerEngine');
    await settle(() => fake.deps.engineAnswers.mock.calls.length === 1, 'the look at the engine');
    await run('updateImagesNow');
    expect(infoMessages()).toEqual([ControllerTexts.removalRunning('build-box')]);
    expect(h.logger.info).toHaveBeenCalledWith('Update All Images Now did not run: Devspaces is being removed from build-box.');
    expect(h.monitorQuestion.askIfNeeded).not.toHaveBeenCalled();
    expect(startDocker).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    // After the removal (here: cancelled at its question), it runs: the question, the Docker start, then the request.
    answers.resolve(true);
    await removing;
    await run('updateImagesNow');
    expect(h.monitorQuestion.askIfNeeded).toHaveBeenCalledTimes(1);
    expect(startDocker).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(h.monitorQuestion.askIfNeeded.mock.invocationCallOrder[0]).toBeLessThan(startDocker.mock.invocationCallOrder[0]);
    expect(startDocker.mock.invocationCallOrder[0]).toBeLessThan(update.mock.invocationCallOrder[0]);
  });

  // The Docker start can take long, and a removal in another window does not see the request: the request would set
  // up the Monitor, the worker and the volumes there again. Mutation: without the checks after the Docker start, the
  // request is sent in both cases.
  it('Update All Images Now sends no request when another window removes Devspaces from the engine while Docker starts', async () => {
    const update = vi.fn(async (_target: DockerTarget, _signal: AbortSignal) => {});
    let whileDockerStarts = async (): Promise<void> => {};
    const startDocker = vi.fn(async () => whileDockerStarts());
    onBuildBox(removalFake(), BUILD_BOX, { updateImagesNow: update, startDocker });
    // The removal still runs when Docker has started.
    whileDockerStarts = () => otherWindowRemoves();
    await run('updateImagesNow');
    expect(startDocker).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    expect(infoMessages()).toEqual([ControllerTexts.removalRunningElsewhere('build-box')]);
    expect(h.logger.info).toHaveBeenCalledWith(`Update All Images Now did not run: Devspaces is being removed from build-box in another window (process ${OTHER_PID}).`);
    expect(await h.engineRecords.record('build-box')).toEqual({ host: 'build-box', removedAt: NOW - 30_000, removing: OTHER_REMOVAL });

    // The removal began and ended while Docker started: its mark stays.
    await h.engineRecords.endRemoval('build-box', OTHER_REMOVAL);
    whileDockerStarts = () => h.engineRecords.setRemoved('build-box', NOW);
    await run('updateImagesNow');
    expect(startDocker).toHaveBeenCalledTimes(2);
    expect(update).not.toHaveBeenCalled();
    expect(infoMessages().at(-1)).toBe(
      'Devspaces was removed from build-box in the meantime. No request was sent. Run "Update All Images Now" again to set up Devspaces there again.',
    );
    expect(h.logger.info).toHaveBeenCalledWith('Update All Images Now did not run: Devspaces was removed from build-box in the meantime.');
    expect(await h.engineRecords.record('build-box')).toEqual({ host: 'build-box', removedAt: NOW });

    // Run again, the request sets up Devspaces there again.
    whileDockerStarts = async () => {};
    await run('updateImagesNow');
    expect(update).toHaveBeenCalledTimes(1);
    expect(infoMessages().at(-1)).toBe(ControllerTexts.imagesUpdatingNow('build-box'));
    expect(await h.engineRecords.record('build-box')).toBeUndefined();
  });

  // A removal of this window that began after the first check of the request, before the request took its key in the
  // gate (here: during the question about the Monitor, which stands for the time that beforeUserFlow takes). Mutation:
  // without the check of the removal of this window after the Docker start, the request is sent.
  it('Update All Images Now sends no request when this window began to remove Devspaces from the engine during its question', async () => {
    const update = vi.fn(async (_target: DockerTarget, _signal: AbortSignal) => {});
    const startDocker = vi.fn(async () => {});
    const fake = removalFake();
    onBuildBox(fake, BUILD_BOX, { updateImagesNow: update, startDocker });
    const question = deferred<string>();
    h.monitorQuestion.askIfNeeded.mockReturnValueOnce(question.promise);
    const updating = run('updateImagesNow');
    await settle(() => h.monitorQuestion.askIfNeeded.mock.calls.length === 1, 'the question');
    const answers = deferred<boolean>();
    fake.deps.engineAnswers.mockReturnValueOnce(answers.promise);
    const removing = run('removeFromDockerEngine');
    await settle(() => fake.deps.engineAnswers.mock.calls.length === 1, 'the look at the engine');
    question.resolve('keepRunning');
    await updating;
    expect(startDocker).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    expect(infoMessages()).toEqual([ControllerTexts.removalRunning('build-box')]);
    // The engine does not answer: the removal removes nothing.
    answers.resolve(false);
    await removing;
    expect(await h.engineRecords.removed('build-box')).toBe(false);
  });

  // As for a Start, a mark that beforeUserFlow could not clear (logged) does not stop the flow. Mutation: a check of
  // any mark after the Docker start refuses the request.
  it('a removal mark that Update All Images Now could not clear does not stop its request', async () => {
    const update = vi.fn(async (_target: DockerTarget, _signal: AbortSignal) => {});
    onBuildBox(removalFake(), BUILD_BOX, { updateImagesNow: update, startDocker: vi.fn(async () => {}) });
    await h.engineRecords.setRemoved('build-box', NOW - 1000);
    vi.spyOn(h.engineRecords, 'clearRemoved').mockRejectedValue(new Error('EACCES: permission denied'));
    await run('updateImagesNow');
    expect(h.logger.warn).toHaveBeenCalledWith('The removal mark of build-box could not be cleared: EACCES: permission denied');
    expect(update).toHaveBeenCalledTimes(1);
    expect(infoMessages()).toEqual([ControllerTexts.imagesUpdatingNow('build-box')]);
  });

  // The probe of the review: the removal ran while Docker started, and the request then set up the Monitor, the worker
  // and the volumes there again. Mutation: without the key of the request in the gate, the removal runs.
  it('refuses the removal in this window while Update All Images Now runs, also while Docker starts', async () => {
    const update = vi.fn(async (_target: DockerTarget, _signal: AbortSignal) => {});
    const docker = deferred<void>();
    const startDocker = vi.fn(() => docker.promise);
    const fake = removalFake();
    onBuildBox(fake, BUILD_BOX, { updateImagesNow: update, startDocker });
    const updating = run('updateImagesNow');
    await settle(() => startDocker.mock.calls.length === 1, 'the Docker start');
    await run('removeFromDockerEngine');
    expect(warningMessages()).toEqual(['Update All Images Now is still running. Try again after it ends. Nothing was removed.']);
    expect(h.logger.info).toHaveBeenCalledWith('Devspaces is not removed from build-box: Update All Images Now is still running.');
    expect(fake.deps.engineAnswers).not.toHaveBeenCalled();
    expect(modals()).toEqual([]);
    // A second request for the engine does not start while the first one runs.
    await run('updateImagesNow');
    expect(startDocker).toHaveBeenCalledTimes(1);
    expect(h.logger.info).toHaveBeenCalledWith('Update All Images Now on build-box was not started: an earlier request there is still running.');
    docker.resolve();
    await updating;
    expect(update).toHaveBeenCalledTimes(1);
    expect(infoMessages()).toEqual([ControllerTexts.imagesUpdatingNow('build-box')]);
    // After the request, the removal runs.
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(ControllerTexts.remove);
    await run('removeFromDockerEngine');
    expect(fake.deps.engineAnswers).toHaveBeenCalledTimes(1);
    expect(await h.engineRecords.removed('build-box')).toBe(true);
  });

  it('says in its last message when the removal mark could not be written: background work may come back there', async () => {
    const fake = removalFake();
    onBuildBox(fake);
    vi.spyOn(h.engineRecords, 'startRemoval').mockRejectedValue(new Error('EACCES: permission denied'));
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(ControllerTexts.remove);
    await run('removeFromDockerEngine');
    expect(fakeVscode.window.showWarningMessage).toHaveBeenLastCalledWith(
      'Devspaces was removed from build-box. This computer could not record the removal, so its background work may set Devspaces up on build-box again.',
      Actions.showDetails,
    );
    expect(fakeVscode.window.showInformationMessage).not.toHaveBeenCalled();
    expect(h.logger.warn).toHaveBeenCalledWith(
      'The removal from build-box could not be recorded, so this computer may set Devspaces up there again by itself: EACCES: permission denied',
    );
    // Nothing to remove: the same.
    const empty = removalFake({ engine: { containers: [], volumes: [], images: [] } });
    onBuildBox(empty);
    vi.spyOn(h.engineRecords, 'setRemoved').mockRejectedValue(new Error('EACCES: permission denied'));
    await run('removeFromDockerEngine');
    expect(fakeVscode.window.showWarningMessage).toHaveBeenLastCalledWith(
      `${ControllerTexts.removeNothingFound('build-box')} ${ControllerTexts.removalNotRecorded('build-box')}`,
      Actions.showDetails,
    );
    // Items left: the same sentence after the message.
    const left = removalFake({ engine: { inUse: ['devspaces-worker-cache'] } });
    onBuildBox(left);
    vi.spyOn(h.engineRecords, 'startRemoval').mockRejectedValue(new Error('EACCES: permission denied'));
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(ControllerTexts.remove);
    await run('removeFromDockerEngine');
    expect(fakeVscode.window.showWarningMessage).toHaveBeenLastCalledWith(
      `${ControllerTexts.removalLeftItems(1, 'build-box')} ${ControllerTexts.removalNotRecorded('build-box')}`,
      Actions.showDetails,
    );
  });

  it('a Start of the user clears the mark of its engine; while the removal runs, the operations of the window are refused', async () => {
    const fake = removalFake();
    onBuildBox(fake);
    const env = ownRemote();
    await h.registry.add(env);
    await h.engineRecords.setRemoved('build-box', NOW - 1000);
    await run('start', row('acme/api', env));
    expect(await h.engineRecords.removed('build-box')).toBe(false);
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledTimes(1);
    // The window that connects removes the pending connection file of the open with its status file.
    await h.sessionFiles.removePending(ENV_ID);

    // When the worker of the removal has ended, the user presses Start and Stop: both are refused, and the mark stays.
    // The removal goes on once both refusals were shown.
    const refusals = () => fakeVscode.window.showInformationMessage.mock.calls.filter((call: unknown[]) => call[0] === ControllerTexts.removalRunning('build-box')).length;
    let pressed: Promise<unknown> = Promise.resolve();
    fake.deps.closeWorker.mockImplementationOnce(() => {
      pressed = Promise.all([run('start', row('acme/api', env)), run('stop', row('acme/api', env))]);
    });
    const removeContainer = fake.deps.docker.run.getMockImplementation()!;
    fake.deps.docker.run.mockImplementation(async (args: readonly string[]) => {
      if (args[0] === 'rm') await settle(() => refusals() === 2, 'the refusals');
      return removeContainer(args);
    });
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(ControllerTexts.remove).mockResolvedValueOnce(ControllerTexts.keepDevspaces);
    await run('removeFromDockerEngine');
    await pressed;
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledTimes(1);
    expect(h.service.stop).not.toHaveBeenCalled();
    expect(await h.engineRecords.removed('build-box')).toBe(true);
    expect(h.monitorQuestion.askIfNeeded).toHaveBeenCalledTimes(1);
    expect(h.logger.info).toHaveBeenCalledWith('Start did not run: Devspaces is being removed from build-box.');
    // After the removal, a Start runs again.
    await run('start', row('acme/api', env));
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledTimes(2);
    expect(await h.engineRecords.removed('build-box')).toBe(false);
  });

  // The entry tells the other windows that the removal runs (DockerEngineRecords.removing); it goes at the end, and the
  // mark stays.
  it('writes the entry of the removal with the mark, and removes it at its end', async () => {
    const fake = removalFake();
    onBuildBox(fake);
    let during: unknown;
    const removeContainer = fake.deps.docker.run.getMockImplementation()!;
    fake.deps.docker.run.mockImplementation(async (args: readonly string[]) => {
      if (args[0] === 'rm' && during === undefined) during = await h.engineRecords.record('build-box');
      return removeContainer(args);
    });
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(ControllerTexts.remove);
    await run('removeFromDockerEngine');
    expect(during).toEqual({ host: 'build-box', removedAt: NOW, removing: { windowId: WINDOW_ID, pid: process.pid, since: iso(NOW) } });
    expect(await h.engineRecords.record('build-box')).toEqual({ host: 'build-box', removedAt: NOW });
    expect(h.logger.info).toHaveBeenCalledWith('This computer does no Docker work on build-box by itself until a Start, a Rebuild or "Update All Images Now" there.');
  });

  // The questions can stay open for long, so what the checks at its start found can change meanwhile. Mutation: without
  // the checks after the mark, the devspace is deleted under the window that connected, and the mark stays.
  it('checks again after its questions: a window that connected, or an operation that began meanwhile, stops it, and the record from before comes back', async () => {
    const connecting = removalFake();
    onBuildBox(connecting);
    const env = ownRemote();
    await h.registry.add(env);
    await h.engineRecords.recordMonitorAnswer('build-box', NOW - 5000);
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(ControllerTexts.remove).mockImplementationOnce(async () => {
      otherWindowConnected(ENV_ID);
      return ControllerTexts.deleteDevspacesToo;
    });
    await run('removeFromDockerEngine');
    expect(warningMessages().at(-1)).toBe('Close the windows of your devspaces on build-box first: acme/api. Nothing was removed.');
    expect(changing(connecting)).toEqual([]);
    expect(h.service.deleteInWorker).not.toHaveBeenCalled();
    // No mark, and the answer about its Monitor, as before.
    expect(await h.engineRecords.read()).toEqual([{ host: 'build-box', monitorAnsweredAt: NOW - 5000 }]);

    // An operation of another window began while the question was open; the engine had the mark already, which stays.
    const busy = removalFake();
    onBuildBox(busy);
    await h.registry.add(env);
    await h.engineRecords.setRemoved('build-box', NOW - 1000);
    fakeVscode.window.showWarningMessage
      .mockImplementationOnce(async () => {
        await otherWindowBusy(env);
        return ControllerTexts.remove;
      })
      .mockResolvedValueOnce(ControllerTexts.keepDevspaces);
    await run('removeFromDockerEngine');
    expect(warningMessages().at(-1)).toBe('Update of acme/api is still running. Try again after it ends. Nothing was removed.');
    expect(changing(busy)).toEqual([]);
    expect(await h.engineRecords.read()).toEqual([{ host: 'build-box', removedAt: NOW - 1000 }]);

    // A devspace that another window created there meanwhile, with its busy mark, stops it too.
    const created = removalFake();
    onBuildBox(created);
    fakeVscode.window.showWarningMessage.mockImplementationOnce(async () => {
      await h.registry.add(env);
      await otherWindowBusy(env);
      return ControllerTexts.remove;
    });
    await run('removeFromDockerEngine');
    expect(warningMessages().at(-1)).toBe('Update of acme/api is still running. Try again after it ends. Nothing was removed.');
    expect(changing(created)).toEqual([]);
    expect(await h.engineRecords.read()).toEqual([]);
  });

  // Mutation: without the check before each delete, the devspace that a window connected to is deleted under it.
  it('deletes no devspace that a window connected to while the devspaces before it were deleted', async () => {
    const web = (): Devspace => devspace({ id: OTHER_ENV_ID, repository: 'acme/web', containerName: 'devspaces-acme-web-7c1d2e3f', volumeName: 'devspaces-acme-web-7c1d2e3f', dockerHost: 'build-box' });
    for (const where of ['another window', 'this window'] as const) {
      const fake = removalFake();
      onBuildBox(fake);
      await h.registry.add(ownRemote());
      await h.registry.add(web());
      h.service.deleteInWorker.mockImplementation(async (id: string) => {
        fake.order.push(`delete ${id}`);
        await h.registry.remove(id);
        // While the first one is deleted, a window attaches to the second one.
        if (where === 'another window') otherWindowConnected(OTHER_ENV_ID);
        else await h.controller.workWithoutDevspaces(web(), 'devspaces-acme-web-7c1d2e3f');
      });
      fakeVscode.window.showWarningMessage.mockResolvedValueOnce(ControllerTexts.remove).mockResolvedValueOnce(ControllerTexts.deleteDevspacesToo);
      await run('removeFromDockerEngine');
      expect(h.service.deleteInWorker, where).toHaveBeenCalledTimes(1);
      expect(h.service.deleteInWorker, where).toHaveBeenCalledWith(ENV_ID, expect.anything());
      expect(await h.registry.get(OTHER_ENV_ID), where).toBeDefined();
      expect(h.logger.warn, where).toHaveBeenCalledWith('The devspace of acme/web was not deleted: a window is connected to it. Delete it later with "Devspaces: Delete Devspace".');
      // It counts as an item that is left.
      expect(warningMessages().at(-1), where).toBe('1 item of Devspaces could not be removed from build-box. The log names each one and the command to remove it.');
      expect(changing(fake), where).toContain('docker rm -f m1');
    }
  });

  // Between the end of an open (its busy mark) and the status file of the window that connects, only the pending
  // connection file shows that a window uses the devspace. Mutations: without it, the removal starts, or deletes the
  // devspace under the window that connects; a file of this window, or an old file, counts the other way.
  it('a window that is opening a devspace there (its pending connection file) stops the removal, or keeps that devspace', async () => {
    const env = ownRemote();
    for (const opener of [OTHER_WINDOW_ID, WINDOW_ID]) {
      const opening = removalFake();
      onBuildBox(opening);
      await h.registry.add(env);
      // Another window opens it, or this window opened it in a new window.
      await h.sessionFiles.writePending(ENV_ID, opener);
      await run('removeFromDockerEngine');
      // No window to close yet. Mutation: the text of a connected window.
      expect(ControllerTexts.removeWhileOpening('build-box', 'acme/api')).toBe('A devspace is being opened on build-box: acme/api. Try again after that. Nothing was removed.');
      expect(warningMessages(), opener).toEqual([ControllerTexts.removeWhileOpening('build-box', 'acme/api')]);
      expect(h.logger.info, opener).toHaveBeenCalledWith('Devspaces is not removed from build-box: a window is opening acme/api.');
      expect(modals(), opener).toEqual([]);
      expect(changing(opening), opener).toEqual([]);
      expect(await h.engineRecords.read(), opener).toEqual([]);
    }

    // A window that is connected to it already: the text says to close it.
    onBuildBox(removalFake());
    await h.registry.add(env);
    await h.sessionFiles.writePending(ENV_ID, OTHER_WINDOW_ID);
    otherWindowConnected(ENV_ID);
    await run('removeFromDockerEngine');
    expect(warningMessages()).toEqual(['Close the windows of your devspaces on build-box first: acme/api. Nothing was removed.']);

    // A file older than 2 minutes counts as none: no window connects anymore.
    const old = removalFake();
    onBuildBox(old);
    await h.registry.add(env);
    h.clock.now = () => NOW - PENDING_MAX_AGE_MS - 1;
    await h.sessionFiles.writePending(ENV_ID, OTHER_WINDOW_ID);
    h.clock.now = () => NOW;
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(ControllerTexts.remove).mockResolvedValueOnce(ControllerTexts.keepDevspaces);
    await run('removeFromDockerEngine');
    expect(changing(old)).toContain('docker rm -f m1');

    // When the files cannot be read, it is not known: nothing is removed.
    const unknown = removalFake();
    onBuildBox(unknown);
    await h.registry.add(env);
    vi.spyOn(h.sessionFiles, 'readPendings').mockRejectedValueOnce(new Error('EACCES: permission denied'));
    await run('removeFromDockerEngine');
    // The text fits the removal from an engine as well as the delete of one devspace.
    expect(ControllerTexts.connectingWindowsUnknown).toBe(
      'It could not be checked whether a window is opening a devspace: the pending connection files could not be read. Nothing was changed; see the Devspaces output.',
    );
    expect(fakeVscode.window.showErrorMessage).toHaveBeenCalledWith(ControllerTexts.connectingWindowsUnknown, Actions.showDetails);
    expect(h.logger.warn).toHaveBeenCalledWith('The pending connection files could not be read, so nothing is changed: EACCES: permission denied');
    expect(modals()).toEqual([]);
    expect(changing(unknown)).toEqual([]);

    // A window begins to open the second devspace while the first one is deleted: it is kept, and counts as left.
    const web = (): Devspace => devspace({ id: OTHER_ENV_ID, repository: 'acme/web', containerName: 'devspaces-acme-web-7c1d2e3f', volumeName: 'devspaces-acme-web-7c1d2e3f', dockerHost: 'build-box' });
    const deleting = removalFake();
    onBuildBox(deleting);
    await h.registry.add(env);
    await h.registry.add(web());
    h.service.deleteInWorker.mockImplementation(async (id: string) => {
      deleting.order.push(`delete ${id}`);
      await h.registry.remove(id);
      await h.sessionFiles.writePending(OTHER_ENV_ID, OTHER_WINDOW_ID);
    });
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(ControllerTexts.remove).mockResolvedValueOnce(ControllerTexts.deleteDevspacesToo);
    await run('removeFromDockerEngine');
    expect(h.service.deleteInWorker).toHaveBeenCalledTimes(1);
    expect(h.service.deleteInWorker).toHaveBeenCalledWith(ENV_ID, expect.anything());
    expect(await h.registry.get(OTHER_ENV_ID)).toBeDefined();
    expect(h.logger.warn).toHaveBeenCalledWith('The devspace of acme/web was not deleted: a window is opening it. Delete it later with "Devspaces: Delete Devspace".');
    expect(warningMessages().at(-1)).toBe('1 item of Devspaces could not be removed from build-box. The log names each one and the command to remove it.');
  });

  // Another window would clear the mark of the removal that runs, and set Devspaces up there again while it is removed.
  // Mutation: without the entry, or without its check in beforeUserFlow, the Start clears the mark and runs.
  it('while another window removes Devspaces from the engine, a Start, a Rebuild, Update All Images Now and a second removal there are refused; after that window ended, a Start runs', async () => {
    const update = vi.fn(async (_target: DockerTarget, _signal: AbortSignal) => {});
    // The step "Docker start" of Update All Images Now runs only after the refusal checks.
    const startDocker = vi.fn(async () => {});
    const fake = removalFake();
    onBuildBox(fake, BUILD_BOX, { updateImagesNow: update, startDocker });
    const env = ownRemote();
    await h.registry.add(env);
    await otherWindowRemoves();
    const elsewhere = 'Devspaces is being removed from build-box in another window. Try again after that.';
    expect(ControllerTexts.removalRunningElsewhere('build-box')).toBe(elsewhere);
    await run('start', row('acme/api', env));
    await run('rebuild', row('acme/api', env));
    await run('updateImagesNow');
    await run('removeFromDockerEngine');
    expect(infoMessages()).toEqual([elsewhere, elsewhere, elsewhere, elsewhere]);
    expect(h.logger.info).toHaveBeenCalledWith(`Start did not run: Devspaces is being removed from build-box in another window (process ${OTHER_PID}).`);
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(startDocker).not.toHaveBeenCalled();
    expect(fake.deps.engineAnswers).not.toHaveBeenCalled();
    expect(h.monitorQuestion.askIfNeeded).not.toHaveBeenCalled();
    expect(await h.engineRecords.record('build-box')).toEqual({ host: 'build-box', removedAt: NOW - 30_000, removing: OTHER_REMOVAL });

    // The window of that removal crashed: the Start clears the mark and the entry, and runs.
    h.alive.delete(OTHER_PID);
    await run('start', row('acme/api', env));
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledTimes(1);
    expect(await h.engineRecords.record('build-box')).toBeUndefined();
  });

  // A Stop or a Delete does not clear the mark (no beforeUserFlow), but its worker would build the helper image and
  // create the volumes there again while they are removed. Mutations: without the check in operation(), they run; without
  // the one in stopNow, the Monitor is told to stop the devspace (its channel would start a worker).
  it('while another window removes Devspaces from the engine, a Stop and a Delete there are refused, and the Monitor is not told', async () => {
    const sendStop = vi.fn(async () => ({ ok: true as const }));
    onBuildBox(removalFake(), BUILD_BOX, { sessionMonitor: { sendHeartbeat: vi.fn(async () => ({ ok: true as const })), sendStop } });
    const env = ownRemote();
    await h.registry.add(env);
    await otherWindowRemoves();
    await run('stop', row('acme/api', env));
    await run('delete', row('acme/api', env));
    const elsewhere = ControllerTexts.removalRunningElsewhere('build-box');
    expect(infoMessages()).toEqual([elsewhere, elsewhere]);
    expect(h.logger.info).toHaveBeenCalledWith(`Stop did not run: Devspaces is being removed from build-box in another window (process ${OTHER_PID}).`);
    expect(h.logger.info).toHaveBeenCalledWith(`Delete did not run: Devspaces is being removed from build-box in another window (process ${OTHER_PID}).`);
    expect(sendStop).not.toHaveBeenCalled();
    expect(h.service.stop).not.toHaveBeenCalled();
    expect(h.service.deleteCheckInWorker).not.toHaveBeenCalled();
    expect(h.service.deleteInWorker).not.toHaveBeenCalled();
    expect(await h.engineRecords.record('build-box')).toEqual({ host: 'build-box', removedAt: NOW - 30_000, removing: OTHER_REMOVAL });

    // The removal began after the Stop told the Monitor: the stop of this window is refused all the same.
    await h.engineRecords.endRemoval('build-box', OTHER_REMOVAL);
    sendStop.mockImplementationOnce(async () => {
      await otherWindowRemoves();
      return { ok: true as const };
    });
    await run('stop', row('acme/api', env));
    expect(sendStop).toHaveBeenCalledTimes(1);
    expect(h.service.stop).not.toHaveBeenCalled();
    expect(infoMessages()).toEqual([elsewhere, elsewhere, elsewhere]);

    // After that window ended, both run.
    h.alive.delete(OTHER_PID);
    await run('stop', row('acme/api', env));
    expect(h.service.stop).toHaveBeenCalledTimes(1);
    await run('delete', row('acme/api', env));
    expect(h.service.deleteCheckInWorker).toHaveBeenCalledTimes(1);
  });

  // The restore from the volumes prepares the worker in full: it would build the helper image and create the volumes
  // again while they are removed. Mutations: without the check of another window's entry, or of this window's own
  // removal, Refresh restores during the removal.
  it('a Refresh does not restore a lost registry while Devspaces is being removed from the engine, in another window or in this one', async () => {
    onBuildBox(removalFake());
    await otherWindowRemoves();
    await run('refresh');
    expect(h.service.reconcileInWorker).not.toHaveBeenCalled();
    expect(infoMessages()).toEqual([ControllerTexts.removalRunningElsewhere('build-box')]);
    expect(h.logger.info).toHaveBeenCalledWith(
      `The devspaces are not restored from the volumes on build-box: Devspaces is being removed from there in another window (process ${OTHER_PID}).`,
    );
    // The rest of Refresh runs (a Refresh of the user: a rate limit of GitHub that refuses it gets a message).
    expect(h.sidebar.refreshDiscovery).toHaveBeenCalledWith({ again: true, byUser: true });
    expect(h.sidebar.refreshStates).toHaveBeenCalled();
    // A restore in the background is skipped too, and only logged.
    await h.controller.reconcileIfRegistryLost({ passive: false });
    expect(h.service.reconcileInWorker).not.toHaveBeenCalled();
    expect(infoMessages()).toHaveLength(1);
    // After that window ended, a Refresh restores there again, and the mark stays.
    h.alive.delete(OTHER_PID);
    await run('refresh');
    expect(h.service.reconcileInWorker).toHaveBeenCalledWith({ passive: false });
    expect(await h.engineRecords.removed('build-box')).toBe(true);

    // This window removes Devspaces from the engine, and the user presses Refresh while the containers are removed.
    const own = removalFake();
    onBuildBox(own);
    let refreshed: Promise<unknown> | undefined;
    const removeContainer = own.deps.docker.run.getMockImplementation()!;
    own.deps.docker.run.mockImplementation(async (args: readonly string[]) => {
      if (args[0] === 'rm' && refreshed === undefined) {
        refreshed = run('refresh');
        await refreshed;
      }
      return removeContainer(args);
    });
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(ControllerTexts.remove);
    await run('removeFromDockerEngine');
    expect(refreshed).toBeDefined();
    expect(h.service.reconcileInWorker).not.toHaveBeenCalled();
    expect(infoMessages()).toContain(ControllerTexts.removalRunning('build-box'));
    expect(h.logger.info).toHaveBeenCalledWith('The devspaces are not restored from the volumes on build-box: Devspaces is being removed from there.');
    expect(h.sidebar.refreshStates).toHaveBeenCalled();
  });

  // The question about the Monitor can stay open for long. Mutation: without the check after it, the Start runs.
  it('a removal that another window begins while the question about the Monitor is open refuses the Start', async () => {
    const fake = removalFake();
    onBuildBox(fake);
    const env = ownRemote();
    await h.registry.add(env);
    let removalRuns: ((removal: EngineRemoval) => boolean) | undefined;
    h.monitorQuestion.askIfNeeded.mockImplementationOnce(async (_host, rule) => {
      await otherWindowRemoves();
      removalRuns = await rule?.();
      return 'answered';
    });
    await run('start', row('acme/api', env));
    expect(h.monitorQuestion.askIfNeeded).toHaveBeenCalledTimes(1);
    expect(infoMessages()).toEqual([ControllerTexts.removalRunningElsewhere('build-box')]);
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    expect(await h.engineRecords.removing('build-box')).toEqual(OTHER_REMOVAL);
    // The question records no answer while that removal runs: it gets the liveness rule of the busy marks, which
    // reads the window status files. Mutations: no rule (every entry runs), or the rule without the status files.
    expect(removalRuns?.(OTHER_REMOVAL)).toBe(true);
    expect(removalRuns?.({ ...OTHER_REMOVAL, pid: 5151 })).toBe(false);
    expect(removalRuns?.({ ...OTHER_REMOVAL, windowId: 'window-that-closed' })).toBe(false);
  });

  // The end of a removal keeps its mark. Mutation: without a second clear after the question, the Start runs and the
  // mark stays, so this computer does no Docker work there by itself after a Start of the user.
  it('a removal that another window began and ended while the question about the Monitor was open: the Start clears its mark and runs', async () => {
    const fake = removalFake();
    onBuildBox(fake);
    const env = ownRemote();
    await h.registry.add(env);
    h.monitorQuestion.askIfNeeded.mockImplementationOnce(async () => {
      await otherWindowRemoves();
      await h.engineRecords.endRemoval('build-box', OTHER_REMOVAL);
      return 'answered';
    });
    await run('start', row('acme/api', env));
    expect(infoMessages()).not.toContain(ControllerTexts.removalRunningElsewhere('build-box'));
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledTimes(1);
    expect(await h.engineRecords.record('build-box')).toBeUndefined();
    expect(h.logger.info).toHaveBeenCalledWith('Devspaces is set up on build-box again: the removal mark is cleared.');
  });

  // Mutation: a removal that does not check the entry under the lock removes Devspaces at the same time as window 2.
  it('a removal that another window began while the questions were open is not started a second time', async () => {
    const fake = removalFake();
    onBuildBox(fake);
    fakeVscode.window.showWarningMessage.mockImplementationOnce(async () => {
      await otherWindowRemoves();
      return ControllerTexts.remove;
    });
    await run('removeFromDockerEngine');
    expect(infoMessages()).toEqual([ControllerTexts.removalRunningElsewhere('build-box')]);
    expect(changing(fake)).toEqual([]);
    expect(await h.engineRecords.record('build-box')).toEqual({ host: 'build-box', removedAt: NOW - 30_000, removing: OTHER_REMOVAL });
  });

  it('the reopen at startup opens no kept devspace on an engine with the mark, and says why in the log', async () => {
    await h.registry.add(devspace());
    await h.engineRecords.setRemoved('', NOW - 1000);
    h.sessionFiles.writeReopenSync({ devspaceId: ENV_ID, closedAt: iso(NOW - 60_000) });
    h.connection.isEmptyWindow.mockReturnValue(true);
    await h.controller.runEmptyWindowTasks();
    expect(h.logger.info).toHaveBeenCalledWith('The last devspace is not opened: Devspaces was removed from the local Docker. A Start there sets it up again.');
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    expect(h.connection.open).not.toHaveBeenCalled();
    // The reopen is not a Start of the user: the mark stays.
    expect(await h.engineRecords.removed('')).toBe(true);

    // Without the mark, the same window opens it.
    await h.engineRecords.setRemoved('', undefined);
    await h.controller.runEmptyWindowTasks();
    await settle(() => h.service.openDevspaceInWorker.mock.calls.length === 1, 'the reopen');
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledWith(ENV_ID, expect.anything());
  });

  // A user who kept the devspaces may attach to one to save the changes that are not pushed.
  it('a window of a kept devspace on an engine with the mark stays connected without Devspaces, says so once, and runs nothing', async () => {
    const env = devspace();
    await h.registry.add(env);
    await h.controller.workWithoutDevspaces(env, CONTAINER);
    await h.controller.workWithoutDevspaces(env, CONTAINER);
    expect(fakeVscode.window.showInformationMessage.mock.calls).toEqual([
      [
        'Devspaces was removed from the local Docker, so this window works without it: no background updates and no stop on close. A Start of this devspace sets Devspaces up again there.',
      ],
    ]);
    expect(warningMessages()).toEqual([]);
    expect(h.logger.info.mock.calls.filter(([line]) => String(line).startsWith('This window of acme/api'))).toEqual([
      [
        'This window of acme/api works without Devspaces: Devspaces was removed from the local Docker. No background updates and no stop on close; a Start of acme/api sets Devspaces up there again.',
      ],
    ]);
    // The connection stays, and nothing runs for the devspace.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
    expect(h.coordinator.setDevspace).not.toHaveBeenCalled();
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    expect(h.flow).not.toHaveBeenCalled();
    expect(h.docker.findContainer).not.toHaveBeenCalled();
    expect(h.connection.open).not.toHaveBeenCalled();
    // Nor does the window take the devspace after a restore of the registry.
    h.connection.currentContainerName.mockReturnValue(CONTAINER);
    h.docker.findContainer.mockResolvedValue(containerInfo(String(CONTAINER_VERSION)));
    await h.controller.reconcileIfRegistryLost({ passive: true, adopt: true });
    expect(h.coordinator.setDevspace).not.toHaveBeenCalledWith(ENV_ID);
  });

  // The account rule outranks the removal mark (docs/security.md, Accounts). Mutation: the plain window without the
  // account rule fails it.
  it('the window of a devspace that the signed-in account may not use closes there as on any engine, after the token removal', async () => {
    const other = devspace({ owner: OTHER_ACCOUNT });
    await h.registry.add(other);
    await h.controller.workWithoutDevspaces(other, CONTAINER);
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close of the connection');
    expect(h.flow).toHaveBeenCalledWith(OP_TOKEN_REMOVE, { devspaceId: ENV_ID, containerName: CONTAINER }, { timeoutMs: 60_000 });
    // The token left the container before the close.
    expect(h.flow.mock.invocationCallOrder[0]).toBeLessThan(h.connection.closeRemoteConnection.mock.invocationCallOrder[0]);
    expect(warningMessages()).toEqual([Messages.otherAccountConnection('acme/api')]);
    expect(h.logger.info).toHaveBeenCalledWith('This window is attached to a devspace of another GitHub account. It closes its remote connection.');
    expect(fakeVscode.window.showInformationMessage).not.toHaveBeenCalled();
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();

    // Nobody signed in: the same.
    recreateHarness({});
    h.auth.getAccount.mockResolvedValue(undefined);
    const own = devspace();
    await h.registry.add(own);
    await h.controller.workWithoutDevspaces(own, CONTAINER);
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close of the connection');
    expect(tokenRemovals()).toBe(1);
    expect(warningMessages()).toEqual([ControllerTexts.signedOutConnection('acme/api')]);
    expect(fakeVscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  // Mutation: an account change that does not check the devspace of a window without Devspaces fails it.
  it('a window that works without Devspaces there closes after an account change or a sign-out, after the token removal', async () => {
    const env = devspace();
    await h.registry.add(env);
    await h.controller.workWithoutDevspaces(env, CONTAINER);
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
    expect(h.flow).not.toHaveBeenCalled();
    h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
    await h.controller.onSessionChanged();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close of the connection');
    expect(h.flow).toHaveBeenCalledWith(OP_TOKEN_REMOVE, { devspaceId: ENV_ID, containerName: CONTAINER }, { timeoutMs: 60_000 });
    expect(h.flow.mock.invocationCallOrder[0]).toBeLessThan(h.connection.closeRemoteConnection.mock.invocationCallOrder[0]);
    expect(warningMessages()).toEqual([Messages.otherAccountConnection('acme/api')]);
    expect(h.logger.info).toHaveBeenCalledWith('The GitHub account of acme/api is no longer signed in to Devspaces: the window closes its remote connection.');
    // Its status file does not name the devspace anymore.
    expect(h.coordinator.setPlainDevspace.mock.calls).toEqual([[ENV_ID], [null]]);
    // The window left the devspace: the next change removes nothing more.
    await h.controller.onSessionChanged();
    expect(tokenRemovals()).toBe(1);

    // A sign-out: the same.
    recreateHarness({});
    const own = devspace();
    await h.registry.add(own);
    await h.controller.workWithoutDevspaces(own, CONTAINER);
    h.auth.getAccount.mockResolvedValue(undefined);
    await h.controller.onSessionChanged();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close of the connection');
    expect(tokenRemovals()).toBe(1);
    expect(warningMessages()).toEqual([ControllerTexts.signedOutConnection('acme/api')]);
    expect(h.logger.info).toHaveBeenCalledWith('Nobody is signed in to GitHub anymore. The window closes its remote connection.');

    // The account changed while the window read it: checked again before the window says anything.
    recreateHarness({});
    const raced = devspace();
    await h.registry.add(raced);
    h.auth.getAccount.mockResolvedValueOnce(ACCOUNT).mockResolvedValue(OTHER_ACCOUNT);
    await h.controller.workWithoutDevspaces(raced, CONTAINER);
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close of the connection');
    expect(tokenRemovals()).toBe(1);
    expect(fakeVscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  // Stop, Rebuild and Delete must not change the container under a window that works without Devspaces on it: as for a
  // connected window, that window closes its connection first, and its reloaded empty window runs the operation.
  // Mutation: the checks of the connected devspace only (isConnectedHere, devspaceId of the status files) fail it.
  it('Stop, Rebuild and Delete hand off in a window that works without Devspaces on the devspace', async () => {
    for (const operation of ['stop', 'rebuild', 'delete'] as const) {
      recreateHarness({});
      const env = devspace();
      await h.registry.add(env);
      await h.controller.workWithoutDevspaces(env, CONTAINER);
      if (operation === 'delete') fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.delete);
      await run(operation, row('acme/api', env));
      expect(h.connection.closeRemoteConnection).toHaveBeenCalledTimes(1);
      expect(await h.sessionFiles.readOperations()).toEqual([expect.objectContaining({ devspaceId: ENV_ID, operation, requestedBy: WINDOW_ID })]);
      expect(h.service.stop).not.toHaveBeenCalled();
      expect(h.service.deleteInWorker).not.toHaveBeenCalled();
      expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    }
  });

  // Never two windows on one devspace. Mutation: a check of the connected windows only (devspaceId) opens a second one.
  it('a Start in another window shows the window that works without Devspaces on the devspace, and opens no second one', async () => {
    const env = devspace();
    await h.registry.add(env);
    await h.engineRecords.setRemoved('', NOW - 1000);
    h.coordinator.otherActiveWindows.mockResolvedValue([
      { windowId: OTHER_WINDOW_ID, pid: OTHER_PID, devspaceId: null, plainDevspaceId: ENV_ID, state: 'active', updatedAt: iso(NOW) },
    ]);
    await run('start', row('acme/api', env));
    await run('startInNewWindow', row('acme/api', env));
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    expect(h.coordinator.writePending).not.toHaveBeenCalled();
    // That window is shown: VS Code shows the window that has the folder open.
    expect(h.connection.open.mock.calls).toEqual([[CONTAINER, '/workspaces/api']]);
    expect(h.connection.openInNewWindow.mock.calls).toEqual([[CONTAINER, '/workspaces/api']]);
    expect(h.logger.info).toHaveBeenCalledWith('acme/api is open in another window. That window is shown.');
    // Nothing was set up there: the mark stays.
    expect(await h.engineRecords.removed('')).toBe(true);
  });

  // Mutation: without the own plain devspace as a Reconnect, Start in New Window (or the setting openInNewWindow) opens
  // a second window on the devspace.
  // As for a connected window, the pipeline never replaces the container that runs under this window. Mutations: without
  // the read of its state, the pipeline runs under the window (an update would replace its container); without the
  // leave, the window connects to an outdated container.
  it('a Start of its own devspace in a window that works without Devspaces connects this window, never a new one', async () => {
    for (const how of ['startInNewWindow', 'setting'] as const) {
      recreateHarness({});
      const env = devspace();
      await h.registry.add(env);
      await h.engineRecords.setRemoved('', NOW - 1000);
      await h.controller.workWithoutDevspaces(env, CONTAINER);
      if (how === 'setting') h.settings.openInNewWindow = true;
      await run(how === 'setting' ? 'start' : 'startInNewWindow', row('acme/api', env));
      // Its container runs and is current: this window only connects again, without the pipeline.
      expect(h.service.windowStateInWorker, how).toHaveBeenCalledWith(env, CONTAINER, { signal: expect.any(AbortSignal) });
      expect(h.service.openDevspaceInWorker, how).not.toHaveBeenCalled();
      expect(h.connection.openInNewWindow, how).not.toHaveBeenCalled();
      expect(h.connection.open.mock.calls, how).toEqual([[CONTAINER, '/workspaces/api']]);
      expect(h.logger.info).toHaveBeenCalledWith('This window works without Devspaces on acme/api. The Start sets Devspaces up there again and connects this window.');
      expect(h.logger.info).toHaveBeenCalledWith('The container of acme/api runs. This window connects again, now with Devspaces.');
      // The Start of the user sets Devspaces up there again, before the worker reads the state.
      expect(await h.engineRecords.removed(''), how).toBe(false);
    }

    // A container that does not run: the pipeline starts it, and this window connects.
    recreateHarness({});
    await h.registry.add(devspace());
    await h.engineRecords.setRemoved('', NOW - 1000);
    await h.controller.workWithoutDevspaces(devspace(), CONTAINER);
    h.docker.containerState.mockResolvedValue('exited');
    pipelineStartsContainer();
    await run('start', row('acme/api', devspace()));
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledWith(ENV_ID, expect.anything());
    expect(h.connection.open.mock.calls).toEqual([[CONTAINER, '/workspaces/api']]);

    // A running container of an older version stays as it is: the window leaves it, as a connected window does.
    recreateHarness({});
    await h.registry.add(devspace());
    await h.engineRecords.setRemoved('', NOW - 1000);
    await h.controller.workWithoutDevspaces(devspace(), CONTAINER);
    h.docker.findContainer.mockResolvedValue(containerInfo('0'));
    await run('start', row('acme/api', devspace()));
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    expect(h.connection.open).not.toHaveBeenCalled();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
    expect(h.coordinator.setPlainDevspace).toHaveBeenLastCalledWith(null);
    expect(warningMessages()).toEqual([ControllerTexts.outdatedContainerClosed('acme/api')]);
    expect(await h.engineRecords.removed('')).toBe(false);

    // When the state cannot be read, nothing runs under the window.
    recreateHarness({});
    await h.registry.add(devspace());
    await h.controller.workWithoutDevspaces(devspace(), CONTAINER);
    h.service.windowStateInWorker.mockResolvedValueOnce(undefined);
    await run('start', row('acme/api', devspace()));
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    expect(h.connection.open).not.toHaveBeenCalled();
    expect(fakeVscode.window.showErrorMessage).toHaveBeenCalledWith(ControllerTexts.containerStateUnreadable('acme/api'), Actions.showDetails, Actions.tryAgain);
  });

  it('Stop and Delete of another window ask a window that works without Devspaces on the devspace; it hands off', async () => {
    const env = devspace();
    await h.registry.add(env);
    h.coordinator.otherActiveWindows.mockResolvedValue([
      { windowId: OTHER_WINDOW_ID, pid: OTHER_PID, devspaceId: null, plainDevspaceId: ENV_ID, state: 'active', updatedAt: iso(NOW) },
    ]);
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(ControllerTexts.stop);
    await run('stop', row('acme/api', env));
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledWith(ControllerTexts.otherWindowClosesConnection('acme/api'), { modal: true }, ControllerTexts.stop);
    expect(await h.disconnectRequests.read(ENV_ID)).toEqual(expect.objectContaining({ operation: 'stop', requestedBy: WINDOW_ID }));
    expect(h.service.stop).not.toHaveBeenCalled();
    await h.disconnectRequests.remove(ENV_ID);
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.delete);
    await run('delete', row('acme/api', env));
    expect(warningMessages().at(-1)).toBe(`${Messages.deleteConfirm('acme/api')} ${ControllerTexts.otherWindowClosesConnection('acme/api')}`);
    expect(await h.disconnectRequests.read(ENV_ID)).toEqual(expect.objectContaining({ operation: 'delete', requestedBy: WINDOW_ID }));
    expect(h.service.deleteInWorker).not.toHaveBeenCalled();

    // The window that works without Devspaces answers such a request as a connected window does.
    recreateHarness({});
    await h.registry.add(devspace());
    await h.controller.workWithoutDevspaces(devspace(), CONTAINER);
    await h.disconnectRequests.write({ devspaceId: ENV_ID, operation: 'delete', requestedAt: iso(NOW - 2000), requestedBy: OTHER_WINDOW_ID, reason: 'manual', additionalVolumesToRemove: [] });
    h.controller.onHeartbeat();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
    expect(await h.sessionFiles.readOperations()).toEqual([expect.objectContaining({ devspaceId: ENV_ID, operation: 'delete', requestedBy: WINDOW_ID })]);
    expect(await h.disconnectRequests.read(ENV_ID)).toBeUndefined();
    expect(h.service.deleteInWorker).not.toHaveBeenCalled();
  });

  // A Refresh of the user restores a lost registry also from an engine with the mark, and keeps the mark: the window of
  // a devspace there works without Devspaces, as one that started there. Mutation: an adoption that takes the devspace
  // (its heartbeats go to that engine) fails it.
  it('a Refresh that restores the devspace of this window on an engine with the mark: the window works without Devspaces', async () => {
    const env = devspace();
    h.connection.currentContainerName.mockReturnValue(CONTAINER);
    h.docker.findContainer.mockResolvedValue(containerInfo(String(CONTAINER_VERSION)));
    await h.engineRecords.setRemoved('', NOW - 1000);
    fs.rmSync(h.paths.registry, { force: true });
    h.service.reconcileInWorker.mockImplementation(async () => {
      await h.registry.add(env);
      return 1;
    });
    await run('refresh');
    expect(h.service.reconcileInWorker).toHaveBeenCalledWith({ passive: false });
    expect(h.coordinator.setDevspace).not.toHaveBeenCalledWith(ENV_ID);
    expect(h.coordinator.setPlainDevspace.mock.calls).toEqual([[ENV_ID]]);
    expect(fakeVscode.window.showInformationMessage.mock.calls).toEqual([[ControllerTexts.windowOnRemovedEngine('the local Docker')]]);
    expect(h.statusBar.showConnected).not.toHaveBeenCalled();
    expect(await h.engineRecords.removed('')).toBe(true);
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
    // A Stop there hands off as in a connected window.
    await run('stop', row('acme/api', env));
    expect(h.connection.closeRemoteConnection).toHaveBeenCalledTimes(1);
    expect(h.service.stop).not.toHaveBeenCalled();

    // The devspace of another account: the account rule comes first; the window closes after the token removal.
    recreateHarness({});
    h.connection.currentContainerName.mockReturnValue(CONTAINER);
    await h.engineRecords.setRemoved('', NOW - 1000);
    fs.rmSync(h.paths.registry, { force: true });
    h.service.reconcileInWorker.mockImplementation(async () => {
      await h.registry.add(devspace({ owner: OTHER_ACCOUNT }));
      return 1;
    });
    await run('refresh');
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close of the connection');
    expect(h.flow).toHaveBeenCalledWith(OP_TOKEN_REMOVE, { devspaceId: ENV_ID, containerName: CONTAINER }, { timeoutMs: 60_000 });
    expect(warningMessages()).toEqual([Messages.otherAccountConnection('acme/api')]);
    expect(h.coordinator.setDevspace).not.toHaveBeenCalledWith(ENV_ID);
    expect(h.coordinator.setPlainDevspace).not.toHaveBeenCalled();
  });

  // After a lost registry on an engine with the mark, the activation reads the labels of the container of the window
  // (removedEngineWindowDevspace); when they do not say whose devspace it is, the window closes as for another account.
  it('a window whose container does not say its owner closes, after the token removal when the labels name the devspace', async () => {
    const reason = 'it has no valid label nimblescape.devspaces.owner-id';
    await h.controller.leaveUnknownOwner(CONTAINER, { devspaceId: ENV_ID, reason });
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close of the connection');
    expect(h.flow).toHaveBeenCalledWith(OP_TOKEN_REMOVE, { devspaceId: ENV_ID, containerName: CONTAINER }, { timeoutMs: 60_000 });
    expect(h.flow.mock.invocationCallOrder[0]).toBeLessThan(h.connection.closeRemoteConnection.mock.invocationCallOrder[0]);
    expect(warningMessages()).toEqual([ControllerTexts.unknownOwnerConnection(CONTAINER)]);
    expect(warningMessages()).toEqual([`Devspaces cannot tell which GitHub account owns the container ${CONTAINER}. This window closes its connection to it.`]);
    expect(h.logger.info).toHaveBeenCalledWith(`The window closes its remote connection: the owner of the devspace of the container ${CONTAINER} cannot be read (${reason}).`);
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    expect(fakeVscode.window.showInformationMessage).not.toHaveBeenCalled();
    // Nor does a later restore adopt a devspace for the window.
    h.connection.currentContainerName.mockReturnValue(CONTAINER);
    await h.registry.add(devspace());
    await h.controller.reconcileIfRegistryLost({ passive: false, adopt: true });
    expect(h.coordinator.setDevspace).not.toHaveBeenCalledWith(ENV_ID);
    expect(h.coordinator.setPlainDevspace).not.toHaveBeenCalled();

    // Without the ID of the devspace, nothing can find a token there: the window only closes.
    recreateHarness({});
    await h.controller.leaveUnknownOwner(CONTAINER, { reason: 'Docker did not answer in time' });
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close of the connection');
    expect(h.flow).not.toHaveBeenCalled();
    expect(warningMessages()).toEqual([ControllerTexts.unknownOwnerConnection(CONTAINER)]);
  });

  // The Docker pipe in the authority of the window is not served (windowPipe.ts): nothing that answers would be ours.
  it('a window whose Docker pipe is not served closes its connection with the message, without the open pipeline', async () => {
    recreateHarness({});
    await h.registry.add(devspace());
    await h.controller.leaveWithoutDockerPipe(CONTAINER, 'it was not made on this computer for the devspace of the container.');
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close of the connection');
    expect(warningMessages()).toEqual([ControllerTexts.dockerPipeNotServed(CONTAINER)]);
    expect(h.logger.info).toHaveBeenCalledWith('The window closes its remote connection: its Docker pipe is not served (it was not made on this computer for the devspace of the container.)');
    expect(h.coordinator.setDevspace).toHaveBeenCalledWith(null);
    expect(h.flow).not.toHaveBeenCalled();
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    // Nor does a later restore adopt the devspace for the window.
    h.connection.currentContainerName.mockReturnValue(CONTAINER);
    await h.controller.reconcileIfRegistryLost({ passive: false, adopt: true });
    expect(h.coordinator.setDevspace).not.toHaveBeenCalledWith(ENV_ID);
  });

  // Mutation: without a record of the container, a window that kept its connection stays connected to it.
  it('a window whose container names neither its owner nor its devspace closes its connection again when it kept it, without a token step', async () => {
    recreateHarness({ leaveCheckMs: 20 });
    // This extension host still runs after the close (Cancel on unsaved files): the window is still attached.
    h.connection.currentContainerName.mockReturnValue(CONTAINER);
    await h.controller.leaveUnknownOwner(CONTAINER, { reason: 'Docker did not answer in time' });
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length >= 2, 'the second close');
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledWith(ControllerTexts.stillConnected(CONTAINER), { modal: true }, {
      title: ControllerTexts.closeConnection,
      isCloseAffordance: true,
    });
    expect(h.logger.warn).toHaveBeenCalledWith(`This window is still connected to ${CONTAINER}, which it must not use. It closes its remote connection again.`);
    expect(h.flow).not.toHaveBeenCalled();
    expect(h.connection.open).not.toHaveBeenCalled();
  });

  it('is a command of package.json, in the Command Palette and last in the "…" menu of the view, in a group of its own', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: { commands: Array<{ command: string; title: string; category: string }>; menus: Record<string, Array<{ command: string; when?: string; group?: string }>> };
    };
    expect(manifest.contributes.commands.find((entry) => entry.command === Commands.removeFromDockerEngine)).toEqual({
      command: 'devspaces.removeFromDockerEngine',
      title: 'Remove Devspaces from This Docker Engine…',
      category: 'Devspaces',
    });
    expect(manifest.contributes.menus.commandPalette.some((entry) => entry.command === Commands.removeFromDockerEngine)).toBe(false);
    expect(manifest.contributes.menus['view/title'].find((entry) => entry.command === Commands.removeFromDockerEngine)).toEqual({
      command: Commands.removeFromDockerEngine,
      when: 'view == devspaces.repositories',
      group: '3_remove@1',
    });
    // As Delete in the ⋯ menu of a row: the last item, apart from the others. VS Code sorts the groups of the "…" menu
    // by name and puts the items without a group last; the items of the group navigation are the buttons of the title
    // bar.
    const more = manifest.contributes.menus['view/title'].filter((entry) => !entry.group?.startsWith('navigation'));
    const withoutGroup = (entry: { group?: string }) => (entry.group ? 0 : 1);
    const sorted = [...more].sort((a, b) => withoutGroup(a) - withoutGroup(b) || (a.group ?? '').localeCompare(b.group ?? ''));
    expect(sorted.at(-1)?.command).toBe(Commands.removeFromDockerEngine);
    expect(more.filter((entry) => entry.group?.startsWith('3_remove@')).map((entry) => entry.command)).toEqual([Commands.removeFromDockerEngine]);
  });
});

describe('Connection of this window', () => {
  it('shows Reconnect when the container stops, and Connected when it runs again', async () => {
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    h.docker.containerState.mockResolvedValue('stopped');
    h.controller.onHeartbeat();
    await settle(() => h.statusBar.showConnectionLost.mock.calls.length === 1, 'Reconnect');
    expect(h.statusBar.showConnectionLost).toHaveBeenCalledWith('acme/api', ENV_ID);

    h.docker.containerState.mockResolvedValue('running');
    const connectedCalls = h.statusBar.showConnected.mock.calls.length;
    h.controller.onHeartbeat();
    await settle(() => h.statusBar.showConnected.mock.calls.length > connectedCalls, 'Connected');
  });

  // A state that the worker cannot read ("unknown") changes nothing; a Reconnect of the user then is tried, and its
  // failure leaves the window disconnected.
  it('keeps its state when the state of the container cannot be read, and a Reconnect of the user then is tried', async () => {
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    const connectedCalls = h.statusBar.showConnected.mock.calls.length;
    h.service.windowStateInWorker.mockResolvedValue(undefined);
    const reads = h.service.windowStateInWorker.mock.calls.length;
    h.controller.onHeartbeat();
    await settle(() => h.service.windowStateInWorker.mock.calls.length > reads, 'the read of the state');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.statusBar.showConnectionLost).not.toHaveBeenCalled();
    // The status bar shows the same connected state again, with the tooltip that the state could not be read.
    expect(h.statusBar.showConnected.mock.calls.slice(connectedCalls)).toEqual([h.statusBar.showConnected.mock.calls[connectedCalls - 1]]);
    expect(h.statusBar.showStateUnknown).toHaveBeenLastCalledWith(true);
    // Every read is passive in windowStateInWorker (devspaceService.listInWorker.test).
    expect(h.service.windowStateInWorker.mock.calls.slice(reads).map((call) => call[2])).toEqual([undefined]);
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
    // The Start does not take the unknown state as "not running": it reads again with the worker made ready in full;
    // still unknown, it fails, and the window is disconnected, without a pipeline that could replace the container
    // under it.
    await run('start', { devspaceId: ENV_ID });
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    expect(h.service.windowStateInWorker.mock.calls.some((call) => call[2]?.signal instanceof AbortSignal)).toBe(true);
    expect(fakeVscode.window.showErrorMessage).toHaveBeenCalledWith(ControllerTexts.containerStateUnreadable('acme/api'), expect.anything(), expect.anything());
    expect(h.statusBar.showConnectionLost).toHaveBeenCalledWith('acme/api', ENV_ID);
  });

  // The read again finds the container running: no pipeline under this window.
  it('a Start whose first read is unknown and whose read in the operation finds the container running and outdated leaves it', async () => {
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    h.service.windowStateInWorker.mockResolvedValueOnce(undefined);
    h.docker.findContainer.mockResolvedValue(containerInfo('0'));
    await run('start', { devspaceId: ENV_ID });
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
    expect(warningMessages()).toEqual([ControllerTexts.outdatedContainerClosed('acme/api')]);
  });

  it('a Start whose first read is unknown and whose read in the operation finds the container running and current is connected', async () => {
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    h.service.windowStateInWorker.mockResolvedValueOnce(undefined);
    await run('start', { devspaceId: ENV_ID });
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(ControllerTexts.alreadyConnected('acme/api'));
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
  });

  // A failed Reconnect leaves a container that must not be used as it is.
  it('a Reconnect that fails leaves a container of an older version that it did not make again', async () => {
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    h.docker.containerState.mockResolvedValue('stopped');
    h.docker.findContainer.mockResolvedValue(containerInfo('0'));
    h.service.openDevspaceInWorker.mockRejectedValueOnce(new UserFacingError('hostAccess', Messages.hostAccess('privileged mode')));
    await run('start', { devspaceId: ENV_ID });
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledTimes(1);
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
    expect(warningMessages()).toContain(ControllerTexts.outdatedContainerClosed('acme/api'));
  });

  // An outdated check that was unknown when the window attached is read again.
  it('leaves an outdated container when the check of the connection can read it after the window attached unknown', async () => {
    const env = devspace();
    await h.registry.add(env);
    h.service.windowStateInWorker.mockResolvedValue(undefined);
    h.service.openDevspaceInWorker.mockRejectedValueOnce(new UserFacingError('helperFailed', Messages.helperFailed));
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    expect(h.statusBar.showConnectionLost).toHaveBeenCalledWith('acme/api', ENV_ID);
    // The reads of the window after its open (the connection and the branch) end before the heartbeat.
    await settle(() => h.service.windowStateInWorker.mock.calls.some((call) => call[2]?.branch === true), 'the branch read');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
    h.service.windowStateInWorker.mockResolvedValue({ state: 'running', outdated: 'hostAccess' });
    h.controller.onHeartbeat();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
    expect(warningMessages()).toContain(ControllerTexts.unrestrictedContainerClosed('acme/api'));
  });

  // The host access checks turned on after the window attached apply from the next open: the check that reads the
  // container later does not leave it for them.
  it('does not leave a container that was current at the unknown attach when the host access checks are turned on later', async () => {
    const env = devspace();
    await h.registry.add(env);
    h.settings.hostAccessChecksOff = ['acme/api'];
    h.docker.findContainer.mockResolvedValue({ ...containerInfo(String(CONTAINER_VERSION)), labels: { [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION), [LABEL_HOST_ACCESS]: HOST_ACCESS_UNRESTRICTED } });
    const read = h.service.windowStateInWorker.getMockImplementation()!;
    h.service.windowStateInWorker.mockResolvedValue(undefined);
    h.service.openDevspaceInWorker.mockRejectedValueOnce(new UserFacingError('helperFailed', Messages.helperFailed));
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    await settle(() => h.service.windowStateInWorker.mock.calls.some((call) => call[2]?.branch === true), 'the branch read');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
    h.settings.hostAccessChecksOff = [];
    h.service.windowStateInWorker.mockImplementation(read);
    const reads = h.service.windowStateInWorker.mock.calls.length;
    h.controller.onHeartbeat();
    await settle(() => h.service.windowStateInWorker.mock.calls.length > reads, 'the read');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
  });

  // A Start while the open pipeline of the restored window runs reads and leaves nothing.
  it('a Start during the open pipeline of the restored window neither leaves its container nor shows Reconnect', async () => {
    const env = devspace();
    await h.registry.add(env);
    const pipeline = deferred<OpenResult>();
    h.service.openDevspaceInWorker.mockImplementationOnce(() => pipeline.promise);
    h.docker.containerState.mockResolvedValue('stopped');
    h.docker.findContainer.mockResolvedValue(containerInfo('0'));
    const opening = h.controller.openAttachedWindow(env, CONTAINER, undefined);
    await settle(() => h.service.openDevspaceInWorker.mock.calls.length === 1, 'the pipeline');
    await run('start', { devspaceId: ENV_ID });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const closes = h.connection.closeRemoteConnection.mock.calls.length;
    const lost = h.statusBar.showConnectionLost.mock.calls.length;
    h.docker.containerState.mockResolvedValue('running');
    h.docker.findContainer.mockResolvedValue(containerInfo(String(CONTAINER_VERSION)));
    pipeline.resolve(openResult(env));
    await opening;
    expect({ closes, lost }).toEqual({ closes: 0, lost: 0 });
  });

  // Also a running container of an older version, which the pipeline may replace.
  it('a Start during the open pipeline of the restored window reads nothing, also when its container runs', async () => {
    const env = devspace();
    await h.registry.add(env);
    const pipeline = deferred<OpenResult>();
    h.service.openDevspaceInWorker.mockImplementationOnce(() => pipeline.promise);
    h.docker.findContainer.mockResolvedValue(containerInfo('0'));
    const opening = h.controller.openAttachedWindow(env, CONTAINER, undefined);
    await settle(() => h.service.openDevspaceInWorker.mock.calls.length === 1, 'the pipeline');
    const reads = h.service.windowStateInWorker.mock.calls.length;
    await run('start', { devspaceId: ENV_ID });
    expect(h.service.windowStateInWorker.mock.calls.length).toBe(reads);
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
    h.docker.findContainer.mockResolvedValue(containerInfo(String(CONTAINER_VERSION)));
    pipeline.resolve(openResult(env));
    await opening;
  });

  // Mutation probes of the reads of Start and of the check of the connection.
  it('a Start whose first read finds the container running ends Reconnect, and shows it connected again', async () => {
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    h.service.windowStateInWorker.mockResolvedValueOnce({ state: 'stopped' });
    h.controller.onHeartbeat();
    await settle(() => h.statusBar.showConnectionLost.mock.calls.length > 0, 'Reconnect');
    const lostCalls = h.statusBar.showConnectionLost.mock.calls.length;
    const connectedCalls = h.statusBar.showConnected.mock.calls.length;
    h.service.windowStateInWorker.mockResolvedValueOnce({ state: 'running' });
    h.service.windowStateInWorker.mockResolvedValue(undefined);
    await run('start', { devspaceId: ENV_ID });
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    expect(h.statusBar.showConnectionLost.mock.calls.length).toBe(lostCalls);
    expect(h.statusBar.showConnected.mock.calls.length).toBeGreaterThan(connectedCalls);
    expect(h.statusBar.showConnected).toHaveBeenLastCalledWith('acme/api', expect.anything());
  });

  it('a Start whose read in the operation finds the container running ends Reconnect', async () => {
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    h.service.windowStateInWorker.mockResolvedValueOnce({ state: 'stopped' });
    h.controller.onHeartbeat();
    await settle(() => h.statusBar.showConnectionLost.mock.calls.length > 0, 'Reconnect');
    const lostCalls = h.statusBar.showConnectionLost.mock.calls.length;
    const connectedCalls = h.statusBar.showConnected.mock.calls.length;
    h.service.windowStateInWorker.mockResolvedValueOnce(undefined);
    h.service.windowStateInWorker.mockResolvedValueOnce({ state: 'running' });
    h.service.windowStateInWorker.mockResolvedValue(undefined);
    await run('start', { devspaceId: ENV_ID });
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    expect(h.statusBar.showConnectionLost.mock.calls.length).toBe(lostCalls);
    expect(h.statusBar.showConnected.mock.calls.length).toBeGreaterThan(connectedCalls);
  });

  it('a Start whose read in the operation finds the container running removes the hint of an unknown state', async () => {
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    h.service.windowStateInWorker.mockResolvedValueOnce(undefined);
    h.controller.onHeartbeat();
    await settle(() => h.statusBar.showStateUnknown.mock.lastCall?.[0] === true, 'the hint');
    h.service.windowStateInWorker.mockResolvedValueOnce(undefined);
    h.service.windowStateInWorker.mockResolvedValueOnce({ state: 'running' });
    await run('start', { devspaceId: ENV_ID });
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    expect(h.statusBar.showStateUnknown).toHaveBeenLastCalledWith(false);
  });

  it('the read in the operation of Start reads the container of the folder of the window', async () => {
    const env = devspace();
    await h.registry.add(env);
    const reads = h.service.currentBranch.mock.calls.length;
    await h.controller.openAttachedWindow(env, 'devspaces-old', { devspaceId: env.id, windowId: WINDOW_ID, createdAt: iso(NOW - 5000) });
    await settle(() => h.service.currentBranch.mock.calls.length > reads, 'the branch of the window');
    h.service.windowStateInWorker.mockResolvedValueOnce(undefined);
    await run('start', { devspaceId: ENV_ID });
    expect(h.service.windowStateInWorker.mock.calls.filter((call) => call[2]?.signal !== undefined).map((call) => call[1])).toEqual(['devspaces-old']);
  });

  it('a Cancel during the read in the operation of Start shows no error', async () => {
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    const progress = cancellableProgress();
    h.service.windowStateInWorker.mockResolvedValueOnce(undefined);
    h.service.windowStateInWorker.mockImplementationOnce(async () => {
      progress.cancel();
      return undefined;
    });
    await run('start', { devspaceId: ENV_ID });
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    expect(fakeVscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('the check of the connection shows Reconnect when Docker is not installed', async () => {
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    h.docker.isInstalled.mockReturnValue(false);
    h.controller.onHeartbeat();
    await settle(() => h.statusBar.showConnectionLost.mock.calls.length > 0, 'Reconnect');
  });

  it('a check of the connection that read the container current ends the pending outdated check', async () => {
    const env = devspace();
    await h.registry.add(env);
    h.service.windowStateInWorker.mockResolvedValue(undefined);
    h.service.openDevspaceInWorker.mockRejectedValueOnce(new UserFacingError('helperFailed', Messages.helperFailed));
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    await settle(() => h.service.windowStateInWorker.mock.calls.some((call) => call[2]?.branch === true), 'the branch read');
    await new Promise((resolve) => setTimeout(resolve, 20));
    h.service.windowStateInWorker.mockResolvedValue({ state: 'running' });
    let reads = h.service.windowStateInWorker.mock.calls.length;
    h.controller.onHeartbeat();
    await settle(() => h.service.windowStateInWorker.mock.calls.length > reads, 'the read');
    await new Promise((resolve) => setTimeout(resolve, 20));
    h.service.windowStateInWorker.mockResolvedValue({ state: 'running', outdated: 'hostAccess' });
    reads = h.service.windowStateInWorker.mock.calls.length;
    h.controller.onHeartbeat();
    await settle(() => h.service.windowStateInWorker.mock.calls.length > reads, 'the read');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
  });

  it('a failed Reconnect that read the container current sets no pending outdated check', async () => {
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    h.service.windowStateInWorker.mockResolvedValueOnce({ state: 'stopped' });
    h.service.windowStateInWorker.mockResolvedValueOnce({ state: 'stopped' });
    h.service.openDevspaceInWorker.mockRejectedValueOnce(new UserFacingError('helperFailed', Messages.helperFailed));
    await run('start', { devspaceId: ENV_ID });
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    h.service.windowStateInWorker.mockResolvedValue({ state: 'running', outdated: 'hostAccess' });
    const reads = h.service.windowStateInWorker.mock.calls.length;
    h.controller.onHeartbeat();
    await settle(() => h.service.windowStateInWorker.mock.calls.length > reads, 'the read');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
  });

  // The pending outdated check and the reads of Start.
  async function attachUnknown(env: Devspace): Promise<void> {
    h.service.windowStateInWorker.mockResolvedValue(undefined);
    h.service.openDevspaceInWorker.mockRejectedValueOnce(new UserFacingError('helperFailed', Messages.helperFailed));
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    await settle(() => h.service.windowStateInWorker.mock.calls.some((call) => call[2]?.branch === true), 'the branch read');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
  }

  async function heartbeatRead(value: WindowStateValue): Promise<void> {
    h.service.windowStateInWorker.mockResolvedValue(value);
    const reads = h.service.windowStateInWorker.mock.calls.length;
    h.controller.onHeartbeat();
    await settle(() => h.service.windowStateInWorker.mock.calls.length > reads, 'the read');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  it('the pending outdated check leaves a container of an older version, also when the host access checks changed', async () => {
    const env = devspace();
    await h.registry.add(env);
    await attachUnknown(env);
    h.settings.hostAccessChecksOff = ['acme/api'];
    await heartbeatRead({ state: 'running', outdated: 'version' });
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
    expect(warningMessages()).toContain(ControllerTexts.outdatedContainerClosed('acme/api'));
  });

  it('a Start whose first read finds the container current ends the pending outdated check', async () => {
    const env = devspace();
    await h.registry.add(env);
    await attachUnknown(env);
    h.service.windowStateInWorker.mockResolvedValueOnce({ state: 'running' });
    await run('start', { devspaceId: ENV_ID });
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(ControllerTexts.alreadyConnected('acme/api'));
    await heartbeatRead({ state: 'running', outdated: 'hostAccess' });
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
  });

  // The read in the operation of Start is a known read too.
  it('a Start whose read in the operation finds the container current ends the pending outdated check', async () => {
    const env = devspace();
    await h.registry.add(env);
    await attachUnknown(env);
    h.service.windowStateInWorker.mockResolvedValueOnce(undefined);
    h.service.windowStateInWorker.mockResolvedValueOnce({ state: 'running' });
    await run('start', { devspaceId: ENV_ID });
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(ControllerTexts.alreadyConnected('acme/api'));
    await heartbeatRead({ state: 'running', outdated: 'hostAccess' });
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
  });

  it('a first read of Start that ends after the window left its devspace leaves nothing more', async () => {
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    const read = deferred<WindowStateValue | undefined>();
    h.service.windowStateInWorker.mockImplementationOnce(() => read.promise);
    const starting = run('start', { devspaceId: ENV_ID });
    await settle(() => h.service.windowStateInWorker.mock.calls.length > 0 && h.service.windowStateInWorker.mock.lastCall?.[2] === undefined, 'the read of Start');
    h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
    await h.controller.onSessionChanged();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
    read.resolve({ state: 'running', outdated: 'version' });
    await starting;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.connection.closeRemoteConnection).toHaveBeenCalledTimes(1);
    expect(warningMessages()).not.toContain(ControllerTexts.outdatedContainerClosed('acme/api'));
  });

  it('a read in the operation of Start that ends after the window left its devspace says nothing', async () => {
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    const read = deferred<WindowStateValue | undefined>();
    h.service.windowStateInWorker.mockResolvedValueOnce(undefined);
    h.service.windowStateInWorker.mockImplementationOnce(() => read.promise);
    const starting = run('start', { devspaceId: ENV_ID });
    await settle(() => h.service.windowStateInWorker.mock.calls.some((call) => call[2]?.signal !== undefined), 'the read in the operation');
    h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
    await h.controller.onSessionChanged();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
    read.resolve({ state: 'running', outdated: 'version' });
    await starting;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.connection.closeRemoteConnection).toHaveBeenCalledTimes(1);
    expect(warningMessages()).not.toContain(ControllerTexts.outdatedContainerClosed('acme/api'));
    expect(fakeVscode.window.showInformationMessage).not.toHaveBeenCalledWith(ControllerTexts.alreadyConnected('acme/api'));
  });

  // A container read as current when the window attached is not left by the check.
  it('does not leave a container that was current when the window attached, also when the check reads it outdated', async () => {
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    h.service.windowStateInWorker.mockResolvedValue({ state: 'running', outdated: 'hostAccess' });
    const reads = h.service.windowStateInWorker.mock.calls.length;
    h.controller.onHeartbeat();
    await settle(() => h.service.windowStateInWorker.mock.calls.length > reads, 'the read');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
  });

  // A read that succeeds again removes the hint; a Reconnect of the user from the unknown state that succeeds leaves
  // the window connected.
  it('removes the hint of an unknown state when the state can be read again, and a Reconnect from it that succeeds connects', async () => {
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    h.service.windowStateInWorker.mockResolvedValueOnce(undefined);
    const reads = h.service.windowStateInWorker.mock.calls.length;
    h.controller.onHeartbeat();
    await settle(() => h.statusBar.showStateUnknown.mock.calls.some((call) => call[0] === true), 'the hint');
    // The Start of the user reads unknown once more; its read in the operation finds the container stopped, and the
    // pipeline reconnects, which succeeds.
    h.service.windowStateInWorker.mockResolvedValueOnce(undefined);
    h.docker.containerState.mockResolvedValueOnce('stopped');
    await run('start', { devspaceId: ENV_ID });
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledTimes(1);
    h.docker.containerState.mockResolvedValue('running');
    expect(h.service.windowStateInWorker.mock.calls.length).toBeGreaterThan(reads);
    await new Promise((resolve) => setTimeout(resolve, 20));
    h.controller.onHeartbeat();
    await settle(() => h.statusBar.showStateUnknown.mock.lastCall?.[0] === false, 'the hint removed');
    expect(h.statusBar.showConnectionLost).not.toHaveBeenCalled();
    expect(h.statusBar.showConnected).toHaveBeenLastCalledWith('acme/api', expect.anything());
  });

  // The window reads its own container (from its folder URI), not the one of the record.
  it('reads the container of its folder, also when the record names another one', async () => {
    const env = devspace();
    await h.registry.add(env);
    const reads = h.service.currentBranch.mock.calls.length;
    await h.controller.openAttachedWindow(env, 'devspaces-old', { devspaceId: env.id, windowId: WINDOW_ID, createdAt: iso(NOW - 5000) });
    await settle(() => h.service.currentBranch.mock.calls.length > reads, 'the branch of the window');
    const before = h.service.windowStateInWorker.mock.calls.length;
    h.controller.onHeartbeat();
    await settle(() => h.service.windowStateInWorker.mock.calls.length > before, 'the read of the state');
    expect(h.service.windowStateInWorker.mock.calls.slice(before).map((call) => call[1])).toEqual(['devspaces-old']);
    // The branch read too.
    expect(h.service.windowStateInWorker.mock.calls.filter((call) => call[2]?.branch === true).map((call) => call[1])).toEqual(['devspaces-old']);
    h.docker.containerState.mockResolvedValue('running');
    await run('start', { devspaceId: ENV_ID });
    expect(h.service.windowStateInWorker.mock.lastCall?.[1]).toBe('devspaces-old');
    expect(env.containerName).not.toBe('devspaces-old');
  });

  // A read that ends after the window left its devspace changes nothing.
  it('ignores a read of the state that ends after the window left its devspace', async () => {
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    const read = deferred<WindowStateValue | undefined>();
    h.service.windowStateInWorker.mockImplementationOnce(() => read.promise);
    const reads = h.service.windowStateInWorker.mock.calls.length;
    h.controller.onHeartbeat();
    await settle(() => h.service.windowStateInWorker.mock.calls.length > reads, 'the read in the background');
    h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
    await h.controller.onSessionChanged();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length > 0, 'the close');
    read.resolve({ state: 'stopped' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.logger.info.mock.calls.some(([line]) => String(line) === 'The container of acme/api does not run.')).toBe(false);
    expect(h.statusBar.showConnectionLost).not.toHaveBeenCalled();
  });

  // A Start that reads the container running ends "Connection lost" at once.
  it('a Start that reads the container running while the window shows Reconnect shows it connected, without the pipeline', async () => {
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    h.service.windowStateInWorker.mockResolvedValueOnce({ state: 'stopped' });
    h.controller.onHeartbeat();
    await settle(() => h.statusBar.showConnectionLost.mock.calls.length > 0, 'Reconnect');
    const lostCalls = h.statusBar.showConnectionLost.mock.calls.length;
    h.docker.containerState.mockResolvedValue('running');
    await run('start', { devspaceId: ENV_ID });
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    expect(h.statusBar.showConnectionLost.mock.calls.length).toBe(lostCalls);
    expect(h.statusBar.showConnected).toHaveBeenLastCalledWith('acme/api', expect.anything());
    // The read of Start asks for no branch.
    expect(h.service.windowStateInWorker).toHaveBeenLastCalledWith(expect.objectContaining({ id: ENV_ID }), env.containerName);
  });

  // The window reads its state at once after its open, not at the first heartbeat.
  it('shows Reconnect after its open when its container does not run, without a heartbeat', async () => {
    const env = devspace();
    await h.registry.add(env);
    h.docker.containerState.mockResolvedValue('stopped');
    h.service.openDevspaceInWorker.mockResolvedValueOnce(openResult(env));
    await h.controller.openAttachedWindow(env, CONTAINER, { devspaceId: env.id, windowId: WINDOW_ID, createdAt: iso(NOW - 5000) });
    await settle(() => h.statusBar.showConnectionLost.mock.calls.length > 0, 'Reconnect');
  });

  // A branch read that ends after the window left its devspace changes nothing.
  it('ignores a branch read that ends after the window left its devspace', async () => {
    const env = devspace();
    await h.registry.add(env);
    const read = deferred<WindowStateValue | undefined>();
    h.service.windowStateInWorker.mockImplementation(async (_env, _name, options = {}) => (options.branch ? read.promise : { state: 'running' }));
    await h.controller.openAttachedWindow(env, CONTAINER, { devspaceId: env.id, windowId: WINDOW_ID, createdAt: iso(NOW - 5000) });
    await settle(() => h.service.windowStateInWorker.mock.calls.some((call) => call[2]?.branch === true), 'the branch read');
    h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
    await h.controller.onSessionChanged();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length > 0, 'the close');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const updates = h.statusBar.showNotConnected.mock.calls.length + h.statusBar.showConnected.mock.calls.length;
    read.resolve({ state: 'running', branch: 'feature/late' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.statusBar.showNotConnected.mock.calls.length + h.statusBar.showConnected.mock.calls.length).toBe(updates);
  });

  // A Start whose read finds the container running removes the hint at once.
  it('removes the hint of an unknown state when a Start of the user reads that the container runs', async () => {
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    h.service.windowStateInWorker.mockResolvedValueOnce(undefined);
    h.controller.onHeartbeat();
    await settle(() => h.statusBar.showStateUnknown.mock.lastCall?.[0] === true, 'the hint');
    h.docker.containerState.mockResolvedValue('running');
    await run('start', { devspaceId: ENV_ID });
    expect(h.statusBar.showStateUnknown).toHaveBeenLastCalledWith(false);
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
  });

  // A read that ends after an operation of the devspace started changes nothing.
  it('ignores a read of the state that ends after an operation of its devspace started', async () => {
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    const read = deferred<WindowStateValue | undefined>();
    h.service.windowStateInWorker.mockImplementationOnce(() => read.promise);
    const reads = h.service.windowStateInWorker.mock.calls.length;
    h.controller.onHeartbeat();
    await settle(() => h.service.windowStateInWorker.mock.calls.length > reads, 'the read in the background');
    // A Start of the user meanwhile: the container does not run, the pipeline reconnects and is still running.
    const pipeline = deferred<Awaited<ReturnType<typeof h.service.openDevspaceInWorker>>>();
    h.service.openDevspaceInWorker.mockImplementationOnce(() => pipeline.promise);
    h.docker.containerState.mockResolvedValue('stopped');
    const starting = run('start', { devspaceId: ENV_ID });
    await settle(() => h.service.openDevspaceInWorker.mock.calls.length === 1, 'the pipeline');
    read.resolve({ state: 'stopped' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.statusBar.showConnectionLost).not.toHaveBeenCalled();
    expect(h.logger.info.mock.calls.some(([line]) => String(line) === 'The container of acme/api does not run.')).toBe(false);
    pipeline.reject(new UserFacingError('cancelled', PipelineTexts.cancelled));
    await starting;
  });

  it('closes its connection for the request of another window, and leaves the operation to its empty window', async () => {
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    await h.disconnectRequests.write({
      devspaceId: ENV_ID,
      operation: 'delete',
      requestedAt: iso(NOW - 2000),
      requestedBy: OTHER_WINDOW_ID,
      reason: 'manual',
      additionalVolumesToRemove: ['api-db'],
    });
    h.controller.onHeartbeat();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
    expect(await h.sessionFiles.readOperations()).toEqual([
      expect.objectContaining({ devspaceId: ENV_ID, operation: 'delete', requestedBy: WINDOW_ID, additionalVolumesToRemove: ['api-db'] }),
    ]);
    expect((await h.registry.get(ENV_ID))?.busy).toEqual(expect.objectContaining({ operation: 'delete', windowId: WINDOW_ID }));
    expect(await h.disconnectRequests.read(ENV_ID)).toBeUndefined();
    expect(h.service.deleteInWorker).not.toHaveBeenCalled();
  });

  it('hands off a requested rebuild with its reason', async () => {
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    await h.disconnectRequests.write({
      devspaceId: ENV_ID,
      operation: 'rebuild',
      requestedAt: iso(NOW - 2000),
      requestedBy: OTHER_WINDOW_ID,
      reason: 'configChanged',
    });
    h.controller.onHeartbeat();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
    expect(await h.sessionFiles.readOperations()).toEqual([expect.objectContaining({ operation: 'rebuild', reason: 'configChanged' })]);
    expect((await h.registry.get(ENV_ID))?.busy?.operation).toBe('rebuild');
  });

  it('answers a request at once through the watched folder', async () => {
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    const watcher = h.controller.watchDisconnectRequests();
    try {
      await h.disconnectRequests.write({
        devspaceId: ENV_ID,
        operation: 'stop',
        requestedAt: iso(NOW - 1000),
        requestedBy: OTHER_WINDOW_ID,
        reason: 'manual',
      });
      await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
      expect(await h.sessionFiles.readOperations()).toEqual([expect.objectContaining({ operation: 'stop' })]);
      expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
    } finally {
      watcher.dispose();
    }
  });

  it('drops a request that is too old, and ignores requests for other devspaces', async () => {
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    await h.disconnectRequests.write({
      devspaceId: ENV_ID,
      operation: 'stop',
      requestedAt: iso(NOW - 5 * 60_000),
      requestedBy: OTHER_WINDOW_ID,
      reason: 'manual',
    });
    const other = 'b1c2d3e4-0000-4000-8000-000000000002';
    await h.disconnectRequests.write({
      devspaceId: other,
      operation: 'stop',
      requestedAt: iso(NOW - 1000),
      requestedBy: OTHER_WINDOW_ID,
      reason: 'manual',
    });
    h.controller.onHeartbeat();
    await settle(() => fs.readdirSync(path.join(h.root, 'disconnect')).length === 1, 'the removal');
    expect(await h.disconnectRequests.read(other)).toBeDefined();
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
    expect(await h.sessionFiles.readOperations()).toEqual([]);
  });

  it('shows Updating while a pipeline runs, and the state below it afterwards', () => {
    h.controller.onBusyChanged({ busy: true, title: 'Opening acme/api…', repository: 'acme/api' });
    expect(h.statusBar.showBusy).toHaveBeenCalledWith('acme/api');
    h.controller.onBusyChanged({ busy: true, title: 'Stopping acme/web…' });
    h.controller.onBusyChanged({ busy: false });
    expect(h.statusBar.clearBusy).toHaveBeenCalledTimes(2);
  });

  it('opens the editor of the repository groups with Edit Repository Groups…', async () => {
    await run('editRepositoryGroups');
    expect(h.repositoryGroupsEditor.open).toHaveBeenCalledTimes(1);
  });

  it('runs the buttons of the Docker setup in the sidebar, and Show Docker Setup of the action Install Docker…', async () => {
    await run('dockerSetupInstall');
    await run('dockerSetupStart');
    await run('dockerSetupInstallWsl');
    await run('dockerSetupShow');
    expect(h.dockerSetup.install).toHaveBeenCalledTimes(1);
    expect(h.dockerSetup.start).toHaveBeenCalledTimes(1);
    expect(h.dockerSetup.installWsl).toHaveBeenCalledTimes(1);
    expect(h.dockerSetup.show).toHaveBeenCalledTimes(1);
  });

  it('shows an error of a Docker setup command', async () => {
    h.dockerSetup.start.mockRejectedValue(new UserFacingError('dockerStartFailed', Messages.dockerStartFailed));
    await run('dockerSetupStart');
    expect(fakeVscode.window.showErrorMessage).toHaveBeenCalledWith(Messages.dockerStartFailed, Actions.showDetails);
  });
});

describe('Accounts', () => {
  it('refuses Start, Stop, Delete, and Rebuild of a devspace of another account unless its owner signs in', async () => {
    const env = devspace({ owner: OTHER_ACCOUNT });
    await h.registry.add(env);
    for (const command of ['start', 'stop', 'delete', 'rebuild'] as const) {
      await run(command, row('acme/api', env));
    }
    // The status bar item Reconnect.
    await run('start', { devspaceId: ENV_ID });
    // Each command asks for the sign-in of the owner (rule 2); the user cancels.
    expect(warningMessages()).toEqual(Array(5).fill(ControllerTexts.hiddenOwnerQuestion('acme/api', OTHER_ACCOUNT.login)));
    const buttons = fakeVscode.window.showWarningMessage.mock.calls.map((call: unknown[]) => call.slice(2));
    expect(buttons).toEqual(Array(5).fill([ControllerTexts.signInAs(OTHER_ACCOUNT.login)]));
    for (const call of Object.values(h.service)) expect(call).not.toHaveBeenCalled();
    expect(h.connection.open).not.toHaveBeenCalled();
    expect(fakeVscode.window.createQuickPick).not.toHaveBeenCalled();
    expect(h.auth.getAccount).not.toHaveBeenCalledWith(expect.objectContaining({ interactive: true }));
  });

  it('uses a devspace of another account after the sign-in of its owner, and refuses it after a sign-in of another account', async () => {
    const env = devspace({ owner: OTHER_ACCOUNT });
    await h.registry.add(env);
    // The owner signs in: the devspace opens.
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(ControllerTexts.signInAs(OTHER_ACCOUNT.login));
    h.auth.getAccount.mockImplementation(async (options?: { account?: GitHubAccount }) => options?.account ?? ACCOUNT);
    await run('start', row('acme/api', env));
    expect(h.auth.getAccount).toHaveBeenCalledWith({ interactive: true, account: OTHER_ACCOUNT });
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledWith(ENV_ID, expect.anything());

    // The sign-in ends with another account: nothing opens, and the message names the owner.
    h.service.openDevspaceInWorker.mockClear();
    fakeVscode.window.showWarningMessage.mockClear();
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(ControllerTexts.signInAs(OTHER_ACCOUNT.login));
    h.auth.getAccount.mockImplementation(async () => ACCOUNT);
    await run('start', row('acme/api', env));
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    expect(warningMessages()).toEqual([ControllerTexts.hiddenOwnerQuestion('acme/api', OTHER_ACCOUNT.login), Messages.otherAccount('acme/api', OTHER_ACCOUNT.login)]);
  });

  it('asks before a Start of a repository whose devspace belongs to an account that is not signed in (rule 2)', async () => {
    await h.registry.add(devspace({ owner: OTHER_ACCOUNT }));
    const own = devspace({ id: 'c1d2e3f4-0000-4000-8000-000000000003', containerName: 'devspaces-octo-api-c1d2e3f4' });
    h.service.openInWorker.mockImplementation(async () => {
      await h.registry.add(own);
      return openResult(own);
    });
    // Cancel: nothing opens.
    await run('start', row('acme/api'));
    expect(h.service.openInWorker).not.toHaveBeenCalled();
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    const [question] = fakeVscode.window.showWarningMessage.mock.calls;
    expect(question).toEqual([
      ControllerTexts.hiddenOwnerQuestion('acme/api', OTHER_ACCOUNT.login),
      { modal: true, detail: ControllerTexts.hiddenOwnerDetail(OTHER_ACCOUNT.login, ACCOUNT.login) },
      ControllerTexts.signInAs(OTHER_ACCOUNT.login),
      ControllerTexts.newDevspaceAs(ACCOUNT.login),
    ]);

    // New Devspace as octo: the own devspace of the account; the devspace of the other account stays.
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(ControllerTexts.newDevspaceAs(ACCOUNT.login));
    await run('start', row('acme/api'));
    expect(h.service.openInWorker).toHaveBeenCalledWith(expect.objectContaining({ repository: 'acme/api' }), expect.objectContaining({ account: ACCOUNT }));
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    expect(h.service.deleteInWorker).not.toHaveBeenCalled();
    expect(h.connection.open).toHaveBeenCalledWith(own.containerName, '/workspaces/api');
  });

  it('Try again after New Devspace as <login> keeps that account and asks no second time (rule 2)', async () => {
    await h.registry.add(devspace({ owner: OTHER_ACCOUNT }));
    const own = devspace({ id: 'c1d2e3f4-0000-4000-8000-000000000003', containerName: 'devspaces-octo-api-c1d2e3f4' });
    h.service.openInWorker.mockImplementation(async () => {
      await h.registry.add(own);
      return openResult(own);
    });
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(ControllerTexts.newDevspaceAs(ACCOUNT.login));
    h.service.openInWorker.mockRejectedValueOnce(new UserFacingError('buildFailed', Messages.buildFailed, 'log'));
    fakeVscode.window.showErrorMessage.mockResolvedValueOnce(Actions.tryAgain);
    await run('start', row('acme/api'));
    await settle(() => h.connection.open.mock.calls.length === 1, 'the connection after Try again');
    expect(h.service.openInWorker.mock.calls.map((call) => call[1])).toEqual([expect.objectContaining({ account: ACCOUNT }), expect.objectContaining({ account: ACCOUNT })]);
    expect(warningMessages()).toEqual([ControllerTexts.hiddenOwnerQuestion('acme/api', OTHER_ACCOUNT.login)]);
  });

  it.each<[string, boolean]>([
    ['a repository row', false],
    ['a row that names the devspace', true],
  ])('Try again after an account change: %s', async (_name, named) => {
    await h.registry.add(devspace());
    h.service.openDevspaceInWorker.mockRejectedValueOnce(new UserFacingError('buildFailed', Messages.buildFailed, 'log'));
    // The user signs in with another account while the error shows, then presses Try again; a repository asks about the
    // devspace of the account before (rule 2), and the user creates one of the new account.
    fakeVscode.window.showErrorMessage.mockImplementationOnce(async () => {
      h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
      if (!named) fakeVscode.window.showWarningMessage.mockResolvedValueOnce(ControllerTexts.newDevspaceAs(OTHER_ACCOUNT.login));
      return Actions.tryAgain;
    });
    const own = devspace({ id: 'c1d2e3f4-0000-4000-8000-000000000003', containerName: 'devspaces-acme-api-c1d2e3f4', owner: OTHER_ACCOUNT });
    h.service.openInWorker.mockImplementation(async () => {
      await h.registry.add(own);
      return openResult(own);
    });
    await run('start', named ? row('acme/api', devspace()) : row('acme/api'));
    if (named) {
      // A devspace that the command named stays that devspace (the service refuses it: another account).
      await settle(() => h.service.openDevspaceInWorker.mock.calls.length === 2, 'the second open');
      expect(h.service.openDevspaceInWorker.mock.calls.map((call) => call[0])).toEqual([ENV_ID, ENV_ID]);
      expect(h.service.openInWorker).not.toHaveBeenCalled();
    } else {
      // A repository gets the devspace of the account that is signed in now: its first open.
      await settle(() => h.connection.open.mock.calls.length === 1, 'the connection of the other account');
      expect(h.service.openInWorker).toHaveBeenCalledWith(expect.objectContaining({ repository: 'acme/api' }), expect.anything());
      expect(h.connection.open).toHaveBeenCalledWith(own.containerName, '/workspaces/api');
      expect(warningMessages()).toEqual([ControllerTexts.hiddenOwnerQuestion('acme/api', ACCOUNT.login)]);
      expect(h.service.openDevspaceInWorker).toHaveBeenCalledTimes(1);
    }
  });

  it('Try again of a named devspace (the status bar item) keeps that devspace, also twice and after an account change', async () => {
    await h.registry.add(devspace());
    h.service.openDevspaceInWorker.mockRejectedValue(new UserFacingError('buildFailed', Messages.buildFailed, 'log'));
    let answers = 0;
    fakeVscode.window.showErrorMessage.mockImplementation(async () => {
      answers++;
      if (answers === 1) h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
      return answers <= 2 ? Actions.tryAgain : undefined;
    });
    await run('start', { devspaceId: ENV_ID });
    await settle(() => h.service.openDevspaceInWorker.mock.calls.length === 3, 'the second Try again');
    expect(h.service.openDevspaceInWorker.mock.calls.map((call) => call[0])).toEqual([ENV_ID, ENV_ID, ENV_ID]);
    expect(h.service.openInWorker).not.toHaveBeenCalled();
  });

  it('asks for a sign-in for a devspace when nobody is signed in', async () => {
    await h.registry.add(devspace());
    h.auth.getAccount.mockResolvedValue(undefined);
    await run('start', row('acme/api', devspace()));
    expect(warningMessages()).toEqual([Messages.signInRequired]);
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
  });

  it('lists only the devspaces of the account in the pickers', async () => {
    await h.registry.add(devspace({ owner: OTHER_ACCOUNT }));
    await run('stop');
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(ControllerTexts.noDevspaces);
    expect(fakeVscode.window.showQuickPick).not.toHaveBeenCalled();
    await run('switchDevspace');
    expect(fakeVscode.window.showInformationMessage).toHaveBeenLastCalledWith(ControllerTexts.noRepositories);
  });

  it('role A: a restored window of another account runs no pipeline and closes its connection', async () => {
    const env = devspace({ owner: OTHER_ACCOUNT });
    await h.registry.add(env);
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length > 0, 'the close of the connection');
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    expect(h.coordinator.setDevspace).toHaveBeenCalledWith(null);
    expect(warningMessages()).toEqual([Messages.otherAccountConnection('acme/api')]);
    expect(h.statusBar.showNotConnected).toHaveBeenCalled();
  });

  // The close reloads the window and ends this extension host, and with it a removal of the token that has not ended.
  it('role A: a restored window of another account closes its connection only after the token left the container', async () => {
    const env = devspace({ owner: OTHER_ACCOUNT });
    await h.registry.add(env);
    let answer: (value: unknown) => void = () => {};
    h.flow.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const opened = h.controller.openAttachedWindow(env, CONTAINER, undefined);
    await settle(() => tokenRemovals() > 0, 'the removal of the token');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
    answer({ outcome: 'removed', container: 'c0ffeec0ffee' });
    await opened;
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length > 0, 'the close of the connection');
    expect(h.logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('is not removed from the container'));
  });

  it('role A: a restored window of another account closes its connection when the removal of the token takes too long', async () => {
    recreateHarness({ tokenRemoveWaitMs: 20 });
    const env = devspace({ owner: OTHER_ACCOUNT });
    await h.registry.add(env);
    h.flow.mockImplementationOnce(() => new Promise(() => {}));
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length > 0, 'the close of the connection');
    expect(h.logger.warn).toHaveBeenCalledWith(
      `The GitHub token is not removed from the container ${CONTAINER} yet. The window closes its remote connection without waiting longer.`,
    );
  });

  it('role A: a restored window leaves when its open pipeline refuses the devspace after an account change', async () => {
    const env = devspace();
    await h.registry.add(env);
    // The account changes while the pipeline runs; the session event is not handled yet when the pipeline fails.
    h.service.openDevspaceInWorker.mockImplementationOnce(async () => {
      h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
      throw new UserFacingError('otherAccount', Messages.otherAccount('acme/api'));
    });
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length > 0, 'the close of the connection');
    await settle(() => tokenRemovals() > 0, 'the removal of the token');
    expect(h.flow).toHaveBeenCalledWith(OP_TOKEN_REMOVE, { devspaceId: env.id, containerName: CONTAINER }, { timeoutMs: 60_000 });
    expect(h.statusBar.showConnectionLost).not.toHaveBeenCalled();
  });

  // A window whose container the registry did not know at activation takes its devspace also when the registry was
  // restored already, or the restore added nothing.
  it('adopt: the window takes its restored devspace when the registry was restored already', async () => {
    const env = devspace();
    h.connection.currentContainerName.mockReturnValue(CONTAINER);
    h.docker.findContainer.mockResolvedValue(containerInfo(String(CONTAINER_VERSION)));
    await h.registry.add(env);
    await h.controller.reconcileIfRegistryLost({ passive: true });
    expect(h.coordinator.setDevspace).not.toHaveBeenCalled();
    await h.controller.reconcileIfRegistryLost({ passive: true, adopt: true });
    expect(h.service.reconcileInWorker).not.toHaveBeenCalled();
    expect(h.coordinator.setDevspace).toHaveBeenCalledWith(env.id);
  });

  it('adopt: the window takes its devspace when the restore added none (another window restored it)', async () => {
    const env = devspace();
    h.connection.currentContainerName.mockReturnValue(CONTAINER);
    h.docker.findContainer.mockResolvedValue(containerInfo(String(CONTAINER_VERSION)));
    fs.rmSync(h.paths.registry, { force: true });
    h.service.reconcileInWorker.mockImplementation(async () => {
      await h.registry.add(env);
      return 0;
    });
    await h.controller.reconcileIfRegistryLost({ passive: false, adopt: true });
    expect(h.service.reconcileInWorker).toHaveBeenCalledWith({ passive: false });
    expect(h.coordinator.setDevspace).toHaveBeenCalledWith(env.id);
  });

  // One adoption at a time, once per window, never in a window of role A.
  it('two restores at the same time adopt the window once', async () => {
    const env = devspace();
    h.connection.currentContainerName.mockReturnValue(CONTAINER);
    h.docker.findContainer.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return containerInfo(String(CONTAINER_VERSION));
    });
    await h.registry.add(env);
    await Promise.all([h.controller.reconcileIfRegistryLost({ passive: true, adopt: true }), h.controller.reconcileIfRegistryLost({ passive: false, adopt: true })]);
    expect(h.coordinator.setDevspace.mock.calls.filter(([id]) => id === env.id)).toHaveLength(1);
  });

  it('a window that left the devspace of another account after a restore does not leave it again', async () => {
    const env = devspace({ owner: OTHER_ACCOUNT });
    h.connection.currentContainerName.mockReturnValue(CONTAINER);
    await h.registry.add(env);
    await h.controller.reconcileIfRegistryLost({ passive: true, adopt: true });
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length > 0, 'the close of the connection');
    await h.controller.reconcileIfRegistryLost({ passive: false, adopt: true });
    expect(warningMessages()).toEqual([Messages.otherAccountConnection('acme/api')]);
    expect(h.connection.closeRemoteConnection).toHaveBeenCalledTimes(1);
  });

  it('a window of role A is never adopted by a restore', async () => {
    const env = devspace({ owner: OTHER_ACCOUNT });
    h.connection.currentContainerName.mockReturnValue(CONTAINER);
    await h.registry.add(env);
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length > 0, 'the close of the connection');
    fs.rmSync(h.paths.registry, { force: true });
    h.service.reconcileInWorker.mockImplementation(async () => {
      await h.registry.add(env);
      return 1;
    });
    await h.controller.reconcileIfRegistryLost({ passive: false });
    expect(warningMessages()).toEqual([Messages.otherAccountConnection('acme/api')]);
    expect(h.connection.closeRemoteConnection).toHaveBeenCalledTimes(1);
  });

  it('role A: a window adopted after a restore of the registry leaves when the account changed during its checks', async () => {
    const env = devspace();
    h.connection.currentContainerName.mockReturnValue(CONTAINER);
    // registry.json is missing; the restore adds the entry of this window.
    fs.rmSync(h.paths.registry, { force: true });
    h.service.reconcileInWorker.mockImplementation(async () => {
      await h.registry.add(env);
      return 1;
    });
    // OTHER_ACCOUNT signs in while the window checks the version of the container.
    h.docker.findContainer.mockImplementation(async () => {
      h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
      await h.controller.onSessionChanged();
      return containerInfo(String(CONTAINER_VERSION));
    });
    await h.controller.reconcileIfRegistryLost();
    // In the background, the worker is made ready passively.
    expect(h.service.reconcileInWorker).toHaveBeenCalledWith({ passive: true });
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length > 0, 'the close of the connection');
    expect(warningMessages()).toEqual([Messages.otherAccountConnection('acme/api')]);
    await settle(() => tokenRemovals() > 0, 'the removal of the token');
    expect(h.flow).toHaveBeenCalledWith(OP_TOKEN_REMOVE, { devspaceId: env.id, containerName: CONTAINER }, { timeoutMs: 60_000 });
  });

  it('role A: without a sign-in, the window closes its connection', async () => {
    const env = devspace();
    await h.registry.add(env);
    h.auth.getAccount.mockResolvedValue(undefined);
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length > 0, 'the close of the connection');
    // The sign-in of the owner of the devspace.
    expect(h.auth.getAccount).toHaveBeenCalledWith({ interactive: true, account: ACCOUNT });
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    expect(warningMessages()).toEqual([ControllerTexts.signedOutConnection('acme/api')]);
  });

  it('closes the connection at once when the signed-in account changes to one that may not use the devspace', async () => {
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    await h.controller.onSessionChanged();
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();

    h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
    await h.controller.onSessionChanged();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length > 0, 'the close of the connection');
    expect(h.coordinator.setDevspace).toHaveBeenLastCalledWith(null);
    expect(warningMessages()).toContain(Messages.otherAccountConnection('acme/api'));
    // The window has no devspace anymore: the Monitor stops the container after the waiting time.
    await run('stop');
    expect(h.service.stop).not.toHaveBeenCalled();
  });

  it('role B: runs no pending operation of another account, and does not reopen its devspace', async () => {
    await h.registry.add(devspace({ owner: OTHER_ACCOUNT }));
    await h.sessionFiles.writeOperation({
      devspaceId: ENV_ID,
      operation: 'delete',
      requestedAt: iso(NOW - 5000),
      requestedBy: 'old-window',
      reason: 'manual',
    });
    h.connection.isEmptyWindow.mockReturnValue(true);
    await h.controller.runEmptyWindowTasks();
    expect(h.service.deleteInWorker).not.toHaveBeenCalled();
    // The operation stays until it expires (10 minutes), like an operation that no window takes.
    expect(fs.readdirSync(h.paths.operationsDir)).toEqual([`${ENV_ID}.json`]);

    await h.sessionFiles.removeOperation(ENV_ID);
    h.sessionFiles.writeReopenSync({ devspaceId: ENV_ID, closedAt: iso(NOW - 60_000) });
    await h.controller.runEmptyWindowTasks();
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
  });

  it('closes the connection with a sign-in message when nobody is signed in anymore', async () => {
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    h.auth.getAccount.mockResolvedValue(undefined);
    await h.controller.onSessionChanged();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length > 0, 'the close of the connection');
    expect(h.coordinator.setDevspace).toHaveBeenLastCalledWith(null);
    expect(warningMessages()).toEqual([ControllerTexts.signedOutConnection('acme/api')]);
    expect(warningMessages()).not.toContain(Messages.otherAccountConnection('acme/api'));
  });

  it('takes the token of the owner out of the container when the account changes, not on a hand-off', async () => {
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    await run('stop', row('acme/api', env));
    expect(h.connection.closeRemoteConnection).toHaveBeenCalledTimes(1);
    expect(tokenRemovals()).toBe(0);

    recreateHarness({});
    await h.registry.add(env);
    await connectHere(env);
    h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
    await h.controller.onSessionChanged();
    await settle(() => tokenRemovals() > 0, 'the removal of the token');
    expect(h.flow).toHaveBeenCalledWith(OP_TOKEN_REMOVE, { devspaceId: env.id, containerName: CONTAINER }, { timeoutMs: 60_000 });
  });

  // The token is only in the memory of the dev container; nothing is removed from the volume. The removal is a flow of
  // the worker (the flow itself: src/core/worker/tokenRemoveFlow.test.ts); the controller sends it and logs what it
  // answered.
  describe('the removal of the token from the running container', () => {
    const VOLUME = 'devspaces-acme-api-volume';

    async function takeTokenOut(): Promise<void> {
      const env = devspace({ owner: OTHER_ACCOUNT, volumeName: VOLUME });
      await h.registry.add(env);
      await h.controller.openAttachedWindow(env, CONTAINER, undefined);
      await settle(() => tokenRemovals() > 0, 'the removal of the token');
    }

    it('sends the flow to the worker of the engine, with the devspace and the container', async () => {
      await takeTokenOut();
      expect(h.flow).toHaveBeenCalledTimes(1);
      // The removal is bounded.
      expect(h.flow).toHaveBeenCalledWith(OP_TOKEN_REMOVE, { devspaceId: ENV_ID, containerName: CONTAINER }, { timeoutMs: 60_000 });
      expect(h.docker.exec).not.toHaveBeenCalled();
      expect(h.logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('GitHub token could not be removed'));
    });

    it('warns when the flow fails, and when it answers with an invalid value', async () => {
      h.flow.mockRejectedValueOnce(new Error('/run/devspace/github-token could not be removed.'));
      await takeTokenOut();
      expect(h.logger.warn).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`^The GitHub token could not be removed from the container ${CONTAINER}: .*github-token could not be removed`)),
      );
      recreateHarness({});
      h.flow.mockResolvedValueOnce({ outcome: 'maybe' });
      await takeTokenOut();
      expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining('answered the token removal with an invalid value'));
    });

    it('takes `notRunning` as an answer, without a warning', async () => {
      h.flow.mockResolvedValueOnce({ outcome: 'notRunning' });
      await takeTokenOut();
      expect(h.logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('GitHub token could not be removed'));
    });

    it('runs no flow on another Docker host', async () => {
      recreateHarness({
        dockerTargets: {
          current: async () => ({ kind: 'remote', host: 'build-box', endpoint: 'ssh://build-box' }),
          resolve: async () => ({ kind: 'remote', host: 'build-box', endpoint: 'ssh://build-box' }),
          withOperation: async (_target: unknown, run: () => Promise<unknown>) => run(),
        } as unknown as NonNullable<Parameters<typeof createHarness>[0]>['dockerTargets'],
      });
      const env = devspace({ owner: OTHER_ACCOUNT, volumeName: VOLUME });
      await h.registry.add(env);
      await h.controller.openAttachedWindow(env, CONTAINER, undefined);
      await settle(() => h.logger.info.mock.calls.some((call) => String(call[0]).includes('is on another Docker host')), 'the log line');
      expect(h.flow).not.toHaveBeenCalled();
    });
  });

  it('closes the connection again when the window kept it after an account change (Cancel on unsaved files)', async () => {
    recreateHarness({ leaveCheckMs: 20 });
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    // This extension host still runs after the close: the window is still attached to the container.
    h.connection.currentContainerName.mockReturnValue(CONTAINER);
    h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
    await h.controller.onSessionChanged();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length >= 2, 'the second close');
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledWith(ControllerTexts.stillConnected('acme/api'), { modal: true }, {
      title: ControllerTexts.closeConnection,
      isCloseAffordance: true,
    });
    // The token is taken out again with each close.
    await settle(() => tokenRemovals() >= 2, 'the second removal of the token');
    expect(h.connection.open).not.toHaveBeenCalled();
  });

  it('waits for the removal of the token also before the second close', async () => {
    recreateHarness({ leaveCheckMs: 20 });
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    h.connection.currentContainerName.mockReturnValue(CONTAINER);
    h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
    await h.controller.onSessionChanged();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the first close');
    let answer: (value: unknown) => void = () => {};
    h.flow.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    await settle(() => tokenRemovals() >= 2, 'the second removal of the token');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.connection.closeRemoteConnection).toHaveBeenCalledTimes(1);
    answer({ outcome: 'removed', container: 'c0ffeec0ffee' });
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length >= 2, 'the second close');
  });

  it('does not end a Start in this window that began while the token is removed for the second close', async () => {
    recreateHarness({ leaveCheckMs: 20 });
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    const other = devspace({
      id: 'b1c2d3e4-0000-4000-8000-000000000002',
      repository: 'acme/web',
      containerName: 'web',
      volumeName: 'web',
      remoteWorkspaceFolder: '/workspaces/web',
      owner: OTHER_ACCOUNT,
    });
    await h.registry.add(other);
    h.connection.currentContainerName.mockReturnValue(CONTAINER);
    h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
    await h.controller.onSessionChanged();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the first close');
    let answer: (value: unknown) => void = () => {};
    h.flow.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    await settle(() => tokenRemovals() >= 2, 'the second removal of the token');
    const pipeline = deferred<OpenResult>();
    h.service.openDevspaceInWorker.mockImplementation(async () => pipeline.promise);
    const started = run('startInCurrentWindow', row('acme/web', other));
    await settle(() => h.service.openDevspaceInWorker.mock.calls.length > 0, 'the open pipeline of the Start');
    answer({ outcome: 'removed', container: 'c0ffeec0ffee' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(h.connection.closeRemoteConnection).toHaveBeenCalledTimes(1);
    pipeline.resolve(openResult(other));
    await started;
    expect(h.connection.open).toHaveBeenCalled();
  });

  it('does not close the connection when the owner account signs in again while the token is removed', async () => {
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    h.connection.currentContainerName.mockReturnValue(CONTAINER);
    let answer: (value: unknown) => void = () => {};
    h.flow.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
    const left = h.controller.onSessionChanged();
    await settle(() => tokenRemovals() > 0, 'the removal of the token');
    h.auth.getAccount.mockResolvedValue(ACCOUNT);
    await h.controller.onSessionChanged();
    // The window reloads to open the devspace again (reopenLeftDevspace).
    expect(h.connection.open).toHaveBeenCalledTimes(1);
    answer({ outcome: 'removed', container: 'c0ffeec0ffee' });
    await left;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
  });

  it('does not end a Start in this window that began while the token is removed', async () => {
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    const other = devspace({
      id: 'b1c2d3e4-0000-4000-8000-000000000002',
      repository: 'acme/web',
      containerName: 'web',
      volumeName: 'web',
      remoteWorkspaceFolder: '/workspaces/web',
      owner: OTHER_ACCOUNT,
    });
    await h.registry.add(other);
    let answer: (value: unknown) => void = () => {};
    h.flow.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
    const left = h.controller.onSessionChanged();
    await settle(() => tokenRemovals() > 0, 'the removal of the token');
    const pipeline = deferred<OpenResult>();
    h.service.openDevspaceInWorker.mockImplementation(async () => pipeline.promise);
    const started = run('startInCurrentWindow', row('acme/web', other));
    await settle(() => h.service.openDevspaceInWorker.mock.calls.length > 0, 'the open pipeline of the Start');
    answer({ outcome: 'removed', container: 'c0ffeec0ffee' });
    await left;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
    pipeline.resolve(openResult(other));
    await started;
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
    expect(h.connection.open).toHaveBeenCalled();
  });

  it('role A: closes the connection again when a restored window of another account kept it', async () => {
    recreateHarness({ leaveCheckMs: 20 });
    const env = devspace({ owner: OTHER_ACCOUNT });
    await h.registry.add(env);
    h.connection.currentContainerName.mockReturnValue(CONTAINER);
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length >= 2, 'the second close');
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledWith(ControllerTexts.stillConnected('acme/api'), { modal: true }, {
      title: ControllerTexts.closeConnection,
      isCloseAffordance: true,
    });
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
  });

  it('does not close the connection again when the window has left the container, or after dispose', async () => {
    recreateHarness({ leaveCheckMs: 20 });
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
    // currentContainerName gives no container: the window is not attached anymore.
    await h.controller.onSessionChanged();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
    await pause(80);
    expect(h.connection.closeRemoteConnection).toHaveBeenCalledTimes(1);
    expect(warningMessages()).not.toContain(ControllerTexts.stillConnected('acme/api'));

    recreateHarness({ leaveCheckMs: 20 });
    await h.registry.add(env);
    await connectHere(env);
    h.connection.currentContainerName.mockReturnValue(CONTAINER);
    h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
    await h.controller.onSessionChanged();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
    h.controller.dispose();
    await pause(80);
    expect(h.connection.closeRemoteConnection).toHaveBeenCalledTimes(1);
  });

  it('reloads the window instead of closing it again when the owner account signs in again before the check', async () => {
    recreateHarness({ leaveCheckMs: 100 });
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    h.connection.currentContainerName.mockReturnValue(CONTAINER);
    h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
    await h.controller.onSessionChanged();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
    // The user kept the connection, then signed in with the owner account again.
    h.auth.getAccount.mockResolvedValue(ACCOUNT);
    await h.controller.onSessionChanged();
    // The reload runs the open pipeline of role A, which writes the token again.
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
    await pause(150);
    expect(h.connection.closeRemoteConnection).toHaveBeenCalledTimes(1);
    expect(warningMessages()).not.toContain(ControllerTexts.stillConnected('acme/api'));
  });

  it('reloads the window at the check when the owner account is signed in again', async () => {
    recreateHarness({ leaveCheckMs: 100 });
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    h.connection.currentContainerName.mockReturnValue(CONTAINER);
    h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
    await h.controller.onSessionChanged();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
    h.auth.getAccount.mockResolvedValue(ACCOUNT);
    await settle(() => h.connection.open.mock.calls.length === 1, 'the reload');
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
    expect(h.connection.closeRemoteConnection).toHaveBeenCalledTimes(1);
  });

  it('does not connect when the account changed while the pipeline ran', async () => {
    const env = devspace();
    await h.registry.add(env);
    const pipeline = deferred<OpenResult>();
    h.service.openDevspaceInWorker.mockImplementationOnce(async (id: string) => {
      await h.sessionFiles.writePending(id, WINDOW_ID);
      return pipeline.promise;
    });
    const start = run('start', row('acme/api', env));
    await settle(() => h.service.openDevspaceInWorker.mock.calls.length === 1, 'the pipeline');
    h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
    pipeline.resolve(openResult(env));
    await start;
    expect(h.connection.open).not.toHaveBeenCalled();
    expect(h.coordinator.writePending).not.toHaveBeenCalled();
    // Without the pending connection file, the Monitor stops the container after the waiting time.
    expect(await h.sessionFiles.readPendings()).toEqual([]);
    expect(warningMessages()).toEqual([Messages.otherAccount('acme/api', ACCOUNT.login)]);
  });

  it('does not connect a first open when the account changed while the pipeline ran', async () => {
    const info = repositoryInfo('acme/api');
    h.sidebar.infos.set('acme/api', info);
    const pipeline = deferred<OpenResult>();
    h.service.openInWorker.mockImplementationOnce(async () => {
      await h.registry.add(devspace());
      return pipeline.promise;
    });
    const start = run('start', row('acme/api', undefined, info));
    await settle(() => h.service.openInWorker.mock.calls.length === 1, 'the pipeline');
    h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
    pipeline.resolve(openResult(devspace()));
    await start;
    expect(h.connection.open).not.toHaveBeenCalled();
    expect(warningMessages()).toEqual([Messages.otherAccount('acme/api', ACCOUNT.login)]);
  });

  it('does not connect when nobody is signed in anymore at the end of the pipeline', async () => {
    const env = devspace();
    await h.registry.add(env);
    const pipeline = deferred<OpenResult>();
    h.service.openDevspaceInWorker.mockReturnValueOnce(pipeline.promise);
    const start = run('start', row('acme/api', env));
    await settle(() => h.service.openDevspaceInWorker.mock.calls.length === 1, 'the pipeline');
    h.auth.getAccount.mockResolvedValue(undefined);
    pipeline.resolve(openResult(env));
    await start;
    expect(h.connection.open).not.toHaveBeenCalled();
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledWith(Messages.signInRequired, Actions.signIn);
  });

  it('role B: does not connect after a pending rebuild when the account changed while it ran', async () => {
    await h.registry.add(devspace());
    await h.sessionFiles.writeOperation({
      devspaceId: ENV_ID,
      operation: 'rebuild',
      requestedAt: iso(NOW - 5000),
      requestedBy: 'old-window',
      reason: 'manual',
    });
    h.connection.isEmptyWindow.mockReturnValue(true);
    const pipeline = deferred<OpenResult>();
    h.service.openDevspaceInWorker.mockReturnValueOnce(pipeline.promise);
    const tasks = h.controller.runEmptyWindowTasks();
    await settle(() => h.service.openDevspaceInWorker.mock.calls.length === 1, 'the pipeline');
    h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
    pipeline.resolve(openResult(devspace()));
    await tasks;
    expect(h.connection.open).not.toHaveBeenCalled();
    expect(warningMessages()).toEqual([Messages.otherAccount('acme/api', ACCOUNT.login)]);
  });

  describe('a repository command while GitHub rejects the token of the account', () => {
    // The rejected session still names ACCOUNT (auth.ts: getAccount asks for no new sign-in). Only the pipeline asks
    // for a new sign-in, of the account of the devspace (auth.ts renewToken refuses another account), so a repository
    // command never switches to the devspace of another account.
    beforeEach(async () => {
      await h.registry.add(devspace());
      h.auth.isSignedIn.mockResolvedValue(false);
      h.auth.getSession.mockImplementation(async () => ({ token: 'gho_rejected', account: ACCOUNT }));
      h.auth.getToken.mockResolvedValue('gho_rejected');
    });
    const noSignInOfAnotherAccount = (): void => {
      for (const call of [...h.auth.getSession.mock.calls, ...h.auth.getToken.mock.calls, ...h.auth.getAccount.mock.calls]) {
        const options = call[0] as { interactive?: boolean; account?: GitHubAccount } | undefined;
        if (options?.interactive) expect(options.account).toEqual(ACCOUNT);
      }
      expect(h.auth.addAccount).not.toHaveBeenCalled();
    };

    it('Start of the repository opens the devspace of the account', async () => {
      await run('start', row('acme/api'));
      expect(h.service.openDevspaceInWorker).toHaveBeenCalledWith(ENV_ID, expect.anything());
      expect(h.service.openInWorker).not.toHaveBeenCalled();
      noSignInOfAnotherAccount();
    });

    it('Search does the same', async () => {
      h.sidebar.infos.set('acme/api', repositoryInfo('acme/api'));
      fakeVscode.window.showQuickPick.mockImplementationOnce(async (items: Array<{ repository: RepositoryInfo }>) => items[0]);
      await run('search');
      expect(h.service.openDevspaceInWorker).toHaveBeenCalledWith(ENV_ID, expect.anything());
      expect(h.service.openInWorker).not.toHaveBeenCalled();
      noSignInOfAnotherAccount();
    });

    it('the repository choice of the switcher does the same', async () => {
      h.sidebar.infos.set('acme/api', repositoryInfo('acme/api'));
      fakeVscode.window.showQuickPick.mockImplementation(
        async (items: Array<{ choice?: { kind: string }; repository?: RepositoryInfo }>) =>
          items.find((item) => item.choice?.kind === 'openRepository') ?? items.find((item) => item.repository?.nameWithOwner === 'acme/api'),
      );
      await run('switchDevspace');
      expect(h.service.openDevspaceInWorker).toHaveBeenCalledWith(ENV_ID, expect.anything());
      expect(h.service.openInWorker).not.toHaveBeenCalled();
      noSignInOfAnotherAccount();
    });

    it('Start on the child row of a configuration creates the devspace of the account with that configuration', async () => {
      h.sidebar.infos.set('acme/api', repositoryInfo('acme/api', { configPaths: ['.devcontainer/devcontainer.json', '.devcontainer/python/devcontainer.json'] }));
      await run('start', row('acme/api', undefined, undefined, PYTHON_SOURCE));
      expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
      expect(h.service.openInWorker).toHaveBeenCalledWith(expect.objectContaining({ repository: 'acme/api' }), expect.objectContaining({ source: PYTHON_SOURCE, account: ACCOUNT }));
      noSignInOfAnotherAccount();
    });

    it('Try again of a Start that failed opens the devspace of the account again', async () => {
      h.service.openDevspaceInWorker.mockRejectedValueOnce(new UserFacingError('buildFailed', Messages.buildFailed, 'log'));
      fakeVscode.window.showErrorMessage.mockResolvedValueOnce(Actions.tryAgain);
      h.sidebar.infos.set('acme/api', repositoryInfo('acme/api'));
      fakeVscode.window.showQuickPick.mockImplementationOnce(async (items: Array<{ repository: RepositoryInfo }>) => items[0]);
      await run('search');
      await settle(() => h.service.openDevspaceInWorker.mock.calls.length === 2, 'Try again');
      expect(h.service.openDevspaceInWorker.mock.calls.map((call) => call[0])).toEqual([ENV_ID, ENV_ID]);
      expect(h.service.openInWorker).not.toHaveBeenCalled();
      noSignInOfAnotherAccount();
    });

    it('Stop of the repository asks for no new sign-in (it needs no token)', async () => {
      await run('stop', row('acme/api'));
      expect(h.auth.getSession).not.toHaveBeenCalledWith(expect.objectContaining({ interactive: true }));
      expect(h.auth.getToken).not.toHaveBeenCalledWith(expect.objectContaining({ interactive: true }));
    });
  });

  describe('Try again of a first open of a child row after the account changed', () => {
    const OTHER_ENV = () =>
      devspace({ id: OTHER_ENV_ID, owner: OTHER_ACCOUNT, containerName: 'devspaces-acme-api-7c1d2e3f', volumeName: 'devspaces-acme-api-7c1d2e3f' });

    beforeEach(async () => {
      // ACCOUNT has no devspace of acme/api; OTHER_ACCOUNT has one of the configuration at the root.
      await h.registry.add(OTHER_ENV());
      h.sidebar.infos.set('acme/api', repositoryInfo('acme/api', { configPaths: ['.devcontainer/devcontainer.json', '.devcontainer/python/devcontainer.json'] }));
      h.service.openInWorker.mockRejectedValueOnce(new UserFacingError('buildFailed', Messages.buildFailed, 'log'));
      // While the message shows, OTHER_ACCOUNT signs in; then the user selects Try again.
      fakeVscode.window.showErrorMessage.mockImplementationOnce(async () => {
        h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
        h.auth.getToken.mockResolvedValue('gho_other');
        return Actions.tryAgain;
      });
    });

    it('opens the devspace of the account signed in now when it has one of that source', async () => {
      // The first Start asks about the devspace of OTHER_ACCOUNT (rule 2); the user creates one of ACCOUNT.
      fakeVscode.window.showWarningMessage.mockResolvedValueOnce(ControllerTexts.newDevspaceAs(ACCOUNT.login));
      await run('start', row('acme/api', undefined, undefined, ROOT_SOURCE));
      await settle(() => h.service.openDevspaceInWorker.mock.calls.length === 1, 'Try again');
      expect(h.service.openInWorker).toHaveBeenCalledTimes(1);
      expect(h.service.openDevspaceInWorker).toHaveBeenCalledWith(OTHER_ENV_ID, expect.objectContaining({ source: ROOT_SOURCE }));
    });

    it('creates the devspace of the account signed in now for a source it has no devspace of', async () => {
      await run('start', row('acme/api', undefined, undefined, PYTHON_SOURCE));
      await settle(() => h.service.openInWorker.mock.calls.length === 2, 'Try again');
      expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
      expect(h.service.openInWorker).toHaveBeenLastCalledWith(expect.objectContaining({ repository: 'acme/api' }), expect.objectContaining({ source: PYTHON_SOURCE }));
    });
  });

  it('offers no Try again of the command itself for an error', async () => {
    // Refresh has no Try again of its own: a failure reaches the error display of the command.
    h.sidebar.refreshDiscovery.mockRejectedValueOnce(new UserFacingError('helperFailed', Messages.helperFailed));
    await run('refresh');
    expect(fakeVscode.window.showErrorMessage.mock.calls).toEqual([[Messages.helperFailed, Actions.showDetails]]);
    expect(h.sidebar.refreshDiscovery).toHaveBeenCalledTimes(1);
  });
});

describe('the switch of the host access checks', () => {
  /** The user settings of the section devspace: `globalValue` of hostAccessChecksOff, and the writes. */
  function userSettings(globalValue?: unknown): { update: ReturnType<typeof vi.fn>; inspect: ReturnType<typeof vi.fn> } {
    const configuration = {
      inspect: vi.fn(() => ({ key: `${SETTINGS_SECTION}.hostAccessChecksOff`, globalValue, workspaceValue: ['acme/api'] })),
      update: vi.fn(async () => undefined),
    };
    fakeVscode.workspace.getConfiguration.mockReturnValue(configuration);
    return configuration;
  }

  it('Turn Off Host Access Checks… asks with a modal warning that names what becomes possible, then writes the user setting', async () => {
    const settings = userSettings(['me/dotfiles']);
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.turnOffChecks);
    await run('turnOffHostAccessChecks', row('acme/api'));
    expect(fakeVscode.window.showWarningMessage.mock.calls[0]).toEqual([
      Messages.hostAccessChecksOffConfirm('acme/api'),
      { modal: true, detail: Messages.hostAccessChecksOffDetail },
      Actions.turnOffChecks,
    ]);
    for (const possible of ['bind mounts', 'Docker socket', 'privileged mode', 'devices and GPUs', 'all network addresses', 'volumes of other programs']) {
      expect(Messages.hostAccessChecksOffDetail).toContain(possible);
    }
    expect(fakeVscode.workspace.getConfiguration).toHaveBeenCalledWith(SETTINGS_SECTION);
    // Only the user value counts (the workspace value is not copied).
    expect(settings.update).toHaveBeenCalledWith('hostAccessChecksOff', ['me/dotfiles', 'acme/api'], fakeVscode.ConfigurationTarget.Global);
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(Messages.hostAccessChecksTurnedOff('acme/api'));
  });

  it('Turn Off Host Access Checks… changes nothing when the warning is dismissed', async () => {
    const settings = userSettings(undefined);
    await run('turnOffHostAccessChecks', row('acme/api'));
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(settings.update).not.toHaveBeenCalled();
  });

  it('Turn Off Host Access Checks… asks nothing when the checks are off already', async () => {
    const settings = userSettings(['acme/api']);
    h.settings.hostAccessChecksOff = ['acme/api'];
    await run('turnOffHostAccessChecks', row('acme/api'));
    expect(fakeVscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(settings.update).not.toHaveBeenCalled();
  });

  it('Turn On Host Access Checks writes the user setting without a question', async () => {
    const settings = userSettings(['ACME/api', 'me/dotfiles']);
    h.settings.hostAccessChecksOff = ['ACME/api', 'me/dotfiles'];
    await run('turnOnHostAccessChecks', row('acme/api'));
    expect(fakeVscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(settings.update).toHaveBeenCalledWith('hostAccessChecksOff', ['me/dotfiles'], fakeVscode.ConfigurationTarget.Global);
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(Messages.hostAccessChecksTurnedOn('acme/api'));

    // The last entry: the user value is removed.
    const last = userSettings(['acme/api']);
    await run('turnOnHostAccessChecks', row('acme/api', devspace()));
    expect(last.update).toHaveBeenCalledWith('hostAccessChecksOff', undefined, fakeVscode.ConfigurationTarget.Global);
  });

  it('Turn On Host Access Checks removes every name of a renamed repository: the name on GitHub and the registry name', async () => {
    // alice/tool was transferred to bob/tool on GitHub: the row shows bob/tool, the registry (and the pipeline) keep alice/tool.
    const env = devspace({ repository: 'alice/tool' });
    await h.registry.add(env);
    const settings = userSettings(['alice/tool', 'me/dotfiles', 'Bob/Tool']);
    h.settings.hostAccessChecksOff = ['alice/tool', 'me/dotfiles', 'Bob/Tool'];
    await run('turnOnHostAccessChecks', row('bob/tool', env));
    expect(settings.update).toHaveBeenCalledWith('hostAccessChecksOff', ['me/dotfiles'], fakeVscode.ConfigurationTarget.Global);
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(Messages.hostAccessChecksTurnedOn('bob/tool'));

    // Only the registry name is listed: it is removed as well.
    const registryOnly = userSettings(['alice/tool']);
    await run('turnOnHostAccessChecks', row('bob/tool', env));
    expect(registryOnly.update).toHaveBeenCalledWith('hostAccessChecksOff', undefined, fakeVscode.ConfigurationTarget.Global);
  });

  it('Turn Off Host Access Checks… on a renamed repository writes the registry name, which the open pipeline reads, and the name on GitHub, which a first open of another source reads', async () => {
    const env = devspace({ repository: 'alice/tool' });
    await h.registry.add(env);
    const settings = userSettings(undefined);
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.turnOffChecks);
    await run('turnOffHostAccessChecks', row('bob/tool', env));
    expect(fakeVscode.window.showWarningMessage.mock.calls[0]?.[0]).toBe(Messages.hostAccessChecksOffConfirm('bob/tool'));
    expect(settings.update).toHaveBeenCalledWith('hostAccessChecksOff', ['bob/tool', 'alice/tool'], fakeVscode.ConfigurationTarget.Global);
  });

  it('Turn Off Host Access Checks… on a child row without devspace writes the registry name of the devspaces of the repository', async () => {
    // alice/tool was renamed to bob/tool; its `python` devspace keeps the old name. The `default` row has no devspace.
    const env = devspace({ repository: 'alice/tool', configPath: '.devcontainer/python/devcontainer.json' });
    await h.registry.add(env);
    h.sidebar.model = () =>
      [
        {
          kind: 'owner',
          children: [
            {
              kind: 'repositoryNode',
              children: [
                { kind: 'repository', repository: 'bob/tool', source: DEFAULT_SOURCE, child: true },
                { kind: 'repository', repository: 'bob/tool', source: PYTHON_SOURCE, child: true, devspace: env },
              ],
            },
          ],
        },
      ] as unknown as OwnerGroup[];
    const settings = userSettings(undefined);
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.turnOffChecks);
    await run('turnOffHostAccessChecks', row('bob/tool', undefined, undefined, DEFAULT_SOURCE));
    expect(fakeVscode.window.showWarningMessage.mock.calls[0]?.[0]).toBe(Messages.hostAccessChecksOffConfirm('bob/tool'));
    expect(settings.update).toHaveBeenCalledWith('hostAccessChecksOff', ['bob/tool', 'alice/tool'], fakeVscode.ConfigurationTarget.Global);
  });

  // "Already off" is decided under the pipeline key (the registry name) only; "either name" would answer "already off"
  // while the pipeline still has the checks on.
  it('Turn Off Host Access Checks… decides "already off" by the registry name of a renamed repository', async () => {
    const env = devspace({ repository: 'alice/tool' });
    await h.registry.add(env);
    let settings = userSettings(['alice/tool']);
    h.settings.hostAccessChecksOff = ['alice/tool'];
    await run('turnOffHostAccessChecks', row('bob/tool', env));
    expect(fakeVscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(settings.update).not.toHaveBeenCalled();

    // Only the GitHub name is listed: the pipeline has the checks on, so Turn Off asks and writes the registry name.
    settings = userSettings(['bob/tool']);
    h.settings.hostAccessChecksOff = ['bob/tool'];
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.turnOffChecks);
    await run('turnOffHostAccessChecks', row('bob/tool', env));
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(settings.update).toHaveBeenCalledTimes(1);
    expect(settings.update.mock.calls[0]?.[1]).toEqual(['bob/tool', 'alice/tool']);
  });

  it('needs a row: without an argument, nothing is written', async () => {
    const settings = userSettings(undefined);
    await run('turnOffHostAccessChecks');
    await run('turnOnHostAccessChecks');
    expect(settings.update).not.toHaveBeenCalled();
    expect(fakeVscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('offers the commands in the context menu of repository rows only by their flags, and not in the Command Palette', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: {
        menus: Record<string, Array<{ command?: string; when?: string }>>;
        configuration: { properties: Record<string, { scope?: string; default?: unknown }> };
      };
    };
    const menus = manifest.contributes.menus;
    const when = (menu: string, command: string) => menus[menu].filter((item) => item.command === command).map((item) => item.when);
    expect(when('view/item/context', Commands.turnOffHostAccessChecks)).toEqual(['view == devspaces.repositories && viewItem =~ /hostAccessChecked/']);
    expect(when('view/item/context', Commands.turnOnHostAccessChecks)).toEqual(['view == devspaces.repositories && viewItem =~ /hostAccessUnrestricted/']);
    expect(when('devspaces.more', Commands.turnOffHostAccessChecks)).toEqual(['viewItem =~ /hostAccessChecked/']);
    expect(when('devspaces.more', Commands.turnOnHostAccessChecks)).toEqual(['viewItem =~ /hostAccessUnrestricted/']);
    expect(when('commandPalette', Commands.turnOffHostAccessChecks)).toEqual(['false']);
    expect(when('commandPalette', Commands.turnOnHostAccessChecks)).toEqual(['false']);
    // A workspace or folder setting cannot turn a check off.
    expect(manifest.contributes.configuration.properties[`${SETTINGS_SECTION}.hostAccessChecksOff`]).toMatchObject({ scope: 'application', default: [] });
  });

  const unrestricted: ContainerInfo = {
    ...containerInfo(String(CONTAINER_VERSION)),
    labels: { [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION), 'nimblescape.devspaces.host-access': 'unrestricted' },
  };

  it('role A: closes the connection to a container of the checks-off time when the checks are on and the pipeline refused', async () => {
    const env = devspace();
    await h.registry.add(env);
    h.docker.findContainer.mockResolvedValue(unrestricted);
    h.service.openDevspaceInWorker.mockRejectedValueOnce(new UserFacingError('hostAccess', Messages.hostAccess('privileged mode')));
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
    expect(warningMessages()).toContain(ControllerTexts.unrestrictedContainerClosed('acme/api'));
    expect(warningMessages()).not.toContain(ControllerTexts.outdatedContainerClosed('acme/api'));
  });

  it('role A: keeps a container of the checks-off time while the checks stay off', async () => {
    h.settings.hostAccessChecksOff = ['acme/api'];
    const env = devspace();
    await h.registry.add(env);
    h.docker.findContainer.mockResolvedValue(unrestricted);
    h.service.openDevspaceInWorker.mockRejectedValueOnce(new UserFacingError('hostAccess', Messages.hostAccess('variable GH_TOKEN in containerEnv')));
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    expect(h.statusBar.showConnectionLost).toHaveBeenCalledWith('acme/api', ENV_ID);
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
  });
});

describe('Start in a new window', () => {
  const web = (): Devspace =>
    devspace({
      id: 'b1c2d3e4-0000-4000-8000-000000000002',
      repository: 'acme/web',
      containerName: 'web',
      volumeName: 'web',
      remoteWorkspaceFolder: '/workspaces/web',
    });

  it('Start in New Window runs the pipeline, writes the pending connection file of this window, and opens a new window', async () => {
    const env = devspace();
    await h.registry.add(env);
    await run('startInNewWindow', row('acme/api', env));
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledWith(ENV_ID, expect.anything());
    expect(h.coordinator.writePending).toHaveBeenCalledWith(ENV_ID);
    // The window that ran the pipeline wrote the pending connection file: the container is in use until the new window
    // has written its status file.
    expect(await h.sessionFiles.readPendings()).toEqual([{ devspaceId: ENV_ID, windowId: WINDOW_ID, createdAt: iso(NOW) }]);
    expect(h.connection.openInNewWindow).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
    expect(h.connection.open).not.toHaveBeenCalled();
  });

  it('keeps the devspace of this window: this window does not take the new devspace as its own', async () => {
    const own = devspace();
    await h.registry.add(own);
    await h.registry.add(web());
    await connectHere(own);
    h.coordinator.setDevspace.mockClear();
    h.statusBar.showConnected.mockClear();
    await run('startInNewWindow', row('acme/web', web()));
    expect(h.connection.openInNewWindow).toHaveBeenCalledWith('web', '/workspaces/web');
    expect(h.connection.open).not.toHaveBeenCalled();
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
    expect(h.coordinator.setDevspace).not.toHaveBeenCalled();
    expect(h.statusBar.showConnected).not.toHaveBeenCalled();
    // A later Start of the own devspace in this window still finds it connected here.
    await run('start', row('acme/api', own));
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(ControllerTexts.alreadyConnected('acme/api'));
  });

  it('opens a new repository (first open) in a new window', async () => {
    const info = repositoryInfo('acme/api');
    h.sidebar.infos.set('acme/api', info);
    h.service.openInWorker.mockImplementation(async () => {
      const env = devspace();
      await h.registry.add(env);
      return openResult(env);
    });
    await run('startInNewWindow', row('acme/api', undefined, info));
    expect(h.service.openInWorker).toHaveBeenCalledTimes(1);
    expect(h.connection.openInNewWindow).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
    expect(h.connection.open).not.toHaveBeenCalled();
  });

  it('opens a new window also from an empty window, because the user asked for it', async () => {
    await h.registry.add(devspace());
    h.connection.isEmptyWindow.mockReturnValue(true);
    await run('startInNewWindow', row('acme/api', devspace()));
    expect(h.connection.openInNewWindow).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
    expect(h.connection.open).not.toHaveBeenCalled();
  });

  it('plain Start uses this window by default', async () => {
    await h.registry.add(devspace());
    await run('start', row('acme/api', devspace()));
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
    expect(h.connection.openInNewWindow).not.toHaveBeenCalled();
  });

  it('with the setting openInNewWindow, plain Start opens a new window and Start in Current Window uses this one', async () => {
    h.settings.openInNewWindow = true;
    await h.registry.add(devspace());
    await h.registry.add(web());
    await run('start', row('acme/api', devspace()));
    expect(h.connection.openInNewWindow).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
    expect(h.connection.open).not.toHaveBeenCalled();
    await run('startInCurrentWindow', row('acme/web', web()));
    expect(h.connection.open).toHaveBeenCalledWith('web', '/workspaces/web');
    expect(h.connection.openInNewWindow).toHaveBeenCalledTimes(1);
  });

  it('with the setting openInNewWindow, plain Start in an empty window uses the empty window', async () => {
    h.settings.openInNewWindow = true;
    h.connection.isEmptyWindow.mockReturnValue(true);
    await h.registry.add(devspace());
    await run('start', row('acme/api', devspace()));
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
    expect(h.connection.openInNewWindow).not.toHaveBeenCalled();
  });

  it('shows the other window instead of a second connection when another window uses the devspace', async () => {
    const env = devspace();
    await h.registry.add(env);
    otherWindowConnected();
    await run('startInNewWindow', row('acme/api', env));
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    expect(h.coordinator.writePending).not.toHaveBeenCalled();
    // A request for a new window never uses the current window, also here. VS Code shows the window that has this
    // folder open; if it did not find it, a new window opens and this one stays.
    expect(h.connection.open).not.toHaveBeenCalled();
    expect(h.connection.openInNewWindow).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
  });

  it('shows the other window with the current-window call for plain Start', async () => {
    const env = devspace();
    await h.registry.add(env);
    otherWindowConnected();
    await run('start', row('acme/api', env));
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    expect(h.connection.openInNewWindow).not.toHaveBeenCalled();
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
  });

  it('opens no second window for the devspace of this window', async () => {
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    await run('startInNewWindow', row('acme/api', env));
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    expect(h.connection.openInNewWindow).not.toHaveBeenCalled();
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(ControllerTexts.alreadyConnected('acme/api'));
  });

  it('reconnects this window when its own container does not run, also with the setting openInNewWindow', async () => {
    h.settings.openInNewWindow = true;
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    h.docker.containerState.mockResolvedValue('stopped');
    pipelineStartsContainer(); // The window connects only to a running container.
    await run('startInNewWindow', { devspaceId: ENV_ID });
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledTimes(1);
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
    expect(h.connection.openInNewWindow).not.toHaveBeenCalled();
  });

  it('a new window neither skips nor is skipped by the connection of this window', async () => {
    await h.registry.add(devspace());
    await h.registry.add(web());
    const api = deferred<OpenResult>();
    h.service.openDevspaceInWorker.mockImplementation(async (id: string) => (id === ENV_ID ? api.promise : openResult(web())));
    const first = run('start', row('acme/api', devspace()));
    await settle(() => h.service.openDevspaceInWorker.mock.calls.length === 1, 'the first pipeline');
    await run('startInNewWindow', row('acme/web', web()));
    expect(h.connection.openInNewWindow).toHaveBeenCalledWith('web', '/workspaces/web');
    api.resolve(openResult(devspace()));
    await first;
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
  });

  it('removes the pending connection file and opens no window when the user cancels', async () => {
    const env = devspace();
    await h.registry.add(env);
    const progress = cancellableProgress();
    h.service.openDevspaceInWorker.mockImplementation(async (id: string) => {
      await h.sessionFiles.writePending(id, WINDOW_ID);
      progress.cancel();
      return openResult(env);
    });
    await run('startInNewWindow', row('acme/api', env));
    expect(h.connection.openInNewWindow).not.toHaveBeenCalled();
    expect(await h.sessionFiles.readPendings()).toEqual([]);
  });

  it('Try again after a failure opens a new window again', async () => {
    await h.registry.add(devspace());
    h.service.openDevspaceInWorker.mockRejectedValueOnce(new UserFacingError('buildFailed', Messages.buildFailed, 'log'));
    fakeVscode.window.showErrorMessage.mockResolvedValueOnce(Actions.tryAgain);
    await run('startInNewWindow', row('acme/api', devspace()));
    await settle(() => h.connection.openInNewWindow.mock.calls.length === 1, 'the new window of Try again');
    expect(h.connection.open).not.toHaveBeenCalled();
  });

  it('the switcher for a new window opens the selected devspace in a new window', async () => {
    await h.registry.add(devspace());
    fakeVscode.window.showQuickPick.mockImplementationOnce(async (items: Array<{ choice?: { kind: string } }>) =>
      items.find((item) => item.choice?.kind === 'devspace'),
    );
    await run('switchDevspaceInNewWindow');
    const options = fakeVscode.window.showQuickPick.mock.calls[0][1] as { placeHolder?: string };
    expect(options.placeHolder).toBe('Select a devspace to open in a new window');
    expect(h.connection.openInNewWindow).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
    expect(h.connection.open).not.toHaveBeenCalled();
  });

  it('with the setting openInNewWindow, the switcher for the current window uses this window', async () => {
    h.settings.openInNewWindow = true;
    await h.registry.add(devspace());
    fakeVscode.window.showQuickPick.mockImplementationOnce(async (items: Array<{ choice?: { kind: string } }>) =>
      items.find((item) => item.choice?.kind === 'devspace'),
    );
    await run('switchDevspaceInCurrentWindow');
    const options = fakeVscode.window.showQuickPick.mock.calls[0][1] as { placeHolder?: string };
    expect(options.placeHolder).toBe('Select a devspace to open in this window');
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
    expect(h.connection.openInNewWindow).not.toHaveBeenCalled();
  });

  it('binds a key to Switch Devspace… only on macOS (package.json)', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: { keybindings: Array<Record<string, string>> };
    };
    // On many Windows keyboards, Ctrl+Alt+E is AltGr+E, which types a character such as €. Without "key", VS Code
    // binds no key on Windows and Linux.
    expect(manifest.contributes.keybindings.filter((binding) => binding.command === Commands.switchDevspace)).toEqual([
      { command: Commands.switchDevspace, mac: 'cmd+alt+e' },
    ]);
  });

  it('role A in the new window: the pending connection file of the window that ran the pipeline means no second pipeline', async () => {
    const env = devspace();
    await h.registry.add(env);
    // The file names the window that ran the pipeline, not this (new) window.
    await h.controller.openAttachedWindow(env, CONTAINER, { devspaceId: ENV_ID, windowId: OTHER_WINDOW_ID, createdAt: iso(NOW - 5000) });
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    expect(h.statusBar.showConnected).toHaveBeenCalled();
  });

  it('offers Start in New Window next to Start, or Start in Current Window while the setting is on (package.json)', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: {
        menus: Record<string, Array<{ command?: string; when?: string; group?: string }>>;
        configuration: { properties: Record<string, { scope?: string; default?: unknown; type?: string }> };
      };
    };
    const menus = manifest.contributes.menus;
    const entries = (menu: string, command: string) =>
      menus[menu].filter((item) => item.command === command).map((item) => [item.when, item.group]);
    // Right after Start (1_actions@1), in a fixed order.
    expect(entries('view/item/context', Commands.startInNewWindow)).toEqual([
      ['view == devspaces.repositories && viewItem =~ /canStart/ && !config.devspaces.openInNewWindow', '1_actions@2'],
    ]);
    expect(entries('view/item/context', Commands.startInCurrentWindow)).toEqual([
      ['view == devspaces.repositories && viewItem =~ /canStart/ && config.devspaces.openInNewWindow', '1_actions@2'],
    ]);
    expect(entries('devspaces.more', Commands.startInNewWindow)).toEqual([
      ['viewItem =~ /canStart/ && !config.devspaces.openInNewWindow', '0_start@1'],
    ]);
    expect(entries('commandPalette', Commands.startInNewWindow)).toEqual([['!config.devspaces.openInNewWindow', undefined]]);
    expect(entries('commandPalette', Commands.startInCurrentWindow)).toEqual([['config.devspaces.openInNewWindow', undefined]]);
    expect(entries('commandPalette', Commands.switchDevspaceInNewWindow)).toEqual([['!config.devspaces.openInNewWindow', undefined]]);
    expect(entries('commandPalette', Commands.switchDevspaceInCurrentWindow)).toEqual([['config.devspaces.openInNewWindow', undefined]]);
    // Only the user settings decide which window a Start uses.
    expect(manifest.contributes.configuration.properties[`${SETTINGS_SECTION}.openInNewWindow`]).toMatchObject({
      type: 'boolean',
      scope: 'application',
      default: false,
    });
  });

  it('offers no command of the source: the rows of the sources carry Start, and the node of a repository has no menu (package.json)', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: {
        commands: Array<{ command: string }>;
        menus: Record<string, Array<{ command?: string; submenu?: string; when?: string; group?: string }>>;
        configuration: { properties: Record<string, { scope?: string; default?: unknown; type?: string }> };
      };
    };
    const commands = manifest.contributes.commands.map((command) => command.command);
    for (const gone of ['startWithDefaultImage', 'startWithConfiguration', 'selectConfiguration']) expect(commands).not.toContain(`devspaces.${gone}`);
    const menus = manifest.contributes.menus;
    for (const items of Object.values(menus)) {
      for (const item of items) expect(item.when ?? '').not.toMatch(/hasDefaultImage|canChooseSource|multiConfig/);
    }
    // No item of the context menu, inline or in the submenu, matches the node of a repository (REPOSITORY_NODE_CONTEXT).
    const matches = (when: string | undefined, value: string) => {
      const regex = /viewItem =~ \/(.+?)\//.exec(when ?? '');
      return regex ? new RegExp(regex[1]).test(value) : true;
    };
    for (const item of [...menus['view/item/context'], ...menus['devspaces.more']]) {
      expect(matches(item.when, REPOSITORY_NODE_CONTEXT), `${item.command ?? item.submenu} for a repository node`).toBe(false);
    }
    // Stop and the others follow Start, in their order.
    const actions = menus['view/item/context'].filter((item) => item.group?.startsWith('1_actions@')).map((item) => `${item.group} ${item.command}`);
    expect(actions).toEqual([
      '1_actions@1 devspaces.start',
      '1_actions@2 devspaces.startInNewWindow',
      '1_actions@2 devspaces.startInCurrentWindow',
      '1_actions@3 devspaces.startWithAccount',
      '1_actions@4 devspaces.stop',
      '1_actions@5 devspaces.delete',
      '1_actions@6 devspaces.keepRunning',
      '1_actions@6 devspaces.stopWhenClosed',
      '1_actions@7 devspaces.closeAndKeepRunning',
    ]);
    // The buttons of a row are Start, Stop and the ⋯ submenu; Delete is in the submenu (last, in its own group) and in
    // the context menu, not next to Stop.
    const inline = menus['view/item/context'].filter((item) => item.group?.startsWith('inline@')).map((item) => `${item.group} ${item.command ?? item.submenu}`);
    expect(inline).toEqual(['inline@1 devspaces.start', 'inline@2 devspaces.stop', 'inline@4 devspaces.more']);
    expect(menus['devspaces.more'].at(-1)).toEqual({ command: Commands.delete, when: 'viewItem =~ /canDelete/', group: '3_delete@1' });
    // The settings of the default image: the image, and the place of its row.
    expect(manifest.contributes.configuration.properties[`${SETTINGS_SECTION}.defaultImage`]).toMatchObject({ type: 'string', scope: 'application', default: '' });
    expect(manifest.contributes.configuration.properties[`${SETTINGS_SECTION}.startWithDefaultImage`]).toMatchObject({ type: 'boolean', scope: 'application', default: true });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Docker on another computer over SSH: a host of the list of Devspaces.

describe('the Docker host of Devspaces', () => {
  const REMOTE_ENV_ID = 'a1b2c3d4-0000-4000-8000-00000000000b';
  const PIPE = 'unix:///run/user/1000/devspaces-0123456789abcdef/docker.sock';
  /** The Docker host of Devspaces: a host of its list, or the local Docker of the current context. */
  let current: DockerTarget;
  /** The local Docker of the current context while Devspaces uses a host of its list. */
  let localTarget: DockerTarget;
  let operations: DockerTarget[];
  let resolves: number;
  let depth = 0;
  let windowDockerHost: Mock<NonNullable<ControllerDeps['windowDockerHost']>>;
  let remote: {
    useRemoteHost: Mock<RemoteDockerCommands['useRemoteHost']>;
    useLocalDocker: Mock<RemoteDockerCommands['useLocalDocker']>;
    chooseDockerHost: Mock<RemoteDockerCommands['chooseDockerHost']>;
  };

  /** As DockerTargets.ofHost: a host of the list over SSH, '' the local Docker of the current context. */
  function ofHost(host: string): DockerTarget {
    if (host !== '') return remoteDockerTarget(host);
    return current.kind === 'remote' ? localTarget : current;
  }

  beforeEach(() => {
    h.controller.dispose();
    fs.rmSync(h.root, { recursive: true, force: true });
    current = dockerTargetOf('unix:///var/run/docker.sock', 'default');
    localTarget = current;
    operations = [];
    resolves = 0;
    depth = 0;
    remote = {
      useRemoteHost: vi.fn(async () => {}),
      useLocalDocker: vi.fn(async () => {}),
      chooseDockerHost: vi.fn(async () => {}),
    };
    const dockerTargets = {
      resolve: vi.fn(async () => {
        resolves++;
        return current;
      }),
      // As DockerTargets.current: the target of the running operation, else a fresh read.
      current: vi.fn(async () => operationDockerTarget() ?? current),
      // As DockerTargets.withOperation: a nested operation keeps the target of the outer one, and the calls of the
      // operation see its target (runWithDockerTarget).
      withOperation: vi.fn(async <T,>(fn: () => Promise<T>): Promise<T> => {
        if (depth > 0 || operationDockerTarget() !== undefined) return fn();
        const target = current;
        operations.push(target);
        depth++;
        try {
          return await runWithDockerTarget(target, fn);
        } finally {
          depth--;
        }
      }),
      ofHost: vi.fn(async (host: string) => ofHost(host)),
    };
    // Every devspace on an SSH host has the Docker pipe of its window (ssh is installed).
    windowDockerHost = vi.fn((shown: Devspace) => (shown.dockerHost === undefined ? undefined : PIPE));
    h = createHarness({ dockerTargets: dockerTargets as unknown as ControllerDeps['dockerTargets'], remoteDocker: remote, windowDockerHost });
  });

  function remoteDevspace(overrides: Partial<Devspace> = {}): Devspace {
    return devspace({
      id: REMOTE_ENV_ID,
      containerName: 'devspaces-acme-api-a1b2c3d4',
      volumeName: 'devspaces-acme-api-a1b2c3d4',
      dockerHost: 'build-box',
      ...overrides,
    });
  }

  it('registers both commands and runs them without an operation of their own', async () => {
    await run('useRemoteDockerHost');
    await run('useLocalDocker');
    expect(remote.useRemoteHost).toHaveBeenCalledTimes(1);
    expect(remote.useLocalDocker).toHaveBeenCalledTimes(1);
    expect(operations).toEqual([]);
  });

  // The link Show details of a running operation runs Show Log: it must not wait for a read of the Docker context
  // (up to 15 s while the Docker CLI does not answer).
  it('opens the log without an operation, so it reads no Docker context', async () => {
    await run('showLog');
    expect(h.logger.show).toHaveBeenCalledTimes(1);
    expect(operations).toEqual([]);
  });

  // Show Log from the Command Palette or the status bar leaves the notifications; the link Show details of a progress
  // notification passes 'progressNotification' and hides the notification as the key Escape does (progress.ts).
  it('hides the notifications only for the link Show details of a progress notification', async () => {
    await run('showLog');
    expect(fakeVscode.commands.executeCommand).not.toHaveBeenCalledWith('notifications.hideToasts');
    await run('showLog', 'progressNotification');
    expect(h.logger.show).toHaveBeenCalledTimes(2);
    expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith('notifications.hideToasts');
    expect(operations).toEqual([]);
  });

  it('opens the log also when VS Code cannot hide the notification, with one line in the log per window and no message', async () => {
    fakeVscode.commands.executeCommand.mockImplementation(async (command: string) => {
      if (command === 'notifications.hideToasts') throw new Error("command 'notifications.hideToasts' not found");
    });
    await run('showLog', 'progressNotification');
    await run('showLog', 'progressNotification');
    expect(h.logger.show).toHaveBeenCalledTimes(2);
    const warnings = h.logger.warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('notifications.hideToasts'));
    expect(warnings).toEqual([
      "Show details did not hide the notification, because the VS Code command notifications.hideToasts failed: command 'notifications.hideToasts' not found",
    ]);
    expect(fakeVscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(fakeVscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  // The choice of the Docker host is the command of the first row of the view, so the view's title bar has no icon of
  // the Docker host.
  it('runs the choice of the Docker host without an operation, and shows no icon of the Docker host in the title bar', async () => {
    await run('chooseDockerHost');
    expect(remote.chooseDockerHost).toHaveBeenCalledTimes(1);
    expect(operations).toEqual([]);
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: {
        commands: Array<{ command: string; icon?: string }>;
        menus: Record<string, Array<{ command: string; when?: string; group?: string }>>;
      };
    };
    const title = manifest.contributes.menus['view/title'];
    // The first row of the list chooses the Docker host; the title bar has no icon of the Docker host, and the commands
    // no icon.
    expect(title.filter((entry) => entry.command === 'devspaces.useRemoteDockerHost' || entry.command === 'devspaces.chooseDockerHost')).toEqual([]);
    const icons = Object.fromEntries(manifest.contributes.commands.map((command) => [command.command, command.icon]));
    expect(icons['devspaces.useRemoteDockerHost']).toBeUndefined();
    expect(icons['devspaces.chooseDockerHost']).toBeUndefined();
    expect(manifest.contributes.menus.commandPalette).toContainEqual({ command: 'devspaces.chooseDockerHost', when: 'false' });
  });

  // A window knows its host from its devspace: a command on a row or the status bar item runs on that host.
  it('runs a command that names a devspace on the host of that devspace, whatever host Devspaces uses', async () => {
    current = remoteDockerTarget('build-box');
    await h.registry.add(devspace());
    const seen: Array<string | undefined> = [];
    h.service.stop.mockImplementation(async () => {
      seen.push(operationDockerTarget()?.host);
    });
    await run('stop', row('acme/api', devspace()));
    await run('stop', { devspaceId: ENV_ID });
    expect(h.service.stop).toHaveBeenCalledWith(ENV_ID);
    expect(seen).toEqual(['', '']);
    expect(operations).toEqual([]);
  });

  // Try again runs after the operation ended: on the host of the devspace again, not on the host that Devspaces uses then.
  it('runs Try again of a Stop on the host of its devspace', async () => {
    await h.registry.add(devspace());
    const seen: Array<string | undefined> = [];
    h.service.stop.mockImplementationOnce(async () => {
      seen.push(operationDockerTarget()?.host);
      // Devspaces uses another host when the user clicks Try again.
      current = remoteDockerTarget('build-box');
      throw new UserFacingError('dockerStartFailed', Messages.dockerStartFailed, 'log');
    });
    h.service.stop.mockImplementationOnce(async () => {
      seen.push(operationDockerTarget()?.host);
    });
    fakeVscode.window.showErrorMessage.mockResolvedValueOnce(Actions.tryAgain);
    await run('stop', row('acme/api', devspace()));
    await settle(() => h.service.stop.mock.calls.length === 2, 'the Try again');
    expect(seen).toEqual(['', '']);
  });

  it('runs every other command as one operation on the host that is current when it starts', async () => {
    current = remoteDockerTarget('build-box');
    await run('updateImagesNow');
    expect(operations.map((target) => target.host)).toEqual(['build-box']);
  });

  it('Start of a repository uses the devspace of the current host only', async () => {
    await h.registry.add(remoteDevspace());
    h.sidebar.infos.set('acme/api', repositoryInfo('acme/api'));
    await run('start', row('acme/api', undefined, repositoryInfo('acme/api')));
    // The local Docker is current: the service opens the repository (a new devspace), not the one on build-box.
    expect(h.service.openInWorker).toHaveBeenCalledTimes(1);
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
  });

  // The window knows its Docker host from its devspace (for example a window of Open Recent after the user chose another
  // host): its pipeline runs there, without a question.
  it.each([
    ['the host of Devspaces', () => remoteDockerTarget('build-box')],
    ['another host than the one of Devspaces', () => dockerTargetOf('unix:///var/run/docker.sock', 'default')],
  ])('a restored window of a devspace on %s runs on the host of its devspace, without a question', async (_name, target) => {
    current = target();
    const env = remoteDevspace();
    await h.registry.add(env);
    const seen: Array<DockerTarget | undefined> = [];
    h.service.openDevspaceInWorker.mockImplementation(async (id: string) => {
      seen.push(operationDockerTarget());
      return openResult((await h.registry.get(id))!);
    });
    await h.controller.openAttachedWindow(env, env.containerName, undefined);
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledWith(REMOTE_ENV_ID, expect.anything());
    expect(seen).toEqual([remoteDockerTarget('build-box')]);
    expect(fakeVscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
  });

  // A local devspace runs on the local Docker of the current context; one that is not local is logged and refused by the
  // steps of the pipeline (the Docker start).
  it('a restored window of a local devspace runs on the local Docker, also while Devspaces uses an SSH host', async () => {
    current = remoteDockerTarget('build-box');
    localTarget = dockerTargetOf('unix:///home/me/.docker/desktop/docker.sock', 'desktop-linux');
    const env = devspace();
    await h.registry.add(env);
    const seen: Array<DockerTarget | undefined> = [];
    h.service.openDevspaceInWorker.mockImplementation(async (id: string) => {
      seen.push(operationDockerTarget());
      return openResult((await h.registry.get(id))!);
    });
    await h.controller.openAttachedWindow(env, env.containerName, undefined);
    expect(seen).toEqual([localTarget]);
    localTarget = dockerTargetOf('ssh://me@box', 'box');
    h.logger.info.mockClear();
    await h.controller.openAttachedWindow(env, env.containerName, undefined);
    expect(h.logger.info).toHaveBeenCalledWith(
      'The devspace acme/api is on the local Docker, which is not supported now. The current Docker context box reaches me@box over SSH, which is not a host of the list of Devspaces.',
    );
  });

  // A window of the versions that made a Docker context for each host names that context in its authority.
  it('a restored window that names a Docker context stays as it is', async () => {
    current = remoteDockerTarget('build-box');
    const env = remoteDevspace();
    await h.registry.add(env);
    h.connection.currentContainerName.mockReturnValue(env.containerName);
    h.connection.currentDockerContext.mockReturnValue('my-build-box');
    await h.controller.openAttachedWindow(env, env.containerName, undefined);
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledTimes(1);
    // The window is not opened again with the context.
    expect(h.connection.open).not.toHaveBeenCalled();
  });

  // The status of the other window is read once; it closing meanwhile does not drop the context.
  it('uses the status of the other window that it decided on, not a second read', async () => {
    current = remoteDockerTarget('build-box');
    await h.registry.add(remoteDevspace());
    // A context other than the operation's, and no pipeline, so only the other-window branch can pass.
    h.coordinator.otherActiveWindows.mockResolvedValueOnce([
      { windowId: OTHER_WINDOW_ID, pid: OTHER_PID, devspaceId: REMOTE_ENV_ID, state: 'active', updatedAt: iso(NOW), dockerContext: 'my-build-box' },
    ]);
    h.coordinator.otherActiveWindows.mockResolvedValue([]);
    await run('start', row('acme/api', remoteDevspace()));
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    expect(h.connection.open.mock.calls).toEqual([['devspaces-acme-api-a1b2c3d4', '/workspaces/api', { context: 'my-build-box' }]]);
  });

  // The other window is shown by exactly its URI, with the context of its status file.
  it('shows the other window of a remote devspace with the context that its status file names, or none', async () => {
    current = remoteDockerTarget('build-box');
    await h.registry.add(remoteDevspace());
    h.coordinator.otherActiveWindows.mockResolvedValue([
      { windowId: OTHER_WINDOW_ID, pid: OTHER_PID, devspaceId: REMOTE_ENV_ID, state: 'active', updatedAt: iso(NOW), dockerContext: 'my-build-box' },
    ]);
    await run('start', row('acme/api', remoteDevspace()));
    h.coordinator.otherActiveWindows.mockResolvedValue([
      { windowId: OTHER_WINDOW_ID, pid: OTHER_PID, devspaceId: REMOTE_ENV_ID, state: 'active', updatedAt: iso(NOW) },
    ]);
    await run('start', row('acme/api', remoteDevspace()));
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    expect(h.connection.open.mock.calls).toEqual([
      ['devspaces-acme-api-a1b2c3d4', '/workspaces/api', { context: 'my-build-box' }],
      ['devspaces-acme-api-a1b2c3d4', '/workspaces/api'],
    ]);
  });

  /** DockerTargets as in the beforeEach: the operation runs on the target that is current when it starts. */
  function pinnedTargets(): ControllerDeps['dockerTargets'] {
    return {
      resolve: vi.fn(async () => current),
      current: vi.fn(async () => current),
      withOperation: vi.fn(async <T,>(fn: () => Promise<T>): Promise<T> => (operationDockerTarget() !== undefined ? fn() : runWithDockerTarget(current, fn))),
      ofHost: vi.fn(async (host: string) => ofHost(host)),
    } as unknown as ControllerDeps['dockerTargets'];
  }

  // Outside an operation too, also when Devspaces uses another host meanwhile.
  it('the reload for the owner account opens the window with its Docker pipe (outside an operation)', async () => {
    current = remoteDockerTarget('build-box');
    recreateHarness({ leaveCheckMs: 100, dockerTargets: pinnedTargets(), remoteDocker: remote, windowDockerHost });
    const env = remoteDevspace();
    await h.registry.add(env);
    h.connection.currentContainerName.mockReturnValue(env.containerName);
    await connectHere(env);
    h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
    await h.controller.onSessionChanged();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
    current = dockerTargetOf('unix:///var/run/docker.sock', 'default');
    h.auth.getAccount.mockResolvedValue(ACCOUNT);
    await h.controller.onSessionChanged();
    expect(h.connection.open).toHaveBeenCalledWith('devspaces-acme-api-a1b2c3d4', '/workspaces/api', { host: PIPE });
  });

  // Without ssh on this computer, a devspace on an SSH host has no Docker pipe, and its window does not open: the check
  // comes before the pending connection file.
  it('does not open the window of a devspace on an SSH host without its Docker pipe', async () => {
    windowDockerHost.mockReturnValue(undefined);
    current = remoteDockerTarget('build-box');
    await h.registry.add(remoteDevspace());
    await run('start', row('acme/api', remoteDevspace()));
    expect(h.connection.open).not.toHaveBeenCalled();
    expect(h.coordinator.writePending).not.toHaveBeenCalled();
    expect(fakeVscode.window.showErrorMessage.mock.calls[0]?.[0]).toBe(Messages.dockerHostUnreachable('build-box', dockerHostReason('sshMissing', 'build-box')));
  });

  // Devspaces reaches a host only through its own list.
  it('never creates, changes or uses a Docker context for a devspace on an SSH host', async () => {
    current = remoteDockerTarget('build-box');
    await h.registry.add(remoteDevspace());
    await run('start', row('acme/api', remoteDevspace()));
    expect(h.connection.open).toHaveBeenCalledWith('devspaces-acme-api-a1b2c3d4', '/workspaces/api', { host: PIPE });
    const calls = h.docker.run.mock.calls.map(([args]) => (args as string[]).join(' '));
    expect(calls.filter((call) => call.startsWith('context ') || call.startsWith('--context '))).toEqual([]);
  });

  it('role B: a pending operation runs on the host of its devspace; the reopen rule skips a devspace of another host', async () => {
    await h.registry.add(remoteDevspace());
    h.connection.isEmptyWindow.mockReturnValue(true);
    await h.sessionFiles.writeOperation({
      devspaceId: REMOTE_ENV_ID,
      operation: 'stop',
      requestedAt: iso(NOW - 5000),
      requestedBy: 'old-window',
      reason: 'manual',
    });
    const seen: Array<string | undefined> = [];
    h.service.stop.mockImplementation(async () => {
      seen.push(operationDockerTarget()?.host);
    });
    await h.controller.runEmptyWindowTasks();
    expect(h.service.stop).toHaveBeenCalledWith(REMOTE_ENV_ID);
    expect(seen).toEqual(['build-box']);

    await h.sessionFiles.removeOperation(REMOTE_ENV_ID).catch(() => {});
    h.sessionFiles.writeReopenSync({ devspaceId: REMOTE_ENV_ID, closedAt: iso(NOW - 60_000) });
    await h.controller.runEmptyWindowTasks();
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    expect(h.connection.open).not.toHaveBeenCalled();
  });

  // The empty window runs the operation on the host of the devspace (the test above), so the connected window hands it
  // off also while Devspaces uses another host.
  it('hands off Stop of the connected devspace on its own host while Devspaces uses another host', async () => {
    current = remoteDockerTarget('build-box');
    const env = remoteDevspace();
    await h.registry.add(env);
    await connectHere(env);
    current = dockerTargetOf('unix:///var/run/docker.sock', 'default');
    await run('stop', row('acme/api', env));
    expect(fakeVscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(h.connection.closeRemoteConnection).toHaveBeenCalled();
    expect(await h.sessionFiles.readOperations()).toEqual([expect.objectContaining({ devspaceId: REMOTE_ENV_ID, operation: 'stop' })]);
  });

  it('reads the Docker host again for the next operation (a switch while VS Code runs takes effect)', async () => {
    await run('updateImagesNow');
    current = remoteDockerTarget('build-box');
    await run('updateImagesNow');
    expect(operations.map((target) => target.host)).toEqual(['', 'build-box']);
  });

  // The window of a local devspace connects only when the current Docker context is still the local Docker and the
  // container runs, and the log shows which Docker the Dev Containers extension will ask.
  it('does not connect the window of a local devspace when the Docker context of this computer changed during the start', async () => {
    await h.registry.add(devspace());
    h.service.openDevspaceInWorker.mockImplementation(async (id: string) => {
      await h.sessionFiles.writePending(id, WINDOW_ID);
      current = dockerTargetOf('ssh://me@box', 'box');
      return openResult((await h.registry.get(id))!);
    });
    await run('start', row('acme/api', devspace()));
    // The message of this path says that the container stays and how to go back.
    expect(fakeVscode.window.showWarningMessage.mock.calls[0]?.[0]).toBe(Messages.otherDockerHostAfterStart('acme/api', 'ssh://me@box'));
    // The pending connection file of the pipeline is removed.
    expect(await h.sessionFiles.readPendings()).toEqual([]);
    expect(h.coordinator.writePending).not.toHaveBeenCalled();
    expect(h.connection.open).not.toHaveBeenCalled();
  });

  // The window of a devspace on an SSH host reaches it through its Docker pipe, whatever host Devspaces uses.
  it('connects the window of a devspace on an SSH host also when Devspaces switched to another host during the start', async () => {
    current = remoteDockerTarget('build-box');
    await h.registry.add(remoteDevspace());
    h.service.openDevspaceInWorker.mockImplementation(async (id: string) => {
      await h.sessionFiles.writePending(id, WINDOW_ID);
      current = dockerTargetOf('unix:///var/run/docker.sock', 'default');
      return openResult((await h.registry.get(id))!);
    });
    await run('start', row('acme/api', remoteDevspace()));
    expect(fakeVscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(h.connection.open).toHaveBeenCalledWith('devspaces-acme-api-a1b2c3d4', '/workspaces/api', { host: PIPE });
  });

  it('names no context in the window of a local devspace', async () => {
    await h.registry.add(devspace());
    await run('start', row('acme/api', devspace()));
    expect(h.connection.open.mock.calls[0]).toEqual([CONTAINER, '/workspaces/api']);
  });

  // The Docker pipe of the window (windowPipe.ts) comes before any context: the window of the devspace has one address.
  it('names the Docker pipe in the window of a remote devspace that has one, and nothing for a local devspace', async () => {
    const pipe = 'unix:///run/user/1000/devspaces-0123456789abcdef/docker.sock';
    windowDockerHost.mockImplementation((shown) => (shown.dockerHost === undefined ? undefined : pipe));
    current = remoteDockerTarget('build-box');
    await h.registry.add(remoteDevspace());
    await run('start', row('acme/api', remoteDevspace()));
    expect(h.connection.open.mock.calls[0]).toEqual(['devspaces-acme-api-a1b2c3d4', '/workspaces/api', { host: pipe }]);
    expect(windowDockerHost).toHaveBeenCalledWith(expect.objectContaining({ id: REMOTE_ENV_ID }), 'devspaces-acme-api-a1b2c3d4');
    // The window of a local devspace never asks for one.
    windowDockerHost.mockClear();
    current = dockerTargetOf('unix:///var/run/docker.sock', 'default');
    await h.registry.add(devspace());
    await run('start', row('acme/api', devspace()));
    expect(h.connection.open.mock.calls[1]).toEqual([CONTAINER, '/workspaces/api']);
    expect(windowDockerHost).not.toHaveBeenCalled();
  });

  it('shows the other window of a remote devspace with the Docker pipe that its status file names', async () => {
    const pipe = 'unix:///run/user/1000/devspaces-0123456789abcdef/docker.sock';
    current = remoteDockerTarget('build-box');
    await h.registry.add(remoteDevspace());
    h.coordinator.otherActiveWindows.mockResolvedValue([
      { windowId: OTHER_WINDOW_ID, pid: OTHER_PID, devspaceId: REMOTE_ENV_ID, state: 'active', updatedAt: iso(NOW), dockerHost: pipe },
    ]);
    await run('start', row('acme/api', remoteDevspace()));
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    expect(h.connection.open.mock.calls).toEqual([['devspaces-acme-api-a1b2c3d4', '/workspaces/api', { host: pipe }]]);
  });

  // The check reads the current context itself, although the operation's calls are pinned to its own context
  // (DOCKER_CONTEXT), with the real DockerTargets.
  it('does not connect the window when the current context changed during the start (real DockerTargets)', async () => {
    const endpoints: Record<string, string> = { box: 'ssh://me@box', default: 'unix:///var/run/docker.sock' };
    let currentContext = 'default';
    const cli = {
      isInstalled: () => true,
      // As BootstrapDocker.run: the context of the running operation (DOCKER_CONTEXT) wins over the current one.
      run: vi.fn(async (_args: readonly string[]) => {
        const name = operationDockerTarget()?.context ?? currentContext;
        return { exitCode: 0, stdout: JSON.stringify({ Name: name, Endpoints: { docker: { Host: endpoints[name] } } }), stderr: '', timedOut: false };
      }),
    };
    recreateHarness({ dockerTargets: new DockerTargets(cli, {}, silentLogger, 'linux'), remoteDocker: remote });
    await h.registry.add(devspace());
    h.service.openDevspaceInWorker.mockImplementation(async (id: string) => {
      await h.sessionFiles.writePending(id, WINDOW_ID);
      currentContext = 'box';
      return openResult((await h.registry.get(id))!);
    });
    await run('start', row('acme/api', devspace()));
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledTimes(1);
    expect(fakeVscode.window.showWarningMessage.mock.calls[0]?.[0]).toBe(Messages.otherDockerHostAfterStart('acme/api', 'ssh://me@box'));
    expect(await h.sessionFiles.readPendings()).toEqual([]);
    expect(h.connection.open).not.toHaveBeenCalled();
  });

  it('does not connect the window when the container does not run after the start', async () => {
    current = remoteDockerTarget('build-box');
    await h.registry.add(remoteDevspace());
    h.docker.containerState.mockResolvedValue('stopped');
    h.service.openDevspaceInWorker.mockImplementation(async (id: string) => {
      await h.sessionFiles.writePending(id, WINDOW_ID);
      return openResult((await h.registry.get(id))!);
    });
    await run('start', row('acme/api', remoteDevspace()));
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledTimes(1);
    // The pending connection file of the pipeline is removed.
    expect(await h.sessionFiles.readPendings()).toEqual([]);
    expect(h.docker.containerState.mock.calls.filter(([name]) => name === 'devspaces-acme-api-a1b2c3d4').length).toBeGreaterThanOrEqual(5);
    // Each check of the attach is a read of the worker (windowStateInWorker), never a Docker call of the window (this
    // harness's worker reads the same fake).
    expect(h.service.windowStateInWorker.mock.calls.filter(([, name]) => name === 'devspaces-acme-api-a1b2c3d4').length).toBeGreaterThanOrEqual(5);
    expect(fakeVscode.window.showErrorMessage.mock.calls[0]?.[0]).toBe(Messages.containerNotReady('acme/api', 'devspaces-acme-api-a1b2c3d4'));
    expect(h.coordinator.writePending).not.toHaveBeenCalled();
    expect(h.connection.open).not.toHaveBeenCalled();
  });

  it('does not connect the window when the worker cannot read the container, and names that in the log', async () => {
    // Each check of the attach is a bounded read of the worker within the operation (with a signal, so not passive); an
    // unread state counts as not running.
    current = remoteDockerTarget('build-box');
    await h.registry.add(remoteDevspace());
    h.service.windowStateInWorker.mockResolvedValue(undefined);
    h.service.openDevspaceInWorker.mockImplementation(async (id: string) => {
      await h.sessionFiles.writePending(id, WINDOW_ID);
      return openResult((await h.registry.get(id))!);
    });
    await run('start', row('acme/api', remoteDevspace()));
    const reads = h.service.windowStateInWorker.mock.calls.filter(([, name]) => name === 'devspaces-acme-api-a1b2c3d4');
    expect(reads.length).toBeGreaterThanOrEqual(5);
    for (const [, , options] of reads) expect((options as { signal?: AbortSignal } | undefined)?.signal).toBeInstanceOf(AbortSignal);
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining('does not run (state: not readable)'));
    expect(fakeVscode.window.showErrorMessage.mock.calls[0]?.[0]).toBe(Messages.containerNotReady('acme/api', 'devspaces-acme-api-a1b2c3d4'));
    expect(await h.sessionFiles.readPendings()).toEqual([]);
    expect(h.connection.open).not.toHaveBeenCalled();
  });

  it('logs the current context and both inspects before the window of a local devspace connects', async () => {
    current = dockerTargetOf('unix:///home/me/.docker/desktop/docker.sock', 'desktop-linux');
    await h.registry.add(devspace());
    await run('start', row('acme/api', devspace()));
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
    const calls = h.docker.run.mock.calls.map(([args]) => (args as string[]).join(' '));
    expect(calls).toContain('context show');
    expect(calls).toContain(`inspect --type container /${CONTAINER} --format {{.Id}} {{.State.Status}}`);
    // The context that the operation used.
    expect(calls).toContain(`--context desktop-linux inspect --type container /${CONTAINER} --format {{.Id}} {{.State.Status}}`);
    const logged = h.logger.info.mock.calls.map(([line]) => String(line));
    expect(logged.some((line) => line.startsWith('Before the window connects: Current Docker context:'))).toBe(true);
  });

  // The Dev Containers extension asks the Docker pipe of such a window, not a context; an inspect through the context
  // would only log in to the host once more.
  it('logs only the Docker pipe before a window with a Docker pipe connects', async () => {
    const pipe = PIPE;
    current = remoteDockerTarget('build-box');
    await h.registry.add(remoteDevspace());
    await run('start', row('acme/api', remoteDevspace()));
    expect(h.connection.open).toHaveBeenCalledWith('devspaces-acme-api-a1b2c3d4', '/workspaces/api', { host: pipe });
    const calls = h.docker.run.mock.calls.map(([args]) => (args as string[]).join(' '));
    expect(calls.filter((call) => call.includes('inspect --type container'))).toEqual([]);
    expect(calls).not.toContain('context show');
    const logged = h.logger.info.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith('Before the window connects:'));
    expect(logged).toEqual([`Before the window connects: the Dev Containers extension reaches build-box through the Docker pipe ${pipe} of the window.`]);
  });
});

// Close and Keep Running closes the window; the container keeps running this time.
describe('Close and Keep Running', () => {
  const REMOTE_TARGET = remoteDockerTarget('build-box');
  let current: DockerTarget;
  let sendHeartbeat: ReturnType<typeof vi.fn<(devspaceId: string) => Promise<{ ok: true } | { ok: false; detail: string }>>>;
  const order: string[] = [];

  /** The harness with a Monitor on every engine; `target` is the current Docker target. */
  function monitorHarness(target: DockerTarget, options: { leaveCheckMs?: number } = {}): void {
    current = target;
    order.length = 0;
    sendHeartbeat = vi.fn(async (id: string) => {
      // The flag is stored before the heartbeat reads it (WindowHeartbeats.sendFor reads the registry).
      order.push(`heartbeat ${id} ${(await h.registry.get(id))?.keepRunningOnce === true ? 'kept' : 'not kept'}`);
      return { ok: true as const };
    });
    const dockerTargets = {
      resolve: vi.fn(async () => current),
      current: vi.fn(async () => operationDockerTarget() ?? current),
      withOperation: vi.fn(async <T,>(fn: () => Promise<T>): Promise<T> => (operationDockerTarget() !== undefined ? fn() : runWithDockerTarget(current, fn))),
      ofHost: vi.fn(async (host: string) => (host === '' ? LOCAL_TARGET : remoteDockerTarget(host))),
    };
    recreateHarness({
      dockerTargets: dockerTargets as unknown as ControllerDeps['dockerTargets'],
      sessionMonitor: { sendHeartbeat, sendStop: vi.fn(async () => ({ ok: true as const })) },
      leaveCheckMs: options.leaveCheckMs,
      windowDockerHost: (shown) => (shown.dockerHost === undefined ? undefined : 'unix:///run/user/1000/devspaces-0123456789abcdef/docker.sock'),
    });
    h.connection.closeWindow.mockImplementation(async () => {
      order.push('close');
    });
  }

  function remoteHarness(options: { leaveCheckMs?: number } = {}): void {
    monitorHarness(REMOTE_TARGET, options);
  }

  const LOCAL_TARGET = dockerTargetOf('unix:///var/run/docker.sock', 'default');

  it('says so in a window without a devspace, and changes nothing', async () => {
    await h.registry.add(devspace());
    await run('closeAndKeepRunning');
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(ControllerTexts.closeAndKeepRunningNotConnected);
    expect(h.connection.closeWindow).not.toHaveBeenCalled();
    expect(await h.registry.get(ENV_ID)).not.toHaveProperty('keepRunningOnce');
  });

  // On the local Docker too, one heartbeat with the keep flag goes to the Monitor of the engine first.
  it('local devspace: sends one heartbeat with the keep flag first, then closes the window', async () => {
    monitorHarness(LOCAL_TARGET);
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    await run('closeAndKeepRunning');
    expect((await h.registry.get(ENV_ID))?.keepRunningOnce).toBe(true);
    expect(sendHeartbeat).toHaveBeenCalledWith(ENV_ID);
    expect(order).toEqual([`heartbeat ${ENV_ID} kept`, 'close']);
    expect(h.connection.closeWindow).toHaveBeenCalledTimes(1);
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
    // The row argument of the context menu does not matter: the command acts on the devspace of this window.
    expect(h.service.stop).not.toHaveBeenCalled();
  });

  it('remote devspace: sends one heartbeat with the keep flag first, then closes the window', async () => {
    remoteHarness();
    const env = devspace({ dockerHost: 'build-box' });
    await h.registry.add(env);
    await connectHere(env);
    await run('closeAndKeepRunning', row('acme/api', env));
    // WindowHeartbeats.sendFor takes the seq itself before it reads the flag, which is stored before.
    expect(sendHeartbeat).toHaveBeenCalledWith(ENV_ID);
    expect(order).toEqual([`heartbeat ${ENV_ID} kept`, 'close']);
    expect((await h.registry.get(ENV_ID))?.keepRunningOnce).toBe(true);
  });

  it('remote devspace: when the host cannot be reached, clears the flag, says so, and the window stays open', async () => {
    remoteHarness();
    h.settings.stopAfterMinutes = 15;
    sendHeartbeat.mockResolvedValue({ ok: false, detail: 'ssh: connect to host build-box port 22: Connection timed out' });
    const env = devspace({ dockerHost: 'build-box' });
    await h.registry.add(env);
    await connectHere(env);
    await run('closeAndKeepRunning');
    expect(await h.registry.get(ENV_ID)).not.toHaveProperty('keepRunningOnce');
    expect(h.connection.closeWindow).not.toHaveBeenCalled();
    expect(fakeVscode.window.showErrorMessage).toHaveBeenCalledWith(
      'The Docker host build-box cannot be reached. The container would stop after 15 minutes without contact. The window stays open.',
    );
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Connection timed out'));
  });

  // A window knows its host from its devspace.
  it('remote devspace while Devspaces uses the local Docker: the heartbeat goes to its own host, then the window closes', async () => {
    remoteHarness();
    const env = devspace({ dockerHost: 'build-box' });
    await h.registry.add(env);
    await connectHere(env);
    current = dockerTargetOf('unix:///var/run/docker.sock', 'default');
    await run('closeAndKeepRunning');
    expect(warningMessages()).toEqual([]);
    expect(order).toEqual([`heartbeat ${ENV_ID} kept`, 'close']);
  });

  // The same rules on the local Docker.
  it('local devspace: when the Monitor cannot be reached, clears the flag, says so, and the window stays open', async () => {
    monitorHarness(LOCAL_TARGET);
    sendHeartbeat.mockResolvedValue({ ok: false, detail: 'The Monitor could not be started again: image not found' });
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    await run('closeAndKeepRunning');
    expect(await h.registry.get(ENV_ID)).not.toHaveProperty('keepRunningOnce');
    expect(h.connection.closeWindow).not.toHaveBeenCalled();
    expect(fakeVscode.window.showErrorMessage).toHaveBeenCalledWith(
      'The Monitor of the local Docker cannot be reached. The container would stop after 10 minutes without contact. The window stays open.',
    );
  });

  it('local devspace while Devspaces uses a remote host: the heartbeat goes to the local Docker, then the window closes', async () => {
    monitorHarness(LOCAL_TARGET);
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    current = REMOTE_TARGET;
    await run('closeAndKeepRunning');
    expect(warningMessages()).toEqual([]);
    expect(order).toEqual([`heartbeat ${ENV_ID} kept`, 'close']);
  });

  it('refuses without a Monitor in this window, and clears the flag', async () => {
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    await run('closeAndKeepRunning');
    expect(h.connection.closeWindow).not.toHaveBeenCalled();
    expect(await h.registry.get(ENV_ID)).not.toHaveProperty('keepRunningOnce');
  });

  // closeWindow resolves when the close starts, not after the dialog about unsaved files.
  it('keeps the flag when the window stays open (Cancel in the dialog about unsaved files), until the next connect', async () => {
    // With the Monitor of the local Docker (every engine needs its heartbeat).
    monitorHarness(LOCAL_TARGET, { leaveCheckMs: 10 });
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    await run('closeAndKeepRunning');
    await pause(50);
    expect((await h.registry.get(ENV_ID))?.keepRunningOnce).toBe(true);
    expect(h.logger.info).not.toHaveBeenCalledWith(expect.stringContaining('stayed open'));
  });

  it('a window that connects to the devspace again clears the flag', async () => {
    const env = devspace({ keepRunningOnce: true, keepRunning: true });
    await h.registry.add(env);
    await connectHere(env);
    const stored = await h.registry.get(ENV_ID);
    expect(stored).not.toHaveProperty('keepRunningOnce');
    expect(stored?.keepRunning).toBe(true);
  });

  it('sets the context key of a connected window when it connects', async () => {
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith('setContext', CONNECTED_CONTEXT_KEY, true);
  });

  it('is offered in the Command Palette only in a connected window, and in the menus of the row of this window', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: {
        commands: Array<{ command: string; title: string }>;
        menus: Record<string, Array<{ command?: string; when?: string }>>;
      };
    };
    expect(manifest.contributes.commands.find((entry) => entry.command === Commands.closeAndKeepRunning)?.title).toBe('Close and Keep Running');
    const when = (menu: string) => manifest.contributes.menus[menu].filter((item) => item.command === Commands.closeAndKeepRunning).map((item) => item.when);
    expect(when('commandPalette')).toEqual([CONNECTED_CONTEXT_KEY]);
    const clause = when('devspaces.more')[0]!;
    expect(when('view/item/context')).toEqual([`view == devspaces.repositories && ${clause}`]);
    const matches = (value: string) => new RegExp(clause.match(/viewItem =~ \/(.*)\/$/)![1]).test(value);
    expect(matches(treeContextValue(rowActions('connected', undefined), 'on', false, true))).toBe(true);
    expect(matches(treeContextValue(rowActions('connected', undefined), 'on', true, true))).toBe(true);
    expect(matches(treeContextValue(rowActions('running', undefined), 'on', false))).toBe(false);
  });
});

describe('Double-click on a repository row', () => {
  /** A row as the view gives it to its command: with the actions of its state. */
  function viewRow(repository: string, env: Devspace | undefined, state?: Parameters<typeof rowActions>[0]): unknown {
    return { ...(row(repository, env) as object), actions: rowActions(state, undefined) };
  }

  /** One click at `at` milliseconds after NOW. */
  async function click(argument: unknown, at: number): Promise<void> {
    h.clock.now = () => NOW + at;
    await run('rowActivated', argument);
  }

  it('is hidden in the Command Palette, as the command of Enter', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: { commands: Array<{ command: string }>; menus: Record<string, Array<{ command?: string; when?: string }>> };
    };
    for (const command of [Commands.rowActivated, Commands.rowEnter]) {
      expect(manifest.contributes.commands.some((entry) => entry.command === command)).toBe(true);
      const entries = manifest.contributes.menus.commandPalette.filter((item) => item.command === command);
      expect(entries.map((item) => item.when)).toEqual(['false']);
      // Only the row itself (or its key) runs it: no menu offers it.
      for (const [menu, items] of Object.entries(manifest.contributes.menus)) {
        if (menu !== 'commandPalette') expect(items.some((item) => item.command === command)).toBe(false);
      }
    }
  });

  it('binds Enter in the view to devspaces.rowEnter (package.json)', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: { keybindings: Array<Record<string, string>> };
    };
    // Also on an owner, a group or a repository with child rows: list.select opens or closes an owner or a group, which
    // have no command, and runs the command of a repository with child rows. A sticky header row at the top of the
    // view (an owner) keeps Enter of VS Code while it has the keyboard focus: Enter reveals that row, as in the
    // keybinding of list.select in VS Code, and never starts the repository row below it.
    expect(manifest.contributes.keybindings.filter((binding) => binding.command === Commands.rowEnter)).toEqual([
      {
        command: Commands.rowEnter,
        key: 'enter',
        when: 'focusedView == devspaces.repositories && listFocus && !inputFocus && !treestickyScrollFocused',
      },
    ]);
  });

  it('forgets the Enter on an owner or a group, which opens or closes it, so that a click right after it only selects', async () => {
    const start = vi.spyOn(h.controller, 'start').mockResolvedValue(undefined);
    // VS Code opens or closes the node, which has no command (TreeView.onDidExpandElement or onDidCollapseElement).
    fakeVscode.commands.executeCommand.mockImplementation(async (command: string) => {
      if (command === 'list.select') h.controller.nodeToggled();
    });
    h.clock.now = () => NOW;
    await run('rowEnter');
    await click(viewRow('acme/api', undefined), 10);
    expect(start).not.toHaveBeenCalled();
  });

  it('runs Start on Enter: devspaces.rowEnter runs list.select, and the activation of the row that follows starts it', async () => {
    const start = vi.spyOn(h.controller, 'start').mockResolvedValue(undefined);
    const argument = viewRow('acme/api', undefined);
    // VS Code selects the focused row and runs its command.
    fakeVscode.commands.executeCommand.mockImplementation(async (command: string) => {
      if (command === 'list.select') await click(argument, 10);
    });
    h.clock.now = () => NOW;
    await run('rowEnter');
    expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith('list.select');
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith({ kind: 'row', repository: 'acme/api', info: undefined, devspaceId: undefined });
    // A click after it only selects the row again.
    await click(argument, 200);
    expect(start).toHaveBeenCalledTimes(1);
  });

  // The Sign in row and the Docker host row run their own command on Enter, not the command of a repository row.
  it('forgets the Enter when the row runs another command of Devspaces, so that a click right after it only selects', async () => {
    const start = vi.spyOn(h.controller, 'start').mockResolvedValue(undefined);
    let rowCommand: string = Commands.signIn;
    fakeVscode.commands.executeCommand.mockImplementation(async (command: string) => {
      if (command === 'list.select') await h.commands.get(rowCommand)?.();
    });
    for (const [command, repository] of [
      [Commands.signIn, 'acme/api'],
      [Commands.chooseDockerHost, 'acme/web'],
    ]) {
      rowCommand = command;
      h.clock.now = () => NOW;
      await run('rowEnter');
      await click(viewRow(repository, undefined), 10);
    }
    expect(h.auth.getToken).toHaveBeenCalledWith({ interactive: true });
    expect(start).not.toHaveBeenCalled();
  });

  // A later VS Code may remove or rename list.select.
  it('logs a failed list.select once per window, without a message, and forgets the Enter', async () => {
    const start = vi.spyOn(h.controller, 'start').mockResolvedValue(undefined);
    fakeVscode.commands.executeCommand.mockImplementation(async (command: string) => {
      if (command === 'list.select') throw new Error("command 'list.select' not found");
    });
    h.clock.now = () => NOW;
    await run('rowEnter');
    await run('rowEnter');
    expect(fakeVscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(fakeVscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(h.logger.error).not.toHaveBeenCalled();
    const logged = h.logger.warn.mock.calls.filter((call: unknown[]) => String(call[0]).includes('list.select'));
    expect(logged).toEqual([[expect.stringContaining("command 'list.select' not found")]]);
    // A click right after it only selects the row.
    await click(viewRow('acme/api', undefined), 10);
    expect(start).not.toHaveBeenCalled();
  });

  it('only selects the row on a single click', async () => {
    const start = vi.spyOn(h.controller, 'start');
    await h.registry.add(devspace());
    await click(viewRow('acme/api', devspace(), 'stopped'), 0);
    expect(start).not.toHaveBeenCalled();
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    expect(fakeVscode.window.createQuickPick).not.toHaveBeenCalled();
  });

  it('runs Start with the row on two clicks of the same row within the interval', async () => {
    const start = vi.spyOn(h.controller, 'start');
    await h.registry.add(devspace());
    const argument = viewRow('acme/api', devspace(), 'stopped');
    await click(argument, 0);
    await click(argument, DOUBLE_CLICK_INTERVAL_MS);
    expect(start).toHaveBeenCalledTimes(1);
    // The same argument as the Start button of the row.
    expect(start).toHaveBeenCalledWith({ kind: 'row', repository: 'acme/api', info: undefined, devspaceId: ENV_ID });
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledWith(ENV_ID, expect.anything());
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
  });

  it('starts nothing on two clicks of different rows', async () => {
    const start = vi.spyOn(h.controller, 'start');
    await click(viewRow('acme/api', undefined), 0);
    await click(viewRow('acme/web', undefined), 100);
    await click(viewRow('acme/api', undefined), 200);
    expect(start).not.toHaveBeenCalled();
    expect(h.service.openInWorker).not.toHaveBeenCalled();
  });

  it('starts nothing on clicks slower than the interval', async () => {
    const start = vi.spyOn(h.controller, 'start');
    const argument = viewRow('acme/api', undefined);
    await click(argument, 0);
    await click(argument, DOUBLE_CLICK_INTERVAL_MS + 1);
    await click(argument, 2 * DOUBLE_CLICK_INTERVAL_MS + 2);
    expect(start).not.toHaveBeenCalled();
  });

  it('starts once on a triple click', async () => {
    const start = vi.spyOn(h.controller, 'start').mockResolvedValue(undefined);
    const argument = viewRow('acme/api', undefined);
    await click(argument, 0);
    await click(argument, 150);
    await click(argument, 300);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('runs Start on the first activation when workbench.list.openMode is doubleClick', async () => {
    h.listOpenMode.value = 'doubleClick';
    const start = vi.spyOn(h.controller, 'start').mockResolvedValue(undefined);
    await click(viewRow('acme/api', undefined), 0);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith({ kind: 'row', repository: 'acme/api', info: undefined, devspaceId: undefined });
    // VS Code sends each double-click once: the next one starts again (Start's own rules decide).
    await click(viewRow('acme/api', undefined), 100);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('starts nothing in the row of the devspace of this window', async () => {
    const start = vi.spyOn(h.controller, 'start');
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    await click(viewRow('acme/api', env, 'connected'), 0);
    await click(viewRow('acme/api', env, 'connected'), 100);
    // Also a row from before the connection, which still shows Start.
    await click(viewRow('acme/api', env, 'stopped'), 1000);
    await click(viewRow('acme/api', env, 'stopped'), 1100);
    expect(start).not.toHaveBeenCalled();
    expect(fakeVscode.window.showInformationMessage).not.toHaveBeenCalled();
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
  });

  it('starts nothing where the row shows no Start (updating)', async () => {
    const start = vi.spyOn(h.controller, 'start');
    await click(viewRow('acme/api', devspace(), 'updating'), 0);
    await click(viewRow('acme/api', devspace(), 'updating'), 100);
    expect(start).not.toHaveBeenCalled();
  });

  describe('a repository with several sources', () => {
    /** The node of acme/api with its child rows, as the view gives it to its command. */
    function viewNode(...children: unknown[]): unknown {
      return { kind: 'repositoryNode', id: 'repo:acme/api', repository: 'acme/api', children };
    }
    const child = (source: DevspaceSource, env?: Devspace, state?: Parameters<typeof rowActions>[0]): unknown => ({
      ...(row('acme/api', env, undefined, source) as object),
      id: `repo:acme/api:${source.kind}`,
      actions: rowActions(state, undefined),
    });

    it('starts its first child row on a double-click: the default image while startWithDefaultImage is on', async () => {
      const start = vi.spyOn(h.controller, 'start').mockResolvedValue(undefined);
      const node = viewNode(child(DEFAULT_SOURCE), child(ROOT_SOURCE));
      await click(node, 0);
      expect(start).not.toHaveBeenCalled();
      await click(node, 100);
      expect(start).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledWith({ kind: 'row', repository: 'acme/api', info: undefined, devspaceId: undefined, source: DEFAULT_SOURCE });
    });

    it('starts the first configuration while startWithDefaultImage is off (the default image is the last row)', async () => {
      const start = vi.spyOn(h.controller, 'start').mockResolvedValue(undefined);
      const env = devspace({ configPath: ROOT_SOURCE.configPath });
      await h.registry.add(env);
      const node = viewNode(child(ROOT_SOURCE, env, 'stopped'), child(PYTHON_SOURCE), child(DEFAULT_SOURCE));
      await click(node, 0);
      await click(node, 100);
      expect(start).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledWith({ kind: 'row', repository: 'acme/api', info: undefined, devspaceId: ENV_ID, source: ROOT_SOURCE });
    });

    it('starts its first child row on Enter at once', async () => {
      const start = vi.spyOn(h.controller, 'start').mockResolvedValue(undefined);
      const node = viewNode(child(DEFAULT_SOURCE), child(ROOT_SOURCE));
      fakeVscode.commands.executeCommand.mockImplementation(async (command: string) => {
        if (command === 'list.select') await click(node, 10);
      });
      h.clock.now = () => NOW;
      await run('rowEnter');
      expect(start).toHaveBeenCalledWith({ kind: 'row', repository: 'acme/api', info: undefined, devspaceId: undefined, source: DEFAULT_SOURCE });
    });

    it('starts nothing where its first child row shows no Start, and counts no double-click across the node and a child', async () => {
      const start = vi.spyOn(h.controller, 'start');
      const updating = viewNode(child(DEFAULT_SOURCE, devspace(), 'updating'), child(ROOT_SOURCE));
      await click(updating, 0);
      await click(updating, 100);
      const first = child(DEFAULT_SOURCE);
      await click(viewNode(first, child(ROOT_SOURCE)), 1000);
      await click(first, 1100);
      expect(start).not.toHaveBeenCalled();
      expect(h.revealRow).not.toHaveBeenCalled();
    });

    it('shows the child row that starts (VS Code also opens or closes the node on a double-click), never a repository row', async () => {
      const start = vi.spyOn(h.controller, 'start').mockResolvedValue(undefined);
      const node = viewNode(child(DEFAULT_SOURCE), child(ROOT_SOURCE));
      await click(node, 0);
      expect(h.revealRow).not.toHaveBeenCalled();
      await click(node, 100);
      expect(h.revealRow.mock.calls).toEqual([['repo:acme/api:defaultImage']]);
      // A double-click on a repository row is on the row itself.
      const config = child(ROOT_SOURCE);
      await click(config, 1000);
      await click(config, 1100);
      expect(start).toHaveBeenCalledTimes(2);
      expect(h.revealRow).toHaveBeenCalledTimes(1);
      // A row that the view no longer has: the start runs all the same, and nothing is left unhandled.
      const unhandled: unknown[] = [];
      const listener = (reason: unknown): void => void unhandled.push(reason);
      process.on('unhandledRejection', listener);
      try {
        h.revealRow.mockRejectedValueOnce(new Error('Cannot resolve tree item'));
        await click(node, 2000);
        await click(node, 2100);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(start).toHaveBeenCalledTimes(3);
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', listener);
      }
    });
  });

  it('ignores an argument that is no repository row', async () => {
    const start = vi.spyOn(h.controller, 'start');
    for (const argument of [undefined, { kind: 'owner', id: 'owner:acme' }, { kind: 'hint', id: 'hint:acme' }, { devspaceId: ENV_ID }]) {
      await click(argument, 0);
      await click(argument, 100);
    }
    expect(start).not.toHaveBeenCalled();
  });
});

describe('A link to Devspaces', () => {
  /** The link vscode://nimblescape.nimblescape-devspaces-2/open?repository=<repository>, as vscode.Uri gives it. */
  const link = (repository: string) => ({ path: '/open', query: `repository=${repository}` });
  /** The question before a link creates a devspace: linkStartConfirm, or for another owner untrustedRepository. */
  const isLinkQuestion = (message: string) => message.includes(' from a link? ') || message.endsWith(Messages.untrustedRepository(''));
  const linkQuestions = () => warningMessages().filter(isLinkQuestion);

  // The question is answered with Open, unless a test answers otherwise.
  beforeEach(() => {
    fakeVscode.window.showWarningMessage.mockImplementation(async (message: string) => (isLinkQuestion(message) ? Actions.open : undefined));
  });

  it('starts the extension for a link (activation event onUri)', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { activationEvents: string[] };
    expect(manifest.activationEvents).toContain('onUri');
  });

  it('starts a listed repository from its first source, as a double-click does, after the question of the link', async () => {
    h.sidebar.infos.set('acme/api', repositoryInfo('acme/api', { configPaths: ['.devcontainer/devcontainer.json', '.devcontainer/python/devcontainer.json'] }));
    h.settings.defaultImage = DEFAULT_IMAGE;
    await h.controller.openLink(link('acme/api'));
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledWith(ControllerTexts.linkStartConfirm('acme/api'), { modal: true }, Actions.open, ControllerTexts.alwaysOpen);
    // The user answered the question of the link: the pipeline asks no question of its own (trusted).
    expect(h.service.openInWorker).toHaveBeenLastCalledWith(expect.objectContaining({ repository: 'acme/api', trusted: true }), expect.objectContaining({ source: DEFAULT_SOURCE }));
    h.settings.startWithDefaultImage = false;
    await h.controller.openLink(link('acme/api'));
    expect(h.service.openInWorker).toHaveBeenLastCalledWith(expect.objectContaining({ repository: 'acme/api' }), expect.objectContaining({ source: ROOT_SOURCE }));
    expect(h.discovery.getRepository).not.toHaveBeenCalled();
    expect(fakeVscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(warningMessages()).toEqual([ControllerTexts.linkStartConfirm('acme/api'), ControllerTexts.linkStartConfirm('acme/api')]);
  });

  it('creates no devspace and starts no Docker work when the question is not answered with Open', async () => {
    h.sidebar.infos.set('acme/api', repositoryInfo('acme/api'));
    fakeVscode.window.showWarningMessage.mockResolvedValue(undefined);
    await h.controller.openLink(link('acme/api'));
    h.sidebar.trustedOwner.mockResolvedValue(false);
    await h.controller.openLink(link('acme/api'));
    expect(linkQuestions()).toEqual([ControllerTexts.linkStartConfirm('acme/api'), Messages.untrustedRepository('acme/api')]);
    expect(h.logger.info).toHaveBeenCalledWith('The start of acme/api from the link was not confirmed.');
    expect(h.service.openInWorker).not.toHaveBeenCalled();
    // Not even the question about the Monitor of the engine (beforeUserFlow), which comes before the pipeline.
    expect(h.monitorQuestion.askIfNeeded).not.toHaveBeenCalled();
    expect(h.connection.openInNewWindow).not.toHaveBeenCalled();
  });

  describe('Always Open', () => {
    /** The user settings of the section devspaces: the writes. */
    function userSettings(): { update: ReturnType<typeof vi.fn> } {
      const configuration = { update: vi.fn(async () => undefined) };
      fakeVscode.workspace.getConfiguration.mockReturnValue(configuration);
      return configuration;
    }

    it('opens, and turns off the question of the link in the user settings', async () => {
      const settings = userSettings();
      h.sidebar.infos.set('acme/api', repositoryInfo('acme/api'));
      fakeVscode.window.showWarningMessage.mockImplementation(async (message: string) => (isLinkQuestion(message) ? ControllerTexts.alwaysOpen : undefined));
      await h.controller.openLink(link('acme/api'));
      expect(fakeVscode.workspace.getConfiguration).toHaveBeenCalledWith(SETTINGS_SECTION);
      expect(settings.update).toHaveBeenCalledWith('confirmOpenFromLink', false, fakeVscode.ConfigurationTarget.Global);
      // The setting is written before any Docker work, and the start goes on as after Open.
      expect(settings.update.mock.invocationCallOrder[0]).toBeLessThan(h.service.openInWorker.mock.invocationCallOrder[0] ?? 0);
      expect(h.service.openInWorker).toHaveBeenCalledWith(expect.objectContaining({ repository: 'acme/api', trusted: true }), expect.objectContaining({ source: ROOT_SOURCE }));
      expect(h.logger.info).toHaveBeenCalledWith(expect.stringContaining('the setting confirmOpenFromLink is off. Turn it on to get the question again.'));
    });

    it('does not write the setting after Open', async () => {
      const settings = userSettings();
      h.sidebar.infos.set('acme/api', repositoryInfo('acme/api'));
      await h.controller.openLink(link('acme/api'));
      expect(h.service.openInWorker).toHaveBeenCalledTimes(1);
      expect(settings.update).not.toHaveBeenCalled();
    });

    it('opens also when the setting cannot be written, and says so in the log', async () => {
      const settings = userSettings();
      settings.update.mockRejectedValue(new Error('settings.json is read-only'));
      h.sidebar.infos.set('acme/api', repositoryInfo('acme/api'));
      fakeVscode.window.showWarningMessage.mockImplementation(async (message: string) => (isLinkQuestion(message) ? ControllerTexts.alwaysOpen : undefined));
      await h.controller.openLink(link('acme/api'));
      expect(h.logger.warn).toHaveBeenCalledWith('The setting confirmOpenFromLink could not be turned off, so the next link asks again: settings.json is read-only');
      expect(h.service.openInWorker).toHaveBeenCalledTimes(1);
      expect(fakeVscode.window.showErrorMessage).not.toHaveBeenCalled();
    });

    it('with the setting off, creates the devspace of the account or of its organizations without the question', async () => {
      h.settings.confirmOpenFromLink = false;
      h.sidebar.infos.set('acme/api', repositoryInfo('acme/api'));
      await h.controller.openLink(link('acme/api'));
      expect(linkQuestions()).toEqual([]);
      expect(h.logger.info).toHaveBeenCalledWith('The link creates the devspace of acme/api without a question: the setting confirmOpenFromLink is off.');
      expect(h.service.openInWorker).toHaveBeenCalledWith(expect.objectContaining({ repository: 'acme/api', trusted: true }), expect.objectContaining({ source: ROOT_SOURCE }));
    });

    // Any website can show a link: the setting never skips the confirmation of a repository of another owner, and that
    // confirmation has no button that turns it off.
    it('with the setting off, still asks for a repository of another owner, without the button', async () => {
      h.settings.confirmOpenFromLink = false;
      h.sidebar.trustedOwner.mockResolvedValue(false);
      h.sidebar.infos.set('other/tool', repositoryInfo('other/tool'));
      await h.controller.openLink(link('other/tool'));
      expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledWith(Messages.untrustedRepository('other/tool'), { modal: true }, Actions.open);
      expect(linkQuestions()).toEqual([Messages.untrustedRepository('other/tool')]);
      expect(h.service.openInWorker).toHaveBeenCalledTimes(1);
      // Cancel: nothing starts.
      fakeVscode.window.showWarningMessage.mockResolvedValue(undefined);
      await h.controller.openLink(link('other/tool'));
      expect(h.service.openInWorker).toHaveBeenCalledTimes(1);
    });

    it('reads the setting as a user setting only, on by default (package.json)', () => {
      const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
        contributes: { configuration: { properties: Record<string, { default?: unknown; scope?: string; type?: string; markdownDescription?: string }> } };
      };
      const property = manifest.contributes.configuration.properties[`${SETTINGS_SECTION}.confirmOpenFromLink`];
      expect(property).toMatchObject({ type: 'boolean', default: true, scope: 'application' });
      expect(DEFAULT_SETTINGS.confirmOpenFromLink).toBe(true);
      expect(property?.markdownDescription).toContain(`**${ControllerTexts.alwaysOpen}**`);
    });
  });

  it('asks GitHub for a repository that the list does not show, and starts it with its name and data from GitHub', async () => {
    h.sidebar.trustedOwner.mockResolvedValue(false);
    h.discovery.getRepository.mockResolvedValue(repositoryInfo('majikmate/classroom', { defaultBranch: 'trunk', configPaths: ['.devcontainer/web/devcontainer.json'] }));
    await h.controller.openLink(link('MajikMate/Classroom'));
    // The token of the account, without a dialog.
    expect(h.auth.getToken).toHaveBeenCalledWith({ interactive: false, account: ACCOUNT });
    expect(h.discovery.getRepository).toHaveBeenCalledWith('MajikMate/Classroom', 'gho_token');
    // The owner is neither the account nor one of its organizations: the link asks for the confirmation of every first
    // open before any Docker work, and the pipeline asks it no second time (trusted: true).
    expect(h.sidebar.trustedOwner).toHaveBeenCalledWith('majikmate');
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledWith(Messages.untrustedRepository('majikmate/classroom'), { modal: true }, Actions.open);
    expect(linkQuestions()).toEqual([Messages.untrustedRepository('majikmate/classroom')]);
    expect(h.service.openInWorker).toHaveBeenCalledWith(
      { repository: 'majikmate/classroom', defaultBranch: 'trunk', configPaths: ['.devcontainer/web/devcontainer.json'], trusted: true },
      expect.objectContaining({ source: { kind: 'configuration', configPath: '.devcontainer/web/devcontainer.json' } }),
    );
  });

  it('opens the devspace in a new window, and only in an empty window in that window', async () => {
    h.sidebar.infos.set('acme/api', repositoryInfo('acme/api'));
    await h.controller.openLink(link('acme/api'));
    expect(h.connection.openInNewWindow).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
    expect(h.connection.open).not.toHaveBeenCalled();
    h.connection.isEmptyWindow.mockReturnValue(true);
    await h.controller.openLink(link('acme/api'));
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
    expect(h.connection.openInNewWindow).toHaveBeenCalledTimes(1);
    // The setting openInNewWindow does not change it.
    h.settings.openInNewWindow = true;
    await h.controller.openLink(link('acme/api'));
    expect(h.connection.open).toHaveBeenCalledTimes(2);
  });

  it('opens the devspace of the repository when it has one', async () => {
    h.sidebar.infos.set('acme/api', repositoryInfo('acme/api'));
    await h.registry.add(devspace());
    await h.controller.openLink(link('acme/api'));
    expect(h.service.openInWorker).not.toHaveBeenCalled();
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledWith(ENV_ID, expect.objectContaining({ source: ROOT_SOURCE }));
    // An existing devspace opens without the question of the link.
    expect(linkQuestions()).toEqual([]);
  });

  it('opens the devspace that was used last, not the first source, of a repository with several sources', async () => {
    h.sidebar.infos.set('acme/api', repositoryInfo('acme/api', { configPaths: ['.devcontainer/devcontainer.json', '.devcontainer/python/devcontainer.json'] }));
    h.settings.defaultImage = DEFAULT_IMAGE;
    await h.registry.add(devspace({ configPath: '.devcontainer/python/devcontainer.json', lastUsedAt: iso(NOW - 1000) }));
    await h.registry.add(devspace({ id: OTHER_ENV_ID, volumeName: 'other', containerName: 'other', lastUsedAt: iso(NOW - 90_000_000) }));
    await h.controller.openLink(link('acme/api'));
    expect(h.service.openInWorker).not.toHaveBeenCalled();
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledWith(ENV_ID, expect.objectContaining({ source: PYTHON_SOURCE }));
  });

  it('opens the devspace of a repository that GitHub could not be asked for, but not of one that GitHub does not show', async () => {
    await h.registry.add(devspace());
    h.discovery.getRepository.mockRejectedValueOnce(new Error('rate limit'));
    await h.controller.openLink(link('Acme/API'));
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledTimes(1);
    expect(h.service.openDevspaceInWorker).toHaveBeenLastCalledWith(ENV_ID, expect.objectContaining({ source: ROOT_SOURCE }));
    expect(h.logger.info).toHaveBeenCalledWith('Without the data of GitHub, the link opens the devspace of acme/api that was used last.');
    expect(warningMessages()).toEqual([]);
    // GitHub answers that the account cannot see the repository (any more): the link opens nothing.
    await h.controller.openLink(link('acme/api'));
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledTimes(1);
    expect(warningMessages()).toEqual([ControllerTexts.linkRepositoryNotFound('acme/api')]);
  });

  it('asks for a new sign-in when GitHub rejects the token, and opens the link with it', async () => {
    h.discovery.getRepository.mockRejectedValueOnce(new GitHubApiError('Bad credentials', 401));
    h.discovery.getRepository.mockResolvedValueOnce(repositoryInfo('acme/api'));
    h.auth.renewToken.mockImplementationOnce(async () => {
      h.auth.getToken.mockResolvedValue('gho_new');
      return 'gho_new';
    });
    await h.controller.openLink(link('acme/api'));
    expect(h.discovery.getRepository.mock.calls).toEqual([['acme/api', 'gho_token'], ['acme/api', 'gho_new']]);
    expect(h.service.openInWorker).toHaveBeenCalledWith(expect.objectContaining({ repository: 'acme/api' }), expect.objectContaining({ source: ROOT_SOURCE }));
    // A cancelled new sign-in opens nothing.
    h.discovery.getRepository.mockRejectedValueOnce(new GitHubApiError('Bad credentials', 401));
    await h.controller.openLink(link('acme/web'));
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledWith(Messages.signInRequired, Actions.signIn);
    expect(h.service.openInWorker).toHaveBeenCalledTimes(1);
  });

  // The automatic reopen of the last devspace runs a few seconds after the start of an empty window; VS Code started by
  // a click on a link opens such a window. Mutation: a link that holds no request while it asks fails it.
  it('holds back the automatic reopen in an empty window while the link asks for the sign-in', async () => {
    await h.registry.add(devspace());
    h.sessionFiles.writeReopenSync({ devspaceId: ENV_ID, closedAt: iso(NOW - 60_000) });
    h.connection.isEmptyWindow.mockReturnValue(true);
    // Devspaces uses no account yet: the link asks for the sign-in.
    const signIn = deferred<GitHubAccount | undefined>();
    h.auth.accounts.mockResolvedValueOnce([]);
    h.auth.getAccount.mockImplementationOnce(() => signIn.promise);
    const opening = h.controller.openLink(link('acme/web'));
    await settle(() => interactiveSignIns() === 1, 'the sign-in');
    await h.controller.runEmptyWindowTasks();
    expect(h.logger.info).toHaveBeenCalledWith('The last devspace is not opened: another devspace is opening in this window.');
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    signIn.resolve(undefined);
    await opening;
    // The link ended: the reopen runs again.
    await h.controller.runEmptyWindowTasks();
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledWith(ENV_ID, expect.anything());
  });

  // Mutation: a link that takes a connect request (reserveConnectRequest) while it asks fails it: the Start, older,
  // does not connect then, and the link opens nothing.
  it('does not stop a Start in this window while the link asks for the sign-in', async () => {
    await h.registry.add(devspace());
    h.connection.isEmptyWindow.mockReturnValue(true);
    const pipeline = deferred<OpenResult>();
    h.service.openDevspaceInWorker.mockReturnValueOnce(pipeline.promise);
    const starting = run('start', row('acme/api', devspace()));
    await settle(() => h.service.openDevspaceInWorker.mock.calls.length === 1, 'the pipeline');
    // Devspaces uses no account (a sign-out meanwhile): the link asks for the sign-in.
    const signIn = deferred<GitHubAccount | undefined>();
    const signIns = interactiveSignIns();
    h.auth.accounts.mockResolvedValueOnce([]);
    h.auth.getAccount.mockImplementationOnce(() => signIn.promise);
    const opening = h.controller.openLink(link('acme/web'));
    await settle(() => interactiveSignIns() > signIns, 'the sign-in of the link');
    pipeline.resolve(openResult(devspace()));
    await starting;
    expect(h.connection.open).toHaveBeenCalledTimes(1);
    signIn.resolve(undefined);
    await opening;
    expect(warningMessages()).toEqual([Messages.signInRequired]);
  });

  // A link that arrives after the check of the reopen (VS Code asked whether Devspaces may open it) asks its question
  // while the reopen runs: the reopen does not reload the window under it.
  it('keeps the automatic reopen from connecting this window while the link asks its question', async () => {
    await h.registry.add(devspace());
    h.sessionFiles.writeReopenSync({ devspaceId: ENV_ID, closedAt: iso(NOW - 60_000) });
    h.connection.isEmptyWindow.mockReturnValue(true);
    const pipeline = deferred<OpenResult>();
    h.service.openDevspaceInWorker.mockReturnValueOnce(pipeline.promise);
    const reopening = h.controller.runEmptyWindowTasks();
    await settle(() => h.service.openDevspaceInWorker.mock.calls.length === 1, 'the reopen');
    const question = deferred<string | undefined>();
    fakeVscode.window.showWarningMessage.mockReturnValueOnce(question.promise);
    h.sidebar.infos.set('acme/web', repositoryInfo('acme/web'));
    const opening = h.controller.openLink(link('acme/web'));
    await settle(() => linkQuestions().length === 1, 'the question of the link');
    pipeline.resolve(openResult(devspace()));
    await reopening;
    expect(h.logger.info).toHaveBeenCalledWith('acme/api is not connected: a link to Devspaces is opening in this window.');
    expect(h.connection.open).not.toHaveBeenCalled();
    question.resolve(undefined);
    await opening;
    expect(h.service.openInWorker).not.toHaveBeenCalled();
  });

  // VS Code gives a link to the extension at its activation; the window then may not know its role and its devspace yet.
  it('waits for the end of the activation, also of one that failed', async () => {
    h.sidebar.infos.set('acme/api', repositoryInfo('acme/api'));
    h.auth.accounts.mockClear();
    for (const end of ['resolve', 'reject'] as const) {
      const activation = deferred<void>();
      h.controller.setActivation(activation.promise);
      const opening = h.controller.openLink(link('acme/api'));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(h.auth.accounts).not.toHaveBeenCalled();
      if (end === 'resolve') activation.resolve();
      else activation.reject(new Error('activation failed'));
      await opening;
      expect(h.auth.accounts).toHaveBeenCalled();
      h.auth.accounts.mockClear();
    }
    expect(h.service.openInWorker).toHaveBeenCalledTimes(2);
  });

  it('opens nothing and asks nobody for a link that names no repository', async () => {
    await h.controller.openLink({ path: '/open', query: 'repository=acme/api/../x' });
    await h.controller.openLink({ path: '/start', query: 'repository=acme/api' });
    expect(warningMessages()).toEqual([ControllerTexts.invalidLink, ControllerTexts.invalidLink]);
    expect(h.logger.info).toHaveBeenCalledWith('A link to Devspaces was not opened: its path is not /open or /course.');
    expect(h.auth.getSession).not.toHaveBeenCalled();
    expect(h.discovery.getRepository).not.toHaveBeenCalled();
    expect(h.service.openInWorker).not.toHaveBeenCalled();
  });

  it('opens nothing when GitHub does not show the repository to the account', async () => {
    await h.controller.openLink(link('acme/secret'));
    expect(warningMessages()).toEqual([ControllerTexts.linkRepositoryNotFound('acme/secret')]);
    expect(h.service.openInWorker).not.toHaveBeenCalled();
  });

  it('opens nothing when GitHub could not be asked, and offers the log', async () => {
    h.discovery.getRepository.mockRejectedValue(new Error('rate limit'));
    await h.controller.openLink(link('acme/api'));
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledWith(ControllerTexts.linkRepositoryUnknown('acme/api'), Actions.showDetails);
    expect(h.logger.warn).toHaveBeenCalledWith('GitHub could not be asked for acme/api with octo: rate limit');
    expect(h.service.openInWorker).not.toHaveBeenCalled();
  });

  it('opens nothing for a repository without a configuration while no default image is set', async () => {
    h.discovery.getRepository.mockResolvedValue(repositoryInfo('acme/plain', { configPaths: [] }));
    await h.controller.openLink(link('acme/plain'));
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(Messages.noConfiguration('acme/plain'));
    expect(h.service.openInWorker).not.toHaveBeenCalled();
    // With a default image, the repository starts from it.
    h.settings.defaultImage = DEFAULT_IMAGE;
    await h.controller.openLink(link('acme/plain'));
    expect(h.service.openInWorker).toHaveBeenCalledWith(expect.objectContaining({ repository: 'acme/plain', configPaths: [] }), expect.objectContaining({ source: DEFAULT_SOURCE }));
  });

  it('opens nothing without a sign-in, also for a listed repository', async () => {
    h.auth.getAccount.mockResolvedValue(undefined);
    await h.controller.openLink(link('acme/api'));
    h.sidebar.infos.set('acme/api', repositoryInfo('acme/api'));
    await h.controller.openLink(link('acme/api'));
    expect(h.auth.getAccount).toHaveBeenCalledWith({ interactive: true });
    expect(warningMessages()).toEqual([Messages.signInRequired, Messages.signInRequired]);
    expect(h.discovery.getRepository).not.toHaveBeenCalled();
    expect(h.service.openInWorker).not.toHaveBeenCalled();
  });
});

// The course link opens the repository of the signed-in account in a course, as GitHub Classroom names it: the name
// of the course repository and the GitHub login of the account (ACCOUNT, octo).
describe('A course link to Devspaces', () => {
  /** The link vscode://nimblescape.nimblescape-devspaces-2/course?repository=<repository>, as vscode.Uri gives it. */
  const courseLink = (repository: string) => ({ path: '/course', query: `repository=${repository}` });
  const isLinkQuestion = (message: string) => message.includes(' from a link? ') || message.endsWith(Messages.untrustedRepository(''));

  beforeEach(() => {
    fakeVscode.window.showWarningMessage.mockImplementation(async (message: string) => (isLinkQuestion(message) ? Actions.open : undefined));
  });

  it('starts the repository of the course with the login of the account, after the question of the link', async () => {
    h.sidebar.trustedOwner.mockResolvedValue(false);
    h.discovery.getRepository.mockImplementation(async (repository: string) => repositoryInfo(repository.toLowerCase()));
    await h.controller.openLink(courseLink('MySchool/module-ts-2-<username>'));
    expect(h.auth.getToken).toHaveBeenCalledWith({ interactive: false, account: ACCOUNT });
    expect(h.discovery.getRepository).toHaveBeenCalledWith('MySchool/module-ts-2-octo', 'gho_token');
    expect(h.logger.info).toHaveBeenCalledWith('A course link asks to open MySchool/module-ts-2-<username> with the GitHub login of the account.');
    expect(h.logger.info).toHaveBeenCalledWith('The course link opens MySchool/module-ts-2-octo for octo.');
    // The organization of a course is often not one of the account: the confirmation of every first open.
    expect(warningMessages()).toEqual([Messages.untrustedRepository('myschool/module-ts-2-octo')]);
    expect(h.service.openInWorker).toHaveBeenLastCalledWith(expect.objectContaining({ repository: 'myschool/module-ts-2-octo', trusted: true }), expect.objectContaining({ source: ROOT_SOURCE }));
    // Without the placeholder, the link adds `-<username>` at the end of the name.
    await h.controller.openLink(courseLink('MySchool/module-ts-2'));
    expect(h.discovery.getRepository).toHaveBeenLastCalledWith('MySchool/module-ts-2-octo', 'gho_token');
    expect(h.service.openInWorker).toHaveBeenCalledTimes(2);
  });

  it('opens the devspace of the repository of the course when the account has one', async () => {
    h.sidebar.infos.set('acme/api-octo', repositoryInfo('acme/api-octo', { access: [{ account: ACCOUNT }] }));
    await h.registry.add(devspace({ repository: 'acme/api-octo' }));
    await h.controller.openLink(courseLink('acme/api-<username>'));
    expect(h.discovery.getRepository).not.toHaveBeenCalled();
    expect(h.service.openInWorker).not.toHaveBeenCalled();
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledWith(ENV_ID, expect.objectContaining({ source: ROOT_SOURCE }));
    expect(warningMessages()).toEqual([]);
  });

  it('asks GitHub with the account about a repository of the course that the sidebar found with another token', async () => {
    // A lookup of the sidebar (a devspace of another account) names no account with access.
    h.sidebar.infos.set('acme/api-octo', repositoryInfo('acme/api-octo'));
    await h.controller.openLink(courseLink('acme/api-<username>'));
    expect(h.discovery.getRepository).toHaveBeenCalledWith('acme/api-octo', 'gho_token');
    expect(warningMessages()).toEqual([ControllerTexts.courseRepositoryNotFound('acme/api-octo', 'octo')]);
  });

  it('asks nobody without a sign-in, because the login is not known', async () => {
    h.auth.getAccount.mockResolvedValue(undefined);
    await h.controller.openLink(courseLink('acme/api-<username>'));
    expect(h.auth.getAccount).toHaveBeenCalledWith({ interactive: true });
    expect(warningMessages()).toEqual([Messages.signInRequired]);
    expect(h.discovery.getRepository).not.toHaveBeenCalled();
    expect(h.service.openInWorker).not.toHaveBeenCalled();
  });

  it('says that the account has no repository of the course when GitHub does not show it', async () => {
    await h.controller.openLink(courseLink('acme/api-<username>'));
    expect(h.discovery.getRepository).toHaveBeenCalledWith('acme/api-octo', 'gho_token');
    expect(warningMessages()).toEqual([ControllerTexts.courseRepositoryNotFound('acme/api-octo', 'octo')]);
    expect(h.service.openInWorker).not.toHaveBeenCalled();
  });

  it('asks the account whose token GitHub rejected for a new sign-in, and asks GitHub again with its new token', async () => {
    h.discovery.getRepository.mockRejectedValueOnce(new GitHubApiError('Bad credentials', 401));
    h.discovery.getRepository.mockResolvedValueOnce(repositoryInfo('acme/api-octo'));
    h.auth.renewToken.mockImplementationOnce(async () => {
      h.auth.getToken.mockResolvedValue('gho_new');
      return 'gho_new';
    });
    await h.controller.openLink(courseLink('acme/api-<username>'));
    // The new sign-in is one of the same account (auth.ts refuses another one), so the login in the name stays.
    expect(h.auth.renewToken).toHaveBeenCalledWith(ACCOUNT);
    expect(h.discovery.getRepository.mock.calls).toEqual([['acme/api-octo', 'gho_token'], ['acme/api-octo', 'gho_new']]);
    expect(h.service.openInWorker).toHaveBeenCalledWith(expect.objectContaining({ repository: 'acme/api-octo' }), expect.objectContaining({ source: ROOT_SOURCE, account: ACCOUNT }));
  });

  it('opens nothing when the name with the login is longer than GitHub allows', async () => {
    const login = 'a'.repeat(39);
    h.auth.getAccount.mockResolvedValue({ id: '3003', login });
    const name = 'b'.repeat(70);
    await h.controller.openLink(courseLink(`acme/${name}`));
    expect(h.logger.info).toHaveBeenCalledWith(`The course link acme/${name}-<username> names no GitHub repository with the login ${login}.`);
    expect(warningMessages()).toEqual([ControllerTexts.courseLinkInvalidForLogin([login])]);
    expect(h.discovery.getRepository).not.toHaveBeenCalled();
    expect(h.service.openInWorker).not.toHaveBeenCalled();
  });

  it('opens nothing and asks nobody for a course link that names no repository', async () => {
    await h.controller.openLink(courseLink('<username>/api'));
    expect(warningMessages()).toEqual([ControllerTexts.invalidLink]);
    expect(h.logger.info).toHaveBeenCalledWith('A link to Devspaces was not opened: its parameter repository is not a GitHub repository owner/name-<username>.');
    expect(h.auth.getSession).not.toHaveBeenCalled();
  });
});

// The recorded state may be older than the last use of the devspace (its release was lost, or the Monitor
// stopped it by the long limit); Delete's confirmation says that later changes are not known. Only a message: nothing
// more runs for it.
describe('Delete: a recorded state older than the last use', () => {
  const at = (ms: number) => new Date(ms).toLocaleString();

  it('names the time of the recorded state when the devspace was used after it (the container did not run)', async () => {
    const env = devspace({
      lastUsedAt: iso(NOW - 600_000),
      gitSummary: { branch: 'main', uncommittedFiles: 0, unpushedCommits: 0, stashes: 0, recordedAt: iso(NOW - 3_600_000) },
    });
    await h.registry.add(env);
    h.service.safetyCheck.mockResolvedValue(env.gitSummary);
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.delete);
    await run('delete', row('acme/api', env));
    expect(fakeVscode.window.showWarningMessage.mock.calls[0]).toEqual([
      `${Messages.deleteConfirm('acme/api')} ${Messages.deleteChangesUnknownSince(at(NOW - 3_600_000))}`,
      { modal: true },
      Actions.delete,
    ]);
    expect(h.service.deleteInWorker).toHaveBeenCalled();
  });

  it('also with recorded changes, and without any recorded state since the last open', async () => {
    const old = { branch: 'main', uncommittedFiles: 2, unpushedCommits: 0, stashes: 0, recordedAt: iso(NOW - 3_600_000) };
    await h.registry.add(devspace({ lastUsedAt: iso(NOW - 600_000), gitSummary: old }));
    h.service.safetyCheck.mockResolvedValue(old);
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(undefined);
    await run('delete', row('acme/api', devspace()));
    expect(fakeVscode.window.showWarningMessage.mock.calls[0][0]).toBe(
      `${Messages.deleteUnsaved('acme/api', '2 uncommitted')} ${Messages.deleteChangesUnknownSince(at(NOW - 3_600_000))}`,
    );
    // Nothing recorded at all (safetyCheck has nothing, nor has the registry).
    fakeVscode.window.showWarningMessage.mockReset();
    await h.registry.updateDevspace(ENV_ID, (entry) => {
      delete entry.gitSummary;
    });
    h.service.safetyCheck.mockResolvedValue(undefined);
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(undefined);
    await run('delete', row('acme/api', devspace()));
    expect(fakeVscode.window.showWarningMessage.mock.calls[0][0]).toBe(`${Messages.deleteConfirm('acme/api')} ${Messages.deleteChangesNotRecorded}`);
  });

  it('says nothing more for a state recorded at or after the last use (a running container was checked just now)', async () => {
    await h.registry.add(devspace({ lastUsedAt: iso(NOW - 600_000) }));
    h.service.safetyCheck.mockResolvedValue({ branch: 'main', uncommittedFiles: 0, unpushedCommits: 0, stashes: 0, recordedAt: iso(NOW) });
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(undefined);
    await run('delete', row('acme/api', devspace()));
    expect(fakeVscode.window.showWarningMessage.mock.calls[0][0]).toBe(Messages.deleteConfirm('acme/api'));
  });

  // A reload or a release moves the last use (lastSeenInUseAt), not only the open.
  it('compares with the last time a window was seen using it (a reload after the last open), not only the open', async () => {
    const recorded = { branch: 'main', uncommittedFiles: 0, unpushedCommits: 0, stashes: 0, recordedAt: iso(NOW - 3_600_000) };
    // Opened before the state was recorded, but seen in use after it (a reload): later changes are not known.
    await h.registry.add(devspace({ lastUsedAt: iso(NOW - 7_200_000), lastSeenInUseAt: iso(NOW - 600_000), gitSummary: recorded }));
    h.service.safetyCheck.mockResolvedValue(recorded);
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(undefined);
    await run('delete', row('acme/api', devspace()));
    expect(fakeVscode.window.showWarningMessage.mock.calls[0][0]).toBe(
      `${Messages.deleteConfirm('acme/api')} ${Messages.deleteChangesUnknownSince(at(NOW - 3_600_000))}`,
    );
    // Seen in use last before the state was recorded (the release recorded it): nothing more.
    fakeVscode.window.showWarningMessage.mockReset();
    await h.registry.updateDevspace(ENV_ID, (entry) => {
      entry.lastSeenInUseAt = iso(NOW - 3_700_000);
    });
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(undefined);
    await run('delete', row('acme/api', devspace()));
    expect(fakeVscode.window.showWarningMessage.mock.calls[0][0]).toBe(Messages.deleteConfirm('acme/api'));
    expect(h.service.deleteInWorker).not.toHaveBeenCalled();
  });
});

// Mutation probes of the Delete command.
describe('the Delete command sends the check to the worker', () => {
  it('the check runs cancellable, with the signal of its progress and the name that the user sees', async () => {
    await h.registry.add(devspace());
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(undefined);
    await run('delete', row('acme/api', devspace(), repositoryInfo('Acme/API')));
    const [, options] = h.service.deleteCheckInWorker.mock.calls[0];
    expect(options).toMatchObject({ repository: 'Acme/API', otherWindow: false });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    // The only progress: the check (the dismissed confirmation deletes nothing).
    expect(fakeVscode.window.withProgress.mock.calls.map((call: unknown[]) => call[0])).toEqual([expect.objectContaining({ cancellable: true })]);
  });
});

// Several GitHub accounts of VS Code that Devspaces uses at the same time (docs/security.md "Accounts"): ACCOUNT (octo)
// and OTHER_ACCOUNT (someone), each with its own token.
describe('Several GitHub accounts', () => {
  const OTHER_TOKEN = 'gho_other';
  const tokenOf = (options?: { account?: GitHubAccount }) => (options?.account?.id === OTHER_ACCOUNT.id ? OTHER_TOKEN : 'gho_token');
  const link = (repository: string) => ({ path: '/open', query: `repository=${repository}` });
  const courseLink = (repository: string) => ({ path: '/course', query: `repository=${repository}` });
  /** A repository that both accounts can access, as the merged list of the sidebar gives it. */
  const shared = (octo: RepositoryInfo['permission'], someone: RepositoryInfo['permission']) =>
    repositoryInfo('acme/api', {
      access: [
        { account: ACCOUNT, ...(octo !== undefined ? { permission: octo } : {}) },
        { account: OTHER_ACCOUNT, ...(someone !== undefined ? { permission: someone } : {}) },
      ],
    });

  beforeEach(() => {
    h.auth.accounts.mockResolvedValue([ACCOUNT, OTHER_ACCOUNT]);
    h.auth.getAccount.mockImplementation(async (options?: { account?: GitHubAccount }) => options?.account ?? ACCOUNT);
    h.auth.getToken.mockImplementation(async (options?: { account?: GitHubAccount }) => tokenOf(options));
    h.sidebar.accountListings.mockReturnValue([
      { account: ACCOUNT, organizations: [] },
      { account: OTHER_ACCOUNT, organizations: ['acme'] },
    ]);
  });

  it('starts a new devspace with the account of the highest permission (rule 4)', async () => {
    h.sidebar.infos.set('acme/api', shared('WRITE', 'ADMIN'));
    await run('start', row('acme/api'));
    expect(h.service.openInWorker).toHaveBeenCalledWith(expect.objectContaining({ repository: 'acme/api' }), expect.objectContaining({ account: OTHER_ACCOUNT }));
    expect(h.logger.info).toHaveBeenCalledWith('A new devspace of acme/api uses the GitHub account someone (admin).');
  });

  it('with equal permission, prefers the member of the owning organization (rule 6)', async () => {
    h.sidebar.infos.set('acme/api', shared('READ', 'READ'));
    await run('start', row('acme/api'));
    expect(h.service.openInWorker).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ account: OTHER_ACCOUNT }));
  });

  it('opens the existing devspace with its owner, also when another account has a higher permission (rule 1)', async () => {
    h.sidebar.infos.set('acme/api', shared('READ', 'ADMIN'));
    await h.registry.add(devspace());
    await run('start', row('acme/api'));
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledWith(ENV_ID, expect.anything());
    expect(h.service.openInWorker).not.toHaveBeenCalled();
    // Two devspaces of one source (one per account): the one used last opens.
    await h.registry.add(devspace({ id: OTHER_ENV_ID, owner: OTHER_ACCOUNT, volumeName: 'other', containerName: 'other', lastUsedAt: iso(NOW - 1000) }));
    await run('start', row('acme/api'));
    expect(h.service.openDevspaceInWorker).toHaveBeenLastCalledWith(OTHER_ENV_ID, expect.anything());
  });

  it('Start with Account… offers the accounts in the order of the rules and creates a devspace of the chosen one; the other devspace stays', async () => {
    h.sidebar.infos.set('acme/api', shared('ADMIN', 'WRITE'));
    await h.registry.add(devspace());
    const created = devspace({ id: OTHER_ENV_ID, owner: OTHER_ACCOUNT, volumeName: 'other', containerName: 'other' });
    h.service.openInWorker.mockImplementation(async () => {
      await h.registry.add(created);
      return openResult(created);
    });
    let offered: Array<{ label: string; description: string }> = [];
    fakeVscode.window.showQuickPick.mockImplementationOnce(async (items: Array<{ label: string; description: string }>) => {
      offered = items;
      return items.find((item) => item.label === OTHER_ACCOUNT.login);
    });
    await run('startWithAccount', row('acme/api', devspace()));
    expect(offered.map((item) => [item.label, item.description])).toEqual([
      ['octo', ControllerTexts.accountChoiceDescription('admin', true)],
      ['someone', ControllerTexts.accountChoiceDescription('write', false)],
    ]);
    expect(h.service.openInWorker).toHaveBeenCalledWith(expect.objectContaining({ repository: 'acme/api' }), expect.objectContaining({ account: OTHER_ACCOUNT }));
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
    expect(h.service.deleteInWorker).not.toHaveBeenCalled();
    expect((await h.registry.list()).map((entry) => entry.id).sort()).toEqual([ENV_ID, OTHER_ENV_ID].sort());
  });

  it('Start with Account… opens the devspace of the chosen account when it has one, and says when only one account can access the repository', async () => {
    h.sidebar.infos.set('acme/api', shared('ADMIN', 'WRITE'));
    await h.registry.add(devspace({ id: OTHER_ENV_ID, owner: OTHER_ACCOUNT, volumeName: 'other', containerName: 'other' }));
    fakeVscode.window.showQuickPick.mockImplementationOnce(async (items: Array<{ label: string }>) => items.find((item) => item.label === OTHER_ACCOUNT.login));
    await run('startWithAccount', row('acme/api'));
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledWith(OTHER_ENV_ID, expect.anything());

    // The devspace of the row opens for its owner, also when the registry keeps the name before a rename on GitHub.
    const renamed = devspace({ repository: 'acme/old-api' });
    await h.registry.add(renamed);
    let offered: Array<{ label: string; description: string }> = [];
    fakeVscode.window.showQuickPick.mockImplementationOnce(async (items: Array<{ label: string; description: string }>) => {
      offered = items;
      return items.find((item) => item.label === ACCOUNT.login);
    });
    await run('startWithAccount', row('acme/api', renamed));
    expect(offered.map((item) => item.description)).toEqual([ControllerTexts.accountChoiceDescription('admin', true), ControllerTexts.accountChoiceDescription('write', true)]);
    expect(h.service.openDevspaceInWorker).toHaveBeenLastCalledWith(ENV_ID, expect.anything());
    expect(h.service.openInWorker).not.toHaveBeenCalled();

    h.sidebar.infos.set('acme/web', repositoryInfo('acme/web', { access: [{ account: ACCOUNT, permission: 'ADMIN' }] }));
    await run('startWithAccount', row('acme/web'));
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(ControllerTexts.oneAccountOnly('acme/web'));
    expect(fakeVscode.window.showQuickPick).toHaveBeenCalledTimes(2);
  });

  it('Add GitHub Account… tells which account Devspaces uses now, or that it used it already', async () => {
    const STUDENT: GitHubAccount = { id: '3003', login: 'student' };
    h.auth.addAccount.mockResolvedValueOnce(STUDENT);
    await run('addAccount');
    expect(fakeVscode.window.showInformationMessage).toHaveBeenLastCalledWith(ControllerTexts.accountAdded('student'));
    h.auth.addAccount.mockResolvedValueOnce(OTHER_ACCOUNT);
    await run('addAccount');
    expect(fakeVscode.window.showInformationMessage).toHaveBeenLastCalledWith(ControllerTexts.accountAlreadyUsed('someone'));
    // Cancel: nothing.
    await run('addAccount');
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledTimes(2);
  });

  it('a link asks GitHub with each account and starts with the account of the highest permission', async () => {
    fakeVscode.window.showWarningMessage.mockResolvedValue(Actions.open);
    h.discovery.getRepository.mockImplementation(async (repository: string, token: string) =>
      repository === 'acme/tool' ? repositoryInfo('acme/tool', { permission: token === OTHER_TOKEN ? 'MAINTAIN' : 'READ' }) : undefined,
    );
    await h.controller.openLink(link('acme/tool'));
    expect(h.discovery.getRepository.mock.calls).toEqual([
      ['acme/tool', 'gho_token'],
      ['acme/tool', OTHER_TOKEN],
    ]);
    expect(h.service.openInWorker).toHaveBeenCalledWith(expect.objectContaining({ repository: 'acme/tool' }), expect.objectContaining({ account: OTHER_ACCOUNT }));

    // GitHub shows the repository to no account: the message names both.
    await h.controller.openLink(link('acme/secret'));
    expect(warningMessages()).toContain(ControllerTexts.linkRepositoryNotFound('acme/secret', ['octo', 'someone']));
  });

  it('a link takes the account that GitHub shows the repository to, also with a lower permission elsewhere', async () => {
    fakeVscode.window.showWarningMessage.mockResolvedValue(Actions.open);
    h.discovery.getRepository.mockImplementation(async (repository: string, token: string) => (token === 'gho_token' ? repositoryInfo(repository, { permission: 'READ' }) : undefined));
    await h.controller.openLink(link('octo/private'));
    expect(h.service.openInWorker).toHaveBeenCalledWith(expect.objectContaining({ repository: 'octo/private' }), expect.objectContaining({ account: ACCOUNT }));
  });

  it('a course link opens the repository of the login in its name with that account, never the account with more rights', async () => {
    fakeVscode.window.showWarningMessage.mockResolvedValue(Actions.open);
    // octo is an owner of the course organization (ADMIN on every repository of it); someone is the student.
    h.discovery.getRepository.mockImplementation(async (repository: string, token: string) =>
      repository === 'acme/task-someone' ? repositoryInfo(repository, { permission: token === OTHER_TOKEN ? 'WRITE' : 'ADMIN' }) : undefined,
    );
    await h.controller.openLink(courseLink('acme/task-<username>'));
    expect(h.discovery.getRepository.mock.calls).toEqual([
      ['acme/task-octo', 'gho_token'],
      ['acme/task-someone', OTHER_TOKEN],
    ]);
    expect(h.service.openInWorker).toHaveBeenCalledWith(expect.objectContaining({ repository: 'acme/task-someone' }), expect.objectContaining({ account: OTHER_ACCOUNT }));
    expect(h.logger.info).toHaveBeenCalledWith('The course link opens acme/task-someone for someone.');
  });

  it('a course link asks which repository to open when two accounts have one, and names all that it tried when none has one', async () => {
    fakeVscode.window.showWarningMessage.mockResolvedValue(Actions.open);
    h.discovery.getRepository.mockImplementation(async (repository: string) => repositoryInfo(repository));
    fakeVscode.window.showQuickPick.mockImplementationOnce(async (items: Array<{ label: string; description: string }>) => {
      expect(items.map((item) => [item.label, item.description])).toEqual([
        ['acme/task-octo', 'octo'],
        ['acme/task-someone', 'someone'],
      ]);
      return items[1];
    });
    await h.controller.openLink(courseLink('acme/task-<username>'));
    expect(h.service.openInWorker).toHaveBeenCalledWith(expect.objectContaining({ repository: 'acme/task-someone' }), expect.objectContaining({ account: OTHER_ACCOUNT }));

    h.discovery.getRepository.mockResolvedValue(undefined);
    await h.controller.openLink(courseLink('acme/exam-<username>'));
    expect(warningMessages()).toContain(ControllerTexts.courseRepositoriesNotFound('acme/exam-octo (octo), acme/exam-someone (someone)'));
    expect(h.service.openInWorker).toHaveBeenCalledTimes(1);
  });

  it('a link that GitHub could not be asked about opens only an existing devspace: no question, no second lookup', async () => {
    const STRANGER: GitHubAccount = { id: '4004', login: 'stranger' };
    await h.registry.add(devspace({ owner: STRANGER }));
    h.discovery.getRepository.mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.github.com'));
    await h.controller.openLink(link('acme/api'));
    // One lookup per account, and no question of rule 2 about the devspace of stranger.
    expect(h.discovery.getRepository).toHaveBeenCalledTimes(2);
    expect(warningMessages()).not.toContain(ControllerTexts.hiddenOwnerQuestion('acme/api', STRANGER.login));
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledWith(ControllerTexts.linkRepositoryUnknown('acme/api'), Actions.showDetails);
    expect(h.service.openInWorker).not.toHaveBeenCalled();
    expect(h.service.openDevspaceInWorker).not.toHaveBeenCalled();
  });

  it('a course link asks no new sign-in of an account whose token GitHub rejected while another account finds its repository', async () => {
    fakeVscode.window.showWarningMessage.mockResolvedValue(Actions.open);
    h.discovery.getRepository.mockImplementation(async (repository: string, token: string) => {
      if (token === 'gho_token') throw new GitHubApiError('Bad credentials', 401);
      return repositoryInfo(repository);
    });
    await h.controller.openLink(courseLink('acme/task-<username>'));
    expect(h.auth.renewToken).not.toHaveBeenCalled();
    expect(h.service.openInWorker).toHaveBeenCalledWith(expect.objectContaining({ repository: 'acme/task-someone' }), expect.objectContaining({ account: OTHER_ACCOUNT }));
  });

  it('a course link asks only the account whose token GitHub rejected to sign in again when no account finds its repository', async () => {
    fakeVscode.window.showWarningMessage.mockResolvedValue(Actions.open);
    h.discovery.getRepository.mockImplementation(async (repository: string, token: string) => {
      if (token === 'gho_token') throw new GitHubApiError('Bad credentials', 401);
      return undefined;
    });
    await h.controller.openLink(courseLink('acme/task-<username>'));
    expect(h.auth.renewToken.mock.calls).toEqual([[ACCOUNT]]);
  });

  it('a link opens the existing devspace of an account that GitHub could not be asked with, also when the token of another account was rejected', async () => {
    await h.registry.add(devspace({ owner: OTHER_ACCOUNT }));
    h.discovery.getRepository.mockImplementation(async (_repository: string, token: string) => {
      if (token === OTHER_TOKEN) throw new Error('getaddrinfo ENOTFOUND api.github.com');
      throw new GitHubApiError('Bad credentials', 401);
    });
    await h.controller.openLink(link('acme/api'));
    // The user cancelled the new sign-in of octo (renewToken gives no token).
    expect(h.auth.renewToken.mock.calls).toEqual([[ACCOUNT]]);
    expect(h.service.openDevspaceInWorker).toHaveBeenCalledWith(ENV_ID, expect.anything());
    expect(warningMessages()).not.toContain(Messages.signInRequired);
  });

  it('a link asks no further account to sign in again once a new sign-in finds the repository', async () => {
    fakeVscode.window.showWarningMessage.mockResolvedValue(Actions.open);
    h.auth.renewToken.mockResolvedValue('gho_renewed');
    h.discovery.getRepository.mockImplementation(async (repository: string, token: string) => {
      if (token !== 'gho_renewed') throw new GitHubApiError('Bad credentials', 401);
      return repositoryInfo(repository);
    });
    await h.controller.openLink(link('acme/api'));
    expect(h.auth.renewToken.mock.calls).toEqual([[ACCOUNT]]);
  });

  it('closes the window of a devspace only when its own account leaves, not when another account leaves', async () => {
    const env = devspace();
    await h.registry.add(env);
    await connectHere(env);
    // someone signs out: the devspace of octo stays connected.
    h.auth.accounts.mockResolvedValue([ACCOUNT]);
    await h.controller.onSessionChanged();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
    expect(tokenRemovals()).toBe(0);
    // A new account never closes a window.
    h.auth.accounts.mockResolvedValue([ACCOUNT, OTHER_ACCOUNT]);
    await h.controller.onSessionChanged();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
    // octo signs out: its window closes, and its token leaves the container.
    h.auth.accounts.mockResolvedValue([OTHER_ACCOUNT]);
    await h.controller.onSessionChanged();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length > 0, 'the close of the connection');
    expect(warningMessages()).toContain(Messages.otherAccountConnection('acme/api'));
  });

  it('lists and acts on the devspaces of both accounts, and never on one of an account that Devspaces does not use', async () => {
    const STRANGER: GitHubAccount = { id: '4004', login: 'stranger' };
    await h.registry.add(devspace());
    await h.registry.add(devspace({ id: OTHER_ENV_ID, repository: 'acme/web', owner: OTHER_ACCOUNT, volumeName: 'web', containerName: 'web' }));
    await h.registry.add(devspace({ id: '7c1d2e3f-0000-4000-8000-000000000009', repository: 'acme/hidden', owner: STRANGER, volumeName: 'hidden', containerName: 'hidden' }));
    expect((await h.sidebar.availableDevspaces()).map((entry: Devspace) => entry.id)).toEqual([ENV_ID, OTHER_ENV_ID]);
    await run('stop', row('acme/web', devspace({ id: OTHER_ENV_ID, repository: 'acme/web', owner: OTHER_ACCOUNT })));
    expect(h.service.stop).toHaveBeenCalledWith(OTHER_ENV_ID);
  });
});
