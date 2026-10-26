// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The worker is the deputy: the core services of the pipeline as the worker constructs them for one operation.
// DevspaceService and WorkspaceHelper run as they are; what they need from the user's computer goes through the
// requests of the operation (HostSide), the engine is the worker's own (EngineDocker), the helper image is the worker's
// own image, and the lock and the batch helper are taken in the worker (`devspaceLock`, given by the operation). The
// busy marks are specific requests to the extension; so are the registry writes of the open (hostOpenRecords); the
// liveness of the processes of the computer, the GitHub profile and the window's lifecycle memory are asked of the
// extension. The open runs here (the operation `open`), with the analysis thread, the image check, the settings and the
// Monitor that its operation gives; without them, they fail closed. The records have no write by a function at
// all (DevspaceStore). The variables of the computer (`${localEnv:…}`) are never passed (localEnv.ts). Pure over its
// deps; no `vscode`.
import * as fs from 'fs';
import * as path from 'path';
import { UserFacingError, errorMessage } from '../errors';
import { DevspaceLockError, type HeldDevspaceLock } from '../docker/devspaceLock';
import type { ConfigurationAnalyzer } from '../helper/configurationAnalysis';
import { WorkspaceHelper } from '../helper/workspaceHelper';
import { ImageChecker } from '../imageCheck/imageCheck';
import { RegistryClient, type CredentialsProvider } from '../imageCheck/registryClient';
import { IDENTITY_TOKEN_USER } from '../imageCheck/credentials';
import { proxiedHttpsTransport } from '../proxyTransport';
import { LOCK_STATE_DIR, SECRET_REGISTRY, type VscodeServerRef } from '../helperChannel/protocol';
import { LABEL_VOLUME, VSCODE_STORE_DIR } from '../names';
import { Messages } from '../messages';
import { DevspaceService, devspaceOfVolume } from '../pipeline/devspaceService';
import type { DevspaceServiceDeps, DevspaceSessionMonitor, PrepareLock, VscodeExtensionCache } from '../pipeline/devspacePorts';
import type { DevspaceSessionFiles, DevspaceStore } from '../pipeline/operationBase';
import type { DevspaceBusyMarks } from '../pipeline/busyMarks';
import type { OpenRecords } from '../pipeline/openRecords';
import type { LifecycleMemory } from '../pipeline/lifecycleMemory';
import { abortError, systemClock, type GitHubAuth, type Logger, type PipelineUi } from '../ports';
import type { Devspace, ExtensionSettings } from '../types';
import type { DockerEngine } from './dockerEngine';
import { forgetRecord, sendHeartbeat } from './monitorFlow';
import { isSourceId } from '../remoteMonitor/protocol';
import { MAX_REGISTRY_ANSWERS_CHARACTERS, REGISTRY_ANSWERS_FILE, parseRegistryAnswers, type RegistryAnswers } from '../remoteMonitor/registryAnswers';
import { stopAfterSeconds } from '../session/sessionRules';
import { EngineDocker } from './engineDocker';
import type { HostSide } from './hostSide';
import type { OwnHelper } from './ownHelper';
import { ensureEngineServer, storeLock, unpackServer, type VscodeStoreDeps } from './vscodeServerStore';
import { cachedExtensionFiles, readExtensionChoices, readExtensionDependencies, recordExtensions } from './vscodeExtensionStore';
import { dependencyIds, parseExtensionEntry, seedSelection, type ExtensionRef } from '../vscodeExtensions';

/**
 * What a part of the pipeline throws when its operation did not give the worker what it needs (fail closed): only the
 * operation `open` gives the settings and the ensure of the Monitor.
 */
function notGiven(what: string): Error {
  return new Error(`The operation gives the worker no ${what}.`);
}

/**
 * DevspaceStore over the `record` requests. A write by a function cannot cross the channel (each write is a specific
 * request): the busy marks (hostBusyMarks), the entry of a first open and the other writes of the open
 * (hostOpenRecords), the Git state (`record recordGitSummary`).
 */
export function hostStore(records: HostSide['records']): DevspaceStore {
  return {
    read: () => records.read(),
    get: (id) => records.get(id),
    list: () => records.list(),
    findForAccount: (repository, accountId, dockerHost = '', source) => records.findForAccount(repository, accountId, dockerHost, source),
    remove: (id, volumes = {}) => records.remove(id, volumes),
    forgetKeptVolumes: (names) => records.forgetKeptVolumes(names),
    // The entries rebuilt from the volumes of the engine.
    restore: (entries) => records.restore(entries),
  };
}

