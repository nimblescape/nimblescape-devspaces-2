// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Docker Compose configurations: the open pipeline for a configuration with `dockerComposeFile` and `service`. The
// model run, the check of every service before any build and before each `up` that creates containers, the build and up
// models, the volumes, the labels, the image check over all services, update, rebuild, refused update, and start and
// stop of all containers.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandError, UserFacingError } from '../errors';
import { WORKSPACE_VOLUME_KEY, type ComposeModel } from '../helper/composeModel';
import {
  COMPOSE_DEV_DOCKERFILE,
  COMPOSE_MODEL_PATH,
  composeConfigHash,
  composeInputsHash,
  type ComposeModelOutput,
} from '../helper/compose';
import { DEVCONTAINER_ID_PLACEHOLDER, devspaceDevcontainerId } from '../helper/cliVariables';
import { DevcontainerCommandError } from '../helper/devcontainerCli';
import { sourceSegment } from '../devspaceSource';
import { HOME_GIT_CONFIG_SCRIPT } from '../helper/containerGit';
import { TOKEN_WRITE_SCRIPT } from '../helper/containerToken';
import { scriptCommand } from '../worker/containerScripts';
import { ANALYSIS_FAILED_ITEM, dockerCheckItem } from '../helper/configurationAnalysis';
import { Messages } from '../messages';
import { abortError } from '../ports';
import { EXISTING_PATHS_SCRIPT, MAX_SERVICE_FOLDERS, OWNERSHIP_FIX_SCRIPT, servicePathArguments } from '../git/gitSummary';
import {
  CONTAINER_VERSION,
  HOST_ACCESS_UNRESTRICTED,
  LABEL_COMPOSE_SERVICE,
  LABEL_CONFIG_PATH,
  LABEL_CONTAINER_VERSION,
  LABEL_HOST_ACCESS,
  LABEL_DEVSPACE_ID,
  LABEL_BUILD_RECORD,
  LABEL_OWNER_ID,
  LABEL_REPOSITORY,
  LABEL_VOLUME,
  TOKEN_TMPFS,
  VOLUME_KIND_ADDITIONAL,
  VOLUME_KIND_COMPOSE,
  composeProjectName,
  devspaceImageName,
  resourceName,
} from '../names';
import type { ContainerInfo } from '../docker/dockerObjects';
import type { BuildRecord, ContainerState, Devspace, WindowStatus } from '../types';
import { type DevspaceSessionMonitor } from './devspacePorts';
import { PipelineTexts, type RepositoryTarget } from './operationBase';
import {
  ACCOUNT,
  BASE_IMAGE,
  DEFAULT_CONFIG_TEXT,
  DIGEST_NEW,
  DIGEST_OLD,
  ENV_ID,
  FEATURE,
  FEATURE_DIGEST,
  OTHER_ACCOUNT,
  OTHER_ID,
  PID,
  REPO,
  T0,
  TOKEN,
  WINDOW_ID,
  checked,
  createHarness,
  seedDevspace,
  type Harness,
} from './devspaceService.testkit';
import { DEFAULT_CONFIG_PATH } from './recordRules';
import { repositoryServiceDataFolders } from './pipelineRules';
import { parseJsonc } from '../jsonc';
import { MAX_ITEM_LENGTH, MAX_LISTED_ITEMS } from '../policy';

const TARGET: RepositoryTarget = { repository: REPO, defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };
const NAME = resourceName(REPO, ENV_ID);
/** The names of a devspace that a first open of TARGET creates: with the word of its source, `config`. */
const FIRST_OPEN_NAME = resourceName(REPO, ENV_ID, 'config');
const PROJECT = composeProjectName(REPO, ENV_ID);
/** The Compose project of the devspace OTHER_ID of acme/web. */
const OTHER_PROJECT = composeProjectName('acme/web', OTHER_ID);
const IMAGE_1 = devspaceImageName(REPO, ENV_ID, 1);
const IMAGE_2 = devspaceImageName(REPO, ENV_ID, 2);
const FOLDER = '/workspaces/api';
const DB_IMAGE = 'postgres:16';
const DB_DIGEST = `sha256:${'d'.repeat(64)}`;
const DB_DIGEST_NEW = `sha256:${'e'.repeat(64)}`;
// Compose puts the project and, on containers only, the number of the container and the hash of its configuration
// (isComposeContainer needs one of them).
const COMPOSE_LABELS = { 'com.docker.compose.project': PROJECT, 'com.docker.compose.container-number': '1' };

const CONFIG_TEXT = `{
  // A Docker Compose configuration like the templates "… & Postgres"
  "name": "API",
  "dockerComposeFile": ["compose.yml"],
  "service": "app",
  "workspaceFolder": "/workspaces/\${localWorkspaceFolderBasename}",
  "features": { "${FEATURE}": {} },
  "remoteUser": "vscode",
  "mounts": ["source=cache,target=/cache,type=volume"]
}`;

/** The merged model of CONFIG_TEXT as `docker compose config --format json` prints it. */
function model(): ComposeModel {
  return {
    name: PROJECT,
    services: {
      app: {
        image: BASE_IMAGE,
        command: ['sleep', 'infinity'],
        // The templates' bind mount of the parent of the repository: replaced by the workspace volume.
        volumes: [{ type: 'bind', source: '/workspaces', target: '/workspaces', bind: {} }],
        networks: { default: null },
      },
      db: {
        image: DB_IMAGE,
        ports: [{ mode: 'ingress', target: 5432, published: '5432', protocol: 'tcp' }],
        volumes: [
          { type: 'volume', source: 'pgdata', target: '/var/lib/postgresql/data', volume: {} },
          { type: 'bind', source: `${FOLDER}/init.sql`, target: '/docker-entrypoint-initdb.d/init.sql', read_only: true, bind: {} },
        ],
        networks: { default: null },
      },
    },
    networks: { default: { name: `${PROJECT}_default` } },
    volumes: { pgdata: { name: `${PROJECT}_pgdata` } },
  };
}

function output(changes: (m: ComposeModel) => void = () => undefined): ComposeModelOutput {
  const m = model();
  changes(m);
  return {
    version: '2.40.3',
    dollarEscaped: true,
    model: m,
    dockerfiles: {},
    realPaths: { '/workspaces': '/workspaces', [`${FOLDER}/init.sql`]: `${FOLDER}/init.sql` },
    inputsHash: 'inputs-1',
  };
}

const HASH = composeConfigHash(CONFIG_TEXT, model(), {});

let h: Harness;

beforeEach(() => {
  h = createHarness({ newDevspaceId: () => ENV_ID });
  useCompose(h);
});

afterEach(() => {
  h.cleanup();
});

function useCompose(harness: Harness, out: ComposeModelOutput = output()): void {
  harness.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: CONFIG_TEXT } };
  harness.helper.composeOutput = out;
  harness.checker.outcome = checked({ [BASE_IMAGE]: DIGEST_NEW, [DB_IMAGE]: DB_DIGEST }, { [FEATURE]: FEATURE_DIGEST });
}

function options() {
  return { progress: h.progress };
}

async function rejection(promise: Promise<unknown>): Promise<UserFacingError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UserFacingError) return error;
    throw error;
  }
  throw new Error('The promise did not reject.');
}

function upModel(index = -1): ComposeModel {
  const up = h.helper.ups.at(index);
  return JSON.parse(up?.files?.[COMPOSE_MODEL_PATH] ?? 'null') as ComposeModel;
}

function devContainer(): ContainerInfo | undefined {
  return h.docker.containersOf(ENV_ID).find((c) => c.labels[LABEL_COMPOSE_SERVICE] === undefined);
}

function dbContainer(): ContainerInfo | undefined {
  return h.docker.containersOf(ENV_ID).find((c) => c.labels[LABEL_COMPOSE_SERVICE] === 'db');
}

/** A Compose devspace that is up to date: build record with the compose part, dev and db containers. */
async function seedCompose(
  p: {
    dev?: ContainerState | null;
    db?: ContainerState | null;
    record?: Partial<BuildRecord>;
    /** More labels of the dev container and of the db container. */
    devLabels?: Record<string, string>;
    dbLabels?: Record<string, string>;
    /** More fields of the entry. */
    extra?: Partial<Devspace>;
  } = {},
): Promise<void> {
  await seedDevspace(h, {
    ...(p.extra ? { extra: p.extra } : {}),
    container: p.dev === undefined ? 'stopped' : p.dev,
    containerLabels: { [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION), ...COMPOSE_LABELS, 'com.docker.compose.service': 'app', ...p.devLabels },
    record: {
      configHash: HASH,
      images: { [BASE_IMAGE]: DIGEST_NEW, [DB_IMAGE]: DB_DIGEST },
      compose: {
        service: 'app',
        images: [`${PROJECT}-app`],
        serviceImages: [DB_IMAGE],
        version: '2.40.3',
        inputsHash: composeInputsHash(CONFIG_TEXT, 'inputs-1', {}),
      },
      ...p.record,
    },
  });
  h.docker.images.add(DB_IMAGE);
  const dbState = p.db === undefined ? 'stopped' : p.db;
  if (dbState !== null) {
    h.docker.addContainer({
      devspaceId: ENV_ID,
      name: `${PROJECT}-db-1`,
      state: dbState,
      image: DB_IMAGE,
      labels: { [LABEL_COMPOSE_SERVICE]: 'db', ...COMPOSE_LABELS, 'com.docker.compose.service': 'db', ...p.dbLabels },
    });
  }
}

describe('first open of a Docker Compose configuration', () => {
  // The first opens of this group create the devspace, so its names carry the word of the source.
  const NAME = FIRST_OPEN_NAME;
  it('reads the model, checks it, builds the dev service image, and starts both services', async () => {
    const result = await h.service.open(TARGET, options());

    // No helper image is ensured before the lock (the worker runs its own image).
    expect(h.helper.calls.filter((call) => !call.startsWith('readConfigFiles') && call !== 'ensureImage')).toEqual([
      'clone main',
      `readConfiguration ${DEFAULT_CONFIG_PATH}`,
      `composeModel ${PROJECT}`,
      `readConfiguration ${DEFAULT_CONFIG_PATH}`,
      `build ${IMAGE_1}`,
      'prepareGit',
      `up ${IMAGE_1}`,
    ]);
    // The model run gets the compose files of the configuration, resolved against its folder.
    expect(h.helper.composeModels).toEqual([{ files: [`${FOLDER}/.devcontainer/compose.yml`], project: PROJECT }]);
    // devcontainer.json first without the merged configuration, then with our copy, whose only compose file is ours.
    // The first read also has the project name in its environment.
    expect(h.helper.readConfigurations[0]).toEqual({ configPath: DEFAULT_CONFIG_PATH, merged: false, env: { COMPOSE_PROJECT_NAME: PROJECT } });
    const merged = h.helper.readConfigurations[1];
    expect(merged.override).toMatchObject({ dockerComposeFile: [COMPOSE_MODEL_PATH], service: 'app', name: 'API' });
    expect(merged.env).toEqual({ COMPOSE_PROJECT_NAME: PROJECT });
    expect(Object.keys(merged.files ?? {}).sort()).toEqual([COMPOSE_MODEL_PATH, COMPOSE_DEV_DOCKERFILE].sort());

    // The images of all services are downloaded before the build (the image check covers them).
    expect(h.docker.log.filter((line) => line.startsWith('pull'))).toEqual([`pull ${BASE_IMAGE}`, `pull ${DB_IMAGE}`]);
    expect(h.checker.calls.at(-1)).toEqual({ images: [BASE_IMAGE, DB_IMAGE], features: [FEATURE] });

    // Build: our copy of devcontainer.json names the build model; the image-only dev service gets a build of its own.
    const build = h.helper.builds[0];
    expect(build.override).toMatchObject({ dockerComposeFile: [COMPOSE_MODEL_PATH], service: 'app' });
    expect(build.override).not.toHaveProperty('initializeCommand');
    expect(build.env).toEqual({ COMPOSE_PROJECT_NAME: PROJECT });
    expect(build.files?.[COMPOSE_DEV_DOCKERFILE]).toBe(`FROM ${BASE_IMAGE}\n`);
    const buildModel = JSON.parse(build.files?.[COMPOSE_MODEL_PATH] ?? '{}') as ComposeModel;
    expect(buildModel.services.app).toMatchObject({ image: `${PROJECT}-app`, build: { dockerfile: COMPOSE_DEV_DOCKERFILE } });

    // Up: the override configuration and the up model.
    const up = h.helper.ups[0];
    expect(up.override).toMatchObject({
      dockerComposeFile: [COMPOSE_MODEL_PATH],
      service: 'app',
      workspaceFolder: FOLDER,
      shutdownAction: 'none',
    });
    expect(up.override).not.toHaveProperty('image');
    expect(up.override).not.toHaveProperty('runArgs');
    expect(up.env).toEqual({ COMPOSE_PROJECT_NAME: PROJECT });
    const m = upModel();
    expect(m.name).toBe(PROJECT);
    expect(m.services.app).toMatchObject({
      image: IMAGE_1,
      pull_policy: 'never',
      container_name: NAME,
      labels: { [LABEL_DEVSPACE_ID]: ENV_ID, [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION) },
      volumes: [{ type: 'volume', source: WORKSPACE_VOLUME_KEY, target: '/workspaces' }],
    });
    expect(m.services.app).not.toHaveProperty('build');
    // The tmpfs of the token, only in the dev container; the token is written into it after `up`.
    expect(m.services.app.tmpfs).toEqual([TOKEN_TMPFS]);
    expect(m.services.db).not.toHaveProperty('tmpfs');
    expect(h.docker.tokenWrites()).toEqual([expect.objectContaining({ container: h.docker.containersOf(ENV_ID).find((c) => c.name === NAME)?.id, user: 'root', token: TOKEN, login: 'octo' })]);
    expect(JSON.stringify(h.helper.ups)).not.toContain(TOKEN);
    expect(m.services.db).toMatchObject({
      pull_policy: 'missing',
      labels: { [LABEL_DEVSPACE_ID]: ENV_ID, [LABEL_COMPOSE_SERVICE]: 'db' },
      ports: [expect.objectContaining({ target: 5432, host_ip: '127.0.0.1' })],
    });
    // A file of the repository reaches the service from the workspace volume (volume.subpath).
    expect(m.services.db.volumes).toContainEqual({
      type: 'volume',
      source: WORKSPACE_VOLUME_KEY,
      target: '/docker-entrypoint-initdb.d/init.sql',
      volume: { nocopy: true, subpath: 'api/init.sql' },
      read_only: true,
    });
    expect(m.volumes).toEqual({
      pgdata: { name: `${PROJECT}_pgdata`, external: true },
      cache: { name: `${PROJECT}_cache`, external: true },
      [WORKSPACE_VOLUME_KEY]: { name: NAME, external: true },
    });

    // The volumes are created before `up` with the labels of the devspace: the project volume as service data.
    const labels = { [LABEL_DEVSPACE_ID]: ENV_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id };
    // The volume of the service db is labelled as its data.
    expect(h.docker.volumes.get(`${PROJECT}_pgdata`)).toEqual({ ...labels, [LABEL_VOLUME]: VOLUME_KIND_COMPOSE, 'nimblescape.devspaces.service-data': 'true' });
    // The volume of a `mounts` entry is a volume of the project too (`<project>_cache`), so it is `compose` (never
    // shared with another devspace), not `additional`.
    expect(h.docker.volumes.get(`${PROJECT}_cache`)).toEqual({ ...labels, [LABEL_VOLUME]: VOLUME_KIND_COMPOSE });
    expect(h.docker.log.indexOf(`volume create ${PROJECT}_pgdata`)).toBeGreaterThanOrEqual(0);

    // Both containers carry the devspace ID; the lookup finds the dev container.
    expect(devContainer()).toMatchObject({ name: NAME, state: 'running', image: IMAGE_1 });
    expect(dbContainer()).toMatchObject({ state: 'running', labels: expect.objectContaining({ [LABEL_DEVSPACE_ID]: ENV_ID }) });
    expect((await h.docker.findContainer(ENV_ID, NAME))?.name).toBe(NAME);
    expect(result).toMatchObject({ containerName: NAME, remoteWorkspaceFolder: FOLDER });

    const entry = await h.registry.get(ENV_ID);
    expect(entry?.buildRecord).toMatchObject({
      devspaceImage: IMAGE_1,
      configHash: HASH,
      images: { [BASE_IMAGE]: DIGEST_NEW, [DB_IMAGE]: DB_DIGEST },
      features: { [FEATURE]: FEATURE_DIGEST },
      compose: { service: 'app', images: [`${PROJECT}-app`] },
    });
    expect(entry?.additionalVolumes).toEqual(expect.arrayContaining([`${PROJECT}_pgdata`, `${PROJECT}_cache`]));
    expect(h.logger.infos.some((line) => line.includes('Changed in the Docker Compose model') && line.includes('published on 127.0.0.1 only'))).toBe(true);
  });

  // The switch of the host access checks applies to Docker Compose: privileged mode is access to the computer (class
  // `computer`), which the checks off lift, as for a single container (describe 'Docker Compose with the host access
  // checks off'). So this refusal is checked with the checks on; the checks off keep the items of the class `protected`
  // refused (below).
  it('refuses a privileged side service before any build', async () => {
    useCompose(h, output((m) => (m.services.db.privileged = true)));
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toBe(Messages.hostAccess('service db: privileged mode'));
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.ups).toEqual([]);
    expect(h.docker.log.filter((line) => line.startsWith('pull'))).toEqual([]);
    // A failed first open leaves nothing behind.
    expect(await h.registry.list()).toEqual([]);
    expect(h.docker.containers.size).toBe(0);
  });

  it('refuses the workspace volume in a side service before any build, also with the host access checks off', async () => {
    h.settings = { ...h.settings, hostAccessChecksOff: [REPO] };
    useCompose(
      h,
      output((m) => {
        (m.services.db.volumes as unknown[]).push({ type: 'bind', source: '/workspaces', target: '/w' });
      }),
    );
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    // The workspace volume does not hold the GitHub token (it is in the memory of the dev container).
    expect(error.message).toBe(Messages.hostAccess('service db: bind mount /workspaces → /w (the workspace volume, with the repository and the Git configuration of the devspace)'));
    expect(h.helper.builds).toEqual([]);
    expect(await h.registry.list()).toEqual([]);
  });

  // devcontainer.json of a Compose configuration follows the switch as a single configuration does (privileged mode is
  // lifted with the checks off, describe 'Docker Compose with the host access checks off'); it is checked with the
  // checks on here.
  it('checks devcontainer.json of a Compose configuration with the rules of a single configuration', async () => {
    h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: CONFIG_TEXT.replace('"remoteUser"', '"privileged": true, "remoteUser"') } };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toBe(Messages.hostAccess('privileged mode'));
    expect(h.helper.builds).toEqual([]);
  });

  it('refuses a configuration without a dev service before the model run', async () => {
    h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: '{ "dockerComposeFile": "compose.yml" }' } };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toBe(Messages.unsupportedOptions('service (the dev service of the Docker Compose configuration is missing)'));
    expect(h.helper.composeModels).toEqual([]);
  });

  it('refuses a dev service that the model does not have, and a local Feature', async () => {
    h.helper.files = {
      [DEFAULT_CONFIG_PATH]: { configText: '{ "dockerComposeFile": "compose.yml", "service": "web", "features": { "./local": {} } }' },
    };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toContain('local Feature ./local in a Docker Compose configuration');
    expect(error.message).toContain('service web (not in the Docker Compose configuration)');
    expect(h.helper.builds).toEqual([]);
  });

  it('refuses a service image that is an image of a devspace of another account, whatever the switch says', async () => {
    const theirs = devspaceImageName('acme/web', OTHER_ID, 1);
    await seedDevspace(h, { id: OTHER_ID, repository: 'acme/web', owner: OTHER_ACCOUNT, container: null, volume: false });
    h.docker.images.add(BASE_IMAGE);
    h.docker.images.add(DB_IMAGE);
    h.docker.imageIds.set(DB_IMAGE, `sha256:image-of-${theirs}`);
    for (const checksOff of [false, true]) {
      if (checksOff) h.settings = { ...h.settings, hostAccessChecksOff: [REPO] };
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('hostAccess');
      expect(error.message).toContain(`service db: image ${DB_IMAGE} (an image of a devspace of another GitHub account)`);
      expect(h.helper.builds).toEqual([]);
    }
  });

  it('refuses a project volume of another devspace', async () => {
    h.docker.volumes.set(`${PROJECT}_pgdata`, { [LABEL_DEVSPACE_ID]: OTHER_ID, [LABEL_REPOSITORY]: 'acme/other' });
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toContain(`${PROJECT}_pgdata`);
    expect(h.helper.builds).toEqual([]);
    // The volume of the other devspace stays.
    expect(h.docker.volumes.get(`${PROJECT}_pgdata`)).toEqual({ [LABEL_DEVSPACE_ID]: OTHER_ID, [LABEL_REPOSITORY]: 'acme/other' });
  });

  it('refuses a bind mount of repository files with a Docker Engine older than 26, naming the version', async () => {
    h.docker.apiVersion = '1.44';
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.message).toBe(
      Messages.unsupportedOptions(`service db: bind mount ${FOLDER}/init.sql → /docker-entrypoint-initdb.d/init.sql (needs Docker Engine 26 or newer)`),
    );
  });

  it('names an engine whose version could not be read as unknown, not as old', async () => {
    h.docker.apiVersion = undefined;
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.message).toBe(
      Messages.unsupportedOptions(
        `service db: bind mount ${FOLDER}/init.sql → /docker-entrypoint-initdb.d/init.sql (needs Docker Engine 26 or newer; the version of the Docker Engine could not be read)`,
      ),
    );
  });

  it('refuses a network of another devspace under a name of its own, found by its labels, before any build', async () => {
    useCompose(
      h,
      output((m) => {
        m.networks = { ...m.networks, backend: { name: 'backend' } };
        m.services.db.networks = { default: null, backend: null };
      }),
    );
    // The project of another devspace is composeProjectName.
    h.docker.networks.set('backend', { 'com.docker.compose.project': OTHER_PROJECT });
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.message).toBe(Messages.hostAccess('network backend of another devspace'));
    expect(h.helper.builds).toEqual([]);
    expect(h.docker.networkInspections[0]).toEqual(expect.arrayContaining([`${PROJECT}_default`, 'backend']));
  });

  it('refuses an external network that a container of another devspace uses', async () => {
    useCompose(h, output((m) => (m.networks = { ...m.networks, shared: { name: 'shared', external: true } })));
    const other = h.docker.addContainer({ devspaceId: OTHER_ID, name: resourceName('acme/other', OTHER_ID), state: 'running', image: 'x' });
    h.docker.networks.set('shared', {});
    h.docker.networkContainers.set('shared', [other.id]);
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.message).toBe(Messages.hostAccess('network shared of another devspace'));
    expect(h.helper.builds).toEqual([]);
  });

  it('refuses a network of another devspace that network_mode names by a prefix of its ID', async () => {
    useCompose(h, output((m) => (m.services.db.network_mode = 'f00dbabe')));
    // The project of another devspace is composeProjectName.
    h.docker.networks.set(`${OTHER_PROJECT}_default`, { 'com.docker.compose.project': OTHER_PROJECT });
    h.docker.networkIds.set(`${OTHER_PROJECT}_default`, `f00dbabe${'0'.repeat(56)}`);
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.message).toBe(Messages.hostAccess('service db: network f00dbabe of another devspace'));
    expect(h.helper.builds).toEqual([]);
  });

  it('allows an external network with a container of another devspace of the same owner', async () => {
    useCompose(h, output((m) => (m.networks = { ...m.networks, shared: { name: 'shared', external: true } })));
    await seedDevspace(h, { id: OTHER_ID, repository: 'acme/web', container: 'running' });
    h.docker.networks.set('shared', {});
    h.docker.networkContainers.set('shared', [h.docker.containersOf(OTHER_ID)[0].id]);
    await h.service.open(TARGET, options());
    expect(h.helper.ups).toHaveLength(1);
  });

  it('refuses a local build whose Dockerfile links out of the repository, before any build', async () => {
    useCompose(h, {
      ...output((m) => (m.services.db = { build: { context: `${FOLDER}/db`, dockerfile: 'Dockerfile' } })),
      realPaths: { '/workspaces': '/workspaces', [`${FOLDER}/db`]: '/devspace-cache', [`${FOLDER}/db/Dockerfile`]: '/devspace-cache/Dockerfile' },
    });
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.message).toContain(`service db: build context ${FOLDER}/db (a link to /devspace-cache, outside of the repository)`);
    expect(h.helper.builds).toEqual([]);
  });

  it('allows a side service built FROM the image of another devspace', async () => {
    useCompose(h, {
      ...output((m) => (m.services.db = { build: { context: `${FOLDER}/db`, dockerfile: 'Dockerfile' } })),
      dockerfiles: { db: `FROM index.docker.io/library/${devspaceImageName('acme/web', OTHER_ID, 3)}\n` },
    });
    // The Dockerfile is not checked, so the FROM image of another devspace (named devspaceImageName) is not
    // refused. The fake Docker has no build of Compose: the image that Compose builds for the service, named after the
    // project (composeProjectName), with the ID label of the devspace.
    h.docker.images.add(`${PROJECT}-db`);
    h.docker.imageConfigs.set(`${PROJECT}-db`, { Labels: { [LABEL_DEVSPACE_ID]: ENV_ID } });
    await h.service.open(TARGET, options());
    expect(h.helper.ups).toHaveLength(1);
  });

  it('refuses the image of a side service that Docker would find by the prefix of its ID', async () => {
    useCompose(h, output((m) => (m.services.db.image = 'a1b2c3')));
    h.docker.images.add('a1b2c3');
    h.docker.imageRepoNames.set('a1b2c3', { repoTags: [`${OTHER_PROJECT}-db:latest`], repoDigests: [] });
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.message).toBe(Messages.unsupportedOptions('service db: image a1b2c3 (an image ID; name the image)'));
    expect(h.helper.builds).toEqual([]);
  });

  it('uses the image of a side service that Docker Compose built for another project', async () => {
    h.docker.images.add(DB_IMAGE);
    h.docker.imageConfigs.set(DB_IMAGE, { Labels: { 'com.docker.compose.project': 'app', 'com.docker.compose.service': 'db' } });
    await h.service.open(TARGET, options());
    expect(h.helper.ups).toHaveLength(1);
  });

  describe('the image of another devspace as the image of a side service', () => {
    const theirs = { [LABEL_DEVSPACE_ID]: OTHER_ID, [LABEL_REPOSITORY]: 'acme/web', [LABEL_OWNER_ID]: ACCOUNT.id };

    it('uses one of a devspace of the same account', async () => {
      await seedDevspace(h, { id: OTHER_ID, repository: 'acme/web', container: null });
      h.docker.images.add(DB_IMAGE);
      h.docker.imageConfigs.set(DB_IMAGE, { Labels: theirs });
      await h.service.open(TARGET, options());
      expect(h.helper.ups).toHaveLength(1);
    });

    it('refuses one of a devspace of another account, and the build record on it', async () => {
      await seedDevspace(h, { id: OTHER_ID, repository: 'acme/web', container: null, owner: OTHER_ACCOUNT });
      h.docker.images.add(DB_IMAGE);
      h.docker.imageConfigs.set(DB_IMAGE, { Labels: { ...theirs, [LABEL_OWNER_ID]: OTHER_ACCOUNT.id } });
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.message).toContain(`label ${LABEL_DEVSPACE_ID} of the image ${DB_IMAGE}`);
      expect(h.helper.ups).toEqual([]);
    });

    it('uses the devspace image of a devspace of the same account, with its build record', async () => {
      await seedDevspace(h, { id: OTHER_ID, repository: 'acme/web', container: null });
      h.docker.images.add(DB_IMAGE);
      // Every devspace image carries the label of its build record.
      h.docker.imageConfigs.set(DB_IMAGE, { Labels: { ...theirs, [LABEL_BUILD_RECORD]: '{}' } });
      await h.service.open(TARGET, options());
      expect(h.helper.ups).toHaveLength(1);
    });

    // With several devspaces of the account, the image is checked against the one whose ID it carries, not against
    // the first devspace of the account.
    it('uses the image of the second of several devspaces of the same account', async () => {
      await seedDevspace(h, { id: '9a9a9a9a-0000-4000-8000-000000000009', repository: 'acme/tools', container: null });
      await seedDevspace(h, { id: OTHER_ID, repository: 'acme/web', container: null });
      h.docker.images.add(DB_IMAGE);
      h.docker.imageConfigs.set(DB_IMAGE, { Labels: { ...theirs, [LABEL_BUILD_RECORD]: '{}' } });
      await h.service.open(TARGET, options());
      expect(h.helper.ups).toHaveLength(1);
    });
  });

  // The build record is allowed on the devspace image only; a side service image with this devspace's own labels
  // and a build record is refused.
  it('refuses the build record on the image of a side service with the own labels of the devspace', async () => {
    h.docker.images.add(DB_IMAGE);
    h.docker.imageConfigs.set(DB_IMAGE, {
      Labels: { [LABEL_DEVSPACE_ID]: ENV_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id, [LABEL_BUILD_RECORD]: '{}' },
    });
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.message).toContain(`label ${LABEL_BUILD_RECORD} of the image ${DB_IMAGE}`);
    expect(error.message).not.toContain(`label ${LABEL_DEVSPACE_ID} of the image ${DB_IMAGE}`);
    expect(h.helper.ups).toEqual([]);
  });

  it('refuses a label of the extension on the image of a side service before up creates the containers', async () => {
    h.docker.images.add(DB_IMAGE);
    h.docker.imageConfigs.set(DB_IMAGE, { Labels: { 'nimblescape.devspaces.compose-service': 'x' } });
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.message).toBe(Messages.hostAccess(`label nimblescape.devspaces.compose-service of the image ${DB_IMAGE}`));
    expect(h.helper.ups).toEqual([]);
  });

  it('reports a compose file that Docker Compose cannot read, with its message in the details', async () => {
    h.helper.composeOutput = { error: 'yaml: line 3: mapping values are not allowed in this context' };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('buildFailed');
    expect(error.message).toBe(Messages.composeConfigurationFailed);
    expect(error.detail).toContain('mapping values are not allowed');
    expect(await h.registry.list()).toEqual([]);
  });

  it('refuses the image metadata of the dev service image before up (a Feature with privileged mode)', async () => {
    h.helper.buildMetadata = [{ id: 'ghcr.io/acme/features/dind:1', privileged: true }];
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(h.helper.ups).toEqual([]);
    expect(h.docker.images.has(IMAGE_1)).toBe(false);
  });

  it('checks the model again before up creates the containers, with the labels of the volumes then', async () => {
    // Another devspace took the name of the project volume while the image was built.
    h.helper.onBuild = () => {
      h.docker.volumes.set(`${PROJECT}_pgdata`, { [LABEL_DEVSPACE_ID]: OTHER_ID, [LABEL_REPOSITORY]: 'acme/other' });
    };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toContain(`${PROJECT}_pgdata`);
    expect(h.helper.builds).toHaveLength(1);
    expect(h.helper.ups).toEqual([]);
    expect(h.docker.images.has(IMAGE_1)).toBe(false);
  });

  it('does not check or pass the properties that the CLI ignores for Compose, and logs them', async () => {
    h.helper.files = {
      [DEFAULT_CONFIG_PATH]: { configText: CONFIG_TEXT.replace('"remoteUser"', '"runArgs": ["--privileged"], "appPort": [3000], "remoteUser"') },
    };
    await h.service.open(TARGET, options());
    expect(h.logger.infos).toContain(
      `The Dev Container CLI ignores runArgs, appPort of ${DEFAULT_CONFIG_PATH} for Docker Compose. They are not used and not checked.`,
    );
    expect(h.helper.ups[0].override).not.toHaveProperty('runArgs');
    expect(h.helper.ups[0].override).not.toHaveProperty('appPort');
  });

  it('fails when up used another Compose project', async () => {
    h.helper.composeProjectNameResult = 'api_devcontainer';
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('startFailed');
    expect(error.detail).toContain(`not ${PROJECT}`);
  });
});

