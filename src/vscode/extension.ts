// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Extension entry (esbuild entry of dist/extension.js): the composition root. activate() builds the components,
// registers the commands and listeners, and runs the tasks of the window role. Only the open pipeline of a restored
// window (role A) is awaited; everything else runs in the background.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { attachDiagnostics } from '../core/docker/attachDiagnostics';
import { BootstrapDocker } from '../core/docker/bootstrapDocker';
import { dockerProcessEnv, findDockerCli, findExecutable } from '../core/docker/dockerCli';
import { describeDockerHost, dockerHostOf, isOnDockerHost, type DockerTarget } from '../core/docker/dockerHost';
import { RemovedEngineError, removedEngineImageNote, removedEngineNote } from '../core/docker/engineRemoval';
import { ensureDockerRunning } from '../core/docker/dockerStart';
import { DockerTargets, operationDockerTarget, outsideOperation, runWithDockerTarget } from '../core/docker/dockerTargets';
import { SshLoginCache, findRemoteContext, startDockerFor, type RemoteReachabilityDeps } from '../core/docker/remoteDocker';
import { DiscoveryService } from '../core/discovery/discoveryService';
import { GitHubApi } from '../core/discovery/githubApi';
import { sameScope } from '../core/discovery/scope';
import { errorMessage, UserFacingError } from '../core/errors';
import { helperImageTag, registryBaseDigest } from '../core/helper/helperImage';
import { HelperPrebuild, dockerEngineAnswers } from '../core/helper/helperPrebuild';
import { MissingHelperBuild } from '../core/helper/missingHelperBuild';
import { HelperImages, helperDockerSocket } from '../core/helper/helperImages';
import { HelperChannels, openHelperChannel } from '../core/helperChannel/helperChannels';
import { HelperChannelError } from '../core/helperChannel/helperChannel';
import { Messages } from '../core/messages';
import { nodeHttpsTransport, takeUserAgentVersion } from '../core/http';
import { DockerCredentialStore, withGitHubPackagesFallback } from '../core/imageCheck/credentials';
import { RegistryClient } from '../core/imageCheck/registryClient';
import { isoTime, systemClock } from '../core/ports';
import { usableTimeZone } from '../core/remoteMonitor/cron';
import { monitorSettingsOf } from './monitorSettings';
import { REMOTE_MONITOR_VOLUME } from '../core/remoteMonitor/protocol';
import { DevspaceOperations } from '../core/pipeline/devspaceOperations';
import { windowLifecycleMemory } from '../core/pipeline/lifecycleMemory';
import type { DockerStarter } from '../core/pipeline/operationBase';
import { NodeProcessRunner } from '../core/process';
import { nodeSshConfigFiles, parseSshConfig } from '../core/sshConfig';
import { ClosingWork } from '../core/session/closingWork';
import { heartbeatWiring } from '../core/session/heartbeatWiring';
import { WindowHeartbeats, resolveHeartbeatEngine } from '../core/session/windowHeartbeats';
import { isHandedOffStop, releaseDevspace } from '../core/session/windowRelease';
import { readOrCreateComputerId } from '../core/storage/computerId';
import { DockerEngineRecords } from '../core/storage/dockerEngineRecords';
import { devspacesUsed } from '../core/storage/firstUse';
import { StoragePaths } from '../core/storage/paths';
import { ConfigCheckStore } from '../core/storage/configChecks';
import { bundleHash } from '../core/loader/pipeLoader';
import { DevspaceRegistry } from '../core/storage/registry';
import { showWarningMessage } from './notifications';
import { backgroundEngineAtStart, backgroundWorkAtStart, findWindowDevspace, removedEngineWindowDevspace, restoreAfterPrebuild, windowDevspaceName, type ContainerDevspace } from './windowDevspace';
import { workerMonitor } from './workerMonitor';
import { defaultExtensionEntries, windowVscodeServer } from './vscodeServer';
import { HELPER_DOCKER_SOCKET, VSCODE_STORE_VOLUME } from '../core/names';
import { RemoteDockerState } from '../core/storage/remoteDockerState';
import { SessionFiles } from '../core/storage/sessionFiles';
import type { ExtensionSettings } from '../core/types';
import { VsCodeGitHubAuth, ghcrRejectionReporter, watchGitHubEnterpriseSettings } from './auth';
import { ConnectionAdapter } from './connectionAdapter';
import { Controller } from './controller';
import { DisconnectRequests } from './disconnectRequests';
import { dockerAdapterOptions } from './dockerAdapterOptions';
import { DockerHostIndicator } from './dockerHostIndicator';
import { DockerSetup } from './dockerSetup';
import { MonitorQuestion } from './monitorQuestion';
import { OutputChannelLogger } from './logger';
import { updateOwnersContextKey } from './ownerSelector';
import { updateDevspacesOnlyContextKey } from './devspacesOnly';
import { isProcessAlive } from '../core/session/sessionRules';
import { extensionFlow, extensionHostSide } from './hostSide';
import { VsCodePipelineUi } from './pipelineUi';
import { onDidChangeBusy } from './progress';
import { GroupMatchWorkerRunner } from './groupMatcher';
import { PreviewWorkerRunner } from './groupsPreviewRunner';
import { RemoteDockerCommands } from './remoteDockerCommands';
import { RepositoryGroupsEditor } from './repositoryGroupsEditor';
import { SessionCoordinator } from './sessionCoordinator';
import {
  affectsSettings,
  devContainersDefaultExtensionsValue,
  readSettings,
  warnInvalidCacheUpdateSchedule,
  warnInvalidDefaultImage,
  warnInvalidHostAccessChecksOff,
} from './settings';
import { Sidebar } from './sidebar';
import { DevspaceStatusBar } from './statusBar';
import { Throttle } from './tasks';
import { REPOSITORIES_VIEW_ID, RepositoriesTreeProvider, expandAll, revealRow, type TreeNode } from './treeView';

/** A window that gets the focus refreshes the sidebar at most this often. */
const FOCUS_REFRESH_INTERVAL_MS = 15_000;

/** Kept for deactivate(). */
let coordinator: SessionCoordinator | undefined;
/**
 * The work of deactivate() (the release of the window's devspace, bounded). VS Code disposes the subscriptions right
 * after it calls deactivate(); the worker channels, the preparation of the heartbeats, and the logger are disposed only
 * after it settled (ClosingWork.deferred), so the release still has its worker, can open it again, and logs to a live
 * channel.
 */
