// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The devspace image carries the labels of its devspace and its build record (labelImage after the build), the
// registry record pins the ID of the image after the labels, an image under the name with another ID is not used, an
// entry without a build record takes the record over from its newest image, and the workspace volume of a restored
// entry must have the name of its labels (resourceName). The pure functions: imageRecord.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandError, UserFacingError } from '../errors';
import { DevcontainerCommandError } from '../helper/devcontainerCli';
import { Messages } from '../messages';
import {
  CONTAINER_VERSION,
  LABEL_BUILD_RECORD,
  LABEL_CONTAINER_VERSION,
  LABEL_DEVSPACE_ID,
  LABEL_OWNER_ID,
  LABEL_REPOSITORY,
  composeProjectName,
  devspaceImageName,
  resourceName,
} from '../names';
import type { ContainerInfo } from '../docker/dockerObjects';
import type { BuildRecord } from '../types';
import type { RepositoryTarget } from './operationBase';
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
  REPO,
  createHarness,
  imageConfigWithUser,
  seedDevspace,
  type Harness,
} from './devspaceService.testkit';
import { DEFAULT_CONFIG_PATH } from './recordRules';
import { COMPOSE_CONTAINER_NUMBER_LABEL, configHash } from './pipelineRules';
import { COMPOSE_PROJECT_LABEL } from '../names';

const TARGET: RepositoryTarget = { repository: REPO, defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };
const NAME = resourceName(REPO, ENV_ID);
const IMAGE_1 = devspaceImageName(REPO, ENV_ID, 1);
const IMAGE_2 = devspaceImageName(REPO, ENV_ID, 2);
const IMAGE_3 = devspaceImageName(REPO, ENV_ID, 3);
/** The ID of an image after labelImage (the real `docker build` of the labels gives the image a new ID). */
const LABELLED_ID = `sha256:${'5'.repeat(64)}`;

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

afterEach(() => {
  h.cleanup();
});

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

/** labelImage of the fake, and then the image has the ID LABELLED_ID, as after the `docker build` of the labels. */
function labelsChangeTheId(): void {
  const labelImage = h.docker.labelImage.bind(h.docker);
  h.docker.labelImage = async (image: string, labels: Record<string, string>) => {
    await labelImage(image, labels);
    h.docker.imageIds.set(image, LABELLED_ID);
  };
}

/** A build record of the image `tag` with the build number `n`, up to date with the default configuration and check. */
function recordOf(tag: string, n: number): BuildRecord {
  return {
    builtAt: '2026-09-30T10:00:00.000Z',
    devspaceImage: tag,
    buildNumber: n,
    configPath: DEFAULT_CONFIG_PATH,
    configHash: configHash(DEFAULT_CONFIG_TEXT),
    images: { [BASE_IMAGE]: DIGEST_NEW },
    features: { [FEATURE]: FEATURE_DIGEST },
  };
}

/** The labels that the extension gives the image of ENV_ID (as imageRecordLabels), with `changes`. */
function labelsOf(record: BuildRecord, changes: Record<string, string> = {}): Record<string, string> {
  return {
    [LABEL_DEVSPACE_ID]: ENV_ID,
    [LABEL_REPOSITORY]: REPO,
    [LABEL_OWNER_ID]: ACCOUNT.id,
    [LABEL_BUILD_RECORD]: JSON.stringify(record),
    ...changes,
  };
}

/** A local devspace image `tag` with the labels `labels`. */
function addImage(tag: string, labels: Record<string, string>): void {
  h.docker.images.add(tag);
  const config = imageConfigWithUser('vscode');
  h.docker.imageConfigs.set(tag, { ...config, Labels: { ...config.Labels, ...labels } });
}

function stored(record: BuildRecord | undefined): Omit<BuildRecord, 'imageId'> | undefined {
  if (record === undefined) return undefined;
  const { imageId: _imageId, ...rest } = record;
  return rest;
}

describe('the labels of a new devspace image, and its pinned ID', () => {
  it('labels the image after the build with the devspace and its build record, and pins the ID after the labels', async () => {
    labelsChangeTheId();
    const result = await h.service.open(TARGET, options());
    const env = (await h.registry.get(result.devspace.id))!;
    const image = devspaceImageName(REPO, env.id, 1);
    expect(env.buildRecord?.devspaceImage).toBe(image);
    const labels = h.docker.labelled.get(image);
    expect(labels).toBeDefined();
    expect(Object.keys(labels!).sort()).toEqual([LABEL_BUILD_RECORD, LABEL_DEVSPACE_ID, LABEL_OWNER_ID, LABEL_REPOSITORY].sort());
    expect(labels![LABEL_DEVSPACE_ID]).toBe(env.id);
    expect(labels![LABEL_REPOSITORY]).toBe(REPO);
    expect(labels![LABEL_OWNER_ID]).toBe(ACCOUNT.id);
    // The record of the registry without its pinned ID.
    expect(JSON.parse(labels![LABEL_BUILD_RECORD])).toEqual(stored(env.buildRecord));
    expect(JSON.parse(labels![LABEL_BUILD_RECORD])).not.toHaveProperty('imageId');
    expect(env.buildRecord?.imageId).toBe(LABELLED_ID);
    // The container is made from the labelled image.
    expect(h.helper.ups.map((up) => up.image)).toEqual([image]);
  });

  it('labels the image of an update and pins its new ID', async () => {
    await seedDevspace(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } } });
    labelsChangeTheId();
    await h.service.open(TARGET, options());
    const record = (await h.registry.get(ENV_ID))?.buildRecord;
    expect(record?.devspaceImage).toBe(IMAGE_2);
    expect(record?.imageId).toBe(LABELLED_ID);
    expect(JSON.parse(h.docker.labelled.get(IMAGE_2)![LABEL_BUILD_RECORD])).toEqual(stored(record));
  });

  it('fails a first open whose labels cannot be set like a failed build, and removes the image', async () => {
    h.docker.labelImageError = new DevcontainerCommandError('docker build', 1, '', 'no space left on device');
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('buildFailed');
    expect(h.helper.builds).toHaveLength(1);
    expect(h.helper.ups).toEqual([]);
    expect(await h.registry.list()).toEqual([]);
    expect([...h.docker.images].filter((image) => image.startsWith('devspaces-'))).toEqual([]);
  });

  it('fails a first open whose image is gone after its labels, and writes no record', async () => {
    const label = h.docker.labelImage.bind(h.docker);
    h.docker.labelImage = async (image, labels) => {
      await label(image, labels);
      h.docker.images.delete(image);
    };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('buildFailed');
    expect(h.helper.ups).toEqual([]);
    expect(await h.registry.list()).toEqual([]);
  });

  it('keeps the old container when the labels of an update cannot be set, and removes the new image', async () => {
    await seedDevspace(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } } });
    h.docker.labelImageError = new Error('Cannot connect to the Docker daemon');
    await h.service.open(TARGET, options());
    expect(h.helper.builds.map((build) => build.imageName)).toEqual([IMAGE_2]);
    expect(h.ui.warnings).toEqual([Messages.buildFailed]);
    expect(h.helper.ups).toEqual([expect.objectContaining({ image: IMAGE_1, removeExistingContainer: false })]);
    expect(h.docker.images.has(IMAGE_2)).toBe(false);
    expect(h.docker.images.has(IMAGE_1)).toBe(true);
    const record = (await h.registry.get(ENV_ID))?.buildRecord;
    expect(record?.devspaceImage).toBe(IMAGE_1);
    expect(record?.imageId).toBe(`sha256:image-of-${IMAGE_1}`);
  });
});

