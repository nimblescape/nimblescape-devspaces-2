// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Data of the sidebar: the repository list of the discovery, the devspaces of the registry, and their states. Docker
// is asked only on request (view visible, after an operation), never in the background, so that Docker Desktop's
// Resource Saver can work; the 15-second heartbeat only reads the coordination files. Accounts: the view shows the list
// and the devspaces of the signed-in GitHub account only; without a sign-in, it shows nothing but the sign-in.
import * as vscode from 'vscode';
import type { BootstrapDocker } from '../core/docker/bootstrapDocker';
import type { DockerTargets } from '../core/docker/dockerTargets';
import type { MissingHelperStatus } from '../core/helper/missingHelperBuild';
import { DISCOVERY_CONCURRENCY, type DiscoveryService, type PartialDiscovery } from '../core/discovery/discoveryService';
import { GitHubApiError, GitHubRateLimitError } from '../core/discovery/githubApi';
import { sameScope } from '../core/discovery/scope';
import { errorMessage } from '../core/errors';
import { Actions, Messages } from '../core/messages';
import { devspacesOfHost } from '../core/docker/dockerHost';
import { availableDevspaces } from '../core/ownership';
import { systemClock, type Clock, type Logger } from '../core/ports';
import type { DevspaceOperations } from '../core/pipeline/devspaceOperations';
import type { DevspaceRegistry } from '../core/storage/registry';
import type { SessionFiles } from '../core/storage/sessionFiles';
import type { DiscoveryData, Devspace, ExtensionSettings, GitHubAccount, RepositoryInfo, WindowStatus } from '../core/types';
import { isProcessAlive } from '../core/session/sessionRules';
import { SIGN_IN_AGAIN_DETAIL, type VsCodeGitHubAuth } from './auth';
import { GROUP_MATCH_TIME_LIMIT_MS, type GroupMatcher, type GroupMatchRun, type GroupPlace } from './groupMatcher';
import { showWarningMessage } from './notifications';
import { RepositoryGroupTexts, parseRepositoryGroups, type RepositoryGroupPattern } from './repositoryGroups';
import { showRepositoryGroupsWarning } from './settings';
import type { SessionCoordinator } from './sessionCoordinator';
import { dockerStoppedRuntime, devspaceIdsOf, liveBusyDevspaceIds } from './sidebarData';
import { CoalescingTask, mapLimit } from './tasks';
import { findRepositoryInfo, listedRepositories, ownerTrust, pickerRepositories, repositoriesToLookUp, repositoryKey } from './targets';
import { buildTreeModel, repositoryEntriesOf, type DevspaceRuntime, type OwnerGroup, type StatesUnknown, type TreeInput } from './treeModel';
import { REPOSITORIES_VIEW_ID, type RepositoriesTreeProvider } from './treeView';

/** Context key of the welcome views (package.json): a list was loaded, or the first refresh failed. */
export const LOADED_CONTEXT_KEY = 'devspaces.loaded';
/**
 * Context key of the welcome views (package.json): the last refresh failed and no list is stored, so the view is empty
 * because the list could not be loaded, not because no repository has a configuration.
 */
export const LOAD_FAILED_CONTEXT_KEY = 'devspaces.loadFailed';

/**
 * The refresh after a rate limit of GitHub (onRateLimited) runs at the next full minute that is at least this long after
 * the time that GitHub names, so that a clock that is a little ahead does not ask too early; without a time, the time is
 * RATE_LIMIT_WAIT_MS after now (GitHub asks to wait at least a minute).
 */
export const RATE_LIMIT_MARGIN_MS = 10_000;
export const RATE_LIMIT_WAIT_MS = 60_000;

export interface SidebarDeps {
  logger: Logger;
  registry: DevspaceRegistry;
  sessionFiles: SessionFiles;
  coordinator: SessionCoordinator;
  service: DevspaceOperations;
  docker: BootstrapDocker;
  discovery: DiscoveryService;
  auth: VsCodeGitHubAuth;
  tree: RepositoriesTreeProvider;
  settings: () => ExtensionSettings;
  /**
   * Runs the regular expressions of the setting repositoryGroups in a worker thread with a time limit
   * (GroupMatchWorkerRunner), so that none runs on the extension host.
   */
  groupMatcher: GroupMatcher;
  /**
   * True while the view shows the Docker setup instead of the repositories (`dockerSetupRequired`). Default: false.
   */
  dockerSetupRequired?: () => boolean;
  /**
   * The Docker host of the current Docker context ('' = the local Docker; DockerTargets.host). The view shows only its
   * devspaces. Default: the local Docker.
   */
  dockerHost?: () => Promise<string>;
  /**
   * The refresh of the states runs as one operation on the Docker target that is current at its start. Default: no
   * operation (each call reads the current context).
   */
  dockerTargets?: Pick<DockerTargets, 'withOperation'>;
  /**
   * The tree view of the repositories, once createTreeView registered it. The refresh shows its progress in the view
   * only while the view is visible (viewProgressLocation). Default: no view, the progress shows in the status bar.
   */
  view?: { readonly visible: boolean };
  /**
   * The background build of a helper image that the refresh found missing (MissingHelperBuild.status), for the reason
   * of a state that could not be read. Default: none.
   */
  helperBuilds?: { status(dockerHost: string): MissingHelperStatus | undefined };
  clock?: Clock;
  isAlive?: (pid: number) => boolean;
}