// The Monitor again after `up` of Docker Compose started the dev container, as in runUp: once per run, after
// `up` and before the lifecycle commands.
describe('the Monitor again after `up` of Docker Compose', () => {
  // The port takes no helper tag or image (the worker's monitor runs its own).
  interface Ensure {
    signal: AbortSignal | undefined;
    ups: number;
    userCommands: number;
  }

  /** A harness with a Monitor on the local Docker; `fail` decides the outcome of the ensure with that index. */
  function withSessionMonitor(fail: (index: number) => Promise<void> = async () => undefined): Ensure[] {
    h.cleanup();
    const ensures: Ensure[] = [];
    const sessionMonitor: DevspaceSessionMonitor = {
      ensure: async (signal) => {
        ensures.push({ signal, ups: h.helper.ups.length, userCommands: h.helper.userCommandRuns.length });
        return fail(ensures.length - 1);
      },
      heartbeat: async () => ({ ok: true }),
      forget: async () => undefined,
      images: async () => undefined,
    };
    h = createHarness({
      newDevspaceId: () => ENV_ID,
      dockerTarget: async () => ({ kind: 'local', host: '', endpoint: 'unix:///var/run/docker.sock' }),
      sessionMonitor,
    });
    useCompose(h);
    return ensures;
  }

  it('ensures it again after `up` and before the lifecycle commands, with the same signal, once', async () => {
    const ensures = withSessionMonitor();
    await seedCompose();
    const controller = new AbortController();
    await h.service.openDevspace(ENV_ID, { progress: h.progress, signal: controller.signal });
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_1}`]);
    expect(ensures.map(({ ups, userCommands }) => ({ ups, userCommands }))).toEqual([
      { ups: 0, userCommands: 0 },
      { ups: 1, userCommands: 0 },
    ]);
    expect(h.helper.userCommandRuns).toHaveLength(1);
    expect(ensures[1].signal).toBe(ensures[0].signal);
    expect(ensures[1].signal).toBeDefined();
  });

  it('a first open (model, build, up) ensures it again after `up` created the containers', async () => {
    const ensures = withSessionMonitor();
    await h.service.open(TARGET, options());
    expect(ensures.map(({ ups, userCommands }) => ({ ups, userCommands }))).toEqual([
      { ups: 0, userCommands: 0 },
      { ups: 1, userCommands: 0 },
    ]);
  });

  it('a failed `up` ensures it too, and keeps the error of `up`', async () => {
    const ensures = withSessionMonitor();
    await seedCompose();
    h.helper.upError = () => new Error('compose up failed: port is already allocated');
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('startFailed');
    expect(error.detail).toContain('port is already allocated');
    expect(ensures.map(({ ups, userCommands }) => ({ ups, userCommands }))).toEqual([
      { ups: 0, userCommands: 0 },
      { ups: 1, userCommands: 0 },
    ]);
  });

  it('a cancelled `up` does not ensure it again', async () => {
    const ensures = withSessionMonitor();
    await seedCompose();
    const controller = new AbortController();
    h.helper.upError = () => {
      controller.abort();
      return abortError();
    };
    const error = await rejection(h.service.openDevspace(ENV_ID, { progress: h.progress, signal: controller.signal }));
    expect(error.code).toBe('cancelled');
    expect(ensures.map(({ ups, userCommands }) => ({ ups, userCommands }))).toEqual([{ ups: 0, userCommands: 0 }]);
  });

  it('a failed `up` keeps its error when the second ensure rejects with an AbortError', async () => {
    const ensures = withSessionMonitor(async (index) => (index === 1 ? Promise.reject(abortError()) : undefined));
    await seedCompose();
    h.helper.upError = () => new Error('compose up failed: port is already allocated');
    const error = await rejection(h.service.openDevspace(ENV_ID, { progress: h.progress, signal: new AbortController().signal }));
    expect(error.code).toBe('startFailed');
    expect(error.detail).toContain('port is already allocated');
    expect(ensures).toHaveLength(2);
  });

  it('a failure of the second ensure is a warning, and the open goes on', async () => {
    withSessionMonitor(async (index) => (index === 1 ? Promise.reject(new Error('docker run failed')) : undefined));
    await seedCompose();
    await h.service.openDevspace(ENV_ID, options());
    expect(h.helper.userCommandRuns).toHaveLength(1);
    expect(h.ui.warnings).toContainEqual(expect.stringContaining(`The Monitor on the local Docker could not be started after the container of ${REPO}`));
  });
});

describe('existing Docker Compose devspace', () => {
  it('opens again without a build: up starts both containers', async () => {
    await seedCompose();
    const dev = devContainer()?.id;
    const db = dbContainer()?.id;
    await h.service.openDevspace(ENV_ID, options());
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_1}`]);
    expect(devContainer()).toMatchObject({ id: dev, state: 'running' });
    expect(dbContainer()).toMatchObject({ id: db, state: 'running' });
    expect(h.ui.prompts).toEqual([]);
    // The existing container passed the checks when it was created: the model and the image are not checked again (no
    // image inspect). The volumes of the model that are missing are created all the same (without them, `up` would fail
    // on an external volume that does not exist).
    expect(h.docker.log.filter((line) => line.startsWith('image inspect'))).toEqual([]);
    expect(h.docker.log.filter((line) => line.startsWith('volume create')).sort()).toEqual([`volume create ${PROJECT}_cache`, `volume create ${PROJECT}_pgdata`]);
  });

  it('creates only the missing volumes when up adds the container of a new service', async () => {
    await seedCompose({ dev: 'stopped', db: 'stopped' });
    h.docker.volumes.set(`${PROJECT}_pgdata`, volumeLabelsOf(VOLUME_KIND_COMPOSE));
    h.docker.volumes.set(`${PROJECT}_cache`, volumeLabelsOf(VOLUME_KIND_COMPOSE));
    // The model gained a service with a volume; "Rebuild later" starts the devspace without a build.
    useCompose(
      h,
      output((m) => {
        m.services.cache = { image: DB_IMAGE, volumes: [{ type: 'volume', source: 'cachedata', target: '/data' }] };
        m.volumes = { ...m.volumes, cachedata: { name: `${PROJECT}_cachedata` } };
      }),
    );
    h.ui.configurationChangedAnswer = 'later';
    await h.service.openDevspace(ENV_ID, options());
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_1}`]);
    expect(h.docker.log.filter((line) => line.startsWith('volume create'))).toEqual([`volume create ${PROJECT}_cachedata`]);
    expect(h.docker.volumes.get(`${PROJECT}_cachedata`)?.[LABEL_VOLUME]).toBe(VOLUME_KIND_COMPOSE);
    expect(h.docker.log.indexOf(`volume create ${PROJECT}_cachedata`)).toBeGreaterThanOrEqual(0);
    expect(upModel().volumes).toMatchObject({ cachedata: { name: `${PROJECT}_cachedata`, external: true } });
  });

  it('starts a stopped side service when the dev container runs', async () => {
    await seedCompose({ dev: 'running', db: 'stopped' });
    await h.service.openDevspace(ENV_ID, options());
    expect(h.helper.ups).toEqual([]);
    expect(h.docker.log).toContain(`start ${dbContainer()?.id}`);
    expect(dbContainer()?.state).toBe('running');
  });

  it('updates when the image of a side service changed: pull, build, and replace the dev container', async () => {
    await seedCompose({ record: { images: { [BASE_IMAGE]: DIGEST_NEW, [DB_IMAGE]: DB_DIGEST } } });
    h.checker.outcome = checked({ [BASE_IMAGE]: DIGEST_NEW, [DB_IMAGE]: DB_DIGEST_NEW }, { [FEATURE]: FEATURE_DIGEST });
    await h.service.openDevspace(ENV_ID, options());
    // The image of the dev service is not downloaded before the build; only the changed image is pulled.
    expect(h.docker.log.filter((line) => line.startsWith('pull'))).toEqual([`pull ${DB_IMAGE}`]);
    expect(h.helper.calls.filter((call) => call.startsWith('build') || call.startsWith('up'))).toEqual([
      `build ${IMAGE_2}`,
      `up ${IMAGE_2} --remove-existing-container`,
    ]);
    expect(upModel().services.app.image).toBe(IMAGE_2);
    const entry = await h.registry.get(ENV_ID);
    expect(entry?.buildRecord).toMatchObject({ devspaceImage: IMAGE_2, images: { [DB_IMAGE]: DB_DIGEST_NEW } });
    expect(h.docker.images.has(IMAGE_1)).toBe(false);
  });

  it('removes the old base image of the dev service after an update, but not the old image of a side service', async () => {
    await seedCompose({
      record: { images: { [BASE_IMAGE]: DIGEST_OLD, [DB_IMAGE]: DB_DIGEST }, compose: { service: 'app', images: [`${PROJECT}-app`], serviceImages: [DB_IMAGE], version: '2.40.3', inputsHash: composeInputsHash(CONFIG_TEXT, 'inputs-1', {}) } },
    });
    const oldBase = `mcr.microsoft.com/devcontainers/base@${DIGEST_OLD}`;
    const oldDb = `docker.io/library/postgres@${DB_DIGEST}`;
    h.docker.images.add(oldBase);
    h.docker.images.add(oldDb);
    h.checker.outcome = checked({ [BASE_IMAGE]: DIGEST_NEW, [DB_IMAGE]: DB_DIGEST_NEW }, { [FEATURE]: FEATURE_DIGEST });
    await h.service.openDevspace(ENV_ID, options());
    expect(h.helper.builds.map((build) => build.imageName)).toEqual([IMAGE_2]);
    expect(h.docker.log).toContain(`rmi ${oldBase}`);
    // The image of the database is the user's (for example also used outside Devspaces).
    expect(h.docker.log).not.toContain(`rmi ${oldDb}`);
    expect(h.docker.images.has(oldDb)).toBe(true);
  });

  it('keeps the devspace when the newer dev service image needs access to the computer (refused update)', async () => {
    await seedCompose({ record: { images: { [BASE_IMAGE]: DIGEST_OLD, [DB_IMAGE]: DB_DIGEST } } });
    h.helper.buildMetadata = [{ id: 'ghcr.io/acme/features/dind:1', privileged: true }];
    await h.service.openDevspace(ENV_ID, options());
    expect(h.helper.calls.filter((call) => call.startsWith('build') || call.startsWith('up'))).toEqual([`build ${IMAGE_2}`, `up ${IMAGE_1}`]);
    expect(h.docker.images.has(IMAGE_2)).toBe(false);
    expect(h.ui.warnings).toEqual([Messages.updateRefused('privileged mode')]);
    const entry = await h.registry.get(ENV_ID);
    expect(entry?.buildRecord?.devspaceImage).toBe(IMAGE_1);
    expect(entry?.refusedUpdate).toMatchObject({ configHash: HASH, items: 'privileged mode' });

    // The same update is not built again.
    h.helper.calls.length = 0;
    devContainer()!.state = 'stopped';
    await h.service.openDevspace(ENV_ID, options());
    expect(h.helper.builds.map((build) => build.imageName)).toEqual([IMAGE_2]);
  });

  it('asks before a rebuild when the model changed, and rebuilds on "Rebuild now"', async () => {
    await seedCompose();
    useCompose(h, output((m) => (m.services.db.environment = { POSTGRES_PASSWORD: 'dev' })));
    h.ui.configurationChangedAnswer = 'rebuildNow';
    await h.service.openDevspace(ENV_ID, options());
    expect(h.ui.prompts).toEqual([`configurationChanged ${REPO}`]);
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_2} --remove-existing-container`]);
    const changed = (h.helper.composeOutput as ComposeModelOutput).model;
    expect((await h.registry.get(ENV_ID))?.buildRecord?.configHash).toBe(composeConfigHash(CONFIG_TEXT, changed, {}));
  });

  it('takes over a new Compose version that prints the unchanged files as another model, without a question', async () => {
    await seedCompose({ record: { compose: { service: 'app', images: [`${PROJECT}-app`], serviceImages: [DB_IMAGE], version: '2.39.0', inputsHash: composeInputsHash(CONFIG_TEXT, 'inputs-1', {}) } } });
    // The same files, printed by the newer plugin with a key more.
    useCompose(h, { ...output((m) => (m.services.db.stop_signal = 'SIGTERM')), version: '2.40.3' });
    await h.service.openDevspace(ENV_ID, options());
    expect(h.ui.prompts).toEqual([]);
    expect(h.helper.builds).toEqual([]);
    const record = (await h.registry.get(ENV_ID))?.buildRecord;
    expect(record?.configHash).toBe(composeConfigHash(CONFIG_TEXT, (h.helper.composeOutput as ComposeModelOutput).model, {}));
    expect(record?.compose?.version).toBe('2.40.3');
  });

  it('asks when the files changed, and when the same Compose version prints another model', async () => {
    const record = { compose: { service: 'app', images: [`${PROJECT}-app`], serviceImages: [DB_IMAGE], version: '2.40.3', inputsHash: composeInputsHash(CONFIG_TEXT, 'inputs-1', {}) } };
    await seedCompose({ record });
    // The open asks for the changed model.
    useCompose(h, { ...output(), version: '2.41.0', inputsHash: 'inputs-2' });
    useCompose(h, output((m) => (m.services.db.stop_signal = 'SIGTERM')));
    h.ui.configurationChangedAnswer = 'later';
    await h.service.openDevspace(ENV_ID, options());
    expect(h.ui.prompts).toEqual([`configurationChanged ${REPO}`]);
  });

  it('refuses to start the containers when the configuration cannot be read', async () => {
    await seedCompose();
    h.helper.composeOutput = { error: 'yaml: invalid' };
    // No docker start fallback: the start fails, and nothing starts.
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('startFailed');
    expect(error.message).toBe(PipelineTexts.startFailed);
    expect(error.detail).toContain('The Docker Compose configuration cannot be read');
    expect(h.helper.ups).toEqual([]);
    expect(h.docker.log.filter((line) => line.startsWith('start'))).toEqual([]);
    expect(devContainer()?.state).toBe('stopped');
    expect(dbContainer()?.state).toBe('stopped');
    expect(h.ui.warnings).toEqual([Messages.composeConfigurationFailed]);
  });

  it.each<[string, () => Promise<void>, string]>([
    [
      'there',
      () => seedCompose(),
      'The Docker Compose configuration cannot be read. The containers of Docker Compose start only through the Dev Container CLI, which needs the Docker Compose configuration.',
    ],
    [
      'outdated',
      () => seedCompose({ devLabels: { [LABEL_CONTAINER_VERSION]: '0' } }),
      `The Docker Compose configuration cannot be read, and the container ${NAME} must be created again (it was created while the host access checks were off, or by an older version), which needs the configuration.`,
    ],
    ['missing', () => seedCompose({ dev: null }), 'The Docker Compose configuration cannot be read, and the devspace has no container.'],
  ])('names in the start failure whether the dev container is %s', async (_name, seed, detail) => {
    await seed();
    h.helper.composeOutput = { error: 'yaml: invalid' };
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('startFailed');
    expect(error.message).toBe(PipelineTexts.startFailed);
    expect(error.detail).toBe(detail);
    expect(h.helper.ups).toEqual([]);
    // The log line does not claim that the devspace is started.
    expect(h.logger.errors.filter((line) => line.startsWith('The configuration of'))).toEqual([
      expect.stringContaining(`The configuration of ${REPO} could not be used. Its containers are not started.`),
    ]);
    expect(h.logger.warnings).toContain(`The Docker Compose configuration of ${REPO} cannot be read. Its containers are not started.`);
  });

  it('opens a running dev container that is current as it is without the workspace helper', async () => {
    await seedCompose({ dev: 'running', db: 'running' });
    h.helper.ensureImageError = new UserFacingError('helperFailed', Messages.helperFailed);
    // The tag of the helper image exists (the open takes the lock, which builds only a missing tag); the maintaining
    // ensure of the open fails. A missing tag refuses the open before anything is changed
    // (devspaceService.lock.test.ts).
    h.helper.tagPresent = true;
    await h.service.openDevspace(ENV_ID, options());
    expect(h.ui.warnings).toEqual([Messages.helperFailed]);
    // The log line names the helper, not the configuration.
    expect(h.logger.errors).toEqual([`The workspace helper is not available for ${REPO}. The running devspace is opened as it is. ${Messages.helperFailed}`]);
    expect(h.helper.ups).toEqual([]);
  });

  // A configuration of another kind is not kept (keepsKind false). A helperFailed during an update fails the open: the
  // running single container created without the configuration is not opened as it is.
  it('ends the open with helperFailed although the single container created without the configuration still runs when the configuration now uses Docker Compose and the rebuild fails with helperFailed', async () => {
    await seedDevspace(h, { container: 'running', containerLabels: { [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION), 'nimblescape.devspaces.container-config': 'unknown' } });
    h.docker.images.add(DB_IMAGE);
    const single = h.docker.containersOf(ENV_ID)[0];
    h.ui.configurationChangedAnswer = 'rebuildNow';
    h.helper.buildError = () => new UserFacingError('helperFailed', Messages.helperFailed, 'No such image: x');
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('helperFailed');
    expect(h.ui.warnings).toEqual([]);
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([]);
    expect(h.docker.containersOf(ENV_ID)).toEqual([expect.objectContaining({ id: single.id, state: 'running' })]);
  });

  it('ends the open with helperFailed although the containers still run when the build of the update fails with helperFailed', async () => {
    await seedCompose({ dev: 'running', db: 'running', dbLabels: { 'com.docker.compose.image': `sha256:image-of-${DB_IMAGE}`, 'com.docker.compose.config-hash': 'hash-of-db' } });
    const dev = devContainer()?.id;
    const db = dbContainer()?.id;
    h.checker.outcome = checked({ [BASE_IMAGE]: DIGEST_NEW, [DB_IMAGE]: DB_DIGEST_NEW }, { [FEATURE]: FEATURE_DIGEST });
    h.helper.buildError = () => new UserFacingError('helperFailed', Messages.helperFailed, 'No such image: x');
    // A helperFailed during an update fails the open: the running containers are not opened as they are.
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('helperFailed');
    expect(h.helper.builds.map((build) => build.imageName)).toEqual([IMAGE_2]);
    expect(h.ui.warnings).toEqual([]);
    expect(h.helper.ups).toEqual([]);
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([]);
    expect(devContainer()).toMatchObject({ id: dev, state: 'running' });
    expect(dbContainer()).toMatchObject({ id: db, state: 'running' });
  });

  it('ends the open with helperFailed, without the Git warning, although the containers still run when the Git setup before up of the update fails with helperFailed', async () => {
    await seedCompose({ dev: 'running', db: 'running', dbLabels: { 'com.docker.compose.image': `sha256:image-of-${DB_IMAGE}`, 'com.docker.compose.config-hash': 'hash-of-db' } });
    const dev = devContainer()?.id;
    const db = dbContainer()?.id;
    h.checker.outcome = checked({ [BASE_IMAGE]: DIGEST_NEW, [DB_IMAGE]: DB_DIGEST_NEW }, { [FEATURE]: FEATURE_DIGEST });
    const gone = () => new UserFacingError('helperFailed', Messages.helperFailed, `No such image: sha256:${'4'.repeat(64)}`);
    h.helper.prepareGitError = gone();
    h.helper.upError = () => gone();
    // A helperFailed during an update fails the open: the running containers are not opened as they are.
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('helperFailed');
    expect(h.ui.warnings).toEqual([]);
    expect(h.helper.ups).toEqual([]);
    expect(devContainer()).toMatchObject({ id: dev, state: 'running' });
    expect(dbContainer()).toMatchObject({ id: db, state: 'running' });
  });

  it('opens running containers of the checks-off time as they are without the workspace helper while the checks are off', async () => {
    h.settings = { ...h.settings, hostAccessChecksOff: [REPO] };
    await seedCompose({
      dev: 'running',
      db: 'running',
      devLabels: { [LABEL_HOST_ACCESS]: HOST_ACCESS_UNRESTRICTED },
      dbLabels: { [LABEL_HOST_ACCESS]: HOST_ACCESS_UNRESTRICTED },
    });
    h.helper.ensureImageError = new UserFacingError('helperFailed', Messages.helperFailed);
    // The tag of the helper image exists (the open takes the lock, which builds only a missing tag); the maintaining
    // ensure of the open fails. A missing tag refuses the open before anything is changed
    // (devspaceService.lock.test.ts).
    h.helper.tagPresent = true;
    const result = await h.service.openDevspace(ENV_ID, options());
    expect(result.containerName).toBe(devContainer()?.name);
    expect(h.helper.ups).toEqual([]);
    expect(h.docker.log.filter((line) => line.startsWith('start'))).toEqual([]);
    expect(h.logger.errors).toEqual([`The workspace helper is not available for ${REPO}. The running devspace is opened as it is. ${Messages.helperFailed}`]);
  });

  it('logs that a running current dev container is opened as it is when its configuration cannot be read', async () => {
    // A configuration error, not helperFailed: the log line of the configuration says that the devspace opens as it is.
    await seedCompose({ dev: 'running', db: 'running' });
    h.helper.readConfigurationError = new CommandError('devcontainer read-configuration', 1, '', 'SyntaxError');
    const result = await h.service.openDevspace(ENV_ID, options());
    expect(result.containerName).toBe(devContainer()?.name);
    expect(h.logger.errors.filter((line) => line.startsWith('The configuration of'))).toEqual([
      expect.stringMatching(new RegExp(`^The configuration of ${REPO} could not be used\\. The running devspace is opened as it is\\. `)),
    ]);
    expect(h.helper.ups).toEqual([]);
    expect(devContainer()?.state).toBe('running');
  });

  it.each([
    [
      'helperFailed',
      () => {
        h.helper.ensureImageError = new UserFacingError('helperFailed', Messages.helperFailed);
        // The tag of the helper image exists (the lock builds only a missing tag); the maintaining ensure of the open
        // fails.
        h.helper.tagPresent = true;
      },
      () => h.helper.calls.includes('ensureImage'),
    ],
    [
      'a configuration error',
      () => (h.helper.readConfigurationError = new CommandError('devcontainer read-configuration', 1, '', 'SyntaxError')),
      () => h.helper.readConfigurations.length > 0,
    ],
  ] as const)('ends the open as cancelled when it is cancelled while Step 5 lists the containers after %s', async (_name, fail, reached) => {
    await seedCompose({ dev: 'running', db: 'running' });
    fail();
    const controller = new AbortController();
    const list = h.docker.listDevspaceContainers.bind(h.docker);
    let aborted = false;
    h.docker.listDevspaceContainers = async () => {
      // The listing of opensAsItIsOrFalse: after the error of Step 5.
      if (reached()) {
        aborted = true;
        controller.abort();
        throw abortError();
      }
      return list();
    };
    const error = await rejection(h.service.openDevspace(ENV_ID, { ...options(), signal: controller.signal }));
    expect(aborted).toBe(true);
    expect(error.code).toBe('cancelled');
    expect(h.helper.ups).toEqual([]);
    expect(h.logger.warnings.some((line) => line.includes('could not be listed'))).toBe(false);
  });

  it('keeps helperFailed when the containers cannot be listed at Step 5', async () => {
    await seedCompose({ dev: 'running', db: 'running' });
    h.helper.ensureImageError = new UserFacingError('helperFailed', Messages.helperFailed);
    // The tag of the helper image exists (the open takes the lock, which builds only a missing tag); the maintaining
    // ensure of the open fails. A missing tag refuses the open before anything is changed
    // (devspaceService.lock.test.ts).
    h.helper.tagPresent = true;
    h.docker.listDevspaceContainers = async () => {
      throw new CommandError('docker ps', 1, '', 'Cannot connect to the Docker daemon');
    };
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('helperFailed');
    expect(h.helper.ups).toEqual([]);
    expect(h.logger.warnings.some((line) => line.startsWith(`The containers of ${REPO} could not be listed:`))).toBe(true);
  });

  it('keeps the host access refusal when the containers cannot be listed at Step 5', async () => {
    // The Step 5 handling does not ask for every error whether the running dev container opens as it is (a listing of
    // the containers), so the error of that listing does not replace the refusal.
    await seedCompose({ dev: 'running', db: 'running' });
    useCompose(h, output((m) => (m.services.db.privileged = true)));
    h.docker.listDevspaceContainers = async () => {
      throw new CommandError('docker ps', 1, '', 'Cannot connect to the Docker daemon');
    };
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.message).toBe(Messages.hostAccess('service db: privileged mode'));
    expect(h.helper.ups).toEqual([]);
  });

  it('fails with helperFailed at once, without a warning, for a running dev container that is outdated', async () => {
    await seedCompose({ dev: 'running', devLabels: { [LABEL_CONTAINER_VERSION]: '0' } });
    h.helper.ensureImageError = new UserFacingError('helperFailed', Messages.helperFailed);
    // The tag of the helper image exists (the open takes the lock, which builds only a missing tag); the maintaining
    // ensure of the open fails. A missing tag refuses the open before anything is changed
    // (devspaceService.lock.test.ts).
    h.helper.tagPresent = true;
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('helperFailed');
    expect(h.ui.warnings).toEqual([]);
    expect(h.helper.ups).toEqual([]);
    expect(h.docker.log.filter((line) => line.startsWith('start'))).toEqual([]);
  });

  it('fails with helperFailed at once for a running dev container next to a service of the checks-off time', async () => {
    // The dev container is current, but a container of another service was created while the host access checks were
    // off: the devspace is created again (startContainer), which needs the helper.
    await seedCompose({ dev: 'running', db: 'running', dbLabels: { [LABEL_HOST_ACCESS]: HOST_ACCESS_UNRESTRICTED } });
    h.helper.ensureImageError = new UserFacingError('helperFailed', Messages.helperFailed);
    // The tag of the helper image exists (the open takes the lock, which builds only a missing tag); the maintaining
    // ensure of the open fails. A missing tag refuses the open before anything is changed
    // (devspaceService.lock.test.ts).
    h.helper.tagPresent = true;
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('helperFailed');
    expect(h.ui.warnings).toEqual([]);
    expect(h.helper.ups).toEqual([]);
  });

  it('does not start the devspace without the helper when a service of the checks-off time appears after the first look', async () => {
    // Step 5 saw a running dev container that is current, so the open went on without the helper; startContainer looks
    // at the containers again and finds one of the checks-off time: the devspace would be created again, which needs
    // the helper, so it fails with helperFailed (never a start without the helper).
    await seedCompose({ dev: 'running', db: 'running' });
    h.helper.ensureImageError = new UserFacingError('helperFailed', Messages.helperFailed);
    // The tag of the helper image exists (the open takes the lock, which builds only a missing tag); the maintaining
    // ensure of the open fails. A missing tag refuses the open before anything is changed
    // (devspaceService.lock.test.ts).
    h.helper.tagPresent = true;
    const list = h.docker.listDevspaceContainers.bind(h.docker);
    let calls = 0;
    h.docker.listDevspaceContainers = async () => {
      if (++calls === 2) dbContainer()!.labels[LABEL_HOST_ACCESS] = HOST_ACCESS_UNRESTRICTED;
      return list();
    };
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('helperFailed');
    expect(h.helper.ups).toEqual([]);
    expect(h.docker.log.filter((line) => line.startsWith('start'))).toEqual([]);
  });

  it('fails with helperFailed when up fails because the workspace helper failed', async () => {
    await seedCompose();
    h.helper.upError = () => new UserFacingError('helperFailed', Messages.helperFailed);
    // No docker start fallback: the open fails with helperFailed.
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('helperFailed');
    expect(h.docker.log.filter((line) => line.startsWith('start'))).toEqual([]);
  });

  it('fails with helperFailed and starts nothing when the workspace helper is not available', async () => {
    await seedCompose();
    h.helper.ensureImageError = new UserFacingError('helperFailed', Messages.helperFailed);
    // The tag of the helper image exists (the open takes the lock, which builds only a missing tag); the maintaining
    // ensure of the open fails. A missing tag refuses the open before anything is changed
    // (devspaceService.lock.test.ts).
    h.helper.tagPresent = true;
    // No docker start fallback: the open fails with helperFailed.
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('helperFailed');
    expect(h.docker.log.filter((line) => line.startsWith('start'))).toEqual([]);
    expect(h.helper.ups).toEqual([]);
    expect(devContainer()?.state).toBe('stopped');
  });

  it('passes the helper image of the open to every helper run of a Docker Compose open', async () => {
    await seedCompose();
    await h.service.openDevspace(ENV_ID, options());
    // The HelperImageUse names the image ID `id`: the current tag with its image ID (there is no previous helper
    // image).
    const previous = { tag: 'devspaces-worker:test', id: h.helper.currentHelperImageId };
    expect(h.helper.helperImages.map((entry) => entry.call)).toEqual(expect.arrayContaining(['readConfiguration', 'composeModel', 'up']));
    expect(h.helper.helperImages.filter((entry) => JSON.stringify(entry.image) !== JSON.stringify(previous))).toEqual([]);
  });

  it('replaces a single container of the devspace when the configuration became a Compose configuration', async () => {
    await seedDevspace(h, { container: 'stopped' });
    // Compose pulls a missing image of a side service itself (pull_policy missing).
    h.docker.images.add(DB_IMAGE);
    const single = h.docker.containersOf(ENV_ID)[0].id;
    // The kind switches only with a build (not with "Rebuild later").
    h.ui.configurationChangedAnswer = 'rebuildNow';
    await h.service.openDevspace(ENV_ID, options());
    expect(h.docker.log).toContain(`rm ${single}`);
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_2} --remove-existing-container`]);
    expect(devContainer()).toMatchObject({ name: NAME, state: 'running' });
    expect(dbContainer()?.state).toBe('running');
    // The containers of the configuration are new: the volumes are created with the labels before `up`.
    expect(h.docker.volumes.get(`${PROJECT}_pgdata`)?.[LABEL_VOLUME]).toBe(VOLUME_KIND_COMPOSE);
    // The user learns that the files outside the repository are removed.
    expect(h.progress.details).toContain(Messages.containerComposeCreated);
  });

  it('does not start the single container from its image when up of the new Compose configuration fails', async () => {
    await seedDevspace(h, { container: 'stopped' });
    h.docker.images.add(DB_IMAGE);
    const single = h.docker.containersOf(ENV_ID)[0];
    h.ui.configurationChangedAnswer = 'rebuildNow';
    h.helper.upError = (image) => (image === IMAGE_2 ? new Error('compose up failed') : undefined);
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('startFailed');
    expect(error.detail).toContain('now uses Docker Compose');
    expect(error.detail).toContain(`removed the container ${single.name}`);
    // No `up` of the other kind (a single container from the old image, or Compose from it).
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_2} --remove-existing-container`]);
    expect(h.docker.images.has(IMAGE_2)).toBe(false);
    expect(h.docker.images.has(IMAGE_1)).toBe(true);
  });

  it('ends with helperFailed, with the detail of the switch, when the helper image of the open is gone at up of the new Compose configuration', async () => {
    await seedDevspace(h, { container: 'stopped' });
    h.docker.images.add(DB_IMAGE);
    const single = h.docker.containersOf(ENV_ID)[0];
    h.ui.configurationChangedAnswer = 'rebuildNow';
    h.helper.upError = (image) => (image === IMAGE_2 ? new UserFacingError('helperFailed', Messages.helperFailed, `No such image: sha256:${'4'.repeat(64)}`) : undefined);
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('helperFailed');
    expect(error.message).toBe(Messages.helperFailed);
    expect(error.detail).toContain('now uses Docker Compose');
    expect(error.detail).toContain(`removed the container ${single.name}`);
    // The cleanup of the switch stays, and nothing of the other kind is started.
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_2} --remove-existing-container`]);
    expect(h.docker.images.has(IMAGE_2)).toBe(false);
    expect(h.logger.errors.join('\n')).not.toContain('could not be created from');
    expect(h.ui.warnings).toEqual([]);
  });

  it('ends the open with helperFailed, without the detail of a switch, and keeps the running single container when the folders of the bind mounts cannot be written with helperFailed before the switch to Docker Compose removed it', async () => {
    // The failed step before the switch removed nothing, so the open does not end with the detail "removed the
    // container …".
    const SOURCE = `${FOLDER}/data/postgres`;
    const out = output((m) => {
      m.services.db.volumes = [{ type: 'bind', source: SOURCE, target: '/var/lib/postgresql/data', bind: { create_host_path: true } }];
    });
    out.realPaths = { ...out.realPaths, [SOURCE]: null };
    out.mountAncestors = { [SOURCE]: FOLDER };
    useCompose(h, out);
    await seedDevspace(h, { container: 'running', containerLabels: { [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION), 'nimblescape.devspaces.container-config': 'unknown' } });
    h.docker.images.add(DB_IMAGE);
    const single = h.docker.containersOf(ENV_ID)[0];
    h.ui.configurationChangedAnswer = 'rebuildNow';
    h.helper.createFoldersError = new UserFacingError('helperFailed', Messages.helperFailed, `No such image: sha256:${'4'.repeat(64)}`);
    // A helperFailed during an update fails the open: the running single container is not opened as it is.
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('helperFailed');
    expect(error.detail ?? '').not.toContain('now uses Docker Compose');
    expect(h.helper.calls).toContain(`createRepositoryFolders ${SOURCE}`);
    expect(h.ui.warnings).toEqual([]);
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([]);
    expect(h.docker.log).not.toContain(`rm ${single.id}`);
    expect(h.docker.log.filter((line) => line.startsWith('rename'))).toEqual([]);
    expect(h.docker.containersOf(ENV_ID)).toEqual([expect.objectContaining({ id: single.id, name: NAME, state: 'running' })]);
    expect(h.docker.images.has(IMAGE_2)).toBe(false);
  });

  it('ends the open with helperFailed, without the detail of a switch, and keeps the running single container when the Git setup before up fails with helperFailed before the switch to Docker Compose removed it', async () => {
    await seedDevspace(h, { container: 'running', containerLabels: { [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION), 'nimblescape.devspaces.container-config': 'unknown' } });
    h.docker.images.add(DB_IMAGE);
    const single = h.docker.containersOf(ENV_ID)[0];
    h.ui.configurationChangedAnswer = 'rebuildNow';
    h.helper.prepareGitError = new UserFacingError('helperFailed', Messages.helperFailed, `No such image: sha256:${'4'.repeat(64)}`);
    // A helperFailed during an update fails the open: the running single container is not opened as it is.
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('helperFailed');
    expect(error.detail ?? '').not.toContain('now uses Docker Compose');
    expect(h.ui.warnings).toEqual([]);
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([]);
    expect(h.docker.log.filter((line) => line.startsWith('rm ') || line.startsWith('stop') || line.startsWith('rename'))).toEqual([]);
    expect(h.docker.containersOf(ENV_ID)).toEqual([expect.objectContaining({ id: single.id, name: NAME, state: 'running' })]);
    expect(h.docker.images.has(IMAGE_2)).toBe(false);
  });

  it('starts the single container as it is on "Rebuild later" when the configuration became a Compose configuration', async () => {
    await seedDevspace(h, { container: 'stopped' });
    h.docker.images.add(DB_IMAGE);
    const single = h.docker.containersOf(ENV_ID)[0].id;
    h.ui.configurationChangedAnswer = 'later';
    await h.service.openDevspace(ENV_ID, options());
    expect(h.docker.log).not.toContain(`rm ${single}`);
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_1}`]);
    // A single container: the override configuration of a single container, no model.
    expect(h.helper.ups[0].override).toHaveProperty('runArgs');
    expect(h.helper.ups[0].files).toBeUndefined();
    expect(h.docker.containersOf(ENV_ID)).toHaveLength(1);
    expect(h.docker.containersOf(ENV_ID)[0]).toMatchObject({ id: single, state: 'running' });
    expect(h.progress.details).not.toContain(Messages.containerComposeCreated);
  });
});

describe('stop of a Docker Compose devspace', () => {
  it('stops the dev container first, then the other services', async () => {
    await seedCompose({ dev: 'running', db: 'running' });
    await h.operations.stop(ENV_ID);
    expect(h.docker.log.filter((line) => line.startsWith('stop'))).toEqual([`stop ${devContainer()?.id}`, `stop ${dbContainer()?.id}`]);
    expect(dbContainer()?.state).toBe('stopped');
  });

  it('stops a running side service also when the dev container does not run', async () => {
    await seedCompose({ dev: 'stopped', db: 'running' });
    await h.operations.stop(ENV_ID);
    expect(h.docker.log.filter((line) => line.startsWith('stop'))).toEqual([`stop ${dbContainer()?.id}`]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Docker Compose: the host name, the switch of the host access checks, Delete, a failed first open, a change back to a
// single container, and the restore after a lost registry.

/** The labels of the devspace on a volume (additionalVolumeLabels) with the kind `kind`. */
function volumeLabelsOf(kind: string): Record<string, string> {
  return { [LABEL_DEVSPACE_ID]: ENV_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id, [LABEL_VOLUME]: kind };
}

describe('the host name of the dev container', () => {
  it('names the dev container after the repository, as a single container, and not the other services', async () => {
    await h.service.open(TARGET, options());
    expect(upModel().services.app.hostname).toBe('api');
    expect(upModel().services.db).not.toHaveProperty('hostname');
  });

  it('keeps the host name of the dev service, and sets none with network_mode host', async () => {
    useCompose(h, output((m) => (m.services.app.hostname = 'box')));
    await h.service.open(TARGET, options());
    expect(upModel().services.app.hostname).toBe('box');
    h.cleanup();
    h = createHarness({ newDevspaceId: () => ENV_ID });
    useCompose(h, output((m) => (m.services.app.network_mode = 'host')));
    await h.service.open(TARGET, options());
    expect(upModel().services.app).not.toHaveProperty('hostname');
  });
});

describe('Docker Compose with the host access checks off for the repository', () => {
  const offLines = () => h.logger.warnings.filter((line) => line.startsWith(`The host access checks are off for ${REPO}`));

  it('opens a model with a privileged service and the Docker socket, keeps its ports, and labels every container', async () => {
    h.settings = { ...h.settings, hostAccessChecksOff: [REPO] };
    useCompose(
      h,
      output((m) => {
        m.services.db.privileged = true;
        (m.services.db.volumes as unknown[]).push({ type: 'bind', source: '/var/run/docker.sock', target: '/var/run/docker.sock' });
        m.services.db.ports = [{ mode: 'ingress', target: 5432, published: '5432', protocol: 'tcp', host_ip: '0.0.0.0' }];
      }),
    );
    await h.service.open(TARGET, options());
    const m = upModel();
    expect(m.services.db).toMatchObject({ privileged: true, ports: [{ target: 5432, published: '5432', host_ip: '0.0.0.0' }] });
    expect(m.services.db.volumes).toContainEqual({ type: 'bind', source: '/var/run/docker.sock', target: '/var/run/docker.sock' });
    for (const container of h.docker.containersOf(ENV_ID)) expect(container.labels[LABEL_HOST_ACCESS]).toBe(HOST_ACCESS_UNRESTRICTED);
    expect(offLines()).toHaveLength(1);
  });

  it('keeps the ports of the model without an address as they are (no 127.0.0.1)', async () => {
    h.settings = { ...h.settings, hostAccessChecksOff: [REPO] };
    await h.service.open(TARGET, options());
    expect(upModel().services.db.ports).toEqual([{ mode: 'ingress', target: 5432, published: '5432', protocol: 'tcp' }]);
  });

  it('allows devcontainer.json and a Feature that need the computer', async () => {
    h.settings = { ...h.settings, hostAccessChecksOff: [REPO] };
    h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: CONFIG_TEXT.replace('"remoteUser"', '"privileged": true, "remoteUser"') } };
    h.helper.buildMetadata = [{ id: 'ghcr.io/acme/features/dind:1', privileged: true }];
    await h.service.open(TARGET, options());
    expect(h.helper.ups).toHaveLength(1);
  });

  it('still refuses what stays refused with the checks off: a variable of the GitHub CLI in the dev service', async () => {
    h.settings = { ...h.settings, hostAccessChecksOff: [REPO] };
    useCompose(h, output((m) => (m.services.app.environment = { GH_TOKEN: 'x' })));
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toContain('service app: variable GH_TOKEN in environment');
    expect(h.helper.builds).toEqual([]);
  });

  it('creates the containers again once the checks are on again (the dev container has the label)', async () => {
    await seedCompose({ devLabels: { [LABEL_HOST_ACCESS]: HOST_ACCESS_UNRESTRICTED }, dbLabels: { [LABEL_HOST_ACCESS]: HOST_ACCESS_UNRESTRICTED } });
    await h.service.openDevspace(ENV_ID, options());
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_1} --remove-existing-container`]);
    const m = upModel();
    // `checked` on every service.
    expect(m.services.app.labels).toMatchObject({ [LABEL_HOST_ACCESS]: 'checked' });
    expect(m.services.db.labels).toMatchObject({ [LABEL_HOST_ACCESS]: 'checked' });
    expect(m.services.db.ports).toEqual([expect.objectContaining({ host_ip: '127.0.0.1' })]);
    expect(devContainer()?.labels[LABEL_HOST_ACCESS]).toBe('checked');
    expect(h.progress.details).toContain(Messages.containerHostAccessChecksOn);
  });

  it('does not take a side service for unrestricted when the image that Compose built has the label', async () => {
    useCompose(h, {
      ...output((m) => (m.services.tool = { build: { context: FOLDER, dockerfile: 'tool.Dockerfile' } })),
      dockerfiles: { tool: 'FROM alpine:3.22\nLABEL nimblescape.devspaces.host-access=unrestricted\n' },
      realPaths: { '/workspaces': '/workspaces', [`${FOLDER}/init.sql`]: `${FOLDER}/init.sql`, [FOLDER]: FOLDER, [`${FOLDER}/tool.Dockerfile`]: `${FOLDER}/tool.Dockerfile` },
    });
    // The image that Compose builds during `up` (not checked before it): its label would reach the container.
    h.docker.images.add(`${PROJECT}-tool`);
    h.docker.imageConfigs.set(`${PROJECT}-tool`, { Labels: { [LABEL_HOST_ACCESS]: HOST_ACCESS_UNRESTRICTED } });
    await h.service.open(TARGET, options());
    const tool = h.docker.containersOf(ENV_ID).find((c) => c.labels[LABEL_COMPOSE_SERVICE] === 'tool');
    expect(tool?.labels[LABEL_HOST_ACCESS]).toBe('checked');
    // The next open finds the containers current: nothing is created again.
    await h.service.openDevspace(ENV_ID, options());
    expect(h.helper.ups).toHaveLength(1);
    expect(h.progress.details).not.toContain(Messages.containerHostAccessChecksOn);
  });

  it('creates the containers again when only a side service has the label', async () => {
    await seedCompose({ dev: 'running', db: 'running', dbLabels: { [LABEL_HOST_ACCESS]: HOST_ACCESS_UNRESTRICTED } });
    await h.service.openDevspace(ENV_ID, options());
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_1} --remove-existing-container`]);
    expect(h.progress.details).toContain(Messages.containerHostAccessChecksOn);
    expect(h.logger.infos.some((line) => line.includes(`${PROJECT}-db-1 was created while the host access checks were off`))).toBe(true);
  });

  it('refuses the model once the checks are on again when it still needs the computer, and starts nothing', async () => {
    await seedCompose({ devLabels: { [LABEL_HOST_ACCESS]: HOST_ACCESS_UNRESTRICTED } });
    useCompose(h, output((m) => (m.services.db.privileged = true)));
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.message).toBe(Messages.hostAccess('service db: privileged mode'));
    expect(h.helper.ups).toEqual([]);
    expect(h.docker.log.filter((line) => line.startsWith('start'))).toEqual([]);
  });

  it('does not start containers of the checks-off time with docker start when the configuration cannot be read', async () => {
    await seedCompose({ devLabels: { [LABEL_HOST_ACCESS]: HOST_ACCESS_UNRESTRICTED }, dbLabels: { [LABEL_HOST_ACCESS]: HOST_ACCESS_UNRESTRICTED } });
    h.helper.composeOutput = { error: 'yaml: invalid' };
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('startFailed');
    expect(h.docker.log.filter((line) => line.startsWith('start'))).toEqual([]);
    expect(h.helper.ups).toEqual([]);
  });
});

