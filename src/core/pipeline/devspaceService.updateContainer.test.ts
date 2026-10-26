// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// An open with a newer image for the existing container of the devspace (running or stopped) announces the update
// (setting updateContainer `notify`: Continue or Cancel) or asks (`ask`: Update Now or Later); a first build, a missing
// image and a rebuild stay without the question. The image check of a running container is never skipped for a recent
// check; the Monitor's registry answer covers that case (devspaceService.registryAnswers.test.ts).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UserFacingError } from '../errors';
import { Messages } from '../messages';
import { devspaceImageName } from '../names';
import type { Devspace } from '../types';
import { BASE_IMAGE, DIGEST_NEW, DIGEST_OLD, ENV_ID, REPO, createHarness, seedDevspace, type Harness } from './devspaceService.testkit';

const IMAGE_1 = devspaceImageName(REPO, ENV_ID, 1);
const IMAGE_2 = devspaceImageName(REPO, ENV_ID, 2);
const OLD_RECORD = { images: { [BASE_IMAGE]: DIGEST_OLD } };

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

afterEach(() => {
  h.cleanup();
});

async function entry(): Promise<Devspace | undefined> {
  return h.registry.get(ENV_ID);
}

async function open(extra: { forceRebuild?: boolean } = {}) {
  return h.service.openDevspace(ENV_ID, { progress: h.progress, ...extra });
}

async function cancelled(promise: Promise<unknown>): Promise<UserFacingError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(UserFacingError);
  expect((error as UserFacingError).code).toBe('cancelled');
  return error as UserFacingError;
}

