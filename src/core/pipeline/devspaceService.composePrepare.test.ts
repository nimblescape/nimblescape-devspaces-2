// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The headless prepare of a Docker Compose devspace, and the swap at its open. The prepare builds the devspace
// image of the dev service to `<resource>:prepared`, with a build model whose images all have prepared names (never
// `<project>-<service>`), pulls only the base images of the dev service, and leaves the images of the other services
// (pulled or built) to the open, so the existing setup keeps exactly its images until Continue or Update Now. On the
// fakes of the harness, with deps of a prepare that know no computer.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMPOSE_MODEL_PATH, composeConfigHash, composeInputsHash, type ComposeModelOutput } from '../helper/compose';
import type { ComposeModel } from '../helper/composeModel';
import { Messages } from '../messages';
import {
  CONTAINER_VERSION,
  HOST_ACCESS_UNRESTRICTED,
  LABEL_COMPOSE_SERVICE,
  LABEL_CONTAINER_VERSION,
  LABEL_DEVSPACE_ID,
  LABEL_HOST_ACCESS,
  LABEL_PREPARED,
  composeProjectName,
  devspaceImageName,
  preparedImageName,
  preparedServiceImageName,
} from '../names';
import type { BuildRecord, Devspace } from '../types';
import {
  ACCOUNT,
  BASE_IMAGE,
  DIGEST_NEW,
  DIGEST_OLD,
  ENV_ID,
  FEATURE,
  FEATURE_DIGEST,
  REPO,
  checked,
  createHarness,
  headlessPrepareService,
  imageConfigWithUser,
  prepareRun,
  seedDevspace,
  type Harness,
} from './devspaceService.testkit';
import { imageRecordLabels, preparedImageLabels, type PrepareKey } from './imageRecord';
import { DEFAULT_CONFIG_PATH } from './recordRules';

const PROJECT = composeProjectName(REPO, ENV_ID);
const IMAGE_1 = devspaceImageName(REPO, ENV_ID, 1);
const IMAGE_2 = devspaceImageName(REPO, ENV_ID, 2);
const PREPARED = preparedImageName(REPO, ENV_ID);
const PREPARED_WORKER = preparedServiceImageName(REPO, ENV_ID, 'worker');
const FOLDER = '/workspaces/api';
const DB_IMAGE = 'postgres:16';
const DB_DIGEST = `sha256:${'d'.repeat(64)}`;
const DB_DIGEST_NEW = `sha256:${'e'.repeat(64)}`;
/** The base image of the built service `worker`. */
const NODE_IMAGE = 'node:20';
const NODE_DIGEST = `sha256:${'1'.repeat(64)}`;
const NODE_DIGEST_NEW = `sha256:${'2'.repeat(64)}`;
const COMPOSE_LABELS = { 'com.docker.compose.project': PROJECT, 'com.docker.compose.container-number': '1' };
/** The images of the existing setup, by their IDs: a prepare must leave every one of them as it is. */
const SETUP_IMAGES: Record<string, string> = {
  [`${PROJECT}-app`]: `sha256:${'3'.repeat(64)}`,
  [`${PROJECT}-worker`]: `sha256:${'4'.repeat(64)}`,
  [DB_IMAGE]: `sha256:${'5'.repeat(64)}`,
  [NODE_IMAGE]: `sha256:${'6'.repeat(64)}`,
};

const CONFIG_TEXT = `{
  "name": "API",
  "dockerComposeFile": ["compose.yml"],
  "service": "app",
  "workspaceFolder": "/workspaces/\${localWorkspaceFolderBasename}",
  "features": { "${FEATURE}": {} },
  "remoteUser": "vscode"
}`;

const DOCKERFILES = { worker: `FROM ${NODE_IMAGE}\n` };

/** The merged model: the dev service `app` (image only), the database `db` (pulled), and `worker` (built). */
function model(): ComposeModel {
  return {
    name: PROJECT,
    services: {
      app: { image: BASE_IMAGE, command: ['sleep', 'infinity'], networks: { default: null } },
      db: {
        image: DB_IMAGE,
        volumes: [{ type: 'volume', source: 'pgdata', target: '/var/lib/postgresql/data', volume: {} }],
        networks: { default: null },
      },
      worker: { build: { context: `${FOLDER}/worker`, dockerfile: 'Dockerfile' }, command: ['sleep', 'infinity'], networks: { default: null } },
    },
    networks: { default: { name: `${PROJECT}_default` } },
    volumes: { pgdata: { name: `${PROJECT}_pgdata` } },
  };
}

