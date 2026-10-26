// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// All user-visible texts.
import { sshCommandLine } from './docker/dockerHost';

export const Steps = {
  startingDocker: 'Starting Docker',
  /**
   * Update All Images Now, after a Docker start: the worker is made ready, and the request goes to the Monitor. Not
   * "Asking the Monitor": the title of that progress says it already.
   */
  sendingRequest: 'Sending the request',
  downloadingRepository: 'Downloading repository',
  checkingImage: 'Checking for a newer image',
  downloadingImage: 'Downloading the new image',
  preparing: 'Preparing devspace',
  starting: 'Starting devspace',
  connecting: 'Connecting',
} as const;

export type ProgressStep = keyof typeof Steps;

export const Messages = {
  dockerNotInstalled: 'Docker Desktop is not installed.',
  dockerStartFailed: 'Docker could not be started.',
  dockerEngineNotRunning: 'Docker is not running. Start the Docker service with this command: sudo systemctl enable --now docker',
  /**
   * The docker command of this computer is Podman (for example the package podman-docker), or the engine that it
   * reaches is the Docker-compatible API of Podman (ensureDockerRunning, and podmanDockerTarget when the current Docker
   * context cannot be read). Docker is not started.
   */
  podmanNotSupported:
    'The docker command on this computer uses Podman. Devspaces does not support Podman. It needs Docker: Docker Desktop, or Docker Engine on Linux. Nothing was done.',
  buildFailed: 'The devspace could not be prepared.',
  registryUnreachable:
    'No connection to the image registry. The update check was skipped. The devspace uses the local image.',
  firstOpenOffline: 'This repository cannot be opened without internet access.',
  registrySignIn: (registry: string) => `The registry ${registry} requires a sign-in.`,
  organizationNotAuthorized: (organization: string) =>
    `Access to the organization ${organization} is not authorized.`,
  /**
   * GitHub refused the refresh of the repository list for its rate limit. `time`: the local time when Devspaces loads
   * the list again (`retry`), or after which Refresh works again.
   */
  gitHubRateLimited: (time: string, retry: boolean) =>
    'GitHub limits the requests of your account for now. The repository list may be incomplete or out of date. ' +
    (retry ? `Devspaces loads it again at ${time}.` : `Choose Refresh after ${time}.`),
  /** An owner of the setting `owners` that GitHub does not return (unknown, or no access). */
  organizationNotFound: (organization: string) => `The organization ${organization} was not found or is not accessible.`,
  newerImage: 'A newer image is available. The devspace is updated. Your files are kept.',
  /**
   * The modal message of the setting updateContainer `notify` (Continue or Cancel), and the question of `ask` (Update
   * Now or Later), when a newer image is available for the existing container (`running`: it runs).
   */
  containerUpdateNotice: (repository: string, running: boolean) =>
    running
      ? `A newer image is available for ${repository}. To use it, the running container is stopped and created again from the new image. Your files in the workspace are kept; programs and files that you added outside the workspace are not. Choose Continue to update now, or Cancel to leave the devspace closed.`
      : `A newer image is available for ${repository}. Its container is created again from the new image before it opens. Your files in the workspace are kept; programs and files that you added outside the workspace are not. Choose Continue to update now, or Cancel to leave the devspace closed.`,
  containerUpdateQuestion: (repository: string, running: boolean) =>
    running
      ? `A newer image is available for ${repository}. Update Now stops the running container and creates it again from the new image: your files in the workspace are kept, but programs and files that you added outside the workspace are not. Later opens the current container without the update.`
      : `A newer image is available for ${repository}. Update Now creates its container again from the new image: your files in the workspace are kept, but programs and files that you added outside the workspace are not. Later starts the current container without the update.`,
  /** Cancel of containerUpdateNotice; the open ended, nothing was changed. */
  containerUpdateCancelled: (repository: string) => `${repository} was not opened, and its container was not updated.`,
  filesMissing: 'The files of this devspace are missing.',
  configurationChanged: 'The devspace configuration changed.',
  /** The default image of the setting changed since the devspace was built from one. */
  defaultImageChanged: 'The default image of the devspace changed.',
  /**
   * A devspace without a build record (restored after a lost registry) whose containers are of another kind than
   * its configuration. Rebuild now switches the kind; Later keeps it (the non-destructive answer). No docker start
   * fallback: Later starts no stopped dev container of Docker Compose without a Docker Compose configuration; a running
   * one opens as it is and its stopped services start when no container of the devspace must be created again (a
   * container created while the host access checks were off must be created again while they are on).
   */
  configurationKindChanged: (containersUseCompose: boolean, configPath: string) =>
    containersUseCompose
      ? `The containers of this devspace use Docker Compose, but the configuration ${configPath} uses a single container. Rebuild now switches the devspace to a single container: it removes the containers of the other services and the files outside the volumes; named volumes are kept. Later keeps Docker Compose without a rebuild: if the dev container runs already and no container of the devspace must be created again, the dev container opens as it is, and the stopped containers of the other services are started. Otherwise nothing starts: a stopped dev container, or containers that must be created again (for example because an older version created them, or because they were created while the host access checks were off and the checks are on now), start only with a Docker Compose configuration. A Docker Compose configuration of the repository, if it has one, is its own row in the list of devspaces.`
      : `The container of this devspace is a single container, but the configuration ${configPath} uses Docker Compose. Rebuild now switches the devspace to Docker Compose: it removes the container and the files outside the volumes; named volumes are kept. Later keeps the single container. A single-container configuration of the repository, if it has one, is its own row in the list of devspaces.`,
  /**
   * configurationKindChanged when the dev container of Docker Compose is missing: Later starts nothing then
   * (composeDevContainerMissing).
   */
  configurationKindChangedDevContainerMissing: (configPath: string) =>
    `The dev container of this Docker Compose devspace is missing, and the configuration ${configPath} uses a single container. Rebuild now switches the devspace to a single container: it removes the containers of the other services and the files outside the volumes; named volumes are kept. Later starts nothing and keeps the containers of the other services. To switch later, choose Rebuild. A Docker Compose configuration of the repository, if it has one, is its own row in the list of devspaces.`,
  /**
   * Later for a devspace whose Docker Compose dev container is missing: nothing can start without the switch, so
   * nothing is removed and nothing starts.
   */
  composeDevContainerMissing: (configPath: string) =>
    `The dev container of this Docker Compose devspace is missing, and the configuration ${configPath} uses a single container. The containers of the other services are kept. Rebuild the devspace to switch it to a single container, or start the row of a Docker Compose configuration of the repository, if it has one.`,
  /**
   * The configuration builds from a Dockerfile or a build context that does not exist in the repository. Not a refusal:
   * the existing devspace still starts.
   */
  buildFileMissing: (what: string) => `The configuration names ${what}, which does not exist in the repository. Nothing was built.`,
  /** Docker Compose could not read the compose files of a configuration (the details have its message). */
  composeConfigurationFailed: 'The Docker Compose files of this configuration could not be read. The details show why.',
  noConfiguration: (repository: string) => `The repository ${repository} has no Dev Container configuration.`,
  configurationNotFound: (configPath: string, configurationName: string) =>
    `The configuration ${configPath} does not exist on this branch. The configuration ${configurationName} is used.`,
  computerDependent: (items: string) =>
    `This configuration uses files on your computer (${items}). This does not work, because the repository is stored in a Docker volume.`,
  hostAccess: (items: string) =>
    `This configuration needs access to your computer, which Devspaces does not allow: ${items}. Change the configuration of the repository.`,
  /**
   * Settings that the host access policy does not know, so it cannot tell what they do, and values that work against
   * how the extension runs the container, for example `--restart=always`.
   */
  unsupportedOptions: (items: string) =>
    `This configuration uses options that Devspaces does not support: ${items}. Change the configuration of the repository.`,
  /**
   * The host access analysis of the configuration failed (its worker ran out of time or memory, or crashed): refused,
   * never allowed. The text is ANALYSIS_FAILED_ITEM of helper/configurationAnalysis.ts.
   */
  configurationTooComplex: (item: string) => `${item}. Change the configuration of the repository.`,
  /**
   * The analysis of the configuration could not run (its worker did not start, or crashed without an answer): no fault
   * of the configuration. The item is analysisInternalItem of helper/configurationAnalysis.ts.
   */
  configurationCheckInternal: (item: string) => `${item}. Try again; if it fails again, reinstall Devspaces.`,
  /**
   * Docker could not answer the check of the image references (a timeout, a daemon that cannot be reached): no fault of
   * the configuration, nor of the installation. The item is dockerCheckItem of helper/configurationAnalysis.ts.
   */
  configurationCheckDocker: (item: string) => `${item}. Check that Docker is running and try again.`,
  /**
   * The check of the new devspace image of an update failed (not a refusal of the policy): the old one starts, and
   * the next open tries the update again. The item says why (ANALYSIS_FAILED_ITEM or analysisInternalItem).
   */
  updateCheckFailed: (item: string) => `The configuration could not be checked. Try again. (${item}.) The devspace is started without the update.`,
  /** Both: settings that need access to the computer, and settings that the policy does not know. */
  hostAccessAndUnsupported: (items: string, unsupported: string) =>
    `This configuration needs access to your computer, which Devspaces does not allow: ${items}. It also uses options that Devspaces does not support: ${unsupported}. Change the configuration of the repository.`,
  /**
   * The check of the new devspace image of an update failed for a size limit (the item is ANALYSIS_FAILED_ITEM); the
   * old one starts, and the same update is not built again.
   */
  updateTooLarge: (item: string) => `The newer image of the devspace is too large or too complex to check (${item}). The devspace is started without the update.`,
  /** The new devspace image of an update was refused by the host access policy; the old one starts. */
  updateRefused: (items: string) =>
    `The newer image of the devspace needs access to your computer, which Devspaces does not allow: ${items}. The devspace is started without the update.`,
  /** A container of an older version of the extension is created again. */
  containerRecreated:
    'Devspaces was updated, so the container of the devspace is set up again. Your files in the repository are kept. Files in other folders of the container, for example in the home folder, are removed.',
  /** A container that was created while the configuration could not be read is created again with it. */
  containerConfigApplied:
    'The configuration of the devspace can be read again, so the container is set up again with it. Your files in the repository are kept. Files in other folders of the container, for example in the home folder, are removed.',
  /**
   * A container that was created while the host access checks were off for the repository is created again once they
   * are on (and the configuration passes them).
   */
  containerHostAccessChecksOn:
    'The host access checks are on again for this repository, so the container is set up again with them. Your files in the repository are kept. Files in other folders of the container, for example in the home folder, are removed.',
  /**
   * The configuration of a devspace of a Docker Compose configuration does not use Docker Compose any more: its
   * container is created again as a single container, and the containers of its other services are removed (their
   * volumes stay).
   */
  // The containers of the other services go; their named volumes stay, and the data in their volumes without a name is
  // not used any more (Docker keeps those volumes as unused volumes).
  containerComposeReplaced:
    'The configuration of the devspace no longer uses Docker Compose, so the container is set up again, and the containers of the other services are removed. Your files in the repository and the data that the services keep in named volumes are kept. Data that the services keep in volumes without a name is no longer used; Docker keeps those volumes as unused volumes. Files in other folders of the container, for example in the home folder, are removed.',
  /**
   * The selected configuration names another service of the same Docker Compose project as its dev container, and the
   * previous dev container could not be renamed out of the way: it is removed (its volumes stay).
   */
  containerComposeDevServiceChanged:
    'The configuration of the devspace uses another service of Docker Compose for the dev container, so the previous dev container is removed and the containers are set up again. Your files in the repository and the data in named volumes are kept. Files in other folders of the previous dev container, for example in the home folder, are removed.',
  /** A single container is replaced by the containers of a Docker Compose configuration. */
  containerComposeCreated:
    'The configuration of the devspace now uses Docker Compose, so the container is set up again with the containers of its services. Your files in the repository are kept. Files in other folders of the container, for example in the home folder, are removed.',
  /**
   * Recreate offer: the modal question when the existing container of a devspace is damaged, so that it cannot be
   * started or used (for example its /etc/passwd lacks the user). `compose`: the containers of a Docker Compose
   * devspace. The detail is containerRecreateDetail.
   */
  containerRecreateQuestion: (repository: string, compose: boolean) =>
    compose
      ? `The dev container of ${repository} cannot be started or used. Recreate it?`
      : `The container of ${repository} cannot be started or used. Recreate it?`,
  /**
   * Recreate offer: what stays and what is lost (the volumes are never removed). `unnamedFolders` are the folders of
   * the damaged container that are volumes without a name (for example `- /workspaces/api/node_modules` in a compose
   * file, `VOLUME /data` in the image): they are not carried over into the new container (unnamedVolumesNotCarried).
   */
  containerRecreateDetail: (compose: boolean, unnamedFolders: readonly string[] = [], withoutConfiguration = false) =>
    (compose
      ? 'Only the dev container is removed and created again from its devspace image. The other services, for example a database, keep running with their data. ' +
        'Kept: the repository with its uncommitted changes, unpushed commits, and stashes, the named volumes of the devspace, and the containers of the other services. ' +
        'Lost: everything else in the dev container, for example installed packages, changes to the system, and files outside /workspaces and the volumes, such as the home folder. '
      : 'The container of the devspace is removed and created again from its devspace image. ' +
        'Kept: the repository with its uncommitted changes, unpushed commits, and stashes, and all files in the named volumes of the devspace. ' +
        'Lost: everything else in the container, for example installed packages, changes to the system, and files outside /workspaces and the volumes, such as the home folder. ') +
    unnamedVolumesNotCarried(unnamedFolders) +
    // A single container created while the configuration cannot be read.
    (withoutConfiguration
      ? 'The configuration cannot be read now, so the new container starts without the runArgs of the configuration (also their mounts) and without its published ports, until the configuration can be read again; then the container is set up again. '
      : '') +
    'The setup commands of the configuration (onCreateCommand, postCreateCommand) run again. Cancel changes nothing.',
  /**
   * Recreate offer: after Recreate, the direct check before `up` found that Docker Compose would also create the
   * containers of other services again (`services`): nothing is changed.
   */
  composeServicesWouldBeRecreated: (services: string) =>
    `The dev container was not created again: Docker Compose would also create the containers of other services again (${services}), which the question promised to keep. Nothing was changed. Rebuild the devspace instead.`,
  /**
   * Recreate offer: after Recreate, the devspace was changed meanwhile (for example by another window): nothing is
   * created again.
   */
  containerChangedMeanwhile:
    'The devspace was changed in the meantime, for example in another window. The container was not created again, and nothing was changed. Try again.',
  /**
   * Recreate offer: the progress detail after the confirmation, as for the other recreations, with the folders in
   * volumes without a name (containerRecreateDetail).
   */
  containerRecreatedDamaged: (unnamedFolders: readonly string[] = []) =>
    'The container of the devspace could not be started, so it is set up again. Your files in the repository and in the named volumes are kept. Files in other folders of the container, for example in the home folder, are removed. ' +
    unnamedVolumesNotCarried(unnamedFolders).trim(),
  /**
   * The modal question of Turn Off Host Access Checks… (docs/security.md "Turning the checks off"), with what the
   * configuration of the repository can then use (hostAccessChecksOffDetail).
   */
  hostAccessChecksOffConfirm: (repository: string) =>
    `Turn off the host access checks for ${repository}? Only do this for a repository that you trust.`,
  hostAccessChecksOffDetail:
    'The configuration of the repository, its Features, and its base image can then use your computer:\n' +
    '• the files and folders of your computer (bind mounts)\n' +
    '• the Docker socket, which gives full control of Docker and of every other devspace, also of other GitHub accounts\n' +
    '• privileged mode, extra capabilities, and security options\n' +
    '• devices and GPUs of your computer\n' +
    '• published ports on all network addresses, so that other computers of the network can reach them\n' +
    '• the volumes of other programs, for example of Docker Compose or of the Dev Containers extension\n\n' +
    'Still checked: the volumes of your other devspaces and of other GitHub accounts, the GitHub account of the devspace, and options that Devspaces does not support. The change applies when the container of the devspace is created next, for example with Rebuild. An existing container keeps its current settings, such as ports that are bound to this computer only.',
  /** After Turn Off Host Access Checks… */
  hostAccessChecksTurnedOff: (repository: string) =>
    `The host access checks are off for ${repository}. They apply again when you turn them on. The change applies when the container of the devspace is created next, for example with Rebuild; an existing container keeps its current settings, such as ports that are bound to this computer only.`,
  /** After Turn On Host Access Checks. */
  hostAccessChecksTurnedOn: (repository: string) =>
    `The host access checks are on again for ${repository}. At the next start, a container that was made without them is set up again, if the configuration passes the checks. Your files in the repository are kept. Files in other folders of that container, for example in the home folder, are removed; copy them out before you start it again.`,
  /** The warning in the tooltip of a repository row whose host access checks are off. */
  hostAccessUnrestrictedTooltip:
    'Warning: the host access checks are off for this repository. Its configuration can use the files, devices, and Docker of your computer.',
  /** The setting defaultImage is no image reference: it is ignored (no default image). */
  defaultImageInvalid: (value: string) =>
    `The setting devspaces.defaultImage is not an image reference like ghcr.io/owner/image:tag. It is ignored: ${value}`,
  /** The setting cacheUpdateSchedule is no schedule that the Monitor takes (parseCacheSchedule): the default applies. */
  cacheUpdateScheduleInvalid: (value: string) =>
    `The setting devspaces.cacheUpdateSchedule is not a cron schedule like 7 6 * * * with at least 5 minutes between its times, and not a number of minutes from 5 to 1440. The Monitor uses the default, daily at 06:07. The value is: ${value}`,
  /** Entries of the setting devspaces.hostAccessChecksOff that are no repository name (`owner/name`). */
  hostAccessChecksOffInvalid: (entries: string) =>
    `The setting devspaces.hostAccessChecksOff has entries that are not a repository name like owner/name. They are ignored: ${entries}`,
  /** Git before 2.9 does not remove the forwarding credential helper with an empty helper. */
  oldGit: (version: string) =>
    `Git ${version} in the devspace is older than version 2.9. It may use the Git credentials of your computer instead of the GitHub account of the devspace. Use an image with a newer Git.`,
  // The CLI resolves ${localEnv:NAME} in the workspace helper: a variable that the helper sets (HOME, PATH, HOSTNAME, and
  // the variables of its image, HELPER_ENV_NAMES) gets the value of the helper, any other one is empty or has its default
  // value. `helperNames`: those of `names` that the helper sets, when the caller knows them.
  localEnvNotPassed: (names: string, helperNames?: string) =>
    `The configuration uses variables of your computer: ${names}. Devspaces does not pass their values to the devspace. ` +
    (helperNames
      ? `The workspace helper sets ${helperNames} to its own values (for example, HOME is /root), not to the values of your computer. The others are empty or have their default value.`
      : 'They are empty or have their default value, except variables that the workspace helper sets itself (for example, HOME is /root).'),
  /**
   * A devspace that a command names belongs to another account, for example a row or the status bar item from
   * before an account change, or an open during which the account changed. Never for a repository: each account has its
   * own devspace of it.
   */
  otherAccount: (repository: string) =>
    `The devspace of ${repository} belongs to another GitHub account. Sign in with that account to use it.`,
  otherAccountConnection: (repository: string) =>
    `The devspace of ${repository} does not belong to the GitHub account that is signed in. This window closes its connection.`,
  gitSetupFailed: 'Git in the devspace could not be prepared. Pushing to GitHub may not work.',
  untrustedRepository: (repository: string) =>
    `${repository} does not belong to you or to one of your organizations. Opening it runs code from the repository (Dockerfile, Features, and commands) on your computer. Open it?`,
  signInRequired: 'Sign in with GitHub to use Devspaces.',
  opening: (repository: string) => `Opening ${repository}…`,
  deleteConfirm: (repository: string) =>
    `Delete the devspace of ${repository}? The container and the files in the devspace are removed.`,
  /** The recorded state is older than the last use of the devspace. */
  deleteChangesUnknownSince: (time: string) => `Changes made in the devspace after ${time} are not known.`,
  /** No state was recorded since the devspace was last used. */
  deleteChangesNotRecorded: 'Changes made in the devspace since it was last opened are not known.',
  deleteUnsaved: (repository: string, changes: string) =>
    `The devspace of ${repository} has ${changes}. These changes are lost when you delete the devspace.`,
  /**
   * The paths of the repository that the other services of Docker Compose mount (Devspace.serviceFolders): they are
   * in the workspace volume, so Delete removes them with the repository; the confirmation names them, as the question
   * about the data volumes of the services names those.
   */
  deleteRepositoryServiceData: (folders: string) => `Service data in the repository will be deleted: ${folders}.`,
  deleteAdditionalVolumes: (volumes: string) =>
    `The devspace also used these volumes: ${volumes}. Remove them too?`,
  /**
   * The title of the question of Delete about the volumes of the Docker Compose project (the data of its services), a
   * list in which the user ticks the volumes to remove; none is ticked, and nothing ticked keeps them all.
   */
  deleteServiceDataTitle: 'Remove the data of the services too?',
  /** The hint of that list. */
  deleteServiceDataPlaceholder:
    'These volumes hold data of the services of the devspace, for example of a database. Tick the ones to remove; the others are kept. Escape cancels the deletion.',
  /** The description of each volume in that list. */
  deleteServiceDataItem: 'data of the services',
  /**
   * The description of a volume in that list of a devspace whose services are not known (for example one restored
   * from its volumes): it may hold data of a service, or be another additional volume.
   */
  deleteServiceDataPossibleItem: 'additional volume (possibly data of services)',
  /** The hint of that list when it holds such a volume. */
  deleteServiceDataPossiblePlaceholder:
    'These volumes may hold data of the services of the devspace, for example of a database. Tick the ones to remove; the others are kept. Escape cancels the deletion.',
  helperFailed: 'The workspace helper could not be prepared.',
  /**
   * The refresh of the sidebar found no helper image; it never builds one. The window builds it in the background
   * (MissingHelperBuild).
   */
  helperImageNotPresent:
    'The workspace helper image is not on this Docker engine (or could not be checked); this window builds it in the background (or the next Start, Stop or Delete does).',
  /**
   * A helper step of an open needs the batch helper of the operation (one per operation, through the worker that holds
   * the lock), and it could not be used; the open was refused, and nothing was run without it. Also a running, current
   * container is not opened as it is then (BatchHelperUnavailableError, src/core/errors.ts).
   */
  batchHelperUnavailable: (cause: string) =>
    `The workspace helper of this operation could not be used (${cause}), so the operation was stopped and nothing was run without it. Check that Docker runs (see the Devspaces output), then try again.`,
  /**
   * A plain Docker call of an operation, or the refresh of the states, needs the worker on the Docker host, and it
   * could not be made ready (the helper image, the open); the call was refused and nothing was run directly. As
   * PipelineTexts.devspaceLockUnavailable.
   */
  workerUnavailable: (cause: string) =>
    `The Devspaces worker on the Docker host could not be prepared (${cause}), so nothing was run. Check that Docker runs and that the workspace helper image can be built (see the Devspaces output), then try again.`,
  /**
   * The Monitor container of the engine could not be started at an open, so the open was refused (the user
   * error `sessionMonitorFailed`, isSessionMonitorFailed).
   */
  sessionMonitorUnavailable: (repository: string, cause: string) =>
    `${repository} was not opened: the Monitor on the Docker engine could not be started (${cause}). Without it, a devspace that no window uses any more would not be stopped. Check that Docker runs (see the Devspaces output), then try again.`,
  /**
   * The Monitor of the engine could not be ensured again right after the container of an open started (it may
   * have exited when idle during the clone and the build). The open goes on. `engine` is undefined when the Docker
   * target could not be read.
   */
  sessionMonitorAfterStartFailed: (repository: string, engine: string | undefined, cause: string) =>
    `The Monitor on ${engine === undefined ? 'the Docker engine' : engine === 'the local Docker' ? engine : `the Docker host ${engine}`} could not be started after the container of ${repository} started (${cause}). Until it runs, the container is not stopped when no window uses it any more; a window connected to it keeps trying. Check that Docker runs (see the Devspaces output).`,
  /**
   * The heartbeats of this window to the Monitor of the engine of its devspace failed
   * HEARTBEAT_WARN_AFTER_FAILURES times in a row (once per failure streak).
   */
  heartbeatsFailing: (repository: string, engine: string, minutesLeft: number) =>
    `Devspaces cannot reach the Monitor on ${engine === 'the local Docker' ? engine : `the Docker host ${engine}`}. If this goes on, it may stop the container of ${repository} ${
      minutesLeft <= 0 ? 'at any moment' : `in about ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}`
    }. Check that Docker runs (see the Devspaces output); the window keeps trying.`,
  /**
   * The helper image could not be prepared at Step 5 of a Rebuild or of the switch to a newly selected configuration,
   * and the running container, which is current, opened as it is. `change` names what was not applied; with a selected
   * configuration, `previous` names the configuration that stays selected. (A helperFailed in Step 8 ends the open
   * instead.)
   */
  helperFailedOpenedAsItIs: (change: 'rebuild' | 'configuration', previous?: string) =>
    `The workspace helper could not be prepared. The running devspace is opened as it is: ${
      change === 'configuration'
        ? `the selected configuration was not applied${previous !== undefined ? `, and ${previous} stays selected` : ''}`
        : 'it was not rebuilt'
    }. Open it again to try again.`,
  /**
   * The lifecycle commands of a container could not run (the workspace helper failed), it still runs, and the registry
   * could not record that (Devspace.lifecycleIncomplete).
   */
  lifecycleNotRecorded: (repository: string) =>
    `The container of ${repository} runs without its lifecycle commands, and this could not be recorded. Stop or rebuild the devspace before working in it.`,
  cloneFailed: 'The repository could not be downloaded.',
  noDevspace: (repository: string) => `${repository} has no devspace.`,
  /**
   * The remote Docker host (the current Docker context, `ssh://…`) did not answer. `reason` is one of dockerHostReason.
   * Shown instead of the start of Docker Desktop and of the Docker setup.
   */
  dockerHostUnreachable: (host: string, reason: string) => `The Docker host ${host} cannot be reached. ${reason}`,
  /** The current Docker context points to another computer without SSH (for example `tcp://`). */
  dockerEndpointUnsupported: (endpoint: string) =>
    `Docker is set to ${endpoint}. Devspaces uses Docker on another computer only over SSH. Choose "Devspaces: Use a Remote Docker Host…" or "Devspaces: Use the Local Docker".`,
  /**
   * The current Docker context could not be read (`docker context inspect` failed, and DOCKER_HOST is not set): the
   * Docker calls could reach another computer than the one that the devspaces record, so nothing is done.
   */
  dockerContextUnreadable:
    'Devspaces cannot read the current Docker context, so it does not know which Docker to use. It does nothing with Docker until it can read the context. Run "docker context inspect" in a terminal to see the problem, or choose "Devspaces: Use the Local Docker" or "Devspaces: Use a Remote Docker Host…".',
  /** The Docker host of a context that could not be read, in other texts ("Docker is set to …"). */
  unreadableDockerContextHost: 'a Docker context that cannot be read',
  /** The view's title and the first row of the sidebar while the current Docker context cannot be read. */
  dockerContextUnreadableLabel: 'Docker context cannot be read',
  /** The tooltip of that row. */
  dockerContextUnreadableTooltip: 'Devspaces cannot read the current Docker context, so it does nothing with Docker. Click to choose the Docker host.',
  /** The Docker host of a docker command that uses Podman (podmanDockerTarget), in other texts ("Docker is set to …"). */
  podmanDockerHost: 'Podman (not supported)',
  /** The view's title and the first row of the sidebar while the docker command uses Podman (podmanDockerTarget). */
  podmanNotSupportedLabel: 'Podman is not supported',
  /** The tooltip of that row. */
  podmanNotSupportedTooltip:
    'The docker command on this computer uses Podman. Devspaces does not support Podman, so it does nothing with Docker. It needs Docker: Docker Desktop, or Docker Engine on Linux.',
  /**
   * The window is not connected, because the container did not answer as running on the Docker host that the window
   * uses (checked right before the window connects).
   */
  containerNotReady: (repository: string, container: string) =>
    `The container ${container} of ${repository} does not run. Its state is in the details; start ${repository} again when the cause is fixed.`,
  /**
   * The pipeline ran, but the current Docker context changed to another host meanwhile, so the window does not connect.
   * The container stays on its host.
   */
  otherDockerHostAfterStart: (repository: string, devspaceHost: string, currentHost: string) =>
    `The devspace of ${repository} runs on ${describeHost(devspaceHost)}, but Docker is now set to ${describeHost(currentHost)}, so this window does not connect to it. Choose "Devspaces: Use a Remote Docker Host…" or "Devspaces: Use the Local Docker" for ${describeHost(devspaceHost)}, then start ${repository} again.`,
  /** A devspace of another Docker host is never acted on. */
  otherDockerHost: (repository: string, devspaceHost: string, currentHost: string) =>
    `The devspace of ${repository} is on ${describeHost(devspaceHost)}, but Docker is set to ${describeHost(currentHost)}. Nothing was changed.`,
} as const;