describe('the update of an existing container', () => {
  for (const state of ['running', 'stopped'] as const) {
    describe(`a ${state} container`, () => {
      it('asks first; the update goes on when the user continues', async () => {
        await seedDevspace(h, { record: OLD_RECORD, container: state });
        h.ui.updateContainerAnswer = 'update';
        await open();
        expect(h.ui.prompts).toEqual([`updateContainer ${REPO} ${state}`]);
        expect(h.helper.calls).toContain(`build ${IMAGE_2}`);
        expect(h.helper.calls).toContain(`up ${IMAGE_2} --remove-existing-container`);
        expect((await entry())?.buildRecord).toMatchObject({ devspaceImage: IMAGE_2, images: { [BASE_IMAGE]: DIGEST_NEW } });
        expect(h.logger.infos).toContain(`Decision for ${REPO}: a new devspace image (a newer image is available).`);
      });

      it('Cancel ends the open: nothing pulled, built, removed or started, the lock released, a short info', async () => {
        await seedDevspace(h, { record: OLD_RECORD, container: state });
        const before = h.docker.containersOf(ENV_ID).map((c) => [c.id, c.state, c.image]);
        h.ui.updateContainerAnswer = 'cancel';
        await cancelled(open());
        expect(h.ui.prompts).toEqual([`updateContainer ${REPO} ${state}`]);
        expect(h.docker.log.filter((line) => line.startsWith('pull') || line.startsWith('rm'))).toEqual([]);
        expect(h.helper.builds).toEqual([]);
        expect(h.helper.ups).toEqual([]);
        expect(h.docker.containersOf(ENV_ID).map((c) => [c.id, c.state, c.image])).toEqual(before);
        expect(h.docker.images.has(IMAGE_1)).toBe(true);
        const env = await entry();
        expect(env?.buildRecord).toMatchObject({ devspaceImage: IMAGE_1, images: { [BASE_IMAGE]: DIGEST_OLD } });
        expect(env?.busy).toBeUndefined();
        expect(h.lock.released).toEqual(h.lock.acquired);
        expect(h.lock.acquired).toEqual([ENV_ID]);
        expect((await h.sessionFiles.readPendings()).map((p) => p.devspaceId)).toEqual([]);
        expect(h.ui.infos).toEqual([Messages.containerUpdateCancelled(REPO)]);
        expect(h.ui.warnings).toEqual([]);
        expect(h.logger.infos).toContain(`Decision for ${REPO}: no build (the update of its container was cancelled; nothing was changed, and the window is not connected).`);
        // The next open asks again and can update.
        h.ui.updateContainerAnswer = 'update';
        await open();
        expect(h.helper.calls).toContain(`build ${IMAGE_2}`);
      });

      it('Later uses the existing container without the update, and the decision says "update postponed"', async () => {
        await seedDevspace(h, { record: OLD_RECORD, container: state });
        const before = h.docker.containersOf(ENV_ID)[0].id;
        h.ui.updateContainerAnswer = 'later';
        const result = await open();
        expect(result.devspace.id).toBe(ENV_ID);
        expect(h.ui.prompts).toEqual([`updateContainer ${REPO} ${state}`]);
        expect(h.docker.log.filter((line) => line.startsWith('pull'))).toEqual([]);
        expect(h.helper.builds).toEqual([]);
        expect(h.helper.ups.every((up) => up.image === IMAGE_1 && !up.removeExistingContainer)).toBe(true);
        // A running container opens as it is; a stopped one starts.
        expect(h.helper.ups).toHaveLength(state === 'running' ? 0 : 1);
        expect(h.docker.containersOf(ENV_ID).map((c) => [c.id, c.state])).toEqual([[before, 'running']]);
        expect((await entry())?.buildRecord).toMatchObject({ devspaceImage: IMAGE_1, images: { [BASE_IMAGE]: DIGEST_OLD } });
        expect(h.logger.infos).toContain(`Decision for ${REPO}: no build (update postponed).`);
      });
    });
  }

  it('asks nothing for a rebuild, a missing devspace image, a first build, a missing container, or an image that is current', async () => {
    await seedDevspace(h, { record: OLD_RECORD, container: 'running' });
    h.ui.updateContainerAnswer = 'cancel';
    await open({ forceRebuild: true });
    expect(h.helper.calls).toContain(`build ${IMAGE_2}`);
    h.cleanup();

    h = createHarness();
    h.ui.updateContainerAnswer = 'cancel';
    await seedDevspace(h, { record: OLD_RECORD, container: 'running', image: false });
    await open();
    expect(h.helper.builds).toHaveLength(1);
    h.cleanup();

    h = createHarness();
    h.ui.updateContainerAnswer = 'cancel';
    await seedDevspace(h, { record: null, container: 'running' });
    await open();
    expect(h.helper.builds).toHaveLength(1);
    h.cleanup();

    h = createHarness();
    h.ui.updateContainerAnswer = 'cancel';
    await seedDevspace(h, { record: OLD_RECORD, container: null });
    await open();
    expect(h.helper.calls).toContain(`build ${IMAGE_2}`);
    h.cleanup();

    h = createHarness();
    h.ui.updateContainerAnswer = 'cancel';
    await seedDevspace(h, { container: 'running' });
    await open();
    expect(h.helper.builds).toEqual([]);
    expect(h.ui.prompts).toEqual([]);
  });

  it('asks nothing when the configuration changed and the user chose Rebuild now', async () => {
    await seedDevspace(h, { record: { ...OLD_RECORD, configHash: 'sha256:other' }, container: 'running' });
    h.ui.configurationChangedAnswer = 'rebuildNow';
    h.ui.updateContainerAnswer = 'cancel';
    await open();
    expect(h.ui.prompts).toEqual([`configurationChanged ${REPO}`]);
    expect(h.helper.calls).toContain(`build ${IMAGE_2}`);
  });
});

describe('no image check is skipped for a recent one', () => {
  it('checks the registry at each open of a running container, and records no check time', async () => {
    await seedDevspace(h, { container: 'running' });
    await open();
    await open();
    expect(h.checker.calls).toHaveLength(2);
    expect(await entry()).not.toHaveProperty('imagesCheckedAt');
    expect(h.logger.infos.some((line) => line.includes('image check skipped'))).toBe(false);
  });
});
