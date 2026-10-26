// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The HostSide of this computer, which answers the requests of a flow that runs in the worker (hostSideHandler; the
// worker is the deputy of this computer). It is the only place where those requests reach VS Code, the registry, the
// session files and the sign-ins; the flow itself has none of them.
import type { DevspaceRegistry } from '../core/storage/registry';
import type { SessionFiles } from '../core/storage/sessionFiles';
import type { GitHubAuth, Logger, PipelineUi } from '../core/ports';
import { credentialServerName } from '../core/imageCheck/reference';
import type { DockerCredentialStore } from '../core/imageCheck/credentials';
import { GITHUB_PACKAGES_REGISTRY, IDENTITY_TOKEN_USER } from '../core/imageCheck/credentials';
import { FLOW_REQUESTS, VIEWER_TIMEOUT_MS, type HostSide } from '../core/worker/hostSide';
import { registryBusyMarks, type BusyMarkView } from '../core/pipeline/busyMarks';
import { requestOpenRecords, type OpenRequestScope, type OpenRequests } from '../core/worker/openRequests';
import { isoTime, type Clock } from '../core/ports';
import { hostSideHandler } from '../core/worker/hostSideHandler';
import type { HelperChannels } from '../core/helperChannel/helperChannels';
import type { DockerTarget } from '../core/docker/dockerHost';
import { errorMessage } from '../core/errors';
import type { GitHubViewer } from '../core/helper/containerGit';
import type { HelperMaintenance } from '../core/helper/helperImages';
import type { LifecycleMemory } from '../core/pipeline/lifecycleMemory';
import type { ConfigCheckStore } from '../core/storage/configChecks';
import { isOnDockerHost } from '../core/docker/dockerHost';

export interface HostSideDeps {
  // `update` for the writes of the open that read the whole registry.
  registry: Pick<DevspaceRegistry, 'read' | 'get' | 'list' | 'findForAccount' | 'restore' | 'update' | 'updateDevspace' | 'remove' | 'forgetKeptVolumes'>;
  sessionFiles: Pick<
    SessionFiles,
    'readWindowStatuses' | 'readPendings' | 'writePending' | 'removePending' | 'removeOperation' | 'removeReopenOf' | 'removeDisconnectRequest'
  >;
  ui: PipelineUi;
  auth: Pick<GitHubAuth, 'getToken' | 'getPackagesCredentials' | 'getAccount'>;
  /** The registry logins that Docker stored on this computer (DockerCredentialStore.getForPull). */
  credentials: Pick<DockerCredentialStore, 'getForPull'>;
  /** The window of this computer (its id, for the pending files that a flow writes). */
  windowId: string;
  /** The extension host of this window (its process id), for the busy marks of a flow. */
  pid: number;
  /** The clock of the busy marks. */
  clock: Clock;
  isProcessAlive: (pid: number) => boolean;
  /** The GitHub profile of a token (DiscoveryService.viewer); without it, `local viewer` answers none. */
  viewer?: (token: string, signal?: AbortSignal) => Promise<GitHubViewer>;
  /** The memory of this window, which its own pipeline uses too. */
  lifecycleMemory: LifecycleMemory;
  /**
   * The remembered check results of the configurations (in the global storage folder of the extension); without it, the
   * open has none and stores none.
   */
  configChecks?: Pick<ConfigCheckStore, 'get' | 'set' | 'remove'>;
  logger: Logger;
}

