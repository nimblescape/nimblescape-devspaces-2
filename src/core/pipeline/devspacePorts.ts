// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The ports of the devspace service (devspaceService.ts), in their own module: its Docker, its part of
// WorkspaceHelper, the Monitor, the extension cache and its deps. Types only.
import type { RegistryAnswers } from '../remoteMonitor/registryAnswers';
import type { ConfigCheckEntry } from '../storage/configCheckEntry';
import type { DevspaceBusyMarks } from './busyMarks';
import type { ContainerInfo, ImageInfo, ImageInspection, ListedContainer, NetworkInfo, VolumeInfo } from '../docker/dockerObjects';
import type { HeldDevspaceLock } from '../docker/devspaceLock';
import type { UserIds } from '../docker/passwdUsers';
import type { SECRET_TOKEN, VscodePlatform, VscodeServerRef } from '../helperChannel/protocol';
import type { ConfigurationAnalyzer } from '../helper/configurationAnalysis';
import type { GitHubViewer } from '../helper/containerGit';
import type { WorkspaceHelper } from '../helper/workspaceHelper';
import type { ImageChecker } from '../imageCheck/imageCheck';
import type { GitHubAuth, PipelineUi, RunResult } from '../ports';
import type { ContainerState, GitSummary } from '../types';
import type { ExtensionRef } from '../vscodeExtensions';
import type { DockerStarter, OperationBaseDeps } from './operationBase';
import type { OpenRecords } from './openRecords';

/**
 * The Docker of the pipeline: the calls that the service and the refresh make. The worker's EngineDocker
 * (src/core/worker/engineDocker.ts, over the Engine API) is the one implementation (one way of commanding Docker). The
 * calls throw when Docker fails; a missing object is an answer where it says so.
 */