/** DevspaceSessionFiles over the `record sessionFile` and `local pendings` requests. */
export function hostSessionFiles(host: HostSide): DevspaceSessionFiles {
  return {
    // The pending file is always the one of the window that sent the operation (the extension knows it).
    writePending: (devspaceId) => host.records.sessionFile('writePending', devspaceId),
    removePending: (devspaceId) => host.records.sessionFile('removePending', devspaceId),
    removeOperation: (devspaceId) => host.records.sessionFile('removeOperation', devspaceId),
    removeDisconnectRequest: (devspaceId) => host.records.sessionFile('removeDisconnectRequest', devspaceId),
    // The extension reads the reopen record and removes it when it names the devspace.
    removeReopenOf: (devspaceId) => host.records.sessionFile('removeReopenOf', devspaceId),
    readPendings: async () => [...(await host.state.pendings())],
  };
}

/**
 * The busy marks of the window that sent the operation, which the extension sets and clears (`record markBusy`, `record
 * clearBusy`) with its clock and its view of the windows.
 */
export function hostBusyMarks(records: HostSide['records']): DevspaceBusyMarks {
  return {
    mark: (devspaceId, operation) => records.markBusy(devspaceId, operation),
    clear: (devspaceId) => records.clearBusy(devspaceId),
  };
}

/**
 * The registry writes of the open as requests to the extension, which applies them with its owner, clock, account and
 * view of the windows (`record createMark`, `record stepMark`, `record ownerLogin`, `record lifecycleMark`, `record
 * openFinished`). The worker sends neither the account of the owner, nor the time of the last use, nor the liveness of
 * the marks: the extension takes its own. The entry of a first open (`record createDevspace`: its ID, repository and
 * configuration; the extension builds the rest), its removal (`record dropCreated`), the configuration (`record
 * configuration`) and the build records (`record build`).
 */
export function hostOpenRecords(host: HostSide): OpenRecords {
  const { records } = host;
  return {
    createDevspace: async (devspace) => {
      const entry = await records.createDevspace(devspace.id, devspace.repository, devspace.configPath, undefined, devspace.defaultImage);
      // The extension answered the devspace of the repository that another window of the account created meanwhile:
      // the open finds it and uses it (openFirst), as when the registry refuses a second one.
      if (entry.id !== devspace.id) throw new Error(`A devspace of ${devspace.repository} of the GitHub account exists already.`);
      // The open goes on with the entry as the extension recorded it (its clock, mark, owner).
      Object.assign(devspace, entry);
    },
    dropCreated: (devspaceId) => records.dropCreated(devspaceId),
    createMark: (devspaceId, kind, previous) => records.createMark(devspaceId, kind, previous),
    takeStepMark: (devspaceId, operation) => records.takeStepMark(devspaceId, operation),
    releaseStepMark: (devspaceId, mark) => records.releaseStepMark(devspaceId, mark),
    ownerLogin: (devspaceId) => records.ownerLogin(devspaceId),
    configuration: (devspaceId, change) => records.configuration(devspaceId, change),
    build: (devspaceId, change) => records.build(devspaceId, change),
    lifecycleMark: (devspaceId, change) => records.lifecycleMark(devspaceId, change),
    openFinished: (devspaceId, finish) =>
      records.openFinished(devspaceId, {
        ...(finish.lifecycleMarkRead !== undefined ? { lifecycleMarkRead: finish.lifecycleMarkRead } : {}),
        ...(finish.lifecycleRanFor !== undefined ? { lifecycleRanFor: finish.lifecycleRanFor } : {}),
        ...(finish.remoteUser !== undefined ? { remoteUser: finish.remoteUser } : {}),
        remoteWorkspaceFolder: finish.remoteWorkspaceFolder,
        ...(finish.gitSummary !== undefined ? { gitSummary: finish.gitSummary } : {}),
      }),
  };
}

/**
 * The Monitor of the worker's engine, as Delete uses it: `forget` removes the heartbeat record of `source` (the
 * computer that sent the operation) for the devspace (monitorFlow.forgetRecord). Best effort: a monitor container
 * that does not exist or does not run has no record that matters; any other failure is logged. The heartbeats of the
 * windows are their own operation (`heartbeat`). The open's ensure (`ensure`, given by the operation with its image
 * maintenance, as `monitorEnsure` does it; without it, the ensure fails closed and the open is refused) and its first
 * heartbeat for `source` with the time limit of the settings (`limitSeconds`; without the settings or the computer it
 * is not sent, which the pipeline logs). The image settings and the image references in use of the open (`images`,
 * given by the operation; without it, none).
 */
