// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Volumes and networks of the container policy: which named volumes a mount may use (its own, an additional volume of
// a devspace of the same owner) and which belong to something else (another devspace or account, the workspace
// helper, another program), and the networks of other devspaces. Account separation: refused whatever the switch
// says (class `protected`), a volume of another program is access to the computer. Pure functions, no I/O.
import {
  COMPOSE_PROJECT_LABEL,
  isDevspaceResourceName,
  HELPER_CACHE_VOLUME,
  LABEL_DEVSPACE_ID,
  LABEL_OWNER_ID,
  LABEL_VOLUME,
  VOLUME_KIND_ADDITIONAL,
  VSCODE_STORE_VOLUME,
} from '../names';
import { DEV_CONTAINERS_VOLUMES, hasDevContainersVolumeLabel, isDevContainersCloneVolumeName } from '../devContainers';
import { REMOTE_MONITOR_VOLUME } from '../remoteMonitor/protocol';
import { access, guarded, type HostAccessFinding, type Problem } from './report';

export function volumeContext(input: VolumeInput): VolumeContext {
  return {
    own: input.ownVolume,
    foreign: new Set(input.foreignVolumes ?? []),
    labels: input.volumeLabels ?? {},
    devspace: input.devspace,
    networks: input.networks ?? {},
  };
}

/** The part of HostAccessInput (and of ComposeAccessInput) that decides which named volumes a mount may use. */
export interface VolumeInput {
  /**
   * The workspace volume of the devspace: the only volume named like the workspace volume of a devspace
   * (isDevspaceResourceName) that a mount may use.
   */
  ownVolume: string;
  /**
   * Named volumes that devspaces of other GitHub accounts use (their additional volumes in the registry): a mount
   * may not use them, so that no container of one account shares a volume with a container of another account.
   */
  foreignVolumes?: readonly string[];
  /**
   * The labels of the volumes of mountedVolumeNames that exist, by name (`docker volume inspect`): a mount may not use
   * a volume that another program created (volumeLabelOwner).
   */
  volumeLabels?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /**
   * The devspace that is checked (its ID and the GitHub user ID of its owner): an existing volume whose labels of
   * Devspace name it is its own (isOwnVolume) and may be mounted, and so may an additional volume of another
   * devspace of the same owner (isSameOwnerAdditionalVolume). Without it, every volume with
   * nimblescape.devspaces.id is refused.
   */
  devspace?: { id: string; ownerId: string };
  /**
   * The networks that the configuration names (runArgsNetworks, or the networks of a Docker Compose model) and that
   * exist, by name: their labels and the devspaces of the containers attached to them (foreignNetworkItem).
   */
  networks?: Readonly<Record<string, NetworkState>>;
}

/**
 * What the check knows of an existing network (HostAccessInput.networks), by the reference that the configuration writes
 * (its name, its ID, or a unique prefix of its ID, as Docker resolves it).
 */
export interface NetworkState {
  /** The name of the network that the reference resolves to; the rules on names apply to it too. */
  name?: string;
  /** The labels of the network (`docker network inspect`). */
  labels: Readonly<Record<string, string>>;
  /** The label nimblescape.devspaces.id of each container attached to the network that has it. */
  devspaces: readonly string[];
  /**
   * Of `devspaces`, those of registry entries of the owner of the checked devspace: the devspaces of one
   * account may share a network of their own (as they share additional volumes). A devspace of another owner, or
   * without an entry, stays another devspace's.
   */
  sameOwnerDevspaces?: readonly string[];
}