/** What a flow in the worker may ask this computer for. */
export function extensionHostSide(deps: HostSideDeps): HostSide {
  // The same busy marks as the pipeline of this window sets itself.
  const markView: BusyMarkView = {
    owner: { windowId: deps.windowId, pid: deps.pid },
    clock: deps.clock,
    isAlive: (pid) => deps.isProcessAlive(pid),
    windowStatuses: () => deps.sessionFiles.readWindowStatuses(),
    logger: deps.logger,
  };
  const busyMarks = registryBusyMarks(deps.registry, markView);
  // The registry writes of the open for a request of the worker, with the owner, clock and view of the windows of this
  // window, only on an entry of the account signed in here (read now, never the worker's) on the Docker host of the
  // operation (`scope`, from the handler).
  const openRequests = async (scope: OpenRequestScope | undefined): Promise<OpenRequests> => {
    if (scope === undefined) throw new Error('The registry write of the open names no Docker host of its operation.');
    const account = await deps.auth.getAccount({ interactive: false });
    if (account === undefined) throw new Error('No GitHub account is signed in in this window.');
    return requestOpenRecords(deps.registry, markView, { account: { id: account.id, login: account.login }, dockerHost: scope.dockerHost });
  };
  // The remembered check result only of an entry of the account signed in here (read now, never the worker's) on the
  // Docker host of the operation (`scope`, from the handler), as the registry writes of the open.
  const configCheckEntry = async (devspaceId: string, scope: OpenRequestScope | undefined): Promise<boolean> => {
    if (scope === undefined) throw new Error('The check result of the open names no Docker host of its operation.');
    const account = await deps.auth.getAccount({ interactive: false });
    if (account === undefined) throw new Error('No GitHub account is signed in in this window.');
    const entry = await deps.registry.get(devspaceId);
    return entry !== undefined && entry.owner.id === account.id && isOnDockerHost(entry, scope.dockerHost);
  };
  return {
    questions: {
      confirmUntrustedRepository: (repository) => deps.ui.confirmUntrustedRepository(repository),
      configurationChanged: (repository, what) => deps.ui.configurationChanged(repository, what),
      configurationKindChanged: (repository, message) => deps.ui.configurationKindChanged(repository, message),
      filesMissing: (repository) => deps.ui.filesMissing(repository),
      recreateContainer: (repository, question) => deps.ui.recreateContainer(repository, question),
      updateContainer: (repository, running) => deps.ui.updateContainer(repository, running),
      // The questions of Delete.
      confirmDelete: (repository, confirmation) => deps.ui.confirmDelete(repository, confirmation),
      deleteAdditionalVolumes: (volumes) => deps.ui.deleteAdditionalVolumes(volumes),
      deleteServiceData: (volumes, possibly) => deps.ui.deleteServiceData(volumes, possibly),
      message: async (kind, text) => {
        if (kind === 'info') deps.ui.info(text);
        else if (kind === 'warn') deps.ui.warn(text);
        else deps.ui.registrySignIn(text);
      },
    },
    state: {
      windowStatuses: () => deps.sessionFiles.readWindowStatuses(),
      pendings: async () => (await deps.sessionFiles.readPendings()).map((pending) => ({ ...pending })),
      processAlive: async (pid) => deps.isProcessAlive(pid),
      account: (interactive) => deps.auth.getAccount({ interactive }),
      // With the token of this window, never one of the worker; only the profile of the signed-in account.
      viewer: async () => {
        if (!deps.viewer) return undefined;
        try {
          const account = await deps.auth.getAccount({ interactive: false });
          const token = await deps.auth.getToken({ interactive: false });
          if (account === undefined || token === undefined) return undefined;
          const profile = await deps.viewer(token, AbortSignal.timeout(VIEWER_TIMEOUT_MS));
          return String(profile.databaseId) === account.id ? profile : undefined;
        } catch (error) {
          deps.logger.info(`The GitHub profile could not be read for the worker: ${errorMessage(error)}`);
          return undefined;
        }
      },
      unrecordedLifecycle: (devspaceId) => deps.lifecycleMemory.get(devspaceId),
    },
    records: {
      read: () => deps.registry.read(),
      get: (id) => deps.registry.get(id),
      list: () => deps.registry.list(),
      findForAccount: (repository, accountId, dockerHost, source) => deps.registry.findForAccount(repository, accountId, dockerHost, source),
      // The volumes of a removal are the additional volumes of the entry, never the kept volumes of another devspace
      // or account.
      remove: async (id, volumes) => {
        const own = new Set((await deps.registry.get(id))?.additionalVolumes ?? []);
        const odd = [...(volumes.kept ?? []), ...(volumes.removed ?? [])].filter((name) => !own.has(name));
        if (odd.length > 0) throw new Error(`The volumes ${odd.join(', ')} are not additional volumes of the devspace.`);
        await deps.registry.remove(id, volumes);
        // The remembered check result of the configuration goes with the devspace.
        await deps.configChecks?.remove(id).catch((error: unknown) => deps.logger.warn(`The check result of the configuration of ${id} could not be removed: ${errorMessage(error)}`));
      },
      forgetKeptVolumes: (names) => deps.registry.forgetKeptVolumes(names),
      // The memory of this window (the handler checks the devspace and the container ID).
      rememberLifecycle: (devspaceId, containerId) => deps.lifecycleMemory.remember(devspaceId, containerId),
      forgetLifecycle: (devspaceId, containerId) => deps.lifecycleMemory.forget(devspaceId, containerId),
      sessionFile: async (kind, devspaceId) => {
        if (kind === 'writePending') await deps.sessionFiles.writePending(devspaceId, deps.windowId);
        else if (kind === 'removePending') await deps.sessionFiles.removePending(devspaceId);
        else if (kind === 'removeOperation') await deps.sessionFiles.removeOperation(devspaceId);
        else if (kind === 'removeReopenOf') await deps.sessionFiles.removeReopenOf(devspaceId);
        else if (kind === 'removeDisconnectRequest') await deps.sessionFiles.removeDisconnectRequest(devspaceId);
        // A second guard behind the handler's allowlist.
        else throw new Error(`The session file request ${String(kind)} is not known.`);
      },
      markBusy: (devspaceId, operation, onReplaced) => busyMarks.mark(devspaceId, operation, onReplaced),
      clearBusy: (devspaceId) => busyMarks.clear(devspaceId),
      // The Git state that the worker read, under the registry lock.
      recordGitSummary: async (devspaceId, summary) =>
        void (await deps.registry.updateDevspace(devspaceId, (entry) => {
          entry.gitSummary = summary;
        })),
      // The entries rebuilt from the volumes, with the clock of this window.
      restore: async (entries) => {
        const now = isoTime(deps.clock);
        return deps.registry.restore(entries.map((entry) => ({ ...entry, createdAt: now, lastUsedAt: now })));
      },
      // The registry writes of the open (requestOpenRecords).
      createMark: async (devspaceId, kind, previous, scope) => (await openRequests(scope)).createMark(devspaceId, kind, previous),
      takeStepMark: async (devspaceId, operation, scope) => (await openRequests(scope)).takeStepMark(devspaceId, operation),
      releaseStepMark: async (devspaceId, mark, scope) => (await openRequests(scope)).releaseStepMark(devspaceId, mark),
      ownerLogin: async (devspaceId, scope) => (await openRequests(scope)).ownerLogin(devspaceId),
      lifecycleMark: async (devspaceId, change, scope) => (await openRequests(scope)).lifecycleMark(devspaceId, change),
      openFinished: async (devspaceId, finish, scope) => (await openRequests(scope)).openFinished(devspaceId, finish),
      // The entry of a first open, its removal, the configuration and the build records (requestOpenRecords).
      createDevspace: async (id, repository, configPath, scope, defaultImage) =>
        (await openRequests(scope)).createDevspace({ id, repository, configPath, ...(defaultImage !== undefined ? { defaultImage } : {}) }),
      dropCreated: async (devspaceId, scope) => (await openRequests(scope)).dropCreated(devspaceId),
      configuration: async (devspaceId, change, scope) => (await openRequests(scope)).configuration(devspaceId, change),
      build: async (devspaceId, change, scope) => (await openRequests(scope)).build(devspaceId, change),
      // The remembered check result of the configuration (configChecks.ts).
      configCheck: async (devspaceId, scope) => {
        if (deps.configChecks === undefined || !(await configCheckEntry(devspaceId, scope))) return undefined;
        return deps.configChecks.get(devspaceId);
      },
      rememberConfigCheck: async (devspaceId, entry, scope) => {
        if (deps.configChecks === undefined) return;
        if (!(await configCheckEntry(devspaceId, scope))) throw new Error('The devspace of the check result is not one of the signed-in account on the Docker host of the operation.');
        await deps.configChecks.set(devspaceId, entry);
      },
    },
    secrets: {
      token: async () => deps.auth.getToken({ interactive: false }),
      // The handler checked the registry and the repository, and logs the request (hostSideHandler).
      registry: async (registry) => {
        const stored = await deps.credentials.getForPull(registry);
        if (stored !== undefined) {
          const serveraddress = credentialServerName(registry);
          return stored.username === IDENTITY_TOKEN_USER
            ? { identityToken: true, serveraddress, password: stored.password, from: 'docker' }
            : { username: stored.username, serveraddress, password: stored.password, from: 'docker' };
        }
        if (registry.toLowerCase() !== GITHUB_PACKAGES_REGISTRY) return undefined;
        // The GitHub sign-in is the login of ghcr.io when Docker has none; never asked with a dialog.
        const login = await deps.auth.getPackagesCredentials({ interactive: false }).catch(() => undefined);
        return login === undefined ? undefined : { username: login.username, serveraddress: GITHUB_PACKAGES_REGISTRY, password: login.password, from: 'github' };
      },
    },
  };
}

