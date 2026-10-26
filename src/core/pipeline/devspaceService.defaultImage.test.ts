// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The default-image devspace of a repository (DevspaceSource `defaultImage`, the setting `defaultImage`): its open
// reads and builds the synthesized configuration `{ "image": … }` in place of the configuration of the repository and
// records the source in the entry and in the build record; it exists next to the devspace of the configuration; it
// keeps its kind; it asks Rebuild now or Later when the default image of the settings changes; and the headless prepare
// builds the synthesized configuration too. The extension side (the settings, the rows, the commands) is in src/vscode.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LABEL_BUILD_RECORD, LABEL_CONFIG_PATH, LABEL_DEFAULT_IMAGE, LABEL_DEVSPACE_ID, LABEL_OWNER_ID, LABEL_REPOSITORY, devspaceImageName, preparedImageName, resourceName } from '../names';
import type { BuildRecord, Devspace, DevspaceSource } from '../types';
import type { RepositoryTarget } from './operationBase';
import {
  ACCOUNT,
  BASE_IMAGE,
  DIGEST_NEW,
  DIGEST_OLD,
  ENV_ID,
  FEATURE,
  FEATURE_DIGEST,
  OTHER_ID,
  REPO,
  checked,
  createHarness,
  headlessPrepareService,
  imageConfigWithUser,
  prepareRun,
  seedDevspace,
  type Harness,
} from './devspaceService.testkit';
import { imageRecordLabels } from './imageRecord';
import { configHash, defaultImageConfiguration } from './pipelineRules';
import { DEFAULT_CONFIG_PATH } from './recordRules';

const IMAGE = 'ghcr.io/majikmate/devcontainer-base:latest';
const OTHER_IMAGE = 'ghcr.io/majikmate/devcontainer-base:2';
const IMAGE_DIGEST = `sha256:${'d'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'e'.repeat(64)}`;
const TARGET: RepositoryTarget = { repository: REPO, defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };
const DEFAULT_IMAGE: DevspaceSource = { kind: 'defaultImage', image: IMAGE };
const CONFIGURATION: DevspaceSource = { kind: 'configuration', configPath: DEFAULT_CONFIG_PATH };
const IMAGE_1 = devspaceImageName(REPO, ENV_ID, 1);
const IMAGE_2 = devspaceImageName(REPO, ENV_ID, 2);
/** The digests of the registry for every reference of these tests (the check asks only for those of the open). */
const DIGESTS: Record<string, string> = { [BASE_IMAGE]: DIGEST_NEW, [IMAGE]: IMAGE_DIGEST, [OTHER_IMAGE]: OTHER_DIGEST, [FEATURE]: FEATURE_DIGEST };
const PREPARED = preparedImageName(REPO, ENV_ID);
/** The synthesized configuration of IMAGE, as the open reads and builds it. */
const SYNTHESIZED = defaultImageConfiguration(IMAGE);

let h: Harness;

beforeEach(() => {
  h = createHarness();
  // The registry answers for the references that the open asks for: those of the configuration, or the default image.
  const answers = (references: readonly string[]) => Object.fromEntries(references.filter((reference) => reference in DIGESTS).map((reference) => [reference, DIGESTS[reference]]));
  h.checker.outcome = (references) => checked(answers(references.images), answers(references.features));
});

afterEach(() => {
  h.cleanup();
});

function options(source?: DevspaceSource) {
  return { progress: h.progress, ...(source !== undefined ? { source } : {}) };
}

/** A devspace that was built from the default image IMAGE (its record and its entry say so), up to date. */
async function seedDefaultImageDevspace(extra: Parameters<typeof seedDevspace>[1] = {}): Promise<Devspace> {
  return seedDevspace(h, {
    record: { configHash: configHash(SYNTHESIZED.text), defaultImage: IMAGE, images: { [IMAGE]: IMAGE_DIGEST }, features: {} },
    extra: { defaultImage: IMAGE },
    ...extra,
  });
}

/** The build record of the devspace image `tag` as its labels carry it (without the pinned ID). */
function labelledRecord(tag: string): Record<string, unknown> {
  return JSON.parse(h.docker.labelled.get(tag)![LABEL_BUILD_RECORD]) as Record<string, unknown>;
}