/**
 * Recreate offer: the sentence about the folders of the damaged container that are volumes without a name, or ''
 * without such folders. Ends with a space.
 */
function unnamedVolumesNotCarried(folders: readonly string[]): string {
  if (folders.length === 0) return '';
  return `These folders are volumes without a name, which are not carried over: in the new container they start as the image has them (often empty), and their old content stays in a Docker volume without a name: ${listSome(folders)}. `;
}

function describeHost(host: string): string {
  return host === '' ? 'the local Docker' : host;
}

/** The plain reason of a failed connection to the remote Docker host `host` (see dockerHostProblem). */
export function dockerHostReason(
  problem: 'unreachable' | 'closedBeforeLogin' | 'login' | 'hostKey' | 'dockerMissing' | 'dockerNotRunning' | 'dockerPermission' | 'sshMissing' | 'unknown',
  host: string,
): string {
  switch (problem) {
    case 'unreachable':
      return 'The computer does not answer. Check its name and the network connection.';
    case 'closedBeforeLogin':
      return 'Its SSH server closed the connection before the login. It may limit new connections, for example after failed logins or while many open at once. Wait a minute, then try again. Connection sharing in your SSH config (ControlMaster auto with ControlPersist) lets every Docker call use one connection.';
    case 'login':
      return 'SSH could not log in. Add your SSH key to the SSH agent (ssh-add) or name it in your SSH config, then try again.';
    case 'hostKey':
      return `SSH does not know the host key of this computer yet. Run "${sshCommandLine(host)}" once in a terminal, check the key and accept it, then try again.`;
    case 'dockerMissing':
      return 'Docker is not installed on that computer.';
    case 'dockerNotRunning':
      return 'Docker is not running on that computer.';
    case 'dockerPermission':
      return 'Your user on that computer may not use Docker. Add it to the group docker there.';
    case 'sshMissing':
      return 'The SSH client (ssh) was not found on this computer.';
    case 'unknown':
      return 'The details show why.';
  }
}

