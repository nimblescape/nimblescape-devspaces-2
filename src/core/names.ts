// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Names and labels (docs/architecture.md "Naming").
import * as crypto from 'crypto';
import { namePair, trailingPair } from './namePairs';
import { LABEL_MONITOR_CREATE, LABEL_MONITOR_OWNER, LABEL_MONITOR } from './remoteMonitor/protocol';

/**
 * Labels of the helper channel. Here, not in src/core/helperChannel/protocol.ts, so that the script of the remote
 * Monitor, which imports names.ts, does not bundle the protocol of the channel (its script has to fit on the
 * command line of `docker run`).
 */
/** Label of the container of a channel (its value: channelLabelValue). */
export const LABEL_HELPER_CHANNEL = 'nimblescape.devspaces.worker-channel';
/**
 * The label of the containers that an operation starts and removes by it, never by a name: the session label of a batch
 * helper (`nimblescape.devspaces.channel-step=<session>`, channelStepLabel), which the worker removes by that label
 * (src/helperChannel/batch.ts).
 */
export const LABEL_CHANNEL_STEP = 'nimblescape.devspaces.channel-step';

/**
 * The prefix of every label key of the extension (EXTENSION_LABEL_KEYS), with the name of its publisher: other tools
 * use `devspace.…` too (for example `devspace.fingerprint` of an image tool named devspace), so that prefix alone could
 * collide with their labels.
 */
export const LABEL_PREFIX = 'nimblescape.devspaces.';

export const LABEL_DEVSPACE_ID = 'nimblescape.devspaces.id';

/**
 * The `--id-label` of every run of the Dev Container CLI for the devspace `devspaceId` (read-configuration and
 * `up`): the CLI computes `${devcontainerId}` from it (devspaceDevcontainerId in ./helper/cliVariables.ts).
 */
export function devspaceIdLabel(devspaceId: string): string {
  return `${LABEL_DEVSPACE_ID}=${devspaceId}`;
}
export const LABEL_REPOSITORY = 'nimblescape.devspaces.repository';
/** Volume label: the GitHub user ID of the account that created the devspace. */
export const LABEL_OWNER_ID = 'nimblescape.devspaces.owner-id';
/**
 * On the workspace volume of a default-image devspace: the default image it was created from (DevspaceSource
 * `defaultImage`). Absent on the volume of a configuration devspace. With it, a lost registry gets the kind of the
 * devspace back (devspaceOfVolume).
 */
export const LABEL_DEFAULT_IMAGE = 'nimblescape.devspaces.default-image';
/**
 * Volume label of the additional volumes that the extension creates before `up` (the named volumes that a configuration
 * mounts), with the value VOLUME_KIND_ADDITIONAL. Such a volume also carries nimblescape.devspaces.id,
 * nimblescape.devspaces.owner-id, and nimblescape.devspaces.repository of its devspace: only these labels make a volume
 * the devspace's own (isOwnVolume).
 */
export const LABEL_VOLUME = 'nimblescape.devspaces.volume';
export const VOLUME_KIND_ADDITIONAL = 'additional';
/**
 * nimblescape.devspaces.volume of a named volume of the Compose project of a devspace (`<project>_<key>`, composeProjectName, the
 * data of its services, for example of a database): created by the extension before `up` with the labels of the
 * devspace, never shared with another devspace, and removed by Delete only when the user asks for it.
 */
export const VOLUME_KIND_COMPOSE = 'compose';
/**
 * Volume label, with the value SERVICE_DATA: a volume that the extension created before `up` for a service of Docker
 * Compose other than the dev service (it holds the data of that service, for example of a database), whatever its
 * nimblescape.devspaces.volume. Delete lists such a volume in the question about the data of the services, none ticked,
 * also after a lost registry (reconcileFromVolumes restores Devspace.serviceVolumes from it).
 */