describe('the default-image devspace of a repository', () => {
  it('the first open of the default-image source creates its devspace: the synthesized configuration is read and built in place of the files of the repository, and the entry records the source', async () => {
    // The repository has no Dev Container configuration at all: the default image needs none.
    h.helper.files = {};
    const result = await h.service.open(TARGET, options(DEFAULT_IMAGE));
    const env = (await h.registry.get(result.devspace.id))!;
    const image = devspaceImageName(REPO, env.id, 1);
    // The kind of the devspace, fixed at its creation, and the names with the word of its source.
    expect(env.defaultImage).toBe(IMAGE);
    expect(env.configPath).toBe(DEFAULT_CONFIG_PATH);
    expect(env.volumeName).toBe(resourceName(REPO, env.id, 'default'));
    expect(env.containerName).toBe(env.volumeName);
    expect(h.docker.volumes.get(env.volumeName)).toMatchObject({ [LABEL_DEFAULT_IMAGE]: IMAGE });
    expect(h.docker.volumes.get(env.volumeName)).not.toHaveProperty(LABEL_CONFIG_PATH);
    expect(env.buildRecord).toMatchObject({
      devspaceImage: image,
      configPath: DEFAULT_CONFIG_PATH,
      configHash: configHash(SYNTHESIZED.text),
      defaultImage: IMAGE,
      images: { [IMAGE]: IMAGE_DIGEST },
      features: {},
    });
    // The CLI reads our configuration (`--override-config`) under the configuration path of the devspace; the files
    // of the repository are not read.
    expect(h.helper.readConfigurations.map((read) => [read.configPath, read.override])).toEqual([
      [DEFAULT_CONFIG_PATH, SYNTHESIZED.config],
      [DEFAULT_CONFIG_PATH, SYNTHESIZED.config],
    ]);
    expect(h.helper.calls.filter((call) => call.startsWith('readConfigFiles') || call.startsWith('listConfigurations'))).toEqual([]);
    // The build takes the synthesized configuration as our copy (`--config`), and the image is pulled before it.
    expect(h.helper.builds).toEqual([{ imageName: image, configPath: DEFAULT_CONFIG_PATH, override: SYNTHESIZED.config }]);
    expect(h.docker.log).toContain(`pull ${IMAGE}`);
    expect(h.helper.ups.map((up) => up.override.image)).toEqual([image]);
    // The image carries the record with the source.
    expect(labelledRecord(image)).toMatchObject({ defaultImage: IMAGE });
    expect(h.ui.prompts).toEqual([]);
    expect(h.ui.warnings).toEqual([]);
    expect(h.logger.infos).toContain(`${REPO} opens with the default image ${IMAGE} in place of its configuration.`);
  });

  it('the configuration devspace and the default-image devspace of one repository exist next to each other, each found by its source', async () => {
    const configuration = (await h.service.open(TARGET, options(CONFIGURATION))).devspace;
    const defaultImage = (await h.service.open(TARGET, options(DEFAULT_IMAGE))).devspace;
    expect(defaultImage.id).not.toBe(configuration.id);
    expect(configuration.volumeName).toBe(resourceName(REPO, configuration.id, 'config'));
    expect(defaultImage.volumeName).toBe(resourceName(REPO, defaultImage.id, 'default'));
    expect(configuration).not.toHaveProperty('defaultImage');
    expect(defaultImage.defaultImage).toBe(IMAGE);
    // One build each, from its own source; the first devspace is not touched by the second open.
    expect(h.helper.builds).toEqual([
      { imageName: devspaceImageName(REPO, configuration.id, 1), configPath: DEFAULT_CONFIG_PATH },
      { imageName: devspaceImageName(REPO, defaultImage.id, 1), configPath: DEFAULT_CONFIG_PATH, override: SYNTHESIZED.config },
    ]);
    expect(h.ui.prompts).toEqual([]);
    // The registry finds each devspace by its source; without a source, the most recently used one.
    expect((await h.registry.findForAccount(REPO, ACCOUNT.id, '', CONFIGURATION))?.id).toBe(configuration.id);
    expect((await h.registry.findForAccount(REPO, ACCOUNT.id, '', DEFAULT_IMAGE))?.id).toBe(defaultImage.id);
    expect((await h.registry.findForAccount(REPO, ACCOUNT.id, '', { kind: 'defaultImage', image: OTHER_IMAGE }))?.id).toBe(defaultImage.id);
    // A third open of either source uses its devspace: no third devspace.
    await h.service.open(TARGET, options(DEFAULT_IMAGE));
    expect((await h.registry.list()).map((entry) => entry.id).sort()).toEqual([configuration.id, defaultImage.id].sort());
  });

  it('keeps the default image of the last open when the open names no source', async () => {
    await seedDefaultImageDevspace({ container: 'stopped' });
    await h.service.openDevspace(ENV_ID, options());
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.readConfigurations.every((read) => read.override?.image === IMAGE)).toBe(true);
    expect(h.helper.calls.filter((call) => call.startsWith('readConfigFiles'))).toEqual([]);
    expect(h.helper.ups.map((up) => up.image)).toEqual([IMAGE_1]);
    expect(h.ui.prompts).toEqual([]);
    expect((await h.registry.get(ENV_ID))?.defaultImage).toBe(IMAGE);
  });

  it('keeps its kind when the open names the configuration: a devspace never switches its source', async () => {
    await seedDefaultImageDevspace({ container: 'stopped' });
    await h.service.openDevspace(ENV_ID, options(CONFIGURATION));
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.readConfigurations.every((read) => read.override?.image === IMAGE)).toBe(true);
    expect(h.helper.calls.filter((call) => call.startsWith('readConfigFiles'))).toEqual([]);
    expect(h.ui.prompts).toEqual([]);
    expect((await h.registry.get(ENV_ID))?.defaultImage).toBe(IMAGE);
  });

  it('registry lost: a volume without the source label (version 0.5.0 or older) keeps the kind of the build record of its newest devspace image', async () => {
    // The volume of a default-image devspace of version 0.5.0: the old name, no source label; its devspace image
    // records the default image it was built from.
    const name = resourceName(REPO, OTHER_ID);
    const tag = devspaceImageName(REPO, OTHER_ID, 1);
    const record: BuildRecord = {
      builtAt: '2026-09-20T10:00:00.000Z',
      devspaceImage: tag,
      imageId: `sha256:image-of-${tag}`,
      buildNumber: 1,
      configPath: DEFAULT_CONFIG_PATH,
      configHash: configHash(SYNTHESIZED.text),
      defaultImage: IMAGE,
      images: { [IMAGE]: IMAGE_DIGEST },
      features: {},
    };
    h.docker.volumes.set(name, { [LABEL_DEVSPACE_ID]: OTHER_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id });
    h.docker.images.add(tag);
    const config = imageConfigWithUser('vscode');
    h.docker.imageConfigs.set(tag, { ...config, Labels: { ...config.Labels, ...imageRecordLabels({ id: OTHER_ID, repository: REPO, owner: ACCOUNT }, record) } });
    expect(await h.service.reconcileFromVolumes()).toBe(1);
    expect(await h.registry.get(OTHER_ID)).toMatchObject({ defaultImage: IMAGE, configPath: DEFAULT_CONFIG_PATH, volumeName: name });
    expect(h.logger.infos).toContain(`The volume ${name} is the default-image devspace of ${REPO}, as its devspace image ${tag} records: it was built from ${IMAGE}.`);
    // The Start of the default row finds it: no second default-image devspace.
    expect((await h.registry.findForAccount(REPO, ACCOUNT.id, '', DEFAULT_IMAGE))?.id).toBe(OTHER_ID);
    expect(await h.registry.findForAccount(REPO, ACCOUNT.id, '', CONFIGURATION)).toBeUndefined();
    // Its open takes the record of the image and builds nothing.
    await h.service.openDevspace(OTHER_ID, options());
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.readConfigurations.every((read) => read.override?.image === IMAGE)).toBe(true);
    expect(h.helper.calls.filter((call) => call.startsWith('readConfigFiles'))).toEqual([]);
    expect(await h.registry.get(OTHER_ID)).toMatchObject({ defaultImage: IMAGE, buildRecord: { defaultImage: IMAGE } });
  });

  it('registry lost: a volume of a configuration devspace without the source label stays a configuration devspace', async () => {
    const name = resourceName(REPO, OTHER_ID);
    const tag = devspaceImageName(REPO, OTHER_ID, 1);
    const record: BuildRecord = {
      builtAt: '2026-09-20T10:00:00.000Z',
      devspaceImage: tag,
      imageId: `sha256:image-of-${tag}`,
      buildNumber: 1,
      configPath: DEFAULT_CONFIG_PATH,
      configHash: 'sha256:config',
      images: { [BASE_IMAGE]: DIGEST_NEW },
      features: {},
    };
    h.docker.volumes.set(name, { [LABEL_DEVSPACE_ID]: OTHER_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id });
    h.docker.images.add(tag);
    h.docker.imageConfigs.set(tag, { ...imageConfigWithUser('vscode'), Labels: imageRecordLabels({ id: OTHER_ID, repository: REPO, owner: ACCOUNT }, record) });
    expect(await h.service.reconcileFromVolumes()).toBe(1);
    expect(await h.registry.get(OTHER_ID)).not.toHaveProperty('defaultImage');
    expect((await h.registry.findForAccount(REPO, ACCOUNT.id, '', CONFIGURATION))?.id).toBe(OTHER_ID);
  });

  it('registry lost: a volume of an alternative configuration without the source label (version 0.5.0) takes the configuration of its newest devspace image', async () => {
    const python = '.devcontainer/python/devcontainer.json';
    const name = resourceName(REPO, OTHER_ID);
    const tag = devspaceImageName(REPO, OTHER_ID, 2);
    const record: BuildRecord = {
      builtAt: '2026-09-20T10:00:00.000Z',
      devspaceImage: tag,
      imageId: `sha256:image-of-${tag}`,
      buildNumber: 2,
      configPath: python,
      configHash: 'sha256:config',
      images: { [BASE_IMAGE]: DIGEST_NEW },
      features: {},
    };
    h.docker.volumes.set(name, { [LABEL_DEVSPACE_ID]: OTHER_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id });
    h.docker.images.add(tag);
    h.docker.imageConfigs.set(tag, { ...imageConfigWithUser('vscode'), Labels: imageRecordLabels({ id: OTHER_ID, repository: REPO, owner: ACCOUNT }, record) });
    expect(await h.service.reconcileFromVolumes()).toBe(1);
    expect(await h.registry.get(OTHER_ID)).toMatchObject({ configPath: python, volumeName: name });
    expect(await h.registry.get(OTHER_ID)).not.toHaveProperty('defaultImage');
    expect(h.logger.infos).toContain(`The volume ${name} is the devspace of the configuration ${python} of ${REPO}, as its devspace image ${tag} records.`);
    // The row of the configuration `python` finds it; the root configuration has no devspace.
    expect((await h.registry.findForAccount(REPO, ACCOUNT.id, '', { kind: 'configuration', configPath: python }))?.id).toBe(OTHER_ID);
    expect(await h.registry.findForAccount(REPO, ACCOUNT.id, '', CONFIGURATION)).toBeUndefined();
  });

  it('registry lost: a default-image devspace of a repository without a root configuration takes the configuration path of its newest devspace image (its synthesized configuration is read under it)', async () => {
    const python = '.devcontainer/python/devcontainer.json';
    const name = resourceName(REPO, OTHER_ID, 'default');
    const tag = devspaceImageName(REPO, OTHER_ID, 1);
    const record: BuildRecord = {
      builtAt: '2026-09-20T10:00:00.000Z',
      devspaceImage: tag,
      imageId: `sha256:image-of-${tag}`,
      buildNumber: 1,
      configPath: python,
      configHash: configHash(SYNTHESIZED.text),
      defaultImage: IMAGE,
      images: { [IMAGE]: IMAGE_DIGEST },
      features: {},
    };
    h.docker.volumes.set(name, { [LABEL_DEVSPACE_ID]: OTHER_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id, [LABEL_DEFAULT_IMAGE]: IMAGE });
    h.docker.images.add(tag);
    const config = imageConfigWithUser('vscode');
    h.docker.imageConfigs.set(tag, { ...config, Labels: { ...config.Labels, ...imageRecordLabels({ id: OTHER_ID, repository: REPO, owner: ACCOUNT }, record) } });
    expect(await h.service.reconcileFromVolumes()).toBe(1);
    expect(await h.registry.get(OTHER_ID)).toMatchObject({ defaultImage: IMAGE, configPath: python, volumeName: name });
    expect((await h.registry.findForAccount(REPO, ACCOUNT.id, '', DEFAULT_IMAGE))?.id).toBe(OTHER_ID);
  });

  it('asks Rebuild now or Later when the default image of the settings changed; Later keeps the container and records the new image', async () => {
    await seedDefaultImageDevspace({ container: 'stopped' });
    h.ui.configurationChangedAnswer = 'later';
    // The extension names the image of the settings now (sourceOf).
    await h.service.openDevspace(ENV_ID, options({ kind: 'defaultImage', image: OTHER_IMAGE }));
    expect(h.ui.prompts).toEqual([`configurationChanged ${REPO} defaultImage`]);
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.ups.map((up) => up.image)).toEqual([IMAGE_1]);
    const env = (await h.registry.get(ENV_ID))!;
    expect(env.defaultImage).toBe(OTHER_IMAGE);
    expect(env.buildRecord?.defaultImage).toBe(IMAGE);
    expect(h.logger.infos).toContain(`The default image of ${REPO} changed since the last build: ${IMAGE} → ${OTHER_IMAGE}.`);
  });

  it('Rebuild now builds from the changed default image', async () => {
    await seedDefaultImageDevspace({ container: 'stopped' });
    h.ui.configurationChangedAnswer = 'rebuildNow';
    await h.service.openDevspace(ENV_ID, options({ kind: 'defaultImage', image: OTHER_IMAGE }));
    expect(h.ui.prompts).toEqual([`configurationChanged ${REPO} defaultImage`]);
    expect(h.helper.builds).toEqual([{ imageName: IMAGE_2, configPath: DEFAULT_CONFIG_PATH, override: defaultImageConfiguration(OTHER_IMAGE).config }]);
    expect((await h.registry.get(ENV_ID))?.buildRecord).toMatchObject({ devspaceImage: IMAGE_2, defaultImage: OTHER_IMAGE, images: { [OTHER_IMAGE]: OTHER_DIGEST } });
  });

  it('a cleared setting: the devspace keeps starting from the image it was built from, without a question', async () => {
    await seedDefaultImageDevspace({ container: 'stopped' });
    // The extension names the recorded image when the setting is empty (sourceOf).
    await h.service.openDevspace(ENV_ID, options(DEFAULT_IMAGE));
    expect(h.ui.prompts).toEqual([]);
    expect(h.helper.builds).toEqual([]);
    expect((await h.registry.get(ENV_ID))?.defaultImage).toBe(IMAGE);
  });
});