export const Actions = {
  /** Shows the sidebar view with the steps of the Docker setup (action of the error dockerNotInstalled). */
  installDocker: 'Install Docker…',
  /** Starts Docker Engine on Linux with `sudo systemctl enable --now docker` in a terminal, after a confirmation (action
   *  of the error dockerEngineNotRunning). */
  startDocker: 'Start Docker',
  showDetails: 'Show details',
  tryAgain: 'Try again',
  signIn: 'Sign in',
  authorize: 'Authorize',
  rebuildNow: 'Rebuild now',
  later: 'Later',
  cloneAgain: 'Clone again',
  deleteDevspace: 'Delete devspace',
  openDevspace: 'Open devspace',
  deleteAnyway: 'Delete anyway',
  delete: 'Delete',
  remove: 'Remove',
  keep: 'Keep',
  open: 'Open',
  cancel: 'Cancel',
  continue: 'Continue',
  /** The button of the question Messages.containerUpdateQuestion (with Later). */
  updateNow: 'Update Now',
  /** The button of the modal question of the recreate offer (Messages.containerRecreateQuestion). */
  recreateContainer: 'Recreate',
  /** The button of the modal question of Turn Off Host Access Checks…. */
  turnOffChecks: 'Turn Off Checks',
  /** The button of a warning about the value of a setting: opens the Settings editor at that setting. */
  openSettings: 'Open Settings',
  /**
   * The button of a warning about the setting repositoryGroups: the title of the command devspaces.editRepositoryGroups,
   * which opens the editor of the setting with its preview.
   */
  editRepositoryGroups: 'Edit Repository Groups…',
} as const;

