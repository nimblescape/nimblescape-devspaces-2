// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Controller: the commands of package.json and the flows of the window roles at activation. It connects the UI
// components (sidebar, status bar, switcher, progress, messages) with the devspace service, the Session Coordinator,
// and the Connection Adapter.
import * as path from 'path';
import * as vscode from 'vscode';
import { isBlockingBusyMark, isFreshPending, statusNamesDevspace, type WindowMark } from '../core/busy';
import { attachDiagnostics } from '../core/docker/attachDiagnostics';
import { LOCAL_DOCKER_TARGET, describeDockerHost, dockerHostOf, devspacesOfHost, hostAccessOf, isOnDockerHost, transportProgramOf, unsupportedTargetReason, type DockerTarget } from '../core/docker/dockerHost';
import { dockerEndpointUnsupported } from '../core/docker/remoteDocker';
import { engineInventory, inventoryIsEmpty, removalEndedNote, removeEngineInfrastructure, type EngineInventory, type RemovalResult } from '../core/docker/engineRemoval';
import { operationDockerTarget, outsideOperation, runWithDockerTarget, type DockerTargets } from '../core/docker/dockerTargets';
import type { BootstrapDocker } from '../core/docker/bootstrapDocker';
import type { DiscoveryService } from '../core/discovery/discoveryService';
import { GitHubApiError } from '../core/discovery/githubApi';
import { UserFacingError, errorMessage } from '../core/errors';
import { Actions, Messages, dockerHostReason, formatChanges, listSome } from '../core/messages';
import type { WindowStateValue } from '../core/helperChannel/protocol';
import { HOST_ACCESS_CHECKS_OFF_SETTING, hostAccessChecks, withHostAccessChecks, type HostAccessChecks } from '../core/policy/hostAccessChecks';
import { VSCODE_STORE_VOLUME, repositoryFolder, splitRepository } from '../core/names';
import { candidateOf, chooseAccount, listedCandidates, permissionText, rankAccounts, type AccountCandidate } from '../core/accountChoice';
import { availableDevspaces, isAvailableTo, ownerAmong } from '../core/ownership';
import { isoTime, systemClock, type Clock, type ProgressReporter } from '../core/ports';
import type { DevspaceOperations } from '../core/pipeline/devspaceOperations';
import { PipelineTexts, WINDOW_STATE_FLOW_TIMEOUT_MS, type DockerStarter, type OpenResult } from '../core/pipeline/operationBase';
import type { DockerEngineRecord, DockerEngineRecords, EngineRemoval } from '../core/storage/dockerEngineRecords';
import { lastUsedDevspaceOf, type DevspaceRegistry } from '../core/storage/registry';
import type { SessionFiles } from '../core/storage/sessionFiles';
import type {
  BusyMark,
  BusyOperation,
  Devspace,
  DevspaceSource,
  ExtensionSettings,
  GitHubAccount,
  PendingConnection,
  PendingOperation,
  PendingOperationKind,
  RepositoryInfo,
  WindowStatus,
} from '../core/types';
import { possibleSources, sourceOf, sourceOperationKey } from '../core/devspaceSource';
import { isProcessAlive, stopAfterSeconds } from '../core/session/sessionRules';
import { decideReopen, pipelineJustRan, sortPendingOperations } from './activationRules';
import type { VsCodeGitHubAuth } from './auth';
import { Commands, type CommandName } from './commands';
import type { ConnectionAdapter } from './connectionAdapter';
import type { WindowDocker } from './connection/authority';
import { ControllerTexts } from './controllerTexts';
import {
  DISCONNECT_REQUEST_MAX_AGE_MS,
  isFreshDisconnectRequest,
  type DisconnectRequest,
  type DisconnectRequests,
} from './disconnectRequests';
import type { DockerSetup } from './dockerSetup';
import type { MonitorQuestion } from './monitorQuestion';
import { isCancellation, showError as presentError } from './errors';
import { courseRepository, parseLink, type RepositoryLink } from './links';
import type { OutputChannelLogger } from './logger';
import { showErrorMessage, showInformationMessage, showWarningMessage } from './notifications';
import { selectOwners } from './ownerSelector';
import { setShowOnlyDevspaces } from './devspacesOnly';
import { FROM_PROGRESS_NOTIFICATION, HIDE_NOTIFICATIONS_COMMAND, runWithProgress, type BusyChange } from './progress';
import type { RemoteDockerCommands } from './remoteDockerCommands';
import type { WslSetupCommands } from './wslSetupCommands';
import type { RepositoryGroupsEditor } from './repositoryGroupsEditor';
import type { SessionCoordinator } from './sessionCoordinator';
import { RowActivationTracker, activatedRow, type ListOpenMode } from './rowActivation';
import { CONFIRM_OPEN_FROM_LINK_SETTING, SETTINGS_SECTION, hostAccessChecksOffValue, readListOpenMode } from './settings';
import type { Sidebar } from './sidebar';
import type { DevspaceStatusBar } from './statusBar';
import { pickRepository, showSwitcher, SwitcherTexts } from './switcher';
import { CoalescingTask, OperationGate } from './tasks';
import { parseCommandArgument, repositoryTarget, sourceChoices, type CommandArgument } from './targets';
import { TreeTexts, devspaceName, nonEmpty, recentDevspaces, repositoryRows, stateIcon } from './treeModel';
import { opensNewWindow, type WindowRequest } from './windowChoice';

/**
 * After "Close Remote Connection", the window reloads and this extension host ends. If it still runs after this time,
 * the user kept the connection (for example Cancel in the dialog about unsaved files): the pending operation is
 * removed. Assumption: the extension host of the old window ends within this time when the window reloads.
 */
const HANDOFF_CHECK_MS = 30_000;
/**
 * A window that left a devspace it must not use checks this long after "Close Remote Connection" that its
 * connection closed; a running extension host means that the user kept the connection.
 */
const LEAVE_CHECK_MS = 10_000;
/**
 * A window that leaves a devspace because of the GitHub account waits at most this long for the removal of the token
 * from the container before "Close Remote Connection": the close reloads the window and ends this extension host, and
 * with it a removal that has not ended. The removal usually takes a few seconds (the worker of the engine runs, or
 * starts). When it takes longer (for example the image of the worker must be built first), the window closes its
 * connection anyway, and the token stays in the memory of the container until the Monitor container stops it.
 */
const TOKEN_REMOVE_WAIT_MS = 30_000;
/**
 * The reopen rule looks at the other windows. Windows that VS Code restores at the same start write their status files
 * during their own activation; this pause lets them do so first.
 */
const REOPEN_CHECK_DELAY_MS = 3_000;
/**
 * "Remove Devspaces from This Docker Engine…" waits at most this long for the end of the background builds of the
 * helper image of this window on the engine after it stopped them (EngineRemovalDeps.stopHelperBuilds): a build that
 * does not end then (a Docker call that hangs) never holds the removal.
 */
export const HELPER_BUILDS_STOP_WAIT_MS = 30_000;
/** A Delete that waits for the operation of another window reads the registry this often. */
const BUSY_POLL_MS = 1_000;
/**
 * Set while this window is connected to a devspace (Close and Keep Running in the Command Palette).
 */
export const CONNECTED_CONTEXT_KEY = 'devspaces.connected';

/** The busy mark that a hand-off sets: a stop needs none, it does not change the container. */
const HAND_OFF_BUSY: Record<PendingOperationKind, BusyOperation | undefined> = {
  stop: undefined,
  rebuild: 'rebuild',
  delete: 'delete',
};

export interface ControllerDeps {
  logger: OutputChannelLogger;
  registry: DevspaceRegistry;
  /** True when registry.json is missing or lost content (DevspaceRegistry.needsRestore). */
  registryNeedsRestore: () => Promise<boolean>;
  sessionFiles: SessionFiles;
  /** Requests of other windows to close this window's connection first. */
  disconnectRequests: DisconnectRequests;
  docker: BootstrapDocker;
  /**
   * The operations of this window, each a flow in the worker of the Docker target, also the token removal
   * (removeTokenInWorker).
   */
  service: DevspaceOperations;
  discovery: DiscoveryService;
  auth: VsCodeGitHubAuth;
  connection: ConnectionAdapter;
  coordinator: SessionCoordinator;
  sidebar: Sidebar;
  statusBar: DevspaceStatusBar;
  settings: () => ExtensionSettings;
  /** The Docker setup: the commands of the setup in the sidebar. */
  dockerSetup: Pick<DockerSetup, 'install' | 'start' | 'installWsl' | 'show'>;
  /** The editor of the setting repositoryGroups. */
  repositoryGroupsEditor: Pick<RepositoryGroupsEditor, 'open'>;
  /** True while the sidebar view is visible: only then Docker is asked outside of operations. */
  viewVisible: () => boolean;
  /** Expand All of the view (treeView.ts expandAll). Default: nothing. */
  expandAll?: () => Promise<void>;
  /**
   * Shows a row of the view and opens its parents (treeView.ts revealRow): the child row that a double-click or Enter on
   * a repository with several sources starts. VS Code also opens or closes such a repository on a double-click, so the
   * row could be hidden. Default: nothing.
   */
  revealRow?: (rowId: string) => Promise<void>;
  /**
   * The current Docker host, read at the start of each operation (the Docker host of Devspaces), and the target of the
   * Docker host of a devspace (`ofHost`). Default: the local Docker.
   */
  dockerTargets?: Pick<DockerTargets, 'resolve' | 'current' | 'withOperation' | 'ofHost'>;
  /**
   * The address of the Docker pipe of the window of `devspace` with its container `containerName` (docs/architecture.md
   * "The Docker pipe"), which the authority of its window names (`settings.host`): for a devspace on an SSH host that
   * the connection of the relay reaches; undefined for every other devspace (a local one has no Docker settings in its
   * authority). Default: none.
   */
  windowDockerHost?: (devspace: Devspace, containerName: string) => string | undefined;
  /** "Use a Remote Docker Host…", "Use the Local Docker", and the choice of the first row of the view. */
  remoteDocker?: Pick<RemoteDockerCommands, 'useRemoteHost' | 'useLocalDocker' | 'chooseDockerHost'>;
  /** "Set Up Docker for Devspaces…" and "Remove the WSL Distribution of Devspaces…" (Windows). */
  wslSetup?: Pick<WslSetupCommands, 'setUp' | 'remove'>;
  /**
   * One heartbeat with the current keep-running flag of a devspace to the Monitor container of its engine
   * (Close and Keep Running, Keep Running When Closed, Stop When Closed), on every engine, through this window's worker
   * (WindowHeartbeats.sendFor; its `seq` is the time before it reads the flags, so it is later than the change in the
   * registry). Without it, Close and Keep Running refuses.
   */
  sessionMonitor?: {
    sendHeartbeat(devspaceId: string): Promise<{ ok: true } | { ok: false; detail: string }>;
    /**
     * The stopNow heartbeat of a manual Stop to the Monitor of the devspace's engine
     * (WindowHeartbeats.sendStop, within its short bound), so the engine stops the devspace itself whatever happens
     * to VS Code. Never throws.
     */
    sendStop(devspaceId: string): Promise<{ ok: true } | { ok: false; detail: string }>;
  };
  /**
   * "Update All Images Now": the Monitor of the engine `target` made sure and asked for its background run at
   * once (workerMonitor's monitorRunNow, with the monitor settings of this computer). Resolves when the monitor took
   * the request. Without it, the command does nothing.
   */
  updateImagesNow?: (target: DockerTarget, signal: AbortSignal) => Promise<void>;
  /**
   * The step "Docker start" of an operation, the function that DevspaceOperations gets (startDockerFor with
   * ensureDockerRunning), on the target of the running operation: a local Docker that does not run is started, Podman
   * is refused, and an SSH host gets the reachability check. "Update All Images Now" runs it in its progress, after
   * the question about the Monitor (beforeUserFlow) and before it sends its request to the Monitor. Default: nothing.
   */
  startDocker?: DockerStarter;
  /**
   * The question about the Monitor of an engine (MonitorQuestion; once per engine, never rejects), which a Start, a
   * Rebuild and "Update All Images Now" of the user ask before they run there (beforeUserFlow). The flows that run by
   * themselves never ask. Without it, nothing is asked.
   */
  monitorQuestion?: Pick<MonitorQuestion, 'askIfNeeded'>;
  /**
   * docker-engines.json: the removal mark of an engine ("Remove Devspaces from This Docker Engine…"), which a Start, a
   * Rebuild and "Update All Images Now" of the user clear on their engine (beforeUserFlow), and the entry of a removal
   * that runs in a window, which refuses those flows and every other operation on that engine (operation) in the other
   * windows while it runs.
   */
  engineRecords?: Pick<DockerEngineRecords, 'setRemoved' | 'record' | 'removing' | 'startRemoval' | 'endRemoval' | 'clearRemoved'>;
  /** "Remove Devspaces from This Docker Engine…" (removeFromDockerEngine). Without it, the command does nothing. */
  engineRemoval?: EngineRemovalDeps;
  /**
   * "Remove Devspaces from This Docker Engine…" ended on the engine `host`, with or without a change of its removal
   * mark (the start entry of the WSL distribution of Devspaces follows it). Never throws.
   */
  engineRemovalEnded?: (host: string) => void;
  /** The VS Code setting `workbench.list.openMode` (double-click on a row, rowActivation.ts). Default: `readListOpenMode`. */
  listOpenMode?: () => ListOpenMode;
  /** True in an Extension Development Host (a debug run of this extension): the reopen rule is relaxed. */
  development?: boolean;
  clock?: Clock;
  /** For tests. Default: `isProcessAlive`. */
  isAlive?: (pid: number) => boolean;
  /**
   * For tests: HANDOFF_CHECK_MS, LEAVE_CHECK_MS, TOKEN_REMOVE_WAIT_MS, REOPEN_CHECK_DELAY_MS,
   * DISCONNECT_REQUEST_MAX_AGE_MS, BUSY_POLL_MS, and HELPER_BUILDS_STOP_WAIT_MS.
   */
  timing?: {
    handOffCheckMs?: number;
    leaveCheckMs?: number;
    tokenRemoveWaitMs?: number;
    helperBuildsStopWaitMs?: number;
    reopenCheckDelayMs?: number;
    disconnectAnswerMs?: number;
    busyPollMs?: number;
    /** The pause between the checks of the container before the window connects. */
    readyPollMs?: number;
  };
}

/** What "Remove Devspaces from This Docker Engine…" needs besides the operations of the devspaces. */
export interface EngineRemovalDeps {
  /**
   * Whether the engine of `target` answers: Docker is never started for it, and a remote host gets the SSH check
   * without questions first (dockerEngineAnswers). Rejects only with an AbortError.
   */
  engineAnswers(target: DockerTarget, signal: AbortSignal): Promise<boolean>;
  /** The Docker CLI of the extension, for the inventory and the removal (engineRemoval.ts). */
  docker: Pick<BootstrapDocker, 'run' | 'listImagesByLabel'>;
  /** Ends the worker of this window on the engine of `target` (HelperChannels.close). */
  closeWorker(target: DockerTarget): void;
  /**
   * Stops the background builds of the helper image of this window on the Docker host of `target` (the prebuild at the
   * start, HelperPrebuild, and the build of a missing image, MissingHelperBuild), and waits for their end, so that
   * neither builds the image again after the removal. Never rejects. The removal waits for it at most
   * HELPER_BUILDS_STOP_WAIT_MS, and not after Cancel.
   */
  stopHelperBuilds?(target: DockerTarget): Promise<void>;
  /** The ID of this computer (computer.id), which a permanent Monitor of this computer names as its owner. */
  computerId(): string;
}

/** The names of the operations of a busy mark of another window, in the texts of the user. */
const BUSY_OPERATION_NAMES: Record<BusyOperation, string> = { create: 'Start', update: 'Update', rebuild: 'Rebuild', delete: 'Delete' };

/** The start of the key of a request of "Update All Images Now" in the gate of a window (monitorRequestKey). */
const MONITOR_REQUEST_KEY = 'monitor#';

/**
 * The key of the requests of "Update All Images Now" on the engine `host` in the gate of a window: one request per
 * engine at a time. It is never the key of a devspace (operationKey), whose repository has a slash before the `#`.
 */
function monitorRequestKey(host: string): string {
  return `${MONITOR_REQUEST_KEY}${host}`;
}

/** The checks of the container before the window connects (readyForWindow). */
const READY_CHECKS = 5;
const READY_POLL_MS = 1_000;
/** The longest wait for the log lines of the attach before the window connects. */
const ATTACH_DIAGNOSTICS_WAIT_MS = 3_000;

/** What a command works on. */
interface Target {
  /** `owner/name` as the command received it. */
  repository: string;
  /** GitHub data, if known. */
  info?: RepositoryInfo;
  /**
   * The devspace, read from the registry when the command started: the one that the command names (a row, the status
   * bar item, the switcher), or else the devspace of the repository of an account of Devspaces (repositoryTargetFor).
   */
  devspace?: Devspace;
  /**
   * The command names `devspace` (a row, the status bar item, the switcher, a restored window). Otherwise the
   * devspace belongs to the repository for the accounts of Devspaces, and Try again looks it up again for the accounts
   * of Devspaces then.
   */
  named?: boolean;
  /**
   * The source of the target (DevspaceSource): the one of its devspace (sourceOf), or, without a devspace, the one of
   * the row or of the pick of the source, which the first Start creates the devspace from. Missing: a target of a
   * repository with one source that the discovery does not know yet (the open takes its first configuration).
   */
  source?: DevspaceSource;
  /**
   * The GitHub account that the command uses (accountChoice.ts): the owner of the devspace, or the account that the
   * first open creates the devspace with. Missing: not chosen (a command other than Start on a repository without a
   * devspace; the open of a devspace always uses its owner).
   */
  account?: GitHubAccount;
  /** The user or the link chose `account` (Start with Account…, a course link): Try again keeps it. */
  chosenAccount?: true;
}

/** What GitHub says about a repository for one account (Controller.lookUpRepository). */
type LookUpResult = { info: RepositoryInfo; failure?: undefined } | { info?: undefined; failure: 'notFound' | 'rejected' | 'unknown' };

/** The repository that a link opens (Controller.startFromLink). */
interface LinkRepository {
  repository: string;
  /** Its GitHub data; missing when GitHub could not be asked. */
  info?: RepositoryInfo;
  /** A course link: the account of the login in the name, which opens it. */
  account?: GitHubAccount;
  /** A link `/open` of a repository in no list: the accounts that GitHub shows it to. */
  candidates?: AccountCandidate[];
}

interface StartOptions {
  /**
   * The window that connects: plain Start follows the setting openInNewWindow (default); Start in New Window and Start
   * in Current Window name it. Default: `default`.
   */
  window?: WindowRequest;
  /**
   * First open only: what the open builds the devspace from (DevspaceSource), when the target names none. An existing
   * devspace keeps the source it was created with (sourceOf), whatever the options name.
   */
  source?: DevspaceSource;
  /**
   * The reopen at startup: a Start that the user did not start, so it asks nothing about the Monitor of the engine
   * (beforeUserFlow). Its Try again is a Start of the user.
   */
  automatic?: boolean;
  /**
   * First open from a link only (openLink): the user confirmed the first open already, before any Docker work, so the
   * pipeline asks no question about the owner. Without it, the trust is read at the first open (firstOpenTrust).
   */
  confirmed?: boolean;
}

/** The devspace that this window is attached to. A window changes its devspace only by reloading. */
interface WindowDevspace {
  devspace: Devspace;
  /** Container name from the folder URI of the window. */
  containerName: string;
  /** The container does not run: the status bar shows Reconnect. */
  lost: boolean;
  /** Branch read from the container. */
  branch?: string;
  /** The last check of the connection could not read the state (unknown). */
  unknown?: boolean;
}

/**
 * A devspace that this window left because it must not use it, while the window may still be attached to its
 * container: the devspace of another account (or of nobody, after a sign-out), a container of an older version, or,
 * on an engine with the removal mark, a container whose owner cannot be read and whose labels name no devspace
 * (`unknownOwner`, Controller.leaveUnknownOwner: only its name is known, so no token can be removed from it).
 */
type LeftDevspace =
  | { devspaceId: string; containerName: string; repository: string; reason: 'account' | 'outdated' }
  | { containerName: string; repository: string; reason: 'unknownOwner' };

/** A LeftDevspace whose devspace is known (its ID). */
type KnownLeftDevspace = Extract<LeftDevspace, { devspaceId: string }>;

/**
 * A flow that connects this window (numbered, see `connectingFlow`), or a new window. `automatic`: the reopen at
 * startup, which does not connect this window while a link opens (openLink).
 */
type ConnectRequest = { newWindow: false; number: number; automatic?: boolean } | { newWindow: true };

type HandOffRequest = Pick<PendingOperation, 'operation' | 'reason' | 'additionalVolumesToRemove'>;

/** What a command without argument asks for: `open` is a repository that the command opens (Start). */
type PickKind = 'open' | 'repository' | 'devspace' | 'gitHub';

export class Controller implements vscode.Disposable {
  private readonly gate = new OperationGate();
  private readonly clock: Clock;
  private readonly isAlive: (pid: number) => boolean;
  private readonly timers = new Set<NodeJS.Timeout>();
  private current: WindowDevspace | undefined;
  /**
   * This window runs the open pipeline of role A (openAttachedWindow), or works without Devspaces on an engine with the
   * removal mark (workWithoutDevspaces), so a restore of the registry never adopts a devspace for it; `adoption`: the
   * adoption that runs; `adopted`: an adoption found the devspace of this window (it took it or left it), so no later
   * restore adopts it again.
   */
  private attaching = false;
  /**
   * The devspace of this window when it works without Devspaces on an engine with the removal mark
   * (workWithoutDevspaces, which says so once per window). An account change checks it as the devspace of this window
   * (onSessionChanged).
   */
  private withoutDevspaces: { devspace: Devspace; containerName: string } | undefined;
  private adoption: Promise<void> | undefined;
  private adopted = false;
  /** See `LeftDevspace`; checked until the window has closed its connection (`checkLeftConnection`). */
  private left: LeftDevspace | undefined;
  private checkingLeft = false;
  private ready: Promise<void> = Promise.resolve();
  private checkingConnection = false;
  /**
   * The devspace of this window whose container could not be read for whether it is outdated when the window
   * attached (containerOutdated); checkConnection reads it again. With the host access checks of its repository then;
   * turning them on later applies from the next open.
   */
  private outdatedUncheckedFor: { devspaceId: string; checks: HostAccessChecks } | undefined;
  /** Numbers the flows that connect this window (see `connect`). */
  private connectRequests = 0;
  /** The connecting flows that still run. */
  private readonly activeConnectRequests = new Set<number>();
  /** The links that are opening (openLink): the automatic reopen of the last devspace does not start meanwhile. */
  private linksOpening = 0;
  /** Links wait for this promise: the end of the activation, when this window knows its role and its devspace. */
  private activation: Promise<void> = Promise.resolve();
  /** One check of the disconnect requests at a time; a change during a check runs one more check. */
  private readonly disconnectTask = new CoalescingTask(() => this.checkDisconnectRequest());
  private disconnectWatcher: { dispose(): void } | undefined;
  private disposed = false;
  /** The last value of CONNECTED_CONTEXT_KEY. */
  private connectedContext: boolean | undefined;
  /** Tells a double-click on a repository row from a single click (rowActivated). */
  private readonly rowActivations: RowActivationTracker;
  /**
   * The engine that "Remove Devspaces from This Docker Engine…" removes Devspaces from now (its Docker host, and its name:
   * describeDockerHost): no other operation of this window starts meanwhile, and no restore from the volumes there.
   */
  private removingFrom: { host: string; engine: string } | undefined;
  /** The VS Code command list.select failed on Enter (rowEnter); logged once per window. */
  private listSelectFailed = false;
  /** The VS Code command that hides the notifications failed (showLog); logged once per window. */
  private hideNotificationsFailed = false;

  constructor(private readonly deps: ControllerDeps) {
    this.clock = deps.clock ?? systemClock;
    this.isAlive = deps.isAlive ?? isProcessAlive;
    this.rowActivations = new RowActivationTracker(this.clock);
  }

