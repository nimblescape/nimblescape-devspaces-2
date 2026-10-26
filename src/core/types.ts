// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Shared data types. Stored files (registry.json, repositories-<account ID>.json, session files) use these shapes.
// All times are ISO 8601 strings in UTC, unless a field says otherwise.

/** Last known Git state of the workspace volume. */
export interface GitSummary {
  /** Checked-out branch. `null` for a detached HEAD or when unknown. */
  branch: string | null;
  uncommittedFiles: number;
  unpushedCommits: number;
  stashes: number;
  recordedAt: string;
}

/** Name of the current devspace image and the digests it was built from. */
export interface BuildRecord {
  builtAt: string;
  /** For example `devspaces-majikmate-module-ts-curious-hopper:2` (devspaceImageName). */
  devspaceImage: string;
  /**
   * The full ID of devspaceImage as this computer built it (after its labels, DevspaceDocker.labelImage) or took
   * it over (from the labels of the newest image of a restored devspace). An image under that name with another ID
   * was swapped: it is not used (the open builds again). Not in the label of the build record (the label is part of the
   * ID).
   */
  imageId?: string;
  buildNumber: number;
  /** Configuration that this build used. */
  configPath: string;
  /** `sha256:<hex>` of the devcontainer.json text plus the Dockerfile text, if any. */
  configHash: string;
  /**
   * The build used the default image of the setting `defaultImage` (DevspaceSource `defaultImage`) in place of the
   * configuration of the repository: the image reference as the setting gave it. `configPath` and `configHash` then
   * describe the synthesized configuration `{ "image": "<reference>" }`. Missing: the build used the configuration.
   */
  defaultImage?: string;
  /** Image reference as written in the configuration → digest read right before the build. */
  images: Record<string, string>;
  /** Feature reference as written in the configuration → digest read right before the build. */
  features: Record<string, string>;
  /**
   * A Docker Compose configuration: the dev service, and the images that Compose and the Dev Container CLI built for
   * the project (builtServiceImages), which Delete removes. The devspace image is the image of the dev service.
   */
  compose?: ComposeBuildRecord;
}

/** BuildRecord.compose. */
export interface ComposeBuildRecord {
  /** `service` of devcontainer.json: the dev service. */
  service: string;
  /** `<project>-<service>` (composeServiceImage) of each service that Compose builds. */
  images: string[];
  /**
   * The `image` references of the other services that are not built (for example `postgres:16`), as the image check
   * names them in `images` of the build record. They are images of the user, pulled for the services, not base images
   * of the devspace image: removeUnusedBaseImages never removes them.
   */
  serviceImages: string[];
  /**
   * The version of the Compose plugin that printed the model of `configHash`, and composeInputsHash of the files as
   * written. A new Compose version can print the same files as another model: with equal files, a different model
   * counts as a change only with the same version (composeConfigurationChange).
   */
  version: string;
  inputsHash: string;
}

export type BusyOperation = 'create' | 'update' | 'rebuild' | 'delete';

/** Marks a devspace as busy, so the Monitor does not stop it. */
export interface BusyMark {
  operation: BusyOperation;
  since: string;
  /** Process ID of the extension host that set the mark. A mark of an ended process is ignored. */
  pid: number;
  windowId: string;
}

/** A GitHub account of the VS Code GitHub sign-in. */
export interface GitHubAccount {
  /** Numeric GitHub user ID as a string (`session.account.id`; the `databaseId` of the GraphQL API). */
  id: string;
  /** Login (`session.account.label`). Empty for an owner that was restored from a volume label, until the next open. */
  login: string;
}

