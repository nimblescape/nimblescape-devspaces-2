// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The sources of a repository (DevspaceSource): their words and keys, the source of an existing devspace, and the
// possible sources of a repository in the order of the rows of the sidebar.
import { describe, expect, it } from 'vitest';
import { MAX_SOURCE_SEGMENT_LENGTH, defaultImageOf, hasConfiguration, isSourceOf, possibleSources, sameSource, sourceKey, sourceLabel, sourceOf, sourceOperationKey, sourceSegment } from './devspaceSource';
import type { DevspaceSource } from './types';

const IMAGE = 'ghcr.io/acme/base:latest';
const OTHER_IMAGE = 'ghcr.io/acme/base:2';
const ROOT = '.devcontainer/devcontainer.json';
const ROOT_FILE = '.devcontainer.json';
const PYTHON = '.devcontainer/python/devcontainer.json';
const DEFAULT_IMAGE: DevspaceSource = { kind: 'defaultImage', image: IMAGE };
const configuration = (configPath: string): DevspaceSource => ({ kind: 'configuration', configPath });

describe('the word and the key of a source', () => {
  it('names the default image default, the configuration at the root config, and an alternative configuration by its folder', () => {
    expect(sourceLabel(DEFAULT_IMAGE)).toBe('default');
    expect(sourceLabel(configuration(ROOT))).toBe('config');
    expect(sourceLabel(configuration(ROOT_FILE))).toBe('config');
    expect(sourceLabel(configuration(PYTHON))).toBe('python');
    expect(sourceLabel(configuration('.devcontainer/Data Science/devcontainer.json'))).toBe('Data Science');
  });

  it('keys the root configuration config under both file names, and an alternative configuration config:<folder>', () => {
    expect(sourceKey(DEFAULT_IMAGE)).toBe('default');
    expect(sourceKey(configuration(ROOT))).toBe('config');
    expect(sourceKey(configuration(ROOT_FILE))).toBe('config');
    expect(sourceKey(configuration(PYTHON))).toBe('config:python');
  });

  it('a folder named default or config is its own source, never the root configuration or the default image', () => {
    const defaultFolder = configuration('.devcontainer/default/devcontainer.json');
    const configFolder = configuration('.devcontainer/config/devcontainer.json');
    expect(sourceKey(defaultFolder)).toBe('config:default');
    expect(sourceKey(configFolder)).toBe('config:config');
    expect(sameSource(defaultFolder, configuration(ROOT))).toBe(false);
    expect(sameSource(defaultFolder, DEFAULT_IMAGE)).toBe(false);
    expect(sameSource(configFolder, configuration(ROOT))).toBe(false);
    // Their words repeat the words of the other sources; the keys tell them apart.
    expect(sourceLabel(defaultFolder)).toBe('default');
    expect(sourceLabel(configFolder)).toBe('config');
  });

  it('the same source: the same kind and key; the image of the default image does not count', () => {
    expect(sameSource(DEFAULT_IMAGE, { kind: 'defaultImage', image: OTHER_IMAGE })).toBe(true);
    expect(sameSource(configuration(ROOT), configuration(ROOT_FILE))).toBe(true);
    expect(sameSource(configuration(ROOT), configuration(PYTHON))).toBe(false);
    expect(sameSource(configuration(ROOT), DEFAULT_IMAGE)).toBe(false);
  });

  it('the segment of the Docker names: the word in lower case, runs of other characters as one -, at most 24 characters', () => {
    expect(sourceSegment(DEFAULT_IMAGE)).toBe('default');
    expect(sourceSegment(configuration(ROOT))).toBe('config');
    expect(sourceSegment(configuration(PYTHON))).toBe('python');
    expect(sourceSegment(configuration('.devcontainer/Data Science__2/devcontainer.json'))).toBe('data-science-2');
    expect(sourceSegment(configuration('.devcontainer/___/devcontainer.json'))).toBe('x');
    const long = sourceSegment(configuration(`.devcontainer/${'a'.repeat(30)}-b/devcontainer.json`));
    expect(long).toBe('a'.repeat(MAX_SOURCE_SEGMENT_LENGTH));
    // A cut never ends in a -.
    expect(sourceSegment(configuration(`.devcontainer/${'a'.repeat(23)}-b/devcontainer.json`))).toBe('a'.repeat(23));
  });

  it('the key of the operations of a devspace: the repository in lower case and the key of its source', () => {
    expect(sourceOperationKey('Acme/API', DEFAULT_IMAGE)).toBe('acme/api#default');
    expect(sourceOperationKey('acme/api', configuration(ROOT_FILE))).toBe('acme/api#config');
    expect(sourceOperationKey('acme/api', configuration(PYTHON))).toBe('acme/api#config:python');
  });
});