export function workerSessionMonitor(
  engine: DockerEngine,
  source: string | undefined,
  log: Logger,
  open: {
    ensure?: (signal: AbortSignal | undefined) => Promise<unknown>;
    limitSeconds?: () => number;
    images?: (signal: AbortSignal | undefined) => Promise<void>;
  } = {},
): DevspaceSessionMonitor {
  return {
    // The image settings and the image references in use of the open, given by its operation. Required by the port;
    // without them, nothing is sent.
    images: async (signal) => {
      if (open.images !== undefined) await open.images(signal);
    },
    // The worker's own helper image runs the monitor (the operation knows it); the port names no tag or image of the
    // pipeline's run.
    ensure: async (signal) => {
      if (open.ensure === undefined) throw notGiven('ensure of the Monitor (with its image maintenance)');
      await open.ensure(signal);
    },
    heartbeat: async (devspaceId, keepRunning, seq) => {
      if (source === undefined) return { ok: false, detail: 'The operation names no computer for the Monitor.' };
      // A computer ID that the monitor script would refuse is named as such.
      if (!isSourceId(source)) return { ok: false, detail: 'The computer of the operation has no valid ID for the Monitor.' };
      if (open.limitSeconds === undefined) return { ok: false, detail: 'The operation has no settings for the time limit of the heartbeat.' };
      const result = await sendHeartbeat(engine, { source, limitSeconds: open.limitSeconds(), devspaces: [{ id: devspaceId, keepRunning, seq }] });
      return result.ok ? { ok: true } : { ok: false, detail: result.detail };
    },
    forget: async (devspaceId) => {
      if (source === undefined) throw new Error('The operation names no computer for the Monitor.');
      const result = await forgetRecord(engine, source, devspaceId);
      if (!result.ok && !result.missing) log.warn(`The heartbeat record of ${devspaceId} could not be removed from the Monitor: ${result.detail}`);
    },
  };
}

/**
 * The memory of the window that sent the operation, over `local unrecordedLifecycle`, `record rememberLifecycle` and
 * `record forgetLifecycle`.
 */
export function hostLifecycleMemory(host: HostSide): LifecycleMemory {
  return {
    get: (devspaceId) => host.state.unrecordedLifecycle(devspaceId),
    remember: (devspaceId, containerId) => host.records.rememberLifecycle(devspaceId, containerId),
    forget: (devspaceId, containerId) => host.records.forgetLifecycle(devspaceId, containerId),
  };
}

/** A registry login as the operation holds it while it is used. */
export type RegistryLogin = NonNullable<Awaited<ReturnType<HostSide['secrets']['registry']>>>;

/**
 * The image or Feature whose registry needs a login: the registry host (`registry-1.docker.io` for Docker Hub) and the
 * repository, as parseImageReference normalizes them. The extension gives only the login of that registry.
 */
export interface LoginReference {
  registry: string;
  repository: string;
}

/**
 * The logins of the registries of one operation. Every login comes as the one registry secret of the operation
 * (SECRET_REGISTRY), so they are used one after the other (two logins asked at once could each read the other's): `use`
 * runs with the login of the registry of `reference` (`undefined` when the computer has none, or its request failed,
 * which is logged), and the operation forgets the secret when `use` ends, before the next login is asked.
 */
export function registryLogins(
  host: HostSide,
  forget: () => void,
  log: Logger,
): <T>(reference: LoginReference, use: (login: RegistryLogin | undefined) => Promise<T>, signal?: AbortSignal) => Promise<T> {
  let queue: Promise<unknown> = Promise.resolve();
  // `use` must not ask for a login itself (it would wait for its own turn).
  return (reference, use, signal) => {
    const previous = queue;
    const run = (async () => {
      // The wait for the turn ends with a cancel (an AbortError: a login whose user gave up is not asked); nothing was
      // asked then, so nothing is forgotten.
      await turnOf(previous, signal);
      try {
        let login: RegistryLogin | undefined;
        try {
          login = await host.secrets.registry(reference.registry, reference.repository);
        } catch (error) {
          log.warn(`The login of ${reference.registry} could not be asked: ${errorMessage(error)}`);
        }
        if (signal?.aborted) throw abortError();
        return await use(login);
      } finally {
        forget();
      }
    })();
    // The next turn waits for this one and for the one before it (a cancelled wait ends before the turn before it). The
    // queue keeps no value of a turn (a login that `use` gave back).
    queue = Promise.allSettled([previous, run]).then(() => undefined);
    return run;
  };
}