const closingWork = new ClosingWork();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // The reopen rule measures the age of the reopen record at this time, before any await.
  const activatedAt = systemClock.now();
  const logger = new OutputChannelLogger();
  // The release of deactivate() still logs.
  context.subscriptions.push(closingWork.deferred(logger));
  // The version of the manifest for the header User-Agent of the HTTPS requests, before any request; the worker gets
  // it at its start (channelRunArgs). No bundle holds the version.
  const manifestVersion: unknown = context.extension.packageJSON?.version;
  const invalidVersion = takeUserAgentVersion(manifestVersion, 'The version in the manifest of Devspaces');
  if (invalidVersion !== undefined) logger.warn(invalidVersion);
  // Links to Devspaces wait for the end of the activation, also of one that failed (Controller.setActivation).
  let activationEnded!: () => void;
  const activation = new Promise<void>((resolve) => (activationEnded = resolve));
  try {
    await activateExtension(context, logger, activatedAt, activation);
  } catch (error) {
    logger.error('Devspaces could not be started.', error);
    throw error;
  } finally {
    activationEnded();
  }
}

/**
 * The synchronous `closing` write and the reopen record first. Then, best effort and within about 2 seconds
 * (CLOSE_RELEASE_BOUNDS), the recorded state of the repository and the short release of the window's devspace; VS
 * Code gives deactivate() little time, and a lost release leaves the long limit of the heartbeats.
 */
export function deactivate(): Promise<void> | undefined {
  // Never throws; the disposals of ClosingWork.deferred wait for this promise.
  return closingWork.begin(() => coordinator?.deactivate());
}

