// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The pipeline reads the containers of one devspace through DevspaceDocker.devspaceContainers, never the
// containers of every devspace (listDevspaceContainers). Each test here has a container of another devspace
// next to the one that the flow works on, and names the call site of devspaceService.ts that it holds: the
// containers of another devspace of the same account are never started, stopped or removed, and never decide about
// this one.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContainerInfo } from '../docker/dockerObjects';
import { UserFacingError } from '../errors';
import type { ComposeModel } from '../helper/composeModel';
import { composeConfigHash, composeInputsHash, type ComposeModelOutput } from '../helper/compose';
import { DevcontainerCommandError } from '../helper/devcontainerCli';
import {
  CONTAINER_VERSION,
  HOST_ACCESS_UNRESTRICTED,
  LABEL_COMPOSE_SERVICE,
  LABEL_CONTAINER_VERSION,
  LABEL_DEVSPACE_ID,
  LABEL_HOST_ACCESS,
  LABEL_OWNER_ID,
  LABEL_REPOSITORY,
  LABEL_VOLUME,
  VOLUME_KIND_ADDITIONAL,
  composeProjectName,
  devspaceImageName,
  resourceName,
} from '../names';
import type { BuildRecord, ContainerState, WindowStatus } from '../types';
import type { RepositoryTarget } from './operationBase';
import {
  ACCOUNT,
  BASE_IMAGE,
  DEFAULT_CONFIG_TEXT,
  DIGEST_NEW,
  ENV_ID,
  FEATURE,
  FEATURE_DIGEST,
  OTHER_ID,
  REPO,
  T0,
  checked,
  createHarness,
  seedDevspace,
  type Harness,
} from './devspaceService.testkit';
import { DEFAULT_CONFIG_PATH } from './recordRules';

const TARGET: RepositoryTarget = { repository: REPO, defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };
const PROJECT = composeProjectName(REPO, ENV_ID);
const IMAGE_1 = devspaceImageName(REPO, ENV_ID, 1);
const DB_IMAGE = 'postgres:16';
const DB_DIGEST = `sha256:${'d'.repeat(64)}`;
const COMPOSE_LABELS = { 'com.docker.compose.project': PROJECT, 'com.docker.compose.container-number': '1' };
/** The other devspace: of the same account, another repository. */
const OTHER_REPO = 'acme/web';
const OTHER_PROJECT = composeProjectName(OTHER_REPO, OTHER_ID);

// The Docker Compose configuration of devspaceService.compose.test.ts (a dev service `app` and a database `db`).
const CONFIG_TEXT = `{
  "name": "API",
  "dockerComposeFile": ["compose.yml"],
  "service": "app",
  "workspaceFolder": "/workspaces/\${localWorkspaceFolderBasename}",
  "features": { "${FEATURE}": {} },
  "remoteUser": "vscode",
  "mounts": ["source=cache,target=/cache,type=volume"]
}`;

function model(): ComposeModel {
  return {
    name: PROJECT,
    services: {
      app: { image: BASE_IMAGE, command: ['sleep', 'infinity'], volumes: [{ type: 'bind', source: '/workspaces', target: '/workspaces', bind: {} }], networks: { default: null } },
      db: { image: DB_IMAGE, volumes: [{ type: 'volume', source: 'pgdata', target: '/var/lib/postgresql/data', volume: {} }], networks: { default: null } },
    },
    networks: { default: { name: `${PROJECT}_default` } },
    volumes: { pgdata: { name: `${PROJECT}_pgdata` } },
  };
}

function output(): ComposeModelOutput {
  return { version: '2.40.3', dollarEscaped: true, model: model(), dockerfiles: {}, realPaths: { '/workspaces': '/workspaces' }, inputsHash: 'inputs-1' };
}

let h: Harness;

beforeEach(() => {
  h = createHarness({ newDevspaceId: () => ENV_ID });
});

afterEach(() => {
  h.cleanup();
});

function options() {
  return { progress: h.progress };
}

function useCompose(): void {
  h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: CONFIG_TEXT } };
  h.helper.composeOutput = output();
  h.checker.outcome = checked({ [BASE_IMAGE]: DIGEST_NEW, [DB_IMAGE]: DB_DIGEST }, { [FEATURE]: FEATURE_DIGEST });
}