describe('the pinned ID of the devspace image at the open', () => {
  it('starts the image whose ID the record pins without a build', async () => {
    await seedDevspace(h);
    await h.service.open(TARGET, options());
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.ups.map((up) => up.image)).toEqual([IMAGE_1]);
  });

  it('builds again when the image under the name of the record has another ID, and warns in the log', async () => {
    await seedDevspace(h);
    // For example an image of that name that another computer built on a shared host.
    h.docker.imageIds.set(IMAGE_1, `sha256:${'7'.repeat(64)}`);
    await h.service.open(TARGET, options());
    expect(h.helper.builds).toHaveLength(1);
    expect(h.logger.warnings.some((line) => line.includes(IMAGE_1) && line.includes('not the ID of its build record'))).toBe(true);
    const record = (await h.registry.get(ENV_ID))?.buildRecord;
    expect(record?.devspaceImage).not.toBe(IMAGE_1);
    expect(record?.imageId).toBe(`sha256:image-of-${record?.devspaceImage}`);
    expect(h.helper.ups.map((up) => up.image)).toEqual([record?.devspaceImage]);
  });

  it('builds again when the record pins no image ID', async () => {
    await seedDevspace(h, { record: { imageId: undefined } });
    expect((await h.registry.get(ENV_ID))?.buildRecord).not.toHaveProperty('imageId');
    await h.service.open(TARGET, options());
    expect(h.helper.builds).toHaveLength(1);
    expect(h.logger.warnings.some((line) => line.includes(IMAGE_1) && line.includes('(none)'))).toBe(true);
    expect((await h.registry.get(ENV_ID))?.buildRecord?.imageId).toBeDefined();
  });
});

describe('an entry without a build record takes the record over from its newest image', () => {
  beforeEach(async () => {
    // For example restored by reconcileFromVolumes on a computer that did not build the image.
    await seedDevspace(h, { record: null, container: null });
  });

  it('takes the record of the newest image with fitting labels, pins its ID, and does not build when up to date', async () => {
    addImage(IMAGE_1, labelsOf(recordOf(IMAGE_1, 1)));
    addImage(IMAGE_3, labelsOf(recordOf(IMAGE_3, 3)));
    await h.service.open(TARGET, options());
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.ups.map((up) => up.image)).toEqual([IMAGE_3]);
    const env = await h.registry.get(ENV_ID);
    expect(env?.buildRecord).toEqual({ ...recordOf(IMAGE_3, 3), imageId: `sha256:image-of-${IMAGE_3}` });
    expect(env?.lastBuildNumber).toBe(3);
  });

  it('never lowers the last build number of the entry', async () => {
    await h.registry.updateDevspace(ENV_ID, (entry) => {
      entry.lastBuildNumber = 7;
    });
    addImage(IMAGE_3, labelsOf(recordOf(IMAGE_3, 3)));
    await h.service.open(TARGET, options());
    expect((await h.registry.get(ENV_ID))?.lastBuildNumber).toBe(7);
  });

  it('takes no tag that is no build number as the newest image', async () => {
    addImage(IMAGE_1, labelsOf(recordOf(IMAGE_1, 1)));
    for (const tag of [`${NAME}:0`, `${NAME}:1e30`, `${NAME}:latest`]) h.docker.images.add(tag);
    await h.service.open(TARGET, options());
    expect(h.helper.builds).toEqual([]);
    expect((await h.registry.get(ENV_ID))?.buildRecord?.devspaceImage).toBe(IMAGE_1);
  });

  it('pins the ID that Docker gives the image, never one of the labels', async () => {
    h.docker.imageIds.set(IMAGE_3, `sha256:${'8'.repeat(64)}`);
    addImage(IMAGE_3, labelsOf({ ...recordOf(IMAGE_3, 3), imageId: `sha256:${'9'.repeat(64)}` }));
    await h.service.open(TARGET, options());
    expect(h.helper.builds).toEqual([]);
    expect((await h.registry.get(ENV_ID))?.buildRecord?.imageId).toBe(`sha256:${'8'.repeat(64)}`);
  });

  it('builds when the newest image has no labels of the extension', async () => {
    addImage(IMAGE_3, {});
    await h.service.open(TARGET, options());
    expect(h.helper.builds).toHaveLength(1);
  });

  it.each<[string, Record<string, string>, BuildRecord?]>([
    ['the ID of another devspace', { [LABEL_DEVSPACE_ID]: OTHER_ID }],
    ['another owner', { [LABEL_OWNER_ID]: OTHER_ACCOUNT.id }],
    ['another repository', { [LABEL_REPOSITORY]: 'acme/web' }],
    ['a record that names another tag', {}, recordOf(IMAGE_1, 3)],
    ['a record with another build number', {}, recordOf(IMAGE_3, 1)],
  ])('does not take the record over from labels with %s, and builds', async (_name, changes, record = recordOf(IMAGE_3, 3)) => {
    addImage(IMAGE_3, labelsOf(record, changes));
    await h.service.open(TARGET, options());
    expect(h.helper.builds).toHaveLength(1);
    const env = await h.registry.get(ENV_ID);
    expect(env?.buildRecord?.devspaceImage).not.toBe(IMAGE_3);
    expect(env?.buildRecord?.imageId).toBe(`sha256:image-of-${env?.buildRecord?.devspaceImage}`);
    expect(h.logger.warnings.some((line) => line.includes(IMAGE_3) && line.includes('its labels do not fit'))).toBe(true);
  });
});