function output(changes: (m: ComposeModel) => void = () => undefined, version = '2.40.3'): ComposeModelOutput {
  const m = model();
  changes(m);
  return { version, dollarEscaped: true, model: m, dockerfiles: { ...DOCKERFILES }, realPaths: {}, inputsHash: 'inputs-1' };
}

const HASH = composeConfigHash(CONFIG_TEXT, model(), DOCKERFILES);
const OLD_DIGESTS = { [BASE_IMAGE]: DIGEST_OLD, [DB_IMAGE]: DB_DIGEST, [NODE_IMAGE]: NODE_DIGEST };
/** The key of the update of the seeded record to the default check outcome (updateKey): a new base of the dev service. */
const KEY: PrepareKey = {
  configPath: DEFAULT_CONFIG_PATH,
  configHash: HASH,
  images: { [BASE_IMAGE]: DIGEST_NEW, [DB_IMAGE]: DB_DIGEST, [NODE_IMAGE]: NODE_DIGEST },
  features: { [FEATURE]: FEATURE_DIGEST },
};
const ENV = { id: ENV_ID, repository: REPO, owner: ACCOUNT };

let h: Harness;
let hostUses: string[];

beforeEach(() => {
  h = createHarness();
  hostUses = [];
  h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: CONFIG_TEXT } };
  h.helper.composeOutput = output();
  h.checker.outcome = checked({ [BASE_IMAGE]: DIGEST_NEW, [DB_IMAGE]: DB_DIGEST, [NODE_IMAGE]: NODE_DIGEST }, { [FEATURE]: FEATURE_DIGEST });
});

afterEach(() => {
  h.cleanup();
});

/**
 * A Docker Compose devspace built from the record of the approved configuration (its image labelled with it, as a
 * build of the open does), with its dev, database, and worker containers, and the images of its setup.
 */
async function seedCompose(p: { dev?: 'running' | 'stopped'; record?: Partial<BuildRecord>; dbLabels?: Record<string, string> } = {}): Promise<Devspace> {
  const env = await seedDevspace(h, {
    container: p.dev ?? 'stopped',
    containerLabels: { [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION), ...COMPOSE_LABELS, 'com.docker.compose.service': 'app' },
    record: {
      configHash: HASH,
      images: OLD_DIGESTS,
      compose: {
        service: 'app',
        images: [`${PROJECT}-app`, `${PROJECT}-worker`],
        serviceImages: [DB_IMAGE],
        version: '2.40.3',
        inputsHash: composeInputsHash(CONFIG_TEXT, 'inputs-1', DOCKERFILES),
      },
      ...p.record,
    },
  });
  const record = env.buildRecord as BuildRecord;
  const config = imageConfigWithUser('vscode');
  h.docker.imageConfigs.set(record.devspaceImage, { ...config, Labels: { ...config.Labels, ...imageRecordLabels(env, record) } });
  for (const [image, id] of Object.entries(SETUP_IMAGES)) {
    h.docker.images.add(image);
    h.docker.imageIds.set(image, id);
    if (image.startsWith(`${PROJECT}-`)) h.docker.imageConfigs.set(image, { Labels: { [LABEL_DEVSPACE_ID]: ENV_ID } });
  }
  for (const [service, image] of [
    ['db', DB_IMAGE],
    ['worker', `${PROJECT}-worker`],
  ]) {
    h.docker.addContainer({
      devspaceId: ENV_ID,
      name: `${PROJECT}-${service}-1`,
      state: 'stopped',
      image,
      labels: { [LABEL_COMPOSE_SERVICE]: service, ...COMPOSE_LABELS, 'com.docker.compose.service': service, ...(service === 'db' ? p.dbLabels : {}) },
    });
  }
  return env;
}

async function prepare() {
  const { run, events } = prepareRun();
  const headless = headlessPrepareService(h);
  hostUses = headless.hostUses;
  const result = await headless.service.prepare(ENV_ID, run);
  return { result, events };
}

async function open() {
  return h.service.openDevspace(ENV_ID, { progress: h.progress });
}