export const StateTexts = {
  connected: 'Connected',
  connectedOtherWindow: 'Connected · other window',
  running: 'Running',
  stopped: 'Stopped',
  updating: 'Updating',
  noContainer: 'No container',
  filesMissing: 'Files missing',
  /**
   * The state text of a devspace whose Docker engine the last refresh could not read (TreeInput.statesUnknown),
   * shown instead of the state that the registry alone would give.
   */
  unknown: 'State unknown',
  notOnGitHub: 'not on GitHub',
  /** The marker of a repository whose host access checks are off. */
  hostAccessUnrestricted: 'host access unrestricted',
  /**
   * The suffix of the state text of a kept devspace whose container runs or is stopped, for example `Running · kept`
   * or `Stopped · kept` (Keep Running When Closed).
   */
  kept: 'kept',
  /**
   * The suffix of the state text of a devspace whose dev container does not run while another service of Docker
   * Compose runs (or another dev container of the devspace), for example `Stopped · containers running` (Stop stays
   * offered).
   */
  servicesRunning: 'containers running',
} as const;

/** The most names that one message lists. */
export const MAX_LISTED_NAMES = 20;

/**
 * `items` joined with `, `, at most `max` of them, then `and <n> more`, so that a configuration with thousands of names
 * gives a message of normal length.
 */