describe('reconcileFromVolumes and the names of the devspaces', () => {
  it('restores a volume with the name of its labels, with the container of the same name', async () => {
    h.docker.volumes.set(NAME, { [LABEL_DEVSPACE_ID]: ENV_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id });
    expect(await h.service.reconcileFromVolumes()).toBe(1);
    const env = await h.registry.get(ENV_ID);
    expect(env?.volumeName).toBe(resourceName(REPO, ENV_ID));
    expect(env?.containerName).toBe(env?.volumeName);
  });

  it.each([
    ['the name of the short ID', 'devspaces-acme-api-3f2a9c1e'],
    ['the name of another ID', resourceName(REPO, OTHER_ID)],
    ['the name of another repository', resourceName('acme/web', ENV_ID)],
    ['a name of its own', 'my-volume'],
  ])('skips a volume with the labels of a devspace and %s', async (_name, volume) => {
    h.docker.volumes.set(volume, { [LABEL_DEVSPACE_ID]: ENV_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id });
    expect(await h.service.reconcileFromVolumes()).toBe(0);
    expect(await h.registry.list()).toEqual([]);
    expect(h.logger.warnings).toContain(`The volume ${volume} has the labels of a devspace but not its name. It is skipped.`);
  });
});

describe('a container is created again only from its own image', () => {
  /** An outdated, stopped container, and a configuration that cannot be read: the container is created again without a build. */
  async function outdatedWithoutConfiguration(): Promise<void> {
    await seedDevspace(h, { container: 'stopped', containerLabels: { [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION - 1) } });
    h.helper.readConfigurationError = new CommandError('devcontainer read-configuration', 1, '', 'SyntaxError');
  }

  it('never creates it from another image under the name of the record (the image is gone by its ID)', async () => {
    await outdatedWithoutConfiguration();
    h.docker.imageIds.set(IMAGE_1, `sha256:${'7'.repeat(64)}`);
    await h.service.open(TARGET, options()).catch(() => undefined);
    expect(h.logger.warnings.some((line) => line.includes('not the ID of its build record'))).toBe(true);
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([]);
  });

  it('creates it from its own image by its ID when the name names another image', async () => {
    await outdatedWithoutConfiguration();
    const own = `sha256:image-of-${IMAGE_1}`;
    // The image of the container is still there under another name; the name of the record names another image.
    h.docker.images.add('kept:1');
    h.docker.imageIds.set('kept:1', own);
    h.docker.imageIds.set(IMAGE_1, `sha256:${'7'.repeat(64)}`);
    await h.service.open(TARGET, options()).catch(() => undefined);
    const ups = h.helper.calls.filter((call) => call.startsWith('up'));
    expect(ups).toHaveLength(1);
    expect(ups[0]).toBe(`up ${own} --remove-existing-container`);
    expect(h.logger.warnings.some((line) => line.includes('no longer names the image of the container'))).toBe(true);
  });
});

describe('a Docker failure while the record is taken over', () => {
  it('takes no record and builds, instead of failing the open', async () => {
    await seedDevspace(h, { record: null, container: null });
    h.docker.images.add(IMAGE_1);
    vi.spyOn(h.docker, 'imageLabels').mockRejectedValueOnce(new Error('timeout'));
    await h.service.open(TARGET, options());
    expect(h.logger.warnings.some((line) => line.includes(`The labels of ${IMAGE_1} could not be read: timeout`))).toBe(true);
    expect(h.helper.builds).toHaveLength(1);
  });
});

describe('a failed update and a first open on a volume of another devspace', () => {
  it('a failed update starts the current container again whose image is used by its ID, and never removes it', async () => {
    await seedDevspace(h, { container: 'stopped' });
    const own = `sha256:image-of-${IMAGE_1}`;
    // The image of the container is still there under another name; IMAGE_1 names another image now, so the open builds.
    h.docker.images.add('kept:1');
    h.docker.imageIds.set('kept:1', own);
    h.docker.imageIds.set(IMAGE_1, `sha256:${'7'.repeat(64)}`);
    // The build succeeds; `up` of the new image fails before the CLI removed anything, so the old container survives.
    h.helper.upFailsBeforeRemoval = true;
    h.helper.upError = (image) => (image === IMAGE_2 ? new DevcontainerCommandError('devcontainer up', 1, '', 'invalid override') : undefined);
    await h.service.open(TARGET, options()).catch(() => undefined);
    const ups = h.helper.calls.filter((call) => call.startsWith('up'));
    expect(ups).toHaveLength(2);
    expect(ups[1]).not.toContain('--remove-existing-container');
  });

  it('a first open whose volume another devspace created meanwhile clones nothing into it and removes nothing of it', async () => {
    const FREE = '5e5e5e5e-0000-4000-8000-000000000005';
    h.cleanup();
    h = createHarness({ newDevspaceId: () => FREE });
    const name = resourceName(REPO, FREE, 'config');
    vi.spyOn(h.docker, 'volumeExists').mockResolvedValue(false);
    const theirs = { [LABEL_DEVSPACE_ID]: OTHER_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: OTHER_ACCOUNT.id };
    h.docker.volumes.set(name, theirs);
    // The other first open built its image already (no container yet).
    const image = `${name}:1`;
    h.docker.images.add(image);
    h.docker.imageConfigs.set(image, { User: '', Labels: theirs });
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('startFailed');
    expect(h.helper.calls.filter((call) => call.startsWith('clone'))).toEqual([]);
    expect(h.docker.volumes.get(name)).toEqual(theirs);
    expect(h.docker.images.has(image)).toBe(true);
  });

  it('a failed first open whose volume labels cannot be read removes nothing of its name and keeps the entry', async () => {
    h.helper.cloneError = new Error('clone failed');
    const inspect = h.docker.inspectVolumes.bind(h.docker);
    let calls = 0;
    h.docker.inspectVolumes = async (names) => {
      // The check after the create reads them; the cleanup after the failed clone cannot.
      if (calls++ > 0) throw new Error('timeout');
      return inspect(names);
    };
    await expect(h.service.open(TARGET, options())).rejects.toBeDefined();
    const [entry] = await h.registry.list();
    expect(entry).toBeDefined();
    expect(h.docker.volumes.has(entry.volumeName)).toBe(true);
  });
});