export const LABEL_SERVICE_DATA = 'nimblescape.devspaces.service-data';
export const SERVICE_DATA = 'true';
/**
 * Container label of the containers of a Compose devspace other than the dev container: the name of their service.
 * They carry nimblescape.devspaces.id too, so Stop, the Monitor, and Delete find them; the lookup of
 * the dev container skips them.
 */
export const LABEL_COMPOSE_SERVICE = 'nimblescape.devspaces.compose-service';
/** Container label: the version of the container setup (CONTAINER_VERSION). */
export const LABEL_CONTAINER_VERSION = 'nimblescape.devspaces.container-version';
/**
 * Version of the container setup. A container without the label, or with an older value, is not current
 * (containerIsCurrent): it is created again from its devspace image, and the volume stays. Raise it when a change of
 * the setup needs existing containers to be created again.
 */
export const CONTAINER_VERSION = 1;
/**
 * Container label: `unknown` when the container was created without the configuration of the repository (it could not
 * be read), so without its runArgs and appPort. Such a container is created again once the configuration can be read.
 */
export const LABEL_CONTAINER_CONFIG = 'nimblescape.devspaces.container-config';
export const CONTAINER_CONFIG_UNKNOWN = 'unknown';
/**
 * Container label: the path of the configuration of the repository that the container was created for
 * (Devspace.configPath, for example `.devcontainer/python/devcontainer.json`), on the dev container that `up`
 * creates (a single container, or the dev service of Docker Compose; not the other services), when
 * isConfigPathLabelValue takes the path. reconcileFromVolumes restores the configuration path of an entry from it after
 * a lost registry; without it, the entry gets the default configuration.
 */
export const LABEL_CONFIG_PATH = 'nimblescape.devspaces.config-path';
/** `--label` value of the override configuration of a single container: LABEL_CONFIG_PATH with its value. */
export function configPathLabel(configPath: string): string {
  return `${LABEL_CONFIG_PATH}=${configPath}`;
}
/**
 * Whether a value of LABEL_CONFIG_PATH is a configuration path of a repository as the discovery finds them: relative,
 * `.devcontainer/devcontainer.json`, `.devcontainer/<folder>/devcontainer.json`, or `.devcontainer.json`. The folder as
 * the discovery takes it (isValidFolderName of detect.ts): not empty, not `.` or `..`, without `/`; a backslash and
 * white space are allowed.
 */
export function isConfigPathLabelValue(value: string): boolean {
  if (value === '.devcontainer.json' || value === '.devcontainer/devcontainer.json') return true;
  const match = /^\.devcontainer\/([^/]+)\/devcontainer\.json$/.exec(value);
  return match !== null && match[1] !== '.' && match[1] !== '..';
}
/** `--label` value of the override configuration: the version of the container setup. */
export const CONTAINER_VERSION_LABEL = `${LABEL_CONTAINER_VERSION}=${CONTAINER_VERSION}`;
/** `--label` value of the override configuration of a container created without the configuration of the repository. */
export const CONTAINER_CONFIG_UNKNOWN_LABEL = `${LABEL_CONTAINER_CONFIG}=${CONTAINER_CONFIG_UNKNOWN}`;
/**
 * Container label of a container that was created while the host access checks were off for its repository (setting
 * devspaces.hostAccessChecksOff), with the value HOST_ACCESS_UNRESTRICTED. Once the checks are on again, such a
 * container is not current (containerIsCurrent): it is created again after the checks pass.
 */
export const LABEL_HOST_ACCESS = 'nimblescape.devspaces.host-access';
export const HOST_ACCESS_UNRESTRICTED = 'unrestricted';
/** `--label` value of the override configuration of a container created while the host access checks were off. */
export const HOST_ACCESS_UNRESTRICTED_LABEL = `${LABEL_HOST_ACCESS}=${HOST_ACCESS_UNRESTRICTED}`;
/**
 * nimblescape.devspaces.host-access of a container of Docker Compose that was created while the host access checks were
 * on: the model sets the label on every service explicitly, so that a label of the image (for example of a side service
 * that Compose builds during `up`) cannot decide it.
 */
