// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The headless prepare (DevspaceService.prepare) on the fakes of the harness, with deps of a prepare that know no
// computer: every part of a computer (the records, busy marks, session files, the token and the account, the questions,
// the windows, the devspace lock) records its use and throws, and each test checks that none was used. The
// devspaces come from the volumes (engineDevspaceStore). The open of the harness then swaps to the prepared
// image, end to end on the same engine.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LABEL_HOST_ACCESS, LABEL_PREPARED, HOST_ACCESS_UNRESTRICTED, devspaceImageName, preparedImageName } from '../names';
import { abortError } from '../ports';
import type { BuildRecord, Devspace } from '../types';
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
  checked,
  createHarness,
  headlessPrepareService,
  imageConfigWithUser,
  prepareRun,
  seedDevspace,
  type Harness,
} from './devspaceService.testkit';
import { imageRecordLabels, preparedImageLabels, type PrepareKey } from './imageRecord';
import { PREPARE_LIMIT_MS, PREPARE_STOP_WAIT_SECONDS, configHash, prepareKeyHash } from './pipelineRules';
import { DEFAULT_CONFIG_PATH } from './recordRules';

const IMAGE_1 = devspaceImageName(REPO, ENV_ID, 1);
const IMAGE_2 = devspaceImageName(REPO, ENV_ID, 2);
const PREPARED = preparedImageName(REPO, ENV_ID);
const OLD_RECORD = { images: { [BASE_IMAGE]: DIGEST_OLD } };
/** The key of the update of OLD_RECORD to the default check outcome (updateKey). */
const KEY: PrepareKey = {
  configPath: DEFAULT_CONFIG_PATH,
  configHash: configHash(DEFAULT_CONFIG_TEXT),
  images: { [BASE_IMAGE]: DIGEST_NEW },
  features: { [FEATURE]: FEATURE_DIGEST },
};
const ENV = { id: ENV_ID, repository: REPO, owner: ACCOUNT };

let h: Harness;
/** Every use of a part of a computer by the prepare (must stay empty). */
let hostUses: string[];

beforeEach(() => {
  h = createHarness();
  hostUses = [];
});

afterEach(() => {
  h.cleanup();
});

/** A devspace whose image carries its build record (OLD_RECORD), as a build of the open labels it. */
async function seedLabelled(options: Parameters<typeof seedDevspace>[1] = {}): Promise<Devspace> {
  const env = await seedDevspace(h, { record: OLD_RECORD, container: 'running', ...options });
  const record = env.buildRecord as BuildRecord;
  const config = imageConfigWithUser('vscode');
  h.docker.imageConfigs.set(record.devspaceImage, { ...config, Labels: { ...config.Labels, ...imageRecordLabels(env, record) } });
  return env;
}

async function prepare(options: Parameters<typeof prepareRun>[0] = {}) {
  const { run, events, recorded } = prepareRun(options);
  const headless = headlessPrepareService(h);
  hostUses = headless.hostUses;
  const result = await headless.service.prepare(ENV_ID, run);
  return { result, events, recorded };
}

const HASH = () => prepareKeyHash(KEY, h.helper.currentHelperImageId);