describe('probes: the container and the image of the name', () => {
  const FREE = '5e5e5e5e-0000-4000-8000-000000000005';
  /** The ID of an image that no local image has (the image is gone). */
  const SWAPPED = `sha256:${'7'.repeat(64)}`;
  const OWN = `sha256:image-of-${IMAGE_1}`;

  function ups(): string[] {
    return h.helper.calls.filter((call) => call.startsWith('up'));
  }

  /** IMAGE_1 names another image now; with `keep`, the image of the container is still there under the name kept:1. */
  function swapName(keep: boolean): void {
    if (keep) {
      h.docker.images.add('kept:1');
      h.docker.imageIds.set('kept:1', OWN);
    }
    h.docker.imageIds.set(IMAGE_1, SWAPPED);
  }

  // The container of the devspace's name belongs to the other devspace whose volume took the name; a failed first
  // open never removes it by its name (`docker rm -f`).
  it('a failed first open never removes the container of its name that another devspace created meanwhile', async () => {
    h.cleanup();
    h = createHarness({ newDevspaceId: () => FREE });
    const name = resourceName(REPO, FREE, 'config');
    vi.spyOn(h.docker, 'volumeExists').mockResolvedValue(false);
    vi.spyOn(h.docker, 'containerState').mockResolvedValue('missing');
    h.docker.volumes.set(name, { [LABEL_DEVSPACE_ID]: OTHER_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: OTHER_ACCOUNT.id });
    const theirs = h.docker.addContainer({ devspaceId: OTHER_ID, name, state: 'running', image: 'their-image:1' });
    await expect(h.service.open(TARGET, options())).rejects.toBeDefined();
    expect(h.docker.containerByRef(theirs.id)).toMatchObject({ name, state: 'running' });
    expect(h.docker.log).not.toContain(`rm ${name}`);
    expect(h.docker.log).not.toContain(`rm ${theirs.id}`);
  });

  // A volume without the ID label (here: none, `docker volume create` failed) is no other devspace's: the failed
  // first open still removes what carries its name.
  it('a failed first open without its volume still removes the container of its name and the entry', async () => {
    h.cleanup();
    h = createHarness({ newDevspaceId: () => FREE });
    const name = resourceName(REPO, FREE, 'config');
    vi.spyOn(h.docker, 'createVolume').mockRejectedValue(new CommandError(`docker volume create ${name}`, 1, '', 'no space left on device'));
    await expect(h.service.open(TARGET, options())).rejects.toBeDefined();
    expect(h.docker.log).toContain(`rm ${name}`);
    expect(h.logger.warnings.some((line) => line.includes('belongs to another devspace'))).toBe(false);
    expect(await h.registry.list()).toEqual([]);
  });

  describe('the recreate offer for a damaged container without a pinned image (recreationImage)', () => {
    /** A stopped, current container whose `up` fails because it is damaged; no registry, so no build. */
    async function damagedWithoutBuild(): Promise<void> {
      await seedDevspace(h);
      h.checker.outcome = { status: 'unreachable', registries: ['mcr.microsoft.com'] };
      h.helper.upError = (_image, removeExisting) =>
        removeExisting
          ? undefined
          : new DevcontainerCommandError('devcontainer up', 1, '', 'Error response from daemon: unable to find user vscode: no matching entries in passwd file');
      h.ui.recreateAnswer = true;
    }

    it('creates it again from its own image by its ID when the name names another image', async () => {
      await damagedWithoutBuild();
      swapName(true);
      await h.service.open(TARGET, options()).catch(() => undefined);
      expect(h.helper.builds).toEqual([]);
      expect(h.ui.prompts).toEqual([`recreateContainer ${REPO}`]);
      expect(ups()).toEqual([`up ${IMAGE_1}`, `up ${OWN} --remove-existing-container`]);
    });

    it('offers nothing when its own image is gone, although the name names another image', async () => {
      await damagedWithoutBuild();
      swapName(false);
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('startFailed');
      expect(h.ui.prompts).toEqual([]);
      expect(ups()).toEqual([`up ${IMAGE_1}`]);
    });
  });

  describe('the fallback after a failed build or update uses the container only with its own image', () => {
    it('a failed build creates the outdated container again from its own image by its ID (containerUsable)', async () => {
      await seedDevspace(h, { containerLabels: { [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION - 1) } });
      swapName(true);
      h.helper.buildError = () => new Error('build broke');
      await h.service.open(TARGET, options()).catch(() => undefined);
      expect(h.helper.builds).toHaveLength(1);
      expect(ups()).toEqual([`up ${OWN} --remove-existing-container`]);
    });

    it('a failed build is no fallback for an outdated container whose own image is gone (containerUsable)', async () => {
      await seedDevspace(h, { containerLabels: { [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION - 1) } });
      swapName(false);
      h.helper.buildError = () => new Error('build broke');
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('buildFailed');
      expect(error.detail).toContain('build broke');
      expect(h.ui.warnings).toEqual([]);
      expect(ups()).toEqual([]);
    });

    it('a failed update starts the container again from its own image by its ID, never from the name (previousImage)', async () => {
      await seedDevspace(h, { container: 'stopped' });
      swapName(true);
      h.helper.upFailsBeforeRemoval = true;
      h.helper.upError = (image) => (image === IMAGE_2 ? new DevcontainerCommandError('devcontainer up', 1, '', 'invalid override') : undefined);
      await h.service.open(TARGET, options()).catch(() => undefined);
      expect(ups()).toEqual([`up ${IMAGE_2} --remove-existing-container`, `up ${OWN}`]);
    });

    it('a failed update does not start the container again when its own image is gone (previousImage)', async () => {
      await seedDevspace(h, { container: 'stopped' });
      swapName(false);
      h.helper.upFailsBeforeRemoval = true;
      h.helper.upError = (image) => (image === IMAGE_2 ? new DevcontainerCommandError('devcontainer up', 1, '', 'invalid override') : undefined);
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('startFailed');
      expect(error.detail).toContain('invalid override');
      expect(ups()).toEqual([`up ${IMAGE_2} --remove-existing-container`]);
    });
  });

  // The name moved and the container's own image is gone: there is no image to create it again from (never `up` of an
  // image ID that does not exist).
  it('an outdated container whose own image is gone and whose name names another image: buildFailed, no up', async () => {
    await seedDevspace(h, { containerLabels: { [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION - 1) } });
    h.helper.readConfigurationError = new CommandError('devcontainer read-configuration', 1, '', 'SyntaxError');
    swapName(false);
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('buildFailed');
    expect(error.detail).toBe('There is no devspace image.');
    expect(ups()).toEqual([]);
  });

  describe('containerImage details', () => {
    /**
     * An outdated container created from `old:1` (still there), a record whose image is not pinned (so the container's
     * own image is used), and a configuration that cannot be read: the container is created again without a build.
     */
    async function outdatedFromOld(imageId?: string): Promise<void> {
      await seedDevspace(h, { container: null, record: { imageId: SWAPPED } });
      h.docker.images.add('old:1');
      const container = h.docker.addContainer({
        devspaceId: ENV_ID,
        name: NAME,
        state: 'stopped',
        image: 'old:1',
        labels: { [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION - 1) },
      });
      if (imageId !== undefined) h.docker.containers.set(container.id, { ...container, imageId });
      h.helper.readConfigurationError = new CommandError('devcontainer read-configuration', 1, '', 'SyntaxError');
    }

    it('uses the name while it still names the container image, without a warning', async () => {
      await outdatedFromOld();
      await h.service.open(TARGET, options()).catch(() => undefined);
      expect(ups()).toEqual(['up old:1 --remove-existing-container']);
      expect(h.logger.warnings.some((line) => line.includes('no longer names the image of the container'))).toBe(false);
    });

    it('compares the IDs without regard to case', async () => {
      await outdatedFromOld('sha256:IMAGE-OF-OLD:1');
      await h.service.open(TARGET, options()).catch(() => undefined);
      expect(ups()).toEqual(['up old:1 --remove-existing-container']);
    });

    it('falls back to the image ID when Docker cannot look up the name', async () => {
      await outdatedFromOld();
      const imageId = h.docker.imageId.bind(h.docker);
      vi.spyOn(h.docker, 'imageId').mockImplementation(async (reference) => {
        if (reference === 'old:1') throw new CommandError('docker image inspect old:1', 1, '', 'timeout');
        return imageId(reference);
      });
      await h.service.open(TARGET, options()).catch(() => undefined);
      expect(ups()).toEqual(['up sha256:image-of-old:1 --remove-existing-container']);
    });
  });
});

