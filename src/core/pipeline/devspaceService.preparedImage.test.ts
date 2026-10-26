// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// An update takes the prepared devspace image `<resource>:prepared` that a background prepare built for it, without
// a pull and a build, when its labels fit (the devspace, the key of this update, the helper image of this open);
// every check of the new image before `up` stays. A prepare that runs (its prepare lock is held) is waited for after
// Continue or Update Now; Later and Cancel behave as without a prepare.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UserFacingError } from '../errors';
import { Messages } from '../messages';
import { LABEL_BUILD_RECORD, LABEL_DEVSPACE_ID, LABEL_OWNER_ID, LABEL_PREPARED, LABEL_REPOSITORY, devspaceImageName, preparedImageName } from '../names';
import { abortError } from '../ports';
import type { Devspace } from '../types';
import type { PrepareLock } from './devspacePorts';
import {
  ACCOUNT,
  BASE_IMAGE,
  DEFAULT_CONFIG_TEXT,
  DIGEST_NEW,
  DIGEST_OLD,
  ENV_ID,
  FEATURE,
  FEATURE_DIGEST,
  REPO,
  createHarness,
  imageConfigWithUser,
  seedDevspace,
  type Harness,
} from './devspaceService.testkit';
import { preparedImageLabels, type PrepareKey } from './imageRecord';
import { PipelineTexts } from './operationBase';
import { PREPARE_WAIT_STEP_SECONDS, configHash } from './pipelineRules';
import { DEFAULT_CONFIG_PATH } from './recordRules';

const IMAGE_1 = devspaceImageName(REPO, ENV_ID, 1);
const IMAGE_2 = devspaceImageName(REPO, ENV_ID, 2);
const PREPARED = preparedImageName(REPO, ENV_ID);
const PREPARED_ID = `sha256:${'9'.repeat(64)}`;
const OLD_RECORD = { images: { [BASE_IMAGE]: DIGEST_OLD } };
/** The key of the update of OLD_RECORD to the default check outcome (updateKey). */
const KEY: PrepareKey = {
  configPath: DEFAULT_CONFIG_PATH,
  configHash: configHash(DEFAULT_CONFIG_TEXT),
  images: { [BASE_IMAGE]: DIGEST_NEW },
  features: { [FEATURE]: FEATURE_DIGEST },
};
const ENV = { id: ENV_ID, repository: REPO, owner: ACCOUNT };

/** The prepare lock of the tests: held or not, and what a wait for it does. */
class FakePrepareLock implements PrepareLock {
  isHeld = false;
  /** How many waits of waitFree end with the lock still held before one gets it free. */
  heldWaits = 0;
  /** Runs during waitFree (a prepare that ends, a cancel), with the number of the wait (from 1). */
  onWait: ((wait: number) => void) | undefined;
  readonly calls: string[] = [];

  async held(devspaceId: string): Promise<boolean> {
    this.calls.push(`held ${devspaceId}`);
    return this.isHeld;
  }

  async waitFree(devspaceId: string, waitSeconds: number, signal: AbortSignal | undefined): Promise<boolean> {
    this.calls.push(`waitFree ${devspaceId} ${waitSeconds}`);
    const wait = this.calls.filter((call) => call.startsWith('waitFree')).length;
    this.onWait?.(wait);
    if (signal?.aborted) throw abortError();
    return wait > this.heldWaits;
  }
}

let h: Harness;
let prepareLock: FakePrepareLock;

beforeEach(() => {
  prepareLock = new FakePrepareLock();
  h = createHarness({ prepareLock });
});

afterEach(() => {
  h.cleanup();
});

async function entry(): Promise<Devspace | undefined> {
  return h.registry.get(ENV_ID);
}

async function open(extra: { forceRebuild?: boolean; signal?: AbortSignal } = {}) {
  return h.service.openDevspace(ENV_ID, { progress: h.progress, ...extra });
}

