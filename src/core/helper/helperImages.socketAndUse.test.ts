// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// HelperImages: helperDockerSocket takes the endpoint of the context before DOCKER_HOST, by the rules of the platform
// (the extension uses it for the worker's socket, engineSocket); onImageBuilt reports only a build; the recheck window
// is an hour; recordUse writes helper.json at most once per hour per instance.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ImageInfo } from '../docker/dockerObjects';
import { silentLogger } from '../ports';
import { helperImageTag } from './helperImage';
import type { HelperState } from './helperState';
import { HELPER_DOCKER_SOCKET } from '../names';
import {
  HELPER_IMAGE_RECHECK_MS,
  HelperImages,
  helperDockerSocket,
  type HelperImageDocker,
  type HelperImagesDeps,
} from './helperImages';

const DOCKERFILE = 'FROM node:22-bookworm-slim\n';
const TAG = helperImageTag(DOCKERFILE);
const ID = `sha256:${'c'.repeat(64)}`;

/** An engine with the images of `images`; a build adds its tag. */
class Engine implements HelperImageDocker {
  readonly images = new Set<string>();
  builds = 0;
  async imageExists(reference: string): Promise<boolean> {
    return this.images.has(reference);
  }
  async imageId(reference: string): Promise<string | undefined> {
    return this.images.has(reference) ? ID : undefined;
  }
  async buildImage(options: { tag: string }): Promise<string | undefined> {
    this.builds += 1;
    this.images.add(options.tag);
    return ID;
  }
  async listImagesByLabel(): Promise<ImageInfo[]> {
    return [];
  }
  async removeImage(): Promise<boolean> {
    return false;
  }
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-11ier1-'));
  fs.writeFileSync(path.join(dir, 'Dockerfile'), DOCKERFILE);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function images(deps: Partial<HelperImagesDeps> = {}): HelperImages {
  return new HelperImages({ docker: new Engine(), logger: silentLogger, dockerfilePath: path.join(dir, 'Dockerfile'), ...deps });
}

describe('HelperImages: the socket, the report of a build, and the record of the use', () => {
  it('helperDockerSocket takes the endpoint of the context before DOCKER_HOST, by the rules of the platform', () => {
    expect(helperDockerSocket({ DOCKER_HOST: 'unix:///run/user/1/docker.sock' }, 'linux', 'unix:///run/user/2/docker.sock')).toBe('/run/user/2/docker.sock');
    // A unix endpoint of Docker Desktop on macOS: the engine runs in a VM, its socket there is the default.
    expect(helperDockerSocket({}, 'darwin', 'unix:///Users/me/.docker/run/docker.sock')).toBe(HELPER_DOCKER_SOCKET);
  });

  it('reports a built image (onImageBuilt) only after a build', async () => {
    let built = 0;
    const engine = new Engine();
    engine.images.add(TAG);
    expect(await images({ docker: engine, onImageBuilt: () => (built += 1) }).ensureImagePresent()).toEqual({ tag: TAG, id: ID });
    expect(built).toBe(0);
    const missing = new Engine();
    expect(await images({ docker: missing, onImageBuilt: () => (built += 1) }).ensureImagePresent()).toEqual({ tag: TAG, id: ID });
    expect(missing.builds).toBe(1);
    expect(built).toBe(1);
  });

  it('reuses its result for an ensure for one hour', () => {
    expect(HELPER_IMAGE_RECHECK_MS).toBe(60 * 60 * 1000);
  });

  it('records the use of its cached image in helper.json at most once per hour per instance', async () => {
    const statePath = path.join(dir, 'helper.json');
    let now = Date.parse('2026-10-08T12:00:00.000Z');
    const engine = new Engine();
    engine.images.add(TAG);
    const helper = images({ docker: engine, statePath, clock: { now: () => now } });
    const state = (): HelperState => JSON.parse(fs.readFileSync(statePath, 'utf8')) as HelperState;
    /** Another window's cleanup marks the tag as foreign (a write of this instance clears the mark). */
    const markForeign = (): void => {
      const saved = state();
      saved.images[TAG] = { ...saved.images[TAG], foreignSince: new Date(now).toISOString() };
      fs.writeFileSync(statePath, JSON.stringify(saved));
    };
    await helper.ensureImagePresent();
    expect(state().images[TAG].lastUsedAt).toBe('2026-10-08T12:00:00.000Z');
    markForeign();
    now += 10 * 60 * 1000;
    await helper.ensureImagePresent();
    // Within the hour of the last record: helper.json is not written.
    expect(state().images[TAG].foreignSince).toBeDefined();
    now += 51 * 60 * 1000;
    await helper.ensureImagePresent();
    expect(state().images[TAG]).toEqual({ lastUsedAt: '2026-10-08T13:01:00.000Z' });
    markForeign();
    now += 10 * 60 * 1000;
    await helper.ensureImagePresent();
    // Within the hour of that record: not written either (the instance keeps the time of its last write).
    expect(state().images[TAG].foreignSince).toBeDefined();
    expect(engine.builds).toBe(0);
  });
});