/** One entry of the Devspace Registry. */
export interface Devspace {
  /** `crypto.randomUUID()`. */
  id: string;
  /** `owner/name` with the case that GitHub uses. */
  repository: string;
  /** For example `.devcontainer/python/devcontainer.json`. */
  configPath: string;
  /**
   * The devspace is the default-image devspace of its repository (DevspaceSource `defaultImage`): the image it was
   * last opened with, as the setting `defaultImage` gave it. Missing: the devspace of the configuration `configPath`.
   * Set at the creation and written with the configuration of each open (ConfigurationChange.defaultImage), before the
   * build record; never removed, as a devspace keeps its source.
   */
  defaultImage?: string;
  volumeName: string;
  containerName: string;
  createdAt: string;
  lastUsedAt: string;
  /**
   * The last time a window of this computer was seen using the devspace, besides the open pipeline (`lastUsedAt`): a
   * window that starts connected to it (a reload, SessionCoordinator.start) and the start of each release (before its
   * Git record). Only for the note of Delete's confirmation (recordedStateNote, with lastSeenInUse). It only moves
   * forward (DevspaceRegistry.markSeenInUse).
   */
  lastSeenInUseAt?: string;
  gitSummary?: GitSummary;
  buildRecord?: BuildRecord;
  busy?: BusyMark;
  /** From the result of `devcontainer up`. */
  remoteUser?: string;
  /** From the result of `devcontainer up`. For example `/workspaces/api`. */
  remoteWorkspaceFolder?: string;
  /** The repository configuration sets `"shutdownAction": "none"`. */
  shutdownActionNone?: boolean;
  /** Named volumes of the configuration (`mounts` with `type=volume`), without the workspace volume. */
  additionalVolumes?: string[];
  /**
   * Docker Compose: the named volumes that services other than the dev service mounted, recorded at each open from the
   * checked model (composeServiceVolumeNames) and kept once recorded. Delete lists these volumes as data of the
   * services (none ticked), whatever their label nimblescape.devspaces.volume, also when the configuration cannot be
   * read.
   */
  serviceVolumes?: string[];
  /**
   * The paths of the repository (absolute, for example `/workspaces/api/data/postgres`) that the containers of the
   * other services of Docker Compose may mount from the workspace volume (composeUpModel's `serviceFolders`), written
   * before each `up`, also before the first build record. The list does not shrink while such a container may still
   * mount a path of it: an `up` adds the paths of its model; only an `up` before which no container of another service
   * exists (all of them were removed) replaces it. The ownership fixes after `up` leave the data of the services there
   * alone, and the question of Delete names them. The record of the list that the pipeline computes from facts at each
   * `up` (boundServiceFolders): the paths of the model, the paths that the existing containers of the other services
   * mount (their volume subpaths), and the recorded paths of earlier models while they still exist in the volume; at
   * most MAX_SERVICE_FOLDERS. Before an `up` it only grows (a failed `up` leaves the containers of the earlier models);
   * after it, a path that no model, no container, and no file names any more is dropped. reconcileFromVolumes fills it
   * from the mounts of the containers that it finds.
   */
  serviceFolders?: string[];
  /**
   * The list had more than MAX_SERVICE_FOLDERS paths, so not all are recorded: the ownership fixes leave the whole
   * repository to the services (only the files of root get their owner). It stays set.
   */
  serviceFoldersOverflow?: boolean;
  /** Highest build number used so far for this devspace. */
  lastBuildNumber?: number;
  /** The GitHub account that created the devspace. Only this account can use it. */
  owner: GitHubAccount;
  /**
   * An update whose new devspace image the host access policy refused: the same update is not built again until a
   * digest or the configuration changes.
   */
  refusedUpdate?: RefusedUpdate;
  /**
   * Keep Running When Closed: the Monitor never stops this devspace when no window uses it; only the user's
   * Stop or Delete does. Missing or false: the container stops after the waiting time, as the setting stopOnClose says.
   */
  keepRunning?: boolean;
  /**
   * Close and Keep Running: the window was closed with this command, so the container keeps running this time, as with
   * `keepRunning`. Cleared when a window connects to the devspace again, and by Stop (Delete removes the entry).
   * Missing or false: as `keepRunning` says.
   */
  keepRunningOnce?: boolean;
  /**
   * The Docker host of the devspace, the part after `ssh://` of the Docker context in which it was created (an SSH
   * alias or `user@host[:port]`). Missing: the local Docker. The view, the switcher, the status bar, and every command
   * show and act on the devspaces of the current Docker host only.
   */
  dockerHost?: string;
  /**
   * The ID of a container of the devspace that `up` created or started, whose lifecycle commands could not run (the
   * workspace helper failed), and that could be neither removed nor stopped. Step 9 does not open that container as it
   * is while it runs: it runs `up` (without removal) and the lifecycle commands. Cleared by the next successful open
   * (`finish`), and when that container is removed. A mark that names another container than the current one has no
   * effect.
   */
  lifecycleIncomplete?: string;
}