/** Resolves when `previous` settled; rejects with an AbortError when `signal` aborts first. */
function turnOf(previous: Promise<unknown>, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (signal === undefined) return previous.then(() => undefined, () => undefined);
  return new Promise((resolve, reject) => {
    const aborted = () => reject(abortError());
    signal.addEventListener('abort', aborted, { once: true });
    previous.then(
      () => (signal.removeEventListener('abort', aborted), resolve()),
      () => (signal.removeEventListener('abort', aborted), resolve()),
    );
  });
}

/**
 * The login of a registry for one use of the registry client (CredentialsProvider), through `logins` (asked when it is
 * needed, forgotten right after), for the repository of the image or Feature that needs it. An identity token is the
 * password of IDENTITY_TOKEN_USER, as the Docker credentials give it. Never throws.
 */
export function hostRegistryCredentials(logins: ReturnType<typeof registryLogins>): CredentialsProvider {
  return (registry, signal, repository) =>
    logins(
      { registry, repository },
      async (login) => (login === undefined ? undefined : { username: login.identityToken === true ? IDENTITY_TOKEN_USER : (login.username ?? ''), password: login.password }),
      signal,
    ).catch(() => undefined);
}

/**
 * The image update check of the worker (ImageChecker over a RegistryClient): HTTPS through the proxy of the daemon of
 * its engine (proxiedHttpsTransport), the logins by hostRegistryCredentials. A login is asked only when the registry
 * refused the request without one, so a public image needs none (RegistryClient). A login that a registry rejects is
 * logged; the answer without it counts.
 */
export function workerImageChecker(deps: Pick<WorkerServicesDeps, 'host' | 'engine' | 'forgetSecret' | 'logger'>, logins = registryLogins(deps.host, () => deps.forgetSecret(SECRET_REGISTRY), deps.logger)): ImageChecker {
  const transport = proxiedHttpsTransport(() => deps.engine.proxy());
  const client = new RegistryClient(transport, hostRegistryCredentials(logins), deps.logger, {
    onCredentialsRejected: (registry) => deps.logger.warn(`The registry ${registry} rejected the login of this computer.`),
  });
  return new ImageChecker(client, deps.logger);
}

/** The GitHub sign-in of the user's computer: the account through `local account`, the token through `secret token`. */
export function hostAuth(host: HostSide, log: Logger): Pick<GitHubAuth, 'getToken' | 'getAccount' | 'reportRejectedToken'> {
  return {
    getAccount: ({ interactive }) => host.state.account(interactive),
    // The worker shows no sign-in dialog; the extension made sure of the sign-in before it sent the open
    // (requireSession), so a token is asked without one either way.
    getToken: async () => host.secrets.token(),
    // The token never goes back over the channel; the report of a rejected token comes with the clone.
    reportRejectedToken: () => log.warn('GitHub rejected the token of the operation.'),
  };
}

/** PipelineUi over the `question` requests; the messages go as `question message` (they are not awaited by the pipeline). */
export function hostUi(questions: HostSide['questions'], log: Logger): PipelineUi {
  const message = (kind: 'info' | 'warn' | 'registrySignIn', text: string) => {
    questions.message(kind, text).catch((error: unknown) => log.warn(`A message for the user could not be shown: ${error instanceof Error ? error.message : String(error)}`));
  };
  return {
    confirmUntrustedRepository: (repository) => questions.confirmUntrustedRepository(repository),
    configurationChanged: (repository, what) => questions.configurationChanged(repository, what),
    configurationKindChanged: (repository, text) => questions.configurationKindChanged(repository, text),
    filesMissing: (repository) => questions.filesMissing(repository),
    recreateContainer: (repository, question) => questions.recreateContainer(repository, question),
    updateContainer: (repository, running) => questions.updateContainer(repository, running),
    // The questions of Delete.
    confirmDelete: (repository, confirmation) => questions.confirmDelete(repository, confirmation),
    deleteAdditionalVolumes: (volumes) => questions.deleteAdditionalVolumes(volumes),
    deleteServiceData: (volumes, possibly) => questions.deleteServiceData(volumes, possibly),
    info: (text) => message('info', text),
    warn: (text) => message('warn', text),
    registrySignIn: (registry) => message('registrySignIn', registry),
  };
}

/** Without the analysis thread of the worker (WorkerServicesDeps.analyzer), nothing is analyzed. */
const NO_ANALYZER: ConfigurationAnalyzer = {
  analyze: async () => {
    throw notGiven('host access analysis');
  },
};

