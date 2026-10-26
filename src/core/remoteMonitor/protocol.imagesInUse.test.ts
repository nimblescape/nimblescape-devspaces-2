// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The image references in use: their grammar, the input of `monitor.js images -` (the shape of an older extension and
// the current one), the stored file per computer, and the references of the build records.
import { describe, expect, it } from 'vitest';
import {
  IMAGES_IN_USE_MAX_AGE_MS,
  MAX_IMAGE_LIST_LENGTH,
  MAX_IMAGE_DIGESTS,
  MAX_IMAGE_REFERENCES,
  imageReferencesInUse,
  imagesInUseFileName,
  isListedRepository,
  parseImageReference,
  parseImagesInUseFileName,
  parseImagesInUseRecord,
  parseImagesInput,
  parseReferenceDigests,
} from './protocol';

const SOURCE = '0123456789abcdef0123456789abcdef';
const DIGEST = `sha256:${'a'.repeat(64)}`;

describe('the image references in use', () => {
  it('counts the references of a computer for 30 days', () => {
    expect(IMAGES_IN_USE_MAX_AGE_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(MAX_IMAGE_REFERENCES).toBe(200);
  });

  it('reads a reference by the Docker reference grammar, with the repository as the engine lists it', () => {
    expect(parseImageReference('ghcr.io/majikmate/devcontainer-classroom-web:latest')).toEqual({ repository: 'ghcr.io/majikmate/devcontainer-classroom-web', tag: 'latest' });
    expect(parseImageReference('mcr.microsoft.com/devcontainers/base:ubuntu')).toEqual({ repository: 'mcr.microsoft.com/devcontainers/base', tag: 'ubuntu' });
    // Docker Hub without its registry, its official images without `library/`.
    expect(parseImageReference('node:20')).toEqual({ repository: 'node', tag: '20' });
    expect(parseImageReference('node')).toEqual({ repository: 'node' });
    expect(parseImageReference('docker.io/library/node:20')).toEqual({ repository: 'node', tag: '20' });
    expect(parseImageReference('index.docker.io/acme/tool:1')).toEqual({ repository: 'acme/tool', tag: '1' });
    expect(parseImageReference('acme/tool:1.2.3')).toEqual({ repository: 'acme/tool', tag: '1.2.3' });
    expect(parseImageReference('acme/library/tool')).toEqual({ repository: 'acme/library/tool' });
    // A registry with a port, localhost, a digest, a tag and a digest.
    expect(parseImageReference('localhost:5000/team/app:1')).toEqual({ repository: 'localhost:5000/team/app', tag: '1' });
    expect(parseImageReference('localhost/app')).toEqual({ repository: 'localhost/app' });
    expect(parseImageReference(`ghcr.io/acme/base@${DIGEST}`)).toEqual({ repository: 'ghcr.io/acme/base', digest: DIGEST });
    expect(parseImageReference(`node:20@${DIGEST}`)).toEqual({ repository: 'node', tag: '20', digest: DIGEST });
    expect(parseImageReference('my_org/my__tool:x_y')).toEqual({ repository: 'my_org/my__tool', tag: 'x_y' });
    // Invalid: upper case in the path, a bad tag or digest, spaces, options, too long.
    for (const invalid of [
      'Node:20',
      'node:',
      'node:-1',
      `node@sha256:${'a'.repeat(63)}`,
      'node@md5:abc',
      'node 20',
      '--help',
      '-node',
      'node/',
      '/node',
      'node..x',
      'ghcr.io//a',
      'https://ghcr.io/a:1',
      `node:${'a'.repeat(129)}`,
      `${'a'.repeat(256)}`,
      `ghcr.io/${'a/'.repeat(200)}b`,
      '',
      3,
      undefined,
    ]) {
      expect(parseImageReference(invalid), String(invalid)).toBeUndefined();
    }
    expect(parseImageReference(`${'a'.repeat(255)}`)).toEqual({ repository: 'a'.repeat(255) });
    // The longest that the grammar allows fits (a name of 255, a tag of 128, a digest).
    const longest = `${'a'.repeat(255)}:${'t'.repeat(128)}@${DIGEST}`;
    expect(longest.length).toBe(456);
    expect(parseImageReference(longest)).toEqual({ repository: 'a'.repeat(255), tag: 't'.repeat(128), digest: DIGEST });
    expect(parseImageReference(`${longest}${'x'.repeat(100)}`)).toBeUndefined();
  });

  it('knows a repository as the engine lists it', () => {
    expect(isListedRepository('node')).toBe(true);
    expect(isListedRepository('ghcr.io/acme/base')).toBe(true);
    expect(isListedRepository('library/node')).toBe(false);
    expect(isListedRepository('docker.io/acme/tool')).toBe(false);
    expect(isListedRepository('node:20')).toBe(false);
    expect(isListedRepository(`node@${DIGEST}`)).toBe(false);
  });

  // The list of repositories that an older extension may send is taken and ignored (its entries are not checked).
  it('reads the input of `images -`: the old shape, and the references of a computer with or without the list', () => {
    expect(parseImagesInput(JSON.stringify({ repositories: ['ghcr.io/a/b', 'ghcr.io/a/b'] }))).toEqual({});
    expect(parseImagesInput(JSON.stringify({ source: SOURCE, references: ['node:20', 'node:20', `ghcr.io/a/b@${DIGEST}`] }))).toEqual({ inUse: { source: SOURCE, references: ['node:20', `ghcr.io/a/b@${DIGEST}`] } });
    expect(parseImagesInput(JSON.stringify({ source: SOURCE, references: [], repositories: ['ghcr.io/a/b'] }))).toEqual({ inUse: { source: SOURCE, references: [] } });
    expect(parseImagesInput(JSON.stringify({ source: SOURCE, references: [], repositories: ['node', 'Not Valid'] }))).toEqual({ inUse: { source: SOURCE, references: [] } });
    for (const invalid of [
      {},
      { references: ['node:20'] },
      { source: SOURCE },
      { source: 'ABC', references: [] },
      { source: SOURCE, references: ['Node:20'] },
      { source: SOURCE, references: 'node:20' },
      { source: SOURCE, references: [], repositories: 'ghcr.io/a/b' },
      { repositories: null },
      { source: SOURCE, references: [], extra: 1 },
      { repositories: ['ghcr.io/a/b'], references: [] },
      { source: SOURCE, references: Array.from({ length: MAX_IMAGE_REFERENCES + 1 }, (_, index) => `node:${index}`) },
    ]) {
      expect(parseImagesInput(JSON.stringify(invalid)), JSON.stringify(invalid).slice(0, 80)).toBeUndefined();
    }
    expect(parseImagesInput('not json')).toBeUndefined();
    expect(parseImagesInput(' '.repeat(MAX_IMAGE_LIST_LENGTH + 1))).toBeUndefined();
  });

  // The digests that the opens recorded for the references, optional and strict.
  it('reads the recorded digests of the references in the input and in the stored file', () => {
    const digests = { 'node:20': [DIGEST] };
    expect(parseImagesInput(JSON.stringify({ source: SOURCE, references: ['node:20', 'redis'], digests }))).toEqual({ inUse: { source: SOURCE, references: ['node:20', 'redis'], digests } });
    for (const invalid of [
      { 'node:18': [DIGEST] },
      { 'node:20': [] },
      { 'node:20': ['sha256:abc'] },
      { 'node:20': [DIGEST, DIGEST] },
      { 'node:20': Array.from({ length: MAX_IMAGE_DIGESTS + 1 }, (_, index) => `sha256:${String(index).padStart(64, '0')}`) },
      ['node:20'],
    ]) {
      expect(parseImagesInput(JSON.stringify({ source: SOURCE, references: ['node:20'], digests: invalid })), JSON.stringify(invalid).slice(0, 60)).toBeUndefined();
    }
    expect(parseImagesInUseRecord(JSON.stringify({ at: 1, references: ['node:20'], digests }))).toEqual({ at: 1, references: ['node:20'], digests });
    expect(parseImagesInUseRecord(JSON.stringify({ at: 1, references: ['node:20'], digests: { 'node:18': [DIGEST] } }))).toBeUndefined();
    expect(parseReferenceDigests({}, [])).toEqual({});
  });

  // An older extension may still send its full list beside the references; that input still fits.
  it('a full input of both lists fits', () => {
    const repositories = Array.from({ length: 500 }, (_, index) => `ghcr.io/${'a'.repeat(240)}/r${String(index).padStart(3, '0')}`);
    const references = Array.from({ length: MAX_IMAGE_REFERENCES }, (_, index) => `${'b'.repeat(252)}${String(index).padStart(3, '0')}:${'t'.repeat(128)}@${DIGEST}`);
    // With MAX_IMAGE_DIGESTS recorded digests of each reference.
    const digests = Object.fromEntries(references.map((reference) => [reference, Array.from({ length: MAX_IMAGE_DIGESTS }, (_, index) => `sha256:${String(index).padStart(64, '0')}`)]));
    const text = JSON.stringify({ source: SOURCE, references, repositories, digests });
    expect(text.length).toBeLessThanOrEqual(MAX_IMAGE_LIST_LENGTH);
    expect(parseImagesInput(text)?.inUse?.references).toHaveLength(MAX_IMAGE_REFERENCES);
  });

  it('names the file of a computer, and reads it strictly', () => {
    expect(imagesInUseFileName(SOURCE)).toBe(`images-in-use.${SOURCE}.json`);
    expect(() => imagesInUseFileName('../x')).toThrow();
    expect(parseImagesInUseFileName(`images-in-use.${SOURCE}.json`)).toBe(SOURCE);
    expect(parseImagesInUseFileName(`images-in-use.${SOURCE}.json.1.2.tmp`)).toBeUndefined();
    expect(parseImagesInUseFileName('images.json')).toBeUndefined();
    expect(parseImagesInUseRecord(JSON.stringify({ at: 5, references: ['node:20'] }))).toEqual({ at: 5, references: ['node:20'] });
    for (const invalid of [{ at: -1, references: [] }, { at: 1.5, references: [] }, { at: 1 }, { at: 1, references: ['Node'] }, { at: 1, references: [], more: 1 }]) {
      expect(parseImagesInUseRecord(JSON.stringify(invalid))).toBeUndefined();
    }
    expect(parseImagesInUseRecord('{')).toBeUndefined();
  });

  it('takes the references of the build records: the images, the service images of Compose, valid ones, each once, sorted', () => {
    const OLDER = `sha256:${'e'.repeat(64)}`;
    expect(
      imageReferencesInUse([
        { buildRecord: { builtAt: '2026-10-01T00:00:00.000Z', images: { 'node:20': OLDER, 'mcr.microsoft.com/devcontainers/base:ubuntu': DIGEST } } },
        { buildRecord: { builtAt: '2026-10-10T00:00:00.000Z', images: { 'node:20': DIGEST, '${localEnv:IMAGE}': DIGEST, 'postgres:16': 'not a digest' }, compose: { serviceImages: ['postgres:16', 'redis'] } } },
        {},
      ]),
    ).toEqual({
      references: ['mcr.microsoft.com/devcontainers/base:ubuntu', 'node:20', 'postgres:16', 'redis'],
      // The recorded digests, valid ones, the newest build first.
      digests: { 'mcr.microsoft.com/devcontainers/base:ubuntu': [DIGEST], 'node:20': [DIGEST, OLDER] },
    });
    const many = Array.from({ length: MAX_IMAGE_DIGESTS + 2 }, (_, index) => ({ buildRecord: { images: { 'node:20': `sha256:${String(index).padStart(64, '0')}` } } }));
    expect(imageReferencesInUse(many).digests['node:20']).toHaveLength(MAX_IMAGE_DIGESTS);
  });
});