/**
 * Where the refresh shows its progress: in the view while it is registered and visible, else in the status bar. In a
 * freshly opened or reconnecting window the refresh starts before the view is shown, and VS Code rejects a view
 * location of a view that is not shown ("Bad progress location").
 */
export function viewProgressLocation(view: { readonly visible: boolean } | undefined): vscode.ProgressOptions['location'] {
  return view?.visible ? { viewId: REPOSITORIES_VIEW_ID } : vscode.ProgressLocation.Window;
}

export class Sidebar implements vscode.Disposable {
  private readonly clock: Clock;
  private readonly isAlive: (pid: number) => boolean;
  private data: DiscoveryData | undefined;
  /** The signed-in account whose list and devspaces the view shows. */
  private account: GitHubAccount | undefined;
  private signedIn = false;
  private loaded = false;
  private loadFailed = false;
  /** `undefined`: Docker was not asked yet, or its answer was not usable. */
  private runtime: ReadonlyMap<string, DevspaceRuntime> | undefined;
  /**
   * The engine whose states the last refresh could not read, and whether it answered; `undefined` after a refresh that
   * read them (or knows that nothing runs: the local Docker does not run).
   */
  private statesUnread: { dockerHost: string; reachable: boolean; removed?: true } | undefined;
  private liveBranches: ReadonlyMap<string, string> = new Map();
  private lookups: ReadonlyMap<string, RepositoryInfo | null> = new Map();
  /**
   * Progressive display: the refresh that runs while the view shows no list (the first load, or a list of another
   * scope) shows the repositories as they arrive, for this account.
   */
  private progressiveAccountId: string | undefined;
  private partial: DiscoveryData | undefined;
  private timer: NodeJS.Timeout | undefined;
  /** The one refresh after a rate limit of GitHub (onRateLimited): its timer and time; `undefined` while none waits. */
  private rateLimitRetry: { timer: NodeJS.Timeout; at: number } | undefined;
  /** The next refresh is the one after a rate limit: it gets no second one. */
  private retryingAfterRateLimit = false;
  /** The next refresh is one of the Refresh command (refreshDiscovery `byUser`). */
  private refreshByUser = false;
  private signInOffered = false;
  /** Counts the account changes of onSessionChanged: a refresh that read an older session does not use it. */
  private accountChanges = 0;
  /** The token of the refresh that asks GitHub now; `undefined` while none does. */
  private refreshToken: string | undefined;
  private disposed = false;
  /** Problems of the setting repositoryGroups that were shown: each distinct one once per window session. */
  private readonly shownGroupProblems = new Set<string>();
  /**
   * The places of the repository names under the value of the setting repositoryGroups (`key`, its JSON) that the
   * worker found; `off`: the worker took too long or failed for this value, so the view lists the repositories without
   * groups until the setting changes.
   */
  private groupPlaces: { key: string; places: Map<string, GroupPlace | null>; off?: true } | undefined;
  private readonly renderTask = new CoalescingTask(() => this.renderNow());
  private readonly statesTask = new CoalescingTask(() => this.refreshStatesNow());
  private readonly discoveryTask = new CoalescingTask(() => this.refreshDiscoveryNow());
  private readonly statesEmitter = new vscode.EventEmitter<void>();
  private readonly renderEmitter = new vscode.EventEmitter<void>();
  /** The model of the last render, also while the view shows the Docker setup (model). */
  private groups: readonly OwnerGroup[] = [];
  /** The input of the last render, without the patterns of repositoryGroups (groupingInput). */
  private lastInput: TreeInput | undefined;

  /** Fires after the container states and the branches of running containers were read. */
  readonly onDidRefreshStates: vscode.Event<void> = this.statesEmitter.event;

  /** Fires after each render of the view (for the preview of the repository groups editor). */
  readonly onDidRender: vscode.Event<void> = this.renderEmitter.event;

  constructor(private readonly deps: SidebarDeps) {
    this.clock = deps.clock ?? systemClock;
    this.isAlive = deps.isAlive ?? isProcessAlive;
  }

  /** Stored or fresh discovery data. */
  get discoveryData(): DiscoveryData | undefined {
    return this.data;
  }

  get isSignedIn(): boolean {
    return this.signedIn;
  }

  /** The account whose list and devspaces the view shows; `undefined` without a sign-in. */
  get currentAccount(): GitHubAccount | undefined {
    return this.account;
  }