/** A Docker Compose devspace of ENV_ID that is up to date (as seedCompose of devspaceService.compose.test.ts). */
async function seedCompose(dev: ContainerState, db: ContainerState, record: Partial<BuildRecord> = {}): Promise<void> {
  await seedDevspace(h, {
    container: dev,
    containerLabels: { [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION), ...COMPOSE_LABELS, 'com.docker.compose.service': 'app' },
    record: {
      configHash: composeConfigHash(CONFIG_TEXT, model(), {}),
      images: { [BASE_IMAGE]: DIGEST_NEW, [DB_IMAGE]: DB_DIGEST },
      compose: { service: 'app', images: [`${PROJECT}-app`], serviceImages: [DB_IMAGE], version: '2.40.3', inputsHash: composeInputsHash(CONFIG_TEXT, 'inputs-1', {}) },
      ...record,
    },
  });
  h.docker.images.add(DB_IMAGE);
  h.docker.addContainer({ devspaceId: ENV_ID, name: `${PROJECT}-db-1`, state: db, image: DB_IMAGE, labels: { [LABEL_COMPOSE_SERVICE]: 'db', ...COMPOSE_LABELS, 'com.docker.compose.service': 'db' } });
}

function dbContainer(): ContainerInfo | undefined {
  return h.docker.containersOf(ENV_ID).find((c) => c.labels[LABEL_COMPOSE_SERVICE] === 'db');
}

/** The entry of the other devspace (same account, its own repository), without a container of its own yet. */
async function otherDevspace(): Promise<void> {
  await seedDevspace(h, { id: OTHER_ID, repository: OTHER_REPO, container: null, volume: false, record: null });
}

/** A container of the database service of the other devspace's Docker Compose project. */
function theirService(state: ContainerState, labels: Record<string, string> = {}, volumes?: string[]): ContainerInfo {
  const added = h.docker.addContainer({
    devspaceId: OTHER_ID,
    name: `${OTHER_PROJECT}-db-1`,
    state,
    image: DB_IMAGE,
    labels: { [LABEL_COMPOSE_SERVICE]: 'db', 'com.docker.compose.project': OTHER_PROJECT, 'com.docker.compose.container-number': '1', 'com.docker.compose.service': 'db', ...labels },
  });
  if (volumes !== undefined) h.docker.containers.set(added.id, { ...added, volumes });
  return h.docker.containers.get(added.id)!;
}

/** The dev container of the other devspace (a single container). */
function theirDevContainer(state: ContainerState): ContainerInfo {
  return h.docker.addContainer({ devspaceId: OTHER_ID, name: resourceName(OTHER_REPO, OTHER_ID), state, image: devspaceImageName(OTHER_REPO, OTHER_ID, 1) });
}

/** The container is there as it was: never started, stopped or removed. */
function untouched(container: ContainerInfo): void {
  expect(h.docker.containers.get(container.id)?.state).toBe(container.state);
  expect(h.docker.log.filter((line) => line.endsWith(` ${container.id}`))).toEqual([]);
}