export interface DevspaceDocker {
  /** The engine answers. Rejects only with an AbortError. */
  isRunning(signal?: AbortSignal): Promise<boolean>;
  /**
   * The API version of the engine (for example `1.48`), or `undefined` when the engine does not tell it. Docker Compose
   * configurations need it for `volume.subpath` (supportsVolumeSubpath). Rejects only with an AbortError.
   */
  engineApiVersion(signal?: AbortSignal): Promise<string | undefined>;
  /** `Config` of the inspect of the image `reference`. */
  imageConfig(reference: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<unknown>;
  /**
   * The numeric user and group IDs of `user` in the image `image`, as `id -u` and `id -g` would print them in a
   * container of it, read from its `/etc/passwd` without running anything (EngineDocker.imageUserIds; no extra
   * container). Undefined when they cannot be known that way.
   */
  imageUserIds(image: string, user: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<UserIds | undefined>;
  /**
   * The dev container of the devspace (label nimblescape.devspaces.id, isDevContainer) by the one rule of
   * the dev container (devContainerOf): the container named `containerName` whatever its state, else the newest running
   * one, else the newest one.
   */
  findContainer(devspaceId: string, containerName: string): Promise<ContainerInfo | undefined>;
  /**
   * All containers with the label nimblescape.devspaces.id, running or not (the refresh reads all
   * devspaces at once). Each with the time of its create, for the rule of the dev container.
   */
  listDevspaceContainers(): Promise<ListedContainer[]>;
  /**
   * The containers with the label nimblescape.devspaces.id of `devspaceId`, running or not: its dev
   * container and the other services; each with the time of its create.
   */
  devspaceContainers(devspaceId: string): Promise<ListedContainer[]>;
  /** All containers of the Docker Compose project `project` (label com.docker.compose.project), running or not. */
  listProjectContainers(project: string): Promise<ContainerInfo[]>;
  /** The names of the networks of the Docker Compose project `project`. */
  listProjectNetworks(project: string): Promise<string[]>;
  /** A missing network is not an error; a network in use is. */
  removeNetwork(name: string): Promise<void>;
  /**
   * The images that Docker Compose built for the project `project` (`<project>-*` with a tag), as `repository:tag`; with
   * `devspaceId`, only those whose label nimblescape.devspaces.id names that devspace.
   */
  listProjectImages(project: string, devspaceId?: string): Promise<string[]>;
  /**
   * 'missing' if not found; running|restarting|paused → 'running'; else 'stopped'. An abort of `signal` ends the read
   * at once (a cancel does not wait for the time limit of the query).
   */
  containerState(nameOrId: string, signal?: AbortSignal): Promise<ContainerState>;
  /** A missing container is not an error. */
  stopContainer(nameOrId: string): Promise<void>;
  /** Throws when the container does not exist or the name is taken. */
  renameContainer(nameOrId: string, newName: string): Promise<void>;
  /** Removes the container, also a running one. A missing container is not an error. */
  removeContainer(nameOrId: string): Promise<void>;
  /**
   * `docker exec`; resolves also for a non-zero exit code. The pipeline runs only the scripts of the registry through
   * it (runScript, src/core/worker/containerScripts.ts). `secretInputName` names the secret of the operation that is
   * the standard input of the process, as DockerEngine.exec takes it (a name, never a value): only the token
   * (SECRET_TOKEN), which the operation must hold.
   */
  exec(
    container: string,
    command: readonly string[],
    options?: { user?: string; workdir?: string; input?: string; secretInputName?: typeof SECRET_TOKEN; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<RunResult>;
  /** Starts the container with the full ID `id`. */
  startContainer(id: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
  volumeExists(name: string): Promise<boolean>;
  createVolume(name: string, labels: Record<string, string>): Promise<void>;
  removeVolume(name: string): Promise<void>;
  /** The volumes with the label nimblescape.devspaces.id. */
  listDevspaceVolumes(signal?: AbortSignal): Promise<VolumeInfo[]>;
  /** The volumes of `names` that exist, each once. */
  inspectVolumes(names: readonly string[]): Promise<VolumeInfo[]>;
  /** The networks of `names` that exist, each once. */
  inspectNetworks(names: readonly string[]): Promise<NetworkInfo[]>;
  imageExists(reference: string): Promise<boolean>;
  /** The full ID of the image, or undefined for a missing image. */
  imageId(reference: string): Promise<string | undefined>;
  /** The labels of the image, or undefined for a missing image. */
  imageLabels(reference: string): Promise<Record<string, string> | undefined>;
  /**
   * Tags the image with the full ID `image` as `reference` (`repository:tag`, a local name); a tag of another image
   * moves.
   */
  tagImage(image: string, reference: string, signal?: AbortSignal): Promise<void>;
  /** The labels of the images of `references` by their lower-case full IDs; a missing image is left out. */
  imageLabelsOf(references: readonly string[], signal?: AbortSignal): Promise<Map<string, Record<string, string>>>;
  /**
   * Gives the image `image` the labels `labels` (its build record); the previous image is removed only when nothing
   * names it.
   */
  labelImage(image: string, labels: Record<string, string>, signal?: AbortSignal): Promise<void>;
  /**
   * The images that the references find; the references that could not be checked, each with its reason
   * (ImageUncheckedReason).
   */
  inspectImageNames(references: readonly string[], signal?: AbortSignal): Promise<ImageInspection>;
  /** True when the image was removed; false for a missing image or one in use. */
  removeImage(reference: string): Promise<boolean>;
  /** The tags `repository:tag` of exactly this repository, sorted by tag, numbers numerically. */
  listImageTags(repository: string): Promise<string[]>;
  /** The named images `devspaces-*`, each once with its references. */
  listDevspaceImages(signal?: AbortSignal): Promise<ImageInfo[]>;
  /**
   * `docker pull`. EngineDocker.pullImage pulls without a login first; it asks for the login of the registry of the
   * reference itself only when the registry refuses that pull (or Docker Hub limits it), and holds it only for this
   * pull.
   */
  pullImage(reference: string, options?: { onOutput?: (text: string) => void; signal?: AbortSignal }): Promise<void>;
}

/** The part of WorkspaceHelper that the service uses. */
export type DevspaceHelper = Pick<
  WorkspaceHelper,
  | 'ownImageUse'
  | 'clone'
  | 'readConfigFiles'
  | 'listConfigurations'
  | 'readConfiguration'
  | 'composeModel'
  | 'composeServiceHashes'
  | 'build'
  | 'up'
  | 'runUserCommands'
  | 'prepareGit'
  | 'createRepositoryFolders'
  | 'fixConfigOwnership'
  | 'fixRepositoryOwnership'
>;

/**
 * The Monitor container of the Docker engine of the operation (RemoteSessionMonitor, with the socket of that
 * engine and the id of this computer), one on every engine, local and remote. The calls take no Docker target, helper
 * tag or image: the only implementation (workerSessionMonitor) is the monitor of the worker's own engine, run with the
 * worker's own helper image.
 */
export interface DevspaceSessionMonitor {
  /**
   * Makes sure that the monitor container runs on the engine. Rejects with the cause when it cannot (the open is
   * refused), and with an AbortError when `signal` aborts.
   */
  ensure(signal: AbortSignal | undefined): Promise<unknown>;
  /**
   * One heartbeat of this computer for the devspace (with the time limit of the settings). The monitor acts only on
   * devspaces that a computer sent a heartbeat for. `seq`: the wall clock when the keep flag was read
   * (HeartbeatEntry).
   */
  heartbeat(devspaceId: string, keepRunning: boolean, seq: number): Promise<{ ok: true } | { ok: false; detail: string }>;
  /**
   * Removes the heartbeat record of this computer for a deleted devspace (best effort). Only the worker's Session
   * Monitor has it (Delete runs there).
   */
  forget(devspaceId: string): Promise<void>;
  /**
   * Gives the monitor of the engine the image repositories to update and clean (read from the registry; at most once an
   * hour per engine). Best effort: never throws, except an AbortError.
   */
  images(signal?: AbortSignal): Promise<void>;
}

/**
 * The deps of the worker's pipeline. What it shares with the window's operations is OperationBaseDeps; here only what
 * is the pipeline's own, or wider for it.
 */
export interface DevspaceServiceDeps extends OperationBaseDeps {
  docker: DevspaceDocker;
  helper: DevspaceHelper;
  imageChecker: Pick<ImageChecker, 'check'>;
  /**
   * The registry answers of the Monitor of the engine (in its volume, REGISTRY_ANSWERS_FILE), read strictly;
   * `undefined` when there are none or the file is not valid. Without it, the open checks every reference itself.
   */
  registryAnswers?: () => Promise<RegistryAnswers | undefined>;
  /**
   * The remembered check results of the configurations, which the extension keeps (`record configCheck`, `record
   * rememberConfigCheck`); without it, every open runs the whole check.
   */
  configChecks?: {
    get(devspaceId: string): Promise<ConfigCheckEntry | undefined>;
    remember(devspaceId: string, entry: ConfigCheckEntry): Promise<void>;
  };
  /** Also the report of a token that GitHub rejected. */
  auth: Pick<GitHubAuth, 'getToken' | 'getAccount' | 'reportRejectedToken'>;
  /**
   * The GitHub account of a token (DiscoveryService.viewer), for the Git identity of a new devspace. Without it, or
   * when GitHub does not answer in time, the identity comes from the account of the session.
   */
  viewer?: (token: string, signal?: AbortSignal) => Promise<GitHubViewer>;
  /** Time limit of `viewer`. Default 5 s. */
  viewerTimeoutMs?: number;
  /** All questions and messages of the pipeline. */
  ui: PipelineUi;
  /**
   * The start of Docker, or the check that it answers. Required: the worker gives a check that its engine answers.
   */
  startDocker: DockerStarter;
  /**
   * The Monitor container of the engine. The open pipeline ensures it right after the helper image (before the
   * container is created or started); Delete removes the record of this computer there. On every engine, local and
   * remote; an open is refused when it cannot be ensured. Without it (tests): nothing.
   */
  sessionMonitor?: DevspaceSessionMonitor;
  /**
   * The busy marks of the window that runs the operation; the worker's pipeline sends them to the extension (`record
   * markBusy`, `record clearBusy`). Required: there is no write to the registry by a function in the pipeline.
   */
  busyMarks: DevspaceBusyMarks;
  /**
   * The registry writes of the open, as specific operations (the entry, configuration and build writes); the worker's
   * pipeline sends them to the extension (hostOpenRecords). Required, as `busyMarks`.
   */
  openRecords: OpenRecords;
  /**
   * Records the Git state of a devspace (Devspace.gitSummary); the worker's pipeline sends it to the extension
   * (`record recordGitSummary`). Required, as `busyMarks`.
   */
  recordGitSummary: (devspaceId: string, summary: GitSummary) => Promise<void>;
  /** Interval at which an open pipeline writes its pending connection file again. Default 15 s. */
  pendingRefreshMs?: number;
  /** For tests. Default: newDevspaceId of names.ts. */
  newDevspaceId?: () => string;
  /**
   * Runs the host access analysis of a configuration (checkContainer of the container policy, ../policy, and the FROM
   * images of the Dockerfiles for the update check). The worker runs it in its analysis thread with limits of time and
   * memory; a failed analysis refuses the configuration.
   */
  analyzer: ConfigurationAnalyzer;
  /**
   * Takes the lock of a devspace in the worker of the Docker target of the operation (the worker's own,
   * workerDevspaceLock), waiting at most `waitSeconds`. Throws DevspaceLockError (`busy`, `unavailable`) or an
   * AbortError. Stop and Delete take it. Required: there is no path without the lock.
   */
  devspaceLock: (devspaceId: string, waitSeconds: number, signal: AbortSignal | undefined) => Promise<HeldDevspaceLock>;
  /**
   * The prepare lock of a devspace, which a background prepare of its next devspace image holds (in the worker:
   * workerPrepareLock). Only an update that would use the prepared image looks at it. Without it (the tests that are
   * not about it): no prepare runs.
   */
  prepareLock?: PrepareLock;
  /**
   * The name of the shared VS Code server store of the engine (the volume that the worker mounts read-write,
   * OwnHelper.vscodeStore; default VSCODE_STORE_VOLUME). The host access policy allows its mount in the override
   * configuration (HostAccessInput.vscodeStoreVolume), the creation of the additional volumes never creates or records
   * it, and the link checks that the dev container mounts it.
   */
  vscodeStoreVolume?: string;
  /**
   * The VS Code server of an open that carries one (OpenParams.vscodeServer) on a worker with a store, and `fetch`,
   * which makes sure that the store has it for the platform of the engine (ensureEngineServer; resolves with that
   * platform when it is ready, else `undefined`; never rejects). Without it the open runs without the store: no mount
   * of the store, no fetch, no link. The open starts the fetch at its start (a present server costs nothing; a download
   * that runs in another window is waited for through its lock; a missing one is downloaded by the very first open) and
   * waits for it before the link.
   */
  vscodeServer?: { server: VscodeServerRef; fetch: (signal: AbortSignal) => Promise<VscodePlatform | undefined>; extensions?: VscodeExtensionCache };
}

/**
 * The prepare lock of a devspace (prepareLockFilePath), a lock of its own next to the devspace lock. Neither
 * call holds it after it resolves. Both reject only with an AbortError (a cancel of the open); a lock that cannot be
 * asked counts as free (the open then builds, as without a prepare).
 */
export interface PrepareLock {
  /** Whether a prepare holds the lock of `devspaceId` now, asked without a wait. */
  held(devspaceId: string, signal: AbortSignal | undefined): Promise<boolean>;
  /** Waits at most `waitSeconds` until the lock of `devspaceId` is free: false when it stayed held. */
  waitFree(devspaceId: string, waitSeconds: number, signal: AbortSignal | undefined): Promise<boolean>;
  /**
   * Delete asks a running prepare of `devspaceId` to stop (its stop request, prepareStopFilePath) and waits at most
   * `waitSeconds` until the prepare lock is free: false when it stayed held (the Delete goes on anyway; the request
   * then stays, so the prepare still stops when it looks). The request is removed again when the lock got free. Rejects
   * only with an AbortError. Without it, a Delete stops no prepare.
   */
  stop?(devspaceId: string, waitSeconds: number, signal: AbortSignal | undefined): Promise<boolean>;
}

/**
 * What a headless prepare (DevspaceService.prepare) gets besides the deps of its service, from the operation that
 * runs it (the worker's `prepare`, runPrepare). Nothing of it reaches a computer.
 */
export interface PrepareRun {
  /**
   * Takes the prepare lock of `devspaceId` without a wait: the held lock, whose `batch` opens the batch helper of the
   * prepare and whose `lost` resolves when `signal` aborts (the batch helper then ends); `undefined` when it is held
   * elsewhere (a prepare, or the probe of an open: tried again at a later pass). Rejects when the lock cannot be asked.
   */
  takeLock(devspaceId: string, signal: AbortSignal): Promise<HeldDevspaceLock | undefined>;
  /**
   * The hash of the prepare of `devspaceId` that the time limit stopped (prepareKeyHash), or whose build failed, if
   * any. Never rejects.
   */
  stoppedKey(devspaceId: string): Promise<string | undefined>;
  /**
   * Records `hash` as the prepare of `devspaceId` that the time limit stopped or whose build failed, so it is not
   * tried again until its key changes. Never rejects (a failure is logged).
   */
  recordStopped(devspaceId: string, hash: string): Promise<void>;
  /** The cancel of the operation, and the stop request of a Delete. */
  signal: AbortSignal;
  /** The hard limit (default PREPARE_LIMIT_MS; for the tests). */
  limitMs?: number;
}

/** What a prepare did (PrepareValue of the operation; its outcomes are those of PREPARE_OUTCOMES). */
export interface PrepareResult {
  outcome: 'prepared' | 'skipped' | 'stopped' | 'cancelled' | 'failed';
  /** One sentence: why it was skipped or failed, or what it prepared. */
  detail: string;
  durationMs: number;
}

/**
 * The shared extension cache of the store for an open with a VS Code server (the worker's: recordExtensions,
 * cachedExtensionFiles and seedSelection at VSCODE_STORE_DIR; the record, the monitor's chosen files and their
 * dependencies in the volume of the Monitor at LOCK_STATE_DIR).
 */
export interface VscodeExtensionCache {
  /**
   * Records the extension list of the open of `devspaceId` (the configuration's extensions, undefined when the open
   * could not read its configuration: the recorded ones stay; and the user's defaults) with the time of the open;
   * resolves with the list of the open. Rejects with the cause.
   */
  record(devspaceId: string, configuration: ExtensionRef[] | undefined): Promise<ExtensionRef[]>;
  /**
   * The cached files of the store to seed for `list` and the dependencies of its entries (`<folder>/<cache name>`), for
   * the engine's platform when known.
   */
  seedFiles(list: ExtensionRef[], platform: VscodePlatform | undefined): Promise<string[]>;
}