/**
 * An update whose new devspace image the host access policy refused: the configuration and the digests of the image
 * check that led to it. The same update is not built again; a changed digest or configuration, or a manual rebuild,
 * tries again.
 */
export interface RefusedUpdate {
  configPath: string;
  configHash: string;
  /** Image reference → digest, as recordDigests gives it for the build record. */
  images: Record<string, string>;
  /** Feature reference → digest. */
  features: Record<string, string>;
  /** What the new image needed, for the message (Messages.updateRefused). */
  items: string;
  /**
   * `off` when the host access checks were off for the repository at the refusal (only settings that stay refused then,
   * for example a variable of the GitHub CLI); absent when they were on. An update refused with one state of the switch
   * is tried again with the other.
   */
  hostAccessChecks?: 'off';
  /**
   * `size` when the check of the new image failed for a size limit (AnalysisFailure `size`, for example an oversized
   * devcontainer.metadata label), not for the policy (Messages.updateTooLarge); absent otherwise.
   */
  reason?: 'size';
}

/**
 * An additional volume that a Delete kept, with the account whose devspace used it: it stays foreign for the
 * devspaces of other accounts while it exists (docs/security.md "Accounts").
 */
export interface KeptVolume {
  name: string;
  owner: GitHubAccount;
  keptAt: string;
}

export interface RegistryFile {
  version: 1;
  devspaces: Devspace[];
  /** Additional volumes that a Delete kept. Missing when there are none. */
  keptVolumes?: KeptVolume[];
}

/** A repository found by the discovery. */
export interface RepositoryInfo {
  /** `owner/name`. */
  nameWithOwner: string;
  owner: string;
  name: string;
  /** `https://github.com/owner/name`. */
  url: string;
  isArchived: boolean;
  isFork: boolean;
  isPrivate: boolean;
  pushedAt: string | null;
  defaultBranch: string | null;
  /** Configuration paths in the order of precedence. The first one is the default. */
  configPaths: string[];
}

/**
 * `saml`, `oauthRestricted`, `other`: GitHub refuses the access. `notFound`: an organization or account of the scan scope
 * (setting `owners`) does not exist, or the account cannot see it.
 */
export type OrganizationHintKind = 'saml' | 'oauthRestricted' | 'other' | 'notFound';

/** Hint for an organization whose repositories the API did not return. */
export interface OrganizationHint {
  organization: string;
  kind: OrganizationHintKind;
  /** URL where the user can authorize the access. */
  url: string;
}

/** Content of repositories-<account ID>.json. */
export interface DiscoveryData {
  version: 1;
  fetchedAt: string;
  viewerLogin: string;
  /** Logins of the organizations where the user is a member. */
  organizations: string[];
  repositories: RepositoryInfo[];
  hints: OrganizationHint[];
  /**
   * The scan scope that the list was built with (lower-case logins, sorted; `normalizeScope`). Empty: all repositories
   * that the account can access.
   */
  scope: string[];
  /**
   * The repositories of the scan that have no configuration (`configPaths` empty), with the state of GitHub their
   * detection was read from: a later refresh reads the configurations only of new and changed repositories
   * (incremental detection). With a default image (the setting `defaultImage`), the sidebar lists them too: their
   * devspaces start from that image.
   */
  withoutConfiguration: RepositoryInfo[];
  /**
   * Repositories with a configuration whose lookup was not complete (a GraphQL error in its part of the answer), by
   * `owner/name`: the next refresh reads their configurations again. Missing when there are none.
   */
  uncertain?: string[];
}