/** The images of the existing setup still have their IDs, and no tag of them was moved. */
function setupUnchanged(): void {
  for (const [image, id] of Object.entries(SETUP_IMAGES)) {
    expect(h.docker.images.has(image)).toBe(true);
    expect(h.docker.imageIds.get(image)).toBe(id);
  }
  expect(h.docker.log.filter((line) => line.startsWith('tag ') && !line.endsWith(IMAGE_2))).toEqual([]);
}

function buildModel(index = -1): ComposeModel {
  return JSON.parse(h.helper.builds.at(index)?.files?.[COMPOSE_MODEL_PATH] ?? 'null') as ComposeModel;
}

function upModel(index = -1): ComposeModel {
  return JSON.parse(h.helper.ups.at(index)?.files?.[COMPOSE_MODEL_PATH] ?? 'null') as ComposeModel;
}

/** A prepared image on the engine with the labels of a prepare, changed by `key`, `helperImage`, or `labels`. */
function addPrepared(options: { key?: PrepareKey; helperImage?: string; labels?: Record<string, string>; metadata?: Array<Record<string, unknown>> } = {}): string {
  const id = `sha256:${'9'.repeat(64)}`;
  h.docker.images.add(PREPARED);
  h.docker.imageIds.set(PREPARED, id);
  const config = imageConfigWithUser('vscode', options.metadata);
  const prepared = preparedImageLabels(ENV, { key: options.key ?? KEY, helperImage: options.helperImage ?? h.helper.currentHelperImageId });
  h.docker.imageConfigs.set(PREPARED, { ...config, Labels: { ...config.Labels, ...prepared, ...options.labels } });
  return id;
}

