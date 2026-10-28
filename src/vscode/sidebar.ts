// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Data of the sidebar: the repository list of the discovery, the devspaces of the registry, and their states. Docker
// is asked only on request (view visible, after an operation), never in the background, so that Docker Desktop's
// Resource Saver can work; the 15-second heartbeat only reads the coordination files. Accounts: the view shows one list
// for all accounts of Devspaces (auth.ts), merged from the list of each account (mergeDiscovery), and the devspaces of
// these accounts; without a sign-in, it shows nothing but the sign-in.
import * as vscode from 'vscode';
import type { BootstrapDocker } from '../core/docker/bootstrapDocker';
import type { DockerTargets } from '../core/docker/dockerTargets';
import type { MissingHelperStatus } from '../core/helper/missingHelperBuild';
import { DISCOVERY_CONCURRENCY, type DiscoveryService, type PartialDiscovery } from '../core/discovery/discoveryService';
import { GitHubApiError, GitHubRateLimitError } from '../core/discovery/githubApi';
import { mergeDiscovery } from '../core/discovery/mergeDiscovery';
import { sameScope } from '../core/discovery/scope';
import { errorMessage } from '../core/errors';
import { Actions, Messages } from '../core/messages';
import { devspacesOfHost } from '../core/docker/dockerHost';
import { accountIds, availableDevspaces } from '../core/ownership';
import { systemClock, type Clock, type Logger } from '../core/ports';
import type { DevspaceOperations } from '../core/pipeline/devspaceOperations';
import type { DevspaceRegistry } from '../core/storage/registry';
import type { SessionFiles } from '../core/storage/sessionFiles';
import type { AccountListing, DiscoveryData, Devspace, ExtensionSettings, GitHubAccount, RepositoryInfo, WindowStatus } from '../core/types';
import { isProcessAlive } from '../core/session/sessionRules';
import { SIGN_IN_AGAIN_DETAIL, signInAgainDetailOf, type VsCodeGitHubAuth } from './auth';
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

/** The list of one account of Devspaces in the sidebar. */
interface AccountState {
  account: GitHubAccount;
  /** Its stored or fresh list of the current scope; `undefined` until one is loaded. */
  data: DiscoveryData | undefined;
  /**
   * Progressive display: the part of its first load (its refresh while the view has no list of it, or a list of
   * another scope) that the view shows as the repositories arrive (onPartialResult).
   */
  partial: DiscoveryData | undefined;
  /** Its running refresh is a first load, whose parts are shown. */
  progressive: boolean;
}

export class Sidebar implements vscode.Disposable {
  private readonly clock: Clock;
  private readonly isAlive: (pid: number) => boolean;
  /** The merged list of the accounts (mergeDiscovery): their lists, and the parts of their first loads. */
  private data: DiscoveryData | undefined;
  /** The accounts of Devspaces whose lists and devspaces the view shows, in the order of their logins. */
  private accounts: GitHubAccount[] = [];
  /** The list of each account of `accounts`, by its ID. */
  private readonly lists = new Map<string, AccountState>();
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
  private timer: NodeJS.Timeout | undefined;
  /** The one refresh after a rate limit of GitHub (onRateLimited): its timer and time; `undefined` while none waits. */
  private rateLimitRetry: { timer: NodeJS.Timeout; at: number } | undefined;
  /** The next refresh is the one after a rate limit: it gets no second one. */
  private retryingAfterRateLimit = false;
  /** The next refresh is one of the Refresh command (refreshDiscovery `byUser`). */
  private refreshByUser = false;
  /**
   * The accounts whose rejected token got the offer of a new sign-in (offerSignInAgain): each one once per window, and
   * again after a Refresh of the user (the offer is the only way to sign in again as an account that is not the one
   * that VS Code gives Devspaces).
   */
  private readonly signInOffered = new Set<string>();
  /** Counts the changes of the accounts in onSessionChanged: a refresh that read older accounts does not use them. */
  private accountChanges = 0;
  /** A refresh of the lists runs (runRefresh). */
  private refreshing = false;
  /**
   * The token of each account that the running refresh of the lists reached so far (also an account that it skipped),
   * as it read the token: a new session of one of them needs a refresh of its own (refreshUsesCurrentSession).
   */
  private passTokens = new Map<string, string>();
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
  private readonly discoveryTask = new CoalescingTask(() => this.runRefresh());
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

  /** The merged list of the accounts: stored or fresh discovery data. */
  get discoveryData(): DiscoveryData | undefined {
    return this.data;
  }

  get isSignedIn(): boolean {
    return this.signedIn;
  }