/** Content of sessions/<window-id>.json. */
export interface WindowStatus {
  windowId: string;
  /** Process ID of the local extension host of the window. */
  pid: number;
  devspaceId: string | null;
  state: 'active' | 'closing';
  updatedAt: string;
  /**
   * The Docker context named in the authority of the window: another window that wants to show this one opens exactly
   * its URI. Missing for a window without one.
   */
  dockerContext?: string;
  /**
   * The devspace that the window is attached to while it works without Devspaces on an engine with the removal mark
   * (Controller.workWithoutDevspaces): not `devspaceId`, so that no heartbeat, no release and no reopen record go to it.
   * The removal ("Remove Devspaces from This Docker Engine…") and the Stop, Rebuild and Delete of another window count
   * the window as connected to it. Missing for every other window.
   */
  plainDevspaceId?: string;
}

/** Content of pending/<devspace-id>.json. */
export interface PendingConnection {
  devspaceId: string;
  windowId: string;
  createdAt: string;
}

/**
 * `stop` exists because Stop of the devspace that the window is connected to closes the remote connection first,
 * which reloads the window; the reloaded window finishes the stop.
 */
export type PendingOperationKind = 'rebuild' | 'delete' | 'stop';

/** Content of operations/<devspace-id>.json. */
export interface PendingOperation {
  devspaceId: string;
  operation: PendingOperationKind;
  requestedAt: string;
  /** Window ID of the window that requested the operation. */
  requestedBy: string;
  reason: 'manual' | 'update' | 'configChanged';
  /**
   * For `delete`: the additional named volumes that the user confirmed for removal, as the question listed them. A volume
   * that the devspace recorded after the question is kept.
   */
  additionalVolumesToRemove?: string[];
}

/** Content of reopen.json. */
export interface ReopenRecord {
  devspaceId: string;
  closedAt: string;
}

/** The settings of the extension. */
export interface ExtensionSettings {
  reopenLastOnStartup: boolean;
  stopOnClose: boolean;
  updateImagesOnConnect: boolean;
  respectShutdownActionNone: boolean;
  owners: string[];
  includeArchived: boolean;
  includeForks: boolean;
  /** `showOnlyDevspaces`: the sidebar lists only the repositories that have a devspace. Missing: false. */
  showOnlyDevspaces?: boolean;
  refreshIntervalMinutes: number;
  /**
   * Repositories (`owner/name`, valid entries only, trimmed) whose host access checks are off (hostAccessChecks in
   * policy/hostAccessChecks.ts). Only the user setting counts.
   */
  hostAccessChecksOff: string[];
  /**
   * Raw entries of `repositoryGroups`: regular expressions that filter and group the repositories of the sidebar. The
   * sidebar checks each entry (src/vscode/repositoryGroups.ts). Missing: the same as an empty list.
   */
  repositoryGroups?: unknown[];
  /**
   * `openInNewWindow`: Start opens the devspace in a new window, and the current window keeps its devspace. Only
   * the user setting counts (scope `application`). Missing: false (Start uses the current window).
   */
  openInNewWindow?: boolean;
  /**
   * `stopAfterMinutes`: the time limit of the heartbeats of a window to the Monitor container of the engine of
   * its devspace, on every engine: a container stops after this many minutes without a heartbeat, unless it keeps
   * running when closed. 5 to 1440. Missing: 10.
   */
  stopAfterMinutes?: number;
  /**
   * When the Monitor container of each engine runs its background run (the images in use, the newest VS Code
   * server, the cleanup of the store at most once a day): a cron expression of five fields (minute hour day-of-month
   * month day-of-week) in the time zone of this computer, or an interval in whole minutes (at least 5), as
   * normalizeCacheSchedule gives it. Default `17` (every 17 minutes).
   */
  cacheUpdateSchedule?: string;
  /**
   * The Monitor of an engine, local or remote, ends after 5 minutes without a running devspace (true); false, the
   * default: it runs permanently once the user answered the question about it on that engine (monitorQuestion.ts,
   * which writes this setting).
   */
  stopMonitorWhenIdle?: boolean;
  /**
   * What an open does when a newer image is available for the existing container of the devspace (running or
   * stopped). `notify` (default): a modal message that the container is updated now (Continue, or Cancel: the open ends
   * without connecting); `ask`: a modal question (Update Now, or Later: the existing container starts and the window
   * connects without the update).
   */
  updateContainer?: UpdateContainer;
  /**
   * `defaultImage`: an image reference (for example `ghcr.io/majikmate/devcontainer-base:latest`) that every
   * repository can start from, next to its Dev Container configurations: its default-image devspace (DevspaceSource).
   * Only the user setting counts (scope `application`). Missing or empty: no default image; a devspace built from one
   * keeps starting from it. An invalid reference is ignored (readSettings warns once).
   */
  defaultImage?: string;
  /**
   * `startWithDefaultImage`: with a default image, the row `default` is the first child row of a repository (true,
   * the default) or the last one (false); the pickers list the sources in the same order. Only the user setting counts
   * (scope `application`).
   */
  startWithDefaultImage?: boolean;
}