async function rejection(promise: Promise<unknown>): Promise<UserFacingError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(UserFacingError);
  return error as UserFacingError;
}

/** A prepared image on the engine with the labels of a prepare (preparedImageLabels), changed by `labels`. */
function addPrepared(options: { key?: PrepareKey; helperImage?: string; labels?: Record<string, string>; metadata?: Array<Record<string, unknown>> } = {}): void {
  h.docker.images.add(PREPARED);
  h.docker.imageIds.set(PREPARED, PREPARED_ID);
  const config = imageConfigWithUser('vscode', options.metadata);
  const prepared = preparedImageLabels(ENV, { key: options.key ?? KEY, helperImage: options.helperImage ?? h.helper.currentHelperImageId });
  h.docker.imageConfigs.set(PREPARED, { ...config, Labels: { ...config.Labels, ...prepared, ...options.labels } });
}

function builtNormally(): void {
  expect(h.helper.builds.map((build) => build.imageName)).toEqual([IMAGE_2]);
  expect(h.docker.log).toContain(`pull ${BASE_IMAGE}`);
  expect(h.docker.log.some((line) => line.startsWith('tag '))).toBe(false);
  expect(h.helper.calls).toContain(`up ${IMAGE_2} --remove-existing-container`);
  // The leftover prepared image goes with the old images.
  expect(h.docker.images.has(PREPARED)).toBe(false);
}

