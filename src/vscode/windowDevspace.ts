// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The devspace of the window at its activation, and the restore of a lost registry around it. No `vscode` import
// here, so it is unit-tested.
import type { BootstrapDocker } from '../core/docker/bootstrapDocker';
import type { HelperPrebuildOutcome } from '../core/helper/helperPrebuild';
import type { DevspaceOperations } from '../core/pipeline/devspaceOperations';
import type { Logger } from '../core/ports';
import { describeDockerHost, dockerHostField, isOnDockerHost, type DockerTarget } from '../core/docker/dockerHost';
import { runWithDockerTarget } from '../core/docker/dockerTargets';
import { DOCKER_QUERY_TIMEOUT_MS } from '../core/docker/dockerTimeouts';
import { removedEngineNote } from '../core/docker/engineRemoval';
import { errorMessage } from '../core/errors';
import { LABEL_COMPOSE_SERVICE, LABEL_CONFIG_PATH, LABEL_DEVSPACE_ID, LABEL_OWNER_ID, LABEL_REPOSITORY, RESOURCE_NAME_PREFIX, isConfigPathLabelValue } from '../core/names';
import { DEFAULT_CONFIG_PATH, isRepositoryName } from '../core/pipeline/recordRules';
import { isStorageId } from '../core/storage/paths';
import type { DevspaceRegistry } from '../core/storage/registry';
import type { Devspace } from '../core/types';
import { isRecord } from '../core/valueChecks';

/**
 * The longest wait of the activation for the restore of a lost registry, and for the labels of the container of the
 * window when no restore runs on an engine with the removal mark (removedEngineWindowDevspace).
 */
export const WINDOW_RESTORE_TIMEOUT_MS = 30_000;

/**
 * The name of the devspace of this window (resourceName, the name of its workspace volume: with the word of its source
 * from version 0.6.0 on, without it before) for the name of its worker on the Docker host `host` (the host of the
 * worker's engine, '' for the local Docker; workerNameStart): of the registry entry of the container that the window
 * is attached to (`containerName`, ConnectionAdapter.currentContainerName), when the devspace is on that host.
 * Undefined for a window of no container, for a container that the registry does not know (also of a lost registry
 * before its restore), and for the workers of the window on other engines: these are named after the window.
 */
export async function windowDevspaceName(
  containerName: string | undefined,
  host: string,
  registry: Pick<DevspaceRegistry, 'findByContainerName'>,
): Promise<string | undefined> {
  if (!containerName) return undefined;
  const devspace = await registry.findByContainerName(containerName);
  return devspace && isOnDockerHost(devspace, host) ? devspace.volumeName : undefined;
}

/**
 * Whether the activation does its Docker work in the background (the restore of a lost registry, the prebuild of the
 * helper image): after the first use of Devspaces (`used`, devspacesUsed), and in the window of a container whose name
 * starts with `devspaces-` (the dev container of a devspace, also one that Docker Compose named after the project of
 * the devspace), which needs its devspace also when the storage folder was lost. Before the first use, other windows
 * ask Docker nothing in the background.
 */
export function backgroundWorkAtStart(used: boolean, containerName: string | undefined): boolean {
  return used || (containerName !== undefined && containerName.toLowerCase().startsWith(RESOURCE_NAME_PREFIX));
}

/**
 * The engine of the Docker work that the activation does in the background (backgroundWorkAtStart): the one of the
 * current Docker context (`current`), unless the user removed Devspaces from it (`removed`: "Remove Devspaces from This
 * Docker Engine…", until a Start, a Rebuild or "Update All Images Now" there); then none, with a line in the log.
 */
export async function backgroundEngineAtStart(deps: {
  current(): Promise<DockerTarget>;
  removed(target: DockerTarget): Promise<boolean>;
  logger: Logger;
}): Promise<DockerTarget | undefined> {
  const target = await deps.current();
  if (!(await deps.removed(target))) return target;
  deps.logger.info(`No Docker work in the background at the start: ${removedEngineNote(describeDockerHost(target.host))}`);
  return undefined;
}