describe('the headless prepare', () => {
  it('builds <resource>:prepared with the labels of the update, frozen lockfile, no token, under the prepare lock only', async () => {
    await seedLabelled();
    const { result, events } = await prepare();
    expect(result).toMatchObject({ outcome: 'prepared' });
    expect(hostUses).toEqual([]);
    expect(events).toEqual([`take ${ENV_ID}`, `release ${ENV_ID}`]);
    // No devspace lock (only the harness's own open would take it).
    expect(h.lock.acquired).toEqual([]);
    expect(h.helper.builds).toEqual([{ imageName: PREPARED, configPath: DEFAULT_CONFIG_PATH, frozenLockfile: true }]);
    expect(h.helper.buildTokens).toEqual([undefined]);
    // The changed base image is pulled (anonymously: the engine of a prepare has no login).
    expect(h.docker.log).toContain(`pull ${BASE_IMAGE}`);
    expect(h.docker.labelled.get(PREPARED)).toEqual(preparedImageLabels(ENV, { key: KEY, helperImage: h.helper.currentHelperImageId }));
    // Nothing of the devspace changed: no container, no record, no image of a build number.
    expect(h.helper.ups).toEqual([]);
    expect(h.docker.log.filter((line) => line.startsWith('rm ') || line.startsWith('stop ') || line.startsWith('start '))).toEqual([]);
    expect(h.docker.images.has(IMAGE_2)).toBe(false);
    expect((await h.registry.get(ENV_ID))?.buildRecord?.devspaceImage).toBe(IMAGE_1);
    expect(h.logger.infos.some((line) => line.startsWith(`${REPO}: the newer image was prepared as ${PREPARED}`) && / in \d+ s\.$/.test(line))).toBe(true);
  });

  it('then the open takes it: no pull, no build', async () => {
    await seedLabelled();
    expect((await prepare()).result.outcome).toBe('prepared');
    const pulls = h.docker.pulls.length;
    await h.service.openDevspace(ENV_ID, { progress: h.progress });
    expect(h.helper.builds.map((build) => build.imageName)).toEqual([PREPARED]);
    expect(h.docker.pulls).toHaveLength(pulls);
    expect(h.helper.calls).toContain(`up ${IMAGE_2} --remove-existing-container`);
    expect(h.docker.images.has(PREPARED)).toBe(false);
    expect((await h.registry.get(ENV_ID))?.buildRecord).toMatchObject({ devspaceImage: IMAGE_2, images: { [BASE_IMAGE]: DIGEST_NEW } });
    expect(h.docker.labelled.get(IMAGE_2)?.[LABEL_PREPARED]).toBe('');
  });

  it('a second prepare of the same update finds it prepared already', async () => {
    await seedLabelled();
    await prepare();
    const { result } = await prepare();
    expect(result).toMatchObject({ outcome: 'skipped', detail: `the newer image is prepared already (${PREPARED})` });
    expect(h.helper.builds).toHaveLength(1);
  });

  it('replaces an older prepared image (at most one per devspace)', async () => {
    await seedLabelled();
    h.docker.images.add(PREPARED);
    h.docker.imageIds.set(PREPARED, `sha256:${'9'.repeat(64)}`);
    h.docker.imageConfigs.set(PREPARED, { Labels: preparedImageLabels(ENV, { key: { ...KEY, images: { [BASE_IMAGE]: DIGEST_OLD } }, helperImage: h.helper.currentHelperImageId }) });
    const { result } = await prepare();
    expect(result.outcome).toBe('prepared');
    const removed = h.docker.log.indexOf(`rmi ${PREPARED}`);
    expect(removed).toBeGreaterThanOrEqual(0);
    expect(removed).toBeLessThan(h.docker.log.indexOf(`pull ${BASE_IMAGE}`));
    expect(h.helper.builds.map((build) => build.imageName)).toEqual([PREPARED]);
  });

  describe('is skipped, with one line of the log', () => {
    const skipped = async (detail: string | RegExp) => {
      const { result } = await prepare();
      expect(result.outcome).toBe('skipped');
      if (typeof detail === 'string') expect(result.detail).toBe(detail);
      else expect(result.detail).toMatch(detail);
      expect(h.logger.infos.filter((line) => line.includes(': no prepare: '))).toHaveLength(1);
      expect(h.helper.builds).toEqual([]);
      expect(h.docker.images.has(PREPARED)).toBe(false);
      expect(hostUses).toEqual([]);
      return result;
    };

    it('without a workspace volume on the engine', async () => {
      await seedLabelled({ volume: false });
      await skipped('it has no workspace volume on this engine');
    });

    it('while the prepare lock is held (tried at the next pass)', async () => {
      await seedLabelled();
      const { result, events } = await prepare({ busy: true });
      expect(result).toMatchObject({ outcome: 'skipped', detail: 'its prepare lock is held (it is tried again at the next pass)' });
      expect(events).toEqual([`take ${ENV_ID}`]);
      expect(h.helper.builds).toEqual([]);
    });

    it('without a build record on the devspace image', async () => {
      await seedDevspace(h, { record: OLD_RECORD, container: 'running' });
      await skipped(/^its devspace image .* has no build record of it/);
    });

    // Docker Compose is prepared too (devspaceService.composePrepare.test.ts); a record of Docker Compose for a
    // configuration of a single container is another configuration.
    it('for a record of Docker Compose and a configuration of a single container', async () => {
      const env = await seedDevspace(h, { record: { ...OLD_RECORD, compose: { service: 'app', images: [], serviceImages: [], version: '2.30.0', inputsHash: 'x' } }, container: 'running' });
      const config = imageConfigWithUser('vscode');
      h.docker.imageConfigs.set(IMAGE_1, { ...config, Labels: { ...config.Labels, ...imageRecordLabels(env, env.buildRecord as BuildRecord) } });
      await skipped('its configuration changed since its last build (only the approved configuration is prepared)');
    });

    it('for an incomplete record of Docker Compose', async () => {
      const env = await seedDevspace(h, { record: { ...OLD_RECORD, compose: { service: 'app', images: [], serviceImages: [], version: '2.30.0' } as never }, container: 'running' });
      const config = imageConfigWithUser('vscode');
      h.docker.imageConfigs.set(IMAGE_1, { ...config, Labels: { ...config.Labels, ...imageRecordLabels(env, env.buildRecord as BuildRecord) } });
      await skipped('its build record of Docker Compose is incomplete');
    });

    it('for a container created with the host access checks off', async () => {
      await seedLabelled({ containerLabels: { 'nimblescape.devspaces.container-version': '99', [LABEL_HOST_ACCESS]: HOST_ACCESS_UNRESTRICTED } });
      await skipped('the host access checks are off for it (its container was created without them)');
    });

    it('for a configuration other than the approved one (its hash)', async () => {
      await seedLabelled();
      h.helper.files[DEFAULT_CONFIG_PATH] = { configText: `${DEFAULT_CONFIG_TEXT}\n` };
      await skipped('its configuration changed since its last build (only the approved configuration is prepared)');
      // Before any analysis or merged read.
      expect(h.helper.readConfigurations.filter((read) => read.merged !== false)).toEqual([]);
    });

    it('for a configuration that the host access policy refuses (checks on)', async () => {
      await seedLabelled();
      h.helper.config = { ...h.helper.config, privileged: true };
      await skipped(/^the host access policy refuses its configuration \(.*privileged/);
    });

    it('without an update', async () => {
      await seedLabelled({ record: {} });
      await skipped('its images are current (no update)');
    });

    // The Monitor asks every devspace of its engine each run; nothing moved costs no batch helper, no Dev
    // Container CLI and no analysis.
    it('without an update, found on the references of the record before anything is read from the volume', async () => {
      const env = await seedLabelled({ record: {} });
      await skipped('its images are current (no update)');
      const record = env.buildRecord as BuildRecord;
      expect(h.checker.calls).toEqual([{ images: Object.keys(record.images), features: Object.keys(record.features) }]);
      expect(h.helper.calls).toEqual([]);
      expect(h.helper.readConfigurations).toEqual([]);
    });

    it('when the registries cannot be asked', async () => {
      await seedLabelled();
      h.checker.outcome = { status: 'unreachable', registries: ['mcr.microsoft.com'] };
      await skipped('the registries could not be asked');
    });

    it('for the key that the time limit stopped before', async () => {
      await seedLabelled();
      const { result } = await prepare({ stopped: HASH() });
      expect(result).toMatchObject({ outcome: 'skipped', detail: 'a prepare of the same update failed or was stopped by the time limit before (it is tried again when the update changes)' });
      expect(h.helper.builds).toEqual([]);
    });

    it('but not for another stopped key (a new digest)', async () => {
      await seedLabelled();
      h.checker.outcome = checked({ [BASE_IMAGE]: `sha256:${'e'.repeat(64)}` }, { [FEATURE]: FEATURE_DIGEST });
      const { result } = await prepare({ stopped: HASH() });
      expect(result.outcome).toBe('prepared');
    });
  });

  it('is stopped by its time limit: the build ends, the image goes, the key is recorded, and one line says so', async () => {
    await seedLabelled();
    h.helper.onBuild = () => new Promise((resolve) => setTimeout(resolve, 100));
    const { result, events, recorded } = await prepare({ limitMs: 20 });
    expect(result.outcome).toBe('stopped');
    expect(h.docker.log).toContain(`rmi ${PREPARED}`);
    expect(h.docker.images.has(PREPARED)).toBe(false);
    expect(recorded).toEqual([`${ENV_ID} ${HASH()}`]);
    expect(events).toEqual([`take ${ENV_ID}`, `release ${ENV_ID}`]);
    expect(h.logger.warnings).toContain(`${REPO}: the prepare was stopped after 0 minutes; the next open builds it.`);
    expect(hostUses).toEqual([]);
  });

  it('the limit is 30 minutes, and its line names them', () => {
    expect(PREPARE_LIMIT_MS).toBe(30 * 60_000);
  });

  it('a stop request (a Delete) or a cancel ends it without a record; its image goes', async () => {
    await seedLabelled();
    const controller = new AbortController();
    h.helper.onBuild = () => controller.abort();
    const { result, recorded } = await prepare({ signal: controller.signal });
    expect(result).toMatchObject({ outcome: 'cancelled', detail: 'it was asked to stop' });
    expect(recorded).toEqual([]);
    expect(h.docker.images.has(PREPARED)).toBe(false);
  });

  it('removes its image when the devspace was deleted during the build', async () => {
    const env = await seedLabelled();
    h.helper.onBuild = () => void h.docker.volumes.delete(env.volumeName);
    const { result } = await prepare();
    expect(result).toMatchObject({ outcome: 'skipped', detail: 'its workspace volume is gone (the devspace was deleted)' });
    expect(h.docker.images.has(PREPARED)).toBe(false);
    expect(h.docker.labelled.has(PREPARED)).toBe(false);
  });

  it('removes its image when the configuration changed during the build', async () => {
    await seedLabelled();
    h.helper.onBuild = () => void (h.helper.files[DEFAULT_CONFIG_PATH] = { configText: `${DEFAULT_CONFIG_TEXT} ` });
    const { result } = await prepare();
    expect(result).toMatchObject({ outcome: 'skipped', detail: 'its configuration changed during the prepare' });
    expect(h.docker.images.has(PREPARED)).toBe(false);
  });

  it('a failed build fails it with its cause; its image goes', async () => {
    await seedLabelled();
    h.helper.buildError = () => new Error('the build broke');
    const { result } = await prepare();
    expect(result).toMatchObject({ outcome: 'failed', detail: 'the build broke' });
    expect(h.docker.log).toContain(`rmi ${PREPARED}`);
    expect(h.logger.warnings.some((line) => line.startsWith(`${REPO}: the prepare failed after `))).toBe(true);
  });

  it('a failed pull fails it before the build (no build on an older base), and is tried again at the next pass', async () => {
    await seedLabelled();
    h.docker.pullError = () => new Error('pull access denied');
    const { result, recorded } = await prepare();
    expect(result).toMatchObject({ outcome: 'failed', detail: 'pull access denied' });
    expect(h.helper.builds).toEqual([]);
    expect(recorded).toEqual([]);
  });

  // No daily build that fails the same way.
  it('a failed build records its key, so the same update is not built again until the key changes', async () => {
    await seedLabelled();
    h.helper.buildError = () => new Error('the lockfile does not match');
    const { result, recorded } = await prepare();
    expect(result).toMatchObject({ outcome: 'failed', detail: 'the lockfile does not match' });
    expect(recorded).toEqual([`${ENV_ID} ${HASH()}`]);
    h.helper.buildError = () => undefined;
    const again = await prepare({ stopped: HASH() });
    expect(again.result).toMatchObject({ outcome: 'skipped', detail: 'a prepare of the same update failed or was stopped by the time limit before (it is tried again when the update changes)' });
    expect(h.helper.builds).toHaveLength(1);
  });

  it('a host access refusal or a skip records no key', async () => {
    await seedLabelled();
    h.helper.config = { ...h.helper.config, privileged: true };
    expect((await prepare()).recorded).toEqual([]);
  });
});

describe('Delete stops a running prepare first', () => {
  class StoppablePrepareLock implements PrepareLock {
    isHeld = true;
    stopsInTime = true;
    readonly calls: string[] = [];
    async held(devspaceId: string): Promise<boolean> {
      this.calls.push(`held ${devspaceId}`);
      return this.isHeld;
    }
    async waitFree(): Promise<boolean> {
      return true;
    }
    async stop(devspaceId: string, waitSeconds: number, signal: AbortSignal | undefined): Promise<boolean> {
      this.calls.push(`stop ${devspaceId} ${waitSeconds}`);
      if (signal?.aborted) throw abortError();
      return this.stopsInTime;
    }
  }

  for (const stopsInTime of [true, false]) {
    it(`asks it to stop and waits at most ${PREPARE_STOP_WAIT_SECONDS} s, then deletes (${stopsInTime ? 'it stopped' : 'it did not stop in time'})`, async () => {
      h.cleanup();
      const prepareLock = new StoppablePrepareLock();
      prepareLock.stopsInTime = stopsInTime;
      h = createHarness({ prepareLock });
      const env = await seedDevspace(h, { container: 'stopped' });
      await h.service.delete(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] });
      expect(prepareLock.calls).toEqual([`held ${ENV_ID}`, `stop ${ENV_ID} ${PREPARE_STOP_WAIT_SECONDS}`]);
      expect(h.docker.volumes.has(env.volumeName)).toBe(false);
      expect(await h.registry.get(ENV_ID)).toBeUndefined();
      if (stopsInTime) expect(h.logger.infos).toContain(`The prepare of ${REPO} stopped.`);
      else expect(h.logger.warnings).toContain(`The prepare of ${REPO} did not stop within ${PREPARE_STOP_WAIT_SECONDS} s; the Delete goes on.`);
    });
  }

  it('asks nothing when no prepare runs', async () => {
    h.cleanup();
    const prepareLock = new StoppablePrepareLock();
    prepareLock.isHeld = false;
    h = createHarness({ prepareLock });
    await seedDevspace(h, { container: 'stopped' });
    await h.service.delete(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] });
    expect(prepareLock.calls).toEqual([`held ${ENV_ID}`]);
  });
});