describe('the headless prepare of a devspace of the default image', () => {
  it('builds the synthesized configuration as our copy (no frozen lockfile), reads no files, and the open takes the image', async () => {
    const env = await seedDefaultImageDevspace({ record: { configHash: configHash(SYNTHESIZED.text), defaultImage: IMAGE, images: { [IMAGE]: DIGEST_OLD }, features: {} }, container: 'running' });
    const record = env.buildRecord!;
    const config = imageConfigWithUser('vscode');
    h.docker.imageConfigs.set(record.devspaceImage, { ...config, Labels: { ...config.Labels, ...imageRecordLabels(env, record) } });
    const { run } = prepareRun();
    const headless = headlessPrepareService(h);
    const result = await headless.service.prepare(ENV_ID, run);
    expect(result).toMatchObject({ outcome: 'prepared' });
    expect(headless.hostUses).toEqual([]);
    expect(h.helper.builds).toEqual([{ imageName: PREPARED, configPath: DEFAULT_CONFIG_PATH, override: SYNTHESIZED.config }]);
    expect(h.helper.calls.filter((call) => call.startsWith('readConfigFiles') || call.startsWith('listConfigurations'))).toEqual([]);
    expect(h.helper.readConfigurations.every((read) => read.override?.image === IMAGE)).toBe(true);
    expect(h.docker.log).toContain(`pull ${IMAGE}`);
    // Then the open takes the prepared image: no build of its own.
    await h.service.openDevspace(ENV_ID, options());
    expect(h.helper.builds.map((build) => build.imageName)).toEqual([PREPARED]);
    expect((await h.registry.get(ENV_ID))?.buildRecord).toMatchObject({ devspaceImage: IMAGE_2, defaultImage: IMAGE, images: { [IMAGE]: IMAGE_DIGEST } });
  });
});
