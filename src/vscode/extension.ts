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
import { addDockerFolderToPath, dockerProcessEnv, findDockerCli, findExecutable, putFolderFirstInPath } from '../core/docker/dockerCli';
import { ownDockerCliDownload, OWN_DOCKER_CLI_VERSION, presentOwnDockerCli } from '../core/docker/ownDockerCli';
import {
  WSL_LIST_ARGS,
  WSL_RUNNING_ARGS,
  describeDockerHost,
  devspacesOfHost,
  dockerHostOf,
  hostAccessOf,
  parseWslList,
  sshCommandArgs,
  wslCommandArgs,
  wslEnv,
  type DockerTarget,
} from '../core/docker/dockerHost';
import { RemovedEngineError, removedEngineImageNote, removedEngineNote } from '../core/docker/engineRemoval';
import { ensureDockerRunning } from '../core/docker/dockerStart';
import { DockerTargets, operationDockerTarget, outsideOperation, runWithDockerTarget } from '../core/docker/dockerTargets';
import { SshLoginCache, noPromptEnv, sshHostsOfContexts, startDockerFor, type RemoteReachabilityDeps } from '../core/docker/remoteDocker';
import { RelayConnectionError } from '../core/relay/connection';
import { openRelayConnection, sshHostTransport, wslHostTransport } from '../core/relay/transport';
import { RelayConnections, relayAccess } from '../core/relay/connections';
import { serveWindowPipe, windowDockerHost } from '../core/relay/windowPipe';
import { HostPipes } from '../core/relay/hostPipes';
import { RemoteShells, type RemoteShellStart } from '../core/relay/remoteShells';
import { dockerPipeBase } from '../core/relay/pipeAddress';
import { sshPromptSignal, sshPromptsAllowed } from '../core/sshAskpass';
import { DiscoveryService } from '../core/discovery/discoveryService';
import { GitHubApi } from '../core/discovery/githubApi';
import { sameScope } from '../core/discovery/scope';
import { errorMessage, UserFacingError } from '../core/errors';
import { helperImageTag, registryBaseDigest } from '../core/helper/helperImage';
import { HelperPrebuild, dockerEngineAnswers, type DockerEngineAnswersDeps } from '../core/helper/helperPrebuild';
import { MissingHelperBuild } from '../core/helper/missingHelperBuild';
import { HelperImages, helperDockerSocket } from '../core/helper/helperImages';
import { HelperChannels, openHelperChannel } from '../core/helperChannel/helperChannels';
import { HelperChannelError } from '../core/helperChannel/helperChannel';
import { Messages } from '../core/messages';
import { nodeHttpsTransport, takeUserAgentVersion } from '../core/http';
import { DockerCredentialStore } from '../core/imageCheck/credentials';
import { RegistryClient } from '../core/imageCheck/registryClient';
import { isAbortError, isoTime, systemClock, type StartedByteProcess } from '../core/ports';
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
import { WindowHeartbeats, hostEngine, resolveHeartbeatEngine } from '../core/session/windowHeartbeats';
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
import { AccountOffers } from './accountOffers';
import { VsCodeGitHubAuth, watchGitHubEnterpriseSettings } from './auth';
import { ConnectionAdapter } from './connectionAdapter';
import { installOwnDockerCliWithProgress, OwnDockerCliTexts } from './ownDockerCliWindow';
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
import { extensionFlow, extensionHostSide, type HostSideDeps } from './hostSide';
import { VsCodePipelineUi } from './pipelineUi';
import { onDidChangeBusy } from './progress';
import { SshAskpassServer, vscodeSshLoginDialogs, type SshLogin } from './sshLoginPrompts';
import { SshKeyOffer, vscodeSshKeyDialogs } from './sshKeyOffer';
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