describe('a workspace volume of the name with another devspace\'s ID', () => {
  const theirs = { [LABEL_DEVSPACE_ID]: OTHER_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: OTHER_ACCOUNT.id };

  it('is never removed by the Delete of the entry that a failed first open kept (its labels were unreadable then)', async () => {
    const FREE = '5e5e5e5e-0000-4000-8000-000000000005';
    h.cleanup();
    h = createHarness({ newDevspaceId: () => FREE });
    const name = resourceName(REPO, FREE, 'config');
    const exists = vi.spyOn(h.docker, 'volumeExists').mockResolvedValue(false);
    h.docker.volumes.set(name, theirs);
    const inspect = h.docker.inspectVolumes.bind(h.docker);
    let failing = true;
    h.docker.inspectVolumes = async (names) => {
      if (failing) throw new Error('timeout');
      return inspect(names);
    };
    await expect(h.service.open(TARGET, options())).rejects.toBeDefined();
    expect((await h.registry.list()).map((entry) => entry.id)).toEqual([FREE]);
    exists.mockRestore();
    failing = false;
    await h.service.delete(FREE, { progress: h.progress, additionalVolumesToRemove: [] });
    expect(h.docker.volumes.get(name)).toEqual(theirs);
    expect(await h.registry.list()).toEqual([]);
  });

  it('is never opened by an existing devspace', async () => {
    await seedDevspace(h, { container: null });
    h.docker.volumes.set(NAME, theirs);
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('startFailed');
    expect(h.helper.calls.filter((call) => call.startsWith('up') || call.startsWith('clone'))).toEqual([]);
  });

  it('is never removed by the Delete of an existing devspace, nor its images', async () => {
    await seedDevspace(h, { container: null });
    h.docker.volumes.set(NAME, theirs);
    await h.service.delete(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] });
    expect(h.docker.volumes.get(NAME)).toEqual(theirs);
    expect(h.docker.images.has(IMAGE_1)).toBe(true);
    expect(await h.registry.get(ENV_ID)).toBeUndefined();
  });

  it('stops Delete without removing anything when Docker cannot say whose it is', async () => {
    await seedDevspace(h, { container: null });
    h.docker.inspectVolumes = async () => {
      throw new Error('timeout');
    };
    await expect(h.service.delete(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] })).rejects.toBeDefined();
    expect(h.docker.volumes.has(NAME)).toBe(true);
    expect(await h.registry.get(ENV_ID)).toBeDefined();
  });
});

describe('a failed first open and a volume of its name without labels', () => {
  it('refuses the volume and then removes nothing of its name (the same rule as Delete)', async () => {
    const FREE = '5e5e5e5e-0000-4000-8000-000000000005';
    h.cleanup();
    h = createHarness({ newDevspaceId: () => FREE });
    const name = resourceName(REPO, FREE, 'config');
    vi.spyOn(h.docker, 'volumeExists').mockResolvedValue(false);
    // A volume of the name without the labels of Devspace (made by hand, or by another program).
    h.docker.volumes.set(name, {});
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('startFailed');
    expect(h.docker.volumes.get(name)).toEqual({});
    expect(h.docker.log.filter((line) => line.startsWith('rm ') || line.startsWith('volume rm'))).toEqual([]);
  });
});