describe('Delete of a Docker Compose devspace', () => {
  async function seedForDelete(): Promise<{ oneOff: string }> {
    await seedCompose({ dev: 'running', db: 'running' });
    await h.registry.updateDevspace(ENV_ID, (entry) => {
      entry.additionalVolumes = [`${PROJECT}_pgdata`, `${PROJECT}_cache`, 'shared-tools'];
    });
    h.docker.volumes.set(`${PROJECT}_pgdata`, volumeLabelsOf(VOLUME_KIND_COMPOSE));
    h.docker.volumes.set(`${PROJECT}_cache`, volumeLabelsOf(VOLUME_KIND_COMPOSE));
    h.docker.volumes.set('shared-tools', volumeLabelsOf(VOLUME_KIND_ADDITIONAL));
    h.docker.networks.set(`${PROJECT}_default`, COMPOSE_LABELS);
    // The project of another devspace is named composeProjectName.
    h.docker.networks.set(`${OTHER_PROJECT}_default`, { 'com.docker.compose.project': OTHER_PROJECT });
    // The images that Compose built for the devspace carry its ID label (build.labels); listProjectImages keeps only
    // those.
    for (const built of [`${PROJECT}-app`, `${PROJECT}-worker:latest`]) {
      h.docker.images.add(built);
      h.docker.imageConfigs.set(built, { Labels: { [LABEL_DEVSPACE_ID]: ENV_ID } });
    }
    h.docker.images.add(`${OTHER_PROJECT}-app`);
    // A one-off container of `docker compose run`: the label of the project, not the one of the devspace.
    const oneOff = h.docker.addContainer({ devspaceId: 'x', name: `${PROJECT}-db-run-1`, state: 'stopped', image: DB_IMAGE, labels: COMPOSE_LABELS });
    delete oneOff.labels[LABEL_DEVSPACE_ID];
    return { oneOff: oneOff.id };
  }

  it('lists the volumes of the project apart from the other additional volumes', async () => {
    await seedForDelete();
    // The one read of the removable volumes (removableVolumesOf).
    expect((await h.service.removableVolumesOf(ENV_ID)).serviceData).toEqual([`${PROJECT}_pgdata`, `${PROJECT}_cache`]);
    expect((await h.service.removableVolumesOf(ENV_ID)).additional).toEqual(['shared-tools']);
  });

  // The check of Delete reads the removable volumes once for both of its questions (one computation).
  it('the check of Delete reads the removable volumes once for both questions', async () => {
    await seedForDelete();
    const asked: unknown[] = [];
    h.ui.deleteAdditionalVolumes = async (...args: unknown[]) => (asked.push(['additional', ...args]), 'keep');
    h.ui.deleteServiceData = async (...args: unknown[]) => (asked.push(['serviceData', ...args]), []);
    let lists = 0;
    const list = h.docker.devspaceContainers.bind(h.docker);
    h.docker.devspaceContainers = async (devspaceId) => (lists++, list(devspaceId));
    const inspections = h.docker.volumeInspections.length;
    expect(await h.service.deleteCheck(ENV_ID, { progress: h.progress, repository: REPO, otherWindow: false })).toEqual({ decision: 'delete', additionalVolumesToRemove: [] });
    expect(asked).toEqual([
      ['additional', ['shared-tools']],
      ['serviceData', [`${PROJECT}_pgdata`, `${PROJECT}_cache`], []],
    ]);
    // One inspect of the volumes, and two lists of the containers: one for the data folders of the confirmation
    // (repositoryServiceData), one for the volumes of both questions.
    expect(h.docker.volumeInspections.length - inspections).toBe(1);
    expect(lists).toBe(2);
  });

  it('lists a volume with a name of its own that a side service mounts as data of the services', async () => {
    // The database keeps its data in a volume that the model names itself (label `additional`), recorded at the open.
    useCompose(
      h,
      output((m) => {
        m.volumes = { pgdata: { name: 'myapp-db' } };
      }),
    );
    await h.service.open(TARGET, options());
    expect(h.docker.volumes.get('myapp-db')?.[LABEL_VOLUME]).toBe(VOLUME_KIND_ADDITIONAL);
    // And the label of the data of a service.
    expect(h.docker.volumes.get('myapp-db')?.['nimblescape.devspaces.service-data']).toBe('true');
    expect((await h.registry.get(ENV_ID))?.serviceVolumes).toEqual(['myapp-db']);
    // The one read of the removable volumes (removableVolumesOf).
    expect((await h.service.removableVolumesOf(ENV_ID)).serviceData).toContain('myapp-db');
    expect((await h.service.removableVolumesOf(ENV_ID)).additional).not.toContain('myapp-db');
    // Also without the record: the container of the service mounts it.
    await h.registry.updateDevspace(ENV_ID, (entry) => {
      delete entry.serviceVolumes;
    });
    dbContainer()!.volumes = ['myapp-db'];
    // The one read of the removable volumes (removableVolumesOf).
    expect((await h.service.removableVolumesOf(ENV_ID)).serviceData).toContain('myapp-db');
    expect((await h.service.removableVolumesOf(ENV_ID)).additional).not.toContain('myapp-db');
  });

  it('removes all containers, the networks, and the images of the project, and keeps the data of the services by default', async () => {
    const { oneOff } = await seedForDelete();
    await h.service.delete(ENV_ID, { ...options(), additionalVolumesToRemove: [] });
    expect(h.docker.containersOf(ENV_ID)).toEqual([]);
    expect(h.docker.containerByRef(oneOff)).toBeUndefined();
    expect(h.docker.networks.has(`${PROJECT}_default`)).toBe(false);
    expect(h.docker.images.has(`${PROJECT}-app`)).toBe(false);
    expect(h.docker.images.has(`${PROJECT}-worker:latest`)).toBe(false);
    expect(h.docker.images.has(IMAGE_1)).toBe(false);
    expect(h.docker.volumes.has(NAME)).toBe(false);
    // The data of the services and the other volumes stay; so does everything of another devspace.
    expect(h.docker.volumes.has(`${PROJECT}_pgdata`)).toBe(true);
    expect(h.docker.volumes.has('shared-tools')).toBe(true);
    expect(h.docker.networks.has(`${OTHER_PROJECT}_default`)).toBe(true);
    expect(h.docker.images.has(`${OTHER_PROJECT}-app`)).toBe(true);
    expect(await h.registry.list()).toEqual([]);
    // The containers go before the networks, which Docker removes only when no container uses them.
    expect(h.docker.log.indexOf(`network rm ${PROJECT}_default`)).toBeGreaterThan(h.docker.log.indexOf(`rm ${oneOff}`));
  });

  it('keeps a container of another devspace that has the label of the project', async () => {
    await seedForDelete();
    // For example a single container of another devspace whose image has the label of this project.
    const foreign = h.docker.addContainer({ devspaceId: OTHER_ID, name: resourceName('acme/other', OTHER_ID), state: 'running', image: 'x', labels: { ...COMPOSE_LABELS } });
    h.docker.images.add(`${PROJECT}-tool`);
    h.docker.imageConfigs.set(`${PROJECT}-tool`, { Labels: { [LABEL_DEVSPACE_ID]: OTHER_ID } });
    await h.service.delete(ENV_ID, { ...options(), additionalVolumesToRemove: [] });
    expect(h.docker.containerByRef(foreign.id)).toBeDefined();
    expect(h.docker.log).not.toContain(`rm ${foreign.id}`);
    expect(h.docker.images.has(`${PROJECT}-tool`)).toBe(true);
    expect(h.docker.images.has(`${PROJECT}-app`)).toBe(false);
  });

  // Delete removes a recorded image of the project (BuildRecord.compose) only when it carries the ID of this
  // devspace (ownComposeImages in removeComposeProject).
  it('keeps a recorded image of the project that carries the ID of another devspace', async () => {
    await seedForDelete();
    h.docker.imageConfigs.set(`${PROJECT}-app`, { Labels: { [LABEL_DEVSPACE_ID]: OTHER_ID } });
    await h.service.delete(ENV_ID, { ...options(), additionalVolumesToRemove: [] });
    expect(h.docker.images.has(`${PROJECT}-app`)).toBe(true);
    expect(h.docker.log).not.toContain(`rmi ${PROJECT}-app`);
    expect(h.docker.images.has(`${PROJECT}-worker:latest`)).toBe(false);
    expect(await h.registry.list()).toEqual([]);
  });

  // A recorded image whose labels cannot be read is kept.
  it('keeps a recorded image of the project whose labels cannot be read', async () => {
    await seedForDelete();
    h.docker.imageConfigs.set(`${PROJECT}-app`, { Labels: { [LABEL_DEVSPACE_ID]: OTHER_ID } });
    const imageLabels = h.docker.imageLabels.bind(h.docker);
    h.docker.imageLabels = async (reference: string) => {
      if (reference === `${PROJECT}-app`) throw new CommandError(`docker image inspect ${reference}`, 1, '', 'timeout');
      return imageLabels(reference);
    };
    await h.service.delete(ENV_ID, { ...options(), additionalVolumesToRemove: [] });
    expect(h.docker.images.has(`${PROJECT}-app`)).toBe(true);
    expect(h.docker.log).not.toContain(`rmi ${PROJECT}-app`);
    expect(h.docker.images.has(`${PROJECT}-worker:latest`)).toBe(false);
  });

  it('removes the volumes of the project that the user ticked', async () => {
    await seedForDelete();
    await h.service.delete(ENV_ID, { ...options(), additionalVolumesToRemove: [`${PROJECT}_pgdata`] });
    expect(h.docker.volumes.has(`${PROJECT}_pgdata`)).toBe(false);
    expect(h.docker.volumes.has(`${PROJECT}_cache`)).toBe(true);
  });

  it('removes the project also without a build record (a restored devspace), found by its containers', async () => {
    await seedForDelete();
    await h.registry.updateDevspace(ENV_ID, (entry) => {
      delete entry.buildRecord;
    });
    await h.service.delete(ENV_ID, { ...options(), additionalVolumesToRemove: [] });
    expect(h.docker.networks.has(`${PROJECT}_default`)).toBe(false);
    expect(h.docker.images.has(`${PROJECT}-app`)).toBe(false);
  });
});

describe('a failed first open of a Docker Compose configuration', () => {
  it('removes the containers, the networks, and the images of the project', async () => {
    h.helper.onBuild = () => {
      h.docker.images.add(`${PROJECT}-app`);
      // Compose builds it with the ID label of the devspace (build.labels).
      h.docker.imageConfigs.set(`${PROJECT}-app`, { Labels: { [LABEL_DEVSPACE_ID]: ENV_ID } });
    };
    h.helper.composeProjectNameResult = 'api_devcontainer';
    await rejection(h.service.open(TARGET, options()));
    expect(h.docker.containersOf(ENV_ID)).toEqual([]);
    expect(h.docker.networks.has(`${PROJECT}_default`)).toBe(false);
    expect(h.docker.images.has(`${PROJECT}-app`)).toBe(false);
    expect(h.docker.images.has(IMAGE_1)).toBe(false);
    expect(h.docker.volumes.has(NAME)).toBe(false);
    expect(await h.registry.list()).toEqual([]);
  });
});

describe('a Docker Compose devspace whose configuration became a single container', () => {
  beforeEach(async () => {
    await seedCompose({ dev: 'stopped', db: 'stopped' });
    h.docker.networks.set(`${PROJECT}_default`, COMPOSE_LABELS);
    h.docker.images.add(`${PROJECT}-app`);
    // As Compose builds it (build.labels), so that the rebuild removes it.
    h.docker.imageConfigs.set(`${PROJECT}-app`, { User: '', Labels: { [LABEL_DEVSPACE_ID]: ENV_ID } });
    h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: DEFAULT_CONFIG_TEXT } };
  });

  it('removes the other services, then creates the container again as a single container', async () => {
    const db = dbContainer()?.id;
    // The kind switches only with a build (not with "Rebuild later").
    h.ui.configurationChangedAnswer = 'rebuildNow';
    await h.service.openDevspace(ENV_ID, options());
    expect(h.docker.log).toContain(`rm ${db}`);
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_2} --remove-existing-container`]);
    // `up` got a single container, and the containers of Compose are gone.
    expect(h.helper.ups[0].override).toHaveProperty('runArgs');
    const containers = h.docker.containersOf(ENV_ID);
    expect(containers).toHaveLength(1);
    // The override configuration sets the label empty.
    expect(containers[0].labels['com.docker.compose.project']).toBe('');
    expect(containers[0].labels['com.docker.compose.service']).toBe('');
    // The side service went before `up`, which finds the container by the ID label; the network after it.
    expect(h.docker.log.indexOf(`rm ${db}`)).toBeLessThan(h.docker.log.indexOf(`network rm ${PROJECT}_default`));
    expect(h.docker.networks.has(`${PROJECT}_default`)).toBe(false);
    expect(h.progress.details).toContain(Messages.containerComposeReplaced);
    // The merged configuration of the container of Compose is not checked (the CLI could read another service).
    expect(h.logger.infos.some((line) => line.includes('was created for a Docker Compose configuration. Its merged configuration is not checked'))).toBe(true);
  });

  it('the detail of a failed switch whose `up` failed still says that nothing else was removed', async () => {
    dbContainer();
    h.ui.configurationChangedAnswer = 'rebuildNow';
    h.helper.upError = (image) => (image === IMAGE_2 ? new Error('up failed') : undefined);
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('startFailed');
    expect(error.detail).toMatch(/ The Dev Container CLI may have removed the previous dev container before it failed\. Nothing else was removed, and the files in the volumes are kept\. up failed$/);
  });

  it('does not start the old image of Docker Compose as a single container when up fails', async () => {
    const db = dbContainer();
    h.ui.configurationChangedAnswer = 'rebuildNow';
    h.helper.upError = (image) => (image === IMAGE_2 ? new Error('up failed') : undefined);
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('startFailed');
    expect(error.detail).toContain('no longer uses Docker Compose');
    expect(error.detail).toContain(`removed the container ${db?.name} of the service db`);
    // Never a single container from the image of the Compose dev service, which inherits the label of the project and
    // would then be taken for a container of Compose.
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_2} --remove-existing-container`]);
    expect(h.docker.images.has(IMAGE_2)).toBe(false);
  });

  it('ends with helperFailed, with the detail of the switch, when the helper image of the open is gone at up of the new single container', async () => {
    const db = dbContainer();
    h.ui.configurationChangedAnswer = 'rebuildNow';
    h.helper.upError = (image) => (image === IMAGE_2 ? new UserFacingError('helperFailed', Messages.helperFailed, `No such image: sha256:${'4'.repeat(64)}`) : undefined);
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('helperFailed');
    expect(error.message).toBe(Messages.helperFailed);
    expect(error.detail).toContain('no longer uses Docker Compose');
    expect(error.detail).toContain(`removed the container ${db?.name} of the service db`);
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_2} --remove-existing-container`]);
    expect(h.docker.images.has(IMAGE_2)).toBe(false);
    expect(h.logger.errors.join('\n')).not.toContain('could not be created from');
  });

  it('ends with helperFailed and keeps the other services when the Git setup before up of the new single container fails with helperFailed', async () => {
    // prepareGit keeps the helperFailed (not the gitSetupFailed warning), and the switch does not remove the container
    // of the service db while the helper image is known to be gone.
    const db = dbContainer();
    h.ui.configurationChangedAnswer = 'rebuildNow';
    h.helper.prepareGitError = new UserFacingError('helperFailed', Messages.helperFailed, `No such image: sha256:${'4'.repeat(64)}`);
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('helperFailed');
    expect(error.detail ?? '').not.toContain('no longer uses Docker Compose');
    expect(h.docker.log).not.toContain(`rm ${db?.id}`);
    expect(dbContainer()).toMatchObject({ id: db?.id });
    expect(h.ui.warnings).not.toContain(Messages.gitSetupFailed);
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([]);
    expect(h.docker.images.has(IMAGE_2)).toBe(false);
  });

  it('gives the detail of the switch when run-user-commands fails with helperFailed after up replaced the only dev container', async () => {
    const db = dbContainer();
    if (db) h.docker.containers.delete(db.id);
    h.ui.configurationChangedAnswer = 'rebuildNow';
    h.helper.userCommandsError = new UserFacingError('helperFailed', Messages.helperFailed, `No such image: sha256:${'4'.repeat(64)}`);
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('helperFailed');
    expect(error.detail).toContain('no longer uses Docker Compose');
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_2} --remove-existing-container`]);
  });

  it('up that fails with helperFailed never ran, so the running dev container is kept, and the open ends with helperFailed', async () => {
    // A helperFailed of `up` means that the helper container never started (its pinned image is gone), so the CLI removed nothing.
    const db = dbContainer();
    if (db) h.docker.containers.delete(db.id);
    const dev = devContainer();
    if (dev) {
      dev.state = 'running';
      dev.rawState = 'running';
    }
    h.ui.configurationChangedAnswer = 'rebuildNow';
    h.helper.upFailsBeforeRemoval = true;
    h.helper.upError = (image) => (image === IMAGE_2 ? new UserFacingError('helperFailed', Messages.helperFailed, `No such image: sha256:${'4'.repeat(64)}`) : undefined);
    // A helperFailed during an update fails the open: the running dev container is not opened as it is.
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('helperFailed');
    expect(error.detail ?? '').not.toContain('no longer uses Docker Compose');
    expect(h.ui.warnings).toEqual([]);
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_2} --remove-existing-container`]);
    expect(devContainer()).toMatchObject({ id: dev?.id, state: 'running' });
    expect(h.docker.log.filter((line) => line.startsWith('rm ') || line.startsWith('stop '))).toEqual([]);
  });

  it('run-user-commands of the new single container fails with helperFailed: it is removed, the detail is true, and "Rebuild later" does not open it as it is', async () => {
    const db = dbContainer();
    h.ui.configurationChangedAnswer = 'rebuildNow';
    h.helper.userCommandsError = new UserFacingError('helperFailed', Messages.helperFailed, `No such image: sha256:${'4'.repeat(64)}`);
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('helperFailed');
    expect(error.detail).toBe(
      `The configuration no longer uses Docker Compose. Its container was created, but its lifecycle commands could not run. It was removed. The devspace is not started with its previous containers, which belong to the previous configuration; rebuild it to try again. The change removed the container ${db?.name} of the service db. The Dev Container CLI removed the previous dev container. The files in the volumes are kept. No such image: sha256:${'4'.repeat(64)}`,
    );
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_2} --remove-existing-container`]);
    expect(h.docker.containersOf(ENV_ID)).toEqual([]);
    expect(h.docker.images.has(IMAGE_2)).toBe(false);
    // "Rebuild later": the devspace keeps its kind (Docker Compose), which has no container: startFailed, no `up`.
    h.helper.userCommandsError = undefined;
    h.ui.configurationChangedAnswer = 'later';
    const runs = h.helper.userCommandRuns.length;
    h.helper.calls.length = 0;
    const later = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(later.code).toBe('startFailed');
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([]);
    expect(h.helper.userCommandRuns.length).toBe(runs);
  });

  it('the new single container cannot be removed: it is stopped, the detail promises nothing about the next open, and "Rebuild later" does not start it', async () => {
    h.ui.configurationChangedAnswer = 'rebuildNow';
    const remove = h.docker.removeContainer.bind(h.docker);
    h.docker.removeContainer = async (ref) => {
      if (new Error().stack?.includes('withdrawAfterHelperFailed')) throw new CommandError('docker rm', 1, '', 'Cannot connect to the Docker daemon');
      return remove(ref);
    };
    h.helper.userCommandsError = new UserFacingError('helperFailed', Messages.helperFailed, `No such image: sha256:${'4'.repeat(64)}`);
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('helperFailed');
    expect(error.detail).toContain('Its container was created, but its lifecycle commands could not run. It could not be removed and was stopped. The devspace is not started');
    expect(error.detail).not.toContain('the next open');
    const leftover = h.docker.containersOf(ENV_ID);
    expect(leftover).toEqual([expect.objectContaining({ state: 'stopped' })]);
    // "Rebuild later": the devspace keeps its kind (its build record: Docker Compose), as after a removal that worked.
    h.docker.removeContainer = remove;
    h.helper.userCommandsError = undefined;
    h.ui.configurationChangedAnswer = 'later';
    const runs = h.helper.userCommandRuns.length;
    h.helper.calls.length = 0;
    const later = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(later.code).toBe('startFailed');
    expect(later.detail).toBe(`The configuration no longer uses Docker Compose, which applies with a rebuild. The container ${leftover[0].name} is no container of Docker Compose; it is not started until the rebuild.`);
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([]);
    expect(h.helper.userCommandRuns.length).toBe(runs);
    expect(h.docker.containersOf(ENV_ID)).toEqual([expect.objectContaining({ id: leftover[0].id, state: 'stopped' })]);
  });

  it('the new single container can be neither removed nor stopped: the registry marks it, "Rebuild later" does not open it as it is, and "Rebuild now" replaces it and clears the mark', async () => {
    h.ui.configurationChangedAnswer = 'rebuildNow';
    const remove = h.docker.removeContainer.bind(h.docker);
    const stop = h.docker.stopContainer.bind(h.docker);
    h.docker.removeContainer = async (ref) => {
      if (new Error().stack?.includes('withdrawAfterHelperFailed')) throw new CommandError('docker rm', 1, '', 'Cannot connect to the Docker daemon');
      return remove(ref);
    };
    h.docker.stopContainer = async (ref) => {
      if (new Error().stack?.includes('withdrawAfterHelperFailed')) throw new CommandError('docker stop', 1, '', 'Cannot connect to the Docker daemon');
      return stop(ref);
    };
    h.helper.userCommandsError = new UserFacingError('helperFailed', Messages.helperFailed, `No such image: sha256:${'4'.repeat(64)}`);
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('helperFailed');
    expect(error.detail).toContain('It could be neither removed nor stopped. The devspace is not started');
    const leftover = h.docker.containersOf(ENV_ID);
    expect(leftover).toEqual([expect.objectContaining({ state: 'running' })]);
    expect((await h.registry.get(ENV_ID))?.lifecycleIncomplete).toBe(leftover[0].id);
    h.docker.removeContainer = remove;
    h.docker.stopContainer = stop;
    h.helper.userCommandsError = undefined;
    h.ui.configurationChangedAnswer = 'later';
    const runs = h.helper.userCommandRuns.length;
    h.helper.calls.length = 0;
    const later = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(later.code).toBe('startFailed');
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([]);
    expect(h.helper.userCommandRuns.length).toBe(runs);
    h.ui.configurationChangedAnswer = 'rebuildNow';
    await h.service.openDevspace(ENV_ID, options());
    expect(h.helper.calls.filter((call) => call.startsWith('up')).at(-1)).toMatch(/--remove-existing-container$/);
    expect(h.docker.containersOf(ENV_ID).map((c) => c.id)).not.toContain(leftover[0].id);
    expect((await h.registry.get(ENV_ID))?.lifecycleIncomplete).toBeUndefined();
  });

  it('the dev container of Docker Compose was gone, so `up` removed nothing, and the detail does not say it did', async () => {
    const dev = devContainer();
    if (dev) h.docker.containers.delete(dev.id);
    h.ui.configurationChangedAnswer = 'rebuildNow';
    h.helper.userCommandsError = new UserFacingError('helperFailed', Messages.helperFailed, `No such image: sha256:${'4'.repeat(64)}`);
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('helperFailed');
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_2}`]);
    expect(error.detail).toContain('no longer uses Docker Compose');
    expect(error.detail).not.toContain('The Dev Container CLI');
    expect(error.detail).toContain(`of the service db. The files in the volumes are kept. No such image: sha256:${'4'.repeat(64)}`);
  });

  it('the dev container of Docker Compose was gone and `up` failed: the detail does not say that the CLI may have removed it', async () => {
    const dev = devContainer();
    if (dev) h.docker.containers.delete(dev.id);
    h.ui.configurationChangedAnswer = 'rebuildNow';
    h.helper.upError = (image) => (image === IMAGE_2 ? new Error('up failed') : undefined);
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('startFailed');
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_2}`]);
    expect(error.detail).not.toContain('The Dev Container CLI');
    expect(error.detail).toMatch(/ Nothing else was removed, and the files in the volumes are kept\. up failed$/);
  });

  it('keeps the containers of Docker Compose and starts nothing on "Rebuild later"', async () => {
    const db = dbContainer()?.id;
    h.ui.configurationChangedAnswer = 'later';
    // No docker start fallback: without a Docker Compose configuration there is no `up`, so the start fails.
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('startFailed');
    expect(error.detail).toContain('no longer uses Docker Compose');
    expect(h.helper.ups).toEqual([]);
    expect(h.docker.log).not.toContain(`rm ${db}`);
    expect(h.docker.log.filter((line) => line.startsWith('start'))).toEqual([]);
    expect(h.docker.networks.has(`${PROJECT}_default`)).toBe(true);
    expect(h.progress.details).not.toContain(Messages.containerComposeReplaced);
  });

  it('opens a running dev container as it is and starts its stopped services on "Rebuild later"', async () => {
    const db = dbContainer()?.id;
    const dev = devContainer();
    if (dev) {
      dev.state = 'running';
      dev.rawState = 'running';
    }
    h.ui.configurationChangedAnswer = 'later';
    const result = await h.service.openDevspace(ENV_ID, options());
    expect(result.containerName).toBe(NAME);
    expect(h.helper.ups).toEqual([]);
    expect(h.helper.builds).toEqual([]);
    expect(h.docker.log.filter((line) => line.startsWith('start'))).toEqual([`start ${db}`]);
    expect(h.docker.log.filter((line) => line.startsWith('rm'))).toEqual([]);
    expect(devContainer()).toMatchObject({ id: dev?.id, state: 'running' });
    expect(dbContainer()).toMatchObject({ id: db, state: 'running' });
    expect(h.docker.networks.has(`${PROJECT}_default`)).toBe(true);
    // The log line names the exception for a running dev container: the condition is per devspace, and only a
    // current dev container opens.
    expect(h.logger.infos.some((line) => line.includes('the containers of Docker Compose start only when the dev container runs already and no container of the devspace must be created again (the dev container then opens as it is)'))).toBe(true);
  });

  it('refuses to start on "Rebuild later" when the Docker Compose devspace has no dev container', async () => {
    for (const container of h.docker.containersOf(ENV_ID)) h.docker.containers.delete(container.id);
    h.ui.configurationChangedAnswer = 'later';
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('startFailed');
    expect(error.detail).toContain('no longer uses Docker Compose');
    expect(h.helper.ups).toEqual([]);
  });

  it('removes the images that Compose built for the project after the rebuild', async () => {
    h.ui.configurationChangedAnswer = 'rebuildNow';
    await h.service.openDevspace(ENV_ID, options());
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_2} --remove-existing-container`]);
    expect(h.docker.containersOf(ENV_ID)).toHaveLength(1);
    expect(h.docker.images.has(`${PROJECT}-app`)).toBe(false);
    expect((await h.registry.get(ENV_ID))?.buildRecord?.compose).toBeUndefined();
  });

  it('keeps a recorded image of the project that carries the ID of another devspace', async () => {
    // The name `<project>-app` can also be the name of an image of another devspace whose name starts with `<project>-`.
    h.docker.imageConfigs.set(`${PROJECT}-app`, { User: '', Labels: { [LABEL_DEVSPACE_ID]: OTHER_ID } });
    h.ui.configurationChangedAnswer = 'rebuildNow';
    await h.service.openDevspace(ENV_ID, options());
    expect(h.docker.images.has(`${PROJECT}-app`)).toBe(true);
  });
});

describe('restore of a Docker Compose devspace after a lost registry', () => {
  /** The workspace volume of the devspace and a volume of its own with `labels`, which no container mounts. */
  function seedVolumes(volumes: Record<string, Record<string, string>>): void {
    h.docker.volumes.set(NAME, { [LABEL_DEVSPACE_ID]: ENV_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id });
    for (const [name, labels] of Object.entries(volumes)) h.docker.volumes.set(name, labels);
  }

  it('restores the volumes of the services from their label, and asks about them at Delete', async () => {
    // A volume with `name:` of the model (label `additional`) that the database used; no container mounts it now.
    seedVolumes({
      'myapp-db': { ...volumeLabelsOf(VOLUME_KIND_ADDITIONAL), 'nimblescape.devspaces.service-data': 'true' },
      'shared-tools': volumeLabelsOf(VOLUME_KIND_ADDITIONAL),
    });
    expect(await h.service.reconcileFromVolumes()).toBe(1);
    expect((await h.registry.get(ENV_ID))?.serviceVolumes).toEqual(['myapp-db']);
    // The one read of the removable volumes (removableVolumesOf).
    expect((await h.service.removableVolumesOf(ENV_ID)).serviceData).toEqual(['myapp-db']);
    expect((await h.service.removableVolumesOf(ENV_ID)).additional).toEqual(['shared-tools']);
    // Known by its label, so no "possibly". The one read of the removable volumes (removableVolumesOf).
    expect((await h.service.removableVolumesOf(ENV_ID)).possibly).toEqual([]);
  });

  it('asks about every volume of a restored entry whose volumes have no label of the data of a service', async () => {
    // Created without the label (for example by Docker at `up`): whether a service used it is not known.
    seedVolumes({ 'myapp-db': volumeLabelsOf(VOLUME_KIND_ADDITIONAL), 'shared-tools': volumeLabelsOf(VOLUME_KIND_ADDITIONAL) });
    expect(await h.service.reconcileFromVolumes()).toBe(1);
    // The one read of the removable volumes (removableVolumesOf).
    expect((await h.service.removableVolumesOf(ENV_ID)).serviceData).toEqual(['myapp-db', 'shared-tools']);
    expect((await h.service.removableVolumesOf(ENV_ID)).additional).toEqual([]);
    // The question names them as additional volumes that may hold data of services. The one read of the removable
    // volumes (removableVolumesOf).
    expect((await h.service.removableVolumesOf(ENV_ID)).possibly).toEqual(['myapp-db', 'shared-tools']);
    // Once the entry has a build record (its next open), the volumes are known by their use again.
    await h.registry.updateDevspace(ENV_ID, (entry) => {
      entry.buildRecord = { builtAt: '2026-09-24T15:40:00.000Z', devspaceImage: IMAGE_1, buildNumber: 1, configPath: DEFAULT_CONFIG_PATH, configHash: HASH, images: {}, features: {} };
    });
    // The one read of the removable volumes (removableVolumesOf).
    expect((await h.service.removableVolumesOf(ENV_ID)).serviceData).toEqual([]);
    expect((await h.service.removableVolumesOf(ENV_ID)).additional).toEqual(['myapp-db', 'shared-tools']);
  });

  it('restores the entry with the volumes of the project, finds both containers, and asks about the data at Delete', async () => {
    h.docker.volumes.set(NAME, { [LABEL_DEVSPACE_ID]: ENV_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id });
    h.docker.volumes.set(`${PROJECT}_pgdata`, volumeLabelsOf(VOLUME_KIND_COMPOSE));
    h.docker.images.add(IMAGE_1);
    h.docker.images.add(DB_IMAGE);
    h.docker.addContainer({
      devspaceId: ENV_ID,
      name: NAME,
      state: 'stopped',
      image: IMAGE_1,
      labels: { [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION), ...COMPOSE_LABELS, 'com.docker.compose.service': 'app' },
    });
    h.docker.addContainer({
      devspaceId: ENV_ID,
      name: `${PROJECT}-db-1`,
      state: 'stopped',
      image: DB_IMAGE,
      labels: { [LABEL_COMPOSE_SERVICE]: 'db', ...COMPOSE_LABELS, 'com.docker.compose.service': 'db' },
    });
    expect(await h.service.reconcileFromVolumes()).toBe(1);
    const restored = await h.registry.get(ENV_ID);
    expect(restored?.additionalVolumes).toEqual([`${PROJECT}_pgdata`]);
    // The one read of the removable volumes (removableVolumesOf).
    expect((await h.service.removableVolumesOf(ENV_ID)).serviceData).toEqual([`${PROJECT}_pgdata`]);
    expect((await h.operations.inspectStates())?.get(ENV_ID)).toEqual({ container: 'stopped', volume: true });

    // Without a build record, the next open builds, and `up` creates the dev container again in the same project.
    await h.service.openDevspace(ENV_ID, options());
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_2} --remove-existing-container`]);
    expect(h.helper.ups[0].env).toEqual({ COMPOSE_PROJECT_NAME: PROJECT });
    expect(dbContainer()?.state).toBe('running');
    // The record names the pulled images of the other services, which are no base images, and the version of Compose
    // and the hash of the files as written.
    expect((await h.registry.get(ENV_ID))?.buildRecord?.compose).toEqual({
      service: 'app',
      images: [`${PROJECT}-app`],
      serviceImages: [DB_IMAGE],
      version: '2.40.3',
      inputsHash: composeInputsHash(CONFIG_TEXT, 'inputs-1', {}),
      // No serviceFolders here: the entry holds them (Devspace.serviceFolders), and a read-only mount such as
      // init.sql is not recorded.
    });
    expect((await h.registry.get(ENV_ID))?.serviceFolders).toBeUndefined();
  });
});