/**
 * The registry entry of the container that this window is attached to. When the registry lost its content (the file is
 * missing, not valid, or has invalid entries), it is restored from the volume labels first, so that the open pipeline
 * of role A can run for a restored window; this needs a running Docker, which is not started for it. With `mayRestore`
 * false (backgroundWorkAtStart), nothing is restored; as a check, it runs only for a lost registry, and nothing is
 * restored when it answers false (an engine with the removal mark). Never throws.
 */
export async function findWindowDevspace(
  containerName: string,
  deps: {
    registry: Pick<DevspaceRegistry, 'findByContainerName'>;
    needsRestore: () => Promise<boolean>;
    docker: Pick<BootstrapDocker, 'isInstalled'>;
    service: Pick<DevspaceOperations, 'reconcileInWorker'>;
    logger: Logger;
    /** Whether a lost registry may be restored here, or the check of it; true when not given. */
    mayRestore?: boolean | (() => Promise<boolean>);
  },
): Promise<Devspace | undefined> {
  const { registry, needsRestore, docker, service, logger } = deps;
  try {
    const devspace = await registry.findByContainerName(containerName);
    if (devspace || deps.mayRestore === false || !(await needsRestore())) return devspace;
    if (typeof deps.mayRestore === 'function' && !(await deps.mayRestore())) return undefined;
    // reconcileInWorker checks the Docker target first (never an endpoint that is neither local nor SSH), then whether
    // Docker runs; the worker of the Docker host restores, in the background (passive).
    if (!docker.isInstalled()) return undefined;
    // The activation waits at most WINDOW_RESTORE_TIMEOUT_MS for it; the restore in the background of the activation,
    // and the one after the build of the helper image, adopt the window later (reconcileIfRegistryLost with `adopt`).
    try {
      await service.reconcileInWorker({ passive: true, signal: AbortSignal.timeout(WINDOW_RESTORE_TIMEOUT_MS) });
    } catch (error) {
      logger.warn(`The devspaces could not be restored from the volumes while this window started: ${errorMessage(error)}`);
    }
    // The registry is read again whatever the restore answered: it may have added the entry before its time limit
    // ended, or another window restored it first (nothing added here).
    return await registry.findByContainerName(containerName);
  } catch (error) {
    logger.error('The devspace of this window could not be found.', error);
    return undefined;
  }
}

/**
 * The restore at activation is passive (it never builds the helper image), so a lost registry is restored again once
 * the background preparation of the helper image ended with an image (`restore` adopts a restored window), also when
 * the image was there already or is not due (a passive restore may have found no image, or no worker ready in time);
 * `restore` makes the worker ready in full.
 */
export async function restoreAfterPrebuild(outcome: HelperPrebuildOutcome, restore: () => Promise<void>): Promise<void> {
  if (outcome === 'built' || outcome === 'present' || outcome === 'notDue') await restore();
}

/**
 * What the labels of the container that a window is attached to say about its devspace (containerDevspace).
 * `devspace`: an entry made of them; `unreadable`: the owner cannot be read, with the reason, and the ID of the
 * devspace when the labels name a valid one; `none`: the container is no dev container of a devspace on that engine.
 */
export type ContainerDevspace =
  | { kind: 'devspace'; devspace: Devspace }
  | { kind: 'unreadable'; devspaceId?: string; reason: string }
  | { kind: 'none' };

/** stderr of an inspect of a container that the engine does not have (Docker: `No such container: <name>`; Podman too). */
const NO_SUCH_CONTAINER = /no such container/i;

/**
 * The devspace of the container `containerName` by its labels, with one plain `docker container inspect` on the engine
 * of the call (no worker, nothing that changes). The dev container has the label nimblescape.devspaces.id (the id label
 * of the Dev Container CLI), and the devspace image gives it nimblescape.devspaces.repository and
 * nimblescape.devspaces.owner-id (imageRecordLabels); nimblescape.devspaces.config-path names its configuration. The
 * entry is on the Docker host `host`, at `now`, with the owner of the label (its login is not known), named after the
 * container as a restored entry is (devspaceOfVolume). `none` for a container that the engine does not have, one
 * without the first label, and the other containers of a Compose devspace (nimblescape.devspaces.compose-service: no
 * token is ever in them); an inspect that fails otherwise, and a label that is missing or not valid, leave the owner
 * unknown (`unreadable`). Never throws.
 */