export const HOST_ACCESS_CHECKED = 'checked';
/**
 * Label that Docker Compose gives each container, network, and volume of a project (the pipeline, the worker's Docker
 * and the host access policy read it).
 */
export const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
/**
 * `--label` values of the override configuration of a single container: the labels by which Docker Compose finds the
 * containers of a project, with empty values, so that labels that the image inherited (for example of an image that
 * Compose built for another project) cannot make `docker compose -p <project> down` of the user remove the dev
 * container.
 */
export const COMPOSE_CLEARED_LABELS: readonly string[] = ['com.docker.compose.project=', 'com.docker.compose.service='];
export const LABEL_HELPER = 'nimblescape.devspaces.worker';
export const LABEL_HELPER_RUN = 'nimblescape.devspaces.worker-run';
/**
 * A label with a random nonce per build of BootstrapDocker.buildImage, by which it finds the ID of the image that the
 * build made (`docker image ls --filter label=…`).
 */
export const LABEL_BUILD_ID = 'nimblescape.devspaces.build-id';
/**
 * A label of the devspace image (EngineDocker.labelImage, after each build), with the build record of that image as
 * JSON, next to nimblescape.devspaces.id, nimblescape.devspaces.repository, and
 * nimblescape.devspaces.owner-id. The open of a devspace that another computer created, or of one restored after a
 * lost registry, takes the record from its newest image (imageBuildRecord), so its image check works as on the first
 * computer.
 */
export const LABEL_BUILD_RECORD = 'nimblescape.devspaces.build-record';
/**
 * A label of the prepared devspace image (preparedImageName), which a background prepare builds before an open needs
 * it: as JSON its prepare key (the configuration and the digests of the update, as the open computes them: updateKey)
 * and the ID of the helper image that built it (PreparedImageLabel). Next to the devspace ID, repository, and owner
 * labels. The open uses the image only when all of them fit (preparedImageMismatch), and sets the label empty when it
 * takes the image over as its devspace image.
 */
export const LABEL_PREPARED = 'nimblescape.devspaces.prepared';
/**
 * Every label key that the extension reads or writes (on containers, images, and volumes), each with LABEL_PREFIX, in
 * lower case. The host access policy refuses every key with LABEL_PREFIX in a configuration and on images
 * (isReservedLabel in ./policy/rules.ts), these and any later one: such a label would hide a container or volume from
 * the lookups of the extension, or make it look like one of another devspace. A test (names.test.ts) fails for a
 * label with LABEL_PREFIX in the code of src that is not in this set, and for a `devspace.…` or `devspaces.…` label
 * there (other than the IDs of the extension in VS Code).
 */
export const EXTENSION_LABEL_KEYS: ReadonlySet<string> = new Set([
  LABEL_DEVSPACE_ID,
  LABEL_REPOSITORY,
  LABEL_OWNER_ID,
  LABEL_VOLUME,
  LABEL_SERVICE_DATA,
  LABEL_COMPOSE_SERVICE,
  LABEL_CONTAINER_VERSION,
  LABEL_CONTAINER_CONFIG,
  LABEL_CONFIG_PATH,
  LABEL_DEFAULT_IMAGE,
  LABEL_HOST_ACCESS,
  LABEL_HELPER,
  LABEL_HELPER_RUN,
  LABEL_BUILD_ID,
  LABEL_BUILD_RECORD,
  LABEL_PREPARED,
  LABEL_MONITOR,
  LABEL_MONITOR_CREATE,
  LABEL_MONITOR_OWNER,
  LABEL_HELPER_CHANNEL,
  LABEL_CHANNEL_STEP,
]);
export const HELPER_CACHE_VOLUME = 'devspaces-worker-cache';
/**
 * Mount point of the cache volume HELPER_CACHE_VOLUME in the workspace helper (`--user-data-folder` of the CLI).
 * Assumption: the CLI keeps data there that is useful across helper runs. CLI 0.89.0 downloads Features into a new
 * folder below os.tmpdir() for each build, so the Features themselves are not cached there.
 */