describe('the swap to a prepared image at the open', () => {
  it('takes a prepared image that fits: no pull, no build; tagged, labelled, pinned, and the prepared tag removed', async () => {
    await seedDevspace(h, { record: OLD_RECORD, container: 'running' });
    addPrepared();
    await open();
    expect(h.ui.prompts).toEqual([`updateContainer ${REPO} running`]);
    expect(prepareLock.calls).toEqual([`held ${ENV_ID}`]);
    expect(h.helper.builds).toEqual([]);
    expect(h.docker.log.filter((line) => line.startsWith('pull'))).toEqual([]);
    expect(h.docker.log).toContain(`tag ${PREPARED_ID} ${IMAGE_2}`);
    expect(h.helper.calls).toContain(`up ${IMAGE_2} --remove-existing-container`);
    expect(h.docker.images.has(PREPARED)).toBe(false);
    expect(h.docker.images.has(IMAGE_1)).toBe(false);
    const record = (await entry())?.buildRecord;
    expect(record).toMatchObject({ devspaceImage: IMAGE_2, buildNumber: 2, imageId: PREPARED_ID, images: { [BASE_IMAGE]: DIGEST_NEW }, features: { [FEATURE]: FEATURE_DIGEST } });
    expect((await entry())?.lastBuildNumber).toBe(2);
    // The labels of the devspace image with its record; the prepare key is cleared.
    const labels = h.docker.labelled.get(IMAGE_2)!;
    expect(labels).toMatchObject({ [LABEL_DEVSPACE_ID]: ENV_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id, [LABEL_PREPARED]: '' });
    expect(JSON.parse(labels[LABEL_BUILD_RECORD])).toMatchObject({ devspaceImage: IMAGE_2, buildNumber: 2, images: { [BASE_IMAGE]: DIGEST_NEW } });
    expect(h.progress.details).toContain(Messages.newerImage);
    expect(h.logger.infos).toContain(`The prepared image ${PREPARED} (${PREPARED_ID}) fits the update of ${REPO}: it is used without a build.`);
  });

  it('also for a stopped container, and for a missing container (no question)', async () => {
    await seedDevspace(h, { record: OLD_RECORD, container: 'stopped' });
    addPrepared();
    await open();
    expect(h.helper.builds).toEqual([]);
    expect((await entry())?.buildRecord?.imageId).toBe(PREPARED_ID);
    h.cleanup();

    prepareLock = new FakePrepareLock();
    h = createHarness({ prepareLock });
    await seedDevspace(h, { record: OLD_RECORD, container: null });
    addPrepared();
    await open();
    expect(h.ui.prompts).toEqual([]);
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.calls).toContain(`up ${IMAGE_2}`);
  });

  it('still checks the image metadata before `up`: a refused prepared image is not used, the old container starts', async () => {
    await seedDevspace(h, { record: OLD_RECORD, container: 'stopped' });
    addPrepared({ metadata: [{ id: 'docker-in-docker', privileged: true }] });
    const before = h.docker.containersOf(ENV_ID)[0].id;
    await open();
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.ups.map((up) => [up.image, up.removeExistingContainer])).toEqual([[IMAGE_1, false]]);
    expect(h.docker.containersOf(ENV_ID).map((c) => c.id)).toEqual([before]);
    expect(h.ui.warnings).toEqual([Messages.updateRefused('privileged mode')]);
    expect(h.docker.images.has(IMAGE_2)).toBe(false);
    expect((await entry())?.buildRecord?.devspaceImage).toBe(IMAGE_1);
    expect((await entry())?.refusedUpdate).toMatchObject({ ...KEY, items: 'privileged mode' });
  });

  it('a failed tag ends the update like a failed build: the existing container is used', async () => {
    await seedDevspace(h, { record: OLD_RECORD, container: 'running' });
    addPrepared();
    h.docker.tagImageError = new Error('the engine failed');
    await open();
    expect(h.helper.builds).toEqual([]);
    expect(h.ui.warnings).toEqual([Messages.buildFailed]);
    expect(h.docker.images.has(IMAGE_2)).toBe(false);
    expect((await entry())?.buildRecord?.devspaceImage).toBe(IMAGE_1);
  });

  const other = `sha256:${'d'.repeat(64)}`;
  for (const [label, prepared] of [
    ['another devspace ID', { labels: { [LABEL_DEVSPACE_ID]: '7c1d2e3f-0000-4000-8000-000000000002' } }],
    ['another repository', { labels: { [LABEL_REPOSITORY]: 'acme/web' } }],
    ['another owner', { labels: { [LABEL_OWNER_ID]: '2002' } }],
    ['no prepare label', { labels: { [LABEL_PREPARED]: '' } }],
    ['a prepare label that is no JSON', { labels: { [LABEL_PREPARED]: '{' } }],
    ['a prepare label with more keys', { labels: { [LABEL_PREPARED]: JSON.stringify({ key: KEY, helperImage: 'x', extra: 1 }) } }],
    ['another configuration path', { key: { ...KEY, configPath: '.devcontainer/python/devcontainer.json' } }],
    ['another configuration hash', { key: { ...KEY, configHash: `sha256:${'f'.repeat(64)}` } }],
    ['another image digest', { key: { ...KEY, images: { [BASE_IMAGE]: other } } }],
    ['the old image digest', { key: { ...KEY, images: { [BASE_IMAGE]: DIGEST_OLD } } }],
    ['another Feature digest', { key: { ...KEY, features: { [FEATURE]: other } } }],
    ['a Feature less', { key: { ...KEY, features: {} } }],
    ['an image more', { key: { ...KEY, images: { ...KEY.images, 'node:20': other } } }],
    ['the host access checks off', { key: { ...KEY, hostAccessChecks: 'off' as const } }],
    ['another helper image', { helperImage: other }],
  ] as const) {
    it(`builds normally with a prepared image of ${label}`, async () => {
      await seedDevspace(h, { record: OLD_RECORD, container: 'running' });
      addPrepared(prepared);
      await open();
      builtNormally();
      expect((await entry())?.buildRecord?.devspaceImage).toBe(IMAGE_2);
      expect((await entry())?.buildRecord?.imageId).not.toBe(PREPARED_ID);
      expect(h.logger.infos.some((line) => line.startsWith(`The prepared image ${PREPARED} is not used for ${REPO}: `))).toBe(true);
    });
  }

  it('never takes a prepared image with the host access checks off for the repository, whatever its key', async () => {
    h.settings = { ...h.settings, hostAccessChecksOff: [REPO] };
    await seedDevspace(h, { record: OLD_RECORD, container: 'running' });
    addPrepared({ key: { ...KEY, hostAccessChecks: 'off' } });
    await open();
    expect(prepareLock.calls).toEqual([]);
    expect(h.helper.builds.map((build) => build.imageName)).toEqual([IMAGE_2]);
    expect(h.docker.log.some((line) => line.startsWith('tag '))).toBe(false);
  });

  it('never takes a prepared image for a rebuild, a missing devspace image, or a first build', async () => {
    await seedDevspace(h, { record: OLD_RECORD, container: 'running' });
    addPrepared();
    await open({ forceRebuild: true });
    builtNormally();
    h.cleanup();

    prepareLock = new FakePrepareLock();
    h = createHarness({ prepareLock });
    await seedDevspace(h, { record: OLD_RECORD, container: 'running', image: false });
    addPrepared();
    await open();
    expect(h.helper.builds).toHaveLength(1);
    expect(h.docker.log.some((line) => line.startsWith('tag '))).toBe(false);
    h.cleanup();

    prepareLock = new FakePrepareLock();
    h = createHarness({ prepareLock });
    await seedDevspace(h, { record: null, container: 'running' });
    addPrepared();
    await open();
    expect(h.helper.builds).toHaveLength(1);
    expect(h.docker.log.some((line) => line.startsWith('tag '))).toBe(false);
    expect(prepareLock.calls).toEqual([]);
  });

  it('is not looked at when the images are current', async () => {
    await seedDevspace(h, { container: 'running' });
    addPrepared();
    await open();
    expect(h.helper.builds).toEqual([]);
    expect(prepareLock.calls).toEqual([]);
    expect(h.docker.images.has(PREPARED)).toBe(true);
  });

  it('Delete removes a prepared image of the devspace', async () => {
    await seedDevspace(h, { container: 'stopped' });
    addPrepared();
    await h.service.delete(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] });
    expect(h.docker.log).toContain(`rmi ${PREPARED}`);
    expect(h.docker.images.has(PREPARED)).toBe(false);
  });
});