export async function containerDevspace(
  containerName: string,
  deps: { docker: Pick<BootstrapDocker, 'run'>; host: string; now: string; timeoutMs?: number },
): Promise<ContainerDevspace> {
  let labels: Record<string, unknown>;
  try {
    const result = await deps.docker.run(['container', 'inspect', '--format', '{{json .Config.Labels}}', containerName], {
      timeoutMs: deps.timeoutMs ?? DOCKER_QUERY_TIMEOUT_MS,
    });
    if (result.timedOut) return { kind: 'unreadable', reason: 'Docker did not answer in time' };
    if (result.exitCode !== 0) {
      const reason = result.stderr.trim();
      if (NO_SUCH_CONTAINER.test(reason)) return { kind: 'none' };
      return { kind: 'unreadable', reason: (reason || `docker container inspect ended with exit code ${result.exitCode}`).slice(-500) };
    }
    const value: unknown = JSON.parse(result.stdout.trim() || 'null');
    labels = isRecord(value) ? value : {};
  } catch (error) {
    return { kind: 'unreadable', reason: errorMessage(error) };
  }
  const id = labels[LABEL_DEVSPACE_ID];
  if (id === undefined || labels[LABEL_COMPOSE_SERVICE] !== undefined) return { kind: 'none' };
  if (!isStorageId(id)) return { kind: 'unreadable', reason: `its label ${LABEL_DEVSPACE_ID} is not valid` };
  const ownerId = labels[LABEL_OWNER_ID];
  if (!isStorageId(ownerId)) return { kind: 'unreadable', devspaceId: id, reason: `it has no valid label ${LABEL_OWNER_ID}` };
  const repository = labels[LABEL_REPOSITORY];
  if (!isRepositoryName(repository)) return { kind: 'unreadable', devspaceId: id, reason: `it has no valid label ${LABEL_REPOSITORY}` };
  const configPath = labels[LABEL_CONFIG_PATH];
  return {
    kind: 'devspace',
    devspace: {
      id,
      repository,
      configPath: typeof configPath === 'string' && isConfigPathLabelValue(configPath) ? configPath : DEFAULT_CONFIG_PATH,
      volumeName: containerName,
      containerName,
      createdAt: deps.now,
      lastUsedAt: deps.now,
      owner: { id: ownerId, login: '' },
      ...dockerHostField(deps.host),
    },
  };
}

/**
 * The devspace of the window of the container `containerName` when findWindowDevspace found none because the registry
 * lost its content and nothing was restored from the current engine, which has the removal mark (`mayRestore` of the
 * activation): the labels of the container give it (containerDevspace, on that engine, within
 * WINDOW_RESTORE_TIMEOUT_MS), so that the account rule holds for the window there too (Controller.workWithoutDevspaces,
 * Controller.leaveUnknownOwner). `none` without a Docker CLI, for a registry that did not lose its content, and on an
 * engine without the mark (the restore ran there). Never throws.
 */
export async function removedEngineWindowDevspace(
  containerName: string,
  deps: {
    needsRestore: () => Promise<boolean>;
    docker: Pick<BootstrapDocker, 'isInstalled' | 'run'>;
    current: () => Promise<DockerTarget>;
    removed: (target: DockerTarget) => Promise<boolean>;
    now: () => string;
    logger: Logger;
  },
): Promise<ContainerDevspace> {
  try {
    if (!deps.docker.isInstalled() || !(await deps.needsRestore())) return { kind: 'none' };
    const target = await deps.current();
    if (!(await deps.removed(target))) return { kind: 'none' };
    const found = await runWithDockerTarget(target, () =>
      containerDevspace(containerName, { docker: deps.docker, host: target.host, now: deps.now(), timeoutMs: WINDOW_RESTORE_TIMEOUT_MS }),
    );
    if (found.kind !== 'none') {
      deps.logger.info(
        `The devspaces are not restored from ${describeDockerHost(target.host)}: Devspaces was removed from it. The labels of the container ${containerName} are read for its devspace and its owner.`,
      );
    }
    return found;
  } catch (error) {
    deps.logger.warn(`The labels of the container ${containerName} could not be read: ${errorMessage(error)}`);
    return { kind: 'none' };
  }
}