export const HELPER_CACHE_FOLDER = '/devspace-cache';
/** Path of the Docker socket inside the workspace helper, and the default source of its socket mount (helperDockerSocket). */
export const HELPER_DOCKER_SOCKET = '/var/run/docker.sock';
/** Mount point of the workspace volume, in the helper and in the dev container. */
export const WORKSPACES_ROOT = '/workspaces';
/**
 * Folder of the container's own Git and Docker configuration in the workspace volume. A repository name only has
 * `[A-Za-z0-9._-]`, so no repository folder `/workspaces/<name>` can have this name.
 */
export const CONFIG_FOLDER = `${WORKSPACES_ROOT}/.devspace+`;
/** The global Git configuration of the container (GIT_CONFIG_GLOBAL). */
export const GIT_CONFIG_FILE = `${CONFIG_FOLDER}/gitconfig`;
/**
 * The folder of the token of the owner account in the dev container, a tmpfs (TOKEN_TMPFS) that the override
 * configuration adds (single container: runArgs; Docker Compose: `tmpfs` of the dev service in the up model). It is in
 * memory only: its files are gone when the container stops, and they are never in the workspace volume (the kernel may
 * swap the tmpfs to the swap space of the computer or the Docker VM). The extension writes it after each start of an
 * open (TOKEN_WRITE_SCRIPT), owned by the remote user, mode 0700. No configuration of a repository may mount anything
 * at or below it (configFolderTarget).
 */
export const TOKEN_FOLDER = '/run/devspace';
/**
 * The `--tmpfs` value (and the entry of `tmpfs` of the dev service of Docker Compose) of TOKEN_FOLDER: 1 MiB, no programs,
 * no devices, no set-user-ID, only root may enter until the extension gives the folder to the remote user.
 */
export const TOKEN_TMPFS = `${TOKEN_FOLDER}:rw,nosuid,nodev,noexec,size=1m,mode=0700`;
/** The token of the owner account, mode 0600, owned by the remote user (in TOKEN_FOLDER, not in the volume). */
export const GITHUB_TOKEN_FILE = `${TOKEN_FOLDER}/github-token`;
/** DOCKER_CONFIG of the container. */
export const DOCKER_CONFIG_FOLDER = `${CONFIG_FOLDER}/docker`;
/**
 * GH_CONFIG_DIR of the container: the configuration folder of the GitHub CLI (gh), in TOKEN_FOLDER, because gh reads
 * its sign-in (hosts.yml) from this folder. Its other file, config.yml (no secret: gh writes the accounts and their
 * tokens only to hosts.yml), is a link to GH_VOLUME_CONFIG_FILE, so the settings of the user survive a stop.
 */
export const GH_CONFIG_FOLDER = `${TOKEN_FOLDER}/gh`;
/**
 * The sign-in of the GitHub CLI: the account that owns the devspace, with the token of GITHUB_TOKEN_FILE, mode 0600.
 * Written again at each open (TOKEN_WRITE_SCRIPT).
 */
export const GH_HOSTS_FILE = `${GH_CONFIG_FOLDER}/hosts.yml`;
/** The folder of the GitHub CLI in the volume (only for config.yml, the settings of gh without a secret). */
export const GH_VOLUME_FOLDER = `${CONFIG_FOLDER}/gh`;
/** gh's config.yml in the volume; GH_CONFIG_FOLDER/config.yml is a link to it. */
export const GH_VOLUME_CONFIG_FILE = `${GH_VOLUME_FOLDER}/config.yml`;

/**
 * The volume of the shared VS Code servers of an engine, one per engine. Only the worker writes it (mounted read-write
 * at VSCODE_STORE_DIR); a dev container that an open creates gets it read-only at VSCODE_STORE_TARGET. The host access
 * policy protects the name (a repository never mounts it) and reserves the target. It is never a devspace's volume:
 * never created with the labels of a devspace, never recorded, never offered at Delete.
 */