  private get logger(): OutputChannelLogger {
    return this.deps.logger;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Setup

  /**
   * Operations wait for this promise: the window status file must exist first, so that other windows and the Session
   * Monitor count this window's busy marks as live.
   */
  setReady(ready: Promise<unknown>): void {
    this.ready = ready.then(
      () => undefined,
      () => undefined,
    );
  }

  /** The end of the activation, for the links (openLink), also of an activation that failed. */
  setActivation(activation: Promise<unknown>): void {
    this.activation = activation.then(
      () => undefined,
      () => undefined,
    );
  }

  /** Registers the commands of package.json (controller.test.ts counts them). A command never rejects: errors are shown. */
  registerCommands(): vscode.Disposable[] {
    const handlers: Record<CommandName, (argument: unknown) => Promise<void>> = {
      start: (argument) => this.start(parseCommandArgument(argument)),
      startInNewWindow: (argument) => this.start(parseCommandArgument(argument), 'newWindow'),
      startInCurrentWindow: (argument) => this.start(parseCommandArgument(argument), 'currentWindow'),
      startWithAccount: (argument) => this.startWithAccount(parseCommandArgument(argument)),
      stop: (argument) => this.stop(parseCommandArgument(argument)),
      delete: (argument) => this.delete(parseCommandArgument(argument)),
      rebuild: (argument) => this.rebuild(parseCommandArgument(argument)),
      showOnGitHub: (argument) => this.showOnGitHub(parseCommandArgument(argument)),
      switchDevspace: () => this.switchDevspace(),
      switchDevspaceInNewWindow: () => this.switchDevspace('newWindow'),
      switchDevspaceInCurrentWindow: () => this.switchDevspace('currentWindow'),
      refresh: () => this.refresh(),
      updateImagesNow: () => this.updateImagesNowCommand(),
      removeFromDockerEngine: () => this.removeFromDockerEngine(),
      search: () => this.search(),
      showLog: (argument) => this.showLog(argument),
      signIn: () => this.signIn(),
      addAccount: () => this.addAccount(),
      selectOwners: () => this.selectOwners(),
      selectOwnersFiltered: () => this.selectOwners(),
      showOnlyDevspaces: () => setShowOnlyDevspaces(true),
      showAllRepositories: () => setShowOnlyDevspaces(false),
      expandAll: async () => this.deps.expandAll?.(),
      editRepositoryGroups: () => this.deps.repositoryGroupsEditor.open(),
      turnOffHostAccessChecks: (argument) => this.turnOffHostAccessChecks(parseCommandArgument(argument)),
      turnOnHostAccessChecks: (argument) => this.turnOnHostAccessChecks(parseCommandArgument(argument)),
      keepRunning: (argument) => this.setKeepRunning(parseCommandArgument(argument), true),
      stopWhenClosed: (argument) => this.setKeepRunning(parseCommandArgument(argument), false),
      closeAndKeepRunning: () => this.closeAndKeepRunning(),
      dockerSetupInstall: () => this.deps.dockerSetup.install(),
      dockerSetupStart: () => this.deps.dockerSetup.start(),
      dockerSetupInstallWsl: () => this.deps.dockerSetup.installWsl(),
      dockerSetupShow: () => this.deps.dockerSetup.show(),
      useRemoteDockerHost: async () => this.deps.remoteDocker?.useRemoteHost(),
      useLocalDocker: async () => this.deps.remoteDocker?.useLocalDocker(),
      chooseDockerHost: async () => this.deps.remoteDocker?.chooseDockerHost(),
      setUpWslDistribution: async () => this.deps.wslSetup?.setUp(),
      removeWslDistribution: async () => this.deps.wslSetup?.remove(),
      rowActivated: (argument) => this.rowActivated(argument),
      rowEnter: () => this.rowEnter(),
    };
    // Each command is one operation: on the Docker host of the devspace that it names (a row, the status bar item), else
    // on the Docker host that is current when it starts (withCommandTarget); the commands that change the host read it
    // themselves. A click or Enter on a row is no operation: only the Start of a double-click or of Enter is one. Show
    // Log reads no Docker host, so the log opens at once also while the Docker CLI does not answer (the link Show
    // details of a running operation).
    const ownTarget = new Set<CommandName>([
      'useRemoteDockerHost',
      'useLocalDocker',
      'chooseDockerHost',
      'setUpWslDistribution',
      'removeWslDistribution',
      'rowActivated',
      'rowEnter',
      'showLog',
    ]);
    const run = async (name: CommandName, argument: unknown): Promise<void> => {
      // Enter on a row whose command is another command of Devspaces (the Sign in row, the Docker host row) ends with
      // that command: a click on a repository row right after it only selects that row (rowActivation.ts).
      if (name !== 'rowEnter' && name !== 'rowActivated') this.rowActivations.forgetEnter();
      try {
        if (ownTarget.has(name)) await handlers[name](argument);
        else await this.withCommandTarget(parseCommandArgument(argument), () => handlers[name](argument));
      } catch (error) {
        this.showError(error);
      }
    };
    return (Object.keys(handlers) as CommandName[]).map((name) =>
      vscode.commands.registerCommand(Commands[name], (argument: unknown) => run(name, argument)),
    );
  }

  /** Status bar "Updating owner/name…" while a pipeline runs. */
  onBusyChanged(change: BusyChange): void {
    if (change.busy && change.repository) this.deps.statusBar.showBusy(change.repository);
    else this.deps.statusBar.clearBusy();
  }

  /**
   * Every 15 seconds (the window heartbeat): is the container of this window still running, and does another window ask
   * this window to close its connection?
   */
  onHeartbeat(): void {
    this.background(this.checkConnection(), 'check the connection');
    this.onDisconnectRequested();
  }

  /**
   * Watches the disconnect requests of other windows, so that this window answers at once; the heartbeat checks them
   * as well. Call once at activation.
   */
  watchDisconnectRequests(): vscode.Disposable {
    this.disconnectWatcher?.dispose();
    this.disconnectWatcher = this.deps.disconnectRequests.watch(
      () => this.onDisconnectRequested(),
      (error) => this.logger.warn(`The requests of other windows cannot be watched: ${errorMessage(error)}`),
    );
    return {
      dispose: () => {
        this.disconnectWatcher?.dispose();
        this.disconnectWatcher = undefined;
      },
    };
  }

  /**
   * A disconnect request may have changed. Only a window with a devspace answers, also one that works without
   * Devspaces (workWithoutDevspaces).
   */
  onDisconnectRequested(): void {
    if (!(this.current ?? this.withoutDevspaces) || this.disposed) return;
    this.background(this.disconnectTask.request(), 'check the requests of other windows');
  }

  /**
   * The branches of the running containers were read, or the sidebar was rendered: the status bar shows the current
   * branch, and the name of the devspace as the sidebar shows it now (with the word of its source when the repository
   * has several sources, which the list of the sidebar and the settings decide).
   */
  onStatesRefreshed(): void {
    const current = this.current;
    if (!current) return;
    const branch = this.deps.sidebar.liveBranch(current.devspace.id);
    if (branch && branch !== current.branch) current.branch = branch;
    this.updateStatusBar();
  }

  dispose(): void {
    this.disposed = true;
    this.disconnectWatcher?.dispose();
    this.disconnectWatcher = undefined;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Window roles at activation

  /**
   * Role A: VS Code restored this window, reloaded it, or our own `vscode.openFolder` opened it, attached to the
   * container of `devspace`. Unless the open pipeline has just run for it (a fresh pending connection file), the
   * pipeline runs now (the check before each connection; the Docker start, container start, recreation). activate()
   * awaits this.
   */
  async openAttachedWindow(
    attached: Devspace,
    containerName: string,
    pending: PendingConnection | undefined,
  ): Promise<void> {
    this.attaching = true;
    // The devspace of another account runs no pipeline and starts no container; the window closes.
    const devspace = await this.ownWindowDevspace(attached, containerName);
    if (!devspace) return;
    // The window knows its Docker host from its devspace: the pipeline runs there, whatever host Devspaces uses now (for
    // example a window of Open Recent after the user chose another host).
    await this.withHostOf(devspace, () => this.openAttachedDevspace(devspace, containerName, pending));
  }

  /**
   * Role A on an engine with the removal mark ("Remove Devspaces from This Docker Engine…"): VS Code restored this
   * window of a devspace that the user kept there, Open Recent opened it, or the user attached to its container by
   * hand, for example to save changes that are not pushed. The account rule comes first, as in openAttachedWindow: it
   * outranks the mark. A devspace that the signed-in account may not use (another account's, or nobody is signed in)
   * closes the window after the token of its owner left the container through the worker of the engine
   * (ownWindowDevspace), also when that builds the helper image there again; so does a later sign-out or change of the
   * account (onSessionChanged). A devspace of the account: the window stays connected and works as a plain container
   * window: no open pipeline and no Docker work, and its session runs without the devspace (extension.ts), so no
   * heartbeat (whose repair would create the Monitor again) and no stop on close. One line in the log and one
   * information message, once per window. A Start of the devspace sets Devspaces up there again.
   */
  async workWithoutDevspaces(attached: Devspace, containerName: string): Promise<void> {
    // Nor does a restore of the registry adopt the devspace for this window.
    this.attaching = true;
    const devspace = await this.ownWindowDevspace(attached, containerName);
    if (devspace === undefined || this.withoutDevspaces) return;
    this.withoutDevspaces = { devspace, containerName };
    // An account change while the account was read found no devspace of this window yet: check the account again now
    // (as stillAvailable does).
    await this.onSessionChanged();
    if (this.withoutDevspaces?.devspace.id !== devspace.id) return;
    // The status file names it apart from the devspace of the window, so that the removal and the Stop, Rebuild and
    // Delete of other windows see this window (devspacesInUse, connectedInOtherWindow).
    await this.deps.coordinator
      .setPlainDevspace(devspace.id)
      .catch((error: unknown) => this.logger.warn(`The window status could not be written: ${errorMessage(error)}`));
    const repository = this.shownName(this.devspaceTarget(devspace));
    const engine = describeDockerHost(dockerHostOf(devspace));
    this.logger.info(
      `This window of ${repository} works without Devspaces: Devspaces was removed from ${engine}. No background updates and no stop on close; a Start of ${repository} sets Devspaces up there again.`,
    );
    this.inform(ControllerTexts.windowOnRemovedEngine(engine));
  }

  /**
   * Role A whose Docker pipe this window does not serve (windowPipe.ts, `refused`): through the authority, the Dev
   * Containers extension would reach no engine, or on Windows a named pipe of that name that another program serves.
   * The window closes its remote connection before VS Code resolves the authority, with a message, and runs no open
   * pipeline.
   */
  async leaveWithoutDockerPipe(containerName: string, reason: string): Promise<void> {
    // Nor does a restore of the registry adopt the devspace for this window.
    this.attaching = true;
    this.logger.info(`The window closes its remote connection: its Docker pipe is not served (${reason})`);
    await this.leaveDevspace(ControllerTexts.dockerPipeNotServed(containerName));
  }

  /**
   * Role A on an engine with the removal mark after the registry lost its content (nothing is restored there), when the
   * labels of the container of this window do not say whose devspace it is (removedEngineWindowDevspace): the account
   * rule cannot be checked, so the window closes its remote connection, as for the devspace of another account. When
   * the labels name the devspace, the token of its owner leaves the container first, through the worker of the engine
   * (leaveDevspace); without its ID, nothing can find the container's token. Either way, a window that keeps its
   * connection (Cancel on unsaved files) closes it again (checkLeftConnection), as for the devspace of another account.
   */
  async leaveUnknownOwner(containerName: string, unknown: { devspaceId?: string; reason: string }): Promise<void> {
    // Nor does a restore of the registry adopt the devspace for this window.
    this.attaching = true;
    this.logger.info(`The window closes its remote connection: the owner of the devspace of the container ${containerName} cannot be read (${unknown.reason}).`);
    await this.leaveDevspace(
      ControllerTexts.unknownOwnerConnection(containerName),
      unknown.devspaceId === undefined
        ? { containerName, repository: containerName, reason: 'unknownOwner' }
        : { devspaceId: unknown.devspaceId, containerName, repository: containerName, reason: 'account' },
    );
  }

  private async openAttachedDevspace(
    devspace: Devspace,
    containerName: string,
    pending: PendingConnection | undefined,
  ): Promise<void> {
    this.current = { devspace, containerName, lost: false };
    this.updateStatusBar();
    // A window connects again, so Close and Keep Running has done its work.
    await this.clearKeepRunningOnce(devspace.id);
    // An account change while the window checked its devspace found no devspace of this window yet. Check the
    // account again now that the window has one; the window leaves (and the token file is removed) when the devspace
    // is not the account's.
    if (!(await this.stillAvailable(devspace))) return;
    const repository = this.displayName({ repository: devspace.repository });
    if (pipelineJustRan(pending, devspace.id, this.clock.now())) {
      this.logger.info(`The open pipeline of ${repository} has just run for this window.`);
    } else {
      this.logger.info(`This window was restored or reloaded. The open pipeline of ${repository} runs before it connects.`);
      // Assumption: activation through ATTACHED_CONTAINER_ACTIVATION_EVENT blocks the connection until activate()
      // resolves, also when the pipeline starts Docker or updates the devspace for several minutes.
      const shown = this.shownName(this.devspaceTarget(devspace));
      const succeeded = await this.operation(
        this.keyOfDevspace(repository, devspace),
        'Open',
        () =>
          runWithProgress({
            title: Messages.opening(shown),
            repository: shown,
            cancellable: true,
            task: async (progress, signal) => {
              // The devspace opens with its own source (sourceOf, with the default image of the settings now, so that a
              // changed setting is noticed: Rebuild now / Later), as every other open of an existing devspace.
              await this.deps.service.openDevspaceInWorker(devspace.id, { progress, signal, source: sourceOf(devspace, this.deps.settings()) });
            },
          }),
        { retry: this.retryOn(devspace, () => this.start({ kind: 'devspace', devspaceId: devspace.id })) },
      );
      if (!succeeded) {
        // "Delete devspace" for missing files removed the devspace of this window.
        if (await this.leaveDeletedDevspace(devspace.id)) return;
        // The pipeline did not make the container of an older version again (for example the host access policy refused
        // the configuration, or the user cancelled). That container lacks the current setup, so the window must not
        // attach to it. A current container stays: it passed the policy when it was made. So does a container that was
        // made while the host access checks were off, when they are on now and the pipeline refused the configuration:
        // it must not be used as it is.
        const outdated = this.current?.devspace.id === devspace.id ? await this.containerOutdated(devspace) : undefined;
        if (outdated) {
          this.logger.info(`${this.outdatedTexts(outdated, repository).log} It was not made again.`);
          await this.leaveDevspace(this.outdatedTexts(outdated, repository).message, {
            devspaceId: devspace.id,
            containerName,
            repository,
            reason: 'outdated',
          });
          return;
        }
        // The pipeline refuses a devspace that the account signed in now may not use (otherAccount): the window leaves
        // it and its token file, instead of keeping the connection.
        if (this.current?.devspace.id === devspace.id && !(await this.stillAvailable(devspace))) return;
        // The window shows its own connection error; the status bar offers Reconnect.
        if (this.current) {
          this.current.lost = true;
          this.updateStatusBar();
        }
      }
    }
    this.background(this.readWindowBranch(), 'read the branch of the devspace');
  }

  /**
   * Role B: an empty window. First the pending operations that a window left when it closed its remote connection,
   * oldest first; then the reopen rule (decideReopen).
   *
   * `activatedAt`: the time at which the window's activation began (`activate()` passes it), taken before any await.
   * The age of the reopen record is measured at this time, not at the check: the awaits (the window status, the stale
   * claims, the operations, the GitHub account) and the pause of REOPEN_CHECK_DELAY_MS take several seconds, and a
   * Close Remote Connection whose empty window activates 2 to 3 seconds later must still count as younger than
   * REOPEN_MIN_AGE_MS.
   */
  async runEmptyWindowTasks(activatedAt: number = this.clock.now()): Promise<void> {
    await this.withDockerTarget(() => this.runEmptyWindowTasksNow(activatedAt));
  }

  private async runEmptyWindowTasksNow(activatedAt: number): Promise<void> {
    await this.ready;
    const { sessionFiles, coordinator, registry, connection } = this.deps;
    await sessionFiles
      .cleanupStaleClaims()
      .catch((error: unknown) => this.logger.warn(`Old claimed operations could not be removed: ${errorMessage(error)}`));
    // An operation file that cannot be read is not run and not dropped, and the user is told; the operations of the
    // other devspaces still run (the files are per devspace).
    let known: Awaited<ReturnType<typeof sessionFiles.readOperationsKnown>>;
    try {
      known = await sessionFiles.readOperationsKnown();
    } catch (error) {
      this.logger.warn(`The pending operations could not be read: ${errorMessage(error)}`);
      this.warn(ControllerTexts.pendingOperationsUnreadable(errorMessage(error)));
      return;
    }
    for (const { file, error } of known.unreadable) {
      const cause = `${path.basename(file)}: ${errorMessage(error)}`;
      this.logger.warn(`A pending operation could not be read: ${cause}`);
      this.warn(ControllerTexts.pendingOperationsUnreadable(cause));
    }
    const { runnable, stale } = sortPendingOperations(known.operations, this.clock.now());
    for (const operation of stale) {
      this.logger.info(`The pending ${operation.operation} of ${operation.devspaceId} is too old and is dropped.`);
      await this.removeOperationQuietly(operation.devspaceId);
    }
    const accounts = await this.readAccounts();
    const dockerHost = await this.currentDockerHost();
    for (const operation of runnable) {
      if (this.disposed) return;
      // An operation of a devspace of an account that Devspaces does not use is not run by this window; it expires.
      const target = await registry.get(operation.devspaceId);
      if (target && ownerAmong(target, accounts) === undefined) {
        this.logger.info(
          `The pending ${operation.operation} of ${operation.devspaceId} is for a GitHub account that Devspaces does not use. It is not run.`,
        );
        continue;
      }
      // It runs on the Docker host of its devspace, whatever host Devspaces uses now; not when that host is not supported
      // now (the local Docker set to an endpoint that Devspaces does not use), and it expires.
      // The target is read for each operation: an operation before it may run for minutes, and the local Docker may change.
      const engine = target ? await this.hostTargetOf(target) : undefined;
      if (target && engine && !isOnDockerHost(target, engine.host)) {
        this.logger.info(`The pending ${operation.operation} of ${operation.devspaceId} is for ${describeDockerHost(dockerHostOf(target))}, which is not supported now. It is not run.`);
        continue;
      }
      let claimed: PendingOperation | undefined;
      try {
        claimed = await sessionFiles.claimOperation(operation.devspaceId, coordinator.windowId);
      } catch (error) {
        this.logger.warn(`The pending operation of ${operation.devspaceId} could not be claimed: ${errorMessage(error)}`);
        continue;
      }
      if (claimed) {
        const pending = claimed;
        await (engine ? runWithDockerTarget(engine, () => this.runPendingOperation(pending)) : this.runPendingOperation(pending));
      }
    }
    // Not known whether an operation is pending: the window is not opened again.
    if (runnable.length > 0 || known.unreadable.length > 0) return;

    await this.delay(this.deps.timing?.reopenCheckDelayMs ?? REOPEN_CHECK_DELAY_MS);
    if (this.disposed) return;
    const [others, operations, record, devspaces] = await Promise.all([
      coordinator.otherActiveWindows(),
      sessionFiles.readOperations(),
      sessionFiles.readReopen(),
      registry.list(),
    ]);
    const decision = decideReopen({
      settings: this.deps.settings(),
      emptyWindow: connection.isEmptyWindow(),
      otherActiveWindows: others.length,
      otherConnectedWindows: others.filter((status) => status.devspaceId !== null).length,
      pendingOperations: operations.length,
      record,
      // Only a devspace of an account of Devspaces is opened again, and only of the current Docker host.
      devspaceIds: new Set(
        availableDevspaces(devspacesOfHost(devspaces, dockerHost), accounts).map((devspace) => devspace.id),
      ),
      // The age of the record at activation (see `activatedAt`), not after the awaits and the pause.
      now: activatedAt,
      development: this.deps.development,
    });
    if (!decision.reopen) {
      this.logger.info(`The last devspace is not opened: ${decision.reason}.`);
      return;
    }
    const devspace = devspaces.find((candidate) => candidate.id === decision.devspaceId);
    if (!devspace) return;
    // After "Remove Devspaces from This Docker Engine…" there, the reopen would set Devspaces up again by itself (its open
    // creates the Monitor). A Start of the user there clears the mark.
    if (await this.hasRemovalMark(dockerHost)) {
      this.logger.info(`The last devspace is not opened: Devspaces was removed from ${describeDockerHost(dockerHost)}. A Start there sets it up again.`);
      return;
    }
    // A Start of the user in this window (also one that still asks about the Monitor), or a link, is not overtaken.
    if (this.activeConnectRequests.size > 0 || this.linksOpening > 0) {
      this.logger.info('The last devspace is not opened: another devspace is opening in this window.');
      return;
    }
    this.logger.info(`Opening the devspace of the window that closed last, ${devspace.repository}.`);
    // The progress notification "Opening owner/name…" has Cancel: the user can stay in the empty window. The user did
    // not start it, so it asks nothing about the Monitor of the engine.
    await this.startTarget(this.devspaceTarget(devspace), { automatic: true });
  }

  /**
   * Entries for the volumes with the label nimblescape.devspaces.id, when registry.json is missing, not
   * valid, or has invalid entries. Only when Docker runs; Docker is not started for this. By the worker of the Docker
   * host; `passive` (the default, a call in the background): it is made ready as for the refresh. `adopt`, for a window
   * whose container the registry did not know at activation (no open pipeline runs for it): it takes its devspace
   * also when the registry was restored already (by an earlier restore of this window whose answer came too late, or by
   * another window). Not while Devspaces is being removed from the engine (restoreRefusedWhileRemoving); `user`, a
   * Refresh of the user, is told then. `user` and `mayStart` (a window of a container on that Docker host, which starts
   * it anyway) may start a WSL distribution that does not run (reconcileInWorker).
   */
  async reconcileIfRegistryLost(options: { passive: boolean; adopt?: boolean; user?: boolean; mayStart?: boolean } = { passive: true }): Promise<void> {
    await this.withDockerTarget(() => this.reconcileIfRegistryLostNow(options));
  }

  private async reconcileIfRegistryLostNow(options: { passive: boolean; adopt?: boolean; user?: boolean; mayStart?: boolean }): Promise<void> {
    const { docker, service } = this.deps;
    // Also when registry.json exists but its content is lost (not valid, or invalid entries), not only when it is missing.
    if (!(await this.deps.registryNeedsRestore())) {
      if (options.adopt === true) await this.adoptWindowDevspace();
      return;
    }
    // reconcileInWorker checks the Docker target first (never an endpoint that is neither local nor SSH), then whether
    // Docker runs; no `docker info` here before that check. By the worker of the Docker host.
    const target = await this.operationTarget();
    if (!docker.canRunOn(target)) return;
    if (await this.restoreRefusedWhileRemoving(target.host, options.user === true)) return;
    // The Refresh of the user, and the window of a devspace on that host (`mayStart`), may start a WSL distribution that
    // does not run.
    const mayStart = options.user === true || options.mayStart === true;
    const added = await service.reconcileInWorker({ passive: options.passive, ...(mayStart ? { mayStart } : {}) });
    if (added === 0 && options.adopt !== true) return;
    await this.adoptWindowDevspace();
    if (added > 0) await this.deps.sidebar.render();
  }

  /**
   * Whether the restore from the volumes of the engine `host` must not run now: this window (removingFrom) or another
   * live window (otherWindowRemoval) removes Devspaces from that engine, and the worker of the restore would build the
   * helper image and create the shared volumes there again while they are removed. Logged; `tell` (a Refresh of the
   * user) shows the message of a refused operation too. After the removal, a Refresh restores there again.
   */
  private async restoreRefusedWhileRemoving(host: string, tell: boolean): Promise<boolean> {
    const engine = describeDockerHost(host);
    if (this.removingFrom?.host === host) {
      this.logger.info(`The devspaces are not restored from the volumes on ${engine}: Devspaces is being removed from there.`);
      if (tell) this.inform(ControllerTexts.removalRunning(engine));
      return true;
    }
    const other = await this.otherWindowRemoval(host);
    if (other === undefined) return false;
    this.logger.info(`The devspaces are not restored from the volumes on ${engine}: Devspaces is being removed from there in another window (process ${other.pid}).`);
    if (tell) this.inform(ControllerTexts.removalRunningElsewhere(engine));
    return true;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Commands

  /**
   * Start. `window`: Start in New Window or Start in Current Window; plain Start follows the setting openInNewWindow.
   */
  async start(argument: CommandArgument, window: WindowRequest = 'default'): Promise<void> {
    const target = await this.resolveTarget(argument, 'open', this.repositoryPlaceholder(window));
    if (target) await this.startTarget(target, { window });
  }

  /**
   * Start with Account… (the context menu of a row whose repository two or more accounts of Devspaces can access): the
   * devspace of the source of the row of the account that the user picks, else a new one of it, with its own clone,
   * container and images. The devspace of another account stays as it is; a later Start opens the one used last.
   */
  async startWithAccount(argument: CommandArgument): Promise<void> {
    if (argument.kind !== 'row') return;
    const accounts = await this.requireAccounts();
    const info = this.deps.sidebar.repositoryInfo(argument.repository) ?? argument.info;
    const repository = info?.nameWithOwner ?? argument.repository;
    const named = argument.devspaceId !== undefined ? await this.deps.registry.get(argument.devspaceId) : undefined;
    const source = named ? sourceOf(named) : argument.source;
    const candidates = rankAccounts(repository, listedCandidates(info, accounts, this.deps.sidebar.accountListings()));
    if (candidates.length < 2) {
      this.inform(ControllerTexts.oneAccountOnly(repository));
      return;
    }
    const dockerHost = await this.currentDockerHost();
    const entries = await this.deps.registry.list();
    // The devspace of the row is the one of its owner, also after a rename or a transfer on GitHub (the registry keeps
    // the old name); another account has the devspace of the source under the name on GitHub.
    const own = (account: GitHubAccount) => named !== undefined && isAvailableTo(named, account);
    const items = candidates.map((candidate) => {
      const existing = own(candidate.account) || lastUsedDevspaceOf(entries, repository, (accountId) => accountId === candidate.account.id, dockerHost, source) !== undefined;
      return { label: candidate.account.login, description: ControllerTexts.accountChoiceDescription(permissionText(candidate.permission), existing), candidate };
    });
    const picked = await vscode.window.showQuickPick(items, { title: ControllerTexts.startWithAccountTitle(repository), placeHolder: ControllerTexts.startWithAccountPlaceholder });
    if (!picked) return;
    const account = picked.candidate.account;
    const target =
      named !== undefined && own(account)
        ? { repository: argument.repository, info, devspace: named, named: true, source: sourceOf(named), account }
        : await this.repositoryTargetFor(repository, 'start', source, { account });
    if (!target) return;
    this.logger.info(`Start with Account: ${repository} with the GitHub account ${account.login}.`);
    await this.startTarget({ ...target, info: target.info ?? info, chosenAccount: true });
  }

  /**
   * The command of a repository row: VS Code runs it on a click, Enter, or Space in the row. A double-click or Enter
   * (rowEnter) runs Start with the row, the same as its Start button (rowActivation.ts); a single click only selects the
   * row. A repository with several sources starts its first child row: the row of the default image while the setting
   * startWithDefaultImage is on, else the row of its first configuration; the view shows that row (revealRow). Nothing
   * happens where that row shows no Start: this window is connected to the devspace, or it is updating.
   */
  async rowActivated(argument: unknown): Promise<void> {
    const row = activatedRow(argument);
    if (!row) return;
    const parsed = parseCommandArgument(row.start);
    if (parsed.kind !== 'row') return;
    const openMode = (this.deps.listOpenMode ?? readListOpenMode)();
    if (!this.rowActivations.activate(row.id, openMode) || !row.canStart) return;
    // The row may be older than the connection of this window; a lost connection shows Start (Reconnect).
    if (parsed.devspaceId !== undefined && this.current?.devspace.id === parsed.devspaceId && !this.current.lost) return;
    // A row that the view no longer has is not shown; the start does not wait for the view.
    if (row.childId !== undefined) void this.deps.revealRow?.(row.childId).catch(() => undefined);
    await this.withCommandTarget(parsed, () => this.start(parsed));
  }

  /**
   * Show Log. From the link Show details of a progress notification (progress.ts), it also hides the notification, as
   * the key Escape does: the operation goes on, and the notification stays in the notification center with its Cancel
   * button. When VS Code cannot hide it (a later VS Code may remove or rename the command), the notification stays on
   * the screen: no message, and one line in the log per window.
   */
  async showLog(argument: unknown): Promise<void> {
    this.logger.show();
    if (argument !== FROM_PROGRESS_NOTIFICATION) return;
    try {
      await vscode.commands.executeCommand(HIDE_NOTIFICATIONS_COMMAND);
    } catch (error) {
      if (this.hideNotificationsFailed) return;
      this.hideNotificationsFailed = true;
      this.logger.warn(`Show details did not hide the notification, because the VS Code command ${HIDE_NOTIFICATIONS_COMMAND} failed: ${errorMessage(error)}`);
    }
  }

  /**
   * Enter in the view (the keybinding of package.json). `list.select` of VS Code selects the focused row and runs its
   * command, as Enter does without this keybinding; marked as Enter, the command of a repository row runs Start at once
   * (rowActivated). On an owner or a group, which have no command, list.select opens or closes it (nodeToggled). When
   * list.select fails (a later VS Code may remove or rename it), Enter does nothing: no message, and one line in the log
   * per window.
   */
  async rowEnter(): Promise<void> {
    this.rowActivations.enter();
    try {
      await vscode.commands.executeCommand('list.select');
    } catch (error) {
      this.rowActivations.forgetEnter();
      if (this.listSelectFailed) return;
      this.listSelectFailed = true;
      this.logger.warn(`Enter on a row of the view did nothing, because the VS Code command list.select failed: ${errorMessage(error)}`);
    }
  }

  /**
   * A node of the view opened or closed (TreeView.onDidExpandElement and onDidCollapseElement). Enter on an owner or a
   * group does this and runs no command, so a click on a repository row right after it only selects that row.
   */
  nodeToggled(): void {
    this.rowActivations.forgetEnter();
  }

  /** Stop: the container stops at once; a connected window closes its connection first. */
  async stop(argument: CommandArgument): Promise<void> {
    const target = await this.resolveTarget(argument, 'devspace', ControllerTexts.selectDevspaceToStop);
    const devspace = this.requireDevspace(target);
    if (!target || !devspace) return;
    if (this.isAttachedHere(devspace)) {
      await this.handOff(target, devspace, { operation: 'stop', reason: 'manual' });
      return;
    }
    const shown = this.shownName(target);
    if (await this.connectedInOtherWindow(devspace.id)) {
      // The other window closes its connection first, and its reloaded window stops the container.
      if (!(await this.confirmOtherWindow(shown, ControllerTexts.stop))) return;
      await this.operation(this.operationKey(target), 'Stop', () =>
        this.requestOtherWindowHandOff(shown, devspace, { operation: 'stop', reason: 'manual' }),
      );
      return;
    }
    await this.stopNow(target, devspace);
  }

  /**
   * Keep Running When Closed (`keep`) and Stop When Closed: writes the switch `keepRunning` of the devspace into the
   * registry (under its lock) and renders the sidebar. The Monitor never stops a kept devspace; Stop and
   * Delete still do, and Stop keeps the switch. Nothing is started or stopped here: a kept devspace whose container
   * is stopped stays stopped, and one that is not kept any more stops after the waiting time once no window uses it.
   */
  async setKeepRunning(argument: CommandArgument, keep: boolean): Promise<void> {
    const placeholder = keep ? ControllerTexts.selectDevspaceToKeepRunning : ControllerTexts.selectDevspaceToStopWhenClosed;
    const target = await this.resolveTarget(argument, 'devspace', placeholder);
    const devspace = this.requireDevspace(target);
    if (!target || !devspace) return;
    const repository = this.shownName(target);
    const updated = await this.deps.registry.updateDevspace(devspace.id, (current) => {
      if (keep) current.keepRunning = true;
      else delete current.keepRunning;
    });
    if (!updated) {
      this.inform(PipelineTexts.devspaceMissing);
      return;
    }
    this.logger.info(keep ? `${repository} keeps running when no window uses it.` : `${repository} stops when no window uses it.`);
    await this.renderQuietly();
    // The Monitor of the engine learns the choice at once, on every engine (it keeps or stops the container
    // when no window sends heartbeats). The choice stays stored when it fails; a window that uses the devspace tells
    // it at its next heartbeat.
    const sent = (await this.deps.sessionMonitor?.sendHeartbeat(devspace.id)) ?? { ok: true as const };
    if (!sent.ok) {
      this.logger.warn(`The Monitor could not be told that ${repository} ${keep ? 'keeps running' : 'stops'} when closed: ${sent.detail}`);
      this.warn(ControllerTexts.keepRunningNotSent(repository));
      return;
    }
    // With the setting stopOnClose off, every devspace keeps running already; say so instead of a promise that the
    // devspace stops.
    if (!keep && this.deps.settings().stopOnClose === false) this.inform(ControllerTexts.keepAllRunning);
    else this.inform(keep ? ControllerTexts.keptRunning(repository) : ControllerTexts.stopsWhenClosed(repository));
  }

  /**
   * Close and Keep Running: closes this window, and the container of its devspace keeps running this time. It sets
   * `keepRunningOnce` in the registry (under its lock), which the Monitor treats like Keep Running When Closed
   * until a window connects again, or Stop or Delete. One heartbeat with the keep-running flag goes to the Session
   * Monitor container of its engine first (on every engine), so that it keeps the container also when this computer
   * goes offline; when it fails, the flag is cleared again, an error says so, and the window stays open. The flag stays
   * until the next open or attach of the devspace, or Stop or Delete, also when the user cancels the close (the
   * dialog about unsaved files): `workbench.action.closeWindow` resolves when the close starts, not after that dialog,
   * so the window cannot tell. A cancelled close leaves the devspace kept until then: the safe side.
   */
  async closeAndKeepRunning(): Promise<void> {
    const current = this.current;
    if (!current) {
      this.inform(ControllerTexts.closeAndKeepRunningNotConnected);
      return;
    }
    const devspace = current.devspace;
    // On the engine of the devspace, whatever host Devspaces uses now: a window knows its host from its devspace.
    await this.withHostOf(devspace, () => this.closeAndKeepRunningOn(devspace));
  }

  private async closeAndKeepRunningOn(devspace: Devspace): Promise<void> {
    const repository = this.shownName(this.devspaceTarget(devspace));
    // On every engine; the heartbeat goes to the engine of the devspace, which must be the one of this operation.
    const host = dockerHostOf(devspace);
    const currentHost = await this.currentDockerHost();
    if (currentHost !== host) {
      this.warn(Messages.otherDockerHost(repository, host, currentHost));
      return;
    }
    const updated = await this.deps.registry.updateDevspace(devspace.id, (entry) => {
      entry.keepRunningOnce = true;
    });
    if (!updated) {
      this.inform(PipelineTexts.devspaceMissing);
      return;
    }
    const sent = (await this.deps.sessionMonitor?.sendHeartbeat(devspace.id)) ?? {
      ok: false as const,
      detail: 'The Monitor is not available in this window.',
    };
    if (!sent.ok) {
      this.logger.warn(`Close and Keep Running: the heartbeat to the Monitor on ${host === '' ? 'the local Docker' : host} failed: ${sent.detail}`);
      await this.clearKeepRunningOnce(devspace.id);
      const minutes = Math.round(stopAfterSeconds(this.deps.settings().stopAfterMinutes) / 60);
      showErrorMessage(ControllerTexts.closeAndKeepRunningUnreachable(host, minutes))
        .then(undefined, (error: unknown) => this.logger.error('Could not show the message.', error));
      return;
    }
    this.logger.info(`${repository} keeps running this time. The window closes.`);
    await this.deps.connection.closeWindow();
  }

  /** Removes `keepRunningOnce` (a window connected again, or the heartbeat failed). Never throws. */
  private async clearKeepRunningOnce(devspaceId: string): Promise<void> {
    try {
      if ((await this.deps.registry.get(devspaceId))?.keepRunningOnce === undefined) return;
      await this.deps.registry.updateDevspace(devspaceId, (entry) => {
        delete entry.keepRunningOnce;
      });
    } catch (error) {
      this.logger.warn(`Close and Keep Running could not be cleared: ${errorMessage(error)}`);
    }
  }

  /** Delete: safety check, confirmation, then the removal. */
  async delete(argument: CommandArgument): Promise<void> {
    const target = await this.resolveTarget(argument, 'devspace', ControllerTexts.selectDevspaceToDelete);
    const devspace = this.requireDevspace(target);
    if (!target || !devspace) return;
    const repository = this.shownName(target);
    if ((await this.otherWindowMark(devspace.id))?.operation === 'delete') {
      this.inform(ControllerTexts.alreadyDeleting(repository));
      return;
    }
    let openInstead = false;
    await this.operation(
      this.operationKey(target),
      'Delete',
      async () => {
        // The check of Delete and its questions run in the worker of the Docker host (deleteCheck.ts: the Git state,
        // the data of services, the volumes that Delete may remove); the coordination of the windows below stays here.
        const otherWindow = await this.connectedInOtherWindow(devspace.id);
        const decision = await runWithProgress({
          title: ControllerTexts.checkingChanges(repository),
          cancellable: true,
          task: (progress, signal) => this.deps.service.deleteCheckInWorker(devspace.id, { progress, signal, repository, otherWindow }),
        });
        if (decision.decision === 'open') openInstead = true;
        if (decision.decision !== 'delete') return;
        const additionalVolumesToRemove = decision.additionalVolumesToRemove;
        // Delete is possible in every state; during an operation of another window it runs afterwards.
        if (!(await this.waitForOtherWindowOperation(repository, devspace.id))) return;
        const current = await this.deps.registry.get(devspace.id);
        if (!current) {
          this.logger.info(`The devspace of ${repository} does not exist anymore. Nothing is deleted.`);
          return;
        }
        const request: HandOffRequest = { operation: 'delete', reason: 'manual', additionalVolumesToRemove };
        if (this.isAttachedHere(current)) {
          await this.handOffNow(repository, current, request, 'delete');
          return;
        }
        // A window that is connected closes its connection first.
        if (await this.connectedInOtherWindow(current.id)) {
          await this.requestOtherWindowHandOff(repository, current, request);
          return;
        }
        await this.deleteWithProgress(repository, current, additionalVolumesToRemove);
      },
      { retry: this.retryOn(devspace, () => this.delete({ kind: 'devspace', devspaceId: devspace.id })) },
    );
    if (openInstead) {
      const fresh = await this.deps.registry.get(devspace.id);
      if (fresh) {
        await this.startTarget(this.devspaceTarget(fresh));
      }
    }
  }

  /** Rebuild. */
  async rebuild(argument: CommandArgument): Promise<void> {
    const target = await this.resolveTarget(argument, 'devspace', ControllerTexts.selectDevspaceToRebuild);
    const devspace = this.requireDevspace(target);
    if (!target || !devspace) return;
    await this.rebuildDevspace(target, devspace, { reason: 'manual' });
  }

  /** Show on GitHub. */
  async showOnGitHub(argument: CommandArgument): Promise<void> {
    const target = await this.resolveTarget(argument, 'gitHub', ControllerTexts.selectRepositoryForGitHub);
    if (!target) return;
    const info = target.info ?? this.deps.sidebar.repositoryInfo(target.repository);
    if (!info) {
      this.inform(TreeTexts.notListedOnGitHub);
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(info.url));
  }

  /**
   * Switch Devspace…: the selected devspace or repository opens in this window, or in a new window (Switch Devspace
   * in New Window…, or the setting openInNewWindow).
   */
  async switchDevspace(window: WindowRequest = 'default'): Promise<void> {
    const { registry, sidebar } = this.deps;
    // Only the devspaces and the repositories of the accounts of Devspaces.
    const [devspaces, repositories] = await Promise.all([sidebar.availableDevspaces(), sidebar.repositoriesForPicker()]);
    if (devspaces.length === 0 && repositories.length === 0) {
      this.inform(ControllerTexts.noRepositories);
      return;
    }
    await this.renderQuietly();
    const newWindow = this.opensNewWindow(window);
    const choice = await showSwitcher({ groups: sidebar.model(), devspaces, repositories, newWindow });
    if (!choice) return;
    if (choice.kind === 'devspace') {
      const devspace = await registry.get(choice.devspaceId);
      if (!devspace) {
        this.inform(PipelineTexts.devspaceMissing);
        return;
      }
      const target = await this.ownTarget(this.devspaceTarget(devspace));
      if (target) await this.startTarget(target, { window });
      return;
    }
    const target = await this.pickedRepositoryTarget(choice.repository.nameWithOwner, 'start');
    if (target) await this.startTarget(target, { window });
  }

  /** Refresh: the repository list (sign-in first when needed), a lost registry, and the states. */
  async refresh(): Promise<void> {
    if (await this.deps.auth.isSignedIn()) await this.deps.sidebar.refreshDiscovery({ again: true, byUser: true });
    else await this.signIn();
    // The user asked for it, so the worker is made ready in full (as for an operation of the user). Not while Devspaces
    // is being removed from the engine (told); the rest of Refresh runs.
    await this.reconcileIfRegistryLost({ passive: false, user: true }).catch((error: unknown) =>
      this.logger.warn(`The devspaces could not be restored from the volumes: ${errorMessage(error)}`),
    );
    await this.deps.sidebar.refreshStates();
  }

  /**
   * "Update All Images Now": the Monitor of the Docker engine of this operation (the sidebar's) is made sure
   * and asked for its background run at once (the images in use, the VS Code server and the extensions), with a
   * progress until it took the request; then a message. The run itself is not waited for (it can take long); the
   * monitor never runs two at once. The command shows a failure (updateImagesNowCommand). A target that is not
   * supported (an endpoint that is neither local nor SSH, a context that cannot be read, or Podman) is refused with its
   * message, before the question about the Monitor (beforeUserFlow) and before any progress. Before all of this, the
   * flow is refused while this window removes Devspaces from an engine (refusedWhileRemoving), as Start is.
   * In the progress, the step "Docker start" of Start runs first (startDocker): a local Docker that does not run is
   * started, a Podman engine behind the Docker CLI is refused, and an SSH host is checked. After a Docker start, the
   * progress names the next step (sendingRequest), so that it does not say "Starting Docker" until the Monitor took the
   * request. The progress can be cancelled, as the one of Start: a cancel during the Docker start sends the Monitor no
   * request and shows nothing. The progress runs in the gate of this window, with the key of the engine
   * (monitorRequestKey): a second request for the engine is not started while it runs (logged), and the removal of
   * Devspaces from an engine in this window is refused (runningOperation). After the Docker start, which can take long,
   * the request is not sent when a removal of Devspaces began since the question (requestRefusedByRemoval): the request
   * would set up the Monitor, the worker and the volumes again on the engine.
   */
  async updateImagesNow(): Promise<void> {
    const update = this.deps.updateImagesNow;
    if (!update) return;
    await this.ready;
    // Not while this window removes Devspaces from an engine (told), as for Start.
    if (this.refusedWhileRemoving('Update All Images Now')) return;
    const target = await this.operationTarget();
    if (target.kind === 'unsupported') throw dockerEndpointUnsupported(target);
    // The question about the Monitor of the engine, which the request makes sure of; it reads only local records.
    if (!(await this.beforeUserFlow('Update All Images Now'))) return;
    const engine = describeDockerHost(target.host);
    const startDocker = this.deps.startDocker;
    let sent = false;
    const outcome = await this.gate.run(monitorRequestKey(target.host), 'Update All Images Now', async () => {
      // A removal mark that is there now is one that beforeUserFlow could not clear (logged): it does not stop the
      // request, only a newer one does.
      const markBefore = await this.removalMarkOf(target.host);
      await runWithProgress({
        title: ControllerTexts.requestingImageUpdate(engine),
        cancellable: true,
        task: async (progress, signal) => {
          let started = false;
          const onStarting = (): void => {
            started = true;
            progress.step('startingDocker');
          };
          await startDocker?.({ onStarting, signal });
          if (signal.aborted) throw new UserFacingError('cancelled', PipelineTexts.cancelled);
          if (await this.requestRefusedByRemoval(target.host, markBefore)) return;
          // A Docker that runs already showed no step, and shows none now.
          if (started) progress.step('sendingRequest');
          await update(target, signal);
          sent = true;
        },
      });
    });
    if (!outcome.started) {
      this.logger.info(`Update All Images Now on ${engine} was not started: an earlier request there is still running.`);
      return;
    }
    if (!sent) return;
    this.logger.info(`The Monitor on ${engine} took the request of "Update All Images Now".`);
    this.inform(ControllerTexts.imagesUpdatingNow(engine));
  }

  /**
   * After the Docker start of "Update All Images Now" on the engine `host`, right before its request: true, after a
   * message, when a removal of Devspaces began since the question about the Monitor (beforeUserFlow). That is a removal
   * that runs in this window (refusedWhileRemoving; it began before the request took its key in the gate), one that
   * another window runs on the engine (refusedWhileOtherWindowRemoves), or one that ended and left its removal mark
   * there: a mark other than `markBefore`, the mark that beforeUserFlow could not clear (none when it cleared it).
   */
  private async requestRefusedByRemoval(host: string, markBefore: number | undefined): Promise<boolean> {
    const operation = 'Update All Images Now';
    if (this.refusedWhileRemoving(operation) || (await this.refusedWhileOtherWindowRemoves(operation, host))) return true;
    const mark = await this.removalMarkOf(host);
    if (mark === undefined || mark === markBefore) return false;
    const engine = describeDockerHost(host);
    this.logger.info(`${operation} did not run: Devspaces was removed from ${engine} in the meantime.`);
    this.inform(ControllerTexts.removedInTheMeantime(engine));
    return true;
  }

  /**
   * The command "Update All Images Now": a failure is shown with Try again where the error offers it (errors.ts), as for
   * Start. Try again runs the command again, as one operation on the Docker host that is current then. A cancellation
   * shows nothing.
   */
  private async updateImagesNowCommand(): Promise<void> {
    try {
      await this.updateImagesNow();
    } catch (error) {
      this.showError(error, () => this.withDockerTarget(() => this.updateImagesNowCommand()));
    }
  }

  /**
   * "Remove Devspaces from This Docker Engine…" (the Command Palette and the "…" menu of the view), on the engine of the
   * Docker host of Devspaces: after a confirmation, the Monitor, the helper containers and images, and the shared volumes
   * of Devspaces (engineRemoval.ts, with the Docker CLI of the extension once the worker of this window ended); and,
   * after a second confirmation, first the devspaces of the signed-in account there (each as Delete does, in the
   * worker, with all its volumes). Devspaces of other accounts and of other computers stay. Refused while a window of
   * this computer is connected to a devspace there, or an operation runs, also when one of them began while it asked,
   * and while another window removes Devspaces from the engine; Docker is never started for it. The engine gets the
   * removal mark before anything is removed (docker-engines.json), with the entry of this removal, which keeps the flows
   * of the user in other windows from clearing the mark while it runs: until a Start, a Rebuild or "Update All Images
   * Now" of the user there (beforeUserFlow), this computer does no Docker work there by itself.
   */
  async removeFromDockerEngine(): Promise<void> {
    const removal = this.deps.engineRemoval;
    if (!removal) return;
    await this.ready;
    if (this.refusedWhileRemoving('Remove Devspaces')) return;
    await this.withDockerTarget(() => this.removeFromDockerEngineNow(removal));
  }

  private async removeFromDockerEngineNow(removal: EngineRemovalDeps): Promise<void> {
    const target = await this.operationTarget();
    // Never a target that is not supported, such as an endpoint that is neither local nor SSH (every operation
    // refuses it).
    if (target.kind === 'unsupported') throw dockerEndpointUnsupported(target);
    const engine = describeDockerHost(target.host);
    if (await this.refusedWhileOtherWindowRemoves('Remove Devspaces', target.host)) return;
    const known = await this.deps.registry.list();
    const here = known.filter((devspace) => isOnDockerHost(devspace, target.host));
    if (await this.removalRefusedByUse(engine, here)) return;
    // From here on, also while it looks for what Devspaces has there and asks, a second run and the operations of the
    // window are refused (refusedWhileRemoving).
    this.removingFrom = { host: target.host, engine };
    try {
      await this.removeFromCheckedEngine(removal, target, known, here);
    } finally {
      this.removingFrom = undefined;
      this.deps.engineRemovalEnded?.(target.host);
    }
  }

  /** removeFromDockerEngineNow after its refusal checks, while `removingFrom` names the engine of `target`. */
  private async removeFromCheckedEngine(removal: EngineRemovalDeps, target: DockerTarget, known: readonly Devspace[], here: readonly Devspace[]): Promise<void> {
    const engine = describeDockerHost(target.host);
    let inventory: EngineInventory | undefined;
    try {
      inventory = await runWithProgress({
        title: ControllerTexts.removeLooking(engine),
        cancellable: true,
        task: async (_progress, signal) => {
          if (!(await removal.engineAnswers(target, signal))) return undefined;
          return engineInventory(removal.docker, { computerId: removal.computerId(), knownDevspaces: new Set(known.map((devspace) => devspace.id)), signal });
        },
      });
    } catch (error) {
      if (isCancellation(error)) throw error;
      this.logger.warn(`What Devspaces has on ${engine} could not be listed: ${errorMessage(error)}`);
      this.warnWithLog(ControllerTexts.removeListFailed(engine));
      return;
    }
    if (inventory === undefined) {
      this.warn(ControllerTexts.removeEngineNotAnswering(engine));
      return;
    }
    // The devspaces of all accounts of Devspaces (named in the question); without a sign-in, none.
    const accounts = here.length > 0 ? await this.readAccounts() : [];
    const own = availableDevspaces(here, accounts);
    const others = here.filter((devspace) => !own.includes(devspace));
    const ownLogins = accounts.filter((account) => own.some((devspace) => devspace.owner.id === account.id)).map((account) => account.login);
    if (inventoryIsEmpty(inventory) && own.length === 0) {
      // Nothing to remove; the mark still keeps the background work of this computer away from the engine.
      const marked = await this.markRemoved(target.host);
      const message = ControllerTexts.removeNothingFound(engine);
      if (marked) this.inform(message);
      else this.warnWithLog(`${message} ${ControllerTexts.removalNotRecorded(engine)}`);
      return;
    }
    const detail = [ControllerTexts.removeDetail];
    if (inventory.unknownDevspaces.length > 0) detail.push(ControllerTexts.removeUnknownDevspaces);
    else if (inventory.otherComputerMonitor) detail.push(ControllerTexts.removeOtherComputer);
    if (accounts.length === 0 && here.length > 0) detail.push(ControllerTexts.removeSignedOut);
    else if (others.length > 0) detail.push(ControllerTexts.removeOtherAccounts(listSome(others.map((devspace) => this.shownName(this.devspaceTarget(devspace))))));
    const confirmed = await showWarningMessage(ControllerTexts.removeQuestion(engine), { modal: true, detail: detail.join(' ') }, ControllerTexts.remove);
    if (confirmed !== ControllerTexts.remove) return;
    let deleteOwn = false;
    if (own.length > 0) {
      const choice = await showWarningMessage(
        ControllerTexts.removeDevspacesQuestion(own.length, engine, ownLogins),
        { modal: true, detail: ControllerTexts.removeDevspacesDetail(this.recordedChanges(own)) },
        ControllerTexts.deleteDevspacesToo,
        ControllerTexts.keepDevspaces,
      );
      // Cancel removes nothing.
      if (choice === undefined) return;
      deleteOwn = choice === ControllerTexts.deleteDevspacesToo;
    }
    const start = await this.startRemoval(target.host);
    if (start.kind === 'other') {
      this.refuseForOtherRemoval('Remove Devspaces', target.host, start.other);
      return;
    }
    // Until the checks below passed, nothing was removed: a stop brings back the mark from before.
    let stopped = true;
    try {
      // A window that connected to a devspace there, or an operation that began, while the questions were open (also on
      // a devspace that was created meanwhile): the removal stops before it removes anything, as at its start.
      const hereNow = (await this.deps.registry.list()).filter((devspace) => isOnDockerHost(devspace, target.host));
      if (await this.removalRefusedByUse(engine, hereNow)) return;
      stopped = false;
      if (start.kind === 'started') this.logger.info(`This computer does no Docker work on ${engine} by itself until a Start, a Rebuild or "Update All Images Now" there.`);
      this.logger.info(`Removing Devspaces from ${engine}${own.length > 0 ? (deleteOwn ? `, with the devspaces of ${ownLogins.join(', ')} there` : '; the devspaces stay') : ''}.`);
      await this.removeConfirmed(removal, target, {
        own: deleteOwn ? own : [],
        devspacesStay: (!deleteOwn && own.length > 0) || others.length > 0 || inventory.unknownDevspaces.length > 0,
        // Without the mark, the background work of this computer can set Devspaces up there again: the message says so.
        marked: start.kind !== 'notRecorded',
      });
    } finally {
      if (start.kind === 'started') await this.endRemoval(target.host, start.removal, stopped ? start.before : undefined);
    }
  }

  /**
   * The removal after the confirmations and the checks: the devspaces `own`, then what Devspaces keeps on the engine
   * (removeFromEngine), then the last message. `devspacesStay`: devspaces stay on the engine besides those that could
   * not be deleted, so the store of the VS Code Server stays while they use it. `marked`: the removal mark was written;
   * when it was not, the last message says so, and so it does when the removal did not wait for the end of a background
   * build of the helper image (a warning then, also after a removal that removed everything).
   */
  private async removeConfirmed(removal: EngineRemovalDeps, target: DockerTarget, options: { own: readonly Devspace[]; devspacesStay: boolean; marked: boolean }): Promise<void> {
    const engine = describeDockerHost(target.host);
    const { marked } = options;
    const unmarked = (message: string): string => (marked ? message : `${message} ${ControllerTexts.removalNotRecorded(engine)}`);
    let removed: { result: RemovalResult; failedDevspaces: number; buildNotWaitedFor?: true };
    try {
      removed = await runWithProgress({
        title: ControllerTexts.removing(engine),
        cancellable: true,
        task: (progress, signal) => this.removeFromEngine(removal, target, options.own, progress, signal),
      });
    } finally {
      if (!this.disposed) this.background(this.deps.sidebar.refreshStates(), 'update the sidebar');
    }
    const { result, failedDevspaces } = removed;
    const finish = (message: string): string => unmarked(removed.buildNotWaitedFor === true ? `${message} ${ControllerTexts.helperBuildNotWaitedFor}` : message);
    // The store of the VS Code Server stays while devspaces that stay on the engine use it.
    const devspacesStay = options.devspacesStay || failedDevspaces > 0;
    const keptStore = (item: RemovalResult['items'][number]): boolean => devspacesStay && item.kind === 'volume' && item.name === VSCODE_STORE_VOLUME && item.outcome === 'inUse';
    const left = result.items.filter((item) => (item.outcome === 'inUse' || item.outcome === 'failed') && !keptStore(item)).length + failedDevspaces;
    if (result.ended !== undefined) {
      this.warnWithLog(finish(ControllerTexts.removalEnded(engine)));
      return;
    }
    if (left > 0) {
      this.warnWithLog(finish(ControllerTexts.removalLeftItems(left, engine)));
      return;
    }
    this.logger.info(`Devspaces was removed from ${engine}.`);
    const message = ControllerTexts.removedFromEngine(engine);
    const done = result.items.some(keptStore) ? `${message} ${ControllerTexts.vscodeVolumeKept}` : message;
    if (marked && removed.buildNotWaitedFor !== true) this.inform(done);
    else this.warnWithLog(finish(done));
  }

  /**
   * The removal itself, in the progress of the command: the devspaces `devspaces` one after the other in the worker
   * (each with all its volumes; a delete is never stopped half-way, Cancel ends the removal before the next one), then
   * the end of the background builds of the helper image and of this window's worker on the engine, then what Devspaces
   * keeps there (removeEngineInfrastructure). A failure of a devspace is logged, and the removal goes on.
   */
  private async removeFromEngine(
    removal: EngineRemovalDeps,
    target: DockerTarget,
    devspaces: readonly Devspace[],
    progress: ProgressReporter,
    signal: AbortSignal,
  ): Promise<{ result: RemovalResult; failedDevspaces: number; buildNotWaitedFor?: true }> {
    let failedDevspaces = 0;
    // Cancel while the devspaces are deleted: nothing else was removed yet, so the log names the commands that remove
    // the rest (removalEndedNote, as for a removal that ended later), as the message says (removalEnded).
    const remoteHost = target.kind === 'remote' ? target.host : undefined;
    const cancelled = (): { result: RemovalResult; failedDevspaces: number } => {
      this.logger.warn(removalEndedNote('cancelled', remoteHost));
      return { result: { items: [], ended: 'cancelled' }, failedDevspaces };
    };
    for (const devspace of devspaces) {
      if (signal.aborted) {
        this.logger.info('The removal was cancelled before all devspaces were deleted.');
        return cancelled();
      }
      const devspaceTarget = this.devspaceTarget(devspace);
      const name = this.shownName(devspaceTarget);
      try {
        // A window that connected to it after the checks keeps it, and so does a window that is opening it (its fresh
        // pending connection file): its container would be deleted under that window. When the files of the windows
        // cannot be read, it is not deleted either.
        let use: string | undefined;
        if (this.isAttachedHere(devspace) || (await this.connectedInOtherWindow(devspace.id))) use = 'connected to';
        else if ((await this.connectingDevspaces()).has(devspace.id)) use = 'opening';
        if (use !== undefined) {
          failedDevspaces++;
          this.logger.warn(`The devspace of ${name} was not deleted: a window is ${use} it. Delete it later with "Devspaces: Delete Devspace".`);
          continue;
        }
        progress.detail(ControllerTexts.deleting(name));
        // The gate of the devspace, as the Delete command; not cancellable (deleteWithProgress).
        const outcome = await this.gate.run(this.operationKey(devspaceTarget), 'Delete', () =>
          this.deps.service.deleteInWorker(devspace.id, { progress, additionalVolumesToRemove: devspace.additionalVolumes ?? [] }),
        );
        if (!outcome.started) {
          failedDevspaces++;
          this.logger.warn(`The devspace of ${name} was not deleted: ${outcome.running} of it is still running. Delete it later with "Devspaces: Delete Devspace".`);
        }
      } catch (error) {
        failedDevspaces++;
        this.logger.warn(`The devspace of ${name} could not be deleted: ${errorMessage(error)} Delete it later with "Devspaces: Delete Devspace".`);
      }
    }
    if (signal.aborted) return cancelled();
    // A background build of the helper image in this window would make the image again after its removal.
    const builds = await this.helperBuildsStopped(removal, target, signal);
    if (builds === 'cancelled') return cancelled();
    // The worker of this window holds the volumes of the engine; it ends before its container is removed.
    removal.closeWorker(target);
    const result = await removeEngineInfrastructure(removal.docker, {
      answers: (answerSignal) => removal.engineAnswers(target, answerSignal ?? signal),
      logger: this.logger,
      ...(remoteHost !== undefined ? { remoteHost } : {}),
      onItem: (item) => progress.detail(ControllerTexts.removingItem(item)),
      signal,
    });
    return { result, failedDevspaces, ...(builds === 'notWaitedFor' ? { buildNotWaitedFor: true as const } : {}) };
  }

  /**
   * Stops the background builds of the helper image of this window on the engine of `target`, and waits for their end
   * (EngineRemovalDeps.stopHelperBuilds) at most HELPER_BUILDS_STOP_WAIT_MS: after that (`notWaitedFor`), the log says
   * that such a build may make the image again, and the removal goes on. `cancelled`: Cancel (`signal`) ended the wait.
   */
  private async helperBuildsStopped(removal: EngineRemovalDeps, target: DockerTarget, signal: AbortSignal): Promise<'ended' | 'notWaitedFor' | 'cancelled'> {
    const stopping = removal.stopHelperBuilds?.(target);
    if (stopping === undefined) return 'ended';
    const waited = new AbortController();
    const limit = this.delay(this.deps.timing?.helperBuildsStopWaitMs ?? HELPER_BUILDS_STOP_WAIT_MS, AbortSignal.any([waited.signal, signal])).then(() => false);
    const ended = await Promise.race([stopping.then(() => true, () => true), limit]);
    waited.abort();
    if (signal.aborted) return 'cancelled';
    if (ended) return 'ended';
    this.logger.warn(
      `A background build of the helper image on ${describeDockerHost(target.host)} did not end after it was stopped. The removal goes on; that build may make the image again, and a new run of the command removes it.`,
    );
    return 'notWaitedFor';
  }

  /**
   * The recorded changes of `devspaces` for the confirmation of their delete: each one with changes (formatChanges),
   * and each one without a recorded Git state; "none" when no devspace has either.
   */
  private recordedChanges(devspaces: readonly Devspace[]): string {
    const named = devspaces.flatMap((devspace) => {
      const name = this.shownName(this.devspaceTarget(devspace));
      if (devspace.gitSummary === undefined) return [`${name} (${ControllerTexts.changesNotRecorded})`];
      const changes = formatChanges(devspace.gitSummary);
      return changes === '' ? [] : [`${name} (${changes})`];
    });
    return named.length > 0 ? listSome(named) : ControllerTexts.noChanges;
  }

  /**
   * The names of the devspaces of `devspaces` that a window of this computer uses: `connected`, those that a window is
   * connected to (this one or another), also one that works without Devspaces (isAttachedHere,
   * WindowStatus.plainDevspaceId); `opening`, the others that a window is opening (connectingDevspaces).
   */
  private async devspacesInUse(devspaces: readonly Devspace[]): Promise<{ connected: string[]; opening: string[] }> {
    const others = await this.otherActiveWindowsKnown();
    const connecting = await this.connectingDevspaces();
    const name = (devspace: Devspace): string => this.shownName(this.devspaceTarget(devspace));
    const connected = devspaces.filter((devspace) => this.isAttachedHere(devspace) || others.some((window) => usesDevspace(window, devspace.id)));
    const opening = devspaces.filter((devspace) => !connected.includes(devspace) && connecting.has(devspace.id));
    return { connected: connected.map(name), opening: opening.map(name) };
  }

  /**
   * The IDs of the devspaces that a window of this computer is opening now: their fresh pending connection files
   * (isFreshPending), which the window that ran the open writes before the window connects, and which that window
   * removes when it writes its status file. Also those of this window: one that it opened in a new window. Between
   * the end of the open (its busy mark) and the status file of the window, only this file shows the use. When the files
   * cannot be read, it is not known, so nothing is changed (UserFacingError, connectingWindowsUnknown); never "none".
   */
  private async connectingDevspaces(): Promise<Set<string>> {
    let pendings: PendingConnection[];
    try {
      pendings = await this.deps.sessionFiles.readPendings();
    } catch (error) {
      this.logger.warn(`The pending connection files could not be read, so nothing is changed: ${errorMessage(error)}`);
      throw new UserFacingError('startFailed', ControllerTexts.connectingWindowsUnknown, errorMessage(error));
    }
    const now = this.clock.now();
    return new Set(pendings.filter((pending) => isFreshPending(pending, now)).map((pending) => pending.devspaceId));
  }

  /**
   * An operation that runs: any operation of this window (its gate), or one of another live window on a devspace of
   * `devspaces` (its busy mark). The name of the operation and of its repository; undefined when none runs. A request
   * of "Update All Images Now" (monitorRequestKey) has no repository.
   */
  private async runningOperation(devspaces: readonly Devspace[]): Promise<{ operation: string; repository?: string } | undefined> {
    for (const key of this.gate.keys()) {
      const label = this.gate.runningFor(key);
      if (label === undefined) continue;
      if (key.startsWith(MONITOR_REQUEST_KEY)) return { operation: label };
      const devspace = devspaces.find((candidate) => this.operationKey(this.devspaceTarget(candidate)).toLowerCase() === key);
      return { operation: label, repository: devspace !== undefined ? this.shownName(this.devspaceTarget(devspace)) : key.split('#')[0] };
    }
    for (const devspace of devspaces) {
      const mark = await this.otherWindowMark(devspace.id);
      if (mark !== undefined) return { operation: BUSY_OPERATION_NAMES[mark.operation], repository: this.shownName(this.devspaceTarget(devspace)) };
    }
    return undefined;
  }

  /**
   * Whether the removal from `engine` must not run now (told, and logged): a window of this computer is connected to a
   * devspace of `here`, or is opening one (devspacesInUse), or an operation runs (runningOperation). Throws
   * UserFacingError when the window status files or the pending connection files cannot be read (otherWindowsUnknown,
   * connectingWindowsUnknown).
   */
  private async removalRefusedByUse(engine: string, here: readonly Devspace[]): Promise<boolean> {
    // A window that uses a devspace there would start the Monitor again with its next heartbeat.
    const { connected, opening } = await this.devspacesInUse(here);
    if (connected.length > 0) {
      this.logger.info(`Devspaces is not removed from ${engine}: windows are connected to ${connected.join(', ')}.`);
      this.warn(ControllerTexts.removeCloseWindowsFirst(engine, listSome(connected)));
      return true;
    }
    // No window to close yet: the open of this window that still runs, or a new window that did not connect (yet).
    if (opening.length > 0) {
      this.logger.info(`Devspaces is not removed from ${engine}: a window is opening ${opening.join(', ')}.`);
      this.warn(ControllerTexts.removeWhileOpening(engine, listSome(opening)));
      return true;
    }
    const running = await this.runningOperation(here);
    if (running !== undefined) {
      const operation = running.repository !== undefined ? `${running.operation} of ${running.repository}` : running.operation;
      this.logger.info(`Devspaces is not removed from ${engine}: ${operation} is still running.`);
      this.warn(ControllerTexts.removeWhileOperation(running.operation, running.repository));
      return true;
    }
    return false;
  }

  /**
   * Sets the removal mark of the engine `host` with the entry of this removal (DockerEngineRecords.startRemoval).
   * `started`: with the entry, and the record from before, which the end of a removal that stopped early brings back;
   * `other`: another window removes Devspaces from the engine, so nothing was written; `notRecorded`: the file could
   * not be written (logged), and the removal goes on, as its last message says; `untracked`: no records here.
   */
  private async startRemoval(
    host: string,
  ): Promise<{ kind: 'started'; removal: EngineRemoval; before: DockerEngineRecord } | { kind: 'other'; other: EngineRemoval } | { kind: 'notRecorded' | 'untracked' }> {
    const records = this.deps.engineRecords;
    if (records === undefined) return { kind: 'untracked' };
    const owner = this.owner();
    const removal: EngineRemoval = { windowId: owner.windowId, pid: owner.pid, since: isoTime(this.clock) };
    try {
      const start = await records.startRemoval(host, removal, this.clock.now(), await this.markBlocker());
      return start.started ? { kind: 'started', removal, before: start.before } : { kind: 'other', other: start.other };
    } catch (error) {
      this.logger.warn(`The removal from ${describeDockerHost(host)} could not be recorded, so this computer may set Devspaces up there again by itself: ${errorMessage(error)}`);
      return { kind: 'notRecorded' };
    }
  }

  /**
   * The end of the removal `removal` on the engine `host`: its entry goes, and the mark stays; with `before`, the
   * record from before comes back (the removal stopped before it removed anything). A failure is logged.
   */
  private async endRemoval(host: string, removal: EngineRemoval, before?: DockerEngineRecord): Promise<void> {
    try {
      await this.deps.engineRecords?.endRemoval(host, removal, before);
    } catch (error) {
      this.logger.warn(`The end of the removal from ${describeDockerHost(host)} could not be recorded: ${errorMessage(error)}`);
    }
  }

  /**
   * The removal that another live window runs on the engine `host` (its entry in docker-engines.json, with the
   * liveness rule of the busy marks: markBlocker); undefined when none runs, also when the file cannot be read (logged).
   */
  private async otherWindowRemoval(host: string): Promise<EngineRemoval | undefined> {
    const records = this.deps.engineRecords;
    if (records === undefined) return undefined;
    let removal: EngineRemoval | undefined;
    try {
      removal = await records.removing(host);
    } catch (error) {
      this.logger.warn(`The records of the Docker engines could not be read: ${errorMessage(error)}`);
      return undefined;
    }
    if (removal === undefined) return undefined;
    return (await this.markBlocker())(removal) ? removal : undefined;
  }

  /** While another window removes Devspaces from the engine `host`, `operation` is not started (logged and told). */
  private async refusedWhileOtherWindowRemoves(operation: string, host: string): Promise<boolean> {
    const removal = await this.otherWindowRemoval(host);
    if (removal === undefined) return false;
    this.refuseForOtherRemoval(operation, host, removal);
    return true;
  }

  /** `operation` did not start: the window of `removal` removes Devspaces from the engine `host` (logged and told). */
  private refuseForOtherRemoval(operation: string, host: string, removal: EngineRemoval): void {
    const engine = describeDockerHost(host);
    this.logger.info(`${operation} did not run: Devspaces is being removed from ${engine} in another window (process ${removal.pid}).`);
    this.inform(ControllerTexts.removalRunningElsewhere(engine));
  }

  /**
   * Sets the removal mark of the engine `host` when there was nothing to remove. A failure is logged; false then, so
   * that the message says so.
   */
  private async markRemoved(host: string): Promise<boolean> {
    const records = this.deps.engineRecords;
    if (records === undefined) return true;
    try {
      await records.setRemoved(host, this.clock.now());
      this.logger.info(`This computer does no Docker work on ${describeDockerHost(host)} by itself until a Start, a Rebuild or "Update All Images Now" there.`);
      return true;
    } catch (error) {
      this.logger.warn(`The removal from ${describeDockerHost(host)} could not be recorded, so this computer may set Devspaces up there again by itself: ${errorMessage(error)}`);
      return false;
    }
  }

  /** Whether the engine `host` has the removal mark (docker-engines.json); false when it cannot be read (logged). */
  private async hasRemovalMark(host: string): Promise<boolean> {
    return (await this.removalMarkOf(host)) !== undefined;
  }

  /**
   * The removal mark of the engine `host` (docker-engines.json): its time (DockerEngineRecord.removedAt); undefined
   * when the engine has none, and when the file cannot be read (logged).
   */
  private async removalMarkOf(host: string): Promise<number | undefined> {
    const records = this.deps.engineRecords;
    if (records === undefined) return undefined;
    try {
      return (await records.record(host))?.removedAt;
    } catch (error) {
      this.logger.warn(`The records of the Docker engines could not be read: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /** While "Remove Devspaces from This Docker Engine…" runs, `operation` is not started (logged and told). */
  private refusedWhileRemoving(operation: string): boolean {
    const engine = this.removingFrom?.engine;
    if (engine === undefined) return false;
    this.logger.info(`${operation} did not run: Devspaces is being removed from ${engine}.`);
    this.inform(ControllerTexts.removalRunning(engine));
    return true;
  }

  /** Search: all repositories with a text search, then Start. */
  async search(): Promise<void> {
    const repositories = await this.deps.sidebar.repositoriesForPicker();
    if (repositories.length === 0) {
      this.inform(ControllerTexts.noRepositories);
      return;
    }
    const info = await pickRepository(repositories, this.repositoryPlaceholder('default'));
    if (!info) return;
    const target = await this.pickedRepositoryTarget(info.nameWithOwner, 'start');
    if (target) await this.startTarget(target);
  }

  /**
   * A link to Devspaces (links.ts), for example on a website: `vscode://nimblescape.nimblescape-devspaces-2/open?repository=owner/name`.
   * VS Code asks first whether Devspaces may open it, unless the user answered "Do not ask me again for this
   * extension", and it installs Devspaces from the Marketplace when it is missing. The link opens the devspace of the
   * repository that an account of Devspaces used last on the current Docker engine. Without one, it creates the devspace
   * as a double-click on the row of the repository does, from its first source (possibleSources), with the account that
   * a Start chooses (accountChoice.ts), after one question before any Docker work: the confirmation of every first open
   * for a repository that belongs neither to an account of Devspaces nor to one of their organizations, else the
   * question of the link (linkStartConfirm), which "Always Open" turns off (setting
   * confirmOpenFromLink). VS Code gives the link to the window
   * that was active last, in which the user did not ask for anything: the devspace opens in that window only when it is
   * empty, else in a new window, and the window keeps what it has. The repository can be one that the list does not show: then GitHub is asked for
   * it. A link that names no repository asks neither GitHub nor Docker. Never rejects: errors are shown.
   *
   * The course link `/course?repository=owner/name-<username>` opens the repository of one account in a course in the
   * same way: after the sign-in, `<username>` becomes the GitHub login of each account of Devspaces (courseRepository),
   * and the account whose repository exists opens it (courseLinkRepository).
   */
  async openLink(uri: { path: string; query: string }): Promise<void> {
    this.rowActivations.forgetEnter();
    const link = parseLink(uri.path, uri.query);
    if (link.kind === 'invalid') {
      this.logger.info(`A link to Devspaces was not opened: ${link.reason}.`);
      this.warn(ControllerTexts.invalidLink);
      return;
    }
    this.logger.info(link.kind === 'course' ? `A course link asks to open ${link.template} with the GitHub login of the account.` : `A link asks to open ${link.repository}.`);
    // Counted at once: the automatic reopen of the last devspace in an empty window does not start while the link waits
    // for the activation or the sign-in dialog is open (reopenLast).
    this.linksOpening += 1;
    try {
      await this.activation;
      await this.startFromLink(link, this.deps.connection.isEmptyWindow() ? 'currentWindow' : 'newWindow');
    } catch (error) {
      this.showError(error);
    } finally {
      this.linksOpening -= 1;
    }
  }

  private async startFromLink(link: RepositoryLink, window: WindowRequest): Promise<void> {
    const accounts = await this.requireAccounts();
    const found = link.kind === 'course' ? await this.courseLinkRepository(link.template, accounts) : await this.openLinkRepository(link.repository, accounts);
    if (found === undefined) return;
    const { repository, info, account, candidates } = found;
    const name = info?.nameWithOwner ?? repository;
    if (link.kind === 'course' && account !== undefined) this.logger.info(`The course link opens ${repository} for ${account.login}.`);
    // One operation on the Docker host that is current now, as a Start (registerCommands): the target and the open.
    await this.withDockerTarget(async () => {
      // The devspace of the repository that an account of Devspaces used last on this host; for a course link, the
      // devspace of the account of the login in the name (repositoryTargetFor).
      // Without the data of GitHub (it could not be asked), only an existing devspace opens: no account is chosen for a
      // new one, and nothing is asked.
      const signIn = info !== undefined || account !== undefined ? 'start' : true;
      const target = await this.repositoryTargetFor(name, signIn, undefined, account !== undefined ? { account } : candidates !== undefined ? { candidates } : {});
      if (!target) return;
      if (account !== undefined) target.chosenAccount = true;
      if (target.devspace) {
        if (!info) this.logger.info(`Without the data of GitHub, the link opens the devspace of ${target.devspace.repository} that was used last.`);
        await this.startTarget({ ...target, info: target.info ?? info }, { window });
        return;
      }
      if (!info) {
        this.warnWithLog(ControllerTexts.linkRepositoryUnknown(repository));
        return;
      }
      const source = possibleSources({ info, devspaces: [], settings: this.deps.settings() })[0];
      if (!source) {
        this.logger.info(`The link did not open ${name}: it has no Dev Container configuration, and no default image is set.`);
        this.inform(Messages.noConfiguration(name));
        return;
      }
      // A link of a website creates a devspace only after one question, before any Docker work: for another owner, the
      // confirmation of every first open (as PipelineUi.confirmUntrustedRepository); for the account and its
      // organizations, the question of the link, unless the user turned it off (setting confirmOpenFromLink).
      const trusted = await this.deps.sidebar.trustedOwner(splitRepository(name).owner);
      if (!trusted || this.deps.settings().confirmOpenFromLink !== false) {
        const choice = trusted
          ? await showWarningMessage(ControllerTexts.linkStartConfirm(name), { modal: true }, Actions.open, ControllerTexts.alwaysOpen)
          : await showWarningMessage(Messages.untrustedRepository(name), { modal: true }, Actions.open);
        if (choice !== Actions.open && choice !== ControllerTexts.alwaysOpen) {
          this.logger.info(`The start of ${name} from the link was not confirmed.`);
          return;
        }
        if (choice === ControllerTexts.alwaysOpen) await this.turnOffLinkQuestion();
      } else {
        this.logger.info(`The link creates the devspace of ${name} without a question: the setting confirmOpenFromLink is off.`);
      }
      await this.startTarget({ ...target, info: target.info ?? info, source }, { window, confirmed: true });
    });
  }

  /**
   * Always Open in the question of a link: the user setting confirmOpenFromLink becomes false, so that
   * later links create a devspace of the account or of its organizations without the question. The devspace opens also
   * when the setting cannot be written; then the next link asks again.
   */
  private async turnOffLinkQuestion(): Promise<void> {
    try {
      await vscode.workspace.getConfiguration(SETTINGS_SECTION).update(CONFIRM_OPEN_FROM_LINK_SETTING, false, vscode.ConfigurationTarget.Global);
      this.logger.info('Links create a devspace of the account or of one of its organizations without a question from now on: the setting confirmOpenFromLink is off. Turn it on to get the question again.');
    } catch (error) {
      this.logger.warn(`The setting confirmOpenFromLink could not be turned off, so the next link asks again: ${errorMessage(error)}`);
    }
  }

  /**
   * The repository of a link `/open` for the accounts of Devspaces: from the list, else from GitHub with each account,
   * with the accounts that GitHub shows it to (`candidates`, rule 3 of accountChoice.ts). When GitHub could not be
   * asked, the repository without data (the link then opens only an existing devspace). `undefined` after a message
   * when GitHub shows it to none of them.
   */
  private async openLinkRepository(repository: string, accounts: readonly GitHubAccount[]): Promise<LinkRepository | undefined> {
    const listed = this.deps.sidebar.repositoryInfo(repository);
    if (listed) return { repository, info: listed };
    const results = await this.lookUpWithRenewal(accounts.map((account) => ({ repository, account })));
    const found = this.foundCandidates(accounts, results);
    const first = found[0];
    if (first !== undefined) return { repository, info: first.info, candidates: found.map((each) => each.candidate) };
    // An account that GitHub could not be asked with may still have the devspace; a rejected token without a new
    // sign-in only shows nothing.
    if (results.some((result) => result.failure === 'unknown')) return { repository };
    if (results.some((result) => result.failure === 'rejected')) throw new UserFacingError('signInRequired', Messages.signInRequired);
    this.logger.info(`GitHub does not show ${repository} to ${accounts.map((account) => account.login).join(', ')}. The link opened nothing.`);
    this.warn(ControllerTexts.linkRepositoryNotFound(repository, accounts.map((account) => account.login)));
    return undefined;
  }

  /**
   * The repository of a course link and the account that opens it: one candidate per account of Devspaces, the
   * template with its login (courseRepository), found in the list of that account, else with GitHub and that account.
   * The account of the login in the name opens it, never the one with the highest permission: the repository is the
   * personal one of that login. Several found: a Quick Pick (`undefined` when it is cancelled). None found: a message
   * that names each repository that was tried, and `undefined`. When GitHub could not be asked, the first such
   * candidate without data (it opens only an existing devspace).
   */
  private async courseLinkRepository(template: string, accounts: readonly GitHubAccount[]): Promise<LinkRepository | undefined> {
    const results: Array<{ account: GitHubAccount; repository: string } & LookUpResult> = [];
    const unlisted: Array<{ account: GitHubAccount; repository: string }> = [];
    for (const account of accounts) {
      const repository = courseRepository(template, account.login);
      if (repository === undefined) {
        this.logger.info(`The course link ${template} names no GitHub repository with the login ${account.login}.`);
        continue;
      }
      this.logger.info(`The course link asks for ${repository} for ${account.login}.`);
      const listed = this.deps.sidebar.repositoryInfo(repository);
      // The list counts for the account only when its own list has the repository (a lookup of the sidebar with the
      // token of another account names no access).
      if (listed?.access?.some((access) => access.account.id === account.id) === true) {
        results.push({ account, repository, info: listed });
        continue;
      }
      unlisted.push({ account, repository });
    }
    const looked = await this.lookUpWithRenewal(unlisted, results.length > 0);
    results.push(...unlisted.map((request, index) => ({ ...request, ...looked[index] })));
    // In the order of the accounts, as the Quick Pick below shows them.
    results.sort((a, b) => accounts.indexOf(a.account) - accounts.indexOf(b.account));
    if (results.length === 0) {
      this.warn(ControllerTexts.courseLinkInvalidForLogin(accounts.map((account) => account.login)));
      return undefined;
    }
    const found = results.flatMap((result) => (result.info !== undefined ? [{ ...result, info: result.info }] : []));
    if (found.length > 1) {
      const picked = await vscode.window.showQuickPick(
        found.map((result) => ({ label: result.info.nameWithOwner, description: result.account.login, result })),
        { title: ControllerTexts.courseRepositoryTitle, placeHolder: ControllerTexts.courseRepositoryPlaceholder },
      );
      if (!picked) {
        this.logger.info('The course link opened nothing: the pick of the repository was cancelled.');
        return undefined;
      }
      return { repository: picked.result.repository, info: picked.result.info, account: picked.result.account };
    }
    const one = found[0];
    if (one !== undefined) return { repository: one.repository, info: one.info, account: one.account };
    // As for a link /open (openLinkRepository): an account that GitHub could not be asked with first.
    const unknown = results.find((result) => result.failure === 'unknown');
    if (unknown !== undefined) return { repository: unknown.repository, account: unknown.account };
    if (results.some((result) => result.failure === 'rejected')) throw new UserFacingError('signInRequired', Messages.signInRequired);
    const only = results.length === 1 ? results[0] : undefined;
    this.warn(
      only !== undefined
        ? ControllerTexts.courseRepositoryNotFound(only.repository, only.account.login)
        : ControllerTexts.courseRepositoriesNotFound(results.map((result) => `${result.repository} (${result.account.login})`).join(', ')),
    );
    return undefined;
  }

  /**
   * lookUpRepository for each request (a repository and an account), all at the same time; when GitHub rejects the
   * token of an account (HTTP 401) and no account found its repository (`found`: the caller found one already), only
   * that account is asked to sign in again (renewToken, one dialog after the other), and GitHub is asked once more
   * with its new token. The results are in the order of `requests`.
   */
  private async lookUpWithRenewal(requests: ReadonlyArray<{ repository: string; account: GitHubAccount }>, found = false): Promise<LookUpResult[]> {
    const results = await Promise.all(requests.map(({ repository, account }) => this.lookUpRepository(repository, account)));
    // No new sign-in when another account opens the repository.
    if (found || results.some((result) => result.info !== undefined)) return results;
    for (const [index, { repository, account }] of requests.entries()) {
      if (results[index]?.failure !== 'rejected') continue;
      const token = await this.deps.auth.renewToken(account);
      if (token !== undefined) results[index] = await this.lookUpRepository(repository, account, token);
      // That account found it: no further sign-in.
      if (results[index]?.info !== undefined) break;
    }
    return results;
  }

  /**
   * The GitHub data of a repository for one account (with its token, or `token`): without data, `failure` says why:
   * GitHub does not show the repository to the account (`notFound`), rejected the token (`rejected`, HTTP 401, which
   * githubApi.ts reports to auth.ts), or could not be asked (`unknown`, logged). Never a dialog.
   */
  private async lookUpRepository(repository: string, account: GitHubAccount, token?: string): Promise<LookUpResult> {
    const used = token ?? (await this.deps.auth.getToken({ interactive: false, account }).catch(() => undefined));
    if (used === undefined) {
      this.logger.info(`GitHub was not asked for ${repository} with ${account.login}: its session cannot be read.`);
      return { failure: 'unknown' };
    }
    try {
      const info = await this.deps.discovery.getRepository(repository, used);
      if (info) return { info };
      this.logger.info(`GitHub does not show ${repository} to ${account.login}.`);
      return { failure: 'notFound' };
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 401) return { failure: 'rejected' };
      this.logger.warn(`GitHub could not be asked for ${repository} with ${account.login}: ${errorMessage(error)}`);
      return { failure: 'unknown' };
    }
  }

  /**
   * Turn Off Host Access Checks…: after a modal warning that names what the configuration of the repository can then
   * use, the repository joins the user setting devspaces.hostAccessChecksOff. The next open of its devspace applies
   * it.
   */
  async turnOffHostAccessChecks(argument: CommandArgument): Promise<void> {
    const names = await this.hostAccessNames(argument);
    if (!names) return;
    const { repository, key } = names;
    const settings = this.deps.settings();
    // The state that the pipeline applies: the switch under its key.
    if (hostAccessChecks(key, settings) === 'off') {
      this.inform(Messages.hostAccessChecksTurnedOff(repository));
      return;
    }
    const choice = await showWarningMessage(
      Messages.hostAccessChecksOffConfirm(repository),
      { modal: true, detail: Messages.hostAccessChecksOffDetail },
      Actions.turnOffChecks,
    );
    if (choice !== Actions.turnOffChecks) return;
    // Under every name of the repository here: the registry name of its devspaces (the pipeline reads it for them) and
    // the name on GitHub (the first open of another source of the repository reads it).
    await this.writeHostAccessChecks(names.all, 'off');
    this.logger.warn(`The host access checks were turned off for ${repository}. They apply from the next creation of its container.`);
    this.inform(Messages.hostAccessChecksTurnedOff(repository));
  }

  /**
   * Turn On Host Access Checks: the repository leaves the user setting devspaces.hostAccessChecksOff (no question),
   * under every name it has here (the name on GitHub and the name in the registry, which differ after a rename or a
   * transfer). At the next open, the checks run again, and a container that was created without them is created again
   * when the configuration passes them (containerIsCurrent).
   */
  async turnOnHostAccessChecks(argument: CommandArgument): Promise<void> {
    const names = await this.hostAccessNames(argument);
    if (!names) return;
    await this.writeHostAccessChecks(names.all, 'on');
    this.logger.info(`The host access checks were turned on again for ${names.repository}. They apply from the next open of its devspace.`);
    this.inform(Messages.hostAccessChecksTurnedOn(names.repository));
  }

  /**
   * The names of a row or a devspace for the switch of the host access checks: `repository` for the messages (the
   * name the sidebar shows), `key` the name the open pipeline reads the switch under (the registry name of the
   * devspace when there is one), and `all` every name involved (after a rename or a transfer on GitHub the registry
   * keeps the old name). None without an argument.
   */
  private async hostAccessNames(
    argument: CommandArgument,
  ): Promise<{ repository: string; key: string; all: string[] } | undefined> {
    if (argument.kind === 'row') {
      const devspace = argument.devspaceId !== undefined ? await this.deps.registry.get(argument.devspaceId) : undefined;
      // A row without a devspace of a repository that has one (a child row of another source): the switch of the
      // repository is the one of its devspaces, under their registry name, as the sidebar shows it on every row.
      const sibling = devspace ?? repositoryRows(this.deps.sidebar.model()).find((row) => row.repository.toLowerCase() === argument.repository.toLowerCase() && row.devspace !== undefined)?.devspace;
      const key = sibling?.repository ?? argument.repository;
      return { repository: argument.repository, key, all: uniqueNames([argument.repository, key]) };
    }
    if (argument.kind === 'devspace') {
      const devspace = await this.deps.registry.get(argument.devspaceId);
      if (!devspace) {
        this.inform(PipelineTexts.devspaceMissing);
        return undefined;
      }
      const repository = this.displayName({ repository: devspace.repository });
      return { repository, key: devspace.repository, all: uniqueNames([devspace.repository, repository]) };
    }
    this.logger.info('The switch of the host access checks needs a repository row.');
    return undefined;
  }

  /**
   * Writes the switch of `repositories` into the user setting devspaces.hostAccessChecksOff (ConfigurationTarget.Global:
   * the setting has the scope `application`, so no workspace or folder can turn a check off). The other entries stay.
   */
  private async writeHostAccessChecks(repositories: readonly string[], checks: HostAccessChecks): Promise<void> {
    const configuration = vscode.workspace.getConfiguration(SETTINGS_SECTION);
    let value: unknown = hostAccessChecksOffValue(configuration);
    for (const repository of repositories) value = withHostAccessChecks(value, repository, checks);
    const entries: unknown[] = Array.isArray(value) ? value : [];
    await configuration.update(HOST_ACCESS_CHECKS_OFF_SETTING, entries.length > 0 ? entries : undefined, vscode.ConfigurationTarget.Global);
  }

  /** Select Organizations…: writes the setting `owners`, the scan scope of the list. */
  async selectOwners(): Promise<void> {
    await selectOwners({
      auth: this.deps.auth,
      accountList: (accountId) => this.deps.sidebar.accountList(accountId),
      discovery: this.deps.discovery,
      settings: this.deps.settings,
      signIn: () => this.signIn(),
      logger: this.logger,
    });
  }

  /**
   * Add GitHub Account…: the account picker of VS Code, which ends with "Sign in to another account". The account that
   * the user chooses becomes an account of Devspaces: auth.ts fires the change of the sessions, which loads its list
   * and shows its devspaces.
   */
  async addAccount(): Promise<void> {
    const before = new Set((await this.readAccounts()).map((account) => account.id));
    const account = await this.deps.auth.addAccount();
    if (!account) {
      this.logger.info('No GitHub account was added.');
      return;
    }
    if (before.has(account.id)) {
      this.inform(ControllerTexts.accountAlreadyUsed(account.login));
      return;
    }
    this.logger.info(`Devspaces uses the GitHub account ${account.login} now.`);
    this.inform(ControllerTexts.accountAdded(account.login));
  }

  /** Sign in with GitHub. */
  async signIn(): Promise<void> {
    const token = await this.deps.auth.getToken({ interactive: true });
    await this.deps.auth
      .updateContextKey()
      .catch((error: unknown) => this.logger.warn(`The sign-in state could not be read: ${errorMessage(error)}`));
    if (!token) {
      this.logger.info('The GitHub sign-in was not completed.');
      return;
    }
    // A new session also fires the session change event, which starts a refresh: reuse it instead of a second one.
    await this.deps.sidebar.onSessionChanged({ again: false });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Flows

  /**
   * Start flow: the open pipeline, then the connection of this window or of a new window (`options.window`,
   * windowChoice.ts). The window stays connected to its previous devspace while the pipeline runs (a switch is the
   * same flow); with a new window, it keeps its devspace afterwards too. A devspace that another window uses is
   * never opened a second time: that window is shown instead.
   */
  /** `retry`: Try again after a failure; by default a Start of the target again (a first open of a command sets its own). */
  private async startTarget(target: Target, options: StartOptions = {}, retry?: () => Promise<void>): Promise<void> {
    const { service, connection } = this.deps;
    const devspace = target.devspace;
    const repository = this.displayName(target);
    const shown = this.shownName(target);
    const key = this.operationKey(target);
    // The source of the open: the one of an existing devspace, fixed at its creation (with the default image of the
    // settings now, sourceOf, so that a changed setting is noticed: Rebuild now / Later); else the one of the target
    // (its row, or the pick of the source), which the first open creates the devspace from.
    const source = devspace !== undefined ? sourceOf(devspace, this.deps.settings()) : (target.source ?? options.source);
    let reconnecting = false;
    let otherWindow: WindowStatus | undefined;
    // The container of this window whose state is read again within the operation, and what that read found running.
    let recheck: string | undefined;
    let found: WindowStateValue | undefined;
    // The container that this window works on without Devspaces (withoutDevspaces), read within the operation, and the
    // outdated container that this read found running, which the window leaves after the operation.
    let plain: string | undefined;
    let plainOutdated: WindowStateValue['outdated'];
    // The gate refused the operation (another one of the repository runs in this window).
    let refused = false;
    if (devspace) {
      if (this.isConnectedHere(devspace)) {
        // While an operation of this devspace runs in this window (the open pipeline of a restored window,
        // Reconnect), its end decides the state: nothing is read or left here.
        const running = this.gate.runningFor(key);
        if (running !== undefined) {
          this.logger.info(`Start of ${repository} was not started: ${running} of ${repository} is still running.`);
          return;
        }
        // "Already connected → nothing" only while the container runs; otherwise this is Reconnect.
        const containerName = this.current?.containerName ?? devspace.containerName;
        // One read of the worker gives whether it runs and whether it is outdated.
        const value = await this.windowState(devspace, containerName);
        // An operation of this devspace may have started, or the window may have left it, while the worker read.
        if (this.gate.runningFor(key) !== undefined || this.current?.devspace.id !== devspace.id) {
          this.logger.info(`Start of ${repository} was not started: the window or its operation changed while the state of its container was read.`);
          return;
        }
        // A known read decides here; the check of the connection need not read it again.
        if (value !== undefined && this.outdatedUncheckedFor?.devspaceId === devspace.id) this.outdatedUncheckedFor = undefined;
        if (value?.state === 'running') {
          // A container of an older version lacks the current setup. The pipeline must not replace it under this
          // window, so the window leaves it; a Start from the empty window makes a new container. The same for a
          // container made while the host access checks were off, when they are on now.
          const outdated = value.outdated;
          if (outdated) {
            this.logger.info(this.outdatedTexts(outdated, repository).log);
            await this.leaveDevspace(this.outdatedTexts(outdated, repository).message, {
              devspaceId: devspace.id,
              containerName,
              repository,
              reason: 'outdated',
            });
            return;
          }
          this.logger.info(`This window is connected to ${repository}.`);
          // The read succeeded, so the state is known again.
          if (this.current?.lost || this.current?.unknown) {
            this.current.lost = false;
            this.current.unknown = false;
            this.updateStatusBar();
          }
          this.inform(ControllerTexts.alreadyConnected(shown));
          return;
        }
        if (value === undefined) {
          // The pipeline must not replace a running container under this window, so an unknown state is read once more
          // within the operation, with the worker made ready in full (below).
          this.logger.info(`The state of the container of ${repository} could not be read. It is read again before the window connects again.`);
          recheck = containerName;
        } else {
          this.logger.info(`The container of ${repository} does not run. The window connects again.`);
        }
        reconnecting = true;
      } else if (this.withoutDevspaces?.devspace.id === devspace.id) {
        // This window works without Devspaces on the container of the devspace (an engine with the removal mark): the
        // Start sets Devspaces up there again and connects this window, never a second one, as a Reconnect. As for a
        // connected window, the pipeline never replaces the container that runs under this window: its state is read
        // within the operation, once the Start cleared the mark (beforeUserFlow), so no worker starts there before.
        this.logger.info(`This window works without Devspaces on ${repository}. The Start sets Devspaces up there again and connects this window.`);
        plain = this.withoutDevspaces.containerName;
        reconnecting = true;
      } else if ((otherWindow = await this.otherWindowOf(devspace.id))) {
        if ((await this.containerRuns(devspace, devspace.containerName)) === true) {
          // The pipeline must not replace the container under the other window (an update would disconnect it).
          // Assumption: VS Code shows the window that has this folder open instead of opening it again. Also for Start
          // in New Window: never two windows on one devspace.
          this.logger.info(`${repository} is open in another window. That window is shown.`);
          const folder = devspace.remoteWorkspaceFolder ?? repositoryFolder(devspace.repository);
          // A request for a new window never replaces the current window, also if VS Code does not find the other one.
          const args = this.otherWindowArgs(devspace, folder, otherWindow);
          if (this.opensNewWindow(options.window ?? 'default', false)) await connection.openInNewWindow(...args);
          else await connection.open(...args);
          return;
        }
        // Stopped: the next Start starts it. The other window has lost its connection, so the container can be started
        // (or replaced) as usual. The connection then shows the other window, which connects again.
        this.logger.info(
          `The container of ${repository} does not run. The connection of the other window is lost; the devspace starts.`,
        );
      }
    }
    const newWindow = this.opensNewWindow(options.window ?? 'default', reconnecting);
    // A Start in this window takes its connect request now, before the question below: a flow that connects this window
    // meanwhile (the automatic reopen) is then older, and does not connect over it (connect: the newest request wins).
    const reserved = newWindow ? undefined : this.reserveConnectRequest();
    let started: boolean;
    try {
      // A Start of the user asks about the Monitor of the engine before its open makes sure of it; the reopen at
      // startup asks nothing. Refused while Devspaces is being removed from the engine (told).
      if (options.automatic !== true && !(await this.beforeUserFlow('Start', devspace))) return;
      started = await this.operation(
        key,
        'Start',
        () =>
          runWithProgress({
            title: Messages.opening(shown),
            repository: shown,
            cancellable: true,
            task: (progress, signal) =>
              this.connectingFlow(
                newWindow,
                async (request) => {
                  let result: OpenResult;
                  if (devspace && plain !== undefined) {
                    const state = await service.windowStateInWorker(devspace, plain, { signal });
                    if (signal.aborted) throw new UserFacingError('cancelled', PipelineTexts.cancelled);
                    if (state === undefined) throw new UserFacingError('helperFailed', ControllerTexts.containerStateUnreadable(repository));
                    if (state.state === 'running') {
                      // An outdated container stays as it is: the window leaves it after the operation. A current one
                      // only connects this window again, now with Devspaces.
                      if (state.outdated) {
                        plainOutdated = state.outdated;
                        return;
                      }
                      this.logger.info(`The container of ${repository} runs. This window connects again, now with Devspaces.`);
                      const remoteWorkspaceFolder = devspace.remoteWorkspaceFolder ?? repositoryFolder(devspace.repository);
                      await this.connect({ devspace, containerName: plain, remoteWorkspaceFolder }, progress, request, signal);
                      return;
                    }
                  }
                  if (devspace && recheck !== undefined) {
                    const again = await service.windowStateInWorker(devspace, recheck, { signal });
                    if (signal.aborted) throw new UserFacingError('cancelled', PipelineTexts.cancelled);
                    if (again === undefined) throw new UserFacingError('helperFailed', ControllerTexts.containerStateUnreadable(repository));
                    if (again.state === 'running') {
                      found = again;
                      return;
                    }
                  }
                  if (devspace) {
                    result = await service.openDevspaceInWorker(devspace.id, { progress, signal, source });
                  } else {
                    const trusted = options.confirmed === true || (await this.firstOpenTrust(repository, target.account));
                    result = await service.openInWorker(repositoryTarget(repository, target.info, trusted), { progress, signal, source, ...(target.account ? { account: target.account } : {}) });
                  }
                  await this.connect(result, progress, request, signal);
                },
                reserved,
                options.automatic === true,
              ),
          }),
        // Try again is a Start: a repository takes the account of a session with a working token, as at the first try;
        // it opens in the same kind of window as the first try. A devspace starts on its own Docker host (as retryOn), a
        // new one on the host that Devspaces uses then (as withCommandTarget).
        {
          retry:
            retry ??
            (() =>
              outsideOperation(async () => {
                // Nothing when the user cancels a question of the account (repositoryTargetFor).
                const fresh = await this.refreshedTarget(target, 'start');
                if (!fresh) return;
                await this.withTargetOf(fresh.devspace, () => this.startTarget(fresh, { window: options.window, source: options.source }));
              })),
          refused: () => (refused = true),
        },
      );
    } finally {
      if (reserved !== undefined) this.activeConnectRequests.delete(reserved);
    }
    if (started && plainOutdated !== undefined && devspace && this.withoutDevspaces?.devspace.id === devspace.id) {
      // As for a connected window: the pipeline must not replace the container under this window, so the window leaves
      // it; a Start from the empty window makes a new container.
      this.logger.info(this.outdatedTexts(plainOutdated, repository).log);
      await this.leaveDevspace(this.outdatedTexts(plainOutdated, repository).message, {
        devspaceId: devspace.id,
        containerName: this.withoutDevspaces.containerName,
        repository,
        reason: 'outdated',
      });
      return;
    }
    if (started && found !== undefined && devspace && this.current?.devspace.id === devspace.id) {
      // The container runs after all: as for a Start whose first read found it running.
      const containerName = recheck ?? devspace.containerName;
      // This known read decides too.
      if (this.outdatedUncheckedFor?.devspaceId === devspace.id) this.outdatedUncheckedFor = undefined;
      if (found.outdated) {
        this.logger.info(this.outdatedTexts(found.outdated, repository).log);
        await this.leaveDevspace(this.outdatedTexts(found.outdated, repository).message, { devspaceId: devspace.id, containerName, repository, reason: 'outdated' });
        return;
      }
      this.logger.info(`This window is connected to ${repository}.`);
      this.current.lost = false;
      this.current.unknown = false;
      this.updateStatusBar();
      this.inform(ControllerTexts.alreadyConnected(shown));
      return;
    }
    if (!started && !refused && reconnecting && devspace) {
      // Reconnect: "Delete devspace" for missing files removed the devspace of this window.
      if (await this.leaveDeletedDevspace(devspace.id)) return;
      // As for a restored window whose pipeline failed: a container that was not made again and must not be used as it
      // is is left.
      const outdated = this.current?.devspace.id === devspace.id ? await this.containerOutdated(devspace) : undefined;
      if (outdated) {
        this.logger.info(`${this.outdatedTexts(outdated, repository).log} It was not made again.`);
        await this.leaveDevspace(this.outdatedTexts(outdated, repository).message, {
          devspaceId: devspace.id,
          containerName: this.current?.containerName ?? devspace.containerName,
          repository,
          reason: 'outdated',
        });
        return;
      }
      // A Reconnect of the user that failed leaves the window disconnected, also when the state of its container could
      // not be read before.
      if (this.current?.devspace.id === devspace.id && !this.current.lost) {
        this.current.lost = true;
        this.updateStatusBar();
      }
    }
  }

  /**
   * True if a Start with this request opens a new window (windowChoice.ts): the setting openInNewWindow, and whether this
   * window is empty or reconnects its own devspace.
   */
  private opensNewWindow(request: WindowRequest, reconnecting = false): boolean {
    return opensNewWindow({
      request,
      openInNewWindow: this.deps.settings().openInNewWindow === true,
      emptyWindow: this.deps.connection.isEmptyWindow(),
      reconnecting,
    });
  }

  /** The placeholder of the pick of a repository to start: the window that the Start uses, as in the switcher. */
  private repositoryPlaceholder(request: WindowRequest): string {
    return this.opensNewWindow(request) ? SwitcherTexts.newWindowRepositoryPlaceholder : SwitcherTexts.repositoryPlaceholder;
  }

  /**
   * Runs a flow that ends by connecting this window, with its number for `connect`: `reserved` (reserveConnectRequest),
   * or a new one. A flow that connects a new window (`newWindow`) leaves this window as it is: it is not one of the
   * connecting flows of this window, so it neither skips nor is skipped by them. `automatic`: the reopen at startup.
   */
  private async connectingFlow<T>(
    newWindow: boolean,
    fn: (request: ConnectRequest) => Promise<T>,
    reserved?: number,
    automatic = false,
  ): Promise<T> {
    if (newWindow) return fn({ newWindow: true });
    const request = reserved ?? this.reserveConnectRequest();
    this.activeConnectRequests.add(request);
    try {
      return await fn({ newWindow: false, number: request, ...(automatic ? { automatic } : {}) });
    } finally {
      this.activeConnectRequests.delete(request);
    }
  }

  /**
   * The number of a new request to connect this window, active from now on (a connecting flow that runs, or a Start
   * that still asks before its flow; `connect`). The caller removes it from activeConnectRequests at its end.
   */
  private reserveConnectRequest(): number {
    const request = ++this.connectRequests;
    this.activeConnectRequests.add(request);
    return request;
  }

  /**
   * Last step of the pipeline: the pending connection file, then the folder URI in this window. A flow does not connect
   * while a newer connecting flow runs in this window, for example the automatic reopen after the user selected another
   * devspace: the newest request wins, also when the older pipeline finishes first. The skipped devspace's
   * container stops after the long limit of the heartbeats of its open (stopAfterMinutes). Cancel in the progress
   * notification also counts when the pipeline has finished its last step already: the window stays as it is (Cancel
   * lets the user stay in the empty window).
   *
   * A new window (Start in New Window): the pending connection file (written with the ID of this window, the window
   * that ran the pipeline) keeps the container in use until the new window has written its status file; the new window
   * finds the fresh file at its activation, so it does not run the pipeline again (role A, `pipelineJustRan`), and
   * removes it. This window keeps its own devspace, status file, and reopen record.
   */
  private async connect(result: OpenResult, progress: ProgressReporter, request: ConnectRequest, signal: AbortSignal): Promise<void> {
    progress.step('connecting');
    // The checks of the container come first, so Cancel, a newer request, and an account change during them still keep
    // the window as it is. The log lines of the attach run meanwhile.
    const diagnostics = this.logAttachDiagnostics(result.devspace, result.containerName);
    const notReady = await this.readyForWindow(result.devspace, result.containerName, signal);
    const waited = new AbortController();
    // Cancel also ends this wait.
    await Promise.race([diagnostics, this.delay(ATTACH_DIAGNOSTICS_WAIT_MS, AbortSignal.any([waited.signal, signal]))]);
    waited.abort();
    if (!request.newWindow && [...this.activeConnectRequests].some((other) => other > request.number)) {
      this.logger.info(`${result.devspace.repository} is not connected: another devspace is opening in this window.`);
      return;
    }
    // A link that the reopen did not hold back (it arrived after the check of the reopen) may still ask its questions:
    // the reload of this window would end them.
    if (!request.newWindow && request.automatic === true && this.linksOpening > 0) {
      this.logger.info(`${result.devspace.repository} is not connected: a link to Devspaces is opening in this window.`);
      return;
    }
    if (signal.aborted) {
      this.logger.info(`${result.devspace.repository} is not connected: the user cancelled.`);
      // The pipeline wrote the pending connection file for this connection; without it the container stops as usual.
      await this.deps.sessionFiles
        .removePending(result.devspace.id)
        .catch((error: unknown) => this.logger.warn(`The pending connection file could not be removed: ${errorMessage(error)}`));
      throw new UserFacingError('cancelled', PipelineTexts.cancelled);
    }
    // The session is read at the start of the pipeline; the account may have signed out while it ran (a build can take
    // minutes). The window connects only to a devspace of an account of Devspaces now.
    const accounts = await this.readAccounts();
    const entry = (await this.deps.registry.get(result.devspace.id).catch(() => undefined)) ?? result.devspace;
    if (ownerAmong(entry, accounts) === undefined) {
      const repository = this.displayName({ repository: result.devspace.repository });
      this.logger.info(`${repository} is not connected: its GitHub account signed out while it opened.`);
      // No window connects: the Monitor container stops it when the heartbeats of the open end (their long
      // limit).
      await this.deps.sessionFiles
        .removePending(result.devspace.id)
        .catch((error: unknown) => this.logger.warn(`The pending connection file could not be removed: ${errorMessage(error)}`));
      throw accounts.length > 0
        ? new UserFacingError('otherAccount', Messages.otherAccount(repository, entry.owner.login))
        : new UserFacingError('signInRequired', Messages.signInRequired);
    }
    if (notReady) {
      // Without the pending connection file, the container stops as usual: after the long limit of the heartbeats of
      // its open (stopAfterMinutes).
      await this.deps.sessionFiles
        .removePending(result.devspace.id)
        .catch((error: unknown) => this.logger.warn(`The pending connection file could not be removed: ${errorMessage(error)}`));
      throw notReady;
    }
    await this.deps.coordinator.writePending(result.devspace.id);
    if (request.newWindow) {
      await this.deps.connection.openInNewWindow(...this.windowArgs(result.devspace, result.containerName, result.remoteWorkspaceFolder));
      return;
    }
    await this.deps.connection.open(...this.windowArgs(result.devspace, result.containerName, result.remoteWorkspaceFolder));
  }

  /**
   * A first open of a repository of an owner that is neither an account of Devspaces nor one of their organizations
   * needs a confirmation (ownerTrust). The trust needs the lists of the accounts, so the sign-in of the account of the
   * open comes first (the pipeline needs its token anyway).
   */
  private async firstOpenTrust(repository: string, account: GitHubAccount | undefined): Promise<boolean> {
    const token = await this.deps.auth.getToken({ interactive: true, account });
    if (!token) throw new UserFacingError('signInRequired', Messages.signInRequired);
    return this.deps.sidebar.trustedOwner(splitRepository(repository).owner);
  }

  /**
   * Stops the container: every Stop runs here, one of no window and the one that a connected window hands off (its
   * reloaded empty window). First the Monitor of the engine is told to stop it (stopThroughMonitor), so the
   * Stop is not lost when VS Code quits before this stop reaches Docker; then this window's own stop with its progress
   * (usually faster), and "<owner/name> stopped." at its end. The reopen record of the devspace goes (forgetReopen).
   */
  private async stopNow(target: Target, devspace: Devspace): Promise<void> {
    // Not even the Monitor is told while Devspaces is being removed from an engine (its channel would start a worker),
    // also by another window from the current one (operation() checks that again).
    if (this.refusedWhileRemoving('Stop')) return;
    if (await this.refusedWhileOtherWindowRemoves('Stop', await this.currentDockerHost())) return;
    const repository = this.shownName(target);
    await this.stopThroughMonitor(repository, devspace);
    await this.forgetReopen(devspace.id);
    const stopped = await this.operation(
      this.operationKey(target),
      'Stop',
      () => runWithProgress({ title: ControllerTexts.stopping(repository), task: () => this.deps.service.stop(devspace.id) }),
      { retry: this.retryOn(devspace, () => this.stopNow(target, devspace)) },
    );
    if (stopped) this.inform(ControllerTexts.stopped(repository));
  }

  /**
   * The stopNow heartbeat of the Stop of `devspace` (sendStop, within its bound); a failure is logged and the Stop
   * goes on. Not sent when the devspace is not on the Docker host of the operation (the stop refuses it), nor while
   * another window works on it (its live busy mark: the stop waits for that operation). A connected window sends it
   * from its deactivate() instead of its release (windowRelease.ts), once its connection really closes. Never throws.
   */
  private async stopThroughMonitor(repository: string, devspace: Devspace): Promise<void> {
    const monitor = this.deps.sessionMonitor;
    if (monitor === undefined) return;
    try {
      if (dockerHostOf(devspace) !== (await this.currentDockerHost())) return;
      if ((await this.otherWindowMark(devspace.id)) !== undefined) return;
      const sent = await monitor.sendStop(devspace.id);
      if (sent.ok) this.logger.info(`The Monitor of the engine of ${repository} was told to stop it: it stops the devspace also if VS Code quits first.`);
      else this.logger.warn(`The Monitor could not be told to stop ${repository}; this window stops it: ${sent.detail}`);
    } catch (error) {
      this.logger.warn(`The Monitor could not be told to stop ${repository}; this window stops it: ${errorMessage(error)}`);
    }
  }

  /**
   * A manual Stop also means "do not open it again": the reopen record of the devspace goes, so the next start of VS
   * Code does not reconnect to it. Every Stop runs here: one of no window, and the one that a connected window hands
   * off (its closing window wrote the record just before). Never throws.
   */
  private async forgetReopen(devspaceId: string): Promise<void> {
    try {
      if ((await this.deps.sessionFiles.readReopen())?.devspaceId !== devspaceId) return;
      await this.deps.sessionFiles.removeReopen();
      this.logger.info('The reopen record of the stopped devspace is removed: the next start of VS Code does not open it.');
    } catch (error) {
      this.logger.warn(`The reopen record could not be removed: ${errorMessage(error)}`);
    }
  }

  private deleteWithProgress(repository: string, devspace: Devspace, additionalVolumesToRemove: readonly string[]): Promise<void> {
    // Not cancellable: a delete that stops half-way helps nobody.
    return runWithProgress({
      title: ControllerTexts.deleting(repository),
      repository,
      // In the worker of the Docker host of the operation.
      task: (progress, signal) => this.deps.service.deleteInWorker(devspace.id, { progress, signal, additionalVolumesToRemove }),
    });
  }

  /** Rebuild of a devspace that this window may be connected to. */
  private async rebuildDevspace(target: Target, devspace: Devspace, request: { reason: PendingOperation['reason'] }): Promise<void> {
    const repository = this.shownName(target);
    // The question about the Monitor of the engine comes first, also before a hand-off: the window that runs the
    // Rebuild then asks nothing.
    if (!(await this.beforeUserFlow('Rebuild', devspace))) return;
    if (this.isAttachedHere(devspace)) {
      await this.handOff(target, devspace, { operation: 'rebuild', ...request }, 'rebuild');
      return;
    }
    if (await this.connectedInOtherWindow(devspace.id)) {
      // The other window closes its connection, and its reloaded window rebuilds and connects again.
      if (!(await this.confirmOtherWindow(repository, Actions.rebuildNow))) return;
      await this.operation(this.operationKey(target), 'Rebuild', () =>
        this.requestOtherWindowHandOff(repository, devspace, { operation: 'rebuild', ...request }),
      );
      return;
    }
    await this.operation(
      this.operationKey(target),
      'Rebuild',
      () =>
        runWithProgress({
          title: ControllerTexts.rebuilding(repository),
          repository,
          cancellable: true,
          task: async (progress, signal) => {
            // The window is not connected to this devspace, so it does not connect (the container runs until the
            // Monitor stops it). The devspace is built again from its source (sourceOf).
            await this.deps.service.openDevspaceInWorker(devspace.id, { progress, signal, forceRebuild: true, source: sourceOf(devspace, this.deps.settings()) });
          },
        }),
      { retry: this.retryOn(devspace, () => this.rebuildDevspace(target, devspace, request)) },
    );
  }

  /**
   * Operation on the devspace that this window is connected to: busy mark, pending operation, then "Close Remote
   * Connection". The window becomes an empty local window, and the extension there runs the operation (role B).
   */
  private async handOff(target: Target, devspace: Devspace, request: HandOffRequest, busy?: BusyOperation): Promise<void> {
    const repository = this.shownName(target);
    await this.withHostOf(devspace, () => this.operation(this.operationKey(target), request.operation, () => this.handOffNow(repository, devspace, request, busy)));
  }

  private async handOffNow(
    repository: string,
    devspace: Devspace,
    request: HandOffRequest,
    busy?: BusyOperation,
  ): Promise<void> {
    const { sessionFiles, coordinator, connection } = this.deps;
    // The empty window runs the operation on the Docker host of the devspace (runEmptyWindowTasksNow), and drops it
    // without a message when that host is not supported there. So the hand-off is refused here when it is not supported
    // now, as the pipeline refuses it (requireCurrentHost).
    const currentHost = await this.currentDockerHost();
    if (!isOnDockerHost(devspace, currentHost)) {
      throw new UserFacingError('otherDockerHost', Messages.otherDockerHost(repository, dockerHostOf(devspace), currentHost));
    }
    await this.prepareHandOff(repository, devspace, busy);
    this.logger.info(
      `${request.operation} of ${repository}: this window closes its remote connection, and the empty window continues.`,
    );
    try {
      await sessionFiles.writeOperation({
        devspaceId: devspace.id,
        operation: request.operation,
        requestedAt: isoTime(this.clock),
        requestedBy: coordinator.windowId,
        reason: request.reason,
        additionalVolumesToRemove: request.additionalVolumesToRemove,
      });
      await connection.closeRemoteConnection();
    } catch (error) {
      await this.cancelHandOff(devspace.id);
      throw error;
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.background(this.cancelHandOffIfUnclaimed(devspace.id), 'check the pending operation');
    }, this.deps.timing?.handOffCheckMs ?? HANDOFF_CHECK_MS);
    this.timers.add(timer);
  }

  /**
   * Before the connection closes: another live window must not be changing the devspace (an update, rebuild, or
   * delete). Its mark would otherwise be replaced, and the reloaded window would run a second operation on the same
   * devspace. With `operation`, sets this window's busy mark, so that the Monitor does not stop the
   * container before the reloaded window takes over.
   */
  private async prepareHandOff(
    repository: string,
    devspace: Devspace,
    operation: BusyOperation | undefined,
  ): Promise<void> {
    const owner = this.owner();
    const blocks = await this.markBlocker();
    const state: { conflict?: BusyMark } = {};
    let found: Devspace | undefined;
    if (operation) {
      const mark: BusyMark = { operation, since: isoTime(this.clock), pid: owner.pid, windowId: owner.windowId };
      found = await this.deps.registry.updateDevspace(devspace.id, (entry) => {
        if (entry.busy && blocks(entry.busy)) state.conflict = entry.busy;
        else entry.busy = mark;
      });
    } else {
      found = await this.deps.registry.get(devspace.id);
      if (found?.busy && blocks(found.busy)) state.conflict = found.busy;
    }
    if (!found) throw new UserFacingError('startFailed', Messages.noDevspace(repository));
    const conflict = state.conflict;
    if (conflict) {
      throw new UserFacingError(
        'startFailed',
        PipelineTexts.devspaceBusy(repository),
        `Busy mark: ${conflict.operation} since ${conflict.since}, process ${conflict.pid}, window ${conflict.windowId}.`,
      );
    }
  }

  /**
   * The test "a live mark of another window" (`isBlockingBusyMark`), with the window status files read once: for a busy
   * mark, and for the entry of a removal of Devspaces from an engine (EngineRemoval).
   */
  private async markBlocker(): Promise<(mark: WindowMark) => boolean> {
    const owner = this.owner();
    let windowStatuses: WindowStatus[] | undefined;
    try {
      windowStatuses = await this.deps.sessionFiles.readWindowStatuses();
    } catch (error) {
      this.logger.warn(`The window status files could not be read: ${errorMessage(error)}`);
    }
    const now = this.clock.now();
    return (mark) => isBlockingBusyMark(mark, owner, { now, isAlive: this.isAlive, windowStatuses });
  }

  /** The busy mark of another live window on the devspace (an operation that runs there), if any. */
  private async otherWindowMark(devspaceId: string): Promise<BusyMark | undefined> {
    const mark = (await this.deps.registry.get(devspaceId))?.busy;
    if (!mark) return undefined;
    return (await this.markBlocker())(mark) ? mark : undefined;
  }

  /**
   * Delete is possible in every state: while another window updates, rebuilds, creates, or switches the branch of the
   * devspace, the delete waits for the end of that operation, in a progress notification with Cancel. Returns false
   * when the user cancelled, or when the other window deletes the devspace itself.
   */
  private async waitForOtherWindowOperation(repository: string, devspaceId: string): Promise<boolean> {
    const mark = await this.otherWindowMark(devspaceId);
    if (!mark) return true;
    let outcome: 'free' | 'deleting' | 'cancelled' = 'deleting';
    if (mark.operation !== 'delete') {
      this.logger.info(
        `${repository} is busy (${mark.operation}) in another window (process ${mark.pid}). The delete waits for its end.`,
      );
      const pollMs = this.deps.timing?.busyPollMs ?? BUSY_POLL_MS;
      outcome = await runWithProgress({
        title: ControllerTexts.waitingForOtherWindow(repository),
        cancellable: true,
        task: async (_progress, signal): Promise<typeof outcome> => {
          for (;;) {
            await this.delay(pollMs);
            if (signal.aborted || this.disposed) return 'cancelled';
            const next = await this.otherWindowMark(devspaceId);
            if (!next) return 'free';
            if (next.operation === 'delete') return 'deleting';
          }
        },
      });
    }
    if (outcome === 'deleting') this.inform(ControllerTexts.alreadyDeleting(repository));
    if (outcome === 'cancelled') this.logger.info(`The delete of ${repository} was cancelled while it waited.`);
    return outcome === 'free';
  }

  /** This extension host still runs long after "Close Remote Connection": the connection was kept. */
  private async cancelHandOffIfUnclaimed(devspaceId: string): Promise<void> {
    if (this.disposed) return;
    // Only this devspace's file, so an unreadable file of another devspace does not keep this hand-off. When this
    // file cannot be read, its owner is not known: it throws, and the hand-off and the busy mark are kept (never
    // removed without knowing whose request it is).
    const operation = await this.deps.sessionFiles.readOperation(devspaceId);
    if (operation?.requestedBy !== this.deps.coordinator.windowId) return;
    this.logger.info('The remote connection was not closed. The pending operation is cancelled.');
    await this.cancelHandOff(devspaceId);
    this.background(this.deps.sidebar.render(), 'update the sidebar');
  }

  private async cancelHandOff(devspaceId: string): Promise<void> {
    await this.removeOperationQuietly(devspaceId);
    const owner = this.owner();
    await this.deps.registry
      .updateDevspace(devspaceId, (entry) => {
        if (entry.busy && entry.busy.windowId === owner.windowId && entry.busy.pid === owner.pid) delete entry.busy;
      })
      .catch((error: unknown) => this.logger.warn(`The busy mark could not be removed: ${errorMessage(error)}`));
  }

  /**
   * Another window is connected to the devspace (Stop, Rebuild, or Delete): that window closes its connection first.
   * This window leaves a disconnect request, which the connected window answers like its own request
   * (`checkDisconnectRequest`): VS Code asks there about unsaved files, and its reloaded empty window runs the
   * operation (role B). A request that no window takes in time is removed, and the user is told.
   */
  private async requestOtherWindowHandOff(
    repository: string,
    devspace: Devspace,
    request: HandOffRequest,
  ): Promise<void> {
    const sent: DisconnectRequest = {
      devspaceId: devspace.id,
      operation: request.operation,
      requestedAt: isoTime(this.clock),
      requestedBy: this.deps.coordinator.windowId,
      reason: request.reason,
      additionalVolumesToRemove: request.additionalVolumesToRemove,
    };
    await this.deps.disconnectRequests.write(sent);
    this.logger.info(
      `${request.operation} of ${repository}: the other window is asked to close its remote connection; its empty window continues.`,
    );
    this.inform(ControllerTexts.otherWindowContinues(repository));
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.background(this.dropUnansweredRequest(repository, sent), 'check the request to the other window');
    }, this.deps.timing?.disconnectAnswerMs ?? DISCONNECT_REQUEST_MAX_AGE_MS);
    this.timers.add(timer);
  }

  /** The connected window did not take the request in time: nothing was changed. */
  private async dropUnansweredRequest(repository: string, sent: DisconnectRequest): Promise<void> {
    if (this.disposed) return;
    const { disconnectRequests } = this.deps;
    const request = await disconnectRequests.read(sent.devspaceId);
    if (!request || request.requestedAt !== sent.requestedAt || request.requestedBy !== sent.requestedBy) return;
    // `take`, so that the connected window cannot take it at the same moment.
    if (!(await disconnectRequests.take(sent.devspaceId))) return;
    this.logger.warn(`The other window did not close its connection for the ${sent.operation} of ${repository}.`);
    showWarningMessage(ControllerTexts.otherWindowNoAnswer(repository))
      .then(undefined, (error: unknown) => this.logger.error('Could not show the message.', error));
  }

  /**
   * The connected side of a disconnect request: another window stops, rebuilds, or deletes the devspace of this
   * window. This window hands off as for its own request: busy mark, pending operation, then "Close Remote Connection",
   * where VS Code asks about unsaved files. If the user keeps the connection there, the pending operation is removed
   * again (`cancelHandOffIfUnclaimed`).
   */
  private async checkDisconnectRequest(): Promise<void> {
    // A window that works without Devspaces hands off the same way: the reloaded empty window runs the operation.
    const current = this.current ?? this.withoutDevspaces;
    if (!current || this.disposed) return;
    const { disconnectRequests, registry } = this.deps;
    const devspaceId = current.devspace.id;
    const request = await disconnectRequests.read(devspaceId);
    if (!request) return;
    const repository = this.displayName({ repository: current.devspace.repository });
    if (!isFreshDisconnectRequest(request, this.clock.now())) {
      this.logger.info(`The request of another window to close the connection to ${repository} is too old and is dropped.`);
      await disconnectRequests.remove(devspaceId);
      return;
    }
    // An operation of this devspace runs in this window (for example Reconnect): a later check answers the request.
    if (this.gate.runningFor(this.keyOfDevspace(repository, current.devspace)) !== undefined) return;
    if (!(await disconnectRequests.take(devspaceId))) return;
    const devspace = await registry.get(devspaceId);
    if (!devspace || (this.current ?? this.withoutDevspaces) !== current) {
      this.logger.info(`The request of another window for ${repository} is dropped: this window has left the devspace.`);
      return;
    }
    if (ownerAmong(devspace, await this.readAccounts()) === undefined) {
      this.logger.info(`The request of another window for ${repository} is dropped: the devspace is of a GitHub account that Devspaces does not use.`);
      return;
    }
    this.logger.info(`Another window asks this window to close its connection for the ${request.operation} of ${repository}.`);
    await this.handOff(
      this.devspaceTarget(devspace),
      devspace,
      {
        operation: request.operation,
        reason: request.reason,
        additionalVolumesToRemove: request.operation === 'delete' ? (request.additionalVolumesToRemove ?? []) : undefined,
      },
      HAND_OFF_BUSY[request.operation],
    );
  }

  /** Role B: runs a claimed pending operation. The operation file is always removed at the end. */
  private async runPendingOperation(operation: PendingOperation): Promise<void> {
    const { registry } = this.deps;
    try {
      const devspace = await registry.get(operation.devspaceId);
      if (!devspace) {
        this.logger.info(
          `The pending ${operation.operation} is dropped: the devspace ${operation.devspaceId} does not exist anymore.`,
        );
        return;
      }
      const target = this.devspaceTarget(devspace);
      this.logger.info(`Running the pending ${operation.operation} of ${this.displayName(target)}.`);
      switch (operation.operation) {
        case 'rebuild':
          // The update order, then this window connects again.
          await this.rebuildAndConnect(target, devspace, () => this.removeOperationQuietly(operation.devspaceId));
          return;
        case 'delete':
          await this.operation(
            this.operationKey(target),
            'Delete',
            () => this.deleteWithProgress(this.shownName(target), devspace, operation.additionalVolumesToRemove ?? []),
            { retry: this.retryOn(devspace, () => this.delete({ kind: 'devspace', devspaceId: devspace.id })) },
          );
          return;
        case 'stop':
          await this.stopNow(target, devspace);
          return;
      }
    } catch (error) {
      this.showError(error);
    } finally {
      await this.removeOperationQuietly(operation.devspaceId);
    }
  }

  private async rebuildAndConnect(target: Target, devspace: Devspace, beforeConnect: () => Promise<void>): Promise<void> {
    const repository = this.shownName(target);
    await this.operation(
      this.operationKey(target),
      'Rebuild',
      () =>
        runWithProgress({
          title: ControllerTexts.rebuilding(repository),
          repository,
          cancellable: true,
          task: (progress, signal) =>
            this.connectingFlow(false, async (connectRequest) => {
              // The devspace is built again from its source (sourceOf).
              const result = await this.deps.service.openDevspaceInWorker(devspace.id, { progress, signal, forceRebuild: true, source: sourceOf(devspace, this.deps.settings()) });
              // The window reloads when it connects; nothing after `connect` is sure to run.
              await beforeConnect();
              await this.connect(result, progress, connectRequest, signal);
            }),
        }),
      { retry: this.retryOn(devspace, () => this.rebuildAndConnect(target, devspace, beforeConnect)) },
    );
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Connection of this window

  /**
   * Registry restored from the volumes: this window may be attached to one of the restored devspaces. Never in a
   * window of role A; one adoption at a time, and once per window.
   */
  private async adoptWindowDevspace(): Promise<void> {
    if (this.attaching || this.adopted || this.current) return;
    this.adoption ??= this.adoptWindowDevspaceNow().finally(() => {
      this.adoption = undefined;
    });
    await this.adoption;
  }

  private async adoptWindowDevspaceNow(): Promise<void> {
    const containerName = this.deps.connection.currentContainerName();
    if (!containerName) return;
    const restored = await this.deps.registry.findByContainerName(containerName);
    if (!restored || this.attaching || this.adopted) return;
    this.adopted = true;
    // On an engine with the removal mark (a Refresh of the user restores there and keeps the mark), the window works
    // without Devspaces, as one that started there (workWithoutDevspaces): its heartbeats would set Devspaces up there
    // again. The account rule comes first there too.
    if (await this.hasRemovalMark(dockerHostOf(restored))) {
      if (!this.current) await this.workWithoutDevspaces(restored, containerName);
      return;
    }
    const devspace = await this.ownWindowDevspace(restored, containerName);
    if (!devspace || this.current) return;
    // No pipeline runs here, so a container of an older version is not made again: the window leaves it, and so it does
    // a container made while the host access checks were off, when they are on now.
    const outdated = await this.containerOutdated(devspace);
    if (this.current) return;
    if (outdated) {
      const repository = this.displayName({ repository: devspace.repository });
      this.logger.info(this.outdatedTexts(outdated, repository).log);
      await this.leaveDevspace(this.outdatedTexts(outdated, repository).message, {
        devspaceId: devspace.id,
        containerName,
        repository,
        reason: 'outdated',
      });
      return;
    }
    this.current = { devspace, containerName, lost: false };
    await this.deps.coordinator.setDevspace(devspace.id);
    this.updateStatusBar();
    // A window connects again, so Close and Keep Running has done its work.
    await this.clearKeepRunningOnce(devspace.id);
    if (!(await this.stillAvailable(devspace))) return;
    this.background(this.readWindowBranch(), 'read the branch of the devspace');
  }

  /**
   * Checks the account again right after the window took `devspace` (the check of `ownWindowDevspace` ran before
   * awaits, during which the account can change without the window noticing). False when the window left it.
   */
  private async stillAvailable(devspace: Devspace): Promise<boolean> {
    await this.onSessionChanged();
    return this.current?.devspace.id === devspace.id;
  }

  /**
   * The devspace of this window was deleted, for example with "Delete devspace" when its files were missing: the
   * window leaves it and closes its remote connection, instead of offering Reconnect for a devspace that does not
   * exist anymore. Returns false when the devspace still exists.
   */
  private async leaveDeletedDevspace(devspaceId: string): Promise<boolean> {
    if (this.current?.devspace.id !== devspaceId) return false;
    try {
      if (await this.deps.registry.get(devspaceId)) return false;
    } catch (error) {
      this.logger.warn(`The registry could not be read: ${errorMessage(error)}`);
      return false;
    }
    this.logger.info('The devspace of this window was deleted. The window closes its remote connection.');
    await this.leaveDevspace();
    return true;
  }

  /**
   * The window leaves its devspace: no devspace in its status file (the coordinator sends its short release, and
   * the Monitor container stops it after the waiting time unless it is kept), the status bar, then "Close
   * Remote Connection", with `message` for the user. With `left` (a devspace that the window must not use), the
   * window does not rely on the close: VS Code lets the user keep the connection (Cancel in the dialog about unsaved
   * files), and `checkLeftConnection` closes the connection again. When the account is the reason, the token of the
   * owner account leaves the container before the close (`awaitTokenRemoval`).
   */
  private async leaveDevspace(message?: string, left?: LeftDevspace): Promise<void> {
    const plain = this.withoutDevspaces !== undefined;
    this.current = undefined;
    this.withoutDevspaces = undefined;
    this.left = left;
    const statusFailed = (error: unknown): void => this.logger.warn(`The window status could not be written: ${errorMessage(error)}`);
    if (plain) await this.deps.coordinator.setPlainDevspace(null).catch(statusFailed);
    await this.deps.coordinator.setDevspace(null).catch(statusFailed);
    this.updateStatusBar();
    if (message) this.warn(message);
    if (left?.reason === 'account') {
      const requests = this.connectRequests;
      await this.awaitTokenRemoval(left, this.removeGitToken(left));
      // The owner account signed in again meanwhile, and the window reloads to open the devspace (reopenLeftDevspace).
      if (this.left !== left || this.disposed) return;
      if ([...this.activeConnectRequests].some((request) => request > requests)) {
        // A Start in this window began meanwhile and connects it elsewhere: the close must not end its pipeline.
        // Checked again later (checkLeftConnection).
        this.closeConnection(left, { closeFirst: false });
        return;
      }
    }
    this.closeConnection(left);
  }

  /**
   * "Close Remote Connection", then (with `left`) the check whether the window has closed it. Not awaited: a restored
   * window's activate() must end first, and the command reloads the window. `closeFirst: false` only schedules the
   * check.
   */
  private closeConnection(left: LeftDevspace | undefined, options: { closeFirst?: boolean } = {}): void {
    const close = options.closeFirst ?? true;
    this.background(
      this.delay(0)
        .then(() => (close ? this.deps.connection.closeRemoteConnection() : undefined))
        .finally(() => {
          // The window reloads when the connection closes, and this extension host ends: the check never runs then.
          if (!left || this.left !== left || this.disposed) return;
          const timer = setTimeout(() => {
            this.timers.delete(timer);
            this.background(this.checkLeftConnection(true), 'check the connection of this window');
          }, this.deps.timing?.leaveCheckMs ?? LEAVE_CHECK_MS);
          this.timers.add(timer);
        }),
      'close the remote connection',
    );
  }

  /**
   * The window left a devspace that it must not use (`leaveDevspace` with `left`), and this extension host still
   * runs, so the window may have kept its connection. When the signed-in account may use the devspace again (the
   * user signed in with the owner account), the window reloads: the open pipeline of role A runs and writes the token
   * again. Otherwise, with `retry`, the window says so and closes its connection again.
   */
  private async checkLeftConnection(retry: boolean): Promise<void> {
    const left = this.left;
    if (!left || this.current || this.disposed || this.checkingLeft) return;
    if (this.deps.connection.currentContainerName() !== left.containerName) {
      this.left = undefined;
      return;
    }
    this.checkingLeft = true;
    try {
      if (await this.reopenLeftDevspace(left)) return;
      if (!retry) return;
      if (this.activeConnectRequests.size > 0) {
        // A Start in this window connects it elsewhere: the close must not end its pipeline. Checked again later.
        this.closeConnection(left, { closeFirst: false });
        return;
      }
      this.logger.warn(`This window is still connected to ${left.repository}, which it must not use. It closes its remote connection again.`);
      // The removal runs while the message is open; the limit of the wait counts from its end.
      const removal = left.reason === 'account' ? this.removeGitToken(left) : undefined;
      // The one button names what follows; a close of the message (Escape) does the same.
      const closeConnection: vscode.MessageItem = { title: ControllerTexts.closeConnection, isCloseAffordance: true };
      await showWarningMessage(ControllerTexts.stillConnected(left.repository), { modal: true }, closeConnection)
        .then(undefined, (error: unknown) => this.logger.error('Could not show the message.', error));
      if (removal) await this.awaitTokenRemoval(left, removal);
      // The owner account may have signed in while the message was open.
      if (await this.reopenLeftDevspace(left)) return;
      if (this.left !== left || this.current || this.disposed) return;
      if (this.activeConnectRequests.size > 0) {
        // A Start began while the message was open or during the wait (as above).
        this.closeConnection(left, { closeFirst: false });
        return;
      }
      this.closeConnection(left);
    } finally {
      this.checkingLeft = false;
    }
  }

  /**
   * The window left the devspace because of the account, and its owner account is an account of Devspaces again: the
   * window reloads, and the open pipeline of role A runs (it writes the token again). Returns true when the window
   * reloads.
   */
  private async reopenLeftDevspace(left: LeftDevspace): Promise<boolean> {
    if (left.reason !== 'account') return false;
    const accounts = await this.readAccounts();
    const devspace = await this.deps.registry.get(left.devspaceId).catch(() => undefined);
    if (this.left !== left || this.current || this.disposed) return false;
    if (!devspace || ownerAmong(devspace, accounts) === undefined) return false;
    let args: ReturnType<Controller['windowArgs']>;
    try {
      args = this.windowArgs(devspace, left.containerName, devspace.remoteWorkspaceFolder ?? repositoryFolder(devspace.repository));
    } catch (error) {
      this.logger.warn(`The GitHub account of ${left.repository} is signed in again, but the window cannot open it: ${errorMessage(error)}`);
      return false;
    }
    this.left = undefined;
    this.logger.info(`The GitHub account of ${left.repository} is signed in again. The window reloads to open it.`);
    await this.deps.connection.open(...args);
    return true;
  }

  /**
   * The token of the owner account leaves the devspace that the signed-in account may not use, so that Git and the
   * GitHub CLI there cannot work as the owner while a window keeps its connection. The token is only in the memory of
   * the dev container, so it is removed from there when the container runs (the operation `tokenRemove`, a flow of the
   * worker, as root, or as the remote user of the entry when root may not); a stopped container holds no token. The
   * credential helper of the container then gives nothing; the next open of the owner writes the token again. Best
   * effort: the result is logged. Never throws.
   */
  private async removeGitToken(left: KnownLeftDevspace): Promise<void> {
    const { containerName } = left;
    try {
      const target = await this.operationTarget();
      if (!this.deps.docker.canRunOn(target)) return;
      // Never on another Docker host (its container is not on the current engine).
      const known = await this.deps.registry.get(left.devspaceId).catch(() => undefined);
      if (known && !isOnDockerHost(known, target.host)) {
        this.logger.info(`The container ${containerName} is on another Docker host. Its token is not removed from here.`);
        return;
      }
      // The flow runs in the worker of the engine (its log lines come from there), bounded
      // (TOKEN_REMOVE_FLOW_TIMEOUT_MS), through the operations of the window, as every other flow.
      await this.deps.service.removeTokenInWorker(left.devspaceId, containerName);
    } catch (error) {
      this.logger.warn(`The GitHub token could not be removed from the container ${containerName}: ${errorMessage(error)}`);
    }
  }

  /**
   * Waits for `removal` (removeGitToken) before "Close Remote Connection", which reloads the window and ends this
   * extension host, and with it a removal that has not ended. Waits at most TOKEN_REMOVE_WAIT_MS; the removal continues
   * after that while this extension host runs.
   */
  private async awaitTokenRemoval(left: LeftDevspace, removal: Promise<void>): Promise<void> {
    const waited = new AbortController();
    const limit = this.delay(this.deps.timing?.tokenRemoveWaitMs ?? TOKEN_REMOVE_WAIT_MS, waited.signal).then(() => false);
    const ended = await Promise.race([removal.then(() => true, () => true), limit]);
    waited.abort();
    if (!ended) this.logger.warn(`The GitHub token is not removed from the container ${left.containerName} yet. The window closes its remote connection without waiting longer.`);
  }

  /**
   * Role A and a restored registry: the devspace that this window is attached to, when it belongs to an account of
   * Devspaces (without one, a sign-in is asked for: of the owner when its login is known). Otherwise the window runs no
   * pipeline, starts no container, and
   * closes its remote connection with a message; `undefined`. Assumption: the activation blocks the connection of a
   * restored window, so the window of another account never connects to a stopped container, and the token of the
   * owner leaves a container that still runs before the window connects to it (leaveDevspace, within
   * TOKEN_REMOVE_WAIT_MS); the window closes that connection right after it connected.
   */
  private async ownWindowDevspace(devspace: Devspace, containerName: string): Promise<Devspace | undefined> {
    let accounts = await this.readAccounts();
    if (accounts.length === 0) {
      const named = nonEmpty(devspace.owner.login) !== undefined ? devspace.owner : undefined;
      const account = await this.deps.auth.getAccount({ interactive: true, ...(named ? { account: named } : {}) }).catch((error: unknown) => {
        this.logger.warn(`The GitHub account could not be read: ${errorMessage(error)}`);
        return undefined;
      });
      // Another account that the user signed in with instead counts too (the message then names another account).
      accounts = account ? [account] : await this.readAccounts();
    }
    if (ownerAmong(devspace, accounts) !== undefined) return devspace;
    const repository = this.displayName({ repository: devspace.repository });
    let message: string;
    if (accounts.length === 0) {
      this.logger.info('Nobody is signed in to GitHub. The window closes its remote connection.');
      message = ControllerTexts.signedOutConnection(repository);
    } else {
      // The attach tests look for this line.
      this.logger.info('This window is attached to a devspace of another GitHub account. It closes its remote connection.');
      message = Messages.otherAccountConnection(repository);
    }
    await this.leaveDevspace(message, { devspaceId: devspace.id, containerName, repository, reason: 'account' });
    return undefined;
  }

  /**
   * Sign-in or sign-out of an account: a window connected to a devspace whose owner account is no longer an account of
   * Devspaces closes its remote connection at once, after the token of the owner left the container (leaveDevspace).
   * A new account never closes a window, and neither does the sign-out of another account. The Monitor container stops
   * the devspace after the waiting time (the release of the window). A window that has left such a devspace but kept
   * its connection reloads when the owner account signs in again. The account rule outranks the removal mark: a
   * window that works without Devspaces on an engine with the mark (workWithoutDevspaces) leaves its devspace in the
   * same way, without a release (its session has no devspace).
   */
  async onSessionChanged(): Promise<void> {
    const current = this.current ?? this.withoutDevspaces;
    if (this.disposed) return;
    if (!current) {
      await this.checkLeftConnection(false);
      return;
    }
    const accounts = await this.readAccounts();
    const devspace = (await this.deps.registry.get(current.devspace.id).catch(() => undefined)) ?? current.devspace;
    if (ownerAmong(devspace, accounts) !== undefined || (this.current ?? this.withoutDevspaces) !== current) return;
    const repository = this.displayName({ repository: devspace.repository });
    this.logger.info(
      accounts.length > 0
        ? `The GitHub account of ${repository} is no longer signed in to Devspaces: the window closes its remote connection.`
        : 'Nobody is signed in to GitHub anymore. The window closes its remote connection.',
    );
    await this.leaveDevspace(
      accounts.length > 0 ? Messages.otherAccountConnection(repository) : ControllerTexts.signedOutConnection(repository),
      {
        devspaceId: devspace.id,
        containerName: current.containerName,
        repository,
        reason: 'account',
      },
    );
  }

  /**
   * Why the container of the devspace exists but must not be used as it is: `version`, it was made by an older
   * version of the extension (label nimblescape.devspaces.container-version); `hostAccess`, it was made while the host
   * access checks of the repository were off, and they are on now (containerIsCurrent). `undefined` otherwise, and when
   * Docker cannot be asked. Never throws.
   */
  private async containerOutdated(devspace: Devspace): Promise<'version' | 'hostAccess' | undefined> {
    if (!this.hasDockerCliFor(devspace)) return undefined;
    // Read by the worker; unknown (undefined) when it cannot be read.
    const value = await this.deps.service.windowStateInWorker(devspace, devspace.containerName);
    // The window stays then, and the next check of the connection that can read it leaves an outdated container
    // (checkConnection).
    this.outdatedUncheckedFor = value === undefined ? { devspaceId: devspace.id, checks: hostAccessChecks(devspace.repository, this.deps.settings()) } : undefined;
    return value?.outdated;
  }

  /** The message and the log line when the window leaves a container for the reason of containerOutdated. */
  private outdatedTexts(reason: 'version' | 'hostAccess', repository: string): { message: string; log: string } {
    return reason === 'hostAccess'
      ? {
          message: ControllerTexts.unrestrictedContainerClosed(repository),
          log: `The container of ${repository} was made while the host access checks were off, and they are on now. The window closes its remote connection.`,
        }
      : {
          message: ControllerTexts.outdatedContainerClosed(repository),
          log: `The container of ${repository} is of an older version. The window closes its remote connection.`,
        };
  }

  /** The container of this window does not run (for example after a Docker restart). */
  private async checkConnection(): Promise<void> {
    const current = this.current;
    if (!current || this.checkingConnection || this.disposed) return;
    // While an operation of this devspace runs in this window (the open pipeline of a restored window, Reconnect),
    // the container is being started or replaced; the operation's end decides the state. Otherwise a check during the
    // pipeline could leave "Reconnect" in the status bar after a successful start.
    const repository = this.displayName({ repository: current.devspace.repository });
    const key = this.keyOfDevspace(repository, current.devspace);
    if (this.gate.runningFor(key) !== undefined) return;
    this.checkingConnection = true;
    try {
      const value = await this.windowState(current.devspace, current.containerName);
      const runs = this.hasDockerCliFor(current.devspace) ? (value === undefined ? undefined : value.state === 'running') : false;
      // The window or its operation may have changed while the worker read.
      if (this.current !== current || this.disposed || this.gate.runningFor(key) !== undefined) return;
      // Whether it is outdated could not be read when the window attached; now it can.
      const unchecked = this.outdatedUncheckedFor;
      if (value !== undefined && unchecked?.devspaceId === current.devspace.id) {
        this.outdatedUncheckedFor = undefined;
        // A container made while the checks were off is left only when they were on already when the window attached
        // ("applies from the next open").
        const sameChecks = hostAccessChecks(current.devspace.repository, this.deps.settings()) === unchecked.checks;
        if (value.outdated === 'version' || (value.outdated === 'hostAccess' && sameChecks)) {
          this.logger.info(this.outdatedTexts(value.outdated, repository).log);
          await this.leaveDevspace(this.outdatedTexts(value.outdated, repository).message, {
            devspaceId: current.devspace.id,
            containerName: current.containerName,
            repository,
            reason: 'outdated',
          });
          return;
        }
      }
      // A state that could not be read (the worker could not be reached) changes nothing but the tooltip.
      if ((runs === undefined) !== (current.unknown === true)) {
        current.unknown = runs === undefined;
        this.updateStatusBar();
      }
      if (runs === undefined) return;
      const lost = !runs;
      if (lost === current.lost) return;
      current.lost = lost;
      this.logger.info(lost ? `The container of ${repository} does not run.` : `The container of ${repository} runs again.`);
      this.updateStatusBar();
      if (this.deps.viewVisible()) this.background(this.deps.sidebar.refreshStates(), 'update the sidebar');
    } finally {
      this.checkingConnection = false;
    }
  }

  private async readWindowBranch(): Promise<void> {
    const current = this.current;
    if (!current) return;
    await this.checkConnection();
    // Read by the worker. A passive read, which never builds the helper image (windowStateInWorker).
    const branch = (await this.deps.service.windowStateInWorker(current.devspace, current.containerName, { branch: true }))?.branch;
    if (branch && this.current === current) {
      current.branch = branch;
      this.updateStatusBar();
    }
  }

  /**
   * The state of the container, or why it could not be read: the check of the attach (readyForWindow). Read by the
   * worker of the engine (windowStateInWorker), like every read of a container.
   */
  private async containerStateText(devspace: Devspace, containerName: string, signal: AbortSignal): Promise<string> {
    if (!this.hasDockerCliFor(devspace)) return 'Docker is not installed';
    // Not passive (a worker lost after the open is opened again at once), bounded, and ended by the cancel of the open.
    const value = await this.deps.service.windowStateInWorker(devspace, containerName, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(WINDOW_STATE_FLOW_TIMEOUT_MS)]),
    });
    return value === undefined ? 'not readable' : String(value.state);
  }

  /**
   * Whether the container runs, read by the worker; `undefined` when it could not be read (unknown). A Start or
   * Reconnect of the user takes unknown as "not running" and tries; its failure leaves the window disconnected.
   */
  private async containerRuns(devspace: Devspace, containerName: string): Promise<boolean | undefined> {
    if (!this.hasDockerCliFor(devspace)) return false;
    const value = await this.deps.service.windowStateInWorker(devspace, containerName);
    return value === undefined ? undefined : value.state === 'running';
  }

  /**
   * The state of the container and whether it is outdated, in one read of the worker (passive and bounded). `undefined`
   * when it could not be read, or Docker is not installed.
   */
  private async windowState(devspace: Devspace, containerName: string): Promise<WindowStateValue | undefined> {
    if (!this.hasDockerCliFor(devspace)) return undefined;
    return this.deps.service.windowStateInWorker(devspace, containerName);
  }

  /**
   * Whether a Docker CLI runs the calls on the engine of `devspace` (BootstrapDocker.canRunOn): on a computer without
   * Docker, the Docker CLI of Devspaces runs those of a remote host.
   */
  private hasDockerCliFor(devspace: Pick<Devspace, 'dockerHost'>): boolean {
    return this.deps.docker.canRunOn({ kind: dockerHostOf(devspace) === '' ? 'local' : 'remote' });
  }

  private updateStatusBar(): void {
    const current = this.current;
    const { statusBar } = this.deps;
    this.updateConnectedContext(current !== undefined);
    if (!current) {
      statusBar.showStateUnknown(false);
      statusBar.showNotConnected();
      return;
    }
    const repository = this.shownName(this.devspaceTarget(current.devspace));
    statusBar.showStateUnknown(current.unknown === true);
    if (current.lost) statusBar.showConnectionLost(repository, current.devspace.id);
    else statusBar.showConnected(repository, current.branch ?? current.devspace.gitSummary?.branch ?? undefined);
  }

  /** The context key CONNECTED_CONTEXT_KEY, set when it changes. */
  private updateConnectedContext(connected: boolean): void {
    if (this.connectedContext === connected) return;
    this.connectedContext = connected;
    Promise.resolve(vscode.commands.executeCommand('setContext', CONNECTED_CONTEXT_KEY, connected)).catch((error: unknown) =>
      this.logger.warn(`The context key ${CONNECTED_CONTEXT_KEY} could not be set: ${errorMessage(error)}`),
    );
  }

  private isConnectedHere(devspace: Devspace): boolean {
    return this.current?.devspace.id === devspace.id;
  }

  /**
   * Whether this window is attached to the container of `devspace`: connected to it (isConnectedHere), or working
   * without Devspaces on it on an engine with the removal mark (workWithoutDevspaces). Stop, Rebuild and Delete hand
   * off then; a Start in such a window sets Devspaces up again (isConnectedHere only).
   */
  private isAttachedHere(devspace: Devspace): boolean {
    return this.isConnectedHere(devspace) || this.withoutDevspaces?.devspace.id === devspace.id;
  }

  /**
   * The status of another active window that is attached to the devspace, if any (see otherActiveWindowsKnown):
   * connected to it, or working without Devspaces on it (usesDevspace), so that a Start shows that window instead of
   * opening a second one.
   */
  private async otherWindowOf(devspaceId: string): Promise<WindowStatus | undefined> {
    return (await this.otherActiveWindowsKnown()).find((window) => usesDevspace(window, devspaceId));
  }

  /**
   * Whether another active window is connected to the devspace (see otherActiveWindowsKnown), also one that works
   * without Devspaces on it (WindowStatus.plainDevspaceId): it answers the request of a hand-off as well.
   */
  private async connectedInOtherWindow(devspaceId: string): Promise<boolean> {
    return (await this.otherActiveWindowsKnown()).some((window) => usesDevspace(window, devspaceId));
  }

  /**
   * The other active windows. When their files cannot be read, it is not known whether another window uses the
   * devspace, so the operation is refused (UserFacingError, otherWindowsUnknown) and nothing is stopped, removed, or
   * renamed; never "no other window".
   */
  private async otherActiveWindowsKnown(): Promise<WindowStatus[]> {
    try {
      return await this.deps.coordinator.otherActiveWindows();
    } catch (error) {
      this.logger.warn(`The other windows could not be read, so nothing is changed: ${errorMessage(error)}`);
      throw new UserFacingError('startFailed', ControllerTexts.otherWindowsUnknown, errorMessage(error));
    }
  }

  /** Another window is connected to the devspace: it closes its connection first. */
  private async confirmOtherWindow(repository: string, action: string): Promise<boolean> {
    const choice = await showWarningMessage(
      ControllerTexts.otherWindowClosesConnection(repository),
      { modal: true },
      action,
    );
    return choice === action;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Targets and pickers

  /**
   * The target of a command: the row of the sidebar, the devspace of the status bar item, or (from the Command
   * Palette) a Quick Pick. The devspace is read from the registry again: the row may be older than the registry.
   */
  private async resolveTarget(argument: CommandArgument, pick: PickKind, placeholder: string): Promise<Target | undefined> {
    const target = await this.resolveTargetOfAnyAccount(argument, pick, placeholder);
    // Show on GitHub needs no devspace; every other command refuses a named devspace of another account. A
    // repository has only the devspace of the signed-in account, so it is never refused.
    if (!target || pick === 'gitHub') return target;
    return this.ownTarget(target);
  }

  /**
   * The target, when its devspace (if any) belongs to an account of Devspaces, with that account. Asks for a sign-in
   * when the target has a devspace and Devspaces uses no account. A devspace of an account that Devspaces does not use
   * (only a devspace that the command names: a row or the status bar item from before a sign-out, never the devspace of
   * a repository) is used only after a sign-in of its owner (askForOwner); `undefined` otherwise.
   */
  private async ownTarget(target: Target): Promise<Target | undefined> {
    const devspace = target.devspace;
    if (!devspace) return target;
    const owner = ownerAmong(devspace, await this.requireAccounts());
    if (owner) return { ...target, account: owner };
    this.logger.info(`The devspace ${devspace.id} belongs to a GitHub account that Devspaces does not use. It is used only after a sign-in of that account.`);
    const signedIn = await this.askForOwner(this.shownName(target), devspace, undefined);
    return signedIn?.kind === 'owner' ? { ...target, account: signedIn.account } : undefined;
  }

  /**
   * Rule 2 of accountChoice.ts: the devspace `devspace` belongs to an account that Devspaces does not use. A modal
   * question offers Sign In as <login> (when its login is known) and, with `other`, New Devspace as <other login>.
   * Returns the owner after its sign-in, `other` for a new devspace, or `undefined` (Cancel, or the sign-in did not end
   * with the owner; told).
   */
  private async askForOwner(
    shown: string,
    devspace: Devspace,
    other: GitHubAccount | undefined,
  ): Promise<{ kind: 'owner'; account: GitHubAccount } | { kind: 'other'; account: GitHubAccount } | undefined> {
    const login = nonEmpty(devspace.owner.login);
    const signIn = login !== undefined ? ControllerTexts.signInAs(login) : undefined;
    const create = other !== undefined ? ControllerTexts.newDevspaceAs(other.login) : undefined;
    if (signIn === undefined && create === undefined) {
      this.warn(Messages.otherAccount(shown));
      return undefined;
    }
    const choice = await showWarningMessage(
      ControllerTexts.hiddenOwnerQuestion(shown, login),
      { modal: true, detail: ControllerTexts.hiddenOwnerDetail(login, other?.login) },
      ...[signIn, create].filter((item): item is string => item !== undefined),
    );
    if (choice === undefined) return undefined;
    if (choice === create && other !== undefined) {
      this.logger.info(`The Start of ${shown} creates a new devspace of ${other.login}; the devspace of ${login ?? devspace.owner.id} stays.`);
      return { kind: 'other', account: other };
    }
    const account = await this.deps.auth.getAccount({ interactive: true, account: devspace.owner }).catch(() => undefined);
    if (account === undefined || account.id !== devspace.owner.id) {
      this.logger.info(`${login ?? devspace.owner.id} did not sign in, so the devspace of ${shown} is not used.`);
      this.warn(Messages.otherAccount(shown, login));
      return undefined;
    }
    return { kind: 'owner', account };
  }

  /** The accounts of Devspaces (auth.ts), in the order of their logins; empty without one, or when they cannot be read. Never a dialog. */
  private async readAccounts(): Promise<GitHubAccount[]> {
    try {
      return await this.deps.auth.accounts();
    } catch (error) {
      this.logger.warn(`The GitHub accounts could not be read: ${errorMessage(error)}`);
      return [];
    }
  }

  /**
   * The accounts of Devspaces; without one, the sign-in of VS Code first (the account that the user picks there). Throws
   * signInRequired when there is still none.
   */
  private async requireAccounts(): Promise<GitHubAccount[]> {
    const accounts = await this.readAccounts();
    if (accounts.length > 0) return accounts;
    const account = await this.deps.auth.getAccount({ interactive: true }).catch((error: unknown) => {
      this.logger.warn(`The GitHub account could not be read: ${errorMessage(error)}`);
      return undefined;
    });
    if (!account) throw new UserFacingError('signInRequired', Messages.signInRequired);
    return [account];
  }

  private async resolveTargetOfAnyAccount(argument: CommandArgument, pick: PickKind, placeholder: string): Promise<Target | undefined> {
    const { registry, sidebar } = this.deps;
    // Show on GitHub needs neither a devspace nor a sign-in; Start chooses the account of a new devspace.
    const signIn = pick === 'gitHub' ? false : pick === 'open' || pick === 'repository' ? 'start' : true;
    switch (argument.kind) {
      case 'row': {
        const info = sidebar.repositoryInfo(argument.repository) ?? argument.info;
        // The devspace of the row while it exists; otherwise (a row without devspace, or one deleted meanwhile)
        // the devspace of the source of the row of an account of Devspaces.
        const named = argument.devspaceId !== undefined ? await registry.get(argument.devspaceId) : undefined;
        if (named) return { repository: argument.repository, info, devspace: named, named: true, source: sourceOf(named) };
        const target = await this.repositoryTargetFor(argument.repository, signIn, argument.source);
        return target && { ...target, info: target.info ?? info };
      }
      case 'devspace': {
        const devspace = await registry.get(argument.devspaceId);
        if (!devspace) {
          this.inform(PipelineTexts.devspaceMissing);
          return undefined;
        }
        return this.devspaceTarget(devspace);
      }
      case 'none': {
        if (pick === 'devspace') {
          const devspace = await this.pickDevspace(placeholder);
          return devspace ? this.devspaceTarget(devspace) : undefined;
        }
        let repositories = await sidebar.repositoriesForPicker();
        if (pick === 'gitHub') {
          repositories = repositories.filter((info) => sidebar.repositoryInfo(info.nameWithOwner) !== undefined);
        }
        if (repositories.length === 0) {
          this.inform(ControllerTexts.noRepositories);
          return undefined;
        }
        // The title "Open repository…" only where the pick opens the repository.
        const info = await pickRepository(repositories, placeholder, pick === 'open' ? undefined : null);
        if (!info) return undefined;
        // Show on GitHub needs the repository only: no source, no devspace.
        if (pick === 'gitHub') return { repository: info.nameWithOwner, info };
        return this.pickedRepositoryTarget(info.nameWithOwner, signIn);
      }
    }
  }

  private devspaceTarget(devspace: Devspace): Target {
    return { repository: devspace.repository, info: this.deps.sidebar.repositoryInfo(devspace.repository), devspace, named: true, source: sourceOf(devspace) };
  }

  /**
   * The target of a repository that a Quick Pick chose (the Command Palette, Search, the switcher): with one possible
   * source (possibleSources), that source; with several, the source that the user picks (sourceChoices), or
   * `undefined` when the pick is cancelled (or the question of repositoryTargetFor). `signIn` as for
   * `repositoryTargetFor`.
   */
  private async pickedRepositoryTarget(repository: string, signIn: boolean | 'start'): Promise<Target | undefined> {
    const info = this.deps.sidebar.repositoryInfo(repository);
    const own = (await this.deps.sidebar.availableDevspaces()).filter((devspace) => devspace.repository.toLowerCase() === repository.toLowerCase());
    const sources = possibleSources({ info, devspaces: own, settings: this.deps.settings() });
    if (sources.length <= 1) return this.repositoryTargetFor(repository, signIn, sources[0]);
    const picked = await vscode.window.showQuickPick(
      sourceChoices(sources, own).map((choice) => ({ label: choice.label, description: choice.description, source: choice.source })),
      { title: ControllerTexts.selectSourceTitle, placeHolder: ControllerTexts.sourcePlaceholder(info?.nameWithOwner ?? repository), matchOnDescription: true },
    );
    return picked ? this.repositoryTargetFor(repository, signIn, picked.source) : undefined;
  }

  /**
   * The target of a repository, with the account that its command uses (accountChoice.ts):
   * - rule 1: the devspace of the source of the repository on the current Docker host of an account of Devspaces (the
   *   one used last), with its owner;
   * - for a Start (`signIn` 'start') without one: rule 2, a devspace there of an account that Devspaces does not use
   *   (askForOwner; `undefined` when the user cancels), else the rules 3 to 7 for the account of a new devspace;
   * - with `options.account` (Start with Account…, a course link): the devspace of that account, else a new one of it.
   * The devspaces of accounts that Devspaces does not use neither block nor name anything for other commands. With
   * `signIn` a sign-in is asked for when Devspaces uses no account; without it, the target has no devspace then.
   * `options.candidates`: the accounts that can access the repository, when the caller asked GitHub already (a link).
   */
  private async repositoryTargetFor(
    repository: string,
    signIn: boolean | 'start',
    source?: DevspaceSource,
    options: { account?: GitHubAccount; candidates?: readonly AccountCandidate[] } = {},
  ): Promise<Target | undefined> {
    const info = this.deps.sidebar.repositoryInfo(repository);
    const accounts = signIn ? await this.requireAccounts() : await this.readAccounts();
    const dockerHost = await this.currentDockerHost();
    const base: Target = { repository, info, ...(source !== undefined ? { source } : {}) };
    const named = options.account;
    if (named !== undefined && accounts.some((account) => account.id === named.id)) {
      const devspace = await this.deps.registry.findForAccount(repository, named.id, dockerHost, source);
      return { ...base, devspace, account: named };
    }
    // The account chosen before (Try again) left Devspaces meanwhile: the rules below choose, and its devspace is one of
    // an account that Devspaces does not use (rule 2).
    if (named !== undefined) this.logger.info(`The GitHub account ${named.login} is no longer signed in to Devspaces: the account of ${repository} is chosen again.`);
    // The devspace of the source of the repository; without a source (a repository with one source that the discovery
    // does not know), its most recently used devspace.
    const entries = await this.deps.registry.list();
    const used = new Set(accounts.map((account) => account.id));
    const devspace = lastUsedDevspaceOf(entries, repository, (accountId) => used.has(accountId), dockerHost, source);
    if (devspace) return { ...base, devspace, account: ownerAmong(devspace, accounts) };
    if (signIn !== 'start') return base;
    // Also for the question of rule 2, which names the account of a new devspace.
    const chosen = chooseAccount(repository, options.candidates ?? (await this.startCandidates(repository, info, accounts)));
    const hidden = lastUsedDevspaceOf(entries, repository, (accountId) => !used.has(accountId), dockerHost, source);
    if (hidden) {
      const answer = await this.askForOwner(this.displayName({ repository, info }), hidden, chosen?.account);
      if (answer === undefined) return undefined;
      // New Devspace as <login>: Try again keeps that account (chosenAccount).
      return answer.kind === 'owner' ? { ...base, devspace: hidden, account: answer.account } : { ...base, account: answer.account, chosenAccount: true };
    }
    if (chosen && accounts.length > 1) this.logger.info(`A new devspace of ${repository} uses the GitHub account ${chosen.account.login}${chosen.permission !== undefined ? ` (${permissionText(chosen.permission)})` : ''}.`);
    return { ...base, ...(chosen ? { account: chosen.account } : {}) };
  }

  /**
   * The accounts of Devspaces that can access a repository (rule 3 of accountChoice.ts), with their permission: those
   * whose list has it; for a repository in no list, those that GitHub shows it to (with more than one account only).
   * Every account when none is found that way, so that the rules 5 to 7 still choose one (the open then reports what
   * GitHub says).
   */
  private async startCandidates(repository: string, info: RepositoryInfo | undefined, accounts: readonly GitHubAccount[]): Promise<AccountCandidate[]> {
    const listings = this.deps.sidebar.accountListings();
    const listed = listedCandidates(info, accounts, listings);
    if (listed.length > 0 || accounts.length <= 1) return listed.length > 0 ? listed : accounts.map((account) => ({ account }));
    // The accounts are asked at the same time (no dialog: a rejected token counts as no access here).
    const looked = await Promise.all(accounts.map((account) => this.lookUpRepository(repository, account)));
    const found = this.foundCandidates(accounts, looked).map((each) => each.candidate);
    return found.length > 0 ? found : accounts.map((account) => ({ account }));
  }

  /**
   * The candidates of rule 3 (accountChoice.ts) among `accounts` that GitHub showed the repository to (`looked`: the
   * lookUpRepository results, in the order of `accounts`), each with the data that its account got.
   */
  private foundCandidates(accounts: readonly GitHubAccount[], looked: readonly LookUpResult[]): Array<{ candidate: AccountCandidate; info: RepositoryInfo }> {
    const listings = this.deps.sidebar.accountListings();
    return accounts.flatMap((account, index) => {
      const info = looked[index]?.info;
      return info === undefined ? [] : [{ candidate: candidateOf(account, info.permission, listings), info }];
    });
  }

  /**
   * The target with the current registry entry (for Try again, and after a change of the devspace): a named
   * devspace while it exists, otherwise the target of the repository again (repositoryTargetFor), with the account
   * that the target chose by name (Start with Account…, a course link). `signIn` as for `repositoryTargetFor`. The
   * source stays the one of the target.
   */
  private async refreshedTarget(target: Target, signIn: boolean | 'start' = false): Promise<Target | undefined> {
    const current = target.named && target.devspace ? await this.deps.registry.get(target.devspace.id) : undefined;
    const fresh = current
      ? this.devspaceTarget(current)
      : await this.repositoryTargetFor(target.devspace?.repository ?? target.repository, signIn, target.source ?? (target.devspace ? sourceOf(target.devspace) : undefined), {
          ...(target.chosenAccount === true && target.account !== undefined ? { account: target.account } : {}),
        });
    return fresh && { ...fresh, info: fresh.info ?? target.info, ...(target.chosenAccount === true ? { chosenAccount: true } : {}) };
  }

  private requireDevspace(target: Target | undefined): Devspace | undefined {
    if (target && !target.devspace) this.inform(Messages.noDevspace(this.shownName(target)));
    return target?.devspace;
  }

  /** `owner/name` as GitHub writes it, when known. */
  private displayName(target: Target): string {
    return (
      target.info?.nameWithOwner ??
      this.deps.sidebar.repositoryInfo(target.repository)?.nameWithOwner ??
      target.devspace?.repository ??
      target.repository
    );
  }

  /**
   * The name of a target in the texts of the user, as the sidebar names it (devspaceName): its repository
   * (displayName), with the word of its source when the repository has child rows (`acme/api · default`,
   * `acme/api · config`, `acme/api · python`); the repository alone when it has one row.
   */
  private shownName(target: Target): string {
    const repository = this.displayName(target);
    const source = target.devspace ? sourceOf(target.devspace) : target.source;
    if (source === undefined) return repository;
    return devspaceName(repository, source, this.hasChildRows(target));
  }

  /**
   * Whether the sidebar shows the repository of a target with child rows: it has two or more possible sources
   * (possibleSources, as repositoryEntries of the tree model counts them) from its GitHub data, the devspaces of its
   * rows in the last render of the sidebar, the devspace of the target, and the settings.
   */
  private hasChildRows(target: Target): boolean {
    const key = target.repository.toLowerCase();
    const info = target.info ?? this.deps.sidebar.repositoryInfo(target.repository);
    const devspaces = repositoryRows(this.deps.sidebar.model())
      .filter((row) => row.repository.toLowerCase() === key || row.devspace?.repository.toLowerCase() === key)
      .flatMap((row) => (row.devspace ? [row.devspace] : []));
    if (target.devspace && !devspaces.some((devspace) => devspace.id === target.devspace?.id)) devspaces.push(target.devspace);
    return possibleSources({ info, devspaces, settings: this.deps.settings() }).length >= 2;
  }

  /**
   * The key of the operations of a target in the gate of this window (sourceOperationKey): the operations of one
   * devspace run one after the other, those of two devspaces of one repository (its sources) next to each other.
   * A target without a source (a repository with one source that the discovery does not know) has a key of its own.
   */
  private operationKey(target: Target): string {
    const repository = this.displayName(target);
    const source = target.devspace ? sourceOf(target.devspace) : target.source;
    return source !== undefined ? sourceOperationKey(repository, source) : `${repository.toLowerCase()}#`;
  }

  /** The key of the operations of a devspace (operationKey) under the name `repository`. */
  private keyOfDevspace(repository: string, devspace: Devspace): string {
    return sourceOperationKey(repository, sourceOf(devspace));
  }

  private async pickDevspace(placeholder: string): Promise<Devspace | undefined> {
    const { sidebar } = this.deps;
    const devspaces = await sidebar.availableDevspaces();
    if (devspaces.length === 0) {
      this.inform(ControllerTexts.noDevspaces);
      return undefined;
    }
    await this.renderQuietly();
    const items = recentDevspaces(sidebar.model(), devspaces).map((entry) => ({
      label: entry.state ? `$(${stateIcon(entry.state).id}) ${entry.name}` : entry.name,
      description: entry.description,
      devspaceId: entry.devspaceId,
    }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: placeholder, matchOnDescription: true });
    return picked ? devspaces.find((devspace) => devspace.id === picked.devspaceId) : undefined;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Helpers

  /**
   * Runs an operation: at most one per devspace in this window (`key`: operationKey; a second request is ignored with a
   * log line), errors are shown with the action Try again where the error offers it (errors.ts), and the sidebar is
   * updated afterwards. Refused (told, and logged) while this window removes Devspaces from an engine, and while
   * another window removes it from the engine of the operation. Returns true when the operation ran without an error.
   */
  private async operation(
    key: string,
    label: string,
    fn: () => Promise<void>,
    options: { retry?: () => Promise<void>; refused?: () => void } = {},
  ): Promise<boolean> {
    await this.ready;
    // While Devspaces is being removed from an engine, no operation of this window starts (the removal deletes the
    // devspaces in its own gate).
    if (this.refusedWhileRemoving(label)) return false;
    let removedElsewhere = false;
    try {
      const outcome = await this.gate.run(key, label, () =>
        this.withDockerTarget(async () => {
          // Nor while another window removes Devspaces from the engine of the operation: its worker would build the
          // helper image and create the volumes there again while they are removed. This also stops a Stop or a Delete,
          // which do not clear the removal mark (beforeUserFlow), and runs also when the worker of this window is open.
          if (await this.refusedWhileOtherWindowRemoves(label, (await this.operationTarget()).host)) {
            removedElsewhere = true;
            return;
          }
          await fn();
        }),
      );
      if (!outcome.started) {
        this.logger.info(`${label} of ${key} was not started: ${outcome.running} of ${key} is still running.`);
        options.refused?.();
        return false;
      }
      return !removedElsewhere;
    } catch (error) {
      this.showError(error, options.retry);
      return false;
    } finally {
      if (!this.disposed) this.background(this.deps.sidebar.refreshStates(), 'update the sidebar');
    }
  }

  /** Runs `fn` as one operation on the Docker host that is current now (DockerTargets.withOperation). */
  private withDockerTarget<T>(fn: () => Promise<T>): Promise<T> {
    return this.deps.dockerTargets ? this.deps.dockerTargets.withOperation(fn) : fn();
  }

  /**
   * Runs `fn` as one operation on the Docker host of `devspace` (DockerTargets.ofHost), whatever host Devspaces uses now:
   * a window knows its host from its devspace. An operation that runs on that host already keeps its target.
   */
  private async withHostOf<T>(devspace: Devspace, fn: () => Promise<T>): Promise<T> {
    const running = operationDockerTarget();
    if (running !== undefined && isOnDockerHost(devspace, running.host)) return fn();
    const target = await this.hostTargetOf(devspace);
    if (target === undefined) return fn();
    if (!isOnDockerHost(devspace, target.host)) this.logger.info(`The devspace ${devspace.repository} is on ${describeDockerHost(dockerHostOf(devspace))}, which is not supported now. ${unsupportedTargetReason(target)}`);
    return runWithDockerTarget(target, fn);
  }

  /**
   * The Try again of an operation on `devspace`: an operation of its own on the host of that devspace (withHostOf), not on
   * the host that Devspaces uses then. Its callback keeps the context of the failed operation, whose scope ends when that
   * operation ends, so it starts outside of it.
   */
  private retryOn(devspace: Devspace, fn: () => Promise<void>): () => Promise<void> {
    return () => outsideOperation(() => this.withHostOf(devspace, fn));
  }

  /** The target of the Docker host of `devspace` (DockerTargets.ofHost); undefined without Docker targets. */
  private async hostTargetOf(devspace: Devspace): Promise<DockerTarget | undefined> {
    return this.deps.dockerTargets?.ofHost(dockerHostOf(devspace));
  }

  /**
   * Runs the command `fn` as one operation: on the Docker host of the devspace that `argument` names (a row, the status
   * bar item; withHostOf), else on the Docker host that is current now (withDockerTarget).
   */
  private async withCommandTarget<T>(argument: CommandArgument, fn: () => Promise<T>): Promise<T> {
    const devspaceId = argument.kind === 'none' ? undefined : argument.devspaceId;
    const devspace = devspaceId === undefined ? undefined : await this.deps.registry.get(devspaceId).catch(() => undefined);
    return this.withTargetOf(devspace, fn);
  }

  /**
   * Runs `fn` as one operation on the Docker host of `devspace` (withHostOf), or on the current host when there is no
   * devspace (withDockerTarget).
   */
  private withTargetOf<T>(devspace: Devspace | undefined, fn: () => Promise<T>): Promise<T> {
    return devspace === undefined ? this.withDockerTarget(fn) : this.withHostOf(devspace, fn);
  }

  /** The Docker target of the operation (outside of one, the current one); the local Docker without dockerTargets. */
  private async operationTarget(): Promise<DockerTarget> {
    return this.deps.dockerTargets ? this.deps.dockerTargets.current() : LOCAL_DOCKER_TARGET;
  }

  /**
   * Before a Start, a Rebuild or "Update All Images Now" (`operation`) that the user started on the engine of the
   * operation: the removal mark of the engine goes (clearRemovalMark), and the question about the Monitor of that engine
   * comes (MonitorQuestion, once per engine), so the Monitor that the flow makes sure of follows the answer. False, after
   * a message, when the flow must not run: while this window removes Devspaces from an engine (refusedWhileRemoving),
   * or another window removes it from the engine of the flow, also when that removal began while the question was open;
   * the mark stays then. The mark of a removal that began and ended while the question was open goes too.
   * Nothing for a target that is neither local nor SSH (every operation refuses it), nor for a `devspace` of another
   * Docker host (its open is refused). Never throws.
   */
  private async beforeUserFlow(operation: string, devspace?: Devspace): Promise<boolean> {
    if (this.refusedWhileRemoving(operation)) return false;
    const target = await this.operationTarget();
    if (target.kind === 'unsupported' || (devspace !== undefined && !isOnDockerHost(devspace, target.host))) return true;
    if (!(await this.clearRemovalMark(operation, target.host))) return false;
    await this.deps.monitorQuestion?.askIfNeeded(target.host, () => this.markBlocker());
    // Again after the question, which can stay open for long: a removal that another window began meanwhile refuses the
    // flow while it runs, and the mark of one that ended meanwhile goes.
    return this.clearRemovalMark(operation, target.host);
  }

  /**
   * A flow of the user (`operation`) on the engine `host` after "Remove Devspaces from This Docker Engine…" there: the
   * removal mark goes, so the background work of this computer runs there again (and the question about its Monitor
   * comes again: the mark forgot the answer). False, after a message, while another window removes Devspaces from the
   * engine: checked again under the lock of the file, so that the mark of a removal that begins now stays. True
   * otherwise, also when the file cannot be read or written (logged). Never throws.
   */
  private async clearRemovalMark(operation: string, host: string): Promise<boolean> {
    const records = this.deps.engineRecords;
    if (records === undefined) return true;
    try {
      const record = await records.record(host);
      if (record?.removedAt === undefined && record?.removing === undefined) return true;
      const cleared = await records.clearRemoved(host, await this.markBlocker());
      if (cleared.other !== undefined) {
        this.refuseForOtherRemoval(operation, host, cleared.other);
        return false;
      }
      if (cleared.cleared) this.logger.info(`Devspaces is set up on ${describeDockerHost(host)} again: the removal mark is cleared.`);
    } catch (error) {
      this.logger.warn(`The removal mark of ${describeDockerHost(host)} could not be cleared: ${errorMessage(error)}`);
    }
    return true;
  }

  /** The Docker host of the operation ('' = the local Docker). */
  private async currentDockerHost(): Promise<string> {
    return this.deps.dockerTargets ? (await this.deps.dockerTargets.current()).host : '';
  }

  private showError(error: unknown, retry?: () => Promise<void>): void {
    presentError(error, { logger: this.logger, showLog: () => this.logger.show(), retry });
  }

  /** Renders the sidebar, so that pickers show current states. Never throws. */
  private async renderQuietly(): Promise<void> {
    await this.deps.sidebar
      .render()
      .catch((error: unknown) => this.logger.warn(`The sidebar could not be updated: ${errorMessage(error)}`));
  }

  private inform(message: string): void {
    showInformationMessage(message)
      .then(undefined, (error: unknown) => this.logger.error('Could not show the message.', error));
  }

  private warn(message: string): void {
    showWarningMessage(message)
      .then(undefined, (error: unknown) => this.logger.error('Could not show the message.', error));
  }

  /** A warning with "Show details", which shows the log. */
  private warnWithLog(message: string): void {
    showWarningMessage(message, Actions.showDetails).then(
      (choice) => {
        if (choice === Actions.showDetails) this.logger.show();
      },
      (error: unknown) => this.logger.error('Could not show the message.', error),
    );
  }

  private background(promise: Promise<unknown>, what: string): void {
    promise.catch((error: unknown) => this.logger.error(`Could not ${what}.`, error));
  }

  private async removeOperationQuietly(devspaceId: string): Promise<void> {
    await this.deps.sessionFiles
      .removeOperation(devspaceId)
      .catch((error: unknown) => this.logger.warn(`The pending operation could not be removed: ${errorMessage(error)}`));
  }

  private owner(): { windowId: string; pid: number } {
    return { windowId: this.deps.coordinator.windowId, pid: process.pid };
  }

  /**
   * The arguments of ConnectionAdapter.open and openInNewWindow for `devspace`: the container, the folder, and for a
   * devspace on an SSH host the Docker pipe of its window (windowDockerHost), through which the Dev Containers extension
   * reaches its engine (without it in the authority, it asks the local Docker first and reports the container as one that
   * "no longer exists"). Throws when such a devspace has no Docker pipe (no `ssh` on this computer).
   */
  private windowArgs(devspace: Devspace, containerName: string, folder: string): [containerName: string, folder: string, docker?: WindowDocker] {
    const host = dockerHostOf(devspace);
    if (host === '') return [containerName, folder];
    const pipe = this.deps.windowDockerHost?.(devspace, containerName);
    if (pipe === undefined) throw noWindowPipe(host);
    return [containerName, folder, { host: pipe }];
  }

  /**
   * The arguments that show the other window `other` of `devspace`: exactly the URI of that window, with the context or
   * the Docker host of its status file (neither for a window without one), so that VS Code finds it. The status is the
   * one read for the decision (no second read).
   */
  private otherWindowArgs(devspace: Devspace, folder: string, other: WindowStatus): [containerName: string, folder: string, docker?: WindowDocker] {
    if (dockerHostOf(devspace) === '') return [devspace.containerName, folder];
    if (other.dockerContext !== undefined) return [devspace.containerName, folder, { context: other.dockerContext }];
    if (other.dockerHost !== undefined) return [devspace.containerName, folder, { host: other.dockerHost }];
    return [devspace.containerName, folder];
  }

  /**
   * Logs which Docker the Dev Containers extension will ask when the window switches to `containerName`
   * (attachDiagnostics.ts), with the context of the running operation. A window of `devspace` with a Docker pipe
   * (windowDockerHost) gets one line instead: the Dev Containers extension asks no Docker context there, and its pipe
   * logs the Docker calls that come through it, so no inspect logs in to the host for this. A window of a devspace on
   * an SSH host without its pipe gets none: it does not connect (readyForWindow), and the inspects would describe the
   * Docker of this computer. Only log lines; never rejects.
   */
  private async logAttachDiagnostics(devspace: Devspace, containerName: string): Promise<void> {
    try {
      const host = dockerHostOf(devspace);
      const pipe = host === '' ? undefined : this.deps.windowDockerHost?.(devspace, containerName);
      if (pipe !== undefined) {
        this.logger.info(`Before the window connects: the Dev Containers extension reaches ${host} through the Docker pipe ${pipe} of the window.`);
        return;
      }
      if (host !== '' || !this.deps.docker.canRunOn(LOCAL_DOCKER_TARGET)) return;
      const context = operationDockerTarget()?.context;
      const lines = await attachDiagnostics(this.deps.docker, this.deps.docker.processEnv(), containerName, context);
      for (const line of lines) this.logger.info(`Before the window connects: ${line}`);
    } catch (error) {
      this.logger.warn(`The Docker of the attach could not be logged: ${errorMessage(error)}`);
    }
  }

  /**
   * The window connects only to a container that the Docker of the window finds running. The Dev Containers extension
   * of the window attaches through the Docker pipe in the window's authority (a devspace on an SSH host), or else
   * through the current Docker context of this computer, and reports a container that it does not find as one that "no
   * longer exists". So right before the window connects: for a local devspace, the current Docker context is still the
   * local Docker (the user or Docker Desktop may have changed it while the pipeline ran), and the container answers as
   * running (a few checks, 1 s apart, for an engine that answers late). Returns the error of the refusal, or undefined
   * when the window may connect. Stops early when `signal` aborts (the caller then reports the cancel).
   */
  private async readyForWindow(devspace: Devspace, containerName: string, signal: AbortSignal): Promise<UserFacingError | undefined> {
    const repository = this.displayName({ repository: devspace.repository });
    // A devspace on an SSH host needs the Docker pipe of its window (windowArgs).
    const host = dockerHostOf(devspace);
    if (host !== '' && this.deps.windowDockerHost?.(devspace, containerName) === undefined) {
      this.logger.warn(`${repository} is not connected: its window can get no Docker pipe for ${host}.`);
      return noWindowPipe(host);
    }
    const targets = this.deps.dockerTargets;
    if (targets && host === '') {
      // The current context itself, not the one this operation is pinned to (DOCKER_CONTEXT; ofHost reads it outside).
      const current = await targets.ofHost('');
      if (current.kind !== 'local') {
        this.logger.warn(`${repository} is not connected: the container runs on the local Docker, and ${unsupportedTargetReason(current)}`);
        return new UserFacingError('otherDockerHost', Messages.otherDockerHostAfterStart(repository, current.host));
      }
    }
    // The last state that Docker reported goes into the log (Show details).
    let state = 'not read';
    for (let attempt = 1; attempt <= READY_CHECKS; attempt++) {
      if (signal.aborted) return undefined;
      state = await this.containerStateText(devspace, containerName, signal);
      if (state === 'running') return undefined;
      if (attempt < READY_CHECKS) await this.delay(this.deps.timing?.readyPollMs ?? READY_POLL_MS, signal);
    }
    if (signal.aborted) return undefined;
    this.logger.warn(`${repository} is not connected: the container ${containerName} does not run (state: ${state}).`);
    return new UserFacingError('startFailed', Messages.containerNotReady(repository, containerName));
  }

  /** Waits `ms`; ends early when `signal` aborts, at once when it has aborted already. */
  private delay(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.timers.delete(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.timers.add(timer);
      signal?.addEventListener('abort', done, { once: true });
    });
  }
}

/** The names without repeats (compared without case and surrounding spaces), in their order. */
function uniqueNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  return names.filter((name) => {
    const key = name.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Whether the window of `status` is attached to the devspace `devspaceId`: connected to it, or working without
 * Devspaces on it on an engine with the removal mark (WindowStatus.plainDevspaceId, statusNamesDevspace).
 */
const usesDevspace = statusNamesDevspace;

/**
 * The window of a devspace on the remote host `host` can get no Docker pipe (windowDockerHost): the program of its
 * transport is missing on this computer (`ssh`, or `wsl.exe` for the WSL distribution of Devspaces), or `host` has no
 * transport that Devspaces can use.
 */
function noWindowPipe(host: string): UserFacingError {
  const access = hostAccessOf(host);
  const program = transportProgramOf(host);
  return new UserFacingError(
    'dockerHostUnreachable',
    Messages.dockerHostUnreachable(host, dockerHostReason(access === undefined ? 'unknown' : access.kind === 'wsl' ? 'wslMissing' : 'sshMissing', host)),
    access !== undefined ? `No ${program} on this computer, so the window has no Docker pipe.` : `${host} is no SSH address that Devspaces can use, so the window has no Docker pipe.`,
  );
}