describe('probes: volume labels that cannot be read, and the survivor of a failed update', () => {
  const FREE = '5e5e5e5e-0000-4000-8000-000000000005';
  const theirs = { [LABEL_DEVSPACE_ID]: OTHER_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: OTHER_ACCOUNT.id };

  function ups(): string[] {
    return h.helper.calls.filter((call) => call.startsWith('up'));
  }

  /** A first open of the new devspace FREE whose name is free when it is chosen; returns the name of its resources. */
  function firstOpenOfFree(): string {
    h.cleanup();
    h = createHarness({ newDevspaceId: () => FREE });
    vi.spyOn(h.docker, 'volumeExists').mockResolvedValue(false);
    vi.spyOn(h.docker, 'containerState').mockResolvedValue('missing');
    return resourceName(REPO, FREE, 'config');
  }

  // When the labels of the volume cannot be read after a failed clone, nothing of the name is removed (the container,
  // the images), only what carries the devspace ID; the entry keeps its create mark as ended, and the pending
  // connection file goes.
  it('a failed first open whose volume labels cannot be read removes only what carries its ID', async () => {
    const name = firstOpenOfFree();
    h.helper.cloneError = new Error('clone failed');
    const theirContainer = h.docker.addContainer({ devspaceId: OTHER_ID, name, state: 'running', image: 'their-image:1' });
    const ownLeftover = h.docker.addContainer({ devspaceId: FREE, name: 'leftover', state: 'stopped', image: 'their-image:1' });
    const image = `${name}:1`;
    h.docker.images.add(image);
    h.docker.imageConfigs.set(image, { User: '', Labels: theirs });
    const removePending = vi.spyOn(h.sessionFiles, 'removePending');
    const inspect = h.docker.inspectVolumes.bind(h.docker);
    let calls = 0;
    h.docker.inspectVolumes = async (names) => {
      // The check after the create reads them; the cleanup after the failed clone cannot.
      if (calls++ > 0) throw new Error('timeout');
      return inspect(names);
    };
    await expect(h.service.open(TARGET, options())).rejects.toBeDefined();
    expect(h.docker.containerByRef(theirContainer.id)).toMatchObject({ name, state: 'running' });
    expect(h.docker.log).not.toContain(`rm ${name}`);
    expect(h.docker.images.has(image)).toBe(true);
    expect(h.docker.log).toContain(`rm ${ownLeftover.id}`);
    expect(h.docker.containerByRef(ownLeftover.id)).toBeUndefined();
    expect(h.logger.warnings.some((line) => line.includes(`The labels of the volume ${name} could not be read`))).toBe(true);
    expect(h.logger.warnings.some((line) => line.includes(`Nothing of the name ${name} is removed`))).toBe(true);
    const [entry] = await h.registry.list();
    expect(entry?.id).toBe(FREE);
    expect(entry.busy?.operation).toBe('create');
    expect(entry.busy?.since).toBe(new Date(0).toISOString());
    expect(removePending).toHaveBeenCalledWith(FREE);
  });

  // The volume of the name is another devspace's: a container with this devspace's ID is still removed, but the
  // Compose project of the name (the same project name as the other devspace's) is not, so its networks stay.
  it('a failed first open whose volume is another devspace\'s removes its own containers, not the Compose project', async () => {
    const name = firstOpenOfFree();
    const project = composeProjectName(REPO, FREE);
    h.docker.volumes.set(name, theirs);
    const ownLeftover = h.docker.addContainer({
      devspaceId: FREE,
      name: `${project}-db-1`,
      state: 'stopped',
      image: 'postgres:16',
      labels: { [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION), [COMPOSE_PROJECT_LABEL]: project, [COMPOSE_CONTAINER_NUMBER_LABEL]: '1' },
    });
    h.docker.networks.set(`${project}_default`, { [COMPOSE_PROJECT_LABEL]: project });
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('startFailed');
    expect(h.docker.containerByRef(ownLeftover.id)).toBeUndefined();
    expect(h.docker.networks.has(`${project}_default`)).toBe(true);
    expect(h.docker.log.filter((line) => line.startsWith('network rm'))).toEqual([]);
    expect(h.docker.volumes.get(name)).toEqual(theirs);
  });

  // A first open whose volume labels cannot be read after the create never clones into it.
  it('a first open whose volume labels cannot be read after the create clones nothing', async () => {
    const name = firstOpenOfFree();
    h.docker.inspectVolumes = async () => {
      throw new Error('timeout');
    };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('startFailed');
    expect(error.detail).toContain(`The labels of the volume ${name} could not be read.`);
    expect(h.helper.calls.filter((call) => call.startsWith('clone'))).toEqual([]);
  });

  // An existing devspace whose volume labels cannot be read is not opened (openExisting with `unreadable`).
  it('an existing devspace whose volume labels cannot be read is not opened', async () => {
    await seedDevspace(h, { container: 'stopped' });
    h.docker.inspectVolumes = async () => {
      throw new Error('timeout');
    };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('startFailed');
    expect(h.helper.calls.filter((call) => call.startsWith('up') || call.startsWith('clone'))).toEqual([]);
  });

  // Delete of an existing devspace whose volume of the name has no labels removes nothing of the name (the volume,
  // the images), only the entry.
  it('Delete keeps a volume of the name without labels, and the images of the name', async () => {
    await seedDevspace(h, { container: null });
    h.docker.volumes.set(NAME, {});
    await h.service.delete(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] });
    expect(h.docker.volumes.get(NAME)).toEqual({});
    expect(h.docker.images.has(IMAGE_1)).toBe(true);
    expect(await h.registry.get(ENV_ID)).toBeUndefined();
  });

  /**
   * A failed update (`up` of IMAGE_2 fails before the CLI removed anything); `change` alters the surviving container
   * then. IMAGE_1 names another image now (so the open builds), and the container's own image is kept:1, so the
   * previous image is that image's ID, OWN (as in the fallback tests after a failed build or update).
   */
  const OWN = `sha256:image-of-${IMAGE_1}`;
  async function failedUpdate(change: (survivor: ContainerInfo) => ContainerInfo): Promise<void> {
    await seedDevspace(h, { container: 'stopped' });
    h.docker.images.add('kept:1');
    h.docker.imageIds.set('kept:1', OWN);
    h.docker.imageIds.set(IMAGE_1, `sha256:${'7'.repeat(64)}`);
    h.helper.upFailsBeforeRemoval = true;
    h.helper.upError = (image) => {
      if (image !== IMAGE_2) return undefined;
      const [survivor] = h.docker.containersOf(ENV_ID);
      h.docker.containers.set(survivor.id, change(survivor));
      return new DevcontainerCommandError('devcontainer up', 1, '', 'invalid override');
    };
    await h.service.open(TARGET, options()).catch(() => undefined);
  }

  // A survivor whose image differs from the previous image by its name and its ID (half created from the new image) is
  // replaced, not started again.
  it('a failed update replaces a survivor created from another image', async () => {
    await failedUpdate((survivor) => ({ ...survivor, image: IMAGE_2, imageId: `sha256:${'8'.repeat(64)}` }));
    expect(ups()).toEqual([`up ${IMAGE_2} --remove-existing-container`, `up ${OWN} --remove-existing-container`]);
    expect(h.logger.infos.some((line) => line.includes(`created again from the previous devspace image ${OWN}`))).toBe(true);
  });

  // An outdated survivor (an older container version) is created again, although its image is the previous image.
  it('a failed update creates an outdated survivor again', async () => {
    await failedUpdate((survivor) => ({ ...survivor, labels: { ...survivor.labels, [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION - 1) } }));
    expect(ups()).toEqual([`up ${IMAGE_2} --remove-existing-container`, `up ${OWN} --remove-existing-container`]);
  });
});