describe('failed switches, restored devspaces, and missing build files', () => {
  const DB_LABELS = { [LABEL_COMPOSE_SERVICE]: 'db', ...COMPOSE_LABELS, 'com.docker.compose.service': 'db', 'com.docker.compose.config-hash': 'x' };

  function addDb(state: ContainerState = 'running'): ContainerInfo {
    return h.docker.addContainer({ devspaceId: ENV_ID, name: `${PROJECT}-db-1`, state, image: DB_IMAGE, labels: { ...DB_LABELS } });
  }

  it('removes the containers that a failed up of the switch to Docker Compose created, and keeps the volumes', async () => {
    await seedDevspace(h, { container: 'stopped' });
    h.docker.images.add(DB_IMAGE);
    h.ui.configurationChangedAnswer = 'rebuildNow';
    h.helper.upError = (image) => (image === IMAGE_2 ? new Error('compose up failed') : undefined);
    // Compose created and started the db container before the dev service failed (for example a port in use).
    let db: ContainerInfo | undefined;
    h.helper.beforeUpError = () => {
      db = addDb();
    };
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('startFailed');
    expect(error.detail).toContain(`The containers that Docker Compose had created were removed again: the container ${PROJECT}-db-1 of the service db.`);
    expect(error.detail).not.toContain('could not be created.');
    expect(h.docker.log).toContain(`rm ${db?.id}`);
    expect(dbContainer()).toBeUndefined();
    expect(h.docker.volumes.has(`${PROJECT}_pgdata`)).toBe(true);
  });

  it('never takes a container of another service for the dev container of a single container', async () => {
    // As after a failed switch to Docker Compose whose db container could not be removed.
    await seedDevspace(h, { container: 'stopped' });
    h.docker.images.add(DB_IMAGE);
    h.ui.configurationChangedAnswer = 'rebuildNow';
    h.helper.upError = (image) => (image === IMAGE_2 ? new Error('compose up failed') : undefined);
    await rejection(h.service.openDevspace(ENV_ID, options()));
    const db = addDb();
    h.helper.upError = () => undefined;
    // "Rebuild later": the single container is created again from its image; the db container goes first.
    h.ui.configurationChangedAnswer = 'later';
    const result = await h.service.openDevspace(ENV_ID, options());
    expect(h.docker.log).toContain(`rm ${db.id}`);
    expect(h.helper.ups.at(-1)?.image).toBe(IMAGE_1);
    expect(h.docker.containersOf(ENV_ID).map((c) => c.id)).not.toContain(db.id);
    expect(result.containerName).toBe(NAME);
    expect(h.docker.containersOf(ENV_ID)).toHaveLength(1);
  });

  it('Step 9 without a busy mark does not remove the containers of other services while another window is opening the devspace', async () => {
    // A pending connection file of window B (status files do not count while nothing runs).
    await seedDevspace(h, { container: 'stopped' });
    h.docker.images.add(DB_IMAGE);
    h.ui.configurationChangedAnswer = 'rebuildNow';
    h.helper.upError = (image) => (image === IMAGE_2 ? new Error('compose up failed') : undefined);
    await rejection(h.service.openDevspace(ENV_ID, options()));
    const db = addDb();
    h.helper.upError = () => undefined;
    h.ui.configurationChangedAnswer = 'later';
    h.sessionFiles.readPendings = async () => [{ devspaceId: ENV_ID, windowId: 'window-b', createdAt: new Date(T0).toISOString() }];
    const log = h.docker.log.length;
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('startFailed');
    expect(error.detail).toContain('the containers of its other Docker Compose services must be removed, but another window is opening the devspace. Nothing was stopped, removed, or renamed.');
    expect(h.docker.log.slice(log).filter((line) => line.startsWith('stop') || line.startsWith('rm'))).toEqual([]);
    expect(h.docker.containers.get(db.id)).toMatchObject({ state: 'running' });
    expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
  });

  it('never lets an up find the container of another service next to a single container', async () => {
    // An up-to-date single container, and a container of a service of Docker Compose with the ID label.
    await seedDevspace(h, { container: 'stopped' });
    const dev = devContainer();
    useSingle();
    const db = addDb();
    // Next to a single dev container, the container of the other service is a stray: it is removed (its volumes stay),
    // and the single container starts as usual, without a rebuild (which would not help when the configuration cannot
    // be used).
    const result = await h.service.openDevspace(ENV_ID, options());
    expect(h.docker.log).toContain(`rm ${db.id}`);
    expect(h.docker.containersOf(ENV_ID).map((c) => c.id)).toEqual([dev?.id]);
    expect(h.helper.ups.map((up) => [up.image, up.removeExistingContainer])).toEqual([[IMAGE_1, false]]);
    expect(h.helper.builds).toEqual([]);
    expect(result.containerName).toBe(NAME);
    expect(h.docker.log.filter((line) => line.startsWith('volume rm'))).toEqual([]);
  });

  it('keeps the kind of a restored devspace without build record whose containers are of Docker Compose', async () => {
    await seedCompose({ dev: 'stopped', db: 'running' });
    await h.registry.updateDevspace(ENV_ID, (e) => {
      delete e.buildRecord;
    });
    const db = dbContainer();
    const dev = devContainer();
    useSingle();
    // A question of its own that names the switch (configurationKindChanged).
    h.ui.configurationKindChangedAnswer = 'later';
    // No docker start fallback: Later keeps the containers of Docker Compose but cannot start them.
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('startFailed');
    // The detail names the change of kind (keepsKind reads the kind of the containers).
    expect(error.detail).toContain('no longer uses Docker Compose');
    expect(h.ui.prompts).toEqual([`configurationKindChanged ${REPO}`]);
    expect(h.ui.kindQuestions).toEqual([Messages.configurationKindChanged(true, DEFAULT_CONFIG_PATH)]);
    // The question says that a stopped dev container does not start.
    expect(h.ui.kindQuestions[0]).toContain('Otherwise nothing starts: a stopped dev container');
    // The question says that Later keeps Docker Compose without a rebuild and that the containers start only with a
    // Docker Compose configuration.
    expect(h.ui.kindQuestions[0]).toContain('Later keeps Docker Compose without a rebuild');
    expect(h.ui.kindQuestions[0]).toContain('start only with a Docker Compose configuration.');
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.ups).toEqual([]);
    expect(h.docker.log.filter((line) => line.startsWith('rm'))).toEqual([]);
    expect(h.docker.log.filter((line) => line.startsWith('start'))).toEqual([]);
    expect(devContainer()?.id).toBe(dev?.id);
    expect(dbContainer()?.id).toBe(db?.id);
    // "Rebuild now" switches, as a rebuild does: the answer of configurationKindChanged.
    h.ui.configurationKindChangedAnswer = 'rebuildNow';
    await h.service.openDevspace(ENV_ID, options());
    expect(h.helper.builds).toHaveLength(1);
    expect(h.docker.log).toContain(`rm ${db?.id}`);
  });

  it('opens a running dev container of a restored Docker Compose devspace as it is on Later and starts its stopped services', async () => {
    await seedCompose({ dev: 'running', db: 'stopped' });
    await h.registry.updateDevspace(ENV_ID, (e) => {
      delete e.buildRecord;
    });
    const db = dbContainer();
    const dev = devContainer();
    useSingle();
    h.ui.configurationKindChangedAnswer = 'later';
    const result = await h.service.openDevspace(ENV_ID, options());
    expect(result.containerName).toBe(NAME);
    expect(h.ui.prompts).toEqual([`configurationKindChanged ${REPO}`]);
    expect(h.ui.kindQuestions).toEqual([Messages.configurationKindChanged(true, DEFAULT_CONFIG_PATH)]);
    // The question says what Later does with a running dev container that is current; the condition is per devspace.
    expect(Messages.configurationKindChanged(true, DEFAULT_CONFIG_PATH)).toContain('if the dev container runs already and no container of the devspace must be created again, the dev container opens as it is, and the stopped containers of the other services are started');
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.ups).toEqual([]);
    expect(h.docker.log.filter((line) => line.startsWith('start'))).toEqual([`start ${db?.id}`]);
    expect(h.docker.log.filter((line) => line.startsWith('rm'))).toEqual([]);
    expect(devContainer()).toMatchObject({ id: dev?.id, state: 'running' });
    expect(dbContainer()).toMatchObject({ id: db?.id, state: 'running' });
  });

  // With the host access checks off, a container that was created while they were off is current (containerIsCurrent,
  // unrestrictedServiceContainer): Later opens the running dev container and starts the stopped services, and the
  // question names that reason only for checks that are on now.
  it.each([
    ['the dev container and db', { devLabels: { [LABEL_HOST_ACCESS]: HOST_ACCESS_UNRESTRICTED }, dbLabels: { [LABEL_HOST_ACCESS]: HOST_ACCESS_UNRESTRICTED } }],
    ['db', { dbLabels: { [LABEL_HOST_ACCESS]: HOST_ACCESS_UNRESTRICTED } }],
  ])('opens a running dev container on Later with the checks off when %s were created while they were off', async (_case, labels) => {
    h.settings = { ...h.settings, hostAccessChecksOff: [REPO] };
    await seedCompose({ dev: 'running', db: 'stopped', ...labels });
    await h.registry.updateDevspace(ENV_ID, (e) => {
      delete e.buildRecord;
    });
    const db = dbContainer();
    const dev = devContainer();
    useSingle();
    h.ui.configurationKindChangedAnswer = 'later';
    const result = await h.service.openDevspace(ENV_ID, options());
    expect(result.containerName).toBe(NAME);
    expect(h.ui.kindQuestions).toEqual([Messages.configurationKindChanged(true, DEFAULT_CONFIG_PATH)]);
    expect(h.ui.kindQuestions[0]).toContain('while the host access checks were off and the checks are on now');
    expect(h.helper.ups).toEqual([]);
    expect(h.helper.builds).toEqual([]);
    expect(h.docker.log.filter((line) => line.startsWith('start') || line.startsWith('rm'))).toEqual([`start ${db?.id}`]);
    expect(devContainer()).toMatchObject({ id: dev?.id, state: 'running' });
    expect(dbContainer()).toMatchObject({ id: db?.id, state: 'running' });
  });

  it.each([
    ['created by an older version', { devLabels: { [LABEL_CONTAINER_VERSION]: '0' } }, false],
    ['created while the host access checks were off', { devLabels: { [LABEL_HOST_ACCESS]: HOST_ACCESS_UNRESTRICTED } }, false],
    ['next to a service container created while the host access checks were off', { dbLabels: { [LABEL_HOST_ACCESS]: HOST_ACCESS_UNRESTRICTED } }, true],
  ])('does not start a running dev container %s of a restored Docker Compose devspace on Later, as the question says', async (_case, labels, byService) => {
    await seedCompose({ dev: 'running', db: 'stopped', ...labels });
    await h.registry.updateDevspace(ENV_ID, (e) => {
      delete e.buildRecord;
    });
    const db = dbContainer();
    const dev = devContainer();
    useSingle();
    h.ui.configurationKindChangedAnswer = 'later';
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('startFailed');
    expect(error.detail).toContain('must be created again');
    // The detail names the container that must be created again (the dev container, or the container of the service
    // db).
    if (byService) {
      expect(error.detail).toContain(`the container ${db?.name} was created while the host access checks were off`);
      expect(error.detail).not.toContain(`the container ${dev?.name} must be created again`);
    } else {
      expect(error.detail).toContain(`the container ${dev?.name} must be created again`);
    }
    expect(h.ui.kindQuestions).toEqual([Messages.configurationKindChanged(true, DEFAULT_CONFIG_PATH)]);
    // The condition is per devspace and names the host access checks.
    expect(h.ui.kindQuestions[0]).toContain('if the dev container runs already and no container of the devspace must be created again, the dev container opens as it is');
    // The host access reason applies only while the checks are on.
    expect(h.ui.kindQuestions[0]).toContain('because they were created while the host access checks were off and the checks are on now');
    // The question names both reasons, and the detail why nothing can start.
    expect(h.ui.kindQuestions[0]).toContain('because an older version created them');
    expect(error.detail).toMatch(/\), which needs the configuration\.$/);
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.ups).toEqual([]);
    expect(h.docker.log.filter((line) => line.startsWith('start') || line.startsWith('rm'))).toEqual([]);
    expect(devContainer()).toMatchObject({ id: dev?.id, state: 'running' });
    expect(dbContainer()).toMatchObject({ id: db?.id, state: 'stopped' });
    // The condition is per devspace.
    expect(h.logger.infos.some((line) => line.includes('start only when the dev container runs already and no container of the devspace must be created again'))).toBe(true);
  });

  it('does not start the existing Docker Compose devspace when a Dockerfile of a service does not exist in the repository', async () => {
    await seedCompose({ dev: 'stopped', db: 'stopped' });
    useCompose(h, {
      ...output((m) => (m.services.db = { build: { context: `${FOLDER}/db`, dockerfile: 'Dockerfile' } })),
      realPaths: { '/workspaces': '/workspaces', [`${FOLDER}/init.sql`]: `${FOLDER}/init.sql`, [`${FOLDER}/db`]: `${FOLDER}/db`, [`${FOLDER}/db/Dockerfile`]: null },
      missing: [`${FOLDER}/db/Dockerfile`],
    });
    h.ui.configurationChangedAnswer = 'rebuildNow';
    // No docker start fallback: the configuration cannot be used, so there is no model and no `up`: the start fails.
    const failed = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(failed.code).toBe('startFailed');
    const text = Messages.buildFileMissing(`service db: Dockerfile ${FOLDER}/db/Dockerfile`);
    expect(h.ui.warnings).toContain(text);
    expect(h.helper.builds).toEqual([]);
    expect(h.docker.log.filter((line) => line.startsWith('start'))).toEqual([]);
    // A new devspace: a plain error of the configuration, no refusal of the policy.
    const other = createHarness({ newDevspaceId: () => ENV_ID });
    try {
      useCompose(other, h.helper.composeOutput as ComposeModelOutput);
      const error = await rejection(other.service.open(TARGET, { progress: other.progress }));
      expect(error.code).toBe('buildFailed');
      expect(error.message).toBe(text);
      expect(other.helper.builds).toEqual([]);
    } finally {
      other.cleanup();
    }
  });

  it('still refuses a build context or Dockerfile of the repository whose link leads nowhere or out', async () => {
    useCompose(h, {
      ...output((m) => (m.services.db = { build: { context: `${FOLDER}/db`, dockerfile: 'Dockerfile' } })),
      realPaths: { '/workspaces': '/workspaces', [`${FOLDER}/init.sql`]: `${FOLDER}/init.sql`, [`${FOLDER}/db`]: `${FOLDER}/db`, [`${FOLDER}/db/Dockerfile`]: null },
    });
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toContain(`service db: Dockerfile Dockerfile (the path does not exist in the repository)`);
  });
});

/** The single-container configuration at the default path. */
function useSingle(): void {
  h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: DEFAULT_CONFIG_TEXT } };
  h.helper.composeOutput = undefined as never;
  h.checker.outcome = checked({ [BASE_IMAGE]: DIGEST_NEW }, { [FEATURE]: FEATURE_DIGEST });
}

describe('failed switches and the label of the configuration path', () => {
  const DB_LABELS = { [LABEL_COMPOSE_SERVICE]: 'db', ...COMPOSE_LABELS, 'com.docker.compose.service': 'db', 'com.docker.compose.config-hash': 'x' };
  const COMPOSE_PATH = '.devcontainer/compose/devcontainer.json';

  function addDb(state: ContainerState = 'running', labels: Record<string, string> = {}): ContainerInfo {
    return h.docker.addContainer({ devspaceId: ENV_ID, name: `${PROJECT}-db-1`, state, image: DB_IMAGE, labels: { ...DB_LABELS, ...labels } });
  }

  it('never removes a container of Docker Compose that existed before a failed switch, for example of a cancelled one', async () => {
    // A switch to Docker Compose that was cancelled after `up` created the containers: the record stays single.
    await seedDevspace(h, { container: 'stopped' });
    h.docker.images.add(DB_IMAGE);
    h.ui.configurationChangedAnswer = 'rebuildNow';
    const cancel = new AbortController();
    h.helper.upError = (image) => (image === IMAGE_2 ? abortError() : undefined);
    let db: ContainerInfo | undefined;
    h.helper.beforeUpError = () => {
      db = addDb();
      h.docker.addContainer({
        devspaceId: ENV_ID,
        name: NAME,
        state: 'running',
        image: IMAGE_2,
        labels: { [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION), ...COMPOSE_LABELS, 'com.docker.compose.service': 'app', 'com.docker.compose.config-hash': 'y' },
      });
      cancel.abort();
    };
    await h.service.openDevspace(ENV_ID, { progress: h.progress, signal: cancel.signal }).catch(() => undefined);
    h.helper.upError = () => undefined;
    h.helper.beforeUpError = undefined;
    // "Later": the user works with the containers of Docker Compose.
    h.ui.configurationChangedAnswer = 'later';
    await h.service.openDevspace(ENV_ID, options());
    // A later "Rebuild now" whose `up` fails: the db container stays.
    h.ui.configurationChangedAnswer = 'rebuildNow';
    h.helper.upError = (image) => (image !== IMAGE_1 && image !== IMAGE_2 ? new Error('port 5432 in use') : undefined);
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('startFailed');
    expect(h.docker.log).not.toContain(`rm ${db?.id}`);
    expect(dbContainer()?.id).toBe(db?.id);
    expect(error.detail).not.toContain('were removed again');
  });

  async function cancelledSwitch(): Promise<ContainerInfo | undefined> {
    await seedDevspace(h, { container: 'stopped' });
    h.docker.images.add(DB_IMAGE);
    h.ui.configurationChangedAnswer = 'rebuildNow';
    const cancel = new AbortController();
    h.helper.upError = (image) => (image === IMAGE_2 ? abortError() : undefined);
    let db: ContainerInfo | undefined;
    h.helper.beforeUpError = () => {
      db = addDb();
      h.docker.addContainer({
        devspaceId: ENV_ID,
        name: NAME,
        state: 'running',
        image: IMAGE_2,
        labels: { [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION), ...COMPOSE_LABELS, 'com.docker.compose.service': 'app', 'com.docker.compose.config-hash': 'y' },
      });
      cancel.abort();
    };
    await h.service.openDevspace(ENV_ID, { progress: h.progress, signal: cancel.signal }).catch(() => undefined);
    h.helper.upError = () => undefined;
    h.helper.beforeUpError = undefined;
    h.ui.configurationChangedAnswer = 'later';
    await h.service.openDevspace(ENV_ID, options());
    h.ui.configurationChangedAnswer = 'rebuildNow';
    return db;
  }

  it('up helperFailed after a cancelled switch: the running compose containers are kept, and the open ends with helperFailed', async () => {
    const db = await cancelledSwitch();
    const dev = devContainer();
    h.ui.warnings.length = 0;
    const logAt = h.docker.log.length;
    h.helper.upFailsBeforeRemoval = true;
    h.helper.upError = () => new UserFacingError('helperFailed', Messages.helperFailed, `No such image: sha256:${'4'.repeat(64)}`);
    // A helperFailed during an update fails the open: the running compose containers are not opened as they are.
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('helperFailed');
    expect(h.ui.warnings).toEqual([]);
    expect(devContainer()).toMatchObject({ id: dev?.id, state: 'running' });
    expect(dbContainer()?.id).toBe(db?.id);
    expect(h.docker.log.slice(logAt).filter((l) => l.startsWith('rm '))).toEqual([]);
  });

  it('run-user-commands helperFailed after up replaced the dev container of a cancelled switch: detail of the switch', async () => {
    await cancelledSwitch();
    h.helper.userCommandsError = new UserFacingError('helperFailed', Messages.helperFailed, `No such image: sha256:${'4'.repeat(64)}`);
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('helperFailed');
    expect(error.detail).toContain('now uses Docker Compose');
  });

  it('removes only the containers that the failed up created when the switch removed the single container', async () => {
    await seedDevspace(h, { container: 'stopped' });
    h.docker.images.add(DB_IMAGE);
    // A db container of an earlier switch exists already.
    const db = addDb('stopped');
    h.ui.configurationChangedAnswer = 'rebuildNow';
    h.helper.upError = (image) => (image === IMAGE_2 ? new Error('compose up failed') : undefined);
    let cache: ContainerInfo | undefined;
    h.helper.beforeUpError = () => {
      cache = h.docker.addContainer({ devspaceId: ENV_ID, name: `${PROJECT}-cache-1`, state: 'running', image: DB_IMAGE, labels: { ...DB_LABELS, [LABEL_COMPOSE_SERVICE]: 'cache', 'com.docker.compose.service': 'cache' } });
    };
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('startFailed');
    expect(h.docker.log).toContain(`rm ${cache?.id}`);
    expect(h.docker.log).not.toContain(`rm ${db.id}`);
    expect(error.detail).toContain(`The containers that Docker Compose had created were removed again: the container ${PROJECT}-cache-1 of the service cache.`);
    expect(error.detail).toContain(`The containers of Docker Compose that existed before this start were kept: the container ${PROJECT}-db-1 of the service db.`);
  });

  it('labels the dev container that up creates with the configuration path', async () => {
    // Docker Compose: the dev service and the other services.
    await h.service.open(TARGET, options());
    expect(upModel().services.app.labels).toMatchObject({ [LABEL_CONFIG_PATH]: DEFAULT_CONFIG_PATH });
    // Only the dev service carries the label.
    expect(upModel().services.db.labels).not.toHaveProperty(LABEL_CONFIG_PATH);
    expect(devContainer()?.labels[LABEL_CONFIG_PATH]).toBe(DEFAULT_CONFIG_PATH);
    // Only the dev service carries the label.
    expect(dbContainer()?.labels[LABEL_CONFIG_PATH]).toBeUndefined();
    // A single container.
    const other = createHarness({ newDevspaceId: () => ENV_ID });
    try {
      other.helper.files = { [COMPOSE_PATH]: { configText: DEFAULT_CONFIG_TEXT } };
      other.checker.outcome = checked({ [BASE_IMAGE]: DIGEST_NEW }, { [FEATURE]: FEATURE_DIGEST });
      await other.service.open({ ...TARGET, configPaths: [COMPOSE_PATH] }, { progress: other.progress });
      expect(other.helper.ups[0].override.runArgs).toEqual(expect.arrayContaining(['--label', `${LABEL_CONFIG_PATH}=${COMPOSE_PATH}`]));
      expect(other.docker.containersOf(ENV_ID)[0].labels[LABEL_CONFIG_PATH]).toBe(COMPOSE_PATH);
    } finally {
      other.cleanup();
    }
  });

  function seedRestore(): void {
    h.docker.volumes.set(NAME, { [LABEL_DEVSPACE_ID]: ENV_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id });
    h.docker.images.add(DB_IMAGE);
  }

  it('restores the configuration path from the label of the containers, the dev container first', async () => {
    seedRestore();
    h.docker.addContainer({ devspaceId: ENV_ID, name: NAME, state: 'stopped', image: IMAGE_1, labels: { ...COMPOSE_LABELS, 'com.docker.compose.service': 'app', [LABEL_CONFIG_PATH]: COMPOSE_PATH } });
    addDb('stopped', { [LABEL_CONFIG_PATH]: '.devcontainer/other/devcontainer.json' });
    expect(await h.service.reconcileFromVolumes()).toBe(1);
    expect((await h.registry.get(ENV_ID))?.configPath).toBe(COMPOSE_PATH);
  });

  it('keeps the default configuration path when only a container of another service carries the label', async () => {
    seedRestore();
    addDb('stopped', { [LABEL_CONFIG_PATH]: COMPOSE_PATH });
    expect(await h.service.reconcileFromVolumes()).toBe(1);
    // The label of another service (perhaps of its image) does not count.
    expect((await h.registry.get(ENV_ID))?.configPath).toBe(DEFAULT_CONFIG_PATH);
  });

  it.each(['../../etc/devcontainer.json', '/workspaces/api/.devcontainer/devcontainer.json', '.devcontainer/../x/devcontainer.json', '.devcontainer/a/b/devcontainer.json', 'devcontainer.json'])(
    'keeps the default configuration path for the label %j (D4-2)',
    async (value) => {
      seedRestore();
      // The label is on the dev container, the only one whose label counts.
      h.docker.addContainer({ devspaceId: ENV_ID, name: NAME, state: 'stopped', image: IMAGE_1, labels: { ...COMPOSE_LABELS, 'com.docker.compose.service': 'app', [LABEL_CONFIG_PATH]: value } });
      expect(await h.service.reconcileFromVolumes()).toBe(1);
      expect((await h.registry.get(ENV_ID))?.configPath).toBe(DEFAULT_CONFIG_PATH);
      expect(h.logger.warnings.some((line) => line.includes('which is no configuration path'))).toBe(true);
    },
  );

  it('asks before a switch when the dev container of Docker Compose is gone and old containers of other services carry no label', async () => {
    await seedCompose({ dev: null, db: 'running' });
    await h.registry.updateDevspace(ENV_ID, (e) => {
      delete e.buildRecord;
    });
    const db = dbContainer();
    useSingle();
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(h.ui.prompts).toEqual([`configurationKindChanged ${REPO}`]);
    // The question of its own for a missing dev container.
    expect(h.ui.kindQuestions).toEqual([Messages.configurationKindChangedDevContainerMissing(DEFAULT_CONFIG_PATH)]);
    // "Later": nothing can start without the switch, and nothing is removed.
    expect(error.code).toBe('startFailed');
    expect(error.detail).toBe(Messages.composeDevContainerMissing(DEFAULT_CONFIG_PATH));
    expect(h.docker.log.filter((line) => line.startsWith('rm'))).toEqual([]);
    expect(h.helper.ups).toEqual([]);
    expect(dbContainer()?.id).toBe(db?.id);
    // "Rebuild now" switches.
    h.ui.configurationKindChangedAnswer = 'rebuildNow';
    await h.service.openDevspace(ENV_ID, options());
    expect(h.docker.log).toContain(`rm ${db?.id}`);
    expect(h.helper.builds).toHaveLength(1);
  });

  it('names the switch to Docker Compose and what Rebuild now removes', async () => {
    await seedDevspace(h, { container: 'stopped' });
    await h.registry.updateDevspace(ENV_ID, (e) => {
      delete e.buildRecord;
    });
    await h.service.openDevspace(ENV_ID, options());
    expect(h.ui.kindQuestions).toEqual([Messages.configurationKindChanged(false, DEFAULT_CONFIG_PATH)]);
    expect(h.ui.kindQuestions[0]).toContain('is its own row in the list of devspaces');
    expect(h.ui.kindQuestions[0]).toContain('named volumes are kept');
    expect(h.helper.ups.map((up) => up.image)).toEqual([IMAGE_1]);
    expect(h.helper.builds).toEqual([]);
  });

  it('checks devcontainer.json before a Dockerfile of a service that does not exist', async () => {
    await seedCompose({ dev: 'stopped', db: 'stopped' });
    useCompose(h, {
      ...output((m) => (m.services.db = { build: { context: `${FOLDER}/db`, dockerfile: 'Dockerfile' } })),
      realPaths: { '/workspaces': '/workspaces', [`${FOLDER}/init.sql`]: `${FOLDER}/init.sql`, [`${FOLDER}/db`]: `${FOLDER}/db`, [`${FOLDER}/db/Dockerfile`]: null },
      missing: [`${FOLDER}/db/Dockerfile`],
    });
    h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: CONFIG_TEXT.replace('"remoteUser"', '"privileged": true, "remoteUser"') } };
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toBe(Messages.hostAccess('privileged mode'));
    expect(h.docker.log.filter((line) => line.startsWith('start'))).toEqual([]);
  });

  it.each([false, true])(
    'removes stray containers of other services next to a single container and starts it, also when the configuration cannot be read (P4-3, rebuild %s)',
    async (forceRebuild) => {
      await seedDevspace(h, { container: 'stopped' });
      const dev = devContainer();
      useSingle();
      h.helper.readConfigurationError = new Error('bad config');
      const db = addDb('stopped');
      const result = await h.service.openDevspace(ENV_ID, { progress: h.progress, forceRebuild });
      expect(result.containerName).toBe(NAME);
      expect(h.docker.log).toContain(`rm ${db.id}`);
      expect(h.docker.containersOf(ENV_ID).map((c) => c.id)).toEqual([dev?.id]);
      expect(h.docker.log.filter((line) => line.startsWith('volume rm'))).toEqual([]);
    },
  );
});

describe('configurations that share a compose file, and the report of a switch', () => {
  const OTHER_PATH = '.devcontainer/other/devcontainer.json';

  it('keeps the other services as they are when the selected configuration changes between two that share the compose file', async () => {
    h.helper.files = {
      [DEFAULT_CONFIG_PATH]: { configText: CONFIG_TEXT },
      [OTHER_PATH]: { configText: CONFIG_TEXT.replace('["compose.yml"]', '["../compose.yml"]') },
    };
    await h.service.open(TARGET, options());
    const first = upModel();
    await h.service.openDevspace(ENV_ID, { progress: h.progress, configPath: OTHER_PATH });
    expect((await h.registry.get(ENV_ID))?.configPath).toBe(OTHER_PATH);
    expect(h.helper.ups).toHaveLength(2);
    const second = upModel();
    expect(first.services.app.labels).toMatchObject({ [LABEL_CONFIG_PATH]: DEFAULT_CONFIG_PATH });
    expect(second.services.app.labels).toMatchObject({ [LABEL_CONFIG_PATH]: OTHER_PATH });
    // The labels of the db service decide its configuration hash in Docker Compose: the same, so its container stays.
    expect(second.services.db).toEqual(first.services.db);
    expect(second.services.db.labels).not.toHaveProperty([LABEL_CONFIG_PATH]);
  });

  it.each(['.devcontainer/a\\b/devcontainer.json', '.devcontainer/my config/devcontainer.json'])(
    'starts a single container of the configuration %j, with the label nimblescape.devspaces.config-path (D5-2)',
    async (configPath) => {
      const other = createHarness({ newDevspaceId: () => ENV_ID });
      try {
        other.helper.files = { [configPath]: { configText: DEFAULT_CONFIG_TEXT } };
        other.checker.outcome = checked({ [BASE_IMAGE]: DIGEST_NEW }, { [FEATURE]: FEATURE_DIGEST });
        const result = await other.service.open({ ...TARGET, configPaths: [configPath] }, { progress: other.progress });
        // The names carry the word of the source: the folder name of the configuration, lower case, `[a-z0-9-]`.
        expect(result.containerName).toBe(resourceName(REPO, ENV_ID, sourceSegment({ kind: 'configuration', configPath })));
        expect(other.helper.ups[0].override.runArgs).toEqual(expect.arrayContaining(['--label', `${LABEL_CONFIG_PATH}=${configPath}`]));
        expect(other.docker.containersOf(ENV_ID)[0].labels[LABEL_CONFIG_PATH]).toBe(configPath);
      } finally {
        other.cleanup();
      }
    },
  );

  it('restores the configuration path of a folder with a backslash from the label', async () => {
    h.docker.volumes.set(NAME, { [LABEL_DEVSPACE_ID]: ENV_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id });
    h.docker.addContainer({ devspaceId: ENV_ID, name: NAME, state: 'stopped', image: IMAGE_1, labels: { [LABEL_CONFIG_PATH]: '.devcontainer/a\\b/devcontainer.json' } });
    expect(await h.service.reconcileFromVolumes()).toBe(1);
    expect((await h.registry.get(ENV_ID))?.configPath).toBe('.devcontainer/a\\b/devcontainer.json');
  });

  async function withoutRecord(): Promise<void> {
    await h.registry.updateDevspace(ENV_ID, (e) => {
      delete e.buildRecord;
    });
  }

  it('reports a switch from Docker Compose to a single container with the question of the pipeline', async () => {
    await seedCompose({ dev: 'stopped', db: 'stopped' });
    await withoutRecord();
    useSingle();
    // The pipeline asks its own question, which says what Later does in an open. No docker start fallback: Later then
    // fails to start (no Docker Compose configuration, no `up`).
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('startFailed');
    expect(h.ui.kindQuestions).toEqual([Messages.configurationKindChanged(true, DEFAULT_CONFIG_PATH)]);
  });

  it('reports a switch when the dev container of Docker Compose is gone, with the question for it', async () => {
    await seedCompose({ dev: null, db: 'stopped' });
    await withoutRecord();
    useSingle();
    const question = Messages.configurationKindChangedDevContainerMissing(DEFAULT_CONFIG_PATH);
    expect(question).toContain('Later starts nothing');
    expect(question).toContain('choose Rebuild');
    expect(question).toContain('is its own row in the list of devspaces');
    expect(question).not.toContain('Later keeps');
    // The pipeline asks the same question; Later starts nothing.
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(h.ui.kindQuestions).toEqual([question]);
    expect(error.detail).toBe(Messages.composeDevContainerMissing(DEFAULT_CONFIG_PATH));
  });
});

describe('the default configuration of a restored devspace', () => {
  it('restores the default configuration when only a side container carries the label and the dev container is gone', async () => {
    h.docker.volumes.set(NAME, { [LABEL_DEVSPACE_ID]: ENV_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id });
    h.docker.images.add(DB_IMAGE);
    const labels = { [LABEL_COMPOSE_SERVICE]: 'db', ...COMPOSE_LABELS, 'com.docker.compose.service': 'db', [LABEL_CONFIG_PATH]: '.devcontainer/other/devcontainer.json' };
    h.docker.addContainer({ devspaceId: ENV_ID, name: `${PROJECT}-db-1`, state: 'stopped', image: DB_IMAGE, labels });
    expect(await h.service.reconcileFromVolumes()).toBe(1);
    expect((await h.registry.get(ENV_ID))?.configPath).toBe(DEFAULT_CONFIG_PATH);
    expect(h.logger.warnings.some((line) => line.includes('which is no configuration path'))).toBe(false);
  });
});

describe('the restart policy, the container state, and side services at a removal', () => {
  it('opens a model with restart: unless-stopped (the templates), rewrites it to no, and logs it', async () => {
    useCompose(
      h,
      output((m) => {
        m.services.db.restart = 'unless-stopped';
        m.services.db.deploy = { restart_policy: { condition: 'any' } };
      }),
    );
    await h.service.open(TARGET, options());
    expect(upModel().services.db.restart).toBe('no');
    expect(upModel().services.db.deploy).toEqual({ restart_policy: { condition: 'none' } });
    const changed = h.logger.infos.find((line) => line.startsWith('Changed in the Docker Compose model'));
    expect(changed).toContain('service db: restart unless-stopped (Devspaces starts the containers itself (no))');
    expect(changed).toContain('service db: deploy.restart_policy.condition any');
  });

  it('takes the container state of a devspace from its dev container, and marks running side services', async () => {
    await seedCompose({ dev: 'stopped', db: 'running' });
    expect((await h.operations.inspectStates())?.get(ENV_ID)).toEqual({ container: 'stopped', volume: true, servicesRunning: true });
    await h.operations.stop(ENV_ID);
    expect((await h.operations.inspectStates())?.get(ENV_ID)).toEqual({ container: 'stopped', volume: true });
  });

  it('reports a running dev container as running, and no dev container as missing', async () => {
    await seedCompose({ dev: 'running', db: 'stopped' });
    expect((await h.operations.inspectStates())?.get(ENV_ID)).toEqual({ container: 'running', volume: true });
    h.docker.containers.delete(devContainer()!.id);
    dbContainer()!.state = 'running';
    expect((await h.operations.inspectStates())?.get(ENV_ID)).toEqual({ container: 'missing', volume: true, servicesRunning: true });
  });

  /** The lines of the Docker log for `id`: `stop` must come before `rm`. */
  function stopBeforeRemove(id: string): void {
    const stop = h.docker.log.indexOf(`stop ${id}`);
    const rm = h.docker.log.indexOf(`rm ${id}`);
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(rm).toBeGreaterThan(stop);
  }

  it('stops a running side service before Delete removes it', async () => {
    await seedCompose({ dev: 'running', db: 'running' });
    const db = dbContainer()!.id;
    await h.service.delete(ENV_ID, { ...options(), additionalVolumesToRemove: [] });
    stopBeforeRemove(db);
    expect(h.docker.containersOf(ENV_ID)).toEqual([]);
  });

  it('removes a stopped side service at Delete without a stop', async () => {
    await seedCompose({ dev: 'running', db: 'stopped' });
    const db = dbContainer()!.id;
    await h.service.delete(ENV_ID, { ...options(), additionalVolumesToRemove: [] });
    expect(h.docker.log).not.toContain(`stop ${db}`);
    expect(h.docker.log).toContain(`rm ${db}`);
  });

  it('removes a side service at Delete also when its stop fails', async () => {
    await seedCompose({ dev: 'stopped', db: 'running' });
    const db = dbContainer()!.id;
    const stop = h.docker.stopContainer.bind(h.docker);
    h.docker.stopContainer = async (ref: string) => {
      await stop(ref);
      if (ref === db) throw new Error('stop timed out');
    };
    await h.service.delete(ENV_ID, { ...options(), additionalVolumesToRemove: [] });
    expect(h.docker.log).toContain(`rm ${db}`);
    expect(h.logger.warnings.some((line) => line.includes('stop timed out'))).toBe(true);
    expect(await h.registry.list()).toEqual([]);
  });

  it('stops a running side service before the switch to a single container removes it', async () => {
    await seedCompose({ dev: 'stopped', db: 'running' });
    h.docker.networks.set(`${PROJECT}_default`, COMPOSE_LABELS);
    h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: DEFAULT_CONFIG_TEXT } };
    const db = dbContainer()!.id;
    h.ui.configurationChangedAnswer = 'rebuildNow';
    await h.service.openDevspace(ENV_ID, options());
    stopBeforeRemove(db);
  });

  it('stops a running stray side service before it is removed next to a single container', async () => {
    await seedDevspace(h, { container: 'stopped' });
    useSingle();
    h.docker.images.add(DB_IMAGE);
    const db = h.docker.addContainer({
      devspaceId: ENV_ID,
      name: `${PROJECT}-db-1`,
      state: 'running',
      image: DB_IMAGE,
      labels: { [LABEL_COMPOSE_SERVICE]: 'db', ...COMPOSE_LABELS, 'com.docker.compose.service': 'db' },
    });
    await h.service.openDevspace(ENV_ID, options());
    stopBeforeRemove(db.id);
  });
});

describe('a side service is stopped before each removal', () => {
  const DB_LABELS = { [LABEL_COMPOSE_SERVICE]: 'db', ...COMPOSE_LABELS, 'com.docker.compose.service': 'db', 'com.docker.compose.config-hash': 'x' };

  function addDb(state: ContainerState = 'running'): ContainerInfo {
    return h.docker.addContainer({ devspaceId: ENV_ID, name: `${PROJECT}-db-1`, state, image: DB_IMAGE, labels: { ...DB_LABELS } });
  }

  /** The lines of the Docker log for `id`: `stop` must come before `rm`. */
  function stopBeforeRemove(id: string): void {
    const stop = h.docker.log.indexOf(`stop ${id}`);
    const rm = h.docker.log.indexOf(`rm ${id}`);
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(rm).toBeGreaterThan(stop);
  }

  it('stops the containers that a failed up of the switch to Docker Compose created before it removes them (removeFailedComposeContainers)', async () => {
    await seedDevspace(h, { container: 'stopped' });
    h.docker.images.add(DB_IMAGE);
    h.ui.configurationChangedAnswer = 'rebuildNow';
    h.helper.upError = (image) => (image === IMAGE_2 ? new Error('compose up failed') : undefined);
    let db: ContainerInfo | undefined;
    h.helper.beforeUpError = () => {
      db = addDb();
    };
    await rejection(h.service.openDevspace(ENV_ID, options()));
    // Never `docker rm -f` of the running database (a SIGKILL).
    stopBeforeRemove(db!.id);
  });

  it('stops the running side services of a failed first open before it removes them (removeFailedFirstOpen)', async () => {
    h.helper.upError = () => new Error('compose up failed');
    let db: ContainerInfo | undefined;
    h.helper.beforeUpError = () => {
      db = addDb();
    };
    await rejection(h.service.open(TARGET, options()));
    stopBeforeRemove(db!.id);
    expect(h.docker.containersOf(ENV_ID)).toEqual([]);
  });

  it('stops a running side service of the project without the ID label before Delete removes it (removeComposeProject)', async () => {
    await seedCompose({ dev: 'stopped', db: null });
    const db = addDb();
    // For example a container of an earlier model: only the labels of the project.
    delete h.docker.containers.get(db.id)!.labels[LABEL_DEVSPACE_ID];
    await h.service.delete(ENV_ID, { ...options(), additionalVolumesToRemove: [] });
    stopBeforeRemove(db.id);
    expect(h.docker.containers.has(db.id)).toBe(false);
  });
});