/** The devspace of an operation, from its parameters (`devspaceId`), for SCOPED_REQUESTS. */
function devspaceOf(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null) return undefined;
  const id = (params as { devspaceId?: unknown }).devspaceId;
  return typeof id === 'string' ? id : undefined;
}

/** The Docker host of an operation, from its parameters (`dockerHost`), for `record restore`. */
function dockerHostOfParams(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null) return undefined;
  const host = (params as { dockerHost?: unknown }).dockerHost;
  return typeof host === 'string' ? host : undefined;
}

/** The name of the repository that the questions of the operation name. */
function repositoryOf(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null) return undefined;
  const repository = (params as { repository?: unknown }).repository;
  return typeof repository === 'string' ? repository : undefined;
}

/**
 * Runs the flow `op` in the worker of the current engine; the HostSide of this computer answers its requests, and only
 * those that the operation may send (FLOW_REQUESTS: one place, tested).
 */
export function extensionFlow(
  channels: Pick<HelperChannels, 'flow'>,
  current: () => Promise<DockerTarget>,
  host: HostSide,
  logger: Logger,
): (
  op: string,
  params: unknown,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    passive?: boolean;
    onAnswer?: (call: string, args: unknown[], value: unknown) => void;
    onQuestion?: (state: 'asked' | 'settled') => void;
    // The progress of the flow (the steps of the open).
    onProgress?: (step: string, detail?: string) => void;
    // The engine of the flow when it is not the current one (the heartbeats and the release of a window go to the
    // engine that the window uses the devspace on).
    target?: DockerTarget;
    // The helper image maintenance of the preparation of the worker of an operation `open`.
    helperMaintenance?: HelperMaintenance;
  },
) => Promise<unknown> {
  return async (op, params, options) =>
    channels.flow(options.target ?? (await current()), op, params, {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      // A read in the background never builds the helper image.
      ...(options.passive === true ? { passive: true } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      // Only the open passes it; the worker of the open is prepared with it (HelperChannels).
      ...(options.helperMaintenance ? { helperMaintenance: options.helperMaintenance } : {}),
      // The repository that the questions name, and the observer of the answers.
      onAsk: hostSideHandler(host, logger, Object.hasOwn(FLOW_REQUESTS, op) ? FLOW_REQUESTS[op] : [], {
        devspaceId: devspaceOf(params),
        repository: repositoryOf(params),
        dockerHost: dockerHostOfParams(params),
        ...(options.onAnswer ? { onAnswer: options.onAnswer } : {}),
        ...(options.onQuestion ? { onQuestion: options.onQuestion } : {}),
      }),
    });
}