async function activateExtension(
  context: vscode.ExtensionContext,
  logger: OutputChannelLogger,
  activatedAt: number,
  activation: Promise<void>,
): Promise<void> {
  const platform = process.platform;
  const env = process.env;
  const paths = new StoragePaths(context.globalStorageUri.fsPath);
  try {
    paths.ensureDirectoriesSync();
  } catch (error) {
    logger.warn(`The storage folder ${paths.root} could not be created: ${errorMessage(error)}`);
  }
  let settings: ExtensionSettings = readSettings();
  const getSettings = (): ExtensionSettings => settings;
  // Invalid entries of devspaces.hostAccessChecksOff are ignored, and so is an invalid devspaces.defaultImage; in place
  // of an invalid devspaces.cacheUpdateSchedule, the Monitor uses the default: a line in the log at the start and at
  // each change of the setting, and a warning once per window session for each invalid value, until the setting has a
  // valid value again (one set of shown warnings per setting).
  const hostAccessWarnings = new Set<string>();
  const defaultImageWarnings = new Set<string>();
  const cacheScheduleWarnings = new Set<string>();
  warnInvalidHostAccessChecksOff(logger, hostAccessWarnings);
  warnInvalidDefaultImage(logger, defaultImageWarnings);
  warnInvalidCacheUpdateSchedule(logger, cacheScheduleWarnings);

  const runner = new NodeProcessRunner();
  const dockerPath = findDockerCli(env, platform);
  logger.info(dockerPath ? `Docker CLI: ${dockerPath}` : 'The Docker CLI was not found.');
  // Set below; the adapter reports each `docker info` to it (context key devspaces.dockerReady).
  let dockerSetup: DockerSetup | undefined;
  // The worker (the helper channels), set below; its failed opens are tried again at once when the Docker engine begins
  // to answer.
  let helperChannels: HelperChannels | undefined;
  // The background build of a helper image that the refresh found missing, and the sidebar that it refreshes
  // afterwards; both set below.
  let missingHelperBuild: MissingHelperBuild | undefined;
  let sidebarOfBuild: Sidebar | undefined;
  // The background prebuild of the helper image at the start, set below; "Remove Devspaces from This Docker Engine…"
  // stops it on its engine.
  let backgroundPrebuild: HelperPrebuild | undefined;
  let daemonRunning = false;
  const adapterOptions = dockerAdapterOptions(() => dockerSetup);
  // Docker Desktop installed, updated, uninstalled or moved while VS Code runs is found or lost without a reload. The
  // Docker CLI of the extension is only the bootstrap's (BootstrapDocker).
  const docker = new BootstrapDocker(runner, dockerPath, env, logger, platform, {
    ...adapterOptions,
    onDaemonStatus: (running) => {
      if (running && !daemonRunning) helperChannels?.clearFailures();
      daemonRunning = running;
      adapterOptions.onDaemonStatus?.(running);
    },
  });
  // The Docker host is the current Docker context, read at the start of each operation.
  const targets = new DockerTargets(docker, env, logger, platform);
  const remoteState = new RemoteDockerState(paths.remoteDocker);
  // What this computer remembers about each Docker engine (docker-engines.json): the answer to the question about its
  // Monitor (MonitorQuestion), and the removal mark of "Remove Devspaces from This Docker Engine…".
  const engineRecords = new DockerEngineRecords(paths.dockerEngines, { logger });
  // After "Remove Devspaces from This Docker Engine…", this computer does no Docker work on that engine by itself (no
  // worker for a passive read, no background build of the helper image, no background work at the start) until a
  // Start, a Rebuild or "Update All Images Now" of the user there clears the mark. A file that cannot be read, also after
  // the retries of a transient error, has no mark here (logged).
  const engineRemoved = async (target: Pick<DockerTarget, 'host'>): Promise<boolean> => {
    try {
      return await engineRecords.removed(target.host);
    } catch (error) {
      logger.warn(`The records of the Docker engines could not be read: ${errorMessage(error)}`);
      return false;
    }
  };
  const sshPath = (): string | undefined => findExecutable('ssh', env, platform);
  // The SSH check before the Docker calls to a remote host; a success counts for a minute per host.
  const sshLogins = new SshLoginCache();
  const remoteDeps = (): RemoteReachabilityDeps => ({ docker, runner, state: remoteState, logger, sshPath: sshPath(), env, sshLogins });
  const registry = new DevspaceRegistry(paths, systemClock, { logger });
  const needsRestore = (): Promise<boolean> => registry.needsRestore();
  const sessionFiles = new SessionFiles(paths);
  const disconnectRequests = new DisconnectRequests(paths.root);
  const auth = new VsCodeGitHubAuth(logger);
  context.subscriptions.push(auth);
  // Credential helpers (docker-credential-*) are found like the Docker CLI, also with the short PATH of the extension host.
  const credentialEnv = dockerProcessEnv(env, platform, dockerPath);
  const credentials = new DockerCredentialStore(runner, {
    env: credentialEnv,
    platform,
    homeDir: os.homedir(),
    findExecutable: (name) => findExecutable(name, credentialEnv, platform),
    logger,
  });
  // The sign-in fix: a 401 of GitHub (here the token service of ghcr.io for the GitHub session) reaches auth.ts, which
  // ignores tokens that belong to no current session (for example a token of the Docker credentials).
  const registryClient = new RegistryClient(nodeHttpsTransport, withGitHubPackagesFallback(credentials.provider(), auth), logger, {
    onCredentialsRejected: ghcrRejectionReporter(auth),
  });
  const helperDockerfile = context.asAbsolutePath(path.join('resources', 'helper', 'Dockerfile'));
  // The helper image of the bootstrap, apart from the steps of the workspace helper (the worker's).
  const helper = new HelperImages({
    docker,
    logger,
    dockerfilePath: helperDockerfile,
    // The digest of the base image is read with this registry client, with its own time limit of 5 seconds: at the
    // build of a missing tag, and by the weekly check of the maintaining ensure (the preparation of the worker for an
    // operation `open`, and the background prebuild). It asks without a login first; the credentials of this computer
    // (for ghcr.io also the GitHub sign-in) are read only when the registry refuses that request.
    statePath: paths.helperState,
    baseDigest: registryBaseDigest(registryClient),
    // The engine of the operation (its key: '' for the local Docker, else the host), without its socket, which only the
    // steps of the workspace helper read (the worker's own; the socket mount of the worker is engineSocket below).
    engine: async () => ({ key: (await targets.current()).host }),
    // A worker that could not be opened for want of the helper image is tried again at once. A build that succeeded
    // also ends the wait of the heartbeats' builds on its engine (the target of the operation that built it; every wait
    // when it is not known), in heartbeatWiring.
    onImageBuilt: () => {
      helperChannels?.clearFailures();
      heartbeats.imageBuilt();
      // A build (a Start, for example) also ends the wait after a failed background build.
      missingHelperBuild?.clearFailures();
      // A Stop or a Delete of a devspace that the user kept on an engine with the removal mark builds it there again.
      const built = operationDockerTarget();
      if (built !== undefined) void engineRemoved(built).then((removed) => (removed ? logger.info(removedEngineImageNote(describeDockerHost(built.host))) : undefined));
    },
  });
  // The preparation that a heartbeat starts (the helper image for the worker, and for a repair) runs with its own long
  // signal (HELPER_PREBUILD_TIMEOUT_MS, aborted when the window closes); the deadline of the heartbeat's attempt ends
  // only its wait, so the next attempt joins the build instead of starting it again. After a failed build for a
  // heartbeat, the next one on that engine waits 1, 2, then 5 minutes (REPAIR_BACKOFF_MS); a heartbeat within the wait
  // fails at once and counts towards the warning after failed heartbeats (HEARTBEAT_WARN_AFTER_FAILURES). Only a build
  // that started and failed starts the wait; within it a heartbeat goes on when the helper tag is present
  // (presentImage, never a build), and any successful preparation there ends it. The helper image of the worker and of
  // a repair of a heartbeat is built on its engine. This wiring (the preparation disposed with the window,
  // onImageBuilt, the worker's preparation and the repair through heartbeatHelperImage) is heartbeatWiring, tested in
  // core.
  const heartbeats = heartbeatWiring({
    helper,
    inTarget: runWithDockerTarget,
    onOutput: (text) => logger.output(text),
    operationTarget: operationDockerTarget,
    // A heartbeat prepares no worker on an engine with the removal mark (also while the removal runs there).
    engineRemoved,
    // The preparation is disposed only after the release of deactivate(), which may need to open the worker again.
    subscriptions: closingWork.deferredSubscriptions(context.subscriptions),
  });
  const heartbeatPreparation = heartbeats.preparation;
  // The worker per window and Docker engine (the helper channel, dist/helperChannel.js), local and remote. Every
  // operation runs in it; the extension sends no Docker call of its own through it. An operation makes it ready first
  // (the helper image, then the open), and is refused when that fails. Its socket mount is the one of the workspace
  // helper on that engine.
  const channelScriptPath = context.asAbsolutePath(path.join('dist', 'helperChannel.js'));
  // The source of the socket mount on the host of an engine, for the worker and the Monitor container: the
  // recorded socket of a rootless remote engine, else /var/run/docker.sock there; on the local Docker the socket of its
  // endpoint.
  const engineSocket = async (target: Pick<DockerTarget, 'kind' | 'host' | 'endpoint'>): Promise<string> =>
    target.kind === 'remote' ? ((await remoteState.rootlessSocket(target.host)) ?? HELPER_DOCKER_SOCKET) : helperDockerSocket(env, platform, target.endpoint);
  let channelScript: Promise<string> | undefined;
  const workerScript = (): Promise<string> => {
    channelScript ??= fs.promises.readFile(channelScriptPath, 'utf8');
    // A failed read is tried again at the next open.
    channelScript.catch(() => (channelScript = undefined));
    return channelScript;
  };
  // The remembered check results of the configurations, each stamped with the hash of the worker's code (the script
  // that this extension pipes into its workers), so an update forgets them.
  let workerCode: Promise<string> | undefined;
  const configChecks = new ConfigCheckStore(paths.configChecksDir, () => {
    workerCode ??= workerScript().then(bundleHash);
    workerCode.catch(() => (workerCode = undefined));
    return workerCode;
  });
  // When the refresh of the sidebar finds the helper image of an engine missing (for example after a purge of its
  // images), this window builds it in the background, once at a time per engine, and after a failure not again there
  // within 10 minutes (a Start, Stop or Delete builds it at once, as before). The build is the one of Start, Stop and
  // Delete (the preparation of their worker, `prepare` below, without the maintenance of an open: the same Dockerfile,
  // tag and privileges, and the window's shared build, which a Start at the same time joins); only when the engine
  // answers (as the background prebuild: Docker is never started, a remote host gets the SSH check without questions
  // first). Shown in the status bar; then the sidebar refreshes.
  const helperBuilds = new MissingHelperBuild({
    engineAnswers: (target, signal) =>
      runWithDockerTarget(target, () =>
        dockerEngineAnswers(target, { daemonStatus: (s, timeoutMs) => docker.daemonStatus(s, timeoutMs), ssh: remoteDeps(), logger }, signal),
      ),
    build: (target, signal) => heartbeats.prepareWorker(target, signal),
    progress: (target, work) =>
      Promise.resolve(
        vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Devspaces: preparing ${describeDockerHost(target.host)}…` }, work),
      ),
    onBuilt: () => {
      sidebarOfBuild?.refreshStates().catch((error: unknown) => logger.error('Could not update the sidebar.', error));
    },
    onChange: () => {
      sidebarOfBuild?.render().catch((error: unknown) => logger.error('Could not update the sidebar.', error));
    },
    logger,
  });
  missingHelperBuild = helperBuilds;
  // Cancelled when the window closes, after the release of deactivate() (which may join its build), as the preparations
  // of the heartbeats.
  context.subscriptions.push(closingWork.deferred({ dispose: () => helperBuilds.dispose() }));
  // The window of an attached container, also in the names of its workers (ConnectionAdapter.windowName).
  const connection = new ConnectionAdapter(logger);
  const channels = new HelperChannels({
    logger,
    // The refresh found no helper image (see helperBuilds above); never on an engine that Devspaces was removed from.
    onRefreshWithoutHelper: (target) => {
      void engineRemoved(target).then((removed) => (removed ? undefined : helperBuilds.request(target)));
    },
    // The helper image on the engine of the operation, as withDevspaceLock ensures it before the lock (only a
    // missing tag is built). For a heartbeat, with the long signal. For an operation `open`, the maintaining ensure
    // with its `maintenance` (heartbeatWiring).
    prepare: async (target, signal, maintenance) => {
      // For a heartbeat, no new build on this engine within the wait after a failed one; within it, the heartbeat goes
      // on when the tag is present (heartbeatWiring).
      await heartbeats.prepareWorker(target, signal, maintenance);
    },
    // The refresh of the sidebar only checks that the helper image is present. On an engine that Devspaces was removed
    // from, no worker starts for a passive read: its mounts would create the shared volumes again.
    checkPresent: async (target, signal) => {
      if (await engineRemoved(target)) throw new Error(removedEngineNote(describeDockerHost(target.host)));
      await runWithDockerTarget(target, () => helper.checkImagePresent({ signal }));
    },
    open: (target) =>
      openHelperChannel(
        {
          start: (args) => docker.start(args),
          runDirect: (args, options) => docker.run(args, options),
          logger,
          script: workerScript,
          helperTag: async () => helperImageTag(await fs.promises.readFile(helperDockerfile, 'utf8')),
          socketPath: engineSocket,
          // The lock files of the devspaces, in the volume of the Monitor of the engine.
          stateVolume: REMOTE_MONITOR_VOLUME,
          // The shared VS Code server store of the engine, which the worker mounts read-write.
          vscodeVolume: VSCODE_STORE_VOLUME,
          // The name of this window, or of its devspace, in the name of the worker's container.
          windowName: () => connection.windowName(),
          devspaceName: () => windowDevspaceName(connection.currentContainerName(), target.host, registry),
        },
        target,
      ),
  });
  helperChannels = channels;
  // The extension relays no Docker call through the worker (its pipeline runs there). Disposed after the release of
  // deactivate() (bounded; it never rejects), which needs the worker.
  context.subscriptions.push(
    closingWork.deferred({
      dispose: () => {
        channels.dispose();
      },
    }),
  );
  // The heartbeats, the check of a container and the Git state of a release, as operations of the worker of the engine
  // (workerFlow is set below, before the first call). Also the ensure of the Monitor container (on every
  // engine), with the settings of this computer for its background run (cacheUpdateSchedule, in its time zone); the
  // worker holds the script of the monitor and runs from the helper image.
  const monitorCalls = workerMonitor({
    flow: (op, params, options) => workerFlow(op, params, options),
    owner: () => ({ windowId: windowCoordinator?.windowId ?? '', pid: process.pid }),
    logger,
  });
  // The source of the heartbeats and the owner of a permanent Monitor (computer.id); created by the first reader, and
  // read once (each open and each repair of the heartbeats asks for it; a failed read is tried again at the next call).
  let knownComputerId: string | undefined;
  const computerId = (): string => (knownComputerId ??= readOrCreateComputerId(paths.computerId));
  // The open carries the settings of this computer for the Monitor of its engine (no image prefixes and no
  // image list): the schedule of the monitor's whole background run (cacheUpdateSchedule), and its mode, by the same
  // rule on every engine (monitorRunsPermanently: permanent once the user answered the question about the Monitor of
  // that engine, unless stopMonitorWhenIdle is on). In monitorSettings.ts, tested by its behaviour.
  const monitorSettings = monitorSettingsOf({
    settings: getSettings,
    answered: (host) => engineRecords.monitorAnswered(host),
    // An unknown zone of Node.js (`Etc/Unknown`) is UTC.
    timeZone: () => usableTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone),
    computerId,
    logger,
  });
  // The heartbeats of this window to the Monitor container of the engine of each devspace it uses, through
  // this window's worker of that engine (its operation `heartbeat`; the worker is made ready first); a missing monitor
  // is started again as the open starts it. `signal` aborts at the deadline of the heartbeat's attempt; it ends only
  // the wait for the helper image, whose build runs with the long signal of the preparation. The same wait after a
  // failed build on this engine as for the worker of a heartbeat; within it, the repair goes on with the tag when it is
  // present (heartbeatWiring.repair). The repair is the operation `monitorEnsure` of the worker of that engine.
  const repairSessionMonitor = heartbeats.repair(async (target, signal) => monitorCalls.monitorEnsure(target, await monitorSettings.forTarget(target), signal));
  // Set below (the coordinator makes the ID of this window).
  let windowCoordinator: SessionCoordinator | undefined;
  const windowHeartbeats = new WindowHeartbeats({
    owner: () => ({ windowId: windowCoordinator?.windowId ?? '', pid: process.pid }),
    connected: () => windowCoordinator?.devspaceId ?? null,
    registry,
    settings: getSettings,
    sourceId: computerId,
    // The engine of the connected devspace is the one of this window's own Docker context (its authority, which its
    // status file records as dockerContext), also for a local devspace; never the global current context when the
    // window has its own (resolveHeartbeatEngine).
    engineFor: (devspace, use) =>
      resolveHeartbeatEngine(devspace, use, {
        windowContext: (shown) => (connection.currentContainerName() === shown.containerName ? connection.currentDockerContext() : undefined),
        current: () => outsideOperation(() => targets.resolve()),
        ofContext: (name) => outsideOperation(() => targets.ofContext(name)),
        // Only an existing context; a heartbeat never creates one (a context that the user removed is not made again by
        // a tick).
        remoteContext: (host) =>
          outsideOperation(() => findRemoteContext(docker, host)).catch((error: unknown) => {
            logger.warn(`The Docker context of ${host} could not be had: ${errorMessage(error)}`);
            return undefined;
          }),
      }),
    // In the scope of a heartbeat, the worker's preparation runs with the long signal (heartbeatPreparation). The
    // operation `heartbeat` of the worker of that engine.
    send: (target, input, signal) => heartbeatPreparation.scope(() => monitorCalls.heartbeat(target, input, signal)),
    repair: repairSessionMonitor,
    // A Stop or a Delete of a devspace that the user kept on an engine with the removal mark sends its heartbeat there;
    // the Monitor is not started again.
    engineRemoved,
    // The container of the devspace (its name in the registry) on that engine; any failure counts as not there. The
    // operation `windowState` of the worker of that engine.
    containerExists: (target, devspace, signal) => heartbeatPreparation.scope(() => monitorCalls.containerExists(target, devspace, signal)),
    warn: (message) => {
      void showWarningMessage(message).then(undefined, (error: unknown) => logger.error('Could not show the message.', error));
    },
    logger,
  });
  context.subscriptions.push({ dispose: () => windowHeartbeats.dispose() });
  // One stored list per GitHub account.
  const discovery = new DiscoveryService(
    new GitHubApi(nodeHttpsTransport, logger, {
      onUnauthorized: (token) => auth.reportRejectedToken(token),
      onAuthorized: (token) => auth.reportAcceptedToken(token),
    }),
    (accountId) => paths.repositoriesFile(accountId),
    logger,
    systemClock,
    // The setting `owners` is the scan scope; GitHub is asked only about these owners.
    { scope: () => getSettings().owners },
  );
  const ui = new VsCodePipelineUi(auth, logger, () => logger.show(), systemClock, () => getSettings().updateContainer ?? 'notify');
  const sessionCoordinator = new SessionCoordinator({
    paths,
    sessionFiles,
    logger,
    settings: getSettings,
    windowDockerContext: () => connection.currentDockerContext(),
    windowHeartbeats,
    // The release of a devspace this window leaves.
    release: (devspaceId, bounds) =>
      releaseDevspace(
        {
          registry,
          settings: getSettings,
          // Status files, pending connection files, and busy marks of other windows.
          otherWindowUses: (devspace) => sessionCoordinator.otherWindowUses(devspace),
          // The Git state, read in the running dev container as its user, on the engine this window uses it on, through
          // its worker.
          recordGitState: async (devspace, signal) => {
            const target = await windowHeartbeats.connectedEngine(devspace);
            if (target === undefined) return;
            // The operation `recordGitState` of the worker of that engine.
            await heartbeatPreparation.scope(() => monitorCalls.recordGitState(target, devspace, signal));
          },
          send: (id, limitSeconds, signal) => windowHeartbeats.release(id, limitSeconds, signal),
          // A Stop that this window handed off (its pending operation `stop`) goes to the Monitor instead of
          // the release.
          stop: {
            handedOff: async (devspace) => isHandedOffStop(await sessionFiles.readOperation(devspace.id), sessionCoordinator.windowId),
            send: (id, signal) => windowHeartbeats.sendStop(id, signal),
          },
          // The last use, for Delete's note, at the start of every release.
          markSeenInUse: (devspace, at) => registry.markSeenInUse(devspace.id, at),
          logger,
        },
        devspaceId,
        bounds,
      ),
    // A window that starts connected (a reload) was seen using its devspace.
    markSeenInUse: (devspaceId, at) => registry.markSeenInUse(devspaceId, at),
  });
  windowCoordinator = sessionCoordinator;
  coordinator = sessionCoordinator;
  context.subscriptions.push(sessionCoordinator);
  // The flows that run in the worker of the current engine (the worker is the deputy of this computer), with the
  // HostSide of this computer answering their requests; one for the service (also the token removal of the controller)
  // and the calls to the Monitor. The containers that this window remembers, for its pipeline and its worker.
  const lifecycleMemory = windowLifecycleMemory();
  const workerFlow = extensionFlow(
    channels,
    () => targets.current(),
    extensionHostSide({
      registry,
      sessionFiles,
      ui,
      auth,
      credentials,
      windowId: sessionCoordinator.windowId,
      // The busy marks that a flow sets for this window, as its own pipeline sets them.
      pid: process.pid,
      clock: systemClock,
      isProcessAlive: (pid: number) => isProcessAlive(pid),
      // The profile of the account and the window's memory, for the open in the worker.
      viewer: (token, signal) => discovery.viewer(token, signal),
      lifecycleMemory,
      // The remembered check results of the configurations (this extension's storage).
      configChecks,
      logger,
    }),
    logger,
  );
  // The step "Docker start" of an operation (and of "Update All Images Now"): the local Docker is started when needed; a
  // remote host is only checked (never a Docker Desktop start).
  const startDocker: DockerStarter = async ({ onStarting, signal }) =>
    startDockerFor(
      await targets.current(),
      () => ensureDockerRunning(docker, runner, logger, { platform, env, onStarting, signal }),
      remoteDeps(),
      signal,
    );
  // The operations of this window, each a flow in the worker of the Docker target; the pipeline runs there
  // (DevspaceService), never here.
  const service = new DevspaceOperations({
    flow: workerFlow,
    registry,
    sessionFiles,
    auth,
    lifecycleMemory,
    // The refresh of the sidebar in one operation of the worker of the Docker target of the operation (outside of an
    // operation, of the current one; never read directly). Within an operation, the worker is made ready first; when it
    // cannot be, the refresh fails (never read directly).
    workerRefresh: async (devspaces) => {
      // Always through the worker, of the target of the operation or else the current one; never on an engine that
      // Devspaces was removed from (the states stay unknown there).
      const target = operationDockerTarget() ?? (await targets.current());
      if (await engineRemoved(target)) throw new RemovedEngineError(target.host);
      try {
        return await channels.refresh(target, devspaces);
      } catch (error) {
        if (!(error instanceof HelperChannelError) || error.code !== 'unavailable') throw error;
        throw new UserFacingError('helperFailed', Messages.workerUnavailable(error.message), error.message);
      }
    },
    // Whether the Docker engine of the current target answers (Stop and the refresh do nothing without it).
    dockerRunning: () => docker.isRunning(),
    // The refresh of the states asks nothing on an engine with the removal mark, also no `docker info`.
    engineRemoved: (host) => engineRemoved({ host }),
    ui,
    logger,
    clock: systemClock,
    owner: { windowId: sessionCoordinator.windowId, pid: process.pid },
    // The id of this computer in the Monitor, for the `forget` of Delete in the worker.
    monitorSource: computerId,
    settings: getSettings,
    windowStatuses: () => sessionFiles.readWindowStatuses(),
    // New devspaces record the Docker host; only its devspaces are used. An endpoint that is neither local nor
    // SSH is refused by every operation and never read.
    dockerTarget: () => targets.current(),
    // The settings that an open carries for the Monitor of its engine (the worker makes sure that the monitor
    // runs, and sends its first heartbeat). The Docker host of the open is empty for the local Docker and names the SSH
    // host otherwise. The image references in use come with it from the registry
    // (DevspaceOperations.referencesInUse); there is no image list.
    openMonitor: async (dockerHost) => ({ images: await monitorSettings.forOpen(dockerHost) }),
    // The commit and quality of this VS Code (product.json under vscode.env.appRoot, read once), which an open sends
    // when the build qualifies.
    vscodeServerOfWindow: windowVscodeServer(vscode.env.appRoot, (file) => fs.promises.readFile(file, 'utf8'), (message) => logger.info(message)),
    // The user's default extensions of the Dev Containers extension (the user settings only), which an open with a VS
    // Code server carries for the shared extension cache (read at each open).
    defaultExtensionsOfWindow: () => defaultExtensionEntries(devContainersDefaultExtensionsValue(), (message) => logger.info(message)),
    startDocker,
  });

  const tree = new RepositoriesTreeProvider(logger);
  const view = vscode.window.createTreeView<TreeNode>(REPOSITORIES_VIEW_ID, {
    treeDataProvider: tree,
    showCollapseAll: true,
  });
  const statusBar = new DevspaceStatusBar();
  context.subscriptions.push(tree, view, statusBar);
  // The view's title and its first row name the Docker host (also the local Docker).
  const dockerHostIndicator = new DockerHostIndicator(view, logger, (host) => tree.setDockerHost(host));
  context.subscriptions.push({ dispose: targets.onDidResolve((target) => dockerHostIndicator.update(target, docker.isInstalled())) });
  // While no Docker CLI is found, the sidebar shows the Docker setup (welcome view) instead of the repositories: when
  // no remote Docker host is configured and the local Docker is not available, the repositories are not shown.
  const setup = new DockerSetup({
    docker,
    runner,
    logger,
    showLog: () => logger.show(),
    platform,
    env,
    // The CLI was found or lost: the sidebar renders again and shows the repositories or the setup.
    onDidChangeInstalled: () => {
      sidebar.render().catch((error: unknown) => logger.error('Could not update the sidebar.', error));
    },
    // The current Docker context points to another computer (as last read). Without a Docker CLI no context can be
    // read, so the setup shows.
    remoteDockerHostConfigured: () => targets.last?.kind === 'remote',
    // Windows: `wsl --status` only while the view shows the setup (also onViewShown below).
    viewVisible: () => view.visible,
    // Start Docker never starts Docker Desktop for a remote host; it only checks that host.
    startDocker: async (signal, onStarting) =>
      startDockerFor(
        await targets.current(),
        () => ensureDockerRunning(docker, runner, logger, { platform, env, signal, onStarting }),
        remoteDeps(),
        signal,
      ),
  });
  dockerSetup = setup;
  context.subscriptions.push(setup);
  // The worker thread of the repository groups (the regular expressions of the setting run there, with a time limit).
  const groupsWorkerScript = context.asAbsolutePath(path.join('dist', 'groupsPreviewWorker.js'));
  const groupMatcher = new GroupMatchWorkerRunner(groupsWorkerScript);
  context.subscriptions.push({ dispose: () => groupMatcher.dispose() });
  const sidebar = new Sidebar({
    logger,
    registry,
    sessionFiles,
    coordinator: sessionCoordinator,
    service,
    docker,
    discovery,
    auth,
    tree,
    settings: getSettings,
    groupMatcher,
    dockerSetupRequired: () => setup.setupRequired,
    dockerHost: () => targets.host(),
    dockerTargets: targets,
    view,
    // The reason of a state that could not be read (the background build of the helper image).
    helperBuilds,
  });
  sidebarOfBuild = sidebar;
  setup.initialize();
  const repositoryGroupsEditor = new RepositoryGroupsEditor({
    extensionUri: context.extensionUri,
    logger,
    groupingInput: () => sidebar.groupingInput(),
    onDidRender: sidebar.onDidRender,
    previewRunner: new PreviewWorkerRunner(groupsWorkerScript),
  });
  context.subscriptions.push(repositoryGroupsEditor);
  const controller = new Controller({
    logger,
    registry,
    registryNeedsRestore: needsRestore,
    sessionFiles,
    disconnectRequests,
    docker,
    // The flows of the window, also the token removal, run in the worker of the current engine through `service` (the
    // worker is the deputy of this computer).
    service,
    discovery,
    auth,
    connection,
    coordinator: sessionCoordinator,
    sidebar,
    statusBar,
    settings: getSettings,
    dockerSetup: setup,
    repositoryGroupsEditor,
    viewVisible: () => view.visible,
    expandAll: () => expandAll(view, tree.getModel()),
    revealRow: (rowId) => revealRow(view, tree, rowId),
    development: context.extensionMode === vscode.ExtensionMode.Development,
    dockerTargets: targets,
    remoteDocker: new RemoteDockerCommands({
      docker,
      runner,
      targets,
      state: remoteState,
      logger,
      showLog: () => logger.show(),
      sshHosts: () => parseSshConfig(nodeSshConfigFiles, { home: os.homedir() }),
      sshPath,
      env,
      platform,
      sshLogins,
      onDidSwitch: async () => {
        await sidebar.render();
        if (view.visible) await sidebar.refreshStates();
      },
    }),
    // Close and Keep Running tells the Monitor at once, on every engine, and Keep Running When Closed and Stop
    // When Closed too, through this window's worker of the engine.
    sessionMonitor: {
      sendHeartbeat: (devspaceId) => windowHeartbeats.sendFor(devspaceId),
      // The stopNow heartbeat of a manual Stop.
      sendStop: (devspaceId) => windowHeartbeats.sendStop(devspaceId),
    },
    // "Update All Images Now", through this window's worker of the engine, with the monitor settings of this computer
    // for that engine (as the repair of a heartbeat).
    updateImagesNow: async (target, signal) => monitorCalls.monitorRunNow(target, await monitorSettings.forTarget(target), signal),
    // Before the request, after the question about the Monitor, the step "Docker start" of Start: Podman is refused, a
    // local Docker that does not run is started.
    startDocker,
    // The question about the Monitor of an engine, which a Start, a Rebuild and "Update All Images Now" of the user ask
    // there first (once per engine); its answer goes into the setting stopMonitorWhenIdle and the records of the engines.
    monitorQuestion: new MonitorQuestion({ records: engineRecords, settings: getSettings, logger, showLog: () => logger.show() }),
    // The removal mark of the engines, which a Start, a Rebuild and "Update All Images Now" of the user clear there.
    engineRecords,
    // "Remove Devspaces from This Docker Engine…": whether the engine answers (as for the background builds: Docker is
    // never started, a remote host gets the SSH check without questions first), the Docker CLI of the extension for the
    // inventory and the removal, the end of this window's worker there, and the ID of this computer.
    engineRemoval: {
      engineAnswers: (target, signal) =>
        runWithDockerTarget(target, () =>
          dockerEngineAnswers(target, { daemonStatus: (s, timeoutMs) => docker.daemonStatus(s, timeoutMs), ssh: remoteDeps(), logger }, signal),
        ),
      docker,
      closeWorker: (target) => channels.close(target),
      // Neither background build of the helper image makes it again after its removal.
      stopHelperBuilds: async (target) => {
        await Promise.all([backgroundPrebuild?.stop(target), helperBuilds.stop(target)]);
      },
      computerId,
    },
  });
  // A link to Devspaces, for example on a website (links.ts; the activation event onUri starts the extension for it):
  // taken at once, because VS Code keeps a link only for some minutes until an extension takes it. Controller.openLink
  // waits for the end of the activation, when this window knows its role and its devspace.
  controller.setActivation(activation);
  context.subscriptions.push(
    sidebar,
    controller,
    ...controller.registerCommands(),
    vscode.window.registerUriHandler({ handleUri: (uri) => controller.openLink(uri) }),
    controller.watchDisconnectRequests(),
    // Enter on an owner or a group opens or closes it and runs no command (Controller.rowEnter).
    view.onDidExpandElement(() => controller.nodeToggled()),
    view.onDidCollapseElement(() => controller.nodeToggled()),
    // The first load shows the repositories as they arrive.
    discovery.onPartialResult((result) => sidebar.onPartialResult(result)),
  );

  const background = (promise: Promise<unknown>, what: string): void => {
    promise.catch((error: unknown) => logger.error(`Could not ${what}.`, error));
  };

  // The devspace of this window: the container of its folder URI, if the registry knows it.
  const containerName = connection.currentContainerName();
  // Before the first use of Devspaces (no registry.json and no marker of it), the activation asks Docker nothing in the
  // background: no restore of lost devspaces, no prebuild of the helper image. The window of a devspace container does
  // both, so it finds its devspace also after the storage folder was lost (backgroundWorkAtStart).
  const startWork = backgroundWorkAtStart(await devspacesUsed(paths, logger), containerName);
  // A lost registry is restored from the current engine, through its worker: never from an engine with the removal
  // mark, which this computer asks nothing by itself (the check of the worker for a passive read refuses it there too).
  const mayRestore = startWork ? async (): Promise<boolean> => !(await engineRemoved(await targets.current())) : false;
  const currentDevspace = containerName
    ? await findWindowDevspace(containerName, { registry, needsRestore, docker, service, logger, mayRestore })
    : undefined;
  // Nothing was restored from an engine with the removal mark: the labels of the container of this window still give its
  // devspace and its owner (one plain `docker container inspect`, no worker), so that the account rule holds there too.
  const labeled: ContainerDevspace =
    containerName !== undefined && currentDevspace === undefined && startWork
      ? await removedEngineWindowDevspace(containerName, { needsRestore, docker, current: () => targets.current(), removed: engineRemoved, now: () => isoTime(systemClock), logger })
      : { kind: 'none' };
  const windowDevspace = currentDevspace ?? (labeled.kind === 'devspace' ? labeled.devspace : undefined);
  // A window of a devspace that the user kept on an engine with the removal mark ("Remove Devspaces from This Docker
  // Engine…") works without Devspaces: its heartbeats and its open would set Devspaces up there again. Its session
  // starts without the devspace, and the window stays connected as a plain container window; the account rule still
  // closes the window of a devspace that the signed-in account may not use (Controller.workWithoutDevspaces), and the
  // window of a container whose owner cannot be read (Controller.leaveUnknownOwner).
  const onRemovedEngine = labeled.kind !== 'none' || (currentDevspace !== undefined && (await engineRemoved({ host: dockerHostOf(currentDevspace) })));
  // Writes the window status file and cleans up the storage folder. Its result is the pending connection file of this
  // window's devspace, which the first status write removes (role A).
  const started = sessionCoordinator.start(onRemovedEngine ? null : (currentDevspace?.id ?? null));
  controller.setReady(started);

  const focusThrottle = new Throttle(FOCUS_REFRESH_INTERVAL_MS);
  context.subscriptions.push(
    onDidChangeBusy((change) => controller.onBusyChanged(change)),
    sessionCoordinator.onDidHeartbeat(() => {
      controller.onHeartbeat();
      // Only the coordination files; Docker is not asked in the background (Resource Saver of Docker Desktop).
      if (view.visible) background(sidebar.render(), 'update the sidebar');
    }),
    sidebar.onDidRefreshStates(() => controller.onStatesRefreshed()),
    // The name of the devspace in the status bar follows the rows of the sidebar (a changed list or setting).
    sidebar.onDidRender(() => controller.onStatesRefreshed()),
    view.onDidChangeVisibility((event) => {
      if (!event.visible) return;
      setup.onViewShown();
      background(sidebar.refreshStates(), 'update the sidebar');
    }),
    vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused || !focusThrottle.tryAcquire()) return;
      background(view.visible ? sidebar.refreshStates() : sidebar.render(), 'update the sidebar');
    }),
    auth.onDidChangeSession(() => {
      // A window of a devspace of another account closes; the view shows the list of the new account.
      background(controller.onSessionChanged(), 'check the devspace of this window after the account change');
      background(sidebar.onSessionChanged(), 'update the sign-in state');
    }),
    // GitHub rejected the token of the session, or accepted it again: the same account, so only the view changes.
    auth.onDidChangeSignInState(() => background(sidebar.onSessionChanged({ again: false }), 'update the sign-in state')),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!affectsSettings(event)) return;
      const previous = settings;
      settings = readSettings();
      warnInvalidHostAccessChecksOff(logger, hostAccessWarnings, event);
      warnInvalidDefaultImage(logger, defaultImageWarnings, event);
      warnInvalidCacheUpdateSchedule(logger, cacheScheduleWarnings, event);
      updateOwnersContextKey(settings.owners, logger);
      updateDevspacesOnlyContextKey(settings.showOnlyDevspaces === true, logger);
      // Another scan scope loads the list again at once.
      if (!sameScope(previous.owners, settings.owners)) {
        background(sidebar.onScopeChanged(), 'load the repository list of the selected organizations');
      }
      background(sidebar.render(), 'update the sidebar');
      sidebar.restartTimer();
    }),
  );

  // The icons of Select Organizations… and Show Only Devspaces in the view title bar.
  updateOwnersContextKey(settings.owners, logger);
  updateDevspacesOnlyContextKey(settings.showOnlyDevspaces === true, logger);
  // The note of the welcome view when the settings of VS Code name a GitHub Enterprise instance.
  context.subscriptions.push(watchGitHubEnterpriseSettings(logger));
  // The Docker host of the view title (every later read of the context updates it too).
  background(targets.resolve(), 'read the Docker host');
  // The stored list at once, then the background refresh.
  const listed = sidebar.initialize();
  background(listed, 'show the repository list');
  if (view.visible) {
    // The view may have become visible while the activation waited above: VS Code sends that event once, before the
    // listener existed, so the setup looks at the view here too (`wsl --status` while it shows the Docker setup).
    setup.onViewShown();
    background(sidebar.refreshStates(), 'update the sidebar');
  }
  // A lost registry is rebuilt from the volume labels (only when Docker runs, and not before the first use). A window
  // whose container the registry did not know takes its restored devspace. Neither runs on an engine that Devspaces
  // was removed from (backgroundEngineAtStart).
  const adopt = Boolean(containerName) && currentDevspace === undefined;
  const startEngine = startWork ? backgroundEngineAtStart({ current: () => targets.current(), removed: engineRemoved, logger }) : Promise.resolve(undefined);
  background(
    startEngine.then((target) => (target === undefined ? undefined : controller.reconcileIfRegistryLost({ passive: true, adopt }))),
    'restore the devspaces from the volumes',
  );
  // When helper.json does not know the current helper tag (after the installation, or an update that changed it; there
  // is no previous helper image to fall back to), the helper image is built in the background, when Docker runs and
  // Devspaces was used before (startWork; before the first use, the first Start builds it). No cross-window lock:
  // windows that start together may each build once, later ones find the record. The build (HelperImages.prebuildImage)
  // is shared with the preparation of a worker in this window (HelperImages.ensureImagePresent, ensureImageUse before
  // an open) and cancelled when the extension is deactivated.
  // With updateImagesOnConnect on, it also runs when helper.json says that the refresh of the helper image is due (the
  // rebuild that a check asked for, the weekly check), never for the daily cleanup alone; its maintaining ensure then
  // also runs the cleanup when that is due. On the Docker engine of the current Docker context, local or remote alike,
  // as an operation on it (the state file and engine key of an open there); a remote host gets our own SSH check
  // without questions before its `docker info` (dockerEngineAnswers). A host switch starts no new prebuild: the next
  // activation, or the first open on that host, builds its tag.
  const helperPrebuild = new HelperPrebuild({
    helper,
    dockerRunning: (target, signal) =>
      dockerEngineAnswers(target, { daemonStatus: (s, timeoutMs) => docker.daemonStatus(s, timeoutMs), ssh: remoteDeps(), logger }, signal),
    dockerfilePath: context.asAbsolutePath(path.join('resources', 'helper', 'Dockerfile')),
    statePath: paths.helperState,
    // The setting decides the check of the base image and the rebuild, not the cleanup.
    checkBaseImage: () => getSettings().updateImagesOnConnect,
    logger,
  });
  context.subscriptions.push(helperPrebuild);
  backgroundPrebuild = helperPrebuild;
  background(
    startEngine.then(async (target) => {
      if (target === undefined) return;
      const outcome = await helperPrebuild.start(target);
      // A lost registry is restored again once the helper image was built. A failed restore is logged as such, not as
      // a failed preparation.
      await restoreAfterPrebuild(outcome, () => controller.reconcileIfRegistryLost({ passive: false, adopt })).catch((error: unknown) =>
        logger.error('Could not restore the devspaces from the volumes after the helper image was prepared.', error),
      );
    }),
    'prepare the workspace helper image in the background',
  );

  if (currentDevspace && containerName && docker.isInstalled() && !onRemovedEngine) {
    // Which Docker the Dev Containers extension asks when it resolves this window. Only for a devspace of this
    // extension. Its context: the one in the authority of this window, through which the Dev Containers extension
    // attaches; for a window without one, the current context when that is on the host of the devspace, else none
    // for the local Docker.
    const devspace = currentDevspace;
    const logDocker = async (): Promise<void> => {
      const host = dockerHostOf(devspace);
      const own = connection.currentDockerContext();
      const current = own === undefined ? await targets.resolve() : undefined;
      const context = own ?? (current && isOnDockerHost(devspace, current.host) ? current.context : host === '' ? undefined : await findRemoteContext(docker, host));
      const lines = await attachDiagnostics(docker, docker.processEnv(), containerName, context);
      for (const line of lines) logger.info(`While this window connects: ${line}`);
    };
    background(logDocker(), 'log the Docker of this window');
  }

  if (windowDevspace && containerName) {
    // Role A: the open pipeline runs before VS Code connects this window (awaited). Assumption
    // (ATTACHED_CONTAINER_ACTIVATION_EVENT): VS Code waits for activate() before it resolves the authority.
    const pending = await started;
    // The stored list first, so that the progress and the status bar name the devspace as the sidebar shows it (with
    // the word of its source when the repository has several sources).
    await listed.catch(() => undefined);
    if (onRemovedEngine) await controller.workWithoutDevspaces(windowDevspace, containerName);
    else await controller.openAttachedWindow(windowDevspace, containerName, pending);
    return;
  }
  if (labeled.kind === 'unreadable' && containerName) {
    await started;
    await controller.leaveUnknownOwner(containerName, labeled);
    return;
  }
  background(started, 'start the window session');
  // Role B: pending operations, then the reopen rule. Role C (a local folder or another remote): nothing else.
  if (connection.isEmptyWindow()) background(controller.runEmptyWindowTasks(activatedAt), 'run the tasks of the empty window');
}