describe('the prepare of a Docker Compose devspace', () => {
  it('builds only the devspace image of the dev service, as <resource>:prepared, with prepared names in its build model', async () => {
    await seedCompose();
    const { result, events } = await prepare();
    expect(result).toMatchObject({ outcome: 'prepared' });
    expect(hostUses).toEqual([]);
    expect(events).toEqual([`take ${ENV_ID}`, `release ${ENV_ID}`]);
    expect(h.lock.acquired).toEqual([]);
    // One build, of the dev service, without a token; our copy of devcontainer.json (no --frozen-lockfile: the lockfile
    // is copied next to our copy, in the helper).
    expect(h.helper.builds).toHaveLength(1);
    const build = h.helper.builds[0];
    expect(build).toMatchObject({ imageName: PREPARED, configPath: DEFAULT_CONFIG_PATH, env: { COMPOSE_PROJECT_NAME: PROJECT } });
    expect(build).not.toHaveProperty('frozenLockfile');
    expect(build.override).toMatchObject({ dockerComposeFile: [COMPOSE_MODEL_PATH], service: 'app' });
    expect(h.helper.buildTokens).toEqual([undefined]);
    // The build model: the dev service builds the prepared image itself; the other built service has a prepared name; no
    // name of the setup (`<project>-<service>`) is in it.
    const m = buildModel();
    expect(m.services.app.image).toBe(PREPARED);
    expect(m.services.worker.image).toBe(PREPARED_WORKER);
    expect(m.services.db.image).toBe(DB_IMAGE);
    expect(JSON.stringify(m)).not.toContain(`"${PROJECT}-`);
    // Only the changed base image of the dev service is pulled.
    expect(h.docker.log.filter((line) => line.startsWith('pull'))).toEqual([`pull ${BASE_IMAGE}`]);
    expect(h.docker.labelled.get(PREPARED)).toEqual(preparedImageLabels(ENV, { key: KEY, helperImage: h.helper.currentHelperImageId }));
    // Nothing of the setup changed: no `up`, no container, no image of the setup, no record.
    expect(h.helper.ups).toEqual([]);
    expect(h.docker.log.filter((line) => line.startsWith('rm ') || line.startsWith('stop ') || line.startsWith('start ') || line.startsWith('volume '))).toEqual([]);
    setupUnchanged();
    expect(h.docker.images.has(PREPARED_WORKER)).toBe(false);
    expect(h.docker.images.has(IMAGE_2)).toBe(false);
    expect((await h.registry.get(ENV_ID))?.buildRecord?.devspaceImage).toBe(IMAGE_1);
  });

  it('never pulls the image of another service or a base image of another built service: they stay to the open', async () => {
    await seedCompose();
    h.checker.outcome = checked({ [BASE_IMAGE]: DIGEST_NEW, [DB_IMAGE]: DB_DIGEST_NEW, [NODE_IMAGE]: NODE_DIGEST_NEW }, { [FEATURE]: FEATURE_DIGEST });
    const { result } = await prepare();
    expect(result.outcome).toBe('prepared');
    expect(h.docker.log.filter((line) => line.startsWith('pull'))).toEqual([`pull ${BASE_IMAGE}`]);
    setupUnchanged();
    // The key names every digest of the open's check.
    const label = JSON.parse(h.docker.labelled.get(PREPARED)?.[LABEL_PREPARED] ?? '{}') as { key: PrepareKey };
    expect(label.key.images).toEqual({ [BASE_IMAGE]: DIGEST_NEW, [DB_IMAGE]: DB_DIGEST_NEW, [NODE_IMAGE]: NODE_DIGEST_NEW });
  });

  it('a later open with Later, and a start of the stopped setup, keep exactly the images of the setup', async () => {
    h.settings = { ...h.settings, updateContainer: 'ask' };
    await seedCompose();
    await prepare();
    h.ui.updateContainerAnswer = 'later';
    await open();
    expect(h.helper.builds).toHaveLength(1);
    expect(h.helper.ups.map((up) => [up.image, up.removeExistingContainer])).toEqual([[IMAGE_1, false]]);
    const m = upModel();
    expect(m.services.app.image).toBe(IMAGE_1);
    expect(m.services.worker.image).toBe(`${PROJECT}-worker`);
    expect(m.services.db.image).toBe(DB_IMAGE);
    expect(h.docker.log.filter((line) => line.startsWith('pull') || line.startsWith('tag '))).toEqual([`pull ${BASE_IMAGE}`]);
    setupUnchanged();
    // The prepared image waits for the next update.
    expect(h.docker.images.has(PREPARED)).toBe(true);
    expect((await h.registry.get(ENV_ID))?.buildRecord?.devspaceImage).toBe(IMAGE_1);
  });

  describe('is skipped, with one line of the log', () => {
    const skipped = async (detail: string) => {
      const { result } = await prepare();
      expect(result).toMatchObject({ outcome: 'skipped', detail });
      expect(h.helper.builds).toEqual([]);
      expect(h.docker.images.has(PREPARED)).toBe(false);
      expect(hostUses).toEqual([]);
      setupUnchanged();
    };

    it('for a container of another service created with the host access checks off', async () => {
      await seedCompose({ dbLabels: { [LABEL_HOST_ACCESS]: HOST_ACCESS_UNRESTRICTED } });
      await skipped('the host access checks are off for it (its container was created without them)');
    });

    it('for a changed compose model, before any analysis', async () => {
      await seedCompose();
      h.helper.composeOutput = output((m) => (m.services.db.environment = { POSTGRES_DB: 'other' }));
      await skipped('its configuration changed since its last build (only the approved configuration is prepared)');
      expect(h.helper.readConfigurations.filter((read) => read.merged !== false)).toEqual([]);
    });

    for (const spelling of [BASE_IMAGE, BASE_IMAGE.replace('mcr.microsoft.com', 'MCR.Microsoft.com')]) {
      it(`for a base image of the dev service that another service runs as its image (its pull would move that tag): ${spelling}`, async () => {
        const shared = output((m) => (m.services.tools = { image: spelling, networks: { default: null } }));
        h.helper.composeOutput = shared;
        const digests = { [BASE_IMAGE]: DIGEST_NEW, [DB_IMAGE]: DB_DIGEST, [NODE_IMAGE]: NODE_DIGEST, [spelling]: DIGEST_NEW };
        h.checker.outcome = checked(digests, { [FEATURE]: FEATURE_DIGEST });
        // The record of this configuration (an approved one).
        await seedCompose({ record: { configHash: composeConfigHash(CONFIG_TEXT, shared.model, DOCKERFILES), images: { ...OLD_DIGESTS, [spelling]: DIGEST_OLD } } });
        await skipped(`the base image ${BASE_IMAGE} of its dev service is also an image of another service, which only the open pulls`);
        expect(h.docker.log.filter((line) => line.startsWith('pull'))).toEqual([]);
      });
    }

    it('for a base image of the dev service that another built service builds on (its pull would move that tag)', async () => {
      const dockerfiles = { worker: `FROM ${BASE_IMAGE}\n` };
      h.helper.composeOutput = { ...output(), dockerfiles };
      h.checker.outcome = checked({ [BASE_IMAGE]: DIGEST_NEW, [DB_IMAGE]: DB_DIGEST }, { [FEATURE]: FEATURE_DIGEST });
      await seedCompose({
        record: {
          configHash: composeConfigHash(CONFIG_TEXT, model(), dockerfiles),
          images: { [BASE_IMAGE]: DIGEST_OLD, [DB_IMAGE]: DB_DIGEST },
          compose: { service: 'app', images: [`${PROJECT}-app`, `${PROJECT}-worker`], serviceImages: [DB_IMAGE], version: '2.40.3', inputsHash: composeInputsHash(CONFIG_TEXT, 'inputs-1', dockerfiles) },
        },
      });
      await skipped(`the base image ${BASE_IMAGE} of its dev service is also an image of another service, which only the open pulls`);
      expect(h.docker.log.filter((line) => line.startsWith('pull'))).toEqual([]);
    });
  });

  it('prepares the same files that another version of the Compose plugin prints as another model (as the open)', async () => {
    await seedCompose();
    const printed = output((m) => (m.services.app.command = ['sleep', 'infinity', '#']), '2.41.0');
    h.helper.composeOutput = printed;
    const { result } = await prepare();
    expect(result.outcome).toBe('prepared');
    const label = JSON.parse(h.docker.labelled.get(PREPARED)?.[LABEL_PREPARED] ?? '{}') as { key: PrepareKey };
    expect(label.key.configHash).toBe(composeConfigHash(CONFIG_TEXT, printed.model, DOCKERFILES));
  });

  it('removes its image when the compose model changed during the build', async () => {
    await seedCompose();
    h.helper.onBuild = () => void (h.helper.composeOutput = output((m) => (m.services.db.environment = { POSTGRES_DB: 'other' })));
    const { result } = await prepare();
    expect(result).toMatchObject({ outcome: 'skipped', detail: 'its configuration changed during the prepare' });
    expect(h.docker.images.has(PREPARED)).toBe(false);
    setupUnchanged();
  });
});