export interface WorkerServicesDeps {
  host: HostSide;
  engine: DockerEngine;
  /** The secrets of the operation (OperationContext.secrets). */
  secretOf: (name: string) => string | undefined;
  /** Makes the operation forget the secret (OperationContext.forgetSecret). */
  forgetSecret: (name: string) => void;
  logger: Logger;
  /** The worker's own helper image and socket (readOwnHelper). */
  ownHelper: OwnHelper;
  /** The Docker host of the operation as the extension resolved it ('' for the local Docker). */
  dockerHost: string;
  /** The window that sent the operation. */
  owner: { windowId: string; pid: number };
  /** The lock of a devspace, taken in the worker (workerDevspaceLock). */
  devspaceLock: (devspaceId: string, waitSeconds: number, signal: AbortSignal | undefined) => Promise<HeldDevspaceLock>;
  /** The prepare lock of a devspace, for an open (workerPrepareLock); without it no prepare is seen. */
  prepareLock?: PrepareLock;
  /** The settings of the pipeline of an open (openSettingsOf of its parameters); a read without them fails closed. */
  settings?: ExtensionSettings;
  /** The id of the computer that sent the operation in the Monitor (Delete's `forget`). */
  monitorSource?: string;
  /**
   * The ensure of the Monitor of the worker's engine for the open (ensureWorkerMonitor, with the image
   * maintenance of the operation); without it, the ensure fails closed.
   */
  monitorEnsure?: (signal: AbortSignal | undefined) => Promise<unknown>;
  /**
   * Gives the Monitor of the worker's engine the image settings and the image references in use of the open,
   * after its ensure (best effort; never throws, except an AbortError).
   */
  monitorImages?: (signal: AbortSignal | undefined) => Promise<void>;
  /**
   * The host access analysis in the worker (its analysis thread, from the script in the worker's bundle, with its
   * limits); without it, an analysis fails closed.
   */
  analyzer?: ConfigurationAnalyzer;
  /**
   * The VS Code server of an open (OpenParams.vscodeServer). With the store of the worker (OwnHelper.vscodeStore), a
   * container that the open creates mounts the store, the open makes sure that the store has the server
   * (ensureEngineServer, started at its start), and the server is linked into the container; without either, the open
   * runs without the store.
   */
  vscodeServer?: VscodeServerRef;
  /**
   * The user's default extensions of the open (OpenParams.defaultExtensions), recorded with the configuration's
   * extensions in the shared extension cache of the store.
   */
  defaultExtensions?: string[];
  /** The folder of the Monitor's registry answers (default LOCK_STATE_DIR; for the tests). */
  registryAnswersDir?: string;
}

/**
 * The shared extension cache of the store at VSCODE_STORE_DIR for an open: its record of the extension list (with the
 * user's `defaults`, at the time of the open) and the files to seed. The record goes into the volume of the Session
 * Monitor at LOCK_STATE_DIR, which no dev container mounts; the seed prefers the files that the monitor chose, read
 * from there too, and adds the dependencies of the list that the monitor recorded there.
 */
export function workerExtensionCache(
  defaults: readonly string[] | undefined,
  folders: { store: string; state: string } = { store: VSCODE_STORE_DIR, state: LOCK_STATE_DIR },
  now: () => number = Date.now,
): VscodeExtensionCache {
  const refs = (defaults ?? []).map(parseExtensionEntry).filter((ref): ref is ExtensionRef => ref !== undefined);
  return {
    record: (devspaceId, configuration) => recordExtensions(folders.state, devspaceId, configuration, refs, now()),
    // The entries of the list, and the extensions that the server installs with them (their dependencies).
    seedFiles: async (list, platform) => {
      const withDependencies = [...list, ...dependencyIds(list, await readExtensionDependencies(folders.state)).map((id) => ({ id }))];
      return seedSelection(withDependencies, await cachedExtensionFiles(folders.store), platform, await readExtensionChoices(folders.state));
    },
  };
}

/**
 * The registry answers of the Monitor, in its volume at `stateDir` (LOCK_STATE_DIR in the worker): a regular
 * file (no link) of at most MAX_REGISTRY_ANSWERS_CHARACTERS bytes, read strictly (parseRegistryAnswers). `undefined`
 * when there is none, or it is larger, not a regular file, or not valid: the open then checks the registry itself.
 * Never throws.
 */
export async function readRegistryAnswers(stateDir: string = LOCK_STATE_DIR): Promise<RegistryAnswers | undefined> {
  const file = path.join(stateDir, REGISTRY_ANSWERS_FILE);
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_REGISTRY_ANSWERS_CHARACTERS) return undefined;
    const buffer = Buffer.alloc(MAX_REGISTRY_ANSWERS_CHARACTERS + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_REGISTRY_ANSWERS_CHARACTERS) return undefined;
    return parseRegistryAnswers(buffer.subarray(0, bytesRead).toString('utf8'));
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * What ensureServer uses in the worker: the store at VSCODE_STORE_DIR, HTTPS through the proxy of the daemon
 * (proxiedHttpsTransport), the architecture of the engine, the lock of a server version (storeLock), `tar`
 * (unpackServer), and the log of the operation.
 */