describe('the source of an existing devspace', () => {
  it('is the default image of its entry, with the image of the settings now when they name one', () => {
    expect(sourceOf({ configPath: ROOT, defaultImage: IMAGE })).toEqual(DEFAULT_IMAGE);
    expect(sourceOf({ configPath: ROOT, defaultImage: IMAGE }, { defaultImage: OTHER_IMAGE })).toEqual({ kind: 'defaultImage', image: OTHER_IMAGE });
    // A cleared setting: the recorded image.
    expect(sourceOf({ configPath: ROOT, defaultImage: IMAGE }, { defaultImage: '' })).toEqual(DEFAULT_IMAGE);
    expect(sourceOf({ configPath: ROOT, defaultImage: IMAGE }, {})).toEqual(DEFAULT_IMAGE);
  });

  it('is the configuration of its entry otherwise, whatever the settings name', () => {
    expect(sourceOf({ configPath: PYTHON })).toEqual(configuration(PYTHON));
    expect(sourceOf({ configPath: PYTHON }, { defaultImage: IMAGE })).toEqual(configuration(PYTHON));
  });

  it('isSourceOf: the default-image devspace for the default image of any image, the devspace of the configuration with the same key', () => {
    expect(isSourceOf({ configPath: ROOT, defaultImage: IMAGE }, { kind: 'defaultImage', image: OTHER_IMAGE })).toBe(true);
    expect(isSourceOf({ configPath: ROOT, defaultImage: IMAGE }, configuration(ROOT))).toBe(false);
    expect(isSourceOf({ configPath: ROOT }, DEFAULT_IMAGE)).toBe(false);
    expect(isSourceOf({ configPath: ROOT }, configuration(ROOT_FILE))).toBe(true);
    expect(isSourceOf({ configPath: ROOT_FILE }, configuration(ROOT))).toBe(true);
    expect(isSourceOf({ configPath: PYTHON }, configuration(ROOT))).toBe(false);
    expect(isSourceOf({ configPath: '.devcontainer/default/devcontainer.json' }, configuration(ROOT))).toBe(false);
  });

  it('defaultImageOf and hasConfiguration', () => {
    expect(defaultImageOf({ defaultImage: IMAGE })).toBe(IMAGE);
    expect(defaultImageOf({ defaultImage: '' })).toBeUndefined();
    expect(defaultImageOf({})).toBeUndefined();
    expect(hasConfiguration(undefined)).toBe(true);
    expect(hasConfiguration({ configPaths: [] })).toBe(false);
    expect(hasConfiguration({ configPaths: [ROOT] })).toBe(true);
  });
});

describe('the possible sources of a repository', () => {
  const withImage = { defaultImage: IMAGE };
  const withoutImage = {};

  it('lists the configurations of the discovery and of the devspaces once by key, the root first, then by folder name', () => {
    const sources = possibleSources({
      info: { configPaths: [PYTHON, ROOT_FILE] },
      devspaces: [{ configPath: ROOT }, { configPath: '.devcontainer/go/devcontainer.json' }, { configPath: PYTHON }],
      settings: withoutImage,
    });
    // The root configuration under the file name of the discovery (the first one seen).
    expect(sources).toEqual([configuration(ROOT_FILE), configuration('.devcontainer/go/devcontainer.json'), configuration(PYTHON)]);
  });

  it('adds the default image of the settings first, or last while startWithDefaultImage is off', () => {
    const input = { info: { configPaths: [ROOT] }, devspaces: [] };
    expect(possibleSources({ ...input, settings: withImage })).toEqual([DEFAULT_IMAGE, configuration(ROOT)]);
    expect(possibleSources({ ...input, settings: { ...withImage, startWithDefaultImage: true } })).toEqual([DEFAULT_IMAGE, configuration(ROOT)]);
    expect(possibleSources({ ...input, settings: { ...withImage, startWithDefaultImage: false } })).toEqual([configuration(ROOT), DEFAULT_IMAGE]);
    expect(possibleSources({ ...input, settings: withoutImage })).toEqual([configuration(ROOT)]);
  });

  it('a repository without a configuration has the default image as its only source, and none without one', () => {
    expect(possibleSources({ info: { configPaths: [] }, devspaces: [], settings: withImage })).toEqual([DEFAULT_IMAGE]);
    expect(possibleSources({ info: { configPaths: [] }, devspaces: [], settings: withoutImage })).toEqual([]);
  });

  it('keeps the default image of a default-image devspace after the setting was cleared, with the image it records', () => {
    const devspaces = [{ configPath: ROOT, defaultImage: IMAGE }];
    expect(possibleSources({ info: { configPaths: [ROOT] }, devspaces, settings: withoutImage })).toEqual([DEFAULT_IMAGE, configuration(ROOT)]);
    // The image of the settings now when they name one.
    expect(possibleSources({ info: { configPaths: [ROOT] }, devspaces, settings: { defaultImage: OTHER_IMAGE } })).toEqual([{ kind: 'defaultImage', image: OTHER_IMAGE }, configuration(ROOT)]);
  });

  it('a repository that GitHub does not list has the default image only with a default-image devspace', () => {
    expect(possibleSources({ info: undefined, devspaces: [{ configPath: ROOT }], settings: withImage })).toEqual([configuration(ROOT)]);
    expect(possibleSources({ info: undefined, devspaces: [{ configPath: ROOT, defaultImage: OTHER_IMAGE }, { configPath: ROOT }], settings: withImage })).toEqual([DEFAULT_IMAGE, configuration(ROOT)]);
    expect(possibleSources({ info: undefined, devspaces: [{ configPath: ROOT, defaultImage: OTHER_IMAGE }], settings: withoutImage })).toEqual([{ kind: 'defaultImage', image: OTHER_IMAGE }]);
  });
});