describe('the swap at the open of a Docker Compose devspace', () => {
  it('after the prepare: no build; the prepared image becomes the devspace image, the other services as at any update', async () => {
    await seedCompose();
    h.checker.outcome = checked({ [BASE_IMAGE]: DIGEST_NEW, [DB_IMAGE]: DB_DIGEST_NEW, [NODE_IMAGE]: NODE_DIGEST }, { [FEATURE]: FEATURE_DIGEST });
    expect((await prepare()).result.outcome).toBe('prepared');
    const preparedId = await h.docker.imageId(PREPARED);
    await open();
    expect(h.ui.prompts).toEqual([`updateContainer ${REPO} stopped`]);
    // The build of the prepare only.
    expect(h.helper.builds.map((build) => build.imageName)).toEqual([PREPARED]);
    // The open pulls the changed images as without a prepare (with the computer's credentials): the base of the dev
    // service again (same digest), and now the image of the database.
    expect(h.docker.log.filter((line) => line.startsWith('pull'))).toEqual([`pull ${BASE_IMAGE}`, `pull ${BASE_IMAGE}`, `pull ${DB_IMAGE}`]);
    expect(h.docker.log).toContain(`tag ${preparedId} ${IMAGE_2}`);
    expect(h.helper.calls).toContain(`up ${IMAGE_2} --remove-existing-container`);
    const m = upModel();
    expect(m.services.app.image).toBe(IMAGE_2);
    expect(m.services.worker.image).toBe(`${PROJECT}-worker`);
    // Every check of the open: its own model run (the prepare ran two), and before `up` the metadata of the new devspace
    // image (a refusal there: below).
    expect(h.helper.composeModels).toHaveLength(3);
    const record = (await h.registry.get(ENV_ID))?.buildRecord;
    expect(record).toMatchObject({
      devspaceImage: IMAGE_2,
      imageId: preparedId,
      configHash: HASH,
      images: { [BASE_IMAGE]: DIGEST_NEW, [DB_IMAGE]: DB_DIGEST_NEW, [NODE_IMAGE]: NODE_DIGEST },
      compose: { service: 'app', images: [`${PROJECT}-app`, `${PROJECT}-worker`], serviceImages: [DB_IMAGE] },
    });
    expect(h.docker.labelled.get(IMAGE_2)?.[LABEL_PREPARED]).toBe('');
    // The old images go: the old devspace image, the prepared tag, and the old image of the dev service (the
    // prepared image replaced its build); the images of the other services stay.
    expect(h.docker.images.has(IMAGE_1)).toBe(false);
    expect(h.docker.images.has(PREPARED)).toBe(false);
    expect(h.docker.images.has(`${PROJECT}-app`)).toBe(false);
    expect(h.docker.images.has(`${PROJECT}-worker`)).toBe(true);
    expect(h.docker.images.has(DB_IMAGE)).toBe(true);
    expect(h.progress.details).toContain(Messages.newerImage);
  });

  const other = `sha256:${'f'.repeat(64)}`;
  for (const [label, prepared] of [
    ['another digest of the database image', { key: { ...KEY, images: { ...KEY.images, [DB_IMAGE]: other } } }],
    ['another digest of a base of a built service', { key: { ...KEY, images: { ...KEY.images, [NODE_IMAGE]: other } } }],
    ['another configuration hash (another compose model)', { key: { ...KEY, configHash: `sha256:${'f'.repeat(64)}` } }],
    ['the host access checks off', { key: { ...KEY, hostAccessChecks: 'off' as const } }],
    ['another helper image', { helperImage: other }],
    ['another devspace ID', { labels: { [LABEL_DEVSPACE_ID]: '7c1d2e3f-0000-4000-8000-000000000002' } }],
  ] as const) {
    it(`builds normally with a prepared image of ${label}`, async () => {
      await seedCompose();
      addPrepared(prepared);
      await open();
      expect(h.helper.builds.map((build) => build.imageName)).toEqual([IMAGE_2]);
      expect(buildModel().services.app.image).toBe(`${PROJECT}-app`);
      expect(buildModel().services.worker.image).toBe(`${PROJECT}-worker`);
      expect(h.docker.log.some((line) => line.startsWith('tag '))).toBe(false);
      expect(h.logger.infos.some((line) => line.startsWith(`The prepared image ${PREPARED} is not used for ${REPO}: `))).toBe(true);
      // The leftover prepared image goes with the old images; the image of the dev service is the new build's.
      expect(h.docker.images.has(PREPARED)).toBe(false);
      expect(h.docker.images.has(`${PROJECT}-app`)).toBe(true);
    });
  }

  it('never takes a prepared image with the host access checks off for the repository', async () => {
    h.settings = { ...h.settings, hostAccessChecksOff: [REPO] };
    await seedCompose();
    addPrepared();
    await open();
    expect(h.helper.builds.map((build) => build.imageName)).toEqual([IMAGE_2]);
    expect(h.docker.log.some((line) => line.startsWith('tag '))).toBe(false);
  });

  it('a refused metadata of the prepared image: not used, the existing setup starts', async () => {
    await seedCompose();
    addPrepared({ metadata: [{ id: 'docker-in-docker', privileged: true }] });
    await open();
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.ups.map((up) => [up.image, up.removeExistingContainer])).toEqual([[IMAGE_1, false]]);
    expect(h.ui.warnings).toEqual([Messages.updateRefused('privileged mode')]);
    expect((await h.registry.get(ENV_ID))?.buildRecord?.devspaceImage).toBe(IMAGE_1);
    setupUnchanged();
  });

  it('Delete removes the prepared images of the devspace', async () => {
    await seedCompose();
    addPrepared();
    h.docker.images.add(PREPARED_WORKER);
    await h.service.delete(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] });
    expect(h.docker.log).toContain(`rmi ${PREPARED}`);
    expect(h.docker.log).toContain(`rmi ${PREPARED_WORKER}`);
    expect(h.docker.images.has(PREPARED)).toBe(false);
    expect(h.docker.images.has(PREPARED_WORKER)).toBe(false);
  });
});

describe('preparedServiceImageName', () => {
  it('names a built service in the repository of the devspace image, never <project>-<service>', () => {
    expect(PREPARED_WORKER).toBe(`${PROJECT}:prepared-worker`);
    expect(preparedServiceImageName(REPO, ENV_ID, 'My_Service.1')).toBe(`${PROJECT}:prepared-my-service-1`);
    expect(preparedServiceImageName(REPO, ENV_ID, '__')).toBe(`${PROJECT}:prepared-service`);
    const long = preparedServiceImageName(REPO, ENV_ID, 'x'.repeat(300));
    expect(long.slice(long.indexOf(':') + 1).length).toBeLessThanOrEqual(128);
  });
});