export const VSCODE_STORE_VOLUME = 'devspaces-vscode';
/** The mount point of the store in the worker (read-write). */
export const VSCODE_STORE_DIR = '/vscode';
/** The mount point of the store in a dev container (read-only); no configuration may mount at or below it. */
export const VSCODE_STORE_TARGET = '/opt/devspace/vscode';
/**
 * The `--mount` value of the store in the override configuration of a single container (and the volume mount of the dev
 * service of Docker Compose): the store `volume` read-only at VSCODE_STORE_TARGET. The host access policy exempts
 * exactly this text in the override configuration (runArgsFindings). It is `volume-nocopy`, so that Docker never copies
 * the image's VSCODE_STORE_TARGET into an empty store (Docker fills an empty volume from the image at container create
 * unless `nocopy`, read-only or not; a repository's image could plant a server there that every dev container of the
 * engine would then link).
 */
export function vscodeStoreMount(volume: string): string {
  return `type=volume,source=${volume},target=${VSCODE_STORE_TARGET},readonly,volume-nocopy`;
}

export function newDevspaceId(): string {
  return crypto.randomUUID();
}

export function splitRepository(repository: string): { owner: string; name: string } {
  const index = repository.indexOf('/');
  if (index <= 0 || index === repository.length - 1) {
    throw new Error(`Invalid repository name: ${repository}`);
  }
  return { owner: repository.slice(0, index), name: repository.slice(index + 1) };
}

const MAX_NAME_LENGTH = 63;

/**
 * The start of the name of everything of a devspace (resourceName), by which the extension finds its images
 * (EngineDocker.listDevspaceImages) and the host access policy tells a devspace image (devspaceImageNames).
 */
export const RESOURCE_NAME_PREFIX = 'devspaces-';

/**
 * Name of everything of a devspace: the workspace volume, the dev container, the repository of the devspace
 * image, and the Docker Compose project (so also the names that Compose derives from it):
 * `devspaces-<owner>-<repository>-<source>-<adjective>-<scientist>`, with the word of the source of the devspace
 * (sourceSegment: `default`, `config`, or the name of an alternative configuration; `segment`) and the pair of the
 * devspace ID (namePair). Lower case, every run of other characters than `[a-z0-9]` as one `-` (an image repository and
 * a Compose project allow no `.` or `_` next to each other), at most 63 characters: a long `<owner>-<repository>` is
 * shortened, the source and the pair are always kept. The full devspace ID is only in the labels. Devspaces of
 * version 0.5.0 and older have no source in their name (no `segment`); they keep it.
 */