describe('a bind mount of a repository folder that does not exist yet', () => {
  const SOURCE = `${FOLDER}/data/postgres`;

  function withDataFolder(ancestor: string | null): void {
    const out = output((m) => {
      m.services.db.volumes = [{ type: 'bind', source: SOURCE, target: '/var/lib/postgresql/data', bind: { create_host_path: true } }];
    });
    out.realPaths = { ...out.realPaths, [SOURCE]: null };
    out.mountAncestors = { [SOURCE]: ancestor };
    useCompose(h, out);
  }

  it('creates the folder with the helper image of the open', async () => {
    withDataFolder(FOLDER);
    await h.service.open(TARGET, options());
    expect(h.helper.createdFolders).toEqual([[SOURCE]]);
    // There is no previous helper image: the current tag with its image ID.
    const previous = { tag: 'devspaces-worker:test', id: h.helper.currentHelperImageId };
    expect(h.helper.helperImages.filter((entry) => entry.call === 'createRepositoryFolders')).toEqual([{ call: 'createRepositoryFolders', image: previous }]);
  });

  it('creates the folder in the workspace volume before up, and mounts it as a folder of the volume', async () => {
    withDataFolder(FOLDER);
    // Not refused although the path does not exist in the repository yet.
    await h.service.open(TARGET, options());
    expect(h.helper.createdFolders).toEqual([[SOURCE]]);
    const calls = h.helper.calls;
    expect(calls.indexOf(`createRepositoryFolders ${SOURCE}`)).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf(`createRepositoryFolders ${SOURCE}`)).toBeLessThan(calls.findIndex((call) => call.startsWith('up')));
    expect(upModel().services.db.volumes).toEqual([
      { type: 'volume', source: WORKSPACE_VOLUME_KEY, target: '/var/lib/postgresql/data', volume: { nocopy: true, subpath: 'api/data/postgres' } },
    ]);
    const changed = h.logger.infos.find((line) => line.startsWith('Changed in the Docker Compose model'));
    expect(changed).toContain(`service db: bind mount ${SOURCE} → /var/lib/postgresql/data (the folder api/data/postgres of the workspace volume, created in the repository before the start`);
  });

  it('refuses it when the nearest folder is a link out of the repository, before anything is built or created', async () => {
    withDataFolder('/workspaces/.devspace+');
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toBe(Messages.hostAccess(`service db: bind mount ${SOURCE} → /var/lib/postgresql/data (a link to /workspaces/.devspace+, outside of the repository)`));
    expect(h.helper.createdFolders).toEqual([]);
    expect(h.helper.builds).toEqual([]);
  });

  it('does not start when the folder cannot be created', async () => {
    withDataFolder(FOLDER);
    h.helper.createFoldersError = new Error('data leads out of the repository');
    await expect(h.service.open(TARGET, options())).rejects.toThrow();
    expect(h.helper.ups).toEqual([]);
  });
});

describe('the ownership fixes leave out the paths of the repository that other services mount', () => {
  const SOURCE = `${FOLDER}/data/postgres`;
  const INIT_SQL = `${FOLDER}/init.sql`;

  function withDataFolder(): void {
    const out = output((m) => {
      m.services.db.volumes = [
        { type: 'bind', source: SOURCE, target: '/var/lib/postgresql/data', bind: { create_host_path: true } },
        { type: 'bind', source: INIT_SQL, target: '/docker-entrypoint-initdb.d/init.sql', read_only: true, bind: {} },
      ];
    });
    out.realPaths = { ...out.realPaths, [SOURCE]: null };
    out.mountAncestors = { [SOURCE]: FOLDER };
    useCompose(h, out);
  }

  /** The arguments after `sh -c <script> sh` of the ownership fix of the repository folder with `docker exec`. */
  function fixArguments(): string[][] {
    return h.docker.execs
      .filter((e) => e.user === 'root' && e.command[0] === 'sh' && e.command[2].includes('chown') && e.command[4] === FOLDER)
      .map((e) => e.command.slice(4));
  }

  it('leaves the data folder of db out of the fix after up, and records the paths in the build record', async () => {
    withDataFolder();
    await h.service.open(TARGET, options());
    // Not `[FOLDER, 'vscode']` alone: the fix after `up` (db has run) would give the data of Postgres to vscode.
    // Without the read-only INIT_SQL; the ready arguments of find.
    expect(fixArguments()).toEqual([[FOLDER, 'vscode', ...servicePathArguments(FOLDER, [SOURCE])]]);
    // The fix before `up` of the new clone: no service has run on the files yet, so every file gets its owner. It is
    // the step repositoryOwnershipFix of the batch helper with the IDs of vscode from the /etc/passwd of the image,
    // without paths of services.
    const before = h.helper.repositoryOwnershipFixes;
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ repository: REPO, uid: '1000', gid: '1000' });
    expect(before[0].serviceFolders).toBeUndefined();
    // In the entry, not in the build record, and without the read-only INIT_SQL.
    expect((await h.registry.get(ENV_ID))?.serviceFolders).toEqual([SOURCE]);
  });

  it('runs no ownership fix before up when a rebuild creates the containers of an existing clone again', async () => {
    await seedCompose({ dev: 'stopped', db: 'stopped' });
    await h.service.openDevspace(ENV_ID, { ...options(), forceRebuild: true });
    expect(h.helper.ups.length).toBeGreaterThan(0);
    // The fix before `up` is for a new clone only: the services have run on these files. No step
    // repositoryOwnershipFix.
    expect(h.helper.repositoryOwnershipFixes).toEqual([]);
  });

  it('leaves them out when a rebuild creates the containers again', async () => {
    withDataFolder();
    await seedCompose({ dev: 'stopped', db: 'stopped' });
    await h.service.openDevspace(ENV_ID, { ...options(), forceRebuild: true });
    // Without the read-only INIT_SQL; the ready arguments of find.
    expect(fixArguments()).toEqual([[FOLDER, 'vscode', ...servicePathArguments(FOLDER, [SOURCE])]]);
  });

  it('records the paths at an up without a build', async () => {
    await seedCompose({ dev: 'stopped', db: 'stopped' });
    // The next start with up records the paths of the model, in the entry: a data folder of db that exists (the
    // read-only init.sql of the default model is not recorded).
    const out = output((m) => {
      m.services.db.volumes = [...(m.services.db.volumes as unknown[]), { type: 'bind', source: SOURCE, target: '/var/lib/postgresql/data', bind: {} }];
    });
    out.realPaths = { ...out.realPaths, [SOURCE]: SOURCE };
    useCompose(h, out);
    h.ui.configurationChangedAnswer = 'later';
    await h.service.openDevspace(ENV_ID, options());
    expect((await h.registry.get(ENV_ID))?.serviceFolders).toEqual([SOURCE]);
  });
});

describe('the recorded paths of the services never shrink while a container may mount them', () => {
  const OLD = `${FOLDER}/data/pg`;
  const NEW = `${FOLDER}/pgdata`;

  /** The default model with db's data in NEW (a folder that exists). */
  function withNewFolder(): void {
    const out = output((m) => {
      m.services.db.volumes = [{ type: 'bind', source: NEW, target: '/var/lib/postgresql/data', bind: {} }];
    });
    out.realPaths = { ...out.realPaths, [NEW]: NEW };
    useCompose(h, out);
  }

  it('keeps the folder of the old model at an up --no-recreate (Rebuild later), for Delete', async () => {
    // The entry names OLD; the db container was created with it and is not created again.
    await seedCompose({ dev: 'stopped', db: 'stopped', extra: { serviceFolders: [OLD] } });
    withNewFolder();
    h.ui.configurationChangedAnswer = 'later';
    await h.service.openDevspace(ENV_ID, options());
    expect(h.helper.ups.map((up) => up.removeExistingContainer)).toEqual([false]);
    const entry = await h.registry.get(ENV_ID);
    // The paths of the model first, then the recorded ones.
    expect(entry?.serviceFolders).toEqual([NEW, OLD]);
    // The question of Delete names both, in the order of the record.
    expect(repositoryServiceDataFolders(entry!)).toEqual(['./pgdata', './data/pg']);
    // Another start with the same model changes nothing.
    h.docker.containersOf(ENV_ID).forEach((container) => (container.state = 'stopped'));
    await h.service.openDevspace(ENV_ID, options());
    // In the order of the record.
    expect((await h.registry.get(ENV_ID))?.serviceFolders).toEqual([NEW, OLD]);
  });

  it('records the folders before a first up that fails', async () => {
    // An entry without a build record (restored after a lost registry, or a first open that was cut off).
    await seedDevspace(h, { container: null, record: null });
    h.docker.images.add(DB_IMAGE);
    withNewFolder();
    h.helper.upError = () => new Error('Error response from daemon: driver failed programming external connectivity');
    // Compose created the db container (with NEW) before the failure.
    h.helper.beforeUpError = () => {
      h.docker.addContainer({ devspaceId: ENV_ID, name: `${PROJECT}-db-1`, state: 'running', image: DB_IMAGE, labels: { [LABEL_COMPOSE_SERVICE]: 'db', ...COMPOSE_LABELS, 'com.docker.compose.service': 'db' } });
    };
    await expect(h.service.openDevspace(ENV_ID, options())).rejects.toBeInstanceOf(UserFacingError);
    expect((await h.registry.get(ENV_ID))?.buildRecord).toBeUndefined();
    // Also recorded without a build record.
    expect((await h.registry.get(ENV_ID))?.serviceFolders).toEqual([NEW]);
  });

  it('replaces the list when no container of another service exists before up', async () => {
    await seedCompose({ dev: 'stopped', db: null, extra: { serviceFolders: [OLD] } });
    withNewFolder();
    // OLD is kept only while it exists in the volume (also when no container of another service exists, as its data may
    // still be there); here it does not exist any more.
    h.docker.missingPaths.add(OLD);
    await h.service.openDevspace(ENV_ID, { ...options(), forceRebuild: true });
    expect((await h.registry.get(ENV_ID))?.serviceFolders).toEqual([NEW]);
    h.docker.missingPaths.clear();
    // With the db container of NEW, a model with OLD adds OLD.
    const out = output((m) => {
      m.services.db.volumes = [{ type: 'bind', source: OLD, target: '/var/lib/postgresql/data', bind: {} }];
    });
    out.realPaths = { ...out.realPaths, [OLD]: OLD };
    useCompose(h, out);
    h.docker.containersOf(ENV_ID).forEach((container) => (container.state = 'stopped'));
    await h.service.openDevspace(ENV_ID, { ...options(), forceRebuild: true });
    // The paths of the model first, then those that the db container mounts.
    expect((await h.registry.get(ENV_ID))?.serviceFolders).toEqual([OLD, NEW]);
  });
});

describe('a dev container is stopped before it is removed', () => {
  function stopBeforeRemove(id: string): void {
    const stop = h.docker.log.indexOf(`stop ${id}`);
    const rm = h.docker.log.indexOf(`rm ${id}`);
    // Not only `rm -f` (a SIGKILL of the processes of the running container).
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(rm).toBeGreaterThan(stop);
  }

  it('stops the running dev container of Docker Compose before Delete removes it', async () => {
    await seedCompose({ dev: 'running', db: 'running' });
    const dev = devContainer()!;
    const db = dbContainer()!;
    await h.service.delete(ENV_ID, { ...options(), additionalVolumesToRemove: [] });
    stopBeforeRemove(dev.id);
    stopBeforeRemove(db.id);
  });

  it('stops a running single container before Delete removes it', async () => {
    await seedDevspace(h, { container: 'running' });
    const dev = h.docker.containersOf(ENV_ID)[0];
    await h.service.delete(ENV_ID, { ...options(), additionalVolumesToRemove: [] });
    stopBeforeRemove(dev.id);
  });

  it('stops the running single container before the switch to Docker Compose replaces it', async () => {
    await seedDevspace(h, { container: 'running' });
    const single = h.docker.containersOf(ENV_ID)[0];
    h.ui.configurationChangedAnswer = 'rebuildNow';
    await h.service.openDevspace(ENV_ID, options());
    expect(h.docker.containers.has(single.id)).toBe(false);
    stopBeforeRemove(single.id);
  });

  it('removes a stopped dev container without a stop', async () => {
    await seedDevspace(h, { container: 'stopped' });
    const dev = h.docker.containersOf(ENV_ID)[0];
    await h.service.delete(ENV_ID, { ...options(), additionalVolumesToRemove: [] });
    expect(h.docker.log).not.toContain(`stop ${dev.id}`);
    expect(h.docker.log).toContain(`rm ${dev.id}`);
  });
});

describe('the bounds of the extension host for a Docker Compose model', () => {
  it('refuses a model with more services than MAX_COMPOSE_SERVICES before it analyses or rewrites it', async () => {
    useCompose(
      h,
      output((m) => {
        for (let i = 0; i < 501; i++) m.services[`s${i}`] = { image: 'alpine:3.22' };
      }),
    );
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toBe(Messages.configurationTooComplex(ANALYSIS_FAILED_ITEM));
    expect(h.helper.builds).toEqual([]);
    expect(h.logger.warnings.some((line) => line.includes('503 services (at most 500)'))).toBe(true);
  });

  it('refuses a model with too many top-level volumes, or too much Dockerfile text over its services, before it hashes it', async () => {
    const text = `FROM alpine\nRUN echo ${'a'.repeat(1024 * 1024)}`;
    const big = output((m) => {
      for (let i = 0; i < 40; i++) m.services[`s${i}`] = { build: { context: FOLDER, dockerfile: 'Dockerfile' } };
    });
    big.dockerfiles = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`s${i}`, text]));
    useCompose(h, big);
    const error = await rejection(h.service.open(TARGET, options()));
    // Never 40 MiB of JSON text for each hash in the extension host before the job size check of the worker.
    expect(error.code).toBe('hostAccess');
    expect(error.message).toBe(Messages.configurationTooComplex(ANALYSIS_FAILED_ITEM));
    expect(h.logger.warnings.some((line) => line.includes(`more than ${32 * 1024 * 1024} characters of Dockerfiles of the services`))).toBe(true);
    useCompose(
      h,
      output((m) => {
        m.volumes = Object.fromEntries(Array.from({ length: 5001 }, (_, i) => [`v${i}`, { name: `x_v${i}` }]));
      }),
    );
    expect((await rejection(h.service.open(TARGET, options()))).code).toBe('hostAccess');
    expect(h.logger.warnings.some((line) => line.includes('5001 top-level volumes (at most 5000)'))).toBe(true);
    expect(h.helper.builds).toEqual([]);
  });

  it('asks Docker about the image IDs of all services with one call, and not at all for a refused model', async () => {
    useCompose(
      h,
      output((m) => {
        for (let i = 0; i < 50; i++) m.services[`s${i}`] = { image: `example.com/s${i}:1` };
      }),
    );
    await h.service.open(TARGET, options());
    // One `docker image inspect` for each check of the model (not one per reference): before the build, and before the
    // `up` that creates the containers.
    expect(h.docker.imageInspections).toHaveLength(2);
    for (const references of h.docker.imageInspections) {
      expect(references).toHaveLength(52);
      expect(references).toEqual(expect.arrayContaining([DB_IMAGE, BASE_IMAGE, 'example.com/s0:1', 'example.com/s49:1']));
    }
    h.docker.imageInspections.length = 0;
    useCompose(
      h,
      output((m) => {
        m.services.db.privileged = true;
      }),
    );
    await expect(h.service.openDevspace(ENV_ID, { ...options(), forceRebuild: true })).rejects.toMatchObject({ code: 'hostAccess' });
    expect(h.docker.imageInspections).toEqual([]);
  });

  it('still refuses a service image that Docker resolves by its image ID', async () => {
    useCompose(
      h,
      output((m) => {
        m.services.cache = { image: 'a1b2c3' };
      }),
    );
    h.docker.images.add('a1b2c3');
    h.docker.imageRepoNames.set('a1b2c3', { repoTags: [`${OTHER_PROJECT}-db:latest`], repoDigests: [] });
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.message).toContain('image a1b2c3 (an image ID; name the image)');
  });

  it('refuses the image ID of a service also when another reference cannot be inspected, and that reference too', async () => {
    useCompose(
      h,
      output((m) => {
        m.services.cache = { image: '3f2a1b9c' };
        // foo/Bar is refused before any inspect (not a valid image reference); a reference that Docker's grammar allows
        // but Docker cannot inspect (an image ID prefix of several images) is the one that cannot be checked.
        m.services.unused = { image: 'a1b2' };
      }),
    );
    h.docker.images.add('3f2a1b9c');
    h.docker.imageRepoNames.set('3f2a1b9c', { repoTags: [`${OTHER_PROJECT}-db:latest`], repoDigests: [] });
    h.docker.uninspectableImages.add('a1b2');
    const error = await rejection(h.service.open(TARGET, options()));
    // The batch does not fail as a whole: every reference of it is checked.
    expect(error.code).toBe('hostAccess');
    expect(error.message).toContain('service cache: image 3f2a1b9c (an image ID; name the image)');
    expect(error.message).toContain('service unused: image a1b2 (the image reference could not be checked)');
    expect(h.helper.builds).toEqual([]);
  });
});

describe('the image check of Docker tells a refusal from a failure to check', () => {
  // A text of its own for a check that Docker could not answer (not the internal error, which says "reinstall Dev
  // Space").
  const INTERNAL = Messages.configurationCheckDocker(dockerCheckItem(`${BASE_IMAGE}, ${DB_IMAGE}`));

  /** Makes the `n`th inspectImageNames (counted from 1) fail as `failure`; the others answer. */
  function failInspection(n: number, failure: (references: readonly string[]) => void): void {
    const original = h.docker.inspectImageNames.bind(h.docker);
    let calls = 0;
    h.docker.inspectImageNames = async (references: readonly string[]) => {
      calls++;
      if (calls === n) failure(references);
      try {
        return await original(references);
      } finally {
        h.docker.transientImages = new Set();
        h.docker.uninspectableImages.clear();
      }
    };
  }

  it('does not remember an update whose check before `up` timed out', async () => {
    await seedCompose({ record: { images: { [BASE_IMAGE]: DIGEST_OLD, [DB_IMAGE]: DB_DIGEST } } });
    // The inspect at the load answers; the one before the `up` of the new image (composeReport) times out.
    failInspection(2, () => (h.docker.transientImages = 'all'));
    await h.service.openDevspace(ENV_ID, options());
    // Not remembered as a refused update ("needs access to your computer"), which would never be built again.
    expect((await h.registry.get(ENV_ID))?.refusedUpdate).toBeUndefined();
    // dockerCheckItem, not analysisInternalItem.
    expect(h.ui.warnings).toEqual([Messages.updateCheckFailed(dockerCheckItem(`${BASE_IMAGE}, ${DB_IMAGE}`))]);
    expect(h.docker.images.has(IMAGE_2)).toBe(false);
    expect(devContainer()?.state).toBe('running');
    // The next open, with Docker healthy again, builds the update again.
    h.helper.builds.length = 0;
    devContainer()!.state = 'stopped';
    await h.service.openDevspace(ENV_ID, options());
    expect(h.helper.builds).toHaveLength(1);
    expect((await h.registry.get(ENV_ID))?.refusedUpdate).toBeUndefined();
  });

  it('does not blame the configuration when the daemon fails at the load', async () => {
    await seedCompose();
    h.docker.transientImages = 'all';
    // No docker start fallback: a Docker Compose devspace whose configuration could not be used is not started as it
    // is; the open fails with startFailed, and the warning still names Docker, not the configuration.
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('startFailed');
    // Not refused with "Change the configuration of the repository": the warning is the internal error.
    expect(h.ui.warnings).toEqual([INTERNAL]);
    expect(devContainer()?.state).toBe('stopped');
    expect(dbContainer()?.state).toBe('stopped');
    expect(h.helper.builds).toEqual([]);
  });

  it('says in the start failure that the configuration could not be checked when the daemon failed at the load', async () => {
    await seedCompose();
    h.docker.transientImages = 'all';
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('startFailed');
    expect(error.detail).toBe(
      'The Docker Compose configuration could not be checked. The containers of Docker Compose start only through the Dev Container CLI, which needs the Docker Compose configuration.',
    );
    expect(h.logger.warnings).toContain(`The Docker Compose configuration of ${REPO} could not be checked. Its containers are not started.`);
  });

  it('does not use a new configuration whose images Docker could not inspect', async () => {
    h.docker.transientImages = 'all';
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toBe(INTERNAL);
    // The text of a check that Docker could not answer, without "reinstall".
    expect(error.message).toBe(`Docker could not check the image references (${BASE_IMAGE}, ${DB_IMAGE}). Check that Docker is running and try again.`);
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.ups).toEqual([]);
  });

  it('still refuses, and remembers, an update with a reference that Docker calls invalid', async () => {
    await seedCompose({ record: { images: { [BASE_IMAGE]: DIGEST_OLD, [DB_IMAGE]: DB_DIGEST } } });
    // For example an image ID prefix that matches several images.
    failInspection(2, () => h.docker.uninspectableImages.add(DB_IMAGE));
    await h.service.openDevspace(ENV_ID, options());
    const entry = await h.registry.get(ENV_ID);
    expect(entry?.refusedUpdate).toMatchObject({ configHash: HASH, items: `service db: image ${DB_IMAGE} (the image reference could not be checked)` });
    expect(h.docker.images.has(IMAGE_2)).toBe(false);
  });

  it('refuses a reference that is not valid in Docker\'s grammar before any inspect', async () => {
    useCompose(
      h,
      output((m) => {
        m.services.cache = { image: 'foo/Bar' };
        m.services.web = { image: 'redis:-1' };
      }),
    );
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toContain('service cache: image foo/Bar (not a valid image reference)');
    expect(error.message).toContain('service web: image redis:-1 (not a valid image reference)');
    // Never inspected (neither with the other references nor one by one).
    expect(h.docker.imageInspections.flat()).not.toContain('foo/Bar');
    // The configuration is refused for them anyway, so the other references are not inspected either.
    expect(h.docker.imageInspections).toEqual([]);
    expect(h.helper.builds).toEqual([]);
  });

  it('refuses a reference that is not valid in Docker\'s grammar also when Docker cannot answer for the others', async () => {
    await seedCompose();
    useCompose(
      h,
      output((m) => {
        m.services.cache = { image: 'foo/Bar' };
      }),
    );
    h.docker.transientImages = 'all';
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    // Not an AnalysisFailedError of Docker (which would drop the invalid reference and start the existing devspace).
    expect(error.code).toBe('hostAccess');
    expect(error.message).toContain('service cache: image foo/Bar (not a valid image reference)');
    expect(error.message).not.toContain('Docker could not check');
    expect(h.ui.warnings).toEqual([]);
    expect(devContainer()?.state).toBe('stopped');
    expect(dbContainer()?.state).toBe('stopped');
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.ups).toEqual([]);
    // The configuration is refused anyway: no inspect.
    expect(h.docker.imageInspections).toEqual([]);
  });

  it('refuses, and remembers, an update with a reference that Docker calls invalid also when another one is transient', async () => {
    await seedCompose({ record: { images: { [BASE_IMAGE]: DIGEST_OLD, [DB_IMAGE]: DB_DIGEST } } });
    // The load answers; the check before the `up` of the new image gets `invalid` for the base image (for example an
    // image ID prefix of several images) and then `transient` for db (the daemon stopped answering).
    failInspection(2, () => {
      h.docker.uninspectableImages.add(BASE_IMAGE);
      h.docker.transientImages = new Set([DB_IMAGE]);
    });
    await h.service.openDevspace(ENV_ID, options());
    expect(h.docker.imageInspections.at(-1)).toEqual([BASE_IMAGE, DB_IMAGE]);
    const items = `service app: image ${BASE_IMAGE} (the image reference could not be checked)`;
    // Not an AnalysisFailedError of Docker for db: the refusal for the base image is shown and remembered.
    expect((await h.registry.get(ENV_ID))?.refusedUpdate).toMatchObject({ configHash: HASH, items });
    expect(h.ui.warnings).toEqual([Messages.updateRefused(items)]);
    expect(h.docker.images.has(IMAGE_2)).toBe(false);
    expect(devContainer()?.state).toBe('running');
  });

  it('does not refuse a transient reference as an image ID from the images of the others', async () => {
    // A service with the image `cafe` (a local cafe:latest); db's image has an ID that starts with cafe.
    const cafeModel = model();
    cafeModel.services.cache = { image: 'cafe' };
    useCompose(
      h,
      output((m) => {
        m.services.cache = { image: 'cafe' };
      }),
    );
    await seedCompose({ record: { configHash: composeConfigHash(CONFIG_TEXT, cafeModel, {}), images: { [BASE_IMAGE]: DIGEST_OLD, [DB_IMAGE]: DB_DIGEST } } });
    h.docker.images.add('cafe');
    h.docker.imageIds.set(DB_IMAGE, `sha256:cafe${'0'.repeat(60)}`);
    // The load answers (cafe is the image cafe:latest); before the `up` of the new image, the first batch finds db's image and `cafe` is transient.
    failInspection(2, () => (h.docker.transientImages = new Set(['cafe'])));
    await h.service.openDevspace(ENV_ID, options());
    expect(h.docker.imageInspections.at(-1)).toEqual([BASE_IMAGE, DB_IMAGE, 'cafe']);
    // Not refused as "an image ID; name the image" (cafe was never inspected), and not remembered as a refused update.
    expect((await h.registry.get(ENV_ID))?.refusedUpdate).toBeUndefined();
    expect(h.ui.warnings).toEqual([Messages.updateCheckFailed(dockerCheckItem('cafe'))]);
    expect(h.docker.images.has(IMAGE_2)).toBe(false);
    expect(devContainer()?.state).toBe('running');
  });

  it('logs a transient reference and refuses the others for their definitive items', async () => {
    // `cafe` is transient, 3f2a1b9c (an image ID) is answered: refused for 3f2a1b9c only.
    useCompose(
      h,
      output((m) => {
        m.services.cache = { image: '3f2a1b9c' };
        m.services.web = { image: 'cafe' };
      }),
    );
    h.docker.images.add('3f2a1b9c');
    h.docker.imageRepoNames.set('3f2a1b9c', { repoTags: [`${OTHER_PROJECT}-db:latest`], repoDigests: [] });
    h.docker.images.add('cafe');
    h.docker.images.add(DB_IMAGE);
    h.docker.imageIds.set(DB_IMAGE, `sha256:cafe${'0'.repeat(60)}`);
    h.docker.transientImages = new Set(['cafe']);
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toContain('service cache: image 3f2a1b9c (an image ID; name the image)');
    // Not "service web: image cafe (an image ID; name the image)".
    expect(error.message).not.toContain('image cafe');
    expect(h.logger.warnings).toContain('Docker could not check the image references cafe; the configuration is refused for the others.');
  });

  it('passes the cancellation to the inspect', async () => {
    const controller = new AbortController();
    h.docker.inspectImageNames = async (_references: readonly string[], signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      controller.abort();
      throw abortError();
    };
    const error = await rejection(h.service.open(TARGET, { ...options(), signal: controller.signal }));
    expect(error.code).toBe('cancelled');
  });
});

describe('the paths of the services from facts', () => {
  const PGDATA = `${FOLDER}/pgdata`;
  const DATA = `${FOLDER}/data/pg`;

  /** The default model with db's data in `folder` (a folder that exists). */
  function withModelFolder(folder: string): void {
    const out = output((m) => {
      m.services.db.volumes = [{ type: 'bind', source: folder, target: '/var/lib/postgresql/data', bind: {} }];
    });
    out.realPaths = { ...out.realPaths, [folder]: folder };
    useCompose(h, out);
  }

  /** The arguments after `sh -c <script> sh` of the ownership fixes of the repository folder with `docker exec`. */
  function fixArguments(): string[][] {
    return h.docker.execs
      .filter((e) => e.user === 'root' && e.command[0] === 'sh' && e.command[2].includes('chown') && e.command[4] === FOLDER)
      .map((e) => e.command.slice(4));
  }

  async function record(folders: string[]): Promise<void> {
    await h.registry.updateDevspace(ENV_ID, (entry) => {
      entry.serviceFolders = folders;
    });
  }

  function stopAll(): void {
    h.docker.containersOf(ENV_ID).forEach((container) => (container.state = 'stopped'));
  }

  it('keeps a folder of an earlier model while it exists, after the containers of the services were removed', async () => {
    // The db container of the earlier model (./pgdata) was removed while it was stopped (`docker container prune`).
    await seedCompose({ dev: 'stopped', db: null });
    await record([PGDATA]);
    withModelFolder(DATA);
    await h.service.openDevspace(ENV_ID, { ...options(), forceRebuild: true });
    // Not [DATA] alone: no container of another service existed before `up`, but the data of Postgres in ./pgdata stays
    // in the record, so the fix after `up` leaves it alone and Delete names it.
    expect((await h.registry.get(ENV_ID))?.serviceFolders).toEqual([DATA, PGDATA]);
    expect(fixArguments()).toEqual([[FOLDER, 'vscode', ...servicePathArguments(FOLDER, [DATA, PGDATA])]]);
    expect(await h.service.repositoryServiceData(ENV_ID)).toEqual(['./data/pg', './pgdata']);
    // Once ./pgdata is gone from the volume, the next `up` drops it.
    h.docker.missingPaths.add(PGDATA);
    stopAll();
    await h.service.openDevspace(ENV_ID, options());
    expect((await h.registry.get(ENV_ID))?.serviceFolders).toEqual([DATA]);
    expect(await h.service.repositoryServiceData(ENV_ID)).toEqual(['./data/pg']);
    // The check ran as root in the dev container, with the recorded paths that nothing else names.
    const checks = h.docker.execs.filter((e) => e.command[2] === EXISTING_PATHS_SCRIPT);
    expect(checks.map((e) => [e.user, e.command.slice(4)])).toEqual([
      ['root', [PGDATA]],
      ['root', [PGDATA]],
    ]);
  });

  it('keeps the recorded folders when the configuration became a single container, while they exist', async () => {
    await seedCompose({ dev: 'stopped', db: 'stopped' });
    await record([PGDATA]);
    h.docker.networks.set(`${PROJECT}_default`, COMPOSE_LABELS);
    h.docker.images.add(`${PROJECT}-app`);
    // As Compose builds it (build.labels), so that the rebuild removes it.
    h.docker.imageConfigs.set(`${PROJECT}-app`, { User: '', Labels: { [LABEL_DEVSPACE_ID]: ENV_ID } });
    h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: DEFAULT_CONFIG_TEXT } };
    h.ui.configurationChangedAnswer = 'rebuildNow';
    await h.service.openDevspace(ENV_ID, options());
    expect(h.docker.containersOf(ENV_ID)).toHaveLength(1);
    // Not cleared (no container of another service is left), as the data of Postgres is still in ./pgdata.
    expect((await h.registry.get(ENV_ID))?.serviceFolders).toEqual([PGDATA]);
    expect(await h.service.repositoryServiceData(ENV_ID)).toEqual(['./pgdata']);
    h.docker.missingPaths.add(PGDATA);
    stopAll();
    await h.service.openDevspace(ENV_ID, options());
    expect((await h.registry.get(ENV_ID))?.serviceFolders).toBeUndefined();
  });

  it('keeps the recorded list when the containers cannot be read after up (never shrinks on an error)', async () => {
    await seedCompose({ dev: 'stopped', db: null });
    await record([PGDATA]);
    h.docker.missingPaths.add(PGDATA);
    withModelFolder(DATA);
    const up = h.helper.up.bind(h.helper);
    const list = h.docker.listProjectContainers.bind(h.docker);
    let broken = false;
    h.helper.up = async (p) => {
      const result = await up(p);
      broken = true;
      return result;
    };
    h.docker.listProjectContainers = async (project: string) => {
      if (broken) throw new CommandError('docker ps', 1, '', 'Cannot connect to the Docker daemon');
      return list(project);
    };
    await h.service.openDevspace(ENV_ID, { ...options(), forceRebuild: true });
    expect((await h.registry.get(ENV_ID))?.serviceFolders).toEqual([DATA, PGDATA]);
    expect(h.docker.execs.filter((e) => e.command[2] === EXISTING_PATHS_SCRIPT)).toEqual([]);
    // Delete too.
    expect(await h.service.repositoryServiceData(ENV_ID)).toEqual(['./data/pg', './pgdata']);
  });

  // The question of Delete stays.
  it('the question of Delete of a restored entry names the folder that the running db mounts', async () => {
    // An entry without a record (restored from its volumes), and a db container that mounts ./data/pg, as Docker
    // inspects it (HostConfig.Mounts with VolumeOptions.Subpath).
    await seedDevspace(h, {
      container: 'running',
      record: null,
      containerLabels: { [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION), ...COMPOSE_LABELS, 'com.docker.compose.service': 'app' },
    });
    h.docker.addContainer({
      devspaceId: ENV_ID,
      name: `${PROJECT}-db-1`,
      state: 'running',
      image: DB_IMAGE,
      labels: { [LABEL_COMPOSE_SERVICE]: 'db', ...COMPOSE_LABELS, 'com.docker.compose.service': 'db' },
      volumeSubpaths: [
        { volume: NAME, subpath: 'api/data/pg', readOnly: false },
        // Not a path of the services: read-only, another volume, outside of the repository, .git.
        { volume: NAME, subpath: 'api/init.sql', readOnly: true },
        { volume: 'other-volume', subpath: 'api/x', readOnly: false },
        { volume: NAME, subpath: 'other/x', readOnly: false },
        { volume: NAME, subpath: 'api/.git', readOnly: false },
      ],
    });
    expect((await h.registry.get(ENV_ID))?.serviceFolders).toBeUndefined();
    expect(await h.service.repositoryServiceData(ENV_ID)).toEqual(['./data/pg']);
  });

  it('fills the paths of a restored entry from the mounts of the containers that it finds', async () => {
    h.docker.volumes.set(NAME, { [LABEL_DEVSPACE_ID]: ENV_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id });
    h.docker.addContainer({
      devspaceId: ENV_ID,
      name: NAME,
      state: 'stopped',
      image: IMAGE_1,
      labels: { [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION), ...COMPOSE_LABELS, 'com.docker.compose.service': 'app' },
    });
    h.docker.addContainer({
      devspaceId: ENV_ID,
      name: `${PROJECT}-db-1`,
      state: 'stopped',
      image: DB_IMAGE,
      labels: { [LABEL_COMPOSE_SERVICE]: 'db', ...COMPOSE_LABELS, 'com.docker.compose.service': 'db' },
      volumeSubpaths: [{ volume: NAME, subpath: 'api/data/pg', readOnly: false }],
    });
    expect(await h.service.reconcileFromVolumes()).toBe(1);
    // The restore records the list at once, so the ownership fixes leave the folder out before the next `up`.
    expect((await h.registry.get(ENV_ID))?.serviceFolders).toEqual([DATA]);
  });

  it(`records at most ${MAX_SERVICE_FOLDERS} paths, and changes only the files of root beyond them`, async () => {
    // For example ./data/${HOSTNAME}: a new path at each open, and the folders of the earlier runs still exist.
    await seedCompose({ dev: 'stopped', db: null });
    const earlier = Array.from({ length: MAX_SERVICE_FOLDERS }, (_, i) => `${FOLDER}/data/host-${i}`);
    await record(earlier);
    withModelFolder(DATA);
    await h.service.openDevspace(ENV_ID, { ...options(), forceRebuild: true });
    const entry = await h.registry.get(ENV_ID);
    // Bounded: not one more path at each open.
    expect(entry?.serviceFolders).toHaveLength(MAX_SERVICE_FOLDERS);
    expect(entry?.serviceFolders?.[0]).toBe(DATA);
    expect(entry?.serviceFoldersOverflow).toBe(true);
    expect(fixArguments()).toEqual([[FOLDER, 'vscode', '-path', FOLDER, '-o', '-path', `${FOLDER}/*`]]);
    expect(h.logger.warnings.some((line) => line.includes(`More than ${MAX_SERVICE_FOLDERS} paths of ${REPO}`))).toBe(true);
    // The existence check of the recorded paths goes in calls of a bounded command line.
    const checks = h.docker.execs.filter((e) => e.command[2] === EXISTING_PATHS_SCRIPT);
    expect(checks.length).toBeGreaterThan(1);
    // The record before `up` held DATA and the first 999 earlier paths.
    expect(checks.flatMap((e) => e.command.slice(4))).toHaveLength(MAX_SERVICE_FOLDERS - 1);
  });
});