/** The values of the setting updateContainer. */
export type UpdateContainer = 'notify' | 'ask';

/**
 * What a devspace is built from: one Dev Container configuration of its repository (`configPath`), or the default
 * image of the setting `defaultImage` in place of a configuration. With `defaultImage`, the open reads a synthesized
 * configuration `{ "image": "<image>" }` under the configuration path of the devspace: the Dockerfile, the Features,
 * the lifecycle commands, the mounts and the other properties of the configuration of the repository do not apply;
 * only the metadata of the image does. A repository has one devspace per source (src/core/devspaceSource.ts): the
 * source is fixed when the devspace is created (Devspace.defaultImage tells the kind), and the devspaces of a
 * repository run next to each other. A later open of a default-image devspace names the image of the setting at that
 * time; a changed image asks Rebuild now / Later, as a changed configuration does.
 */
export type DevspaceSource = { kind: 'configuration'; configPath: string } | { kind: 'defaultImage'; image: string };

/** State of a container as Docker reports it, simplified. */
export type ContainerState = 'running' | 'stopped' | 'missing';

/** State of a devspace as the sidebar shows it. */
export type DevspaceState =
  | 'connected'
  | 'connectedOtherWindow'
  | 'running'
  | 'stopped'
  | 'updating'
  | 'noContainer'
  | 'filesMissing';

/** JSON result on the last line of standard output of `devcontainer build` and `devcontainer up`. */
export interface DevcontainerResult {
  outcome: 'success' | 'error';
  message?: string;
  description?: string;
  containerId?: string;
  /** `devcontainer up` of a Docker Compose configuration: the project name that the CLI used. */
  composeProjectName?: string;
  imageName?: string | string[];
  remoteUser?: string;
  remoteWorkspaceFolder?: string;
}

/**
 * The part of a (resolved) devcontainer.json configuration that the extension reads.
 * Other properties may exist.
 */
export interface DevcontainerConfig {
  name?: string;
  image?: string;
  build?: {
    dockerfile?: string;
    context?: string;
    args?: Record<string, string>;
    target?: string;
    /** Options of `docker build`. */
    options?: string[];
  };
  /** Deprecated form of `build.dockerfile`. */
  dockerFile?: string;
  dockerComposeFile?: string | string[];
  /** Docker Compose: the dev service. */
  service?: string;
  /** Docker Compose: the services that `up` starts besides the dev service (default: all). */
  runServices?: string[];
  features?: Record<string, unknown>;
  runArgs?: string[];
  appPort?: number | string | Array<number | string>;
  mounts?: Array<string | { source?: string; target?: string; type?: string }>;
  workspaceMount?: string;
  workspaceFolder?: string;
  shutdownAction?: 'none' | 'stopContainer' | 'stopCompose';
  initializeCommand?: unknown;
  privileged?: boolean;
  capAdd?: string[];
  securityOpt?: string[];
  remoteUser?: string;
  containerUser?: string;
  [key: string]: unknown;
}