export function workerVscodeStore(deps: Pick<WorkerServicesDeps, 'engine' | 'logger'>): VscodeStoreDeps {
  return {
    root: VSCODE_STORE_DIR,
    transport: proxiedHttpsTransport(() => deps.engine.proxy()),
    architecture: (signal) => deps.engine.architecture(signal),
    lock: (root, name, waitSeconds, signal) => storeLock(root, name, waitSeconds, signal),
    unpack: (archive, folder, signal) => unpackServer(archive, folder, signal),
    logger: deps.logger,
  };
}

/**
 * What a headless prepare in the worker needs (the operation `prepare`, runPrepare): the engine, the log, the worker's
 * own helper image and the host access analysis. Nothing of a computer: no HostSide at all.
 */
export interface HeadlessServicesDeps {
  engine: DockerEngine;
  logger: Logger;
  ownHelper: OwnHelper;
  analyzer: ConfigurationAnalyzer;
  /** The folder of the Monitor's registry answers (default LOCK_STATE_DIR; for the tests). */
  registryAnswersDir?: string;
}

/**
 * The devspaces of the engine as a headless prepare knows them, without the registry of a computer: one entry per
 * workspace volume with the labels of a devspace (devspaceOfVolume, as the rebuild of a lost registry reads
 * them), with the owner of its label, on the engine of the worker. It only reads; every write throws. The host access
 * policy of the prepare checks the volumes and images of other accounts against these entries (the kept volumes of a
 * computer are not known here; the open checks again with its registry).
 */
export function engineDevspaceStore(docker: Pick<EngineDocker, 'listDevspaceVolumes'>, now: () => string = () => new Date().toISOString()): DevspaceStore {
  const devspaces = async (): Promise<Devspace[]> => {
    const at = now();
    return (await docker.listDevspaceVolumes())
      .filter((volume) => volume.labels[LABEL_VOLUME] === undefined)
      .map((volume) => devspaceOfVolume(volume, at, ''))
      .filter((entry): entry is Devspace => !('skipped' in entry));
  };
  const write = async (): Promise<never> => {
    throw notGiven('registry of a computer (a prepare writes no record)');
  };
  return {
    read: async () => ({ version: 1, devspaces: await devspaces() }),
    list: () => devspaces(),
    get: async (id) => (await devspaces()).find((entry) => entry.id === id),
    findForAccount: async () => undefined,
    remove: write,
    forgetKeptVolumes: write,
    restore: write,
  };
}

/** An object whose every method rejects (or throws) with notGiven(`what`): a part of a computer. */
function notAvailable<T extends object>(what: string): T {
  return new Proxy({} as T, {
    get: (_target, property) =>
      property === 'then'
        ? undefined
        : () => {
            throw notGiven(`${what} (${String(property)}) in a prepare`);
          },
  });
}

/** The settings of a headless prepare: the host access checks on, the image check on. */
const PREPARE_SETTINGS: ExtensionSettings = {
  reopenLastOnStartup: false,
  stopOnClose: false,
  updateImagesOnConnect: true,
  respectShutdownActionNone: false,
  owners: [],
  includeArchived: false,
  includeForks: false,
  refreshIntervalMinutes: 0,
  hostAccessChecksOff: [],
};

/**
 * The image check of a headless prepare: the RegistryClient of the worker without any login (every registry is asked
 * anonymously; a private image is answered as such and keeps the digest of its build record).
 */
export function anonymousImageChecker(deps: Pick<HeadlessServicesDeps, 'engine' | 'logger'>): ImageChecker {
  const transport = proxiedHttpsTransport(() => deps.engine.proxy());
  return new ImageChecker(new RegistryClient(transport, async () => undefined, deps.logger), deps.logger);
}

/**
 * The deps of DevspaceService for a headless prepare (DevspaceService.prepare): no request to a computer at all.
 * The engine of the worker without any secret or login (EngineDocker: anonymous pulls), the worker's own helper image,
 * the devspaces from the volumes of the engine (engineDevspaceStore), the settings of a prepare (the host access
 * checks on), the anonymous image check, the registry answers of the Monitor. Everything else of a computer
 * (the records and busy marks, the session files, the token and the account, the questions, the windows) throws when it
 * is used (notGiven), and so does the devspace lock: a prepare holds its prepare lock only (PrepareRun.takeLock). No
 * Monitor is ensured.
 */