/** Time limit of `wsl.exe --list --quiet`, which may start the WSL service; the choice of the host waits for it. */
const WSL_LIST_TIMEOUT_MS = 5_000;

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
  // The window of an attached container, also in the names of its workers (ConnectionAdapter.windowName).
  const connection = new ConnectionAdapter(logger);
  const installedCli = findDockerCli(env, platform);
  logger.info(installedCli ? `Docker CLI: ${installedCli}` : 'The Docker CLI was not found.');
  // The Docker CLI of Devspaces, one tested version (docs/architecture.md "The Docker CLI of Devspaces"), where Docker
  // publishes one that runs here. In every window, the Docker calls of Devspaces on a remote host take it when it is
  // installed, also on a computer without a Docker CLI (BootstrapDocker option ownCli); the other calls keep the Docker
  // CLI of this computer. The window of a devspace on another computer (its authority names a Docker pipe) runs the Dev
  // Containers extension with it too: its folder goes first in PATH of this extension host, before the Dev Containers
  // extension resolves the window. A CLI that this window needs and is not installed yet is downloaded below, before the
  // window looks up its devspace and serves its pipe; "Use a Remote Docker Host…" downloads it on a computer without a
  // Docker CLI.
  const pipeWindow = connection.currentDockerHost() !== undefined;
  const ownCliBuild = ownDockerCliDownload(platform, process.arch) !== undefined;
  if (pipeWindow && !ownCliBuild) {
    logger.info(`Docker publishes no Docker CLI for ${platform} on ${process.arch} that runs here, so this window uses the Docker CLI of this computer.`);
  }
  const presentOwnCli = (): string | undefined => (ownCliBuild ? presentOwnDockerCli(paths.dockerCliDir, platform, process.arch) : undefined);
  const useOwnDockerCli = (cli: string): void => {
    putFolderFirstInPath(process.env, platform, path.dirname(cli));
    logger.info(`The Docker CLI ${OWN_DOCKER_CLI_VERSION} of Devspaces is first in PATH of this window: ${cli}`);
  };
  const ownCli = pipeWindow ? presentOwnCli() : undefined;
  if (ownCli !== undefined) useOwnDockerCli(ownCli);
  const dockerPath = installedCli ?? ownCli;
  // Windows: the Dev Containers extension, which connects the windows to the containers, runs in this extension host and
  // looks up `docker` in its PATH and in C:\Program Files\Docker\Docker\resources\bin only. A CLI that Devspaces found
  // elsewhere, for example of a per-user Docker Desktop installed after VS Code (or the browser that opened a link of
  // Devspaces) started, gets its folder at the end of PATH of this extension host, so that the Dev Containers extension
  // uses the same CLI. Devspaces activates before the Dev Containers extension resolves the window of a devspace
  // (ATTACHED_CONTAINER_ACTIVATION_EVENT), and this runs before the first await of the activation (the download of the
  // Docker CLI of Devspaces comes later).
  const shareDockerFolder = (cli: string): void => {
    if (addDockerFolderToPath(process.env, platform, cli)) {
      logger.info(`The folder of the Docker CLI was added to PATH of the extension host: ${path.win32.dirname(cli)}`);
    }
  };
  if (dockerPath) shareDockerFolder(dockerPath);
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
  // The Docker pipes of the extension, one per remote host, and the shells before the relay; both set below.
  let hostPipes: HostPipes | undefined;
  let remoteShells: RemoteShells | undefined;
  // The key of Devspaces for its SSH logins (the key offer), set below; the `ssh` of the Docker CLI uses it too.
  let keyOffer: SshKeyOffer | undefined;
  // Docker Desktop installed, updated, uninstalled or moved while VS Code runs is found or lost without a reload. The
  // Docker CLI of the extension is only the bootstrap's (BootstrapDocker). Its calls of an operation on an SSH host go
  // through the Docker pipe of the extension for the host while a connection of the relay to it is open; on the WSL
  // distribution of Devspaces always through its pipe.
  const docker = new BootstrapDocker(runner, dockerPath, env, logger, platform, {
    ...adapterOptions,
    dockerPipe: (target) => hostPipes?.dockerHost(target.host),
    // The pipe of the WSL distribution listens from the first Docker call of an operation there.
    servePipe: async (target) => {
      if (hostAccessOf(target.host)?.kind === 'wsl') await hostPipes?.serve(target.host);
    },
    // A call of an operation that only reads, while the host has no pipe: on the shell before the relay of the host.
    remoteShell: (target, args, options) => remoteShells?.docker(target.host, args, options) ?? Promise.resolve(undefined),
    // A call with `ssh://<host>`: the `ssh` of the Docker CLI with the key of Devspaces when the host has it.
    sshEnv: (host, callEnv) => keyOffer?.dockerSshEnv(host, callEnv),
    // The calls of an operation on a remote host: the Docker CLI of Devspaces when it is installed.
    ownCli: presentOwnCli,
    onCliFound: shareDockerFolder,
    onDaemonStatus: (running) => {
      if (running && !daemonRunning) helperChannels?.clearFailures();
      daemonRunning = running;
      adapterOptions.onDaemonStatus?.(running);
    },
  });
  // The Docker host of Devspaces (a host of its own list, or the local Docker, which the current Docker context names),
  // read at the start of each operation.
  const remoteState = new RemoteDockerState(paths.remoteDocker, logger);
  const targets = new DockerTargets(docker, env, logger, platform, remoteState);
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
  // `wsl.exe` for the WSL distribution of Devspaces (docs/architecture.md "The WSL distribution of Devspaces"); only on
  // Windows.
  const wslPath = (): string | undefined => (platform === 'win32' ? findExecutable('wsl', env, platform) : undefined);
  /** Whether the program of the transport of the remote host `host` is found (`ssh`, or `wsl.exe` for WSL). */
  const transportFound = (host: string): boolean => {
    const access = hostAccessOf(host);
    if (access === undefined) return false;
    return (access.kind === 'wsl' ? wslPath() : sshPath()) !== undefined;
  };
  /**
   * The names that `wsl.exe` lists with `args` (WSL_LIST_ARGS, or WSL_RUNNING_ARGS); none without WSL. Without a
   * distribution (or without one that runs), `wsl.exe` says so with an exit code that is not 0: then there is none.
   * Rejects when it does not answer within WSL_LIST_TIMEOUT_MS, and with an AbortError.
   */
  const wslList = async (args: readonly string[], signal?: AbortSignal): Promise<string[]> => {
    const wsl = wslPath();
    if (wsl === undefined) return [];
    const result = await runner.run(wsl, args, { env: wslEnv(env), timeoutMs: WSL_LIST_TIMEOUT_MS, signal });
    if (result.timedOut) throw new Error(`wsl.exe ${args.join(' ')} did not answer within ${WSL_LIST_TIMEOUT_MS / 1000} seconds`);
    if (result.exitCode !== 0) {
      logger.info(`wsl.exe ${args.join(' ')} lists no distribution (exit code ${result.exitCode}): ${parseWslList(result.stderr || result.stdout).join(' ')}`);
      return [];
    }
    return parseWslList(result.stdout);
  };
  // After a login with a password in a flow of the user, Devspaces offers once per host to log in with its own key
  // (~/.ssh/devspaces_ed25519) next time; every later login of Devspaces to a host with the key uses it.
  const sshKeys = new SshKeyOffer({
    home: os.homedir(),
    platform,
    computerName: os.hostname(),
    wrapperFolder: paths.sshWrapperDir,
    runner,
    sshPath,
    sshKeygenPath: () => findExecutable('ssh-keygen', env, platform),
    env,
    state: remoteState,
    dialogs: vscodeSshKeyDialogs(),
    logger,
  });
  keyOffer = sshKeys;
  void sshKeys.prepare();
  // `ssh … docker system dial-stdio` on an SSH host, or `wsl.exe … docker system dial-stdio` in the WSL distribution,
  // for a connection of a Docker pipe without the relay. The program is found once: a window that works without the
  // relay makes many short Docker connections.
  let dialSsh: string | undefined;
  let dialWsl: string | undefined;
  const dialStdio = (host: string): StartedByteProcess | undefined => {
    const access = hostAccessOf(host);
    if (access?.kind === 'wsl') {
      dialWsl ??= wslPath();
      if (dialWsl === undefined) return undefined;
      return runner.startBytes(dialWsl, wslCommandArgs(access.distribution, ['docker', 'system', 'dial-stdio']), { env: wslEnv(env) });
    }
    dialSsh ??= sshPath();
    if (dialSsh === undefined || access === undefined) return undefined;
    return runner.startBytes(dialSsh, sshCommandArgs(access.address, 'docker system dial-stdio', undefined, { identity: sshKeys.identityFor(host) }), {
      env: noPromptEnv(env),
    });
  };
  // The connections of the relay of this window, one per remote host: its worker channel, its Docker pipe and the
  // Docker pipe of the extension for the host share it. The pipe of the extension for a host listens from the first
  // connection to the host that passed its checks until the window closes.
  const relayConnections = new RelayConnections({ logger, onUse: (host) => void hostPipes?.serve(host) });
  hostPipes = new HostPipes({
    logger,
    platform,
    base: () => dockerPipeBase(env, os.tmpdir()),
    relayConnection: (host) => relayConnections.get(host),
    dialStdio,
  });
  // The questions of the SSH logins of the flows of the user in VS Code (a password, a host key): the helper of
  // SSH_ASKPASS and the pipe that it asks, prepared in the background. Every other login asks nothing (BatchMode).
  const askpass = new SshAskpassServer({
    folder: paths.askpassDir,
    platform,
    nodePath: process.execPath,
    base: () => dockerPipeBase(env, os.tmpdir()),
    dialogs: vscodeSshLoginDialogs(),
    logger,
  });
  context.subscriptions.push(askpass);
  void askpass.prepare();
  /**
   * A new login `ssh … sh -s` to `host` (sshHostTransport), for a shell before the relay or a connection of the relay.
   * Within a flow of the user (withSshPrompts), it may ask in VS Code until the Cancel of the flow; its questions end
   * with its process. With the key of Devspaces when the host has it; after a login that asked for the password, the key
   * offer runs on the shell (SshKeyOffer.afterLogin). For the WSL distribution of Devspaces `wsl.exe … sh -s`
   * (wslHostTransport), which asks nothing. Undefined without the program of the transport and for a host that has
   * none (hostAccessOf).
   */
  const startLogin = (host: string): RemoteShellStart | undefined => {
    const access = hostAccessOf(host);
    if (access?.kind === 'wsl') {
      const wsl = wslPath();
      if (wsl === undefined) return undefined;
      const transport = wslHostTransport(access.distribution, wsl, env);
      return { process: runner.startBytes(transport.file, transport.args, { env: transport.env }) };
    }
    const ssh = sshPath();
    if (ssh === undefined) return undefined;
    const login: SshLogin | undefined = sshPromptsAllowed() ? askpass.login(host, sshPromptSignal()) : undefined;
    const transport = sshHostTransport(host, ssh, env, { prompts: login, identity: sshKeys.identityFor(host) });
    if (transport === undefined) {
      login?.dispose();
      return undefined;
    }
    const process = runner.startBytes(transport.file, transport.args, { env: transport.env });
    if (login !== undefined) void process.exited.then(() => login.dispose());
    return { process, prompts: login, afterLogin: login === undefined ? undefined : (shell) => sshKeys.afterLogin(host, login, shell) };
  };
  // The shells before the relay, one per remote host: the checks before a connection of the relay run on one login,
  // which the connection then takes over (`ssh … sh -s` or `wsl.exe … sh -s`, as its transport).
  remoteShells = new RemoteShells({ logger, start: startLogin });
  const shells = remoteShells;
  // The SSH check before the Docker calls to a remote host: the login of its shell before the relay. A success counts
  // for a minute per host, and the Docker pipe of the extension for the host makes it needless while the calls go
  // through it (they start no `ssh`).
  const sshLogins = new SshLoginCache();
  const remoteDeps = (): RemoteReachabilityDeps => ({
    docker,
    runner,
    state: remoteState,
    logger,
    sshPath: sshPath(),
    env,
    sshLogins,
    viaDockerPipe: (host) => hostPipes?.dockerHost(host) !== undefined,
    shells,
    identityFor: (host) => sshKeys.identityFor(host),
  });
  // What the checks whether an engine answers need (dockerEngineAnswers): Docker is never started, a remote host gets
  // the SSH check without questions first, and a WSL distribution that does not run is not started.
  const engineAnswersDeps = (): DockerEngineAnswersDeps => ({
    daemonStatus: (s, timeoutMs) => docker.daemonStatus(s, timeoutMs),
    ssh: remoteDeps(),
    wslRunning: async (distribution, signal) => {
      try {
        return (await wslList(WSL_RUNNING_ARGS, signal)).some((name) => name.toLowerCase() === distribution.toLowerCase());
      } catch (error) {
        if (isAbortError(error)) throw error;
        logger.info(`Whether the WSL distribution ${distribution} runs is not known: ${errorMessage(error)}`);
        return false;
      }
    },
    logger,
  });
  const registry = new DevspaceRegistry(paths, systemClock, { logger });
  const needsRestore = (): Promise<boolean> => registry.needsRestore();
  const sessionFiles = new SessionFiles(paths);
  const disconnectRequests = new DisconnectRequests(paths.root);
  const auth = new VsCodeGitHubAuth(logger);
  context.subscriptions.push(auth);
  const accountOffers = new AccountOffers({ auth, state: context.globalState, logger, focused: () => vscode.window.state.focused });
  // Credential helpers (docker-credential-*) are found like the Docker CLI, also with the short PATH of the extension host.
  const credentialEnv = dockerProcessEnv(env, platform, dockerPath);
  const credentials = new DockerCredentialStore(runner, {
    env: credentialEnv,
    platform,
    homeDir: os.homedir(),
    findExecutable: (name) => findExecutable(name, credentialEnv, platform),
    logger,
  });
  // Only the logins that Docker stored on this computer: the client has no operation, so it has no GitHub account whose
  // ghcr.io login it could use (the GitHub sign-in is the ghcr.io login of the operations in the worker only).
  const registryClient = new RegistryClient(nodeHttpsTransport, credentials.provider(), logger);
  const helperDockerfile = context.asAbsolutePath(path.join('resources', 'helper', 'Dockerfile'));
  // The helper image of the bootstrap, apart from the steps of the workspace helper (the worker's).
  const helper = new HelperImages({
    docker,
    logger,
    dockerfilePath: helperDockerfile,
    // The digest of the base image is read with this registry client, with its own time limit of 5 seconds: at the
    // build of a missing tag, and by the weekly check of the maintaining ensure (the preparation of the worker for an
    // operation `open`, and the background prebuild). It asks without a login first; the credentials of this computer
    // are read only when the registry refuses that request.
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
      const built = operationDockerTarget();
      // The next worker on the engine starts in a new container of the relay, from the new image (the open connection
      // keeps its streams); every remote engine when the engine of the build is not known.
      if (built === undefined) relayConnections.retireAll();
      else if (built.kind === 'remote') relayConnections.retireAll(built.host);
      // A Stop or a Delete of a devspace that the user kept on an engine with the removal mark builds it there again.
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
        dockerEngineAnswers(target, engineAnswersDeps(), signal),
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
          // A remote engine: the worker behind the relay, on the open connection of the host, or with one login
          // (`ssh … sh -s`, or `wsl.exe … sh -s` for the WSL distribution).
          relay: (target) => {
            if (target.kind !== 'remote') return undefined;
            // An SSH host without `ssh` starts its worker with the Docker CLI (`ssh://`); the WSL distribution only
            // behind the relay, whose open then says that wsl.exe is missing.
            const access = hostAccessOf(target.host);
            if (access === undefined || (access.kind === 'ssh' && sshPath() === undefined)) return undefined;
            // The login of the shell before the relay, when its checks left one open; else a new one, which may ask
            // within a flow of the user.
            const start = () => {
              const started = startLogin(target.host);
              if (started === undefined) {
                const reason = access.kind === 'wsl' ? 'wsl.exe was not found' : 'ssh was not found';
                throw new RelayConnectionError(`The connection to ${target.host} could not be opened: ${reason}.`);
              }
              return started;
            };
            return relayAccess(relayConnections, target.host, (command, bundle) =>
              openRelayConnection(start, command, bundle, { logger, name: target.host, takeOver: () => shells.takeOver(target.host) }),
            );
          },
          runDirect: (args, options, withoutPipe) => (withoutPipe === true ? docker.runWithoutPipe(args, options) : docker.run(args, options)),
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
        relayConnections.dispose();
        shells.dispose();
        hostPipes?.dispose();
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
  // The engine of a devspace for its heartbeats and for the Docker pipe of its window (resolveHeartbeatEngine, hostEngine).
  const engineSources = {
    ofHost: (host: string) => targets.ofHost(host),
    ofContext: (name: string) => outsideOperation(() => targets.ofContext(name)),
  };
  const windowHeartbeats = new WindowHeartbeats({
    owner: () => ({ windowId: windowCoordinator?.windowId ?? '', pid: process.pid }),
    connected: () => windowCoordinator?.devspaceId ?? null,
    registry,
    settings: getSettings,
    sourceId: computerId,
    // The engine of the Docker host of the devspace, whatever host Devspaces uses now (resolveHeartbeatEngine).
    engineFor: (devspace, use) => resolveHeartbeatEngine(devspace, use, engineSources),
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
    windowDockerHost: () => connection.currentDockerHost(),
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
  const hostSideDeps: HostSideDeps = {
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
  };
  // The HostSide of the account of each operation: the extension chooses that account, never the worker.
  const workerFlow = extensionFlow(channels, () => targets.current(), (account) => extensionHostSide(hostSideDeps, account), logger);
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
    // As an operation on the current target: on an SSH host, the call goes through the connection of the relay when
    // one is open (BootstrapDocker), not with an SSH login of its own.
    dockerRunning: () => targets.withOperation(() => docker.isRunning()),
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
  // A remote host needs a Docker CLI for remote engines (the one of Devspaces or of this computer), the local Docker the
  // Docker CLI of this computer.
  context.subscriptions.push({
    dispose: targets.onDidResolve((target) => dockerHostIndicator.update(target, docker.canRunOn(target))),
  });
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
    // Devspaces uses a host of its list (as last read; onDockerHostChanged below). Without a Docker CLI for remote
    // engines, the read gives the local Docker, so the setup shows.
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
  // A change of the Docker host of Devspaces, also by another window, shows or hides the Docker setup.
  context.subscriptions.push({ dispose: targets.onDidResolve(() => setup.onDockerHostChanged()) });
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
  // "Use a Remote Docker Host…", "Use the Local Docker", the choice of the first row of the view, and the offer of the
  // SSH host of a Docker context of the user.
  const remoteDocker = new RemoteDockerCommands({
    docker,
    runner,
    targets,
    state: remoteState,
    logger,
    showLog: () => logger.show(),
    sshHosts: () => parseSshConfig(nodeSshConfigFiles, { home: os.homedir() }),
    sshPath,
    env,
    sshLogins,
    shells,
    identityFor: (host) => sshKeys.identityFor(host),
    sshEnv: (host, callEnv) => sshKeys.dockerSshEnv(host, callEnv),
    // The WSL distributions of this Windows user, for the WSL distribution of Devspaces in the choice of the host.
    wslDistributions: () => wslList(WSL_LIST_ARGS),
    devspaceCount: async (host) => devspacesOfHost(await registry.list(), host).length,
    onDidSwitch: async () => {
      await sidebar.render();
      if (view.visible) await sidebar.refreshStates();
    },
    // A computer without a Docker CLI: the Docker CLI of Devspaces for the remote host.
    installOwnCli: ownCliBuild
      ? () => installOwnDockerCliWithProgress({ folder: paths.dockerCliDir, platform, arch: process.arch, logger, fallback: undefined, failed: OwnDockerCliTexts.failedForRemoteHost })
      : undefined,
  });
  // A Docker context or DOCKER_HOST of the user that reaches a host over SSH while Devspaces uses the local Docker: its
  // host is offered once for the list (in the background; the read that found it goes on).
  context.subscriptions.push({
    dispose: targets.onDidResolve((target) => {
      remoteDocker.offerDockerContextHost(target).catch((error: unknown) => logger.error('Could not offer the host of the Docker context.', error));
    }),
  });
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
    // The Docker pipe of the window of a devspace on a remote host (docs/architecture.md "The Docker pipe").
    windowDockerHost: (devspace, shownContainer) =>
      windowDockerHost(devspace, shownContainer, {
        computerId,
        platform,
        env,
        tmpdir: os.tmpdir(),
        transportFound,
        current: connection.currentDockerHost(),
      }),
    remoteDocker,
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
          dockerEngineAnswers(target, engineAnswersDeps(), signal),
        ),
      docker,
      // The connection of the relay too: the removal removes the container of its worker next. Its calls after this log
      // in with the Docker context without a new SSH check: the connection was such a login without questions, and it
      // carried the calls of the inventory a moment before.
      closeWorker: (target) => {
        channels.close(target);
        if (target.kind === 'remote') relayConnections.close(target.host, 'Devspaces is removed from the engine');
      },
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

  // The Docker CLI of Devspaces that this window needs and does not have yet: downloaded now, with a progress notification
  // (its link Show details needs the commands above), before the window looks up its devspace and serves its pipe, and
  // before activate() returns. On a computer without a Docker CLI, the Docker calls of Devspaces and the Docker setup in
  // the sidebar take it at once.
  if (pipeWindow && ownCliBuild && ownCli === undefined) {
    const cli = await installOwnDockerCliWithProgress({ folder: paths.dockerCliDir, platform, arch: process.arch, logger, fallback: installedCli });
    if (cli !== undefined) {
      useOwnDockerCli(cli);
      if (installedCli === undefined) {
        docker.lookUpCliNow();
        dockerSetup?.checkCli();
      }
    }
  }

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
    ? await findWindowDevspace(containerName, { registry, needsRestore, docker, current: () => targets.current(), service, logger, mayRestore })
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
  // The Docker pipe in the authority of this window (docs/architecture.md "The Docker pipe"): served before activate()
  // returns, because the Dev Containers extension reaches the engine of the devspace through it once VS Code resolves
  // the authority; and before the session starts, so that a window whose pipe is refused is never the window of its
  // devspace in its status file.
  let pipeRefused: string | undefined;
  const pipeHost = connection.currentDockerHost();
  if (pipeHost !== undefined && containerName) {
    const served = await serveWindowPipe(pipeHost, containerName, windowDevspace, {
      logger,
      platform,
      computerId,
      // The hosts of the list of Devspaces, and the SSH hosts of the Docker contexts of the user.
      knownHosts: async () => {
        const [listed, contexts] = await Promise.all([remoteState.remoteHosts(), sshHostsOfContexts(docker).catch(() => [])]);
        return [...new Set([...listed, ...contexts.map((entry) => entry.host)])];
      },
      engineRemoved: (host) => engineRemoved({ host }),
      openRelayConnection: (host) => relayConnections.get(host),
      relayConnection: async (host) => {
        // The worker of the engine opens the connection, whatever host Devspaces uses now.
        const target = await hostEngine(host, engineSources);
        if (target === undefined) throw new Error(`${host} is no remote Docker host`);
        await channels.ensure(target);
        const opened = relayConnections.get(host);
        if (opened === undefined) throw new Error(`the worker on ${host} runs without the connection of the relay`);
        return opened;
      },
      dialStdio,
    });
    // Closed at once when the window closes (the release of deactivate() does not use it), so that the extension host of
    // the window after a reload can serve the address.
    if (served.kind === 'served') context.subscriptions.push({ dispose: () => served.pipe.close() });
    if (served.kind === 'refused' && labeled.kind !== 'unreadable') pipeRefused = served.reason;
  }

  // Writes the window status file and cleans up the storage folder. Its result is the pending connection file of this
  // window's devspace, which the first status write removes (role A).
  const started = sessionCoordinator.start(onRemovedEngine || pipeRefused !== undefined ? null : (currentDevspace?.id ?? null));
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
      // An offer of a GitHub account that waited for the focus of this window.
      if (state.focused) background(accountOffers.onFocused(), 'offer the GitHub accounts of VS Code');
      if (!state.focused || !focusThrottle.tryAcquire()) return;
      background(view.visible ? sidebar.refreshStates() : sidebar.render(), 'update the sidebar');
    }),
    auth.onDidChangeSession(() => {
      // A window of a devspace of an account that signed out closes; the view shows the lists of the accounts now.
      background(controller.onSessionChanged(), 'check the devspace of this window after the account change');
      background(sidebar.onSessionChanged(), 'update the sign-in state');
      // A GitHub account of VS Code that Devspaces does not use yet is offered once.
      background(accountOffers.check(), 'offer the GitHub accounts of VS Code');
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
  // A GitHub account of VS Code that Devspaces does not use yet is offered once (not before the stored list shows).
  background(listed.then(() => accountOffers.check()), 'offer the GitHub accounts of VS Code');
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
      dockerEngineAnswers(target, engineAnswersDeps(), signal),
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

  if (currentDevspace && containerName && docker.isInstalled() && !onRemovedEngine && connection.currentDockerHost() === undefined) {
    // Which Docker the Dev Containers extension asks when it resolves this window. Only for a devspace of this
    // extension, and not for a window whose authority names a Docker host: its Docker pipe logs the Docker calls that
    // come through it, and serveWindowPipe logged any other address. Its context: the one in the authority of this
    // window (a window of a remote devspace of the versions that made a Docker context for each host), through which
    // the Dev Containers extension attaches; else the current context, which a window of a local devspace uses.
    const own = connection.currentDockerContext();
    const logDocker = async (): Promise<void> => {
      const lines = await attachDiagnostics(docker, docker.processEnv(), containerName, own);
      for (const line of lines) logger.info(`While this window connects: ${line}`);
    };
    background(logDocker(), 'log the Docker of this window');
  }

  // Without its Docker pipe, the window must not connect. The window of a container whose owner cannot be read leaves
  // below, after the token left the container.
  if (pipeRefused !== undefined && containerName) {
    await started;
    await controller.leaveWithoutDockerPipe(containerName, pipeRefused);
    return;
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