describe('the ownership fix in the dev container leaves its other mounts below the repository alone', () => {
  const PGDATA = `${FOLDER}/.pgdata`;

  /** The arguments after `sh -c <script> sh` of the ownership fixes of the repository folder with `docker exec`. */
  function fixArguments(): string[][] {
    return h.docker.execs
      .filter((e) => e.user === 'root' && e.command[0] === 'sh' && e.command[2].includes('chown') && e.command[4] === FOLDER)
      .map((e) => e.command.slice(4));
  }

  it('protects the target of a volume that the dev service shares with db, without recording it', async () => {
    // pgdata:/workspaces/api/.pgdata in the dev service, pgdata:/var/lib/postgresql/data in db: one local volume, on the
    // file system of the workspace volume, so `find -xdev` goes into it.
    useCompose(
      h,
      output((m) => {
        m.services.app.volumes = [...(m.services.app.volumes as unknown[]), { type: 'volume', source: 'pgdata', target: `${PGDATA}/`, volume: {} }];
      }),
    );
    await h.service.open(TARGET, options());
    // Not [FOLDER, 'vscode'] alone: that would give the files of Postgres (uid 999) in the volume to vscode. The
    // targets of the mounts of the dev container are marked one by one (DevMountPaths).
    expect(fixArguments()).toEqual([[FOLDER, 'vscode', ...servicePathArguments(FOLDER, [PGDATA], new Set([PGDATA]))]]);
    // Not a path of the workspace volume: neither recorded nor named for Delete.
    expect((await h.registry.get(ENV_ID))?.serviceFolders).toBeUndefined();
    expect(await h.service.repositoryServiceData(ENV_ID)).toEqual([]);
  });

  it('adds the mounts of devcontainer.json (read with docker inspect) after the paths of the services, and falls back to the whole repository when the container cannot be read', async () => {
    h.helper.containerMounts = [
      { type: 'volume', volume: 'api-node_modules', target: `${FOLDER}/node_modules` },
      { type: 'tmpfs', target: `${FOLDER}/tmp` },
      { type: 'bind', target: '/home/vscode/.ssh' },
    ];
    await h.service.open(TARGET, options());
    // The targets of the mounts of the dev container are marked one by one (DevMountPaths).
    expect(fixArguments()).toEqual([[FOLDER, 'vscode', ...servicePathArguments(FOLDER, [`${FOLDER}/node_modules`, `${FOLDER}/tmp`], new Set([`${FOLDER}/node_modules`, `${FOLDER}/tmp`]))]]);

    h.cleanup();
    h = createHarness({ newDevspaceId: () => ENV_ID });
    useCompose(h);
    // The inspect after `up` fails.
    const find = h.docker.findContainer.bind(h.docker);
    h.docker.findContainer = async (id: string, name: string) => {
      if (h.helper.ups.length > 0) throw new Error('Cannot connect to the Docker daemon');
      return find(id, name);
    };
    await h.service.open(TARGET, options());
    expect(fixArguments()).toEqual([[FOLDER, 'vscode', ...servicePathArguments(FOLDER, 'repository')]]);
  });
  it('protects an alias of the workspace volume below the repository that the dev service mounts', async () => {
    // ./data:/workspaces/api/pgview in the dev service, ./data:/var/lib/postgresql/data in db.
    const DATA = `${FOLDER}/data`;
    const PGVIEW = `${FOLDER}/pgview`;
    const out = output((m) => {
      m.services.db.volumes = [{ type: 'bind', source: DATA, target: '/var/lib/postgresql/data', bind: {} }];
      m.services.app.volumes = [...(m.services.app.volumes as unknown[]), { type: 'bind', source: DATA, target: PGVIEW, bind: {} }];
    });
    out.realPaths = { ...out.realPaths, [DATA]: DATA };
    useCompose(h, out);
    await h.service.open(TARGET, options());
    const upApp = upModel().services.app.volumes as Array<{ type: string; source?: string; target: string }>;
    // The pipeline rewrote the bind to the workspace volume (a subpath of it).
    expect(upApp.find((entry) => entry.target === PGVIEW)).toMatchObject({ type: 'volume', source: WORKSPACE_VOLUME_KEY });
    // Not [DATA] alone: `find -xdev` would give the files of db (uid 999) to vscode through pgview. The targets of the
    // mounts of the dev container are marked one by one (DevMountPaths).
    expect(fixArguments()).toEqual([[FOLDER, 'vscode', ...servicePathArguments(FOLDER, [DATA, PGVIEW], new Set([PGVIEW]))]]);
    // Not recorded: it matters only in the dev container.
    expect((await h.registry.get(ENV_ID))?.serviceFolders).toEqual([DATA]);
  });

  it('gives a mount of the workspace volume at its own canonical path the full fix', async () => {
    // ..:/workspaces/api and ../src:/workspaces/api/src in the dev service: the subpaths api and api/src of the workspace
    // volume, each at its own path. src is no alias: after a change of the uid of the remote user, its files of the
    // old uid must get the new one.
    const SRC = `${FOLDER}/src`;
    const out = output((m) => {
      m.services.app.volumes = [
        ...(m.services.app.volumes as unknown[]),
        { type: 'bind', source: FOLDER, target: FOLDER, bind: {} },
        { type: 'bind', source: SRC, target: SRC, bind: {} },
      ];
    });
    out.realPaths = { ...out.realPaths, [FOLDER]: FOLDER, [SRC]: SRC };
    useCompose(h, out);
    await h.service.open(TARGET, options());
    const upApp = upModel().services.app.volumes as Array<{ type: string; target: string; volume?: { subpath?: string } }>;
    expect(upApp.find((entry) => entry.target === SRC)).toMatchObject({ type: 'volume', volume: { subpath: 'api/src' } });
    // Not [SRC]: then only the files of root in src would get the remote user.
    expect(fixArguments()).toEqual([[FOLDER, 'vscode']]);
  });

  it('keeps a mount of the workspace volume at its own path protected when the mounts of the container cannot be read', async () => {
    const SRC = `${FOLDER}/src`;
    const out = output((m) => {
      m.services.app.volumes = [...(m.services.app.volumes as unknown[]), { type: 'bind', source: SRC, target: SRC, bind: {} }];
    });
    out.realPaths = { ...out.realPaths, [SRC]: SRC };
    useCompose(h, out);
    h.docker.execHandler = (_container, command) => (command[0] === 'cat' ? { exitCode: 1, stderr: 'cat: not found' } : {});
    await h.service.open(TARGET, options());
    expect(h.docker.execs.filter((e) => e.command[0] === 'cat').map((e) => [e.command, e.user])).toEqual([[['cat', '/proc/self/mountinfo'], 'root']]);
    // The targets of the mounts of the dev container are marked one by one (DevMountPaths).
    expect(fixArguments()).toEqual([[FOLDER, 'vscode', ...servicePathArguments(FOLDER, [SRC], new Set([SRC]))]]);
  });

  it('keeps a mount of the workspace volume protected when a link in the volume makes it another folder', async () => {
    // ../src:/workspaces/api/src, but src is a link to data in the volume (db mounts ./data): Docker mounts data there.
    const SRC = `${FOLDER}/src`;
    const out = output((m) => {
      m.services.app.volumes = [...(m.services.app.volumes as unknown[]), { type: 'bind', source: SRC, target: SRC, bind: {} }];
    });
    out.realPaths = { ...out.realPaths, [SRC]: SRC };
    useCompose(h, out);
    h.docker.volumeLinks.set('api/src', 'api/data');
    await h.service.open(TARGET, options());
    // The targets of the mounts of the dev container are marked one by one (DevMountPaths).
    expect(fixArguments()).toEqual([[FOLDER, 'vscode', ...servicePathArguments(FOLDER, [SRC], new Set([SRC]))]]);
  });

  it('gives an anonymous volume of the dev container the full fix, and keeps a named volume protected', async () => {
    // An anonymous `node_modules` volume (Docker names it with 64 hexadecimal characters), whose image content is of uid
    // 1000, and a named cache volume.
    h.helper.containerMounts = [
      { type: 'volume', volume: 'c'.repeat(64), target: `${FOLDER}/node_modules` },
      { type: 'volume', volume: 'api-cache', target: `${FOLDER}/.cache` },
    ];
    await h.service.open(TARGET, options());
    // The targets of the mounts of the dev container are marked one by one (DevMountPaths): here .cache only.
    expect(fixArguments()).toEqual([[FOLDER, 'vscode', ...servicePathArguments(FOLDER, [`${FOLDER}/.cache`], new Set([`${FOLDER}/.cache`]))]]);
  });

  it('keeps an anonymous volume protected when the host access checks are off', async () => {
    h.settings = { ...h.settings, hostAccessChecksOff: [REPO] };
    h.helper.containerMounts = [{ type: 'volume', volume: 'c'.repeat(64), target: `${FOLDER}/node_modules` }];
    await h.service.open(TARGET, options());
    // The targets of the mounts of the dev container are marked one by one (DevMountPaths).
    expect(fixArguments()).toEqual([[FOLDER, 'vscode', ...servicePathArguments(FOLDER, [`${FOLDER}/node_modules`], new Set([`${FOLDER}/node_modules`]))]]);
  });
});

describe('the `mounts` of a Compose configuration as the Dev Container CLI writes them', () => {
  const REWRITTEN = (mount: unknown) => `mount ${JSON.stringify(mount)} is written differently by the Dev Container CLI and is not supported`;

  it('refuses a tmpfs mount with a source in devcontainer.json before any build, also with the checks off', async () => {
    h.settings = { ...h.settings, hostAccessChecksOff: [REPO] };
    h.helper.files = {
      [DEFAULT_CONFIG_PATH]: { configText: CONFIG_TEXT.replace('"source=cache,target=/cache,type=volume"', '"type=tmpfs,src=/,dst=/host"') },
    };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toContain(REWRITTEN('type=tmpfs,src=/,dst=/host'));
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.ups).toEqual([]);
  });

  it('refuses a Feature that mounts the Docker socket as tmpfs before up (image metadata)', async () => {
    const mount = { type: 'tmpfs', source: '/var/run/docker.sock', target: '/var/run/docker.sock' };
    h.helper.buildMetadata = [{ id: 'ghcr.io/acme/features/sock:1', mounts: [mount] }];
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toContain(REWRITTEN(mount));
    expect(h.helper.ups).toEqual([]);
    expect(devContainer()).toBeUndefined();
  });

  it('refuses a volume at the internal folder by the target that the CLI cuts at the second `=`', async () => {
    h.helper.files = {
      [DEFAULT_CONFIG_PATH]: {
        configText: CONFIG_TEXT.replace('"source=cache,target=/cache,type=volume"', '"type=volume,src=foo,dst=/workspaces/.devspace+=x"'),
      },
    };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toContain(REWRITTEN('type=volume,src=foo,dst=/workspaces/.devspace+=x'));
    expect(h.helper.builds).toEqual([]);
  });

  it('still opens the usual named volume of `mounts` and a docker-in-docker Feature', async () => {
    h.helper.buildMetadata = [
      { id: 'ghcr.io/devcontainers/features/docker-in-docker:2', mounts: [{ source: 'dind-var-lib-docker-${devcontainerId}', target: '/var/lib/docker', type: 'volume' }] },
    ];
    await h.service.open(TARGET, options());
    expect(h.helper.ups).toHaveLength(1);
  });

  it('checks the label with the variables of the CLI substituted, as for a single container', async () => {
    h.helper.buildMetadata = [
      {
        id: 'ghcr.io/acme/features/cache:1',
        mounts: ['source=${localWorkspaceFolderBasename}-node_modules,target=${containerWorkspaceFolder}/node_modules,type=volume'],
      },
    ];
    await h.service.open(TARGET, options());
    expect(h.helper.ups).toHaveLength(1);
  });

  it('refuses a variable of the label that is left after the substitution as one that cannot be checked, not as written differently', async () => {
    const mount = 'source=${localEnv:TERM}-x,target=/x,type=volume';
    h.helper.buildMetadata = [{ id: 'ghcr.io/acme/features/term:1', mounts: [mount] }];
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toContain(`mount ${JSON.stringify(mount)} uses \${localEnv:TERM}, which cannot be checked`);
    expect(error.message).not.toContain(REWRITTEN(mount));
    expect(h.helper.ups).toEqual([]);
  });
});

describe('the ownership fixes after up', () => {
  // The first opens of this group create the devspace, so its names carry the word of the source.
  const NAME = FIRST_OPEN_NAME;
  const CONFIG = '/workspaces/.devspace+';

  /** The execs in the dev container that walk a folder with an ownership fix: [folder, user, …]. */
  function devFixes(): string[][] {
    return h.docker.execs.filter((e) => e.command[2] === OWNERSHIP_FIX_SCRIPT).map((e) => e.command.slice(4));
  }

  it('fixes the internal folder in a helper container with the numeric IDs of the remote user, not in the dev container', async () => {
    // A mount of the dev container through a link of the repository (x -> ../.devspace+) would lie in the internal folder
    // in the dev container; the helper mounts only the workspace volume.
    h.helper.containerMounts = [{ type: 'volume', volume: `${PROJECT}_pgdata`, target: `${FOLDER}/x` }];
    await h.service.open(TARGET, options());
    expect(devFixes().map((args) => args[0])).toEqual([FOLDER]);
    expect(devFixes().some((args) => args[0] === CONFIG)).toBe(false);
    const ids = h.docker.execs.filter((e) => e.command[0] === 'id');
    expect(ids.map((e) => [e.command, e.user])).toEqual([
      [['id', '-u', 'vscode'], 'root'],
      [['id', '-g', 'vscode'], 'root'],
    ]);
    expect(h.helper.configOwnershipFixes).toEqual([{ volumeName: NAME, folder: CONFIG, uid: '1000', gid: '1000' }]);
  });

  it('skips the fix of the internal folder and logs it when the IDs are not numbers', async () => {
    h.docker.execHandler = (_container, command) => (command[0] === 'id' && command[1] === '-g' ? { stdout: '1000 staff\n' } : {});
    await h.service.open(TARGET, options());
    expect(h.helper.configOwnershipFixes).toEqual([]);
    expect(h.logger.warnings.some((line) => line.includes(`The owner of the files in ${CONFIG} could not be changed`) && line.includes('id -g vscode'))).toBe(true);
    expect(devFixes().some((args) => args[0] === CONFIG)).toBe(false);
  });

  it('logs a failed fix of the internal folder, and the open goes on', async () => {
    h.helper.configOwnershipResult = { exitCode: 1, stderr: `${CONFIG} is not a folder.` };
    const result = await h.service.open(TARGET, options());
    expect(result.containerName).toBe(NAME);
    expect(h.logger.warnings).toContain(`The owner of the files in ${CONFIG} could not be changed: ${CONFIG} is not a folder.`);
  });

  it('leaves a volume that the dev container mounts in .git to its owners, and the rest of .git gets the full fix', async () => {
    h.helper.containerMounts = [{ type: 'volume', volume: `${PROJECT}_pgdata`, target: `${FOLDER}/.git/pg` }];
    await h.service.open(TARGET, options());
    // Not [FOLDER, 'vscode'] alone (a filter of .git would drop the target), which would give the data of db to vscode.
    // The targets of the mounts of the dev container are marked one by one (DevMountPaths).
    expect(devFixes()).toEqual([[FOLDER, 'vscode', ...servicePathArguments(FOLDER, [`${FOLDER}/.git/pg`], new Set([`${FOLDER}/.git/pg`]))]]);
    expect(servicePathArguments(FOLDER, [`${FOLDER}/.git/pg`], true)).toEqual(['(', '-path', `${FOLDER}/.git/pg`, '-o', '-path', `${FOLDER}/.git/pg/*`, ')']);
  });
});

describe('the stage that the Dev Container CLI writes into its compose file for the build', () => {
  it('refuses a build target of the dev service with a line break before any build', async () => {
    useCompose(
      h,
      output((m) => {
        m.services.app = { build: { context: `${FOLDER}/.devcontainer`, dockerfile: 'Dockerfile', target: 'base\n      ssh:\n        - default' }, command: ['sleep', 'infinity'] };
      }),
    );
    const out = h.helper.composeOutput as ComposeModelOutput;
    h.helper.composeOutput = {
      ...out,
      dockerfiles: { app: 'FROM alpine AS base\n' },
      realPaths: { ...out.realPaths, [`${FOLDER}/.devcontainer`]: `${FOLDER}/.devcontainer`, [`${FOLDER}/.devcontainer/Dockerfile`]: `${FOLDER}/.devcontainer/Dockerfile` },
    };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toContain('service app: build target');
    expect(h.helper.builds).toEqual([]);
  });
});

describe('values that the Dev Container CLI writes as text into its compose file for up', () => {
  it('refuses a containerUser of the image metadata with a line break before up, also with the checks off', async () => {
    h.settings = { ...h.settings, hostAccessChecksOff: [REPO] };
    const user = 'root\n    privileged: true';
    h.helper.buildMetadata = [{ id: 'ghcr.io/acme/features/user:1', containerUser: user, entrypoint: '/x.sh"]\n    privileged: true\n    x-a: ["' }];
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toContain(`containerUser ${JSON.stringify(user)}`);
    expect(h.helper.ups).toEqual([]);
  });

  it('refuses a containerEnv name of devcontainer.json that is no plain name before any build', async () => {
    h.helper.files = {
      [DEFAULT_CONFIG_PATH]: { configText: CONFIG_TEXT.replace('"remoteUser": "vscode",', `"remoteUser": "vscode", "containerEnv": { "A'": "1" },`) },
    };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toContain(`containerEnv variable "A'"`);
    expect(h.helper.builds).toEqual([]);
  });

  it('still opens with the usual values', async () => {
    h.helper.buildMetadata = [{ id: 'ghcr.io/devcontainers/features/docker-in-docker:2', entrypoint: '/usr/local/share/docker-init.sh', containerEnv: { DOCKER_BUILDKIT: '1' } }, { containerUser: 'vscode' }];
    await h.service.open(TARGET, options());
    expect(h.helper.ups).toHaveLength(1);
  });
});

describe('volumes of `mounts` with variables of the Dev Container CLI', () => {
  // `${devcontainerId}` of the devspace, as the CLI computes it from `--id-label` (checked against the CLI's own
  // function in cliVariables.test.ts).
  const ID = devspaceDevcontainerId(ENV_ID);
  const COMPOSE_KEY = /^[a-zA-Z0-9._-]+$/;
  const DIND = `dind-var-lib-docker-${ID}`;
  const labels = { [LABEL_DEVSPACE_ID]: ENV_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id };

  function buildModel(index = -1): ComposeModel {
    return JSON.parse(h.helper.builds.at(index)?.files?.[COMPOSE_MODEL_PATH] ?? 'null') as ComposeModel;
  }

  function useMetadataMounts(): void {
    h.helper.buildMetadata = [
      { id: 'ghcr.io/devcontainers/features/docker-in-docker:2', mounts: [{ source: 'dind-var-lib-docker-${devcontainerId}', target: '/var/lib/docker', type: 'volume' }] },
      { id: 'ghcr.io/acme/features/cache:1', mounts: ['source=${localWorkspaceFolderBasename}-node_modules,target=/nm,type=volume'] },
    ];
  }

  it('declares the volumes of the image metadata in the up model by the names that the CLI writes', async () => {
    useMetadataMounts();
    await h.service.open(TARGET, options());
    const volumes = upModel().volumes ?? {};
    expect(Object.keys(volumes).filter((key) => !COMPOSE_KEY.test(key))).toEqual([]);
    expect(volumes).toMatchObject({
      [DIND]: { name: `${PROJECT}_${DIND}`, external: true },
      'api-node_modules': { name: `${PROJECT}_api-node_modules`, external: true },
    });
    expect(ID).toMatch(/^[0-9a-v]{52}$/);
    // Never the placeholder of the checks: the CLI writes the real ID.
    expect(JSON.stringify(upModel())).not.toContain(DEVCONTAINER_ID_PLACEHOLDER);
    expect([...h.docker.volumes.keys()].filter((name) => name.includes(DEVCONTAINER_ID_PLACEHOLDER))).toEqual([]);
  });

  it('creates, records, and lists the volume of the docker-in-docker Feature like the other volumes of the project, and Delete removes it when ticked', async () => {
    useMetadataMounts();
    await h.service.open(TARGET, options());
    expect(h.docker.volumes.get(`${PROJECT}_${DIND}`)).toEqual({ ...labels, [LABEL_VOLUME]: VOLUME_KIND_COMPOSE });
    expect(h.docker.volumes.get(`${PROJECT}_api-node_modules`)).toEqual({ ...labels, [LABEL_VOLUME]: VOLUME_KIND_COMPOSE });
    expect((await h.registry.get(ENV_ID))?.additionalVolumes).toEqual(expect.arrayContaining([`${PROJECT}_${DIND}`, `${PROJECT}_api-node_modules`]));
    // The one read of the removable volumes (removableVolumesOf).
    expect((await h.service.removableVolumesOf(ENV_ID)).serviceData).toEqual(expect.arrayContaining([`${PROJECT}_${DIND}`, `${PROJECT}_api-node_modules`]));
    await h.service.delete(ENV_ID, { ...options(), additionalVolumesToRemove: [`${PROJECT}_${DIND}`] });
    expect(h.docker.volumes.has(`${PROJECT}_${DIND}`)).toBe(false);
    expect(h.docker.volumes.has(`${PROJECT}_api-node_modules`)).toBe(true);
  });

  it('declares a `${devcontainerId}` volume of devcontainer.json in the build model with the real ID', async () => {
    // read-configuration leaves `${devcontainerId}` as written while no container exists.
    h.helper.files = {
      [DEFAULT_CONFIG_PATH]: { configText: CONFIG_TEXT.replace('"source=cache,target=/cache,type=volume"', '"source=hist-${devcontainerId},target=/hist,type=volume"') },
    };
    await h.service.open(TARGET, options());
    for (const m of [buildModel(), upModel()]) {
      const volumes = m.volumes ?? {};
      expect(Object.keys(volumes).filter((key) => !COMPOSE_KEY.test(key))).toEqual([]);
      expect(volumes).toMatchObject({ [`hist-${ID}`]: { name: `${PROJECT}_hist-${ID}`, external: true } });
      expect(JSON.stringify(m)).not.toContain(DEVCONTAINER_ID_PLACEHOLDER);
    }
    expect(h.docker.volumes.get(`${PROJECT}_hist-${ID}`)).toEqual({ ...labels, [LABEL_VOLUME]: VOLUME_KIND_COMPOSE });
  });
});

describe('the build of the dev service and the size of a refusal', () => {
  const DEV_IMAGE = 'mcr.microsoft.com/devcontainers/python:3.12';
  const PRIVATE_IMAGE = 'registry.corp.example/prod/base:1';

  /** The dev service builds `dockerfile` with `build` (target, args) from .devcontainer. */
  function useDevBuild(dockerfile: string, build: Record<string, unknown> = {}): void {
    useCompose(
      h,
      output((m) => {
        m.services.app = { build: { context: `${FOLDER}/.devcontainer`, dockerfile: 'Dockerfile', ...build }, command: ['sleep', 'infinity'] };
      }),
    );
    const out = h.helper.composeOutput as ComposeModelOutput;
    h.helper.composeOutput = {
      ...out,
      dockerfiles: { app: dockerfile },
      realPaths: { ...out.realPaths, [`${FOLDER}/.devcontainer`]: `${FOLDER}/.devcontainer`, [`${FOLDER}/.devcontainer/Dockerfile`]: `${FOLDER}/.devcontainer/Dockerfile` },
    };
    h.checker.outcome = checked({ [DEV_IMAGE]: DIGEST_NEW, [DB_IMAGE]: DB_DIGEST }, { [FEATURE]: FEATURE_DIGEST });
  }

  it('pulls and inspects only the image of the target chain; later stages (a private image, an unresolved tag) are neither pulled nor refused', async () => {
    useDevBuild(`FROM ${DEV_IMAGE} AS dev\nRUN true\nFROM ${PRIVATE_IMAGE} AS prod\nFROM registry.example/app\${TAG} AS release\n`, { target: 'dev' });
    h.docker.pullError = (reference) => (reference === PRIVATE_IMAGE ? new CommandError(`docker pull ${reference}`, 1, '', 'denied') : undefined);
    await h.service.open(TARGET, options());
    expect(h.docker.log).toContain(`pull ${DEV_IMAGE}`);
    expect(h.docker.log.filter((line) => line.includes(PRIVATE_IMAGE) || line.includes('registry.example/app'))).toEqual([]);
    expect(h.helper.builds).toHaveLength(1);
    expect(h.helper.ups).toHaveLength(1);
  });

  it('opens with a multi-line CA certificate build argument and USER $USERNAME, with and without Features', async () => {
    const dockerfile = `FROM ${DEV_IMAGE}\nARG USERNAME=vscode\nARG EXTRA_CA_CERT\nRUN echo "$EXTRA_CA_CERT" > /x.crt\nUSER $USERNAME\n`;
    const args = { USERNAME: 'vscode', EXTRA_CA_CERT: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----' };
    for (const features of [true, false]) {
      h.cleanup();
      h = createHarness({ newDevspaceId: () => ENV_ID });
      useDevBuild(dockerfile, { args });
      if (!features) h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: CONFIG_TEXT.replace(`"features": { "${FEATURE}": {} },`, '') } };
      await h.service.open(TARGET, options());
      expect(h.helper.builds, String(features)).toHaveLength(1);
    }
  });

  it('a refusal of hundreds of services lists at most MAX_LISTED_ITEMS items of at most MAX_ITEM_LENGTH characters', async () => {
    useCompose(
      h,
      output((m) => {
        for (let i = 0; i < 300; i++) m.services[`s${i}`] = { image: DB_IMAGE, privileged: true, [`zz${'k'.repeat(1000)}${i}`]: 1 };
      }),
    );
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    const items = (error as UserFacingError & { items: readonly string[] }).items;
    const report = (error as UserFacingError & { report: { hostAccess: string[]; unsupported: string[] } }).report;
    for (const list of [report.hostAccess, report.unsupported]) {
      expect(list.length).toBeLessThanOrEqual(MAX_LISTED_ITEMS + 1);
      // MAX_ITEM_LENGTH characters of the item and the `…` in their middle (truncated, as in hostAccess.longItems.test.ts).
      for (const item of list) expect(item.length, item).toBeLessThanOrEqual(MAX_ITEM_LENGTH + 1);
    }
    expect(report.unsupported.at(-1)).toMatch(/^and \d+ more$/);
    expect(items.length).toBeLessThanOrEqual(2 * (MAX_LISTED_ITEMS + 1));
    expect(error.message.length).toBeLessThan(20_000);
  });
});

describe('`${localEnv:COMPOSE_PROJECT_NAME}` in the mounts of the image metadata', () => {
  it('declares, creates, and records the volume of the image metadata by the name that the CLI writes (the project name of the devspace)', async () => {
    // The CLI substitutes the metadata at `up`, in the helper that has COMPOSE_PROJECT_NAME (read-configuration has
    // already substituted devcontainer.json).
    h.helper.buildMetadata = [{ id: 'ghcr.io/acme/features/cache:1', mounts: ['source=cache${localEnv:COMPOSE_PROJECT_NAME},target=/c,type=volume'] }];
    await h.service.open(TARGET, options());
    const key = `cache${PROJECT}`;
    expect(upModel().volumes ?? {}).toMatchObject({ [key]: { name: `${PROJECT}_${key}`, external: true } });
    expect(h.docker.volumes.get(`${PROJECT}_${key}`)).toEqual({
      [LABEL_DEVSPACE_ID]: ENV_ID,
      [LABEL_REPOSITORY]: REPO,
      [LABEL_OWNER_ID]: ACCOUNT.id,
      [LABEL_VOLUME]: VOLUME_KIND_COMPOSE,
    });
    expect((await h.registry.get(ENV_ID))?.additionalVolumes).toContain(`${PROJECT}_${key}`);
  });
});

describe('`${localEnv:COMPOSE_PROJECT_NAME}` in the mounts of devcontainer.json', () => {
  const MOUNTS_TEXT = CONFIG_TEXT.replace('"source=cache,', '"source=cache${localEnv:COMPOSE_PROJECT_NAME},');

  /** As the CLI: read-configuration substitutes `${localEnv:…}` with the environment of the helper process. */
  function substitutingReads(withMerged: boolean): void {
    h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: MOUNTS_TEXT } };
    const helper = h.helper as unknown as {
      readConfiguration: (p: { volumeName: string; configPath: string; merged?: boolean; env?: Record<string, string> }) => Promise<unknown>;
      readConfigurations: Array<Record<string, unknown>>;
      mount(volume: string): void;
    };
    helper.readConfiguration = async (p) => {
      helper.mount(p.volumeName);
      helper.readConfigurations.push({ configPath: p.configPath, ...(p.merged !== undefined ? { merged: p.merged } : {}), ...(p.env !== undefined ? { env: p.env } : {}) });
      const config = parseJsonc<Record<string, unknown>>(MOUNTS_TEXT.replace('${localEnv:COMPOSE_PROJECT_NAME}', p.env?.COMPOSE_PROJECT_NAME ?? ''));
      return p.merged === false || !withMerged ? { config } : { config, merged: { ...config } };
    };
  }

  for (const withMerged of [true, false]) {
    it(`declares, creates, and records only the volume that the CLI uses (${withMerged ? 'with' : 'without'} the merged configuration)`, async () => {
      substitutingReads(withMerged);
      await h.service.open(TARGET, options());
      const real = `${PROJECT}_cache${PROJECT}`;
      expect(h.docker.volumes.has(real)).toBe(true);
      expect(h.docker.volumes.has(`${PROJECT}_cache`)).toBe(false);
      const additional = (await h.registry.get(ENV_ID))?.additionalVolumes ?? [];
      expect(additional).toContain(real);
      expect(additional).not.toContain(`${PROJECT}_cache`);
      expect(Object.keys(upModel().volumes ?? {})).not.toContain('cache');
      expect(h.helper.readConfigurations.every((read) => (read.env as Record<string, string> | undefined)?.COMPOSE_PROJECT_NAME === PROJECT)).toBe(true);
    });
  }
});

describe('the checked Dockerfile of the dev service', () => {
  const BASE = 'FROM mcr.microsoft.com/devcontainers/base:bookworm AS base\n';

  /** The dev service builds `dockerfile` (a file of the repository whose name has a $) with `build`. */
  function useDevBuild(dockerfile: string, build: Record<string, unknown> = {}, extra: Partial<ComposeModelOutput> = {}): void {
    useCompose(
      h,
      output((m) => {
        m.services.app = { build: { context: `${FOLDER}/.devcontainer`, dockerfile: `${FOLDER}/.devcontainer/D$x`, ...build }, command: ['sleep', 'infinity'] };
      }),
    );
    const out = h.helper.composeOutput as ComposeModelOutput;
    h.helper.composeOutput = {
      ...out,
      dockerfiles: { app: dockerfile },
      realPaths: { ...out.realPaths, [`${FOLDER}/.devcontainer`]: `${FOLDER}/.devcontainer`, [`${FOLDER}/.devcontainer/D$x`]: `${FOLDER}/.devcontainer/D$x` },
      ...extra,
    };
  }

  it('read-configuration and build get the checked Dockerfile text at COMPOSE_DEV_DOCKERFILE', async () => {
    // No copy of the <Dockerfile>.dockerignore (it would not take effect).
    const dockerfile = `${BASE}RUN echo $HOME\n`;
    useDevBuild(dockerfile);
    await h.service.open(TARGET, options());
    expect(h.helper.builds).toHaveLength(1);
    const reads = h.helper.readConfigurations.filter((read) => read.files !== undefined);
    expect(reads.length).toBeGreaterThan(0);
    for (const files of [h.helper.builds[0].files, ...reads.map((read) => read.files)]) {
      expect(files?.[COMPOSE_DEV_DOCKERFILE]).toBe(dockerfile);
      expect(Object.keys(files ?? {}).filter((file) => file.endsWith('.dockerignore'))).toEqual([]);
      const written = JSON.parse(files?.[COMPOSE_MODEL_PATH] ?? 'null') as ComposeModel;
      // Every service with `build` gets the ID label of the devspace (build.labels).
      expect(written.services.app.build).toEqual({ context: `${FOLDER}/.devcontainer`, dockerfile: COMPOSE_DEV_DOCKERFILE, labels: { [LABEL_DEVSPACE_ID]: ENV_ID } });
    }
  });
});