export function resourceName(repository: string, devspaceId: string, segment?: string): string {
  const { owner, name } = splitRepository(repository);
  const prefix = RESOURCE_NAME_PREFIX;
  const suffix = `${segment !== undefined ? `-${segment}` : ''}-${namePair(devspaceId)}`;
  let middle = `${owner}-${name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '');
  const room = MAX_NAME_LENGTH - prefix.length - suffix.length;
  if (middle.length > room) middle = middle.slice(0, room);
  middle = middle.replace(/-+$/, '');
  return `${prefix}${middle === '' ? 'x' : middle}${suffix}`;
}

/**
 * Whether `name` has the shape of a name of a devspace (resourceName): `devspaces-<…>-<adjective>-<scientist>`, in any
 * case. Other names that start with `devspaces-` (for example `devspaces-tools-node_modules` of a repository `devspaces-tools`)
 * are names of the repository.
 */
export function isDevspaceResourceName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith(RESOURCE_NAME_PREFIX) && /^[a-z0-9-]+$/.test(lower.slice(RESOURCE_NAME_PREFIX.length)) && trailingPair(lower) !== undefined;
}

/**
 * The longest window part of a worker name (workerNameStart), so that a worker name is short: at most 43 characters
 * up to a number of two digits (`devspaces-` 10, the window part, `-worker` 7, and the number).
 */
const WORKER_WINDOW_LENGTH = 24;

/** Letters that NFKD does not split into a letter and an accent, with the plain letters that a worker name takes. */
const PLAIN_LETTERS: Readonly<Record<string, string>> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  ł: 'l',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ı: 'i',
  ħ: 'h',
  ŧ: 't',
  ŋ: 'n',
};

/**
 * The window part of a worker name (workerNameStart): `windowName` (ConnectionAdapter.windowName: the name of the
 * saved workspace file of the window, else of its first folder; the repository folder in a devspace, for its workers on
 * other engines than the one of the devspace) in lower case,
 * letters without their accents (PLAIN_LETTERS for those that have none to remove), each run of other characters than
 * `[a-z0-9]` as one `-`, without `-` at the ends, and `window` when nothing is left. A longer name is cut to
 * WORKER_WINDOW_LENGTH characters at the end of a word (its last `-` before the cut), or within a word when the words
 * before the cut would keep less than half of the room.
 */
function workerWindow(windowName: string): string {
  const words = windowName
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, (letter) => PLAIN_LETTERS[letter] ?? letter)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // One character more than the room: a `-` there ends a word at the cut.
  const end = words.slice(0, WORKER_WINDOW_LENGTH + 1).lastIndexOf('-');
  const window =
    words.length <= WORKER_WINDOW_LENGTH
      ? words
      : end >= WORKER_WINDOW_LENGTH / 2
        ? words.slice(0, end)
        : words.slice(0, WORKER_WINDOW_LENGTH).replace(/-+$/, '');
  return window === '' ? 'window' : window;
}

/**
 * The name of a worker container without its number, `<base>-worker`, so that `docker ps` tells which VS Code window a
 * worker belongs to: `<base>` is the devspace of the window for its worker on the engine of the devspace
 * (`devspaceName`, its resourceName), which gives for example `devspaces-acme-api-sturdy-kahn-worker`, else the short
 * `devspaces-<window>` (`<window>` is workerWindow of `windowName`), which gives for example `devspaces-api-worker`.
 * openHelperChannel adds a number from 1, which keeps the workers of one name start apart on one engine (two windows of
 * one folder, windows of two computers on one remote engine, and the next worker of a window while Docker still removes
 * the last one): the lowest free number (freeWorkerNumber) when Docker refuses a name that another container has. As
 * the name ends in digits, it never has the shape of a name of a devspace (isDevspaceResourceName, whose pair is
 * letters only). Without `-` before its number, a worker name is never the name of a container of Docker Compose, which
 * names them `<project>-<service>-<number>` (the project of a devspace is resourceName), also not of a service
 * `worker`. Nothing finds a worker by its name (the labels do), and the worker never reads it (readOwnHelper reads its
 * container ID).
 */
export function workerNameStart(windowName: string, devspaceName?: string): string {
  const devspace = devspaceName?.toLowerCase();
  if (devspace !== undefined && isDevspaceResourceName(devspace)) return `${devspace}-worker`;
  return `${RESOURCE_NAME_PREFIX}${workerWindow(windowName)}-worker`;
}

/**
 * The lowest number from 1 whose worker name (`nameStart`, workerNameStart, and the number) is not in `names` (the
 * names of containers of the engine) and not in `inUse` (the numbers whose names Docker refused already).
 */
export function freeWorkerNumber(nameStart: string, names: readonly string[], inUse: ReadonlySet<number>): number {
  const taken = new Set(names);
  let number = 1;
  while (inUse.has(number) || taken.has(workerName(nameStart, number))) number++;
  return number;
}

/** The name of a worker container: `nameStart` (workerNameStart) and `number`. */
export function workerName(nameStart: string, number: number): string {
  return `${nameStart}${number}`;
}

/** Repository part of the devspace image name: resourceName. */
export function devspaceImageRepository(repository: string, devspaceId: string): string {
  return resourceName(repository, devspaceId);
}

/**
 * Compose project of a devspace: resourceName. Stable for the life of the devspace (the Dev Container CLI finds
 * the dev container again only by the project and the service) and unique among the devspaces on a Docker engine
 * (unusedDevspaceId).
 */
export function composeProjectName(repository: string, devspaceId: string): string {
  return resourceName(repository, devspaceId);
}

/** Devspace image: `<resourceName>:<build number>`. */
export function devspaceImageName(repository: string, devspaceId: string, buildNumber: number): string {
  return `${devspaceImageRepository(repository, devspaceId)}:${buildNumber}`;
}

/** The tag of the prepared devspace image (LABEL_PREPARED); never a build number. */
export const PREPARED_IMAGE_TAG = 'prepared';

/**
 * The prepared devspace image, `<resourceName>:prepared`, at most one per devspace. In the repository of the
 * devspace image, so that the removal of the devspace images (each update, Delete) removes a leftover one too.
 */
export function preparedImageName(repository: string, devspaceId: string): string {
  return `${devspaceImageRepository(repository, devspaceId)}:${PREPARED_IMAGE_TAG}`;
}

/**
 * The name that the build model of a prepare of Docker Compose gives a built service other than the dev service,
 * `<resourceName>:prepared-<service>` (the service name lower case, only `[a-z0-9-]`, as composeServiceImage), never
 * `<project>-<service>`, whose image a later `up` of the existing setup would use. In the repository of the devspace
 * image, so that the removal of the devspace images (each update, Delete) removes it too. The Dev Container CLI
 * 0.89.0 builds only the dev service in `devcontainer build`, so no image of this name is made today; the name keeps
 * any build of another service by a prepare away from the names of the setup.
 */
export function preparedServiceImageName(repository: string, devspaceId: string, service: string): string {
  const name = service.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100).replace(/-+$/, '');
  return `${devspaceImageRepository(repository, devspaceId)}:${PREPARED_IMAGE_TAG}-${name || 'service'}`;
}

/** Folder of the repository in the workspace volume, for example `/workspaces/api`. */
export function repositoryFolder(repository: string): string {
  return `${WORKSPACES_ROOT}/${splitRepository(repository).name}`;
}

/**
 * Name of a configuration: the sub-folder, for example `python` for `.devcontainer/python/devcontainer.json`, or
 * `default` for `.devcontainer/devcontainer.json` and `.devcontainer.json`.
 */
export function configurationName(configPath: string): string {
  const match = /^\.devcontainer\/([^/]+)\/devcontainer\.json$/.exec(configPath);
  return match ? match[1] : 'default';
}

/** Folder of the configuration file, relative to the repository root. `.` for `.devcontainer.json`. */
export function configurationFolder(configPath: string): string {
  const index = configPath.lastIndexOf('/');
  return index < 0 ? '.' : configPath.slice(0, index);
}

/**
 * The host name of the container of a repository (`--hostname`, the name that the shell prompt shows instead of the
 * container ID): the repository name in lowercase, each run of characters other than letters, digits, and `-` as one
 * `-`, without `-` at the ends, at most 63 characters (one DNS label). `devspace` when nothing is left.
 */
export function containerHostname(repositoryName: string): string {
  const label = repositoryName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '');
  return label === '' ? 'devspace' : label;
}

/** tmpfs mount of the helper for the token (only for runs with `secrets: true`). */
export const SECRETS_FOLDER = '/run/devspace-secrets';
/**
 * The folder of the batch helper in which the Docker socket is mounted, which only root can enter (the image creates it
 * 0700; the helper checks it), so the Git user of the helper cannot reach it. The helper links /var/run/docker.sock to
 * it for its root steps (the default of the Docker CLI and the Dev Container CLI; DOCKER_HOST is never set). Defined
 * here, so that the host access policy names it too (isHelperPath).
 */
export const BATCH_SOCKET_FOLDER = '/run/devspace-docker';