/** What the mounts of a devspace may use besides the rules of volumeNameProblems. */
export interface VolumeContext {
  /** The workspace volume of the devspace. */
  own: string;
  /** The named volumes of devspaces of other GitHub accounts (HostAccessInput.foreignVolumes). */
  foreign: ReadonlySet<string>;
  /** HostAccessInput.volumeLabels. */
  labels: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** HostAccessInput.devspace. */
  devspace: { id: string; ownerId: string } | undefined;
  /** HostAccessInput.networks. */
  networks: Readonly<Record<string, NetworkState>>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Volumes

/** Docker's name of an anonymous volume: 64 hexadecimal characters. */
const ANONYMOUS_VOLUME_NAME = /^[0-9a-f]{64}$/;

/**
 * Whether `name` is Docker's name of an anonymous volume (64 hexadecimal characters). The host access policy refuses a
 * configuration that names such a volume (foreignVolumeName: "another container"), so with the checks on, a volume
 * mount of the dev container with such a name is an anonymous volume of the dev container itself.
 */
export function isAnonymousVolumeName(name: string): boolean {
  return ANONYMOUS_VOLUME_NAME.test(name);
}

/**
 * What a volume belongs to by its name alone, `undefined` for any other name: the workspace helper, the shared VS Code
 * server store, the Monitor on a remote Docker host (its heartbeat records: a mount could forge or delete
 * them), another devspace (named like a workspace volume), another container (an anonymous volume; older Docker
 * versions do not label it), or the Dev Containers extension (DEV_CONTAINERS_VOLUMES). Only for the host access policy:
 * whether a volume is a devspace's own is decided by its labels (isOwnVolume).
 */
export function foreignVolumeName(name: string): string | undefined {
  if (name === HELPER_CACHE_VOLUME) return 'the workspace helper';
  if (name === REMOTE_MONITOR_VOLUME) return 'the Monitor';
  // The shared VS Code server store (only the override configuration mounts it, read-only).
  if (name === VSCODE_STORE_VOLUME) return 'the shared VS Code server store';
  if (isDevspaceResourceName(name)) return 'another devspace';
  if (ANONYMOUS_VOLUME_NAME.test(name)) return 'another container';
  if (DEV_CONTAINERS_VOLUMES.includes(name)) return 'the Dev Containers extension';
  return undefined;
}

/**
 * True when the labels of a volume make it the own volume of the devspace `devspaceId`:
 * nimblescape.devspaces.id is that ID, and nimblescape.devspaces.owner-id is the owner of the devspace. The
 * only rule by which the pipeline records an additional volume and Delete removes one: a volume without these labels
 * (for example one named with `${devcontainerId}`, which Docker creates at `up`, or one of another program) is never
 * the devspace's.
 */
export function isOwnVolume(labels: Readonly<Record<string, string>>, devspaceId: string, ownerId: string): boolean {
  return labels[LABEL_DEVSPACE_ID] === devspaceId && labels[LABEL_OWNER_ID] === ownerId;
}

/**
 * The program that created an existing volume, by its labels, for a volume that a repository did not create by its
 * mounts (Docker gives such a volume no labels): Docker Compose (the volume of a project, for example the data of a
 * database), the Dev Containers extension (hasDevContainersVolumeLabel), Docker itself (an anonymous volume of another
 * container), or Devspaces (a volume of a devspace, nimblescape.devspaces.id). `undefined` for a
 * volume without such labels.
 */
export function volumeLabelOwner(labels: Readonly<Record<string, string>>): string | undefined {
  const keys = Object.keys(labels);
  // Before the labels of Docker Compose: a volume of the Compose project of a devspace carries both (whether it is
  // the devspace's own is decided by isOwnVolume first everywhere).
  if (keys.includes(LABEL_DEVSPACE_ID)) return 'another devspace';
  if (keys.some((key) => key.startsWith('com.docker.compose.'))) {
    const project = labels[COMPOSE_PROJECT_LABEL];
    return project ? `the Docker Compose project ${project}` : 'Docker Compose';
  }
  if (hasDevContainersVolumeLabel(labels)) return 'the Dev Containers extension';
  if (keys.includes('com.docker.volume.anonymous')) return 'another container';
  return undefined;
}

/**
 * True when the labels of a volume make it an additional volume (nimblescape.devspaces.volume=additional) of a
 * devspace of the GitHub user `ownerId`: nimblescape.devspaces.id is set, and nimblescape.devspaces.owner-id
 * is set and is that user. The devspaces of one account share such a volume, for example
 * `${localWorkspaceFolderBasename}-node_modules` of a fork and its upstream repository, or a fixed cache name: each may
 * mount it (mayMountDevspaceVolume) and records it, so that the Delete of one keeps it while another records it. A
 * volume without the owner label and a workspace volume (no nimblescape.devspaces.volume) are not.
 */
export function isSameOwnerAdditionalVolume(labels: Readonly<Record<string, string>>, ownerId: string): boolean {
  return (
    labels[LABEL_DEVSPACE_ID] !== undefined &&
    labels[LABEL_VOLUME] === VOLUME_KIND_ADDITIONAL &&
    labels[LABEL_OWNER_ID] === ownerId
  );
}

/**
 * An existing volume with labels of Devspace that the devspace may mount: its own (isOwnVolume), or an
 * additional volume of another devspace of the same owner (isSameOwnerAdditionalVolume), whether that devspace
 * still exists or its Delete kept the volume. A volume of another account, a volume without an owner label, and a
 * workspace volume are refused.
 */
function mayMountDevspaceVolume(labels: Readonly<Record<string, string>>, volumes: VolumeContext): boolean {
  const devspace = volumes.devspace;
  if (!devspace) return false;
  return isOwnVolume(labels, devspace.id, devspace.ownerId) || isSameOwnerAdditionalVolume(labels, devspace.ownerId);
}

/**
 * A named volume that belongs to something else: the workspace helper, another devspace (named like a workspace
 * volume, used by a devspace of another account, or labeled with the ID of another devspace that is not an
 * additional volume of the same owner, mayMountDevspaceVolume), the Dev
 * Containers extension (by name, or an existing volume whose name ends in a hash and that is not the devspace's
 * own), or another program that created the volume (its labels, volumeLabelOwner). Other named volumes, for example of
 * the repository (`${localWorkspaceFolderBasename}-node_modules`), are allowed: a volume that does not exist yet is
 * created with the labels of the devspace before `up`.
 */
export function volumeNameProblems(name: string, volumes: VolumeContext): Problem[] {
  if (name === '' || name === volumes.own) return [];
  // Account separation: the volumes of other devspaces, the cache volume of the workspace helper, which all
  // devspaces share, and the volume of the Monitor on a remote host (its heartbeat records decide the stop of
  // every devspace there) stay refused with the host access checks off. The volumes of other programs (another
  // container, the Dev Containers extension, Docker Compose) are access to the computer.
  if (volumes.foreign.has(name)) return [guarded(`volume ${name} of another devspace`)];
  const byName = foreignVolumeName(name);
  if (byName !== undefined) {
    const item = `volume ${name} of ${byName}`;
    // The shared VS Code server store too (a write would change the server of every devspace; read-only or not, only
    // the override configuration mounts it).
    const protectedName = name === HELPER_CACHE_VOLUME || name === REMOTE_MONITOR_VOLUME || name === VSCODE_STORE_VOLUME || isDevspaceResourceName(name);
    return [protectedName ? guarded(item) : access(item)];
  }
  const labels = volumes.labels[name];
  // Not known to exist.
  if (labels === undefined) return [];
  if (labels[LABEL_DEVSPACE_ID] !== undefined) {
    return mayMountDevspaceVolume(labels, volumes) ? [] : [guarded(`volume ${name} of another devspace`)];
  }
  const owner = volumeLabelOwner(labels);
  if (owner !== undefined) return [access(`volume ${name} of ${owner}`)];
  // An existing volume named like a clone volume of the Dev Containers extension (isDevContainersCloneVolumeName), which
  // older versions did not label.
  if (isDevContainersCloneVolumeName(name)) return [access(`volume ${name} of another program`)];
  return [];
}

/**
 * The items of a named volume that belongs to something else (the rules of `mounts`: the workspace helper, another
 * devspace, the Dev Containers extension, or another program, by the name and the labels of the volume), for the
 * volumes of a Docker Compose configuration (./compose.ts). Empty for the workspace volume and a volume that may be
 * used.
 */
export function volumeNameItems(name: string, input: VolumeInput): string[] {
  return volumeNameFindings(name, input).map((finding) => finding.item);
}

/**
 * volumeNameItems with the class of each item (HostAccessClass), for the switch of the host access checks in the Docker
 * Compose policy: a volume of another devspace or of the workspace helper stays refused (`protected`), a volume of
 * another program is access to the computer (`computer`), as for the `mounts` of a single container.
 */
export function volumeNameFindings(name: string, input: VolumeInput): HostAccessFinding[] {
  return volumeNameProblems(name, volumeContext(input)).map((problem) => ({ item: problem.item, class: problem.class }));
}

// ---------------------------------------------------------------------------------------------------------------------
// Networks

/**
 * A volume or network name of the Compose project of another devspace: `<name of a devspace>_…`
 * (isDevspaceResourceName; such a name has no `_`), not `<project>_…`.
 */
export function isOtherDevspaceProjectName(name: string, project: string): boolean {
  const index = name.indexOf('_');
  if (index <= 0) return false;
  const prefix = name.slice(0, index);
  return isDevspaceResourceName(prefix) && prefix.toLowerCase() !== project.toLowerCase();
}

/**
 * The network that a reference of a configuration names, of the networks that `docker network inspect <references>`
 * printed, as Docker resolves it: its full ID, else its name, else a unique prefix of its ID. `undefined` when none
 * matches (or the prefix is not unique).
 */
export function resolveNetworkReference<T extends { name: string; id: string }>(reference: string, networks: readonly T[]): T | undefined {
  const text = reference.trim();
  if (text === '') return undefined;
  const byId = networks.find((network) => network.id !== '' && network.id === text);
  if (byId) return byId;
  const byName = networks.find((network) => network.name === text);
  if (byName) return byName;
  const byPrefix = networks.filter((network) => network.id !== '' && network.id.startsWith(text));
  return new Set(byPrefix.map((network) => network.id)).size === 1 ? byPrefix[0] : undefined;
}

/**
 * The item of a network that belongs to another devspace, perhaps of another account (HostAccessClass `protected`):
 * named like the Compose project of another devspace (isOtherDevspaceProjectName), labelled by Docker Compose for
 * the project of another devspace (isDevspaceResourceName), or with a container of another devspace attached
 * (label nimblescape.devspaces.id) that is not a devspace of the same owner
 * (NetworkState.sameOwnerDevspaces). The name rules apply to the written reference and to the name of the network
 * that it resolves to (NetworkState.name). `devspaceId`: the devspace that is checked (its own containers),
 * `project` its Compose project (composeProjectName, the same as its workspace volume); without them, every such
 * network counts as another devspace's. `undefined` for any other network.
 */
export function foreignNetworkItem(name: string, state: NetworkState | undefined, devspaceId: string | undefined, project = ''): string | undefined {
  const item = `network ${name} of another devspace`;
  if (isOtherDevspaceProjectName(name, project)) return item;
  if (!state) return undefined;
  // The network that the reference names (for example by its ID): its own name counts too.
  if (state.name !== undefined && isOtherDevspaceProjectName(state.name, project)) return item;
  const owner = state.labels[COMPOSE_PROJECT_LABEL];
  if (owner !== undefined && isDevspaceResourceName(owner) && owner.toLowerCase() !== project.toLowerCase()) return item;
  // A container of another devspace: only of the same owner may share the network.
  const sameOwner = state.sameOwnerDevspaces ?? [];
  if (state.devspaces.some((id) => id !== devspaceId && !sameOwner.includes(id))) return item;
  return undefined;
}