describe('the containers of another devspace are not this one\'s', () => {
  // unrestrictedServiceContainer: a service of another devspace that was created while the host access checks were
  // off would make this current Docker Compose devspace outdated, so its open would create its containers again.
  it('a service of another devspace of the checks-off time does not make a current devspace outdated', async () => {
    useCompose();
    await seedCompose('running', 'running');
    await otherDevspace();
    const theirs = theirService('running', { [LABEL_HOST_ACCESS]: HOST_ACCESS_UNRESTRICTED });
    await h.service.openDevspace(ENV_ID, options());
    expect(h.helper.ups).toEqual([]);
    expect(h.logger.infos.join('\n')).not.toContain('created while the host access checks were off');
    untouched(theirs);
  });

  // startStoppedServices: the open of a running Docker Compose devspace starts its stopped services, never the
  // stopped services of another devspace.
  it('the open starts the stopped services of this devspace only', async () => {
    useCompose();
    await seedCompose('running', 'stopped');
    await otherDevspace();
    const theirs = theirService('stopped');
    await h.service.openDevspace(ENV_ID, options());
    expect(h.docker.log).toContain(`start ${dbContainer()!.id}`);
    untouched(theirs);
  });

  // The services before `up`: next to a single container, the containers of other services are strays of this
  // devspace that go; a service of another devspace is not one of them (it is never stopped and removed, and the
  // start is not refused).
  it('the start of a single container never removes a service of another devspace as a stray', async () => {
    await seedDevspace(h, { container: 'stopped' });
    await otherDevspace();
    const theirs = theirService('running');
    await h.service.openDevspace(ENV_ID, options());
    expect(h.helper.ups).toHaveLength(1);
    untouched(theirs);
  });

  // upContainers, through anyContainerRuns: whether a container of this devspace runs decides whether another window
  // still counts; a running container of another devspace must not keep an outdated stopped container from being
  // created again.
  it('a running container of another devspace is not a running container of this one', async () => {
    h.cleanup();
    const statusOfB: WindowStatus = { windowId: 'window-b', pid: 5353, devspaceId: ENV_ID, state: 'active', updatedAt: new Date(T0).toISOString() };
    h = createHarness({ newDevspaceId: () => ENV_ID, windowStatuses: async () => [statusOfB] });
    h.alivePids.add(5353);
    await seedDevspace(h, { container: 'stopped', containerLabels: { [LABEL_CONTAINER_VERSION]: '0' } });
    await otherDevspace();
    const theirs = theirDevContainer('running');
    await h.service.open(TARGET, options());
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_1} --remove-existing-container`]);
    untouched(theirs);
  });

  // recordContainerVolumes with `all`: the volumes of the containers of this devspace are recorded as its additional
  // volumes, never an additional volume of another devspace of the same owner that only its container mounts (the
  // record would keep that volume at the other devspace's Delete).
  it('the open records the volumes of the containers of this devspace only', async () => {
    useCompose();
    await seedCompose('running', 'running');
    await otherDevspace();
    h.docker.volumes.set('web-cache', { [LABEL_DEVSPACE_ID]: OTHER_ID, [LABEL_REPOSITORY]: OTHER_REPO, [LABEL_OWNER_ID]: ACCOUNT.id, [LABEL_VOLUME]: VOLUME_KIND_ADDITIONAL });
    theirService('running', {}, ['web-cache']);
    await h.service.openDevspace(ENV_ID, options());
    expect((await h.registry.get(ENV_ID))?.additionalVolumes ?? []).not.toContain('web-cache');
  });

  // removeComposeServices: the switch of a Docker Compose devspace to a single container removes its own services,
  // never those of another devspace.
  it('the switch to a single container removes the services of this devspace only', async () => {
    useCompose();
    await seedCompose('stopped', 'stopped');
    h.docker.images.add(`${PROJECT}-app`);
    h.docker.imageConfigs.set(`${PROJECT}-app`, { User: '', Labels: { [LABEL_DEVSPACE_ID]: ENV_ID } });
    h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: DEFAULT_CONFIG_TEXT } };
    const db = dbContainer()!.id;
    await otherDevspace();
    const theirs = theirService('running');
    h.ui.configurationChangedAnswer = 'rebuildNow';
    await h.service.openDevspace(ENV_ID, options());
    expect(h.docker.log).toContain(`rm ${db}`);
    untouched(theirs);
  });

  // containersUseCompose: an entry without a build record and without a dev container is of the kind of its own
  // containers; a service of another devspace does not make it a Docker Compose devspace (whose question of the
  // switch would end the open).
  it('a service of another devspace does not make an entry without a record a Docker Compose devspace', async () => {
    await seedDevspace(h, { record: null, container: null });
    await otherDevspace();
    const theirs = theirService('stopped');
    await h.service.openDevspace(ENV_ID, options());
    expect(h.ui.prompts.filter((prompt) => prompt.startsWith('configurationKindChanged'))).toEqual([]);
    expect(h.docker.containersOf(ENV_ID)).toHaveLength(1);
    untouched(theirs);
  });

  // removableVolumesByKind: an additional volume of this devspace is data of its services only when a container of
  // its own services mounts it; a service of another devspace that mounts it does not move it into the question of
  // the data of the services.
  it('the volumes that a service of another devspace mounts are no data of the services of this one', async () => {
    await seedDevspace(h, { container: 'stopped', extra: { additionalVolumes: ['api-tools'] } });
    h.docker.volumes.set('api-tools', { [LABEL_DEVSPACE_ID]: ENV_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id, [LABEL_VOLUME]: VOLUME_KIND_ADDITIONAL });
    await otherDevspace();
    theirService('running', {}, ['api-tools']);
    expect(await h.service.removableVolumesOf(ENV_ID)).toEqual({ additional: ['api-tools'], serviceData: [], possibly: [] });
  });

  // removeFailedFirstOpen: a failed first open removes what it created, never the containers of another devspace.
  it('a failed first open removes its own container only', async () => {
    await otherDevspace();
    const theirDev = theirDevContainer('running');
    const theirs = theirService('stopped');
    h.helper.upError = () => new DevcontainerCommandError('devcontainer up', 1, '', 'port is already allocated');
    const error = await h.service.open(TARGET, options()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UserFacingError);
    expect((error as UserFacingError).code).toBe('startFailed');
    expect(h.docker.containersOf(ENV_ID)).toEqual([]);
    untouched(theirDev);
    untouched(theirs);
  });
});