  /** The accounts whose lists and devspaces the view shows; empty without a sign-in. */
  get currentAccounts(): readonly GitHubAccount[] {
    return this.accounts;
  }

  /** The complete list of the account `accountId` of the current scope; `undefined` while none is loaded. */
  accountList(accountId: string): DiscoveryData | undefined {
    return this.lists.get(accountId)?.data;
  }

  /** The accounts whose complete lists the view shows, with their organizations (DiscoveryData.accounts). */
  accountListings(): readonly AccountListing[] {
    return this.data?.accounts ?? [];
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
    const [accounts, signedIn] = await Promise.all([
      this.readAccounts(),
      this.deps.auth.updateContextKey().catch((error: unknown) => {
        this.deps.logger.warn(`The sign-in state could not be read: ${errorMessage(error)}`);
        return false;
      }),
    ]);
    if (this.disposed) return;
    this.signedIn = signedIn && accounts.length > 0;
    await this.useAccounts(accounts);
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
    if (options.again && options.byUser) {
      this.refreshByUser = true;
      this.signInOffered.clear();
    }
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
    let changed = false;
    for (const state of this.lists.values()) {
      // The part of a first load of the previous scope is not shown either.
      if (state.partial && !this.isOfCurrentScope(state.partial)) {
        state.partial = undefined;
        state.progressive = false;
        changed = true;
      }
      if (state.data && !this.isOfCurrentScope(state.data)) {
        state.data = undefined;
        changed = true;
      }
    }
    if (changed) {
      this.lookups = new Map();
      this.merge();
      this.setLoaded(this.hasList());
      this.setLoadFailed(false);
    }
    this.renderInBackground();
    if (this.signedIn) await this.refreshDiscovery({ again: true });
  }

  /**
   * Sign-in, sign-out, or a change of the accounts: new state, then new lists. `again` starts one more refresh after a
   * running one; `again: false` reuses a running refresh. By default, a running refresh is reused only when the
   * accounts are the same and it asks GitHub with the token of the current session of its account, for example when
   * VS Code reports a session of other scopes (read:packages) or of another extension: the lists would be the same,
   * and the Refresh command would wait for two refreshes. Never rejects.
   */
  async onSessionChanged(options: { again?: boolean } = {}): Promise<void> {
    const accounts = await this.readAccounts();
    const accountsChanged = accountIds(accounts) !== accountIds(this.accounts);
    // Another account: its own stored list at once; an account that left: its list is not shown anymore.
    if (accountsChanged) {
      this.accountChanges++;
      await this.useAccounts(accounts);
    }
    const wasSignedIn = this.signedIn;
    this.setSignedIn(accounts.length > 0 && (await this.authSignedIn()));
    this.renderInBackground();
    if (!this.signedIn) return;
    const again = options.again ?? (accountsChanged || !wasSignedIn || !(await this.refreshUsesCurrentSession()));
    await this.refreshDiscovery({ again });
  }

  /**
   * True if a refresh of the lists runs, and each account that it reached so far still has the session whose token it
   * read (the accounts after it are read when it reaches them).
   */
  private async refreshUsesCurrentSession(): Promise<boolean> {
    if (!this.refreshing) return false;
    for (const [accountId, token] of this.passTokens) {
      const account = this.lists.get(accountId)?.account;
      if (account === undefined || (await this.readSession(account))?.token !== token) return false;
    }
    return true;
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
    return findRepositoryInfo(repository, this.data, this.lookups);
  }

  /**
   * A part of the list of a running refresh (DiscoveryService.onPartialResult). Shown only while the view has no list of
   * the account; a later refresh replaces the shown list only when it is complete, so the view does not flicker.
   */
  onPartialResult(result: PartialDiscovery): void {
    const state = this.lists.get(result.accountId);
    if (this.disposed || state === undefined || state.data !== undefined || !state.progressive) return;
    if (!this.isOfCurrentScope(result.data)) return;
    state.partial = result.data;
    this.merge();
    this.renderInBackground();
  }

  /**
   * The merged list (mergeDiscovery) of the accounts: of each account its complete list, else the part of its first
   * load; only lists of the current scope.
   */
  private merge(): void {
    const lists = [];
    for (const account of this.accounts) {
      const state = this.lists.get(account.id);
      if (state === undefined) continue;
      if (state.data !== undefined) lists.push({ account, data: state.data });
      else if (state.progressive && state.partial !== undefined && this.isOfCurrentScope(state.partial)) lists.push({ account, data: state.partial, partial: true });
    }
    this.data = mergeDiscovery(lists);
  }