describe('Clone again and the listing of the configurations on a volume of the name', () => {
  const theirs = { [LABEL_DEVSPACE_ID]: OTHER_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: OTHER_ACCOUNT.id };

  /** The question about the missing files is open while another devspace of the same pair creates the volume. */
  function foreignVolumeWhileAsking(): void {
    const ask = h.ui.filesMissing.bind(h.ui);
    h.ui.filesMissingAnswer = 'cloneAgain';
    h.ui.filesMissing = async (repository: string) => {
      h.docker.volumes.set(NAME, { ...theirs });
      return ask(repository);
    };
  }

  it('Clone again never clones into or starts on a volume of its name that another devspace created meanwhile', async () => {
    await seedDevspace(h, { container: null, volume: false });
    foreignVolumeWhileAsking();
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('startFailed');
    expect(h.helper.clones.filter((clone) => clone.volumeName === NAME)).toEqual([]);
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([]);
    expect(h.docker.volumes.get(NAME)).toEqual(theirs);
  });

  it('a failed Clone again removes its own new volume, so the files count as missing again', async () => {
    await seedDevspace(h, { container: null, volume: false });
    h.ui.filesMissingAnswer = 'cloneAgain';
    h.helper.cloneError = new Error('network down');
    await rejection(h.service.open(TARGET, options()));
    expect(h.docker.volumes.has(NAME)).toBe(false);
  });

  it('the listing of the configurations never lists those of a volume of its name that is another devspace\'s', async () => {
    await seedDevspace(h, { container: null });
    h.docker.volumes.set(NAME, { ...theirs });
    const listed = await h.service.listConfigurations(ENV_ID, options()).catch(() => 'refused');
    expect(listed).toBe('refused');
    expect(h.helper.calls).not.toContain('listConfigurations');
  });
});

describe('Delete when the volume of the name is another devspace\'s', () => {
  const theirs = { [LABEL_DEVSPACE_ID]: OTHER_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: OTHER_ACCOUNT.id };

  // With colliding names, the container of the name is the other devspace's dev container: Delete neither stops nor
  // removes it.
  it('never stops or removes the running container of the name that is another devspace\'s', async () => {
    await seedDevspace(h, { container: null });
    h.docker.volumes.set(NAME, theirs);
    const theirContainer = h.docker.addContainer({ devspaceId: OTHER_ID, name: NAME, state: 'running', image: 'their-image:1' });
    await h.service.delete(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] });
    expect(h.docker.containerByRef(theirContainer.id)).toMatchObject({ name: NAME, state: 'running' });
    expect(h.docker.log).not.toContain(`rm ${NAME}`);
    expect(h.docker.log.filter((line) => line.startsWith('stop '))).toEqual([]);
    expect(await h.registry.get(ENV_ID)).toBeUndefined();
  });

  // With colliding names, the Compose project of the name is the other devspace's: Delete of an entry with a Compose
  // build record keeps its networks (as for a failed first open).
  it('never removes the Compose project of the name (its networks) that is another devspace\'s', async () => {
    const project = composeProjectName(REPO, ENV_ID);
    await seedDevspace(h, {
      container: null,
      record: { compose: { service: 'app', images: [`${project}-app`], serviceImages: [], version: '2.40.3', inputsHash: 'inputs-1' } },
    });
    h.docker.volumes.set(NAME, theirs);
    h.docker.networks.set(`${project}_default`, { [COMPOSE_PROJECT_LABEL]: project });
    await h.service.delete(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] });
    expect(h.docker.networks.has(`${project}_default`)).toBe(true);
    expect(h.docker.log.filter((line) => line.startsWith('network rm'))).toEqual([]);
    expect(h.docker.volumes.get(NAME)).toEqual(theirs);
    expect(await h.registry.get(ENV_ID)).toBeUndefined();
  });
});

// requireOwnVolume refuses a volume that is missing right after `docker volume create` (removed concurrently, or
// created on another context): a helper run on it would create an empty volume without labels. Also for Clone again and
// The listing of the configurations.
describe('a workspace volume that is missing where its own is required', () => {
  it('a first open whose volume is missing after the create clones nothing', async () => {
    vi.spyOn(h.docker, 'createVolume').mockResolvedValue(undefined);
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('startFailed');
    expect(error.detail).toContain('belongs to another devspace');
    expect(h.helper.calls.filter((call) => call.startsWith('clone') || call.startsWith('up'))).toEqual([]);
    expect(h.helper.clones).toEqual([]);
  });

  it('Clone again whose volume is missing after the create clones nothing', async () => {
    await seedDevspace(h, { container: null, volume: false });
    h.ui.filesMissingAnswer = 'cloneAgain';
    vi.spyOn(h.docker, 'createVolume').mockResolvedValue(undefined);
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('startFailed');
    expect(h.helper.clones).toEqual([]);
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([]);
  });

  it('the listing of the configurations lists nothing of a volume that is gone when the lock is held', async () => {
    await seedDevspace(h, { container: null });
    // The volume existed at the check before the lock (requireVolume), and is gone under the lock.
    vi.spyOn(h.docker, 'volumeExists').mockResolvedValue(true);
    h.docker.volumes.delete(NAME);
    const listed = await h.service.listConfigurations(ENV_ID, options()).catch(() => 'refused');
    expect(listed).toBe('refused');
    expect(h.helper.calls).not.toContain('listConfigurations');
  });
});