export function listSome(items: readonly string[], max = MAX_LISTED_NAMES, separator = ', '): string {
  if (items.length <= max) return items.join(separator);
  return `${items.slice(0, max).join(separator)}${separator}and ${items.length - max} more`;
}

/** Formats the change counts of a Git summary, for example `2 uncommitted · 3 unpushed`. Empty when there are no changes. */
export function formatChanges(summary: { uncommittedFiles: number; unpushedCommits: number; stashes?: number }): string {
  const parts: string[] = [];
  if (summary.uncommittedFiles > 0) parts.push(`${summary.uncommittedFiles} uncommitted`);
  if (summary.unpushedCommits > 0) parts.push(`${summary.unpushedCommits} unpushed`);
  if (summary.stashes && summary.stashes > 0) parts.push(`${summary.stashes} stashed`);
  return parts.join(' · ');
}

/**
 * The last time the devspace was seen in use, for Delete's note: the later of `lastSeenInUseAt` (a window that
 * started connected to it, a reload, and the start of each release) and `lastUsedAt` (the open pipeline), as valid
 * times; the one that is valid when the other is missing or invalid; `undefined` when neither is.
 */
export function lastSeenInUse(devspace: { lastUsedAt?: string; lastSeenInUseAt?: string }): string | undefined {
  const candidates = [devspace.lastSeenInUseAt, devspace.lastUsedAt].filter(
    (value): value is string => value !== undefined && Number.isFinite(Date.parse(value)),
  );
  if (candidates.length === 0) return undefined;
  return candidates.reduce((best, value) => (Date.parse(value) > Date.parse(best) ? value : best));
}

/**
 * The note of Delete's confirmation when the recorded state of the repository may be out of date: it was recorded
 * before the devspace was last used (`lastUsedAt`), or never. Empty when it is at least as new as the last use, or
 * when that time is not known. `format` gives the time for the user (default: the locale of the process). Starts with a
 * space when not empty.
 */
export function recordedStateNote(
  summary: { recordedAt: string } | undefined,
  lastUsedAt: string | undefined,
  format: (isoTime: string) => string = (isoTime) => new Date(isoTime).toLocaleString(),
): string {
  const usedAt = lastUsedAt === undefined ? Number.NaN : Date.parse(lastUsedAt);
  if (!Number.isFinite(usedAt)) return '';
  const recordedAt = summary === undefined ? Number.NaN : Date.parse(summary.recordedAt);
  if (summary === undefined || !Number.isFinite(recordedAt)) return ` ${Messages.deleteChangesNotRecorded}`;
  return recordedAt >= usedAt ? '' : ` ${Messages.deleteChangesUnknownSince(format(summary.recordedAt))}`;
}