  /**
   * The input of the last render of the view, without patterns: the repositories already loaded (no GitHub request) and
   * the devspaces with their states. The repository groups editor builds its preview with it and buildTreeModel, as
   * the view does, so the preview is what the view shows with those patterns. Always with all repositories, also while
   * the setting showOnlyDevspaces is on: the patterns apply to all of them. `undefined` before the first render.
   */
  groupingInput(): TreeInput | undefined {
    const input = this.lastInput;
    return input && { ...input, settings: { ...input.settings, showOnlyDevspaces: false } };
  }

  /**
   * The current model of the repositories (for the switcher). While the view shows the Docker setup, the view is empty,
   * but this is the full model: the commands of the Command Palette keep working as before.
   */
  model(): readonly OwnerGroup[] {
    return this.groups;
  }

  /**
   * Shows the stored list at once, then updates it in the background when the user is signed in. Never throws.
   */
  async initialize(): Promise<void> {
    const [account, signedIn] = await Promise.all([
      this.readAccount(),
      this.deps.auth.updateContextKey().catch((error: unknown) => {
        this.deps.logger.warn(`The sign-in state could not be read: ${errorMessage(error)}`);
        return false;
      }),
    ]);
    if (this.disposed) return;
    this.signedIn = signedIn && account !== undefined;
    if (this.account?.id !== account?.id || this.data === undefined) await this.useAccount(account);
    if (this.disposed) return;
    await this.render().catch((error: unknown) => this.deps.logger.error('The sidebar could not be shown.', error));
    this.restartTimer();
    if (this.signedIn) void this.refreshDiscovery();
  }

  /** Builds the view from the registry, the coordination files, and the last known states. No Docker call. */
  render(): Promise<void> {
    return this.renderTask.request();
  }

  /**
   * Reads the container and volume states from Docker (without starting it) and the branches of the running containers,
   * then renders. Call only when the view is visible or after an operation.
   */
  refreshStates(): Promise<void> {
    return this.statesTask.request();
  }

  /**
   * Updates the repository list from GitHub, one refresh at a time: `again` starts one more refresh after a running one
   * (for example after an account change); otherwise a running refresh is reused. `byUser` (with `again`): the refresh
   * is one of the Refresh command, so a rate limit of GitHub that refuses it always gets a message (onRateLimited).
   * Never rejects: a failed refresh keeps the stored list. Resolves with the current data.
   */
  refreshDiscovery(options: { again?: boolean; byUser?: boolean } = {}): Promise<DiscoveryData | undefined> {
    // The refresh that request() starts reads the flag when it starts; a running refresh read it already.
    if (options.again && options.byUser) this.refreshByUser = true;
    const task = options.again ? this.discoveryTask.request() : this.discoveryTask.join();
    return task.catch((error: unknown) => {
      this.deps.logger.error('The repository list could not be updated.', error);
      return this.data;
    });
  }

  /**
   * The setting `owners` (the scan scope) changed: a list of another scope is not shown anymore, because it may contain
   * repositories outside the new scope, and a refresh with the new scope starts at once. Never rejects.
   */
  async onScopeChanged(): Promise<void> {
    // The part of a first load of the previous scope is not shown either.
    if (this.partial && !this.isOfCurrentScope(this.partial)) {
      this.partial = undefined;
      this.progressiveAccountId = undefined;
    }
    if (this.data && !this.isOfCurrentScope(this.data)) {
      this.data = undefined;
      this.lookups = new Map();
      this.setLoaded(false);
      this.setLoadFailed(false);
    }
    this.renderInBackground();
    if (this.signedIn) await this.refreshDiscovery({ again: true });
  }

  /**
   * Sign-in, sign-out, or account change: new state, then a new list. `again` starts one more refresh after a running
   * one; `again: false` reuses a running refresh. By default, a running refresh is reused only when it loads the list
   * of the same account with the token of the current session, for example when VS Code reports a session of other
   * scopes (read:packages) or of another extension: the list would be the same, and the Refresh command would wait for
   * two refreshes. Never rejects.
   */
  async onSessionChanged(options: { again?: boolean } = {}): Promise<void> {
    const account = await this.readAccount();
    const accountChanged = account?.id !== this.account?.id;
    // Another account: its own stored list at once, never the list of the previous one.
    if (accountChanged) {
      this.accountChanges++;
      await this.useAccount(account);
    }
    const wasSignedIn = this.signedIn;
    this.setSignedIn(account !== undefined && (await this.authSignedIn()));
    this.renderInBackground();
    if (!this.signedIn) return;
    const again = options.again ?? (accountChanged || !wasSignedIn || !(await this.refreshUsesCurrentSession()));
    await this.refreshDiscovery({ again });
  }

  /** True if a refresh asks GitHub now with the token of the current session. */
  private async refreshUsesCurrentSession(): Promise<boolean> {
    const running = this.refreshToken;
    if (running === undefined) return false;
    return (await this.readSession())?.token === running;
  }