describe('Clone again when Docker cannot say whose its new volume is', () => {
  /** `docker volume inspect` fails once, at its call number `failing` (1-based). */
  function inspectFailsAt(failing: number): void {
    const inspect = h.docker.inspectVolumes.bind(h.docker);
    let calls = 0;
    h.docker.inspectVolumes = async (names: readonly string[]) => {
      calls++;
      if (calls === failing) throw new Error('Cannot connect to the Docker daemon (transient)');
      return inspect(names);
    };
  }

  it('removes its new volume when the check after the create fails, and the next open clones again', async () => {
    await seedDevspace(h, { container: null, volume: false });
    h.ui.filesMissingAnswer = 'cloneAgain';
    // 1: the ownership read of the open (missing); 2: requireOwnVolume after createVolume (fails once).
    inspectFailsAt(2);
    await rejection(h.service.open(TARGET, options()));
    expect(h.docker.volumes.has(NAME)).toBe(false);
    const clones = h.helper.clones.length;
    await h.service.open(TARGET, options());
    expect(h.helper.clones.length).toBe(clones + 1);
  });

  it('keeps the create mark (ended) when whose the volume is cannot be read after a failed clone', async () => {
    await seedDevspace(h, { container: null, volume: false });
    h.ui.filesMissingAnswer = 'cloneAgain';
    h.helper.cloneError = new Error('network down');
    // 1: the ownership read of the open; 2: requireOwnVolume (own); 3: the read after the failed clone (fails once).
    inspectFailsAt(3);
    await rejection(h.service.open(TARGET, options()));
    expect(h.docker.volumes.has(NAME)).toBe(true);
    expect((await h.registry.get(ENV_ID))?.busy?.operation).toBe('create');
    // The mark is ended (it blocks no window), not live.
    expect((await h.registry.get(ENV_ID))?.busy?.since).toBe(new Date(0).toISOString());
  });

  it('keeps the create mark (ended) when its own new volume cannot be removed after a failed clone', async () => {
    await seedDevspace(h, { container: null, volume: false });
    h.ui.filesMissingAnswer = 'cloneAgain';
    h.helper.cloneError = new Error('network down');
    h.docker.removeVolume = async () => {
      throw new Error('volume is in use');
    };
    await rejection(h.service.open(TARGET, options()));
    expect((await h.registry.get(ENV_ID))?.busy?.operation).toBe('create');
    // The mark is ended (it blocks no window), not live.
    expect((await h.registry.get(ENV_ID))?.busy?.since).toBe(new Date(0).toISOString());
  });
});

// After a failed Clone again, the new volume of the name is removed only while it is its own; a volume of another
// devspace, or one whose labels cannot be read, stays, and no `docker volume rm` runs on it.
describe('a failed Clone again removes the volume of the name only while it is its own', () => {
  const theirs = { [LABEL_DEVSPACE_ID]: OTHER_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: OTHER_ACCOUNT.id };

  it('keeps the volume of the name that another devspace took during the clone, and clears its create mark', async () => {
    await seedDevspace(h, { container: null, volume: false });
    h.ui.filesMissingAnswer = 'cloneAgain';
    // The new volume is removed during the clone, and another devspace of the same pair creates it again.
    h.helper.onClone = () => {
      h.docker.volumes.set(NAME, { ...theirs });
    };
    h.helper.cloneError = new Error('network down');
    await rejection(h.service.open(TARGET, options()));
    expect(h.docker.volumes.get(NAME)).toEqual(theirs);
    expect(h.docker.log).not.toContain(`volume rm ${NAME}`);
    expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
  });

  it('never runs `docker volume rm` on the new volume when whose it is cannot be read after a failed clone', async () => {
    await seedDevspace(h, { container: null, volume: false });
    h.ui.filesMissingAnswer = 'cloneAgain';
    h.helper.cloneError = new Error('network down');
    // 1: the ownership read of the open; 2: requireOwnVolume (own); from 3 on (the read after the failed clone): fails.
    const inspect = h.docker.inspectVolumes.bind(h.docker);
    let calls = 0;
    h.docker.inspectVolumes = async (names: readonly string[]) => {
      calls++;
      if (calls >= 3) throw new Error('Cannot connect to the Docker daemon');
      return inspect(names);
    };
    await rejection(h.service.open(TARGET, options()));
    expect(h.docker.volumes.has(NAME)).toBe(true);
    expect(h.docker.log).not.toContain(`volume rm ${NAME}`);
  });
});

describe('Clone again whose `docker volume create` reports a failure after the daemon created the volume', () => {
  it('removes the volume that was created, so the files count as missing again and the next open clones', async () => {
    await seedDevspace(h, { container: null, volume: false });
    h.ui.filesMissingAnswer = 'cloneAgain';
    const create = h.docker.createVolume.bind(h.docker);
    let failed = false;
    h.docker.createVolume = async (name: string, labels: Record<string, string>) => {
      await create(name, labels);
      if (!failed) {
        failed = true;
        throw new Error('error during connect: unexpected EOF (ssh connection lost)');
      }
    };
    await expect(h.service.open(TARGET, options())).rejects.toThrow('unexpected EOF');
    expect(h.docker.volumes.has(NAME)).toBe(false);
    const clones = h.helper.clones.length;
    await h.service.open(TARGET, options());
    expect(h.helper.clones.length).toBe(clones + 1);
  });
});

describe('a failed Clone again and the newest image: edge cases', () => {
  it('a failed Clone again never ends a mark of another window', async () => {
    await seedDevspace(h, { container: null, volume: false });
    h.ui.filesMissingAnswer = 'cloneAgain';
    h.helper.cloneError = new Error('network down');
    const theirs = { operation: 'create' as const, since: '2026-10-03T10:00:00.000Z', pid: process.pid + 1, windowId: 'another-window' };
    h.helper.onClone = async () => {
      await h.registry.updateDevspace(ENV_ID, (entry) => {
        entry.busy = { ...theirs };
      });
      // Whose the volume is cannot be read after the failure: the mark would be kept as ended, but only its own.
      h.docker.inspectVolumes = async () => {
        throw new Error('timeout');
      };
    };
    await rejection(h.service.open(TARGET, options()));
    expect((await h.registry.get(ENV_ID))?.busy).toEqual(theirs);
  });

  it('a failure to keep the create mark never hides the error of the clone', async () => {
    await seedDevspace(h, { container: null, volume: false });
    h.ui.filesMissingAnswer = 'cloneAgain';
    h.helper.cloneError = new Error('network down');
    h.helper.onClone = () => {
      h.docker.inspectVolumes = async () => {
        throw new Error('timeout');
      };
      const update = h.registry.updateDevspace.bind(h.registry);
      let calls = 0;
      h.registry.updateDevspace = async (id, mutator) => {
        if (calls++ === 0) throw new Error('registry not writable');
        return update(id, mutator);
      };
    };
    await expect(h.service.open(TARGET, options())).rejects.toMatchObject({ detail: expect.stringContaining('network down') });
  });

  it('takes no record over from an image with the tag 0', async () => {
    await seedDevspace(h, { record: null, container: null });
    const zero = `${NAME}:0`;
    addImage(zero, labelsOf(recordOf(zero, 0)));
    await h.service.open(TARGET, options());
    expect((await h.registry.get(ENV_ID))?.buildRecord?.devspaceImage).not.toBe(zero);
    expect(h.helper.builds).toHaveLength(1);
  });
});