export function headlessServiceDeps(deps: HeadlessServicesDeps): DevspaceServiceDeps & { helper: WorkspaceHelper; docker: EngineDocker } {
  const docker = new EngineDocker(deps.engine, deps.logger);
  const helper = new WorkspaceHelper({
    logger: deps.logger,
    ownImage: deps.ownHelper.image,
    socket: deps.ownHelper.socket,
    containerRuns: async (containerId, signal) => (await docker.containerState(containerId, signal)) === 'running',
  });
  const refuse = (what: string) => async (): Promise<never> => {
    throw notGiven(`${what} in a prepare`);
  };
  const store = deps.ownHelper.vscodeStore;
  return {
    ...(store !== undefined ? { vscodeStoreVolume: store } : {}),
    docker,
    helper,
    startDocker: async ({ signal }) => {
      if (!(await docker.isRunning(signal))) throw new UserFacingError('dockerEngineNotRunning', Messages.dockerEngineNotRunning, 'The engine of the worker does not answer.');
    },
    registry: engineDevspaceStore(docker),
    busyMarks: notAvailable<DevspaceBusyMarks>('busy marks'),
    openRecords: notAvailable<OpenRecords>('records of an open'),
    recordGitSummary: refuse('record of the Git state'),
    sessionFiles: notAvailable<DevspaceSessionFiles>('session files of a computer'),
    windowStatuses: refuse('windows of a computer'),
    isProcessAlive: () => {
      throw notGiven('processes of a computer in a prepare');
    },
    processAlive: refuse('processes of a computer'),
    lifecycleMemory: notAvailable<LifecycleMemory>('lifecycle memory of a window'),
    imageChecker: anonymousImageChecker(deps),
    registryAnswers: () => readRegistryAnswers(deps.registryAnswersDir),
    auth: {
      getAccount: refuse('GitHub account'),
      getToken: refuse('GitHub token'),
      reportRejectedToken: () => deps.logger.warn('A prepare has no GitHub token to reject.'),
    },
    ui: {
      confirmUntrustedRepository: refuse('question'),
      configurationChanged: refuse('question'),
      configurationKindChanged: refuse('question'),
      filesMissing: refuse('question'),
      recreateContainer: refuse('question'),
      updateContainer: refuse('question'),
      confirmDelete: refuse('question'),
      deleteAdditionalVolumes: refuse('question'),
      deleteServiceData: refuse('question'),
      // The messages of a prepare go to its log only.
      info: (text) => deps.logger.info(text),
      warn: (text) => deps.logger.warn(text),
      registrySignIn: (registry) => deps.logger.info(`${registry} needs a sign-in; a prepare asks it anonymously.`),
    },
    logger: deps.logger,
    clock: systemClock,
    owner: { windowId: 'prepare', pid: 0 },
    settings: () => PREPARE_SETTINGS,
    analyzer: deps.analyzer,
    dockerTarget: async () => ({ kind: 'local', host: '', endpoint: '' }),
    devspaceLock: async () => {
      throw new DevspaceLockError('unavailable', 'A prepare never takes the lock of a devspace.');
    },
  };
}

/** The core services of one operation in the worker (see the module comment). */
export function workerServices(deps: WorkerServicesDeps): { service: DevspaceService; helper: WorkspaceHelper; docker: EngineDocker } {
  const serviceDeps = workerServiceDeps(deps);
  return { service: new DevspaceService(serviceDeps), helper: serviceDeps.helper as WorkspaceHelper, docker: serviceDeps.docker as EngineDocker };
}

