// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The open gives the Monitor the image references in use of its computer (`monitor.js images -` with `source`
// and `references`), without a list of repositories.
import { describe, expect, it } from 'vitest';
import { parseDevspaceSource, parseOpenParams } from '../core/helperChannel/protocol';
import { MAX_IMAGE_REFERENCES, parseImagesInput } from '../core/remoteMonitor/protocol';
import { silentLogger, type Logger } from '../core/ports';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import type { DockerEngine } from '../core/worker/dockerEngine';
import { giveMonitorImages } from './flowOperations';

const SOURCE = '0123456789abcdef0123456789abcdef';
// No prefixes and no image list.
const IMAGES = { schedule: '7 6 * * *', timeZone: 'UTC' };

function engineOf(exitCode = 0) {
  const inputs: string[] = [];
  const engine: DockerEngine = {
    ...unusedEngine(),
    exec: async (_container, _command, options) => (inputs.push(options?.input ?? ''), { exitCode, stdout: '', stderr: exitCode === 0 ? '' : 'Invalid image list.', timedOut: false }),
  };
  return { engine, inputs };
}

describe('the image references in use of an open, to the Monitor', () => {
  // The references go without a list.
  it('sends the references of the computer after the settings', async () => {
    const both = engineOf();
    await giveMonitorImages(both.engine, { images: IMAGES, references: ['node:20'], monitorSource: SOURCE }, silentLogger, new AbortController().signal);
    expect(both.inputs).toEqual([JSON.stringify(IMAGES), JSON.stringify({ source: SOURCE, references: ['node:20'] })]);
    // The monitor takes what the worker sends.
    expect(parseImagesInput(both.inputs[1])).toEqual({ inUse: { source: SOURCE, references: ['node:20'] } });
    const only = engineOf();
    await giveMonitorImages(only.engine, { images: IMAGES, references: [], monitorSource: SOURCE }, silentLogger, new AbortController().signal);
    expect(only.inputs).toEqual([JSON.stringify(IMAGES), JSON.stringify({ source: SOURCE, references: [] })]);
  });

  // With the digests that the opens recorded for the references.
  it('sends the recorded digests of the references with them', async () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const { engine, inputs } = engineOf();
    await giveMonitorImages(engine, { images: IMAGES, references: ['node:20'], referenceDigests: { 'node:20': [digest] }, monitorSource: SOURCE }, silentLogger, new AbortController().signal);
    expect(inputs[1]).toBe(JSON.stringify({ source: SOURCE, references: ['node:20'], digests: { 'node:20': [digest] } }));
    expect(parseImagesInput(inputs[1])?.inUse?.digests).toEqual({ 'node:20': [digest] });
  });

  // Only the settings go without references or without a valid computer.
  it('sends only the settings without references or without a valid computer', async () => {
    for (const params of [{}, { references: ['node:20'], monitorSource: 'not-a-source' }]) {
      const { engine, inputs } = engineOf();
      await giveMonitorImages(engine, { images: IMAGES, ...params }, silentLogger, new AbortController().signal);
      expect(inputs).toEqual([JSON.stringify(IMAGES)]);
    }
  });

  // An older monitor refuses the shape of the references: the refusal is logged, and nothing goes again (the next open
  // sends the references again).
  it('logs the references that an older monitor refuses, and sends nothing again', async () => {
    const warnings: string[] = [];
    const logger: Logger = { ...silentLogger, warn: (message) => void warnings.push(message) };
    const { engine, inputs } = engineOf(2);
    await giveMonitorImages(engine, { images: IMAGES, references: ['node:20'], monitorSource: SOURCE }, logger, new AbortController().signal);
    expect(inputs).toEqual([JSON.stringify(IMAGES), JSON.stringify({ source: SOURCE, references: ['node:20'] })]);
    expect(warnings).toEqual(['The image settings could not be given to the Monitor: Invalid image list.', 'The image references in use could not be given to the Monitor: Invalid image list.']);
  });

  it('the parameters of the open take valid references only, at most MAX_IMAGE_REFERENCES', () => {
    const base = {
      dockerHost: '',
      owner: { windowId: 'window-1', pid: 4242 },
      monitorSource: SOURCE,
      settings: { updateImagesOnConnect: true, hostAccessChecks: 'off', stopOnClose: false, respectShutdownActionNone: true },
      images: IMAGES,
      repository: 'acme/api',
      devspaceId: '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d',
    };
    // The source of the open (DevspaceSource), strictly.
    const configuration = { kind: 'configuration', configPath: '.devcontainer/python/devcontainer.json' };
    expect(parseOpenParams({ ...base, source: configuration })?.source).toEqual(configuration);
    for (const configPath of ['.devcontainer.json', '.devcontainer/devcontainer.json']) {
      expect(parseDevspaceSource({ kind: 'configuration', configPath })).toEqual({ kind: 'configuration', configPath });
    }
    expect(parseOpenParams({ ...base, source: { kind: 'defaultImage', image: 'ghcr.io/acme/base:latest' } })?.source).toEqual({ kind: 'defaultImage', image: 'ghcr.io/acme/base:latest' });
    expect(parseOpenParams(base)).not.toHaveProperty('source');
    for (const odd of [
      { kind: 'defaultImage' },
      { kind: 'defaultImage', image: 'not an image' },
      { kind: 'configuration' },
      { kind: 'configuration', configPath: '' },
      { kind: 'configuration', configPath: 'a\nb' },
      // Only a configuration path of a repository (isConfigPathLabelValue).
      { kind: 'configuration', configPath: 'devcontainer.json' },
      { kind: 'configuration', configPath: '../x/devcontainer.json' },
      { kind: 'configuration', configPath: '.devcontainer/../devcontainer.json' },
      { kind: 'configuration', configPath: '.devcontainer/a/b/devcontainer.json' },
      { kind: 'configuration', image: 'node:20' },
      { kind: 'configuration', configPath: '.devcontainer/devcontainer.json', image: 'node:20' },
      { kind: 'other' },
      'configuration',
      null,
    ]) {
      expect(parseOpenParams({ ...base, source: odd }), JSON.stringify(odd)).toBeUndefined();
      expect(parseDevspaceSource(odd), JSON.stringify(odd)).toBeUndefined();
    }
    expect(parseOpenParams({ ...base, references: ['node:20', 'node:20', `ghcr.io/a/b@sha256:${'a'.repeat(64)}`] })?.references).toEqual(['node:20', `ghcr.io/a/b@sha256:${'a'.repeat(64)}`]);
    expect(parseOpenParams(base)).not.toHaveProperty('references');
    // The recorded digests, strictly, and only with the references.
    const digest = `sha256:${'a'.repeat(64)}`;
    expect(parseOpenParams({ ...base, references: ['node:20'], referenceDigests: { 'node:20': [digest] } })?.referenceDigests).toEqual({ 'node:20': [digest] });
    expect(parseOpenParams({ ...base, referenceDigests: { 'node:20': [digest] } })).toBeUndefined();
    expect(parseOpenParams({ ...base, references: ['node:20'], referenceDigests: { 'node:18': [digest] } })).toBeUndefined();
    expect(parseOpenParams({ ...base, references: ['node:20'], referenceDigests: { 'node:20': ['latest'] } })).toBeUndefined();
    expect(parseOpenParams({ ...base, references: ['Node:20'] })).toBeUndefined();
    expect(parseOpenParams({ ...base, references: 'node:20' })).toBeUndefined();
    expect(parseOpenParams({ ...base, references: Array.from({ length: MAX_IMAGE_REFERENCES + 1 }, (_, index) => `ghcr.io/a/b:${index}`) })).toBeUndefined();
    expect(parseOpenParams({ ...base, references: Array.from({ length: MAX_IMAGE_REFERENCES }, (_, index) => `ghcr.io/a/b:${index}`) })?.references).toHaveLength(MAX_IMAGE_REFERENCES);
  });
});