  /** Starts the background refresh again with the interval of the settings. */
  restartTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.disposed) return;
    const minutes = this.deps.settings().refreshIntervalMinutes;
    this.timer = setInterval(() => this.backgroundRefresh(), minutes * 60_000);
  }

  /**
   * The refresh of refreshIntervalMinutes. None while the refresh after a rate limit of GitHub waits (onRateLimited),
   * because GitHub would refuse it too; that refresh, and a Refresh that the user chooses, still run.
   */
  private backgroundRefresh(): void {
    const waiting = this.rateLimitRetry;
    if (waiting) {
      this.deps.logger.info(`The background update of the repository list waits for the refresh at ${new Date(waiting.at).toISOString()}, after the rate limit of GitHub.`);
      return;
    }
    void this.refreshDiscovery();
  }

  /** GitHub data of a repository: from the discovery (or the part of the first load), or from a single lookup. */
  repositoryInfo(repository: string): RepositoryInfo | undefined {
    return findRepositoryInfo(repository, this.data ?? this.shownPartial(), this.lookups);
  }

  /**
   * A part of the list of a running refresh (DiscoveryService.onPartialResult). Shown only while the view has no list of
   * the account; a later refresh replaces the shown list only when it is complete, so the view does not flicker.
   */
  onPartialResult(result: PartialDiscovery): void {
    if (this.disposed || this.data !== undefined || result.accountId !== this.progressiveAccountId) return;
    if (result.accountId !== this.account?.id || !this.isOfCurrentScope(result.data)) return;
    this.partial = result.data;
    this.renderInBackground();
  }

  /** The part of the first load that the view may show: of the signed-in account and of the current scope only. */
  private shownPartial(): DiscoveryData | undefined {
    const partial = this.partial;
    if (!partial || this.progressiveAccountId === undefined || this.progressiveAccountId !== this.account?.id) return undefined;
    return this.isOfCurrentScope(partial) ? partial : undefined;
  }

  /** Branch read from the running container at the last state refresh. */
  liveBranch(devspaceId: string): string | undefined {
    return this.liveBranches.get(devspaceId);
  }

  /** The devspaces of the signed-in account, in the order of the registry. */
  async availableDevspaces(): Promise<Devspace[]> {
    return availableDevspaces(await this.devspacesHere(), this.account);
  }

  /** The entries of the registry on the current Docker host; the others are hidden and never acted on. */
  private async devspacesHere(): Promise<Devspace[]> {
    const [entries, host] = await Promise.all([this.deps.registry.list(), this.currentDockerHost()]);
    return devspacesOfHost(entries, host);
  }

  private async currentDockerHost(): Promise<string> {
    try {
      return (await this.deps.dockerHost?.()) ?? '';
    } catch (error) {
      this.deps.logger.warn(`The current Docker host could not be read: ${errorMessage(error)}`);
      return '';
    }
  }

  /**
   * Repositories for Search and the switcher: the list of the view plus the repository of every devspace of the
   * signed-in account.
   */
  async repositoriesForPicker(): Promise<RepositoryInfo[]> {
    const devspaces = await this.availableDevspaces();
    return pickerRepositories({
      data: this.signedIn ? this.data : undefined,
      settings: this.deps.settings(),
      devspaces,
      lookups: this.lookups,
    });
  }

  /**
   * Security: the owner is the signed-in account or one of its organizations. The list belongs to the account that
   * loaded it; after an account change (or without a list), the owner counts as trusted only after a refresh with the
   * current account.
   */
  async trustedOwner(owner: string): Promise<boolean> {
    const account = (await this.readAccount())?.login;
    let trust = ownerTrust(this.data, account, owner);
    if (trust === 'unknown' && account !== undefined) {
      await this.refreshDiscovery();
      trust = ownerTrust(this.data, account, owner);
    }
    return trust === 'trusted';
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.clearRateLimitRetry();
    this.statesEmitter.dispose();
    this.renderEmitter.dispose();
  }

  private renderInBackground(): void {
    this.render().catch((error: unknown) => this.deps.logger.error('The sidebar could not be updated.', error));
  }

  private async renderNow(): Promise<void> {
    if (this.disposed) return;
    const { sessionFiles, coordinator } = this.deps;
    const [entries, statuses, others] = await Promise.all([
      this.devspacesHere(),
      sessionFiles.readWindowStatuses().catch((error: unknown): WindowStatus[] | undefined => {
        this.deps.logger.warn(`The window status files could not be read: ${errorMessage(error)}`);
        return undefined;
      }),
      coordinator.otherActiveWindows().catch((): WindowStatus[] => []),
    ]);
    if (this.disposed) return;
    const account = this.account;
    // Only the devspaces of the signed-in account; hidden ones are not counted or named anywhere.
    const devspaces = availableDevspaces(entries, account);
    const repositoryGroups = this.repositoryGroups();
    const input: TreeInput = {
      discovery: this.data ?? this.shownPartial(),
      settings: this.deps.settings(),
      devspaces,
      runtime: this.runtime,
      ...this.statesUnknown(),
      currentDevspaceId: coordinator.devspaceId,
      otherWindowDevspaceIds: devspaceIdsOf(others),
      busyDevspaceIds: liveBusyDevspaceIds(devspaces, {
        now: this.clock.now(),
        isAlive: this.isAlive,
        windowStatuses: statuses,
      }),
      liveBranches: this.liveBranches,
      signedIn: this.signedIn,
      repositoryLookups: this.lookups,
      formatTime,
    };
    this.lastInput = input;
    const groups = await this.groupedModel(input, repositoryGroups);
    if (this.disposed) return;
    this.logGroupFailures(repositoryGroups.patterns);
    this.groups = groups;
    // When no remote Docker host is configured and the local Docker is not available, the repositories are not shown;
    // the sidebar shows the Docker setup instead. The view gets an empty model, so VS Code shows the welcome view with
    // the setup. The discovery keeps running, so that the list appears at once when Docker is found (DockerSetup calls
    // render then).
    const setupRequired = this.deps.dockerSetupRequired?.() ?? false;
    this.deps.tree.setModel(setupRequired ? [] : groups, { signedIn: this.signedIn });
    this.renderEmitter.fire();
  }

  /**
   * The value of the setting repositoryGroups, and its valid entries, compiled once for this model. An entry that is not
   * valid is left out; its problem is logged and shown once per window session.
   */
  private repositoryGroups(): { entries: readonly unknown[]; patterns: RepositoryGroupPattern[] } {
    const entries = this.deps.settings().repositoryGroups ?? [];
    const { patterns, problems } = parseRepositoryGroups(entries);
    for (const { message } of problems) {
      if (this.shownGroupProblems.has(message)) continue;
      this.shownGroupProblems.add(message);
      this.deps.logger.warn(message);
      showRepositoryGroupsWarning(this.deps.logger, message);
    }
    return { entries, patterns };
  }

  /**
   * The model with the setting repositoryGroups. Its regular expressions run in the worker thread with a time limit
   * (groupMatcher.ts), never on the extension host: a nested repetition such as `(a+)+` can take seconds for one name.
   * The places of the names are kept until the setting changes, and only names without a place go to the worker. When
   * an entry takes too long or the worker fails, the view lists the repositories without groups until the setting
   * changes, and says so once.
   */
  private async groupedModel(input: TreeInput, groups: { entries: readonly unknown[]; patterns: RepositoryGroupPattern[] }): Promise<OwnerGroup[]> {
    const plain = buildTreeModel({ ...input, repositoryGroups: [] });
    const { entries, patterns } = groups;
    if (patterns.length === 0) {
      // Without groups, the kept places are not needed; a value that is set again runs again.
      this.groupPlaces = undefined;
      return plain;
    }
    const key = JSON.stringify(entries);
    if (this.groupPlaces?.key !== key) this.groupPlaces = { key, places: new Map() };
    const state = this.groupPlaces;
    // The names that buildTreeModel matches: one per repository entry (a row, or a node with its child rows).
    const missing = [...new Set(repositoryEntriesOf(plain).map((entry) => entry.name))].filter((name) => !state.places.has(name));
    if (!state.off && missing.length > 0) {
      const run = await this.deps.groupMatcher.run(entries, missing);
      if (this.disposed) return plain;
      if ('places' in run) {
        for (const [name, place] of run.places) state.places.set(name, place);
        for (const pattern of patterns) pattern.failure ??= run.failures.get(pattern.index);
      } else {
        state.off = true;
        // A setting that changed while the job ran gets no warning for its old value: the next render runs the new one.
        if (JSON.stringify(this.deps.settings().repositoryGroups ?? []) === key) this.warnGroupingOff(run, patterns);
      }
    }
    if (state.off) return plain;
    const byIndex = new Map(patterns.map((pattern) => [pattern.index, pattern]));
    return buildTreeModel({
      ...input,
      repositoryGroups: patterns,
      groupMatch: (name) => {
        const place = state.places.get(name);
        const pattern = place ? byIndex.get(place.index) : undefined;
        return place && pattern ? { pattern, levels: place.levels, label: place.label } : undefined;
      },
    });
  }

  /** Names once, in the log and in a message, why the view lists the repositories without groups. */
  private warnGroupingOff(run: Exclude<GroupMatchRun, { places: unknown }>, patterns: readonly RepositoryGroupPattern[]): void {
    const slow = 'tooSlow' in run ? patterns.find((pattern) => pattern.index === run.slowEntry) : undefined;
    const message =
      'tooSlow' in run ? RepositoryGroupTexts.tooSlow(GROUP_MATCH_TIME_LIMIT_MS / 1000, slow?.source) : RepositoryGroupTexts.workerFailed;
    this.deps.logger.warn(message);
    showRepositoryGroupsWarning(this.deps.logger, message);
  }

  /** Logs once per window session each entry that threw while it was matched (matchRepositoryGroup skipped it). */
  private logGroupFailures(patterns: readonly RepositoryGroupPattern[]): void {
    for (const pattern of patterns) {
      if (pattern.failure === undefined) continue;
      const message = RepositoryGroupTexts.failed(pattern.source, pattern.failure);
      if (this.shownGroupProblems.has(message)) continue;
      this.shownGroupProblems.add(message);
      this.deps.logger.warn(message);
    }
  }

  private async refreshStatesNow(): Promise<void> {
    if (this.disposed) return;
    const { service, docker, registry, dockerTargets } = this.deps;
    // The states and the branches of the running dev containers of the account in one call (one operation of the worker
    // when one is open), on one Docker target (DockerTargets.withOperation), with the Docker host of the operation (the
    // engine whose states are read).
    const read = async () => {
      const dockerHost = await this.currentDockerHost();
      return { dockerHost, states: await service.refreshStates(new Set((await this.availableDevspaces()).map((devspace) => devspace.id))) };
    };
    const { dockerHost, states } = await (dockerTargets ? dockerTargets.withOperation(read) : read());
    let runtime: ReadonlyMap<string, DevspaceRuntime> | undefined = states.runtime;
    let unread: { dockerHost: string; reachable: boolean; removed?: true } | undefined;
    if (!runtime && states.engineRemoved === true) {
      // An engine with the removal mark: refreshStates asked Docker nothing there, and neither does the sidebar (no
      // `docker info`); the states stay unknown until a flow of the user there.
      unread = { dockerHost, reachable: true, removed: true };
    } else if (!runtime) {
      // refreshStates gives `undefined` both when Docker does not run and when Docker failed. Only the first means
      // "nothing runs" (a connection that was lost must not keep showing Connected).
      const running = docker.isInstalled() && (await docker.isRunning());
      if (!running) runtime = dockerStoppedRuntime(await registry.list());
      // The states that could not be read are shown as unknown, with the reason: an engine that answers but whose
      // worker could not read them, or a remote engine that does not answer (its containers may run). Only the local
      // Docker that does not run is known: nothing runs. The registry is not changed; the runtime above still gives the
      // actions (Start stays offered).
      if (running || dockerHost !== '') unread = { dockerHost, reachable: running };
    }
    this.runtime = runtime;
    this.statesUnread = unread;
    this.liveBranches = states.branches;
    await this.render();
    if (!this.disposed) this.statesEmitter.fire();
  }

  /**
   * TreeInput.statesUnknown of the last refresh, with the reason; for an engine that answers, the state of its
   * background build of the helper image (MissingHelperBuild) as it is now.
   */
  private statesUnknown(): { statesUnknown?: StatesUnknown } {
    const unread = this.statesUnread;
    if (unread === undefined) return {};
    if (unread.removed === true) return { statesUnknown: { dockerHost: unread.dockerHost, reason: 'removed' } };
    if (!unread.reachable) return { statesUnknown: { dockerHost: unread.dockerHost, reason: 'unreachable' } };
    const build = this.deps.helperBuilds?.status(unread.dockerHost);
    return { statesUnknown: { dockerHost: unread.dockerHost, reason: build === 'building' ? 'building' : build === 'failed' ? 'buildFailed' : 'notReady' } };
  }

  private async refreshDiscoveryNow(): Promise<DiscoveryData | undefined> {
    if (this.disposed) return this.data;
    const afterRateLimit = this.retryingAfterRateLimit;
    this.retryingAfterRateLimit = false;
    const byUser = this.refreshByUser;
    this.refreshByUser = false;
    // Token and account of one session: the list is stored for the account.
    const changes = this.accountChanges;
    const session = await this.readSession();
    // The account changed while the session was read: the refresh of that change uses the new session.
    if (changes !== this.accountChanges) return this.data;
    const token = session?.token;
    const account = session?.account;
    if (account?.id !== this.account?.id) await this.useAccount(account);
    // A session whose token GitHub rejected does not count as signed in (auth.ts): no refresh, which would fail again,
    // until Sign in with GitHub replaces the token.
    this.setSignedIn(account !== undefined && (await this.authSignedIn()));
    if (token === undefined || account === undefined || !this.signedIn) {
      this.renderInBackground();
      return this.data;
    }
    // The part of a first load that a rate limit stopped (onRateLimited) stays shown until this refresh gives its first
    // part (onPartialResult) or ends without a rate limit: a refresh that GitHub refuses at once keeps it.
    const progressive = this.data === undefined ? account.id : undefined;
    if (progressive === undefined || progressive !== this.progressiveAccountId) this.partial = undefined;
    this.progressiveAccountId = progressive;
    this.refreshToken = token;
    let rateLimited = false;
    try {
      const data = await vscode.window.withProgress({ location: viewProgressLocation(this.deps.view) }, () =>
        this.deps.discovery.refresh(token, account.id),
      );
      // The account changed while the list loaded: the list is not shown (the next refresh loads the new one).
      if (this.account?.id !== account.id) return this.data;
      // The scope changed while the list loaded: the refresh that the change requested loads the list of the new scope.
      if (!this.isOfCurrentScope(data)) return this.data;
      this.data = data;
      this.setLoadFailed(false);
      this.clearRateLimitRetry();
      // The complete list is shown at once. The repositories of devspaces that it lacks follow; until then their rows
      // show what the previous refresh found.
      this.endProgressiveDisplay();
      this.setLoaded();
      this.renderInBackground();
      const lookups = await this.lookUpUnlisted(data, token);
      if (this.account?.id === account.id) this.lookups = lookups;
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 401) this.offerSignInAgain();
      // A rate limit of GitHub: the part of the first load that the view shows stays, also for the next refresh.
      if (error instanceof GitHubRateLimitError) {
        rateLimited = true;
        this.onRateLimited(error, afterRateLimit, byUser);
      }
      // Without internet access, the view shows the stored list and skips the update. Without a stored list, the view
      // says that the list could not be loaded (not that no repository was found).
      const shown = this.data ? 'The stored list is shown.' : 'No stored list exists.';
      this.deps.logger.warn(`The repository list could not be updated. ${shown} ${errorMessage(error)}`);
      this.setLoadFailed(this.data === undefined);
    } finally {
      this.refreshToken = undefined;
      if (!rateLimited) this.endProgressiveDisplay();
    }
    this.setLoaded();
    this.renderInBackground();
    return this.data;
  }

  /**
   * GitHub refused the refresh for its rate limit: a message says when the list loads again, and one refresh runs at
   * that time. The refresh at that time gets no second one: after it, the message says from when Refresh works again,
   * and the refresh of refreshIntervalMinutes goes on as before; while the timer waits, that refresh does not run
   * (backgroundRefresh). While that one refresh is planned, a refused refresh plans no other: while its timer waits, the
   * timer moves to a later time that GitHub names (never to an earlier one), and only a new or later time, or a refused
   * Refresh of the user (`byUser`), gets a message, any other refusal only a line in the log; after the timer fired,
   * while that refresh waits for this one to end, only the log says it, and the message comes from that refresh.
   */
  private onRateLimited(error: GitHubRateLimitError, afterRateLimit: boolean, byUser: boolean): void {
    // A refresh that ends after the view was closed shows nothing and plans nothing.
    if (this.disposed) return;
    if (!afterRateLimit && this.retryingAfterRateLimit) {
      this.deps.logger.warn('GitHub refused the update of the repository list for its rate limit. The refresh after the rate limit runs next.');
      return;
    }
    const now = this.clock.now();
    let at = Math.max(error.resetAt ?? now + RATE_LIMIT_WAIT_MS, now) + RATE_LIMIT_MARGIN_MS;
    // The next full minute, because the message names only hour and minute: the timer, the log, and the message use
    // the same time, and a time in the same minute is not a new time.
    at = Math.ceil(at / 60_000) * 60_000;
    // A message for a new time, and for each refused Refresh of the user, who would otherwise see no answer; for any
    // other refusal, the time of the timer that waits was named already.
    let newTime = true;
    if (!afterRateLimit) {
      if (this.rateLimitRetry && this.rateLimitRetry.at >= at) {
        at = this.rateLimitRetry.at;
        newTime = false;
      } else {
        this.clearRateLimitRetry();
        const timer = setTimeout(() => {
          this.rateLimitRetry = undefined;
          this.retryingAfterRateLimit = true;
          void this.refreshDiscovery({ again: true });
        }, at - now);
        this.rateLimitRetry = { timer, at };
      }
    }
    const next = afterRateLimit ? 'Refresh can work again' : 'The list is loaded again';
    this.deps.logger.warn(`GitHub refused the update of the repository list for its rate limit. ${next} at ${new Date(at).toISOString()}.`);
    if (!newTime && !byUser) return;
    showWarningMessage(Messages.gitHubRateLimited(localClockTime(at), !afterRateLimit)).then(undefined, (reason: unknown) =>
      this.deps.logger.error('Could not show the message.', reason),
    );
  }

  private clearRateLimitRetry(): void {
    if (this.rateLimitRetry) clearTimeout(this.rateLimitRetry.timer);
    this.rateLimitRetry = undefined;
  }

  /** The refresh of the progressive display ended: the view shows no part of it anymore. */
  private endProgressiveDisplay(): void {
    this.progressiveAccountId = undefined;
    if (this.partial) {
      this.partial = undefined;
      this.renderInBackground();
    }
  }

  /**
   * The discovery stores the repositories of its scan, with and without a configuration. The repositories of the other
   * devspaces are asked one by one, at most DISCOVERY_CONCURRENCY at the same time (the refresh has ended, so no other
   * request of the list runs), so the view shows `not on GitHub` only for repositories that GitHub does not return.
   * A failed question leaves the repository unknown.
   */
  private async lookUpUnlisted(data: DiscoveryData, token: string): Promise<Map<string, RepositoryInfo | null>> {
    const result = new Map<string, RepositoryInfo | null>();
    const devspaces = await this.availableDevspaces();
    // GitHub is not asked about repositories outside the scan scope; their rows get no `not on GitHub`.
    const repositories = repositoriesToLookUp(devspaces, listedRepositories(data), this.deps.settings().owners);
    await mapLimit(repositories, DISCOVERY_CONCURRENCY, async (repository) => {
      if (this.disposed) return;
      try {
        const info = await this.deps.discovery.getRepository(repository, token);
        result.set(repositoryKey(repository), info ?? null);
      } catch (error) {
        this.deps.logger.info(`GitHub could not be asked for ${repository}: ${errorMessage(error)}`);
      }
    });
    return result;
  }

  /** GitHub rejected the token (HTTP 401): offer a new sign-in, once per window. */
  private offerSignInAgain(): void {
    if (this.signInOffered) return;
    this.signInOffered = true;
    showWarningMessage(SIGN_IN_AGAIN_DETAIL, Actions.signIn)
      .then(async (choice) => {
        if (choice !== Actions.signIn) return;
        const token = await this.deps.auth.renewToken();
        if (token) await this.refreshDiscovery({ again: true });
      })
      .then(undefined, (error: unknown) => this.deps.logger.error('The new GitHub sign-in failed.', error));
  }

  /** The sign-in state of auth.ts, which alone sets the context key `devspaces.signedIn`. */
  private setSignedIn(signedIn: boolean): void {
    this.signedIn = signedIn;
  }

  private async authSignedIn(): Promise<boolean> {
    try {
      return await this.deps.auth.isSignedIn();
    } catch (error) {
      this.deps.logger.warn(`The sign-in state could not be read: ${errorMessage(error)}`);
      return false;
    }
  }

  private setLoaded(loaded = true): void {
    if (this.loaded === loaded) return;
    this.loaded = loaded;
    setContext(LOADED_CONTEXT_KEY, loaded, this.deps.logger);
  }

  /**
   * Shows the list of `account`: its stored list at once (or none, until the refresh), and no single lookups of the
   * previous account. Without an account, no list.
   */
  private async useAccount(account: GitHubAccount | undefined): Promise<void> {
    this.account = account;
    this.data = undefined;
    this.lookups = new Map();
    // The part of the first load of the previous account is never shown to this one.
    this.partial = undefined;
    this.progressiveAccountId = undefined;
    this.setLoadFailed(false);
    if (!account) return;
    const stored = await this.deps.discovery.loadStored(account.id).catch((error: unknown) => {
      this.deps.logger.warn(`The stored repository list could not be read: ${errorMessage(error)}`);
      return undefined;
    });
    // Another change of the account meanwhile wins.
    if (this.account?.id !== account.id) return;
    // A list of another scan scope may contain repositories outside the current one: the view waits for the refresh.
    if (stored && !this.isOfCurrentScope(stored)) {
      this.deps.logger.info('The stored repository list was loaded for other organizations. It is loaded again.');
      return;
    }
    this.data = stored;
    this.setLoaded(stored !== undefined);
  }

  /** Token and account of the GitHub session, without a dialog; undefined when it cannot be read. */
  private async readSession(): Promise<{ token: string; account: GitHubAccount } | undefined> {
    try {
      return await this.deps.auth.getSession({ interactive: false });
    } catch (error) {
      this.deps.logger.warn(`The GitHub session could not be read: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /** True if the list was built with the scan scope of the current settings (an empty scope: all repositories). */
  private isOfCurrentScope(data: DiscoveryData): boolean {
    return sameScope(data.scope, this.deps.settings().owners);
  }

  /** The account of the GitHub session, without a dialog. */
  private async readAccount(): Promise<GitHubAccount | undefined> {
    try {
      return await this.deps.auth.getAccount({ interactive: false });
    } catch (error) {
      this.deps.logger.warn(`The GitHub account could not be read: ${errorMessage(error)}`);
      return undefined;
    }
  }

  private setLoadFailed(loadFailed: boolean): void {
    if (this.loadFailed === loadFailed) return;
    this.loadFailed = loadFailed;
    setContext(LOAD_FAILED_CONTEXT_KEY, loadFailed, this.deps.logger);
  }
}

function setContext(key: string, value: boolean, logger: Logger): void {
  vscode.commands.executeCommand('setContext', key, value).then(undefined, (error: unknown) => {
    logger.warn(`Could not set the context key ${key}: ${errorMessage(error)}`);
  });
}

/** Time of the last use in the tooltip, in the language of VS Code. */
function formatTime(isoTime: string): string {
  const date = new Date(isoTime);
  if (Number.isNaN(date.getTime())) return isoTime;
  try {
    return date.toLocaleString(vscode.env.language);
  } catch {
    return date.toLocaleString();
  }
}

/** `time` (ms since 1970, a full minute: onRateLimited rounds it up) as the hour and minute of the local time: 14:32. */
function localClockTime(time: number): string {
  const date = new Date(time);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