/** The deps of DevspaceService in the worker (workerServices; apart, for their tests). */
export function workerServiceDeps(deps: WorkerServicesDeps): DevspaceServiceDeps & { helper: WorkspaceHelper; docker: EngineDocker } {
  // One queue of registry logins for the operation, shared by its pulls and its image check (they share the one
  // registry secret).
  const logins = registryLogins(deps.host, () => deps.forgetSecret(SECRET_REGISTRY), deps.logger);
  const docker = new EngineDocker(deps.engine, deps.logger, deps.secretOf, logins);
  // The helper runs from the worker's own image with the worker's socket; it gets no Docker port, so nothing of the
  // helper image of the extension is here.
  const helper = new WorkspaceHelper({
    logger: deps.logger,
    ownImage: deps.ownHelper.image,
    socket: deps.ownHelper.socket,
    // A container that runs after its lifecycle commands failed is kept (an inspect of the helper's own would fail
    // closed in the worker, so every such open would fail). With the signal of the step, so a cancel does not wait for
    // the inspect.
    containerRuns: async (containerId, signal) => (await docker.containerState(containerId, signal)) === 'running',
  });
  // The shared VS Code server store of the worker (the volume at VSCODE_STORE_DIR of its own container).
  const store = deps.ownHelper.vscodeStore;
  const server = deps.vscodeServer;
  if (server !== undefined && store === undefined) deps.logger.info('The worker mounts no shared VS Code server store, so the open runs without it.');
  return {
    ...(store !== undefined ? { vscodeStoreVolume: store } : {}),
    // The fetch of the server into the store, for the platform of the engine (ensureEngineServer; never rejects).
    ...(server !== undefined && store !== undefined
      ? {
          vscodeServer: {
            server,
            fetch: (signal: AbortSignal) => ensureEngineServer(workerVscodeStore(deps), server, signal),
            // The record of the extension list and the seed of the cached `.vsix` files.
            extensions: workerExtensionCache(deps.defaultExtensions),
          },
        }
      : {}),
    docker,
    // Docker runs where the worker runs; the engine must answer.
    startDocker: async ({ signal }) => {
      if (!(await docker.isRunning(signal))) throw new UserFacingError('dockerEngineNotRunning', Messages.dockerEngineNotRunning, 'The engine of the worker does not answer.');
    },
    helper,
    registry: hostStore(deps.host.records),
    // The busy marks are set and cleared by the extension.
    busyMarks: hostBusyMarks(deps.host.records),
    // The registry writes of the open are requests to the extension.
    openRecords: hostOpenRecords(deps.host),
    // The Git state is recorded by the extension.
    recordGitSummary: (devspaceId, summary) => deps.host.records.recordGitSummary(devspaceId, summary),
    // The open's ensure and first heartbeat too (the time limit of the settings of the operation).
    sessionMonitor: workerSessionMonitor(deps.engine, deps.monitorSource, deps.logger, {
      ...(deps.monitorEnsure !== undefined ? { ensure: deps.monitorEnsure } : {}),
      ...(deps.monitorImages !== undefined ? { images: deps.monitorImages } : {}),
      ...(deps.settings !== undefined ? { limitSeconds: () => stopAfterSeconds(deps.settings!.stopAfterMinutes) } : {}),
    }),
    sessionFiles: hostSessionFiles(deps.host),
    windowStatuses: () => deps.host.state.windowStatuses(),
    // The processes of the user's computer are not the worker's; the pipeline asks the extension before each decision
    // about the other windows (processAlive). A synchronous question fails closed.
    isProcessAlive: () => {
      throw new Error('The worker does not know synchronously whether a process of the computer runs.');
    },
    processAlive: (pid) => deps.host.state.processAlive(pid),
    // The window's memory of the containers whose lifecycle mark was not recorded.
    lifecycleMemory: hostLifecycleMemory(deps.host),
    // The GitHub profile of the account, read by the extension with its token (never the worker's).
    viewer: async () => {
      const profile = await deps.host.state.viewer();
      if (profile === undefined) throw new Error('The extension could not read the GitHub profile.');
      return profile;
    },
    // The image update check in the worker, over its own HTTPS (through the proxy of the daemon) with the login of each
    // registry asked when it is needed and forgotten after its use.
    imageChecker: workerImageChecker(deps, logins),
    // The registry answers of the Monitor of the worker's engine.
    registryAnswers: () => readRegistryAnswers(deps.registryAnswersDir),
    // The remembered check results of the configurations, which the extension keeps; the worker only asks for the one
    // of its devspace and offers a new one.
    configChecks: {
      get: (devspaceId) => deps.host.records.configCheck(devspaceId),
      remember: (devspaceId, entry) => deps.host.records.rememberConfigCheck(devspaceId, entry),
    },
    auth: hostAuth(deps.host, deps.logger),
    ui: hostUi(deps.host.questions, deps.logger),
    logger: deps.logger,
    clock: systemClock,
    owner: deps.owner,
    settings: () => {
      if (deps.settings === undefined) throw notGiven('settings');
      return deps.settings;
    },
    analyzer: deps.analyzer ?? NO_ANALYZER,
    dockerTarget: async () => ({ kind: deps.dockerHost === '' ? 'local' : 'remote', host: deps.dockerHost, endpoint: '' }),
    devspaceLock: deps.devspaceLock,
    ...(deps.prepareLock !== undefined ? { prepareLock: deps.prepareLock } : {}),
    // The flows and the refresh through a worker are the window's (DevspaceOperations), not the pipeline's.
  };
}