  /** True if the view has the complete list of one account. */
  private hasList(): boolean {
    return [...this.lists.values()].some((state) => state.data !== undefined);
  }

  /** Branch read from the running container at the last state refresh. */
  liveBranch(devspaceId: string): string | undefined {
    return this.liveBranches.get(devspaceId);
  }

  /** The devspaces of the accounts of Devspaces, in the order of the registry. */
  async availableDevspaces(): Promise<Devspace[]> {
    return availableDevspaces(await this.devspacesHere(), this.accounts);
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
   * accounts of Devspaces.
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
   * Security: the owner is an account of Devspaces or one of their organizations (ownerTrust). The organizations come
   * from the list of each account; while the list of an account is not loaded (after its sign-in, or without a list),
   * another owner counts as trusted only after a refresh. An account whose token GitHub rejected does not wait for a
   * refresh, which skips it: without its list, the owner counts as untrusted (the first open asks).
   */
  async trustedOwner(owner: string): Promise<boolean> {
    const accounts = await this.readAccounts();
    const signedIn = await Promise.all(accounts.map((account) => this.authSignedIn(account)));
    const loading = accounts.filter((_, index) => signedIn[index]);
    let trust = ownerTrust(this.data, accounts, owner, loading);
    if (trust === 'unknown' && accounts.length > 0) {
      await this.refreshDiscovery();
      trust = ownerTrust(this.data, accounts, owner, loading);
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
    // Only the devspaces of the accounts of Devspaces; hidden ones are not counted or named anywhere.
    const devspaces = availableDevspaces(entries, this.accounts);
    const repositoryGroups = this.repositoryGroups();
    const input: TreeInput = {
      discovery: this.data,
      accounts: this.accounts,
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

  /** refreshDiscoveryNow, while `refreshing` says that it runs. */
  private async runRefresh(): Promise<DiscoveryData | undefined> {
    this.refreshing = true;
    try {
      return await this.refreshDiscoveryNow();
    } finally {
      this.refreshing = false;
      this.passTokens = new Map();
    }
  }

  /**
   * The refresh of the lists: one account after the other, each with its own token, so that no more than
   * DISCOVERY_CONCURRENCY requests run at the same time. An account whose token GitHub rejected keeps its stored list
   * (no refresh, which would fail again, until its new sign-in); a failed refresh of one account keeps its stored list,
   * and the other accounts still refresh. When a list loaded, the repositories of the devspaces that no list has are
   * looked up.
   */
  private async refreshDiscoveryNow(): Promise<DiscoveryData | undefined> {
    if (this.disposed) return this.data;
    const afterRateLimit = this.retryingAfterRateLimit;
    this.retryingAfterRateLimit = false;
    let byUser = this.refreshByUser;
    this.refreshByUser = false;
    const changes = this.accountChanges;
    const accounts = await this.readAccounts();
    // The accounts changed while they were read: the refresh of that change uses the new ones.
    if (changes !== this.accountChanges) return this.data;
    if (accountIds(accounts) !== accountIds(this.accounts)) await this.useAccounts(accounts);
    // A session whose token GitHub rejected does not count as signed in (auth.ts).
    this.setSignedIn(accounts.length > 0 && (await this.authSignedIn()));
    if (!this.signedIn) {
      this.renderInBackground();
      return this.data;
    }
    let rateLimited = false;
    let failed = false;
    let refreshed = false;
    const passTokens = new Map<string, string>();
    this.passTokens = passTokens;
    for (const account of accounts) {
      if (this.disposed || changes !== this.accountChanges) break;
      const state = this.lists.get(account.id);
      // Token and account of one session: the list is stored for the account.
      const session = state === undefined ? undefined : await this.readSession(account);
      // Security: only a session of this account gives its list (stored under its ID).
      if (state === undefined || session?.account.id !== account.id) continue;
      passTokens.set(account.id, session.token);
      if (!(await this.authSignedIn(account))) {
        // GitHub rejected its token (also in a request outside this view): while another account keeps the view signed
        // in, only this offer says that the list of this account is not updated.
        this.offerSignInAgain(account);
        continue;
      }
      const outcome = await this.refreshAccount(state, session.token, { afterRateLimit, byUser });
      if (outcome === 'rateLimited') {
        rateLimited = true;
        // One message for the Refresh of the user (onRateLimited), also when GitHub refuses several accounts.
        byUser = false;
      }
      if (outcome === 'failed') failed = true;
      if (outcome === 'refreshed') refreshed = true;
    }
    // The refresh after a rate limit is no longer needed only when the lists loaded (a failed refresh keeps it).
    if (refreshed && !rateLimited && !failed) this.clearRateLimitRetry();
    // Without any list, the view says that the list could not be loaded (not that no repository was found).
    this.setLoadFailed((failed || rateLimited) && !this.hasList());
    // As before several accounts: only after a list loaded (without internet access, or while GitHub refuses the lists
    // for its rate limit, the lookups of the last refresh stay).
    if (refreshed && changes === this.accountChanges && !this.disposed) {
      const lookups = await this.lookUpUnlisted();
      if (changes === this.accountChanges) this.lookups = lookups;
    }
    this.setLoaded();
    this.renderInBackground();
    return this.data;
  }

  /**
   * The refresh of the list of one account with its token. The list replaces the shown one when it is complete and of
   * the current scope, while the account is still one of the view.
   */
  private async refreshAccount(
    state: AccountState,
    token: string,
    options: { afterRateLimit: boolean; byUser: boolean },
  ): Promise<'refreshed' | 'rateLimited' | 'failed' | 'dropped'> {
    const { account } = state;
    // The part of a first load that a rate limit stopped (onRateLimited) stays shown until this refresh gives its first
    // part (onPartialResult) or ends without a rate limit: a refresh that GitHub refuses at once keeps it.
    const progressive = state.data === undefined;
    if (!progressive) state.partial = undefined;
    state.progressive = progressive;
    let rateLimited = false;
    try {
      const data = await vscode.window.withProgress({ location: viewProgressLocation(this.deps.view) }, () => this.deps.discovery.refresh(token, account.id));
      // The account left while its list loaded, or the scope changed: the list is not shown (the refresh that the
      // change requested loads the list of the new scope).
      if (this.lists.get(account.id) !== state || !this.isOfCurrentScope(data)) return 'dropped';
      state.data = data;
      // The complete list is shown at once. The repositories of devspaces that it lacks follow; until then their rows
      // show what the previous refresh found.
      this.endProgressiveDisplay(state);
      this.setLoaded();
      this.renderInBackground();
      return 'refreshed';
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 401) this.offerSignInAgain(account);
      // A rate limit of GitHub: the part of the first load that the view shows stays, also for the next refresh.
      if (error instanceof GitHubRateLimitError) {
        rateLimited = true;
        this.onRateLimited(error, options.afterRateLimit, options.byUser);
      }
      // Without internet access, the view shows the stored list and skips the update.
      const shown = state.data ? 'The stored list is shown.' : 'No stored list exists.';
      this.deps.logger.warn(`The repository list of ${account.login} could not be updated. ${shown} ${errorMessage(error)}`);
      return rateLimited ? 'rateLimited' : 'failed';
    } finally {
      if (!rateLimited) this.endProgressiveDisplay(state);
    }
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

  /** The refresh of the progressive display of an account ended: the view shows no part of it anymore. */
  private endProgressiveDisplay(state: AccountState): void {
    const shown = state.partial !== undefined;
    state.progressive = false;
    state.partial = undefined;
    this.merge();
    if (shown) this.renderInBackground();
  }

  /**
   * The discovery stores the repositories of its scan, with and without a configuration. The repositories of the other
   * devspaces are asked one by one, each with the token of the owner account of its devspace, at most
   * DISCOVERY_CONCURRENCY at the same time (the refreshes have ended, so no other request of the lists runs), so the
   * view shows `not on GitHub` only for repositories that GitHub returns to none of the owner accounts of their
   * devspaces. A repository that one of these accounts could not ask about (a failed question, or an owner whose token
   * GitHub rejected) stays unknown, unless another account finds it.
   */
  private async lookUpUnlisted(): Promise<Map<string, RepositoryInfo | null>> {
    const result = new Map<string, RepositoryInfo | null>();
    const unknown = new Set<string>();
    const listed = listedRepositories(this.data);
    const available = await this.availableDevspaces();
    for (const account of this.accounts) {
      const devspaces = available.filter((devspace) => devspace.owner.id === account.id);
      // GitHub is not asked about repositories outside the scan scope; their rows get no `not on GitHub`. A repository
      // that another account did not find is asked again: each account sees its own repositories.
      const repositories = repositoriesToLookUp(devspaces, listed, this.deps.settings().owners).filter((repository) => !result.get(repositoryKey(repository)));
      if (repositories.length === 0 || this.disposed) continue;
      const session = (await this.authSignedIn(account)) ? await this.readSession(account) : undefined;
      if (session?.account.id !== account.id) {
        for (const repository of repositories) unknown.add(repositoryKey(repository));
        continue;
      }
      const token = session.token;
      await mapLimit(repositories, DISCOVERY_CONCURRENCY, async (repository) => {
        if (this.disposed) return;
        try {
          const info = await this.deps.discovery.getRepository(repository, token);
          result.set(repositoryKey(repository), info ?? null);
        } catch (error) {
          unknown.add(repositoryKey(repository));
          this.deps.logger.info(`GitHub could not be asked for ${repository}: ${errorMessage(error)}`);
        }
      });
    }
    for (const key of unknown) if (result.get(key) === null) result.delete(key);
    return result;
  }

  /** GitHub rejected the token of `account` (HTTP 401): offer a new sign-in of that account, once per window. */
  private offerSignInAgain(account: GitHubAccount): void {
    if (this.signInOffered.has(account.id)) return;
    this.signInOffered.add(account.id);
    showWarningMessage(this.accounts.length > 1 ? signInAgainDetailOf(account.login) : SIGN_IN_AGAIN_DETAIL, Actions.signIn)
      .then(async (choice) => {
        if (choice !== Actions.signIn) return;
        const token = await this.deps.auth.renewToken(account);
        if (token) await this.refreshDiscovery({ again: true });
      })
      .then(undefined, (error: unknown) => this.deps.logger.error('The new GitHub sign-in failed.', error));
  }

  /** The sign-in state of auth.ts, which alone sets the context key `devspaces.signedIn`. */
  private setSignedIn(signedIn: boolean): void {
    this.signedIn = signedIn;
  }

  /** auth.isSignedIn: of `account`, or without one of any account of Devspaces. */
  private async authSignedIn(account?: GitHubAccount): Promise<boolean> {
    try {
      return await this.deps.auth.isSignedIn(account);
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
   * Shows the lists of `accounts`: the stored list of each new account at once (or none, until the refresh); an account
   * that left takes its list, its part of a first load and the single lookups with it.
   */
  private async useAccounts(accounts: readonly GitHubAccount[]): Promise<void> {
    const left = this.accounts.some((account) => !accounts.some((each) => each.id === account.id));
    this.accounts = [...accounts];
    for (const id of [...this.lists.keys()]) if (!accounts.some((account) => account.id === id)) this.lists.delete(id);
    if (left) this.lookups = new Map();
    const added = accounts.filter((account) => !this.lists.has(account.id));
    for (const account of added) this.lists.set(account.id, { account, data: undefined, partial: undefined, progressive: false });
    this.merge();
    if (accounts.length === 0) {
      this.setLoaded(false);
      this.setLoadFailed(false);
      return;
    }
    await Promise.all(
      added.map(async (account) => {
        const stored = await this.deps.discovery.loadStored(account.id).catch((error: unknown) => {
          this.deps.logger.warn(`The stored repository list of ${account.login} could not be read: ${errorMessage(error)}`);
          return undefined;
        });
        const state = this.lists.get(account.id);
        // The account left meanwhile, or its refresh gave a list already.
        if (state === undefined || state.data !== undefined || stored === undefined) return;
        // A list of another scan scope may contain repositories outside the current one: the view waits for the refresh.
        if (!this.isOfCurrentScope(stored)) {
          this.deps.logger.info(`The stored repository list of ${account.login} was loaded for other organizations. It is loaded again.`);
          return;
        }
        state.data = stored;
      }),
    );
    this.merge();
    this.setLoaded(this.hasList());
    // Until the refresh of the new accounts ends: a list is shown, or the view loads.
    this.setLoadFailed(false);
  }

  /** Token and account of the GitHub session of `account`, without a dialog; undefined when it cannot be read. */
  private async readSession(account: GitHubAccount): Promise<{ token: string; account: GitHubAccount } | undefined> {
    try {
      return await this.deps.auth.getSession({ interactive: false, account });
    } catch (error) {
      this.deps.logger.warn(`The GitHub session of ${account.login} could not be read: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /** True if the list was built with the scan scope of the current settings (an empty scope: all repositories). */
  private isOfCurrentScope(data: DiscoveryData): boolean {
    return sameScope(data.scope, this.deps.settings().owners);
  }

  /** The accounts of Devspaces (auth.ts), without a dialog; empty when they cannot be read. */
  private async readAccounts(): Promise<GitHubAccount[]> {
    try {
      return await this.deps.auth.accounts();
    } catch (error) {
      this.deps.logger.warn(`The GitHub accounts could not be read: ${errorMessage(error)}`);
      return [];
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