describe('a prepare that runs at the open', () => {
  it('is waited for in waits of a minute, with no limit of its own', () => {
    expect(PREPARE_WAIT_STEP_SECONDS).toBe(60);
  });

  it('Continue waits for it with its detail, then takes the image it prepared', async () => {
    await seedDevspace(h, { record: OLD_RECORD, container: 'running' });
    prepareLock.isHeld = true;
    prepareLock.onWait = () => addPrepared();
    h.ui.updateContainerAnswer = 'update';
    await open();
    expect(h.ui.prompts).toEqual([`updateContainer ${REPO} running`]);
    expect(prepareLock.calls).toEqual([`held ${ENV_ID}`, `waitFree ${ENV_ID} ${PREPARE_WAIT_STEP_SECONDS}`]);
    expect(h.progress.details).toContain(PipelineTexts.preparingNewerImage(0));
    expect(PipelineTexts.preparingNewerImage(0)).toBe('Preparing the newer image.');
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.calls).toContain(`up ${IMAGE_2} --remove-existing-container`);
    expect((await entry())?.buildRecord?.imageId).toBe(PREPARED_ID);
  });

  it('Update Now of the setting `ask` waits the same way', async () => {
    h.settings = { ...h.settings, updateContainer: 'ask' };
    await seedDevspace(h, { record: OLD_RECORD, container: 'stopped' });
    prepareLock.isHeld = true;
    prepareLock.onWait = () => addPrepared();
    h.ui.updateContainerAnswer = 'update';
    await open();
    expect(prepareLock.calls).toHaveLength(2);
    expect(h.helper.builds).toEqual([]);
    expect((await entry())?.buildRecord?.imageId).toBe(PREPARED_ID);
  });

  it('builds normally when the prepared image does not fit after the wait', async () => {
    await seedDevspace(h, { record: OLD_RECORD, container: 'running' });
    prepareLock.isHeld = true;
    prepareLock.onWait = () => addPrepared({ key: { ...KEY, images: { [BASE_IMAGE]: DIGEST_OLD } } });
    await open();
    builtNormally();
  });

  it('waits until the prepare ends, without a limit of its own, with the minutes in its detail', async () => {
    await seedDevspace(h, { record: OLD_RECORD, container: 'running' });
    prepareLock.isHeld = true;
    // 34 waits of a minute end with the lock held (longer than 30 minutes); the 35th gets it free.
    prepareLock.heldWaits = 34;
    prepareLock.onWait = (wait) => {
      if (wait === 35) addPrepared();
    };
    await open();
    expect(prepareLock.calls.filter((call) => call.startsWith('waitFree'))).toHaveLength(35);
    expect(h.progress.details).toContain('Preparing the newer image.');
    expect(h.progress.details).toContain('Preparing the newer image (1 min)…');
    expect(h.progress.details).toContain('Preparing the newer image (3 min)…');
    expect(h.progress.details).toContain('Preparing the newer image (34 min)…');
    expect(h.helper.builds).toEqual([]);
    expect((await entry())?.buildRecord?.imageId).toBe(PREPARED_ID);
    expect(h.logger.infos).toContain(`The prepare of the newer image of ${REPO} ended (the update waited about 34 min).`);
  });

  it('a cancel during a later wait ends the open like Cancel', async () => {
    await seedDevspace(h, { record: OLD_RECORD, container: 'running' });
    const controller = new AbortController();
    prepareLock.isHeld = true;
    prepareLock.heldWaits = 100;
    prepareLock.onWait = (wait) => {
      if (wait === 4) controller.abort();
    };
    const error = await rejection(open({ signal: controller.signal }));
    expect(error.code).toBe('cancelled');
    expect(prepareLock.calls.filter((call) => call.startsWith('waitFree'))).toHaveLength(4);
    expect(h.progress.details).toContain('Preparing the newer image (3 min)…');
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.ups).toEqual([]);
    expect((await entry())?.buildRecord?.devspaceImage).toBe(IMAGE_1);
  });

  it('Later opens the current container at once, without a wait', async () => {
    await seedDevspace(h, { record: OLD_RECORD, container: 'running' });
    prepareLock.isHeld = true;
    h.ui.updateContainerAnswer = 'later';
    await open();
    expect(prepareLock.calls).toEqual([]);
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.ups).toEqual([]);
    expect((await entry())?.buildRecord?.devspaceImage).toBe(IMAGE_1);
  });

  it('Cancel ends the open without a wait and without a connect', async () => {
    await seedDevspace(h, { record: OLD_RECORD, container: 'running' });
    prepareLock.isHeld = true;
    h.ui.updateContainerAnswer = 'cancel';
    const error = await rejection(open());
    expect(error.code).toBe('cancelled');
    expect(prepareLock.calls).toEqual([]);
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.ups).toEqual([]);
    expect((await h.sessionFiles.readPendings()).map((p) => p.devspaceId)).toEqual([]);
  });

  it('a cancel of the progress during the wait ends the open like Cancel: nothing built, swapped, or started', async () => {
    await seedDevspace(h, { record: OLD_RECORD, container: 'running' });
    const controller = new AbortController();
    prepareLock.isHeld = true;
    prepareLock.onWait = () => {
      addPrepared();
      controller.abort();
    };
    const error = await rejection(open({ signal: controller.signal }));
    expect(error.code).toBe('cancelled');
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.ups).toEqual([]);
    expect(h.docker.log.some((line) => line.startsWith('tag ') || line.startsWith('pull '))).toBe(false);
    expect((await entry())?.buildRecord?.devspaceImage).toBe(IMAGE_1);
    expect(h.lock.released).toEqual(h.lock.acquired);
  });
});