describe('a change of the configuration between two configurations of one compose file with another service', () => {
  // The first opens of this group create the devspace, so its names carry the word of the source.
  const NAME = FIRST_OPEN_NAME;
  const WEB_PATH = '.devcontainer/web/devcontainer.json';
  const WEB_TEXT = CONFIG_TEXT.replace('"service": "app"', '"service": "web"').replace('["compose.yml"]', '["../compose.yml"]');

  beforeEach(() => {
    h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: CONFIG_TEXT }, [WEB_PATH]: { configText: WEB_TEXT } };
    h.helper.composeOutput = output((m) => {
      // Each configuration mounts the workspace volume into its dev service only (another service may not mount it).
      delete m.services.app.volumes;
      m.services.web = { image: BASE_IMAGE, command: ['sleep', 'infinity'], networks: { default: null } };
    });
  });

  const byService = (service: string): ContainerInfo | undefined => h.docker.containersOf(ENV_ID).find((c) => c.labels['com.docker.compose.service'] === service);

  it('renames the previous dev container out of the way, stops the container of the new dev service before up removes it, and starts', async () => {
    await h.service.open(TARGET, options());
    const app = byService('app')!;
    const web = byService('web')!;
    expect(app.name).toBe(NAME);
    expect(web.state).toBe('running');
    const log = h.docker.log.length;
    // A container that an earlier failed attempt of Compose left in the state `created`.
    const leftover = h.docker.addContainer({ devspaceId: ENV_ID, name: `${'a'.repeat(12)}_${PROJECT}-app-1`, state: 'stopped', image: IMAGE_1, labels: { ...COMPOSE_LABELS, 'com.docker.compose.service': 'app', [LABEL_COMPOSE_SERVICE]: 'app' } });
    leftover.rawState = 'created';

    await h.service.openDevspace(ENV_ID, { progress: h.progress, configPath: WEB_PATH });

    const after = h.docker.log.slice(log);
    expect(after).toContain(`rename ${app.id} ${PROJECT}-app-1`);
    expect(after).toContain(`stop ${web.id}`);
    expect(after).toContain(`rm ${leftover.id}`);
    // Never removed with its volumes, and the previous dev container is not removed by the extension.
    expect(after).not.toContain(`rm ${app.id}`);
    expect(h.helper.calls.filter((call) => call.startsWith('up')).at(-1)).toBe(`up ${IMAGE_2} --remove-existing-container`);
    expect(byService('web')).toMatchObject({ name: NAME, state: 'running' });
    // Compose creates the previous dev service again as another service, under its default name.
    expect(byService('app')).toMatchObject({ name: `${PROJECT}-app-1`, labels: expect.objectContaining({ [LABEL_COMPOSE_SERVICE]: 'app' }) });
    expect((await h.registry.get(ENV_ID))?.configPath).toBe(WEB_PATH);
    expect(h.progress.details).not.toContain(Messages.containerComposeDevServiceChanged);
  });

  it('stops and removes the previous dev container (its volumes stay) when it cannot be renamed, and tells the user', async () => {
    await h.service.open(TARGET, options());
    const app = byService('app')!;
    h.docker.renameError = new CommandError('docker rename', 1, '', 'Error response from daemon: rename failed');
    await h.service.openDevspace(ENV_ID, { progress: h.progress, configPath: WEB_PATH });
    expect(h.docker.log).toContain(`stop ${app.id}`);
    expect(h.docker.log).toContain(`rm ${app.id}`);
    expect(h.docker.log.filter((line) => line.startsWith('volume rm'))).toEqual([]);
    expect(byService('web')).toMatchObject({ name: NAME, state: 'running' });
    expect(h.progress.details).toContain(Messages.containerComposeDevServiceChanged);
  });

  it('keeps the previous configuration path when the start with the new one fails', async () => {
    await h.service.open(TARGET, options());
    h.helper.upError = () => new Error('compose up failed');
    const error = await rejection(h.service.openDevspace(ENV_ID, { progress: h.progress, configPath: WEB_PATH }));
    expect(error.code).toBe('startFailed');
    expect((await h.registry.get(ENV_ID))?.configPath).toBe(DEFAULT_CONFIG_PATH);
  });

  it('ends with helperFailed and keeps the previous dev container stopped when the helper image of the open is gone at up of the new dev service', async () => {
    await h.service.open(TARGET, options());
    const app = byService('app')!;
    const ups = h.helper.ups.length;
    h.helper.upFailsBeforeRemoval = true;
    h.helper.upError = (image) => (image === IMAGE_1 ? undefined : new UserFacingError('helperFailed', Messages.helperFailed, `No such image: sha256:${'4'.repeat(64)}`));
    const error = await rejection(h.service.openDevspace(ENV_ID, { progress: h.progress, configPath: WEB_PATH }));
    expect(error.code).toBe('helperFailed');
    expect(error.message).toBe(Messages.helperFailed);
    expect(error.detail).toContain('The dev service changed from app to web. The previous dev container is kept, stopped.');
    // Not opened as it is, and no `up` with the previous image.
    expect(h.helper.ups.slice(ups).map((up) => up.image)).toEqual([IMAGE_2]);
    expect(h.docker.containers.get(app.id)).toMatchObject({ name: `${PROJECT}-app-1`, state: 'stopped' });
    expect((await h.registry.get(ENV_ID))?.configPath).toBe(DEFAULT_CONFIG_PATH);
    expect(h.logger.errors.join('\n')).not.toContain('could not be created from');
  });

  it('ends the open with helperFailed, keeps the running previous dev container and the previous configuration when the folders of the bind mounts cannot be written with helperFailed before it was moved', async () => {
    // The open does not end with "The previous dev container is kept, stopped": it was neither renamed nor stopped.
    await h.service.open(TARGET, options());
    const app = byService('app')!;
    expect(app).toMatchObject({ name: NAME, state: 'running' });
    const SOURCE = `${FOLDER}/data/postgres`;
    const out = output((m) => {
      delete m.services.app.volumes;
      m.services.web = { image: BASE_IMAGE, command: ['sleep', 'infinity'], networks: { default: null } };
      m.services.db.volumes = [{ type: 'bind', source: SOURCE, target: '/var/lib/postgresql/data', bind: { create_host_path: true } }];
    });
    out.realPaths = { ...out.realPaths, [SOURCE]: null };
    out.mountAncestors = { [SOURCE]: FOLDER };
    h.helper.composeOutput = out;
    const log = h.docker.log.length;
    const ups = h.helper.ups.length;
    h.helper.createFoldersError = new UserFacingError('helperFailed', Messages.helperFailed, `No such image: sha256:${'4'.repeat(64)}`);
    // A helperFailed during an update fails the open: the running previous dev container is not opened as it is.
    const error = await rejection(h.service.openDevspace(ENV_ID, { progress: h.progress, configPath: WEB_PATH }));
    expect(error.code).toBe('helperFailed');
    expect(error.detail ?? '').not.toContain('The dev service changed');
    expect(h.helper.calls).toContain(`createRepositoryFolders ${SOURCE}`);
    expect(h.ui.warnings).toEqual([]);
    expect(h.helper.ups.slice(ups)).toEqual([]);
    const after = h.docker.log.slice(log);
    expect(after.filter((line) => line.startsWith('rename') || line.startsWith('rm ') || line.startsWith('stop'))).toEqual([]);
    expect(h.docker.containers.get(app.id)).toMatchObject({ name: NAME, state: 'running' });
    expect((await h.registry.get(ENV_ID))?.configPath).toBe(DEFAULT_CONFIG_PATH);
  });

  it('ends the open with helperFailed, keeps the running previous dev container and the previous configuration when the Git setup before up fails with helperFailed before it was moved', async () => {
    await h.service.open(TARGET, options());
    const app = byService('app')!;
    expect(app).toMatchObject({ name: NAME, state: 'running' });
    const log = h.docker.log.length;
    const ups = h.helper.ups.length;
    h.helper.prepareGitError = new UserFacingError('helperFailed', Messages.helperFailed, `No such image: sha256:${'4'.repeat(64)}`);
    // A helperFailed during an update fails the open: the running previous dev container is not opened as it is.
    const error = await rejection(h.service.openDevspace(ENV_ID, { progress: h.progress, configPath: WEB_PATH }));
    expect(error.code).toBe('helperFailed');
    expect(error.detail ?? '').not.toContain('The dev service changed');
    expect(h.ui.warnings).toEqual([]);
    expect(h.helper.ups.slice(ups)).toEqual([]);
    const after = h.docker.log.slice(log);
    expect(after.filter((line) => line.startsWith('rename') || line.startsWith('rm ') || line.startsWith('stop'))).toEqual([]);
    expect(h.docker.containers.get(app.id)).toMatchObject({ name: NAME, state: 'running' });
    expect((await h.registry.get(ENV_ID))?.configPath).toBe(DEFAULT_CONFIG_PATH);
  });

  describe('a failed switch keeps the previous dev container', () => {
    it('restores nothing with the new configuration: the previous dev container stays stopped and intact, and a reopen with the previous configuration starts it', async () => {
      await h.service.open(TARGET, options());
      const app = byService('app')!;
      const log = h.docker.log.length;
      const ups = h.helper.ups.length;
      // Compose fails before it creates the new dev container; the previous devspace image would start.
      h.helper.upFailsBeforeRemoval = true;
      h.helper.upError = (image) => (image === IMAGE_1 ? undefined : new Error('compose up failed'));
      const error = await rejection(h.service.openDevspace(ENV_ID, { progress: h.progress, configPath: WEB_PATH }));
      expect(error.code).toBe('startFailed');
      expect(error.message).toBe(PipelineTexts.startFailed);
      const after = h.docker.log.slice(log);
      expect(after).not.toContain(`rm ${app.id}`);
      // No `up` with the new configuration and the previous image (it would create the previous dev service again).
      expect(h.helper.ups.slice(ups).map((up) => up.image)).toEqual([IMAGE_2]);
      expect(h.docker.containers.get(app.id)).toMatchObject({ name: `${PROJECT}-app-1`, state: 'stopped' });
      expect(h.docker.images.has(IMAGE_2)).toBe(false);
      expect((await h.registry.get(ENV_ID))?.configPath).toBe(DEFAULT_CONFIG_PATH);

      h.helper.upFailsBeforeRemoval = false;
      h.helper.upError = () => undefined;
      await h.service.openDevspace(ENV_ID, { progress: h.progress });
      expect(h.docker.containers.get(app.id)?.state).toBe('running');
      expect(h.docker.log.slice(log)).not.toContain(`rm ${app.id}`);
    });
  });

  describe('the guard of a failed switch of the dev service follows what happened, not the build record', () => {
    /**
     * The first test of 'a failed switch keeps the previous dev container', with the build record of the previous
     * configuration changed by `change` before the switch.
     */
    async function failedSwitch(change: (devspace: Devspace) => void): Promise<void> {
      await h.service.open(TARGET, options());
      const app = byService('app')!;
      await h.registry.updateDevspace(ENV_ID, change);
      const log = h.docker.log.length;
      const ups = h.helper.ups.length;
      h.helper.upFailsBeforeRemoval = true;
      h.helper.upError = (image) => (image === IMAGE_1 ? undefined : new Error('compose up failed'));
      const error = await rejection(h.service.openDevspace(ENV_ID, { progress: h.progress, configPath: WEB_PATH }));
      expect(error.code).toBe('startFailed');
      // The guard does not read the service from composeRecordOf(record): that would skip it, and the restore would run
      // `up` with the new configuration and the previous image next to the renamed previous dev container.
      expect(h.helper.ups.slice(ups).map((up) => up.image)).not.toContain(IMAGE_1);
      expect(h.docker.log.slice(log)).not.toContain(`rm ${app.id}`);
      expect(h.docker.containers.get(app.id)).toMatchObject({ name: `${PROJECT}-app-1`, state: 'stopped' });
      expect(h.docker.containersOf(ENV_ID).filter((c) => c.labels['com.docker.compose.service'] === 'app')).toEqual([expect.objectContaining({ id: app.id })]);
      expect((await h.registry.get(ENV_ID))?.configPath).toBe(DEFAULT_CONFIG_PATH);
    }

    it('an older build record whose part of Docker Compose lacks a field (composeRecordOf rejects it)', async () => {
      await failedSwitch((devspace) => {
        delete (devspace.buildRecord!.compose as Partial<NonNullable<BuildRecord['compose']>>).inputsHash;
      });
    });

    it('a build record without the service name in its part of Docker Compose', async () => {
      await failedSwitch((devspace) => {
        delete (devspace.buildRecord!.compose as Partial<NonNullable<BuildRecord['compose']>>).service;
      });
    });

    it('no build record', async () => {
      await failedSwitch((devspace) => {
        delete devspace.buildRecord;
      });
    });
  });

  describe('run-user-commands of the new dev service fails with helperFailed after up', () => {
    const gone = () => new UserFacingError('helperFailed', Messages.helperFailed, `No such image: sha256:${'4'.repeat(64)}`);

    it('removes the new dev container, says what happened to the previous one, keeps the previous configuration, and the next open runs up and the lifecycle commands', async () => {
      // Compose creates a dev container again whose name changed.
      h.helper.composeRecreatesRenamedDevContainer = true;
      await h.service.open(TARGET, options());
      const app = byService('app')!;
      const web = byService('web')!;
      h.helper.userCommandsError = gone();
      const error = await rejection(h.service.openDevspace(ENV_ID, { progress: h.progress, configPath: WEB_PATH }));
      expect(error.code).toBe('helperFailed');
      expect(error.message).toBe(Messages.helperFailed);
      // Compose created the renamed previous dev container again as the service app (the fake recreates it: its labels changed).
      expect(error.detail).toBe(
        `The dev service changed from app to web. The dev container of the service web was created, but its lifecycle commands could not run. It was removed. Docker Compose created the previous dev container again as the service app (${PROJECT}-app-1); the files outside its volumes are gone. The previous configuration stays selected. No such image: sha256:${'4'.repeat(64)}`,
      );
      // The new dev container is gone (never opened as it is); the previous one (created again by Compose) is stopped.
      expect(h.docker.containersOf(ENV_ID).some((c) => c.name === NAME)).toBe(false);
      expect(h.docker.containers.has(web.id)).toBe(false);
      expect(h.docker.containers.has(app.id)).toBe(false);
      expect(byService('app')).toMatchObject({ name: `${PROJECT}-app-1`, state: 'stopped' });
      expect((await h.registry.get(ENV_ID))?.configPath).toBe(DEFAULT_CONFIG_PATH);
      expect((await h.registry.get(ENV_ID))?.buildRecord?.devspaceImage).toBe(IMAGE_1);
      expect(h.docker.images.has(IMAGE_2)).toBe(false);

      // The next open (helper back, updates off) opens the configuration app through `up` and its lifecycle commands.
      h.helper.userCommandsError = undefined;
      h.settings.updateImagesOnConnect = false;
      const runs = h.helper.userCommandRuns.length;
      h.helper.calls.length = 0;
      const result = await h.service.openDevspace(ENV_ID, options());
      expect(h.helper.calls.filter((call) => call.startsWith('up'))).toHaveLength(1);
      expect(h.helper.ups.at(-1)?.override.service).toBe('app');
      expect(h.helper.userCommandRuns.length).toBe(runs + 1);
      // The window connects to a running container of that name, and the lifecycle commands ran in it (the fake Compose
      // creates the renamed dev container again under its container_name).
      const connected = h.docker.containersOf(ENV_ID).find((c) => c.name === result.containerName);
      expect(connected).toMatchObject({ state: 'running', labels: expect.objectContaining({ 'com.docker.compose.service': 'app' }) });
      expect(h.helper.userCommandRuns.at(-1)?.containerId).toBe(connected?.id);
    });

    it('when the rename of the previous dev container failed, the detail says that it was removed', async () => {
      await h.service.open(TARGET, options());
      const app = byService('app')!;
      h.docker.renameError = new CommandError('docker rename', 1, '', 'Error response from daemon: rename failed');
      h.helper.userCommandsError = gone();
      const error = await rejection(h.service.openDevspace(ENV_ID, { progress: h.progress, configPath: WEB_PATH }));
      expect(error.code).toBe('helperFailed');
      expect(error.detail).toBe(
        `The dev service changed from app to web. The dev container of the service web was created, but its lifecycle commands could not run. It was removed. The previous dev container ${NAME} could not be renamed and was removed; its volumes are kept. The previous configuration stays selected. No such image: sha256:${'4'.repeat(64)}`,
      );
      expect(h.docker.containers.has(app.id)).toBe(false);
      expect(h.docker.containersOf(ENV_ID).some((c) => c.name === NAME)).toBe(false);
    });

    it('when the rename failed and `up` itself fails with helperFailed, the detail says that the previous dev container was removed', async () => {
      await h.service.open(TARGET, options());
      h.docker.renameError = new CommandError('docker rename', 1, '', 'Error response from daemon: rename failed');
      h.helper.upFailsBeforeRemoval = true;
      h.helper.upError = (image) => (image === IMAGE_1 ? undefined : gone());
      const error = await rejection(h.service.openDevspace(ENV_ID, { progress: h.progress, configPath: WEB_PATH }));
      expect(error.code).toBe('helperFailed');
      expect(error.detail).toBe(
        `The dev service changed from app to web. The previous dev container ${NAME} could not be renamed and was removed; its volumes are kept. No such image: sha256:${'4'.repeat(64)}`,
      );
    });

    it('the containers cannot be listed before `up`: the previous dev container that Compose created again is stopped, and the open ends with helperFailed', async () => {
      await h.service.open(TARGET, options());
      const list = h.docker.listDevspaceContainers.bind(h.docker);
      h.docker.listDevspaceContainers = async () => {
        if (new Error().stack?.includes('containersBeforeUp')) throw new CommandError('docker ps', 1, '', 'Cannot connect to the Docker daemon');
        return list();
      };
      h.helper.userCommandsError = gone();
      const error = await rejection(h.service.openDevspace(ENV_ID, { progress: h.progress, configPath: WEB_PATH }));
      expect(error.code).toBe('helperFailed');
      expect(byService('app')).toMatchObject({ name: `${PROJECT}-app-1`, state: 'stopped' });
      expect(error.detail).toContain(`Docker Compose created the previous dev container again as the service app (${PROJECT}-app-1); the files outside its volumes are gone. The previous configuration stays selected.`);
    });

    it('the new dev container that could not be removed: the next open does what the detail says', async () => {
      await h.service.open(TARGET, options());
      const remove = h.docker.removeContainer.bind(h.docker);
      h.docker.removeContainer = async (ref) => {
        if (new Error().stack?.includes('withdrawAfterHelperFailed')) throw new CommandError('docker rm', 1, '', 'Cannot connect to the Docker daemon');
        return remove(ref);
      };
      h.helper.userCommandsError = gone();
      const error = await rejection(h.service.openDevspace(ENV_ID, { progress: h.progress, configPath: WEB_PATH }));
      expect(error.code).toBe('helperFailed');
      const web = byService('web')!;
      expect(web).toMatchObject({ name: NAME, state: 'stopped' });
      h.docker.removeContainer = remove;
      h.helper.userCommandsError = undefined;
      h.settings.updateImagesOnConnect = false;
      const runs = h.helper.userCommandRuns.length;
      await h.service.openDevspace(ENV_ID, options());
      const started = h.helper.userCommandRuns.slice(runs).some((run) => run.containerId === web.id);
      // The detail may promise that the next open starts it and runs its lifecycle commands only when it does.
      expect(error.detail?.includes('the next open starts it') ?? false).toBe(started);
    });

    it('the next open does not rename the dev container of the other service without a busy mark while another window is opening the devspace', async () => {
      // A pending connection file of window B (status files do not count while nothing runs).
      await h.service.open(TARGET, options());
      // The first removal after run-user-commands failed (the withdrawal of the new dev container web) fails.
      let withdrawing = false;
      let failedRemovals = 0;
      const runUserCommands = h.helper.runUserCommands.bind(h.helper);
      h.helper.runUserCommands = async (p) => {
        try {
          return await runUserCommands(p);
        } catch (error) {
          withdrawing = true;
          throw error;
        }
      };
      const remove = h.docker.removeContainer.bind(h.docker);
      h.docker.removeContainer = async (ref) => {
        if (withdrawing) {
          withdrawing = false;
          failedRemovals++;
          throw new CommandError('docker rm', 1, '', 'Cannot connect to the Docker daemon');
        }
        return remove(ref);
      };
      h.helper.userCommandsError = gone();
      await rejection(h.service.openDevspace(ENV_ID, { progress: h.progress, configPath: WEB_PATH }));
      expect(failedRemovals).toBe(1);
      const web = byService('web')!;
      h.docker.removeContainer = remove;
      h.helper.runUserCommands = runUserCommands;
      h.helper.userCommandsError = undefined;
      h.settings.updateImagesOnConnect = false;
      h.sessionFiles.readPendings = async () => [{ devspaceId: ENV_ID, windowId: 'window-b', createdAt: new Date(T0).toISOString() }];
      const log = h.docker.log.length;
      const error = await rejection(h.service.openDevspace(ENV_ID, options()));
      expect(error.code).toBe('startFailed');
      expect(error.detail).toContain(`the dev container ${NAME} of the service web must be renamed and stopped, but another window is opening the devspace.`);
      expect(h.docker.log.slice(log).filter((line) => line.startsWith('stop') || line.startsWith('rm') || line.startsWith('rename'))).toEqual([]);
      expect(h.docker.containers.get(web.id)).toMatchObject({ name: NAME });
      expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
    });

    it('the containers cannot be listed after the failed switch: the state of the previous dev container is not known', async () => {
      await h.service.open(TARGET, options());
      const list = h.docker.listDevspaceContainers.bind(h.docker);
      h.docker.listDevspaceContainers = async () => {
        if (new Error().stack?.includes('previousDevContainerAfterFailedSwitch')) throw new CommandError('docker ps', 1, '', 'Cannot connect to the Docker daemon');
        return list();
      };
      h.helper.userCommandsError = gone();
      const error = await rejection(h.service.openDevspace(ENV_ID, { progress: h.progress, configPath: WEB_PATH }));
      expect(error.code).toBe('helperFailed');
      expect(error.detail).toContain(`It was removed. The state of the previous dev container ${PROJECT}-app-1 is not known. The previous configuration stays selected.`);
    });

    it('the containers cannot be listed before `up`: the detail says "created or started", and nothing about the next open', async () => {
      await h.service.open(TARGET, options());
      const list = h.docker.listDevspaceContainers.bind(h.docker);
      h.docker.listDevspaceContainers = async () => {
        if (new Error().stack?.includes('containersBeforeUp')) throw new CommandError('docker ps', 1, '', 'Cannot connect to the Docker daemon');
        return list();
      };
      h.helper.userCommandsError = gone();
      const error = await rejection(h.service.openDevspace(ENV_ID, { progress: h.progress, configPath: WEB_PATH }));
      expect(error.code).toBe('helperFailed');
      expect(error.detail).toBe(
        `The dev service changed from app to web. The dev container of the service web was created or started, but its lifecycle commands could not run. It was stopped. Docker Compose created the previous dev container again as the service app (${PROJECT}-app-1); the files outside its volumes are gone. The previous configuration stays selected. No such image: sha256:${'4'.repeat(64)}`,
      );
      expect(byService('web')).toMatchObject({ name: NAME, state: 'stopped' });
    });

    it('the previous dev container that Compose created again cannot be stopped: the detail says so', async () => {
      await h.service.open(TARGET, options());
      const list = h.docker.listDevspaceContainers.bind(h.docker);
      h.docker.listDevspaceContainers = async () => {
        if (new Error().stack?.includes('containersBeforeUp')) throw new CommandError('docker ps', 1, '', 'Cannot connect to the Docker daemon');
        return list();
      };
      const stop = h.docker.stopContainer.bind(h.docker);
      h.docker.stopContainer = async (ref) => {
        if (new Error().stack?.includes('previousDevContainerAfterFailedSwitch')) throw new CommandError('docker stop', 1, '', 'Cannot connect to the Docker daemon');
        return stop(ref);
      };
      h.helper.userCommandsError = gone();
      const error = await rejection(h.service.openDevspace(ENV_ID, { progress: h.progress, configPath: WEB_PATH }));
      expect(error.code).toBe('helperFailed');
      expect(error.detail).toContain(
        `Docker Compose created the previous dev container again as the service app (${PROJECT}-app-1); the files outside its volumes are gone. It could not be stopped. The previous configuration stays selected.`,
      );
      expect(byService('app')?.state).toBe('running');
    });


  });

  describe('the new configuration does not start the previous dev service (runServices)', () => {
    const RUN_TEXT = WEB_TEXT.replace('"service": "web"', '"service": "web",\n  "runServices": ["web", "db"]');

    beforeEach(() => {
      h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: CONFIG_TEXT }, [WEB_PATH]: { configText: RUN_TEXT } };
    });

    const running = (): string[] => h.docker.containersOf(ENV_ID).filter((c) => c.state === 'running').map((c) => c.name);

    it('stops the renamed previous dev container (never removes it); Stop then leaves nothing running and a reopen connects to the new dev container', async () => {
      await h.service.open(TARGET, options());
      const app = byService('app')!;
      const log = h.docker.log.length;
      await h.service.openDevspace(ENV_ID, { progress: h.progress, configPath: WEB_PATH });
      const after = h.docker.log.slice(log);
      expect(after).toContain(`rename ${app.id} ${PROJECT}-app-1`);
      expect(after).toContain(`stop ${app.id}`);
      expect(after).not.toContain(`rm ${app.id}`);
      expect(h.docker.log.filter((line) => line.startsWith('volume rm'))).toEqual([]);
      // Compose does not create the service app again: the previous dev container stays, stopped, under its new name.
      expect(h.docker.containers.get(app.id)).toMatchObject({ name: `${PROJECT}-app-1`, state: 'stopped' });
      const web = byService('web')!;
      expect(web).toMatchObject({ name: NAME, state: 'running' });

      await h.operations.stop(ENV_ID);
      expect(running()).toEqual([]);

      const result = await h.service.openDevspace(ENV_ID, { progress: h.progress });
      expect(result.containerName).toBe(NAME);
      expect(h.docker.containers.get(web.id)?.state).toBe('running');
      expect(h.docker.containers.get(app.id)?.state).toBe('stopped');
      expect((await h.registry.get(ENV_ID))?.configPath).toBe(WEB_PATH);
    });

    it('run-user-commands fails with helperFailed after up: the new dev container is removed, the previous one is kept, stopped, and the detail says so', async () => {
      await h.service.open(TARGET, options());
      const app = byService('app')!;
      h.helper.userCommandsError = new UserFacingError('helperFailed', Messages.helperFailed, 'No such image: x');
      const error = await rejection(h.service.openDevspace(ENV_ID, { progress: h.progress, configPath: WEB_PATH }));
      expect(error.code).toBe('helperFailed');
      expect(error.detail).toBe(
        'The dev service changed from app to web. The dev container of the service web was created, but its lifecycle commands could not run. It was removed. The previous dev container is kept, stopped. The previous configuration stays selected. No such image: x',
      );
      expect(h.docker.containers.get(app.id)).toMatchObject({ name: `${PROJECT}-app-1`, state: 'stopped' });
      expect(byService('web')).toBeUndefined();
    });

    it('the previous dev container that cannot be stopped is not called stopped', async () => {
      await h.service.open(TARGET, options());
      const app = byService('app')!;
      const stop = h.docker.stopContainer.bind(h.docker);
      h.docker.stopContainer = async (ref) => {
        if (ref === app.id) throw new CommandError('docker stop', 1, '', 'Cannot connect to the Docker daemon');
        return stop(ref);
      };
      h.helper.userCommandsError = new UserFacingError('helperFailed', Messages.helperFailed, 'No such image: x');
      const error = await rejection(h.service.openDevspace(ENV_ID, { progress: h.progress, configPath: WEB_PATH }));
      expect(error.code).toBe('helperFailed');
      expect(error.detail).toContain('It was removed. The previous dev container is kept, but it could not be stopped. The previous configuration stays selected.');
    });

    it('the renamed previous dev container that is gone after the failed switch is named by its new name', async () => {
      await h.service.open(TARGET, options());
      const app = byService('app')!;
      const error = new UserFacingError('helperFailed', Messages.helperFailed, 'No such image: x');
      // For example removed by hand while the lifecycle commands were to run.
      Object.defineProperty(h.helper, 'userCommandsError', {
        configurable: true,
        get: () => {
          h.docker.containers.delete(app.id);
          return error;
        },
      });
      const failed = await rejection(h.service.openDevspace(ENV_ID, { progress: h.progress, configPath: WEB_PATH }));
      expect(failed.code).toBe('helperFailed');
      expect(failed.detail).toContain(`It was removed. The previous dev container ${PROJECT}-app-1 is gone. The previous configuration stays selected.`);
    });

    it('connects to the dev container with the name of the devspace even when the previous one runs again', async () => {
      await h.service.open(TARGET, options());
      const app = byService('app')!;
      await h.service.openDevspace(ENV_ID, { progress: h.progress, configPath: WEB_PATH });
      const web = byService('web')!;
      await h.operations.stop(ENV_ID);
      // For example started by hand.
      await h.docker.startContainer(app.id);
      const result = await h.service.openDevspace(ENV_ID, { progress: h.progress });
      expect(result.containerName).toBe(NAME);
      expect(h.docker.containers.get(web.id)?.state).toBe('running');
    });

    it('after a failed switch, a reopen with the previous configuration starts the previous dev container again', async () => {
      await h.service.open(TARGET, options());
      const app = byService('app')!;
      h.helper.upError = () => new Error('compose up failed');
      const error = await rejection(h.service.openDevspace(ENV_ID, { progress: h.progress, configPath: WEB_PATH }));
      expect(error.code).toBe('startFailed');
      // Stopped, not removed.
      expect(h.docker.containers.get(app.id)?.state).toBe('stopped');
      h.helper.upError = () => undefined;
      await h.service.openDevspace(ENV_ID, { progress: h.progress });
      expect(h.docker.containers.get(app.id)?.state).toBe('running');
      expect((await h.registry.get(ENV_ID))?.configPath).toBe(DEFAULT_CONFIG_PATH);
    });

    it('a retry of a failed switch keeps the previous dev container (renamed already: no rename, never removed)', async () => {
      await h.service.open(TARGET, options());
      const app = byService('app')!;
      h.helper.upError = () => new Error('compose up failed');
      const error = await rejection(h.service.openDevspace(ENV_ID, { progress: h.progress, configPath: WEB_PATH }));
      expect(error.code).toBe('startFailed');
      expect(h.docker.containers.get(app.id)).toMatchObject({ name: `${PROJECT}-app-1`, state: 'stopped' });
      h.helper.upError = () => undefined;
      const log = h.docker.log.length;
      const result = await h.service.openDevspace(ENV_ID, { progress: h.progress, configPath: WEB_PATH });
      const after = h.docker.log.slice(log);
      expect(after).not.toContain(`rename ${app.id} ${PROJECT}-app-1`);
      expect(after).not.toContain(`rm ${app.id}`);
      expect(h.docker.log.filter((line) => line.startsWith('volume rm'))).toEqual([]);
      expect(h.docker.containers.get(app.id)).toMatchObject({ name: `${PROJECT}-app-1`, state: 'stopped' });
      expect(result.containerName).toBe(NAME);
      expect(byService('web')).toMatchObject({ name: NAME, state: 'running' });
      expect((await h.registry.get(ENV_ID))?.configPath).toBe(WEB_PATH);
      expect(h.progress.details).not.toContain(Messages.containerComposeDevServiceChanged);
    });
  });
});

describe('lifecycle token: Docker Compose', () => {
  // The first opens of this group create the devspace, so its names carry the word of the source.
  const NAME = FIRST_OPEN_NAME;
  it('first open: up, the token into the dev container, then run-user-commands with the model and the project of up', async () => {
    await h.service.open(TARGET, options());
    const dev = devContainer();
    expect(dev?.name).toBe(NAME);
    const up = h.helper.ups[0];
    expect(h.helper.userCommandRuns).toEqual([
      { containerId: dev?.id, devspaceId: ENV_ID, override: up.override, files: up.files, env: { COMPOSE_PROJECT_NAME: PROJECT }, upsBefore: 1, tokenWritesBefore: 1 },
    ]);
    expect(h.docker.tokenWrites()).toEqual([expect.objectContaining({ container: dev?.id, user: 'root', remoteUser: 'vscode', token: TOKEN })]);
    expect(JSON.stringify(h.helper.userCommandRuns)).not.toContain(TOKEN);
  });

  it('~/.gitconfig of the dev container after the token and before run-user-commands; finish does not run it again', async () => {
    await h.service.open(TARGET, options());
    const dev = devContainer();
    const index = (script: string) => h.docker.execs.flatMap((exec, i) => (exec.command[2] === script ? [i] : []));
    const home = index(HOME_GIT_CONFIG_SCRIPT);
    const token = index(TOKEN_WRITE_SCRIPT);
    const [run] = h.helper.userCommandContext;
    expect(h.helper.calls.indexOf('prepareGit')).toBeLessThan(h.helper.calls.findIndex((call) => call.startsWith('up')));
    expect(home).toHaveLength(1);
    // The command of the script `homeGitConfig` of the registry.
    expect(h.docker.execs[home[0]]).toMatchObject({ container: dev?.id, user: 'root', command: scriptCommand('homeGitConfig', ['vscode']) });
    expect(token[0]).toBeLessThan(home[0]);
    expect(home[0]).toBeLessThan(run.execsBefore);
    expect(run.token).toBe(TOKEN);
    // The Git version of the new dev container: once, in finish.
    expect(h.docker.execs.filter((exec) => exec.command[0] === 'git' && exec.command[1] === '--version')).toHaveLength(1);
  });

  it('a stopped devspace gets ~/.gitconfig before run-user-commands too', async () => {
    await seedCompose();
    await h.service.openDevspace(ENV_ID, options());
    const home = h.docker.execs.flatMap((exec, i) => (exec.command[2] === HOME_GIT_CONFIG_SCRIPT ? [i] : []));
    expect(home).toHaveLength(1);
    expect(h.docker.execs[home[0]].container).toBe(devContainer()?.id);
    expect(home[0]).toBeLessThan(h.helper.userCommandContext[0].execsBefore);
  });

  it('a stopped devspace: up starts the containers, then run-user-commands in the dev container', async () => {
    await seedCompose();
    await h.service.openDevspace(ENV_ID, options());
    expect(h.helper.userCommandRuns).toEqual([expect.objectContaining({ containerId: devContainer()?.id, upsBefore: 1, tokenWritesBefore: 1 })]);
  });

  it('a running dev container: no up and no run-user-commands', async () => {
    await seedCompose({ dev: 'running', db: 'running' });
    await h.service.openDevspace(ENV_ID, options());
    expect(h.helper.ups).toEqual([]);
    expect(h.helper.userCommandRuns).toEqual([]);
    expect(h.docker.tokenWrites()).toHaveLength(1);
  });

  it('a lifecycle command that fails in run-user-commands: the existing warning, the devspace opens', async () => {
    await seedCompose();
    h.helper.lifecycleFailure = () => 'postStartCommand from devcontainer.json failed.';
    await h.service.openDevspace(ENV_ID, options());
    expect(h.ui.warnings).toEqual([PipelineTexts.lifecycleCommandFailed('postStartCommand')]);
    expect(devContainer()?.state).toBe('running');
  });
});

describe('recreate offer: Docker Compose', () => {
  const PASSWD_DAMAGED = 'Error response from daemon: unable to find user vscode: no matching entries in passwd file';
  /**
   * Compose labels each container with the ID of its image (the fake image ID of DB_IMAGE) and with the configuration
   * hash of its service (serviceHashes of the fake helper, set below).
   */
  const DB_IMAGE_ID = { 'com.docker.compose.image': `sha256:image-of-${DB_IMAGE}`, 'com.docker.compose.config-hash': 'hash-of-db' };

  beforeEach(() => {
    h.helper.serviceHashes = { app: 'hash-of-app', db: 'hash-of-db' };
  });

  /**
   * `up` of the existing containers fails because the dev container is damaged: like the CLI, the failed `up` leaves the
   * containers running, and the check as the remote user fails in the dev container only. The `up` that replaces the dev
   * container works.
   */
  function damageDevContainer(): void {
    const devId = devContainer()?.id;
    // The check runs as the user of the label devcontainer.metadata of the container.
    const dev = devContainer();
    if (dev) dev.labels['devcontainer.metadata'] = JSON.stringify([{ remoteUser: 'vscode' }]);
    h.helper.upError = (_image, removeExisting) => (removeExisting ? undefined : new DevcontainerCommandError('devcontainer up', 1, '', PASSWD_DAMAGED));
    h.helper.beforeUpError = () => {
      for (const c of h.docker.containersOf(ENV_ID)) {
        c.state = 'running';
        c.rawState = 'running';
      }
    };
    h.docker.execHandler = (container, command) => (container === devId && command[2] === 'exit 0' ? { exitCode: 1, stderr: PASSWD_DAMAGED } : {});
  }

  it('Recreate removes only the dev container (stopped first, never a volume); the database keeps running with its data', async () => {
    await seedCompose({ dev: 'stopped', db: 'running', dbLabels: DB_IMAGE_ID });
    const dev = devContainer();
    const db = dbContainer();
    damageDevContainer();
    h.ui.recreateAnswer = true;

    await h.service.openDevspace(ENV_ID, options());

    expect(h.ui.recreateQuestions).toEqual([{ message: Messages.containerRecreateQuestion(REPO, true), detail: Messages.containerRecreateDetail(true) }]);
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_1}`, `up ${IMAGE_1} --remove-existing-container`]);
    const log = h.docker.log;
    expect(log.indexOf(`stop ${dev?.id}`)).toBeGreaterThanOrEqual(0);
    expect(log.indexOf(`stop ${dev?.id}`)).toBeLessThan(log.indexOf(`rm ${dev?.id}`));
    // The side service is untouched: neither stopped nor removed, the same container, running.
    expect(log.filter((line) => line.includes(String(db?.id)))).toEqual([]);
    expect(dbContainer()).toMatchObject({ id: db?.id, state: 'running' });
    expect(log.filter((line) => line.startsWith('volume rm'))).toEqual([]);
    expect(h.docker.volumes.has(NAME)).toBe(true);
    expect(h.docker.volumes.has(`${PROJECT}_pgdata`)).toBe(true);
    expect(devContainer()).toMatchObject({ name: NAME, state: 'running', image: IMAGE_1 });
    expect(devContainer()?.id).not.toBe(dev?.id);
    expect(h.progress.details).toContain(Messages.containerRecreatedDamaged());
  });

  it('a running dev container that the remote user cannot use: only it is recreated', async () => {
    await seedCompose({ dev: 'running', db: 'running', dbLabels: DB_IMAGE_ID, devLabels: { 'devcontainer.metadata': JSON.stringify([{ remoteUser: 'vscode' }]) } });
    const dev = devContainer();
    const db = dbContainer();
    h.docker.execHandler = (container, command) => (container === dev?.id && command[2] === 'exit 0' ? { exitCode: 1, stderr: PASSWD_DAMAGED } : {});
    h.ui.recreateAnswer = true;

    await h.service.openDevspace(ENV_ID, options());

    expect(h.ui.prompts).toEqual([`recreateContainer ${REPO}`]);
    expect(h.docker.log.filter((line) => line.startsWith('rm '))).toEqual([`rm ${dev?.id}`]);
    expect(dbContainer()).toMatchObject({ id: db?.id, state: 'running' });
    expect(h.docker.log.filter((line) => line.startsWith('volume rm'))).toEqual([]);
  });

  it('the hashes of the other services fail with helperFailed: helperFailed, nothing is removed', async () => {
    await seedCompose({ dev: 'stopped', db: 'running', dbLabels: DB_IMAGE_ID });
    const ids = h.docker.containersOf(ENV_ID).map((c) => c.id).sort();
    damageDevContainer();
    h.ui.recreateAnswer = true;
    h.helper.serviceHashes = new UserFacingError('helperFailed', Messages.helperFailed, `No such image: sha256:${'4'.repeat(64)}`);

    const error = await rejection(h.service.openDevspace(ENV_ID, options()));

    expect(error.code).toBe('helperFailed');
    expect(error.detail ?? '').not.toContain('would also create the containers of other services again');
    expect(h.docker.containersOf(ENV_ID).map((c) => c.id).sort()).toEqual(ids);
    expect(h.docker.log.filter((line) => line.startsWith('rm ') || line.startsWith('volume rm'))).toEqual([]);
  });

  it('Cancel: nothing is removed, startFailed', async () => {
    await seedCompose({ dbLabels: DB_IMAGE_ID });
    const ids = h.docker.containersOf(ENV_ID).map((c) => c.id).sort();
    damageDevContainer();

    const error = await rejection(h.service.openDevspace(ENV_ID, options()));

    expect(error.code).toBe('startFailed');
    expect(h.ui.prompts).toEqual([`recreateContainer ${REPO}`]);
    expect(h.docker.containersOf(ENV_ID).map((c) => c.id).sort()).toEqual(ids);
    expect(h.docker.log.filter((line) => line.startsWith('rm ') || line.startsWith('stop ') || line.startsWith('volume rm'))).toEqual([]);
  });

  it('a refusal of the check before the new dev container: it is not removed', async () => {
    await seedCompose({ dbLabels: DB_IMAGE_ID });
    const ids = h.docker.containersOf(ENV_ID).map((c) => c.id).sort();
    // The metadata of the devspace image is checked only when `up` creates the dev container.
    h.docker.imageConfigs.set(IMAGE_1, { User: '', Labels: { 'devcontainer.metadata': JSON.stringify([{ remoteUser: 'vscode' }, { privileged: true }]) } });
    damageDevContainer();
    h.ui.recreateAnswer = true;

    const error = await rejection(h.service.openDevspace(ENV_ID, options()));

    expect(error.code).toBe('hostAccess');
    // Refused after the question, by the check of the new dev container, before anything was removed.
    expect(h.ui.prompts).toEqual([`recreateContainer ${REPO}`]);
    expect(h.docker.containersOf(ENV_ID).map((c) => c.id).sort()).toEqual(ids);
    expect(h.docker.log.filter((line) => line.startsWith('rm ') || line.startsWith('volume rm'))).toEqual([]);
  });

  it('a damage text that cannot be tied to the dev container (it does not run, or its check passes): no question', async () => {
    await seedCompose({ dbLabels: DB_IMAGE_ID });
    // For example the shell of the database container is gone: Compose cannot start it, and the dev container stays stopped.
    h.helper.upError = () =>
      new DevcontainerCommandError(
        'devcontainer up',
        1,
        '',
        'Error response from daemon: failed to create task for container: OCI runtime create failed: runc create failed: unable to start container process: error during container init: exec: "/bin/sh": stat /bin/sh: no such file or directory',
      );

    const stopped = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(stopped.code).toBe('startFailed');
    expect(h.logger.infos.some((line) => line.includes('the fault cannot be tied to it'))).toBe(true);

    // The dev container runs after the failed `up`, but its check passes: the fault is another service's.
    h.helper.beforeUpError = () => {
      const dev = h.docker.containersOf(ENV_ID).find((c) => c.labels[LABEL_COMPOSE_SERVICE] === undefined);
      if (dev) {
        dev.state = 'running';
        dev.labels['devcontainer.metadata'] = JSON.stringify([{ remoteUser: 'vscode' }]);
      }
    };
    const running = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(running.code).toBe('startFailed');
    expect(h.docker.execs.some((exec) => exec.command[2] === 'exit 0')).toBe(true);

    expect(h.ui.prompts).toEqual([]);
    expect(h.docker.log.filter((line) => line.startsWith('rm ') || line.startsWith('volume rm'))).toEqual([]);
  });

  it('a failure of a side service that names no damage: no question', async () => {
    await seedCompose({ dbLabels: DB_IMAGE_ID });
    h.helper.upError = () => new DevcontainerCommandError('devcontainer up', 1, '', 'Error response from daemon: Bind for 127.0.0.1:5432 failed: port is already allocated');

    const error = await rejection(h.service.openDevspace(ENV_ID, options()));

    expect(error.code).toBe('startFailed');
    expect(h.ui.prompts).toEqual([]);
  });

  describe('never when Compose would create the other services again', () => {
    async function expectNotOffered(): Promise<void> {
      const ids = h.docker.containersOf(ENV_ID).map((c) => c.id).sort();
      const error = await rejection(h.service.openDevspace(ENV_ID, options()));
      expect(error.code).toBe('startFailed');
      expect(h.ui.prompts.filter((prompt) => prompt.startsWith('recreateContainer'))).toEqual([]);
      expect(h.docker.containersOf(ENV_ID).map((c) => c.id).sort()).toEqual(ids);
      expect(h.docker.log.filter((line) => line.startsWith('rm ') || line.startsWith('volume rm'))).toEqual([]);
      expect(h.logger.infos.some((line) => line.includes('is not offered to be created again'))).toBe(true);
    }

    it('after "Rebuild later" (the model is not the one of the build record)', async () => {
      await seedCompose({ dbLabels: DB_IMAGE_ID, record: { configHash: 'sha256:changed' } });
      h.ui.configurationChangedAnswer = 'later';
      damageDevContainer();
      h.ui.recreateAnswer = true;
      await expectNotOffered();
      expect(h.ui.prompts).toContain(`configurationChanged ${REPO}`);
    });

    it('in the fallback after a failed update (a newer image of the database)', async () => {
      await seedCompose({ dbLabels: DB_IMAGE_ID });
      h.checker.outcome = checked({ [BASE_IMAGE]: DIGEST_NEW, [DB_IMAGE]: DB_DIGEST_NEW }, { [FEATURE]: FEATURE_DIGEST });
      h.helper.buildError = () => new DevcontainerCommandError('devcontainer build', 1, '', 'failed to solve');
      damageDevContainer();
      h.ui.recreateAnswer = true;
      await expectNotOffered();
    });

    it('a container of another service without the current image (for example a tag that moved)', async () => {
      await seedCompose({ dbLabels: { 'com.docker.compose.image': 'sha256:an-older-postgres' } });
      damageDevContainer();
      h.ui.recreateAnswer = true;
      await expectNotOffered();
    });

    it('another version of Docker Compose than at the build', async () => {
      await seedCompose({ dbLabels: DB_IMAGE_ID });
      useCompose(h, { ...output(), version: '2.41.0' });
      damageDevContainer();
      h.ui.recreateAnswer = true;
      await expectNotOffered();
    });
  });

  it('another window recreated the dev container while the question was open: nothing is removed', async () => {
    await seedCompose({ dbLabels: DB_IMAGE_ID });
    damageDevContainer();
    h.ui.recreateContainer = async (repository) => {
      h.ui.prompts.push(`recreateContainer ${repository}`);
      // Another window replaced the damaged dev container with a healthy one.
      const old = devContainer();
      if (old) h.docker.containers.delete(old.id);
      h.docker.addContainer({
        devspaceId: ENV_ID,
        name: NAME,
        state: 'running',
        image: IMAGE_1,
        labels: { [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION), ...COMPOSE_LABELS, 'com.docker.compose.service': 'app' },
      });
      return true;
    };
    const healthy = () => devContainer()?.id;

    const error = await rejection(h.service.openDevspace(ENV_ID, options()));

    expect(error.code).toBe('startFailed');
    expect(error.detail).toBe(Messages.containerChangedMeanwhile);
    expect(healthy()).toBeDefined();
    expect(h.docker.log.filter((line) => line.startsWith('rm ') || line.startsWith('stop ') || line.startsWith('volume rm'))).toEqual([]);
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_1}`]);
    expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
  });

  describe('another service that builds its image', () => {
    const WORKER_DOCKERFILES = { worker: `FROM ${DB_IMAGE}\n` };
    const withWorker = (m: ComposeModel) => {
      m.services.worker = { build: { context: `${FOLDER}/worker`, dockerfile: 'Dockerfile' }, command: ['sleep', 'infinity'], networks: { default: null } };
    };

    async function seedWithWorker(configText: string): Promise<void> {
      const changed = { ...output(withWorker), dockerfiles: WORKER_DOCKERFILES };
      h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText } };
      h.helper.composeOutput = changed;
      // The build record is of this configuration: no configuration change, no "Rebuild later".
      await seedCompose({
        dbLabels: DB_IMAGE_ID,
        record: {
          configHash: composeConfigHash(configText, changed.model, WORKER_DOCKERFILES),
          compose: {
            service: 'app',
            images: [`${PROJECT}-app`, `${PROJECT}-worker`],
            serviceImages: [DB_IMAGE],
            version: '2.40.3',
            inputsHash: composeInputsHash(configText, 'inputs-1', WORKER_DOCKERFILES),
          },
        },
      });
      h.docker.images.add(`${PROJECT}-worker`);
      damageDevContainer();
      h.ui.recreateAnswer = true;
    }

    it('a service with build: (all services are started): no question, nothing removed, the log says why', async () => {
      await seedWithWorker(CONFIG_TEXT);

      const error = await rejection(h.service.openDevspace(ENV_ID, options()));

      expect(error.code).toBe('startFailed');
      expect(h.ui.prompts.filter((prompt) => prompt.startsWith('recreateContainer'))).toEqual([]);
      expect(h.logger.infos.some((line) => line.includes('other services build their images (worker)'))).toBe(true);
      expect(h.docker.log.filter((line) => line.startsWith('rm ') || line.startsWith('stop ') || line.startsWith('volume rm'))).toEqual([]);
    });

    it('runServices without the built service: still offered, only the dev container is recreated', async () => {
      await seedWithWorker(CONFIG_TEXT.replace('"service": "app",', '"service": "app",\n  "runServices": ["db"],'));
      const dev = devContainer();
      const db = dbContainer();

      await h.service.openDevspace(ENV_ID, options());

      expect(h.ui.prompts).toContain(`recreateContainer ${REPO}`);
      expect(h.docker.log.filter((line) => line.startsWith('rm '))).toEqual([`rm ${dev?.id}`]);
      expect(dbContainer()?.id).toBe(db?.id);
    });
  });

  describe('another service that shares a namespace or the volumes of another service', () => {
    // Of a third service `cache` (the policy refuses `pid` and `volumes_from` of the dev service).
    it.each<[string, (db: Record<string, unknown>) => void, string]>([
      ['network_mode service:cache', (db) => (db.network_mode = 'service:cache'), 'db: network_mode service:cache'],
      ['ipc service:cache', (db) => (db.ipc = 'service:cache'), 'db: ipc service:cache'],
      ['pid service:cache', (db) => (db.pid = 'service:cache'), 'db: pid service:cache'],
      ['volumes_from cache', (db) => (db.volumes_from = ['cache']), 'db: volumes_from cache'],
    ])('%s: no question (the direct check could never pass), and the log says why', async (_name, change, item) => {
      const changed = output((m) => {
        m.services.cache = { image: DB_IMAGE, command: ['sleep', 'infinity'], networks: { default: null } };
        if ((m.services.db as Record<string, unknown>).network_mode === undefined) delete m.services.db.networks;
        change(m.services.db as Record<string, unknown>);
        if ((m.services.db as Record<string, unknown>).network_mode === undefined) m.services.db.networks = { default: null };
      });
      // The build record is of this model: no configuration change, no "Rebuild later".
      await seedCompose({ dbLabels: DB_IMAGE_ID, record: { configHash: composeConfigHash(CONFIG_TEXT, changed.model, {}) } });
      useCompose(h, changed);
      damageDevContainer();
      h.ui.recreateAnswer = true;

      const error = await rejection(h.service.openDevspace(ENV_ID, options()));

      expect(error.code).toBe('startFailed');
      expect(h.ui.prompts.filter((prompt) => prompt.startsWith('recreateContainer'))).toEqual([]);
      expect(h.logger.infos.some((line) => line.includes('share a namespace or the volumes of another service') && line.includes(item))).toBe(true);
      expect(h.docker.log.filter((line) => line.startsWith('rm ') || line.startsWith('volume rm'))).toEqual([]);
    });
  });

  describe('the direct check of the other services right before up', () => {
    /** A first open creates the containers as Compose does (their labels: the hash of the model, the image ID). */
    async function openedDevspace(): Promise<{ devId: string; dbId: string }> {
      h.helper.serviceHashes = undefined;
      await h.service.open(TARGET, options());
      for (const c of h.docker.containersOf(ENV_ID)) {
        c.state = 'stopped';
        c.rawState = 'exited';
      }
      h.ui.prompts.length = 0;
      h.docker.log.length = 0;
      return { devId: String(devContainer()?.id), dbId: String(dbContainer()?.id) };
    }

    async function expectRefusedAfterAnswer(dbId: string, devId: string): Promise<void> {
      const error = await rejection(h.service.openDevspace(ENV_ID, options()));
      expect(error.code).toBe('startFailed');
      expect(error.detail).toBe(Messages.composeServicesWouldBeRecreated('db'));
      expect(h.ui.prompts).toEqual([`recreateContainer ${REPO}`]);
      // Nothing was stopped or removed; no `up` replaced anything.
      expect(h.docker.log.filter((line) => line.startsWith('rm ') || line.startsWith('stop ') || line.startsWith('volume rm'))).toEqual([]);
      expect(dbContainer()?.id).toBe(dbId);
      expect(devContainer()?.id).toBe(devId);
      expect(h.helper.calls.filter((call) => call.includes('--remove-existing-container'))).toEqual([]);
      expect(h.logger.warnings.some((line) => line.startsWith(`Docker Compose would create the service db of ${REPO} again`))).toBe(true);
      expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
    }

    it('computes the hashes with the helper image of the open', async () => {
      await openedDevspace();
      damageDevContainer();
      h.ui.recreateAnswer = true;
      // There is no previous helper image: the helper image of this open is the current tag with another image ID than
      // the first open's.
      h.helper.currentHelperImageId = `sha256:${'5'.repeat(64)}`;
      h.helper.helperImages.length = 0;
      await h.service.openDevspace(ENV_ID, options());
      const previous = { tag: 'devspaces-worker:test', id: `sha256:${'5'.repeat(64)}` };
      const hashes = h.helper.helperImages.filter((entry) => entry.call === 'composeServiceHashes');
      expect(hashes.length).toBeGreaterThan(0);
      expect(hashes.filter((entry) => JSON.stringify(entry.image) !== JSON.stringify(previous))).toEqual([]);
    });

    it('the happy path: the hashes of the exact up model and the image IDs match; only the dev container is recreated', async () => {
      const { devId, dbId } = await openedDevspace();
      damageDevContainer();
      h.ui.recreateAnswer = true;

      await h.service.openDevspace(ENV_ID, options());

      // The hashes come from the model that `up` got.
      expect(h.helper.hashModels.at(-1)).toBe(h.helper.ups.at(-1)?.files?.[COMPOSE_MODEL_PATH]);
      expect(h.helper.calls.indexOf(`composeServiceHashes ${PROJECT}`)).toBeLessThan(h.helper.calls.lastIndexOf(`up ${IMAGE_1} --remove-existing-container`));
      expect(h.docker.log.filter((line) => line.startsWith('rm '))).toEqual([`rm ${devId}`]);
      expect(dbContainer()?.id).toBe(dbId);
      expect(devContainer()?.id).not.toBe(devId);
    });

    it('the host access checks were turned off after the containers were created: no recreation, nothing removed', async () => {
      const { devId, dbId } = await openedDevspace();
      h.settings = { ...h.settings, hostAccessChecksOff: [REPO] };
      damageDevContainer();
      h.ui.recreateAnswer = true;
      await expectRefusedAfterAnswer(dbId, devId);
    });

    it('a build record rewritten without new containers, but the database container from an older Compose (another hash)', async () => {
      const { devId, dbId } = await openedDevspace();
      const db = h.docker.containers.get(dbId);
      if (db) db.labels['com.docker.compose.config-hash'] = 'hash-of-an-older-compose';
      damageDevContainer();
      h.ui.recreateAnswer = true;
      await expectRefusedAfterAnswer(dbId, devId);
    });

    it('the tag of the database image moves while the question is open: no recreation, nothing removed', async () => {
      const { devId, dbId } = await openedDevspace();
      damageDevContainer();
      h.ui.recreateContainer = async (repository) => {
        h.ui.prompts.push(`recreateContainer ${repository}`);
        // Another devspace pulled a newer postgres:16.
        h.docker.imageIds.set(DB_IMAGE, 'sha256:a-newer-postgres');
        return true;
      };
      await expectRefusedAfterAnswer(dbId, devId);
    });

    it('a container without the hash label, or a failed hash computation: no recreation', async () => {
      const { devId, dbId } = await openedDevspace();
      damageDevContainer();
      h.ui.recreateAnswer = true;
      h.helper.serviceHashes = new CommandError('docker compose config --hash', 1, '', 'unknown flag: --hash');
      await expectRefusedAfterAnswer(dbId, devId);
      expect(h.logger.warnings.some((line) => line.includes('could not be computed'))).toBe(true);
    });
  });

  it('the folders of the dev container in volumes without a name are named; nothing removes them', async () => {
    await seedCompose({ dev: 'stopped', db: 'running', dbLabels: DB_IMAGE_ID });
    const dev = devContainer();
    const anonymous = 'b'.repeat(64);
    if (dev) h.docker.containers.set(dev.id, { ...dev, mountTargets: [{ type: 'volume', volume: anonymous, target: `${FOLDER}/node_modules` }] });
    h.docker.volumes.set(anonymous, {});
    damageDevContainer();
    h.ui.recreateAnswer = true;

    await h.service.openDevspace(ENV_ID, options());

    expect(h.ui.recreateQuestions[0].detail).toBe(Messages.containerRecreateDetail(true, [`${FOLDER}/node_modules`]));
    expect(h.progress.details).toContain(Messages.containerRecreatedDamaged([`${FOLDER}/node_modules`]));
    expect(h.docker.volumes.has(anonymous)).toBe(true);
    expect(h.docker.log.filter((line) => line.startsWith('volume rm'))).toEqual([]);
  });
});

describe('run-user-commands of Docker Compose fails with helperFailed after up returned', () => {
  const gone = () => new UserFacingError('helperFailed', Messages.helperFailed, `No such image: sha256:${'4'.repeat(64)}`);

  /** The next open with the helper back and the updates off runs `up` and the lifecycle commands, and the dev container runs. */
  async function nextOpenRunsLifecycle(): Promise<void> {
    h.helper.userCommandsError = undefined;
    h.settings.updateImagesOnConnect = false;
    const runs = h.helper.userCommandRuns.length;
    h.helper.calls.length = 0;
    await h.service.openDevspace(ENV_ID, options());
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toHaveLength(1);
    expect(h.helper.userCommandRuns.length).toBe(runs + 1);
    expect(devContainer()?.state).toBe('running');
  }

  it('an update of Docker Compose whose run-user-commands fails with helperFailed removes the new dev container', async () => {
    await seedCompose({ dev: 'running', db: 'running', dbLabels: { 'com.docker.compose.image': `sha256:image-of-${DB_IMAGE}`, 'com.docker.compose.config-hash': 'hash-of-db' } });
    const dev = devContainer()?.id;
    h.checker.outcome = checked({ [BASE_IMAGE]: DIGEST_NEW, [DB_IMAGE]: DB_DIGEST_NEW }, { [FEATURE]: FEATURE_DIGEST });
    h.helper.userCommandsError = new UserFacingError('helperFailed', Messages.helperFailed, 'No such image: x');
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('helperFailed');
    expect(h.helper.ups).toHaveLength(1);
    expect(devContainer()?.id).not.toBe(dev);
    expect(devContainer()).toBeUndefined();
    expect(error.detail).toContain('It was removed; the next open creates it again. No such image: x');
    expect(h.docker.images.has(IMAGE_2)).toBe(false);
    h.helper.userCommandsError = undefined;
    const runs = h.helper.userCommandRuns.length;
    await h.service.openDevspace(ENV_ID, options());
    expect(h.helper.userCommandRuns.length).toBe(runs + 1);
    expect(devContainer()?.state).toBe('running');
  });

  it('Step 9: the stopped containers that `up` started are stopped again, and the next open runs up and the lifecycle commands', async () => {
    await seedCompose({ dev: 'stopped', db: 'stopped' });
    const dev = devContainer()!;
    const db = dbContainer()!;
    h.helper.userCommandsError = gone();
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('helperFailed');
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_1}`]);
    expect(error.detail).toBe(
      `The container was started, but its lifecycle commands could not run. It was stopped; the next open starts it again and runs its lifecycle commands. No such image: sha256:${'4'.repeat(64)}`,
    );
    expect(devContainer()).toMatchObject({ id: dev.id, state: 'stopped' });
    // The side service that `up` started (it did not run before) is stopped too.
    expect(dbContainer()).toMatchObject({ id: db.id, state: 'stopped' });
    await nextOpenRunsLifecycle();
    expect(devContainer()?.id).toBe(dev.id);
  });

  it('Step 9: a side service that ran before `up` keeps running', async () => {
    await seedCompose({ dev: 'stopped', db: 'running' });
    const db = dbContainer()!;
    h.helper.userCommandsError = gone();
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('helperFailed');
    expect(devContainer()?.state).toBe('stopped');
    expect(dbContainer()).toMatchObject({ id: db.id, state: 'running' });
    expect(h.docker.log).not.toContain(`stop ${db.id}`);
  });

  it('a switch of a single container to Docker Compose whose run-user-commands fails with helperFailed removes the new dev container, and the detail is true', async () => {
    await seedDevspace(h, { container: 'stopped' });
    h.docker.images.add(DB_IMAGE);
    const single = h.docker.containersOf(ENV_ID)[0];
    h.ui.configurationChangedAnswer = 'rebuildNow';
    h.helper.userCommandsError = gone();
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('helperFailed');
    expect(error.detail).toBe(
      `The configuration now uses Docker Compose. Its dev container was created, but its lifecycle commands could not run. It was removed. The devspace is not started with its previous containers, which belong to the previous configuration; rebuild it to try again. The change removed the container ${single.name}. The containers that Docker Compose had created were removed again: the container ${PROJECT}-db-1 of the service db. The files in the volumes are kept. No such image: sha256:${'4'.repeat(64)}`,
    );
    expect(h.docker.containersOf(ENV_ID)).toEqual([]);
    expect(h.docker.images.has(IMAGE_2)).toBe(false);
  });

  it('a one-off container of the project (without the ID label) that ran before `up` keeps running', async () => {
    await seedCompose({ dev: 'stopped', db: 'running' });
    const oneOff: ContainerInfo = {
      id: 'one-off-1',
      name: `${PROJECT}-db-run-1`,
      state: 'running',
      rawState: 'running',
      image: DB_IMAGE,
      labels: { 'com.docker.compose.project': PROJECT, 'com.docker.compose.service': 'db', 'com.docker.compose.oneoff': 'True' },
    };
    h.docker.containers.set(oneOff.id, oneOff);
    h.helper.userCommandsError = gone();
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('helperFailed');
    expect(h.docker.containers.get(oneOff.id)?.state).toBe('running');
    expect(h.docker.log).not.toContain(`stop ${oneOff.id}`);
  });

  it('the containers cannot be listed before `up`: the open ends with helperFailed, and the dev container is stopped', async () => {
    await seedCompose({ dev: 'stopped', db: 'stopped' });
    const dev = devContainer()!;
    const list = h.docker.listDevspaceContainers.bind(h.docker);
    h.docker.listDevspaceContainers = async () => {
      if (new Error().stack?.includes('containersBeforeUp')) throw new CommandError('docker ps', 1, '', 'Cannot connect to the Docker daemon');
      return list();
    };
    h.helper.userCommandsError = gone();
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('helperFailed');
    expect(error.detail).toBe(`The container was started, but its lifecycle commands could not run. It was stopped; the next open starts it again and runs its lifecycle commands. No such image: sha256:${'4'.repeat(64)}`);
    expect(devContainer()).toMatchObject({ id: dev.id, state: 'stopped' });
  });

  it('a switch to Docker Compose whose new dev container cannot be removed at once: the cleanup of the switch removes it, and the detail names it once, as removed', async () => {
    await seedDevspace(h, { container: 'stopped' });
    h.docker.images.add(DB_IMAGE);
    const single = h.docker.containersOf(ENV_ID)[0];
    h.ui.configurationChangedAnswer = 'rebuildNow';
    const remove = h.docker.removeContainer.bind(h.docker);
    h.docker.removeContainer = async (ref) => {
      if (new Error().stack?.includes('withdrawAfterHelperFailed')) throw new CommandError('docker rm', 1, '', 'Cannot connect to the Docker daemon');
      return remove(ref);
    };
    h.helper.userCommandsError = gone();
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('helperFailed');
    expect(error.detail).toBe(
      `The configuration now uses Docker Compose. Its dev container was created, but its lifecycle commands could not run. It was removed. The devspace is not started with its previous containers, which belong to the previous configuration; rebuild it to try again. The change removed the container ${single.name}. The containers that Docker Compose had created were removed again: the container ${PROJECT}-db-1 of the service db. The files in the volumes are kept. No such image: sha256:${'4'.repeat(64)}`,
    );
    expect(h.docker.containersOf(ENV_ID)).toEqual([]);
  });

  it('a switch to Docker Compose whose new dev container can be neither removed nor stopped at once: the cleanup of the switch removes it and clears the mark', async () => {
    await seedDevspace(h, { container: 'stopped' });
    h.docker.images.add(DB_IMAGE);
    h.ui.configurationChangedAnswer = 'rebuildNow';
    const remove = h.docker.removeContainer.bind(h.docker);
    const stop = h.docker.stopContainer.bind(h.docker);
    h.docker.removeContainer = async (ref) => {
      if (new Error().stack?.includes('withdrawAfterHelperFailed')) throw new CommandError('docker rm', 1, '', 'Cannot connect to the Docker daemon');
      return remove(ref);
    };
    h.docker.stopContainer = async (ref) => {
      if (new Error().stack?.includes('withdrawAfterHelperFailed')) throw new CommandError('docker stop', 1, '', 'Cannot connect to the Docker daemon');
      return stop(ref);
    };
    h.helper.userCommandsError = gone();
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('helperFailed');
    expect(error.detail).toContain('Its dev container was created, but its lifecycle commands could not run. It was removed. The devspace');
    expect(error.detail).toContain(`were removed again: the container ${PROJECT}-db-1 of the service db. The files`);
    expect(h.docker.containersOf(ENV_ID)).toEqual([]);
    expect((await h.registry.get(ENV_ID))?.lifecycleIncomplete).toBeUndefined();
  });

  it('the containers cannot be listed before `up`: the side services are left as they are, and the log says so', async () => {
    await seedCompose({ dev: 'stopped', db: 'stopped' });
    const db = dbContainer()!;
    const list = h.docker.listDevspaceContainers.bind(h.docker);
    h.docker.listDevspaceContainers = async () => {
      if (new Error().stack?.includes('containersBeforeUp')) throw new CommandError('docker ps', 1, '', 'Cannot connect to the Docker daemon');
      return list();
    };
    h.helper.userCommandsError = gone();
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('helperFailed');
    expect(devContainer()?.state).toBe('stopped');
    expect(dbContainer()).toMatchObject({ id: db.id, state: 'running' });
    expect(h.docker.log).not.toContain(`stop ${db.id}`);
    expect(h.logger.infos.join('\n')).toContain('was created or started, but its lifecycle commands did not run. It is stopped');
    expect(h.logger.infos.join('\n')).toContain('The containers of the other services of acme/api are left as they are: it is not known which of them ran before up.');
  });
});

describe('Step 9 next to other windows, and build records of Docker Compose', () => {
  const gone = () => new UserFacingError('helperFailed', Messages.helperFailed, `No such image: sha256:${'4'.repeat(64)}`);
  const WINDOW_B = 'window-b';
  const PID_B = 5252;
  const touched = (): string[] => h.docker.log.filter((line) => line.startsWith('stop') || line.startsWith('rm'));

  /** A harness whose window status files name window B, connected to the devspace. */
  function withWindowB(): void {
    h.cleanup();
    const live: WindowStatus[] = [{ windowId: WINDOW_B, pid: PID_B, devspaceId: ENV_ID, state: 'active', updatedAt: new Date(T0).toISOString() }];
    h = createHarness({ newDevspaceId: () => ENV_ID, windowStatuses: async () => live });
    useCompose(h);
    h.alivePids.add(PID_B);
  }

  /**
   * The build record of Docker Compose (the previous configuration stays selected after a failed switch to a single
   * container), and the new single container of that switch, which was left running for another window and marked
   * (Devspace.lifecycleIncomplete).
   */
  async function seedMarkedSingle(): Promise<ContainerInfo> {
    await seedCompose({ dev: null, db: 'running' });
    const single = h.docker.addContainer({ devspaceId: ENV_ID, name: NAME, state: 'running', image: IMAGE_2 });
    h.docker.images.add(IMAGE_2);
    await h.registry.updateDevspace(ENV_ID, (devspace) => {
      devspace.lifecycleIncomplete = single.id;
    });
    h.settings.updateImagesOnConnect = false;
    return single;
  }

  it('Step 9 does not remove the marked single container that another window uses; the open ends with startFailed and changes nothing', async () => {
    withWindowB();
    const single = await seedMarkedSingle();
    const db = dbContainer()!;
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('startFailed');
    expect(error.message).toBe(PipelineTexts.startFailed);
    expect(error.detail).toBe(
      `To start the devspace with its Docker Compose configuration, the container ${NAME}, which Docker Compose did not create, must be removed, but another window is connected to the devspace. Nothing was stopped, removed, or renamed. Open or rebuild the devspace again when that window is closed.`,
    );
    // runComposeUp never stops and removes it (`docker rm -f`): the files of window B outside the volumes would be
    // lost.
    expect(touched()).toEqual([]);
    expect(h.helper.ups).toEqual([]);
    expect(h.docker.containers.get(single.id)).toMatchObject({ state: 'running' });
    expect(h.docker.containers.get(db.id)).toMatchObject({ state: 'running' });
    const after = await h.registry.get(ENV_ID);
    expect(after?.lifecycleIncomplete).toBe(single.id);
    // The busy mark of the check is gone again.
    expect(after?.busy).toBeUndefined();
  });

  it('the same while another window is opening the devspace (its pending connection file)', async () => {
    const single = await seedMarkedSingle();
    h.sessionFiles.readPendings = async () => [{ devspaceId: ENV_ID, windowId: WINDOW_B, createdAt: new Date(T0).toISOString() }];
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('startFailed');
    expect(error.detail).toContain('must be removed, but another window is opening the devspace. Nothing was stopped, removed, or renamed.');
    expect(touched()).toEqual([]);
    expect(h.docker.containers.get(single.id)).toMatchObject({ state: 'running' });
  });

  it('the same when the files of the windows cannot be read', async () => {
    const single = await seedMarkedSingle();
    h.sessionFiles.readPendings = async () => {
      throw new Error('unreadable pendings');
    };
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('startFailed');
    expect(error.detail).toContain('must be removed, but it could not be checked whether another window uses the devspace.');
    expect(touched()).toEqual([]);
    expect(h.docker.containers.get(single.id)).toMatchObject({ state: 'running' });
  });

  it('without another window, the single container is replaced with the busy mark set, and the mark goes with the open', async () => {
    const single = await seedMarkedSingle();
    let busyAtRemoval: unknown;
    const remove = h.docker.removeContainer.bind(h.docker);
    h.docker.removeContainer = async (ref) => {
      busyAtRemoval = (await h.registry.get(ENV_ID))?.busy;
      return remove(ref);
    };
    await h.service.openDevspace(ENV_ID, options());
    expect(h.docker.log).toContain(`rm ${single.id}`);
    expect(busyAtRemoval).toMatchObject({ operation: 'update', pid: PID, windowId: WINDOW_ID });
    expect(devContainer()?.state).toBe('running');
    const after = await h.registry.get(ENV_ID);
    expect(after?.lifecycleIncomplete).toBeUndefined();
    expect(after?.busy).toBeUndefined();
  });

  /** The single container of seedMarkedSingle, stopped (with the service db in `db`). */
  async function seedStoppedSingle(db: 'running' | 'stopped'): Promise<ContainerInfo> {
    await seedCompose({ dev: null, db });
    const single = h.docker.addContainer({ devspaceId: ENV_ID, name: NAME, state: 'stopped', image: IMAGE_2 });
    h.docker.images.add(IMAGE_2);
    h.settings.updateImagesOnConnect = false;
    return single;
  }

  it('nothing of the devspace runs: window B `active` does not keep the stopped single container from being replaced', async () => {
    withWindowB();
    const single = await seedStoppedSingle('stopped');
    const result = await h.service.openDevspace(ENV_ID, options());
    expect(result.containerName).toBe(NAME);
    // Not startFailed "…must be removed, but another window is connected to the devspace."
    expect(h.docker.log).toContain(`rm ${single.id}`);
    expect(devContainer()?.state).toBe('running');
    expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
  });

  it('the single container is stopped, but the service db runs: window B counts, nothing is changed', async () => {
    withWindowB();
    const single = await seedStoppedSingle('running');
    const db = dbContainer()!;
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('startFailed');
    expect(error.detail).toBe(
      `To start the devspace with its Docker Compose configuration, the container ${NAME}, which Docker Compose did not create, must be removed, but another window is connected to the devspace. Nothing was stopped, removed, or renamed. Open or rebuild the devspace again when that window is closed.`,
    );
    expect(touched()).toEqual([]);
    expect(h.helper.ups).toEqual([]);
    expect(h.docker.containers.get(single.id)).toMatchObject({ state: 'stopped' });
    expect(h.docker.containers.get(db.id)).toMatchObject({ state: 'running' });
  });

  it('a build record of Docker Compose whose part lacks a field of a later version keeps the devspace a Docker Compose devspace', async () => {
    await seedCompose({ dev: 'stopped', db: 'stopped' });
    await h.registry.updateDevspace(ENV_ID, (devspace) => {
      delete (devspace.buildRecord!.compose as Partial<NonNullable<BuildRecord['compose']>>).inputsHash;
    });
    h.settings.updateImagesOnConnect = false;
    // The devspace does not count as a single container (every open without a build would then end with startFailed
    // "The configuration no longer uses Docker Compose, which applies with a rebuild").
    const result = await h.service.openDevspace(ENV_ID, options());
    expect(result.containerName).toBe(NAME);
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_1}`]);
    expect(devContainer()?.state).toBe('running');
  });

  it('with the configuration unreadable and the dev container gone, a build record whose part lacks a field keeps the devspace a Docker Compose devspace', async () => {
    await seedCompose({ dev: null, db: 'stopped' });
    const db = dbContainer()!;
    await h.registry.updateDevspace(ENV_ID, (devspace) => {
      delete (devspace.buildRecord!.compose as Partial<NonNullable<BuildRecord['compose']>>).inputsHash;
    });
    h.settings.updateImagesOnConnect = false;
    h.helper.readConfigurationError = new DevcontainerCommandError('devcontainer read-configuration', 1, '', 'invalid configuration');
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('startFailed');
    expect(error.detail).toContain('The Docker Compose configuration cannot be read, and the devspace has no container.');
    // Never a single container from the image of the Docker Compose dev service: no `up` at all.
    expect(h.helper.ups).toEqual([]);
    expect(h.docker.containersOf(ENV_ID).filter((c) => c.name === NAME)).toEqual([]);
    // Nothing destructive either: the container of the service db stays, and nothing was removed.
    expect(h.docker.containers.get(db.id)).toMatchObject({ id: db.id, state: 'stopped' });
    expect(h.docker.log.filter((line) => line.startsWith('rm'))).toEqual([]);
  });

  it('a switch to Docker Compose whose listing before `up` failed says "created or started"', async () => {
    await seedDevspace(h, { container: 'stopped' });
    h.docker.images.add(DB_IMAGE);
    h.ui.configurationChangedAnswer = 'rebuildNow';
    const list = h.docker.listDevspaceContainers.bind(h.docker);
    h.docker.listDevspaceContainers = async () => {
      if (new Error().stack?.includes('containersBeforeUp')) throw new CommandError('docker ps', 1, '', 'Cannot connect to the Docker daemon');
      return list();
    };
    h.helper.userCommandsError = gone();
    const error = await rejection(h.service.openDevspace(ENV_ID, options()));
    expect(error.code).toBe('helperFailed');
    // Not "Its dev container was created", which the listing could not tell.
    expect(error.detail).toContain('The configuration now uses Docker Compose. Its dev container was created or started, but its lifecycle commands could not run.');
  });
});

// After a rebuild, the images that Compose built under the same names as before (`<project>-<service>`, the images of
// the new build record, with this devspace's ID) are not removed.
describe('a rebuild keeps the images of the project that it just built', () => {
  it('does not remove `<project>-app` that the old and the new build record name', async () => {
    await seedCompose({ record: { images: { [BASE_IMAGE]: DIGEST_NEW, [DB_IMAGE]: DB_DIGEST } } });
    h.docker.images.add(`${PROJECT}-app`);
    h.docker.imageConfigs.set(`${PROJECT}-app`, { User: '', Labels: { [LABEL_DEVSPACE_ID]: ENV_ID } });
    h.checker.outcome = checked({ [BASE_IMAGE]: DIGEST_NEW, [DB_IMAGE]: DB_DIGEST_NEW }, { [FEATURE]: FEATURE_DIGEST });
    await h.service.openDevspace(ENV_ID, options());
    expect(h.helper.builds.map((build) => build.imageName)).toEqual([IMAGE_2]);
    expect((await h.registry.get(ENV_ID))?.buildRecord?.compose?.images).toEqual([`${PROJECT}-app`]);
    expect(h.docker.log).not.toContain(`rmi ${PROJECT}-app`);
    expect(h.docker.images.has(`${PROJECT}-app`)).toBe(true);
    // The old devspace image goes, as after every update.
    expect(h.docker.images.has(IMAGE_1)).toBe(false);
  });
});

describe('the shared VS Code server store in Docker Compose', () => {
  const SERVER = { commit: '0123456789abcdef0123456789abcdef01234567', quality: 'stable' as const };

  it('the up model mounts the store read-only into the dev service; it is never created or recorded as a volume of the devspace', async () => {
    h.cleanup();
    h = createHarness({ newDevspaceId: () => ENV_ID, vscodeStoreVolume: 'devspaces-vscode', vscodeServer: { server: SERVER, fetch: async () => 'linux-x64' } });
    useCompose(h);
    await h.service.open(TARGET, options());
    const m = upModel();
    // `volume: { nocopy: true }`, so that Docker never copies the image's /opt/devspace/vscode into an empty store.
    expect(m.services.app.volumes).toContainEqual({ type: 'volume', source: 'devspaces-vscode', target: '/opt/devspace/vscode', read_only: true, volume: { nocopy: true } });
    expect(m.volumes?.['devspaces-vscode']).toEqual({ name: 'devspaces-vscode', external: true });
    expect(JSON.stringify(m.services.db)).not.toContain('devspaces-vscode');
    expect(h.docker.log.filter((line) => line.includes('devspaces-vscode'))).toEqual([]);
    expect(h.docker.volumes.has('devspaces-vscode')).toBe(false);
    expect(JSON.stringify(await h.registry.get(ENV_ID))).not.toContain('devspaces-vscode');
  });

  it('without a server: the up model has no store', async () => {
    h.cleanup();
    h = createHarness({ newDevspaceId: () => ENV_ID, vscodeStoreVolume: 'devspaces-vscode' });
    useCompose(h);
    await h.service.open(TARGET, options());
    expect(JSON.stringify(upModel())).not.toContain('devspaces-vscode');
  });
});
