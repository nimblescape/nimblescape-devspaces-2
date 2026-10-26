// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.
// Mutation probes of the image maintenance over the Engine API (src/remoteMonitor/images.ts). The comment of each test
// names the mutants that fail it.
import { describe, expect, it } from 'vitest';
import { abortError } from '../core/ports';
import type { EngineFilters, EngineImage } from '../core/worker/dockerEngine';
import type { ImageEngine } from './engine';
import type { HttpResponse, HttpTransport } from '../core/http';
import { ImageMaintenance, localImagesOf, type ReplacedImages } from './images';

const DEV = 'ghcr.io/majikmate/devcontainer-dev';
/**
 * The tag in use that makes DEV a managed repository.
 */
const IN_USE = `${DEV}:2`;

/**
 * A registry that lists no tags (no pull): only the removals of a pass run. It confirms every manifest by its digest
 * (HEAD), so a removal can go ahead.
 */
// The registries are transports of the worker's registry client.
const NO_TAGS = (): HttpTransport => ({
  request: async ({ url }): Promise<HttpResponse> => {
    const digest = /\/manifests\/(sha256:[0-9a-f]{64})$/.exec(url)?.[1];
    return digest === undefined ? { status: 404, headers: {}, body: '' } : { status: 200, headers: { 'docker-content-digest': digest }, body: '' };
  },
});

/**
 * A registry, without a token, that has another image of every tag than the engine (and confirms every manifest by its
 * digest), so the pass pulls the tag in use.
 */
const NEWER_TAG = (): HttpTransport => ({
  request: async ({ url }): Promise<HttpResponse> => {
    const manifest = /\/manifests\/([^/]+)$/.exec(url)?.[1];
    if (manifest === undefined) return { status: 404, headers: {}, body: '' };
    return { status: 200, headers: { 'docker-content-digest': manifest.startsWith('sha256:') ? manifest : `sha256:${'e'.repeat(64)}` }, body: '' };
  },
});

/**
 * An engine of images over the port: `listed` is its list (one entry per image ID), `inspected` the inspect JSON of an
 * ID or a reference (default: the listed image of that ID or `repository:tag`, untagged when it has no tag, with one
 * layer of its own). Every call is recorded as its method and argument, the filters of a list as JSON.
 */
function engineOf(listed: EngineImage[], inspected: Record<string, unknown> = {}) {
  const calls: string[][] = [];
  const removed: string[] = [];
  const find = (reference: string) => listed.find((image) => image.id === reference || image.repoTags.includes(reference));
  const engine: ImageEngine = {
    images: async (filters: EngineFilters) => (calls.push(['images', JSON.stringify(filters)]), listed.filter((image) => !removed.includes(image.id))),
    inspect: async (_kind, reference) => {
      calls.push(['inspect', reference]);
      if (reference in inspected) return inspected[reference];
      const image = find(reference);
      return image === undefined || removed.includes(image.id) ? undefined : { Id: image.id, RepoTags: image.repoTags, RepoDigests: [`${DEV}@sha256:${'d'.repeat(64)}`], Created: image.created, RootFS: { Type: 'layers', Layers: [`${image.id}/layer`] } };
    },
    pull: async (reference) => void calls.push(['pull', reference]),
    containerIds: async () => [],
    removeImage: async (reference) => {
      calls.push(['removeImage', reference]);
      const image = find(reference);
      if (image !== undefined) removed.push(image.id);
      return image === undefined ? 'missing' : 'removed';
    },
  };
  return { engine, calls };
}

/** An image of the list of the engine. */
function listedImage(id: string, created: string, repoTags: string[] = [], repoDigests: string[] = []): EngineImage {
  return { id, repoTags, repoDigests, labels: {}, created };
}

const TWO_NEWEST = [listedImage('sha256:new', '2026-09-20T00:00:00.000Z', [`${DEV}:2`, `${DEV}:2.0.14`]), listedImage('sha256:prev', '2026-09-10T00:00:00.000Z', [`${DEV}:2.0.13`])];

async function pass(engine: ImageEngine, options: { registryTransport?: () => HttpTransport; log?: string[]; replaced?: ReplacedImages; passes?: number } = {}): Promise<ReplacedImages> {
  let stored: ReplacedImages = options.replaced ?? {};
  const maintenance = new ImageMaintenance({
    engine,
    registryTransport: options.registryTransport ?? NO_TAGS,
    log: (message) => options.log?.push(message),
    referencesInUse: async () => ({ references: [IN_USE], complete: true }),
    replaced: { read: async () => stored, write: async (value) => void (stored = JSON.parse(JSON.stringify(value)) as ReplacedImages) },
  });
  // `passes` of one monitor (an untagged image goes at the pass after the first).
  for (let index = 0; index < (options.passes ?? 1); index++) await maintenance.pass();
  return stored;
}

describe('the image maintenance over the Engine API', () => {
  // Fails on a mutant where RepoTags `null` is not untagged: the inspect of an engine may answer an untagged image with
  // RepoTags null (as `{{json .RepoTags}}` prints it); such a stored replaced image is an older version that is
  // removed, not forgotten.
  it('removes a stored replaced image whose inspect answers RepoTags null, as one with RepoTags []', async () => {
    // The image is listed without any reference (the containerd store after a pull replaced it); the store has its ID.
    const { engine, calls } = engineOf([...TWO_NEWEST, listedImage('sha256:old', '2026-09-01T00:00:00.000Z')], {
      'sha256:old': { Id: 'sha256:old', RepoTags: null, RepoDigests: [`${DEV}@sha256:${'b'.repeat(64)}`], Created: '2026-09-01T00:00:00Z', RootFS: { Type: 'layers', Layers: ['sha256:old/layer'] } },
    });
    await pass(engine, { replaced: { [DEV]: ['sha256:old'] }, passes: 2 });
    // 2.0.13 goes too (no rule keeps it).
    expect(calls.filter((call) => call[0] === 'removeImage')).toEqual([
      ['removeImage', `${DEV}:2.0.13`],
      ['removeImage', 'sha256:old'],
    ]);
  });

  // Fails on a mutant where an image with a tag counts as untagged: a stored replaced ID that now carries a tag of
  // another repository (a user tagged the old version, `docker tag <id> backup:1`) is no untagged version of the
  // repository: it is forgotten, never removed by its ID (a removal by the ID without force removes an image with one
  // tag, the user's tag with it).
  it('never removes by its ID a stored replaced image that a tag of another repository names now', async () => {
    const { engine, calls } = engineOf([...TWO_NEWEST, listedImage('sha256:old', '2026-09-01T00:00:00.000Z', ['registry.example.com/someone/backup:1'])]);
    const stored = await pass(engine, { replaced: { [DEV]: ['sha256:old'] } });
    // 2.0.13 goes (no rule keeps it); never the old one.
    expect(calls.filter((call) => call[0] === 'removeImage')).toEqual([['removeImage', `${DEV}:2.0.13`]]);
    expect(stored[DEV]).not.toContain('sha256:old');
  });

  // Fails on a mutant where imageId never answers, so the image that the monitor's own pull replaced is not recorded:
  // the reference `:2` moved to another image between the list of the pass and the pull (another tool pulled
  // meanwhile); the image that the monitor's pull then replaced is known only by the ID that the inspect before the
  // pull read, and is recorded.
  it("records the image that the monitor's pull replaced, also one that the list of the pass did not show", async () => {
    const created: Record<string, string> = { 'sha256:v1': '2026-09-01T00:00:00Z', 'sha256:v1b': '2026-09-20T00:00:00Z', 'sha256:v2': '2026-09-28T00:00:00Z' };
    let pulled = false;
    const engine: ImageEngine = {
      // Before the pull: `:2` names v1 in the list of the pass. After it: v2, and v1 and v1b without any reference.
      images: async () =>
        pulled
          ? [listedImage('sha256:v2', created['sha256:v2'], [`${DEV}:2`]), listedImage('sha256:v1', created['sha256:v1']), listedImage('sha256:v1b', created['sha256:v1b'])]
          : [listedImage('sha256:v1', created['sha256:v1'], [`${DEV}:2`])],
      inspect: async (_kind, reference) => {
        // Another tool pulled `:2` (v1b) after the list of the pass and before the monitor's pull (v2).
        const id = reference === `${DEV}:2` ? (pulled ? 'sha256:v2' : 'sha256:v1b') : reference;
        // With a digest of the registry (the pull of a tag in use needs the registry to confirm the image).
        return { Id: id, RepoTags: id === 'sha256:v2' || reference === `${DEV}:2` ? [`${DEV}:2`] : [], RepoDigests: [`${DEV}@sha256:${'d'.repeat(64)}`], Created: created[id], RootFS: { Type: 'layers', Layers: [`${id}/layer`] } };
      },
      pull: async () => void (pulled = true),
      containerIds: async () => [],
      removeImage: async () => 'removed',
    };
    const stored = await pass(engine, { registryTransport: NEWER_TAG });
    expect(stored[DEV]).toContain('sha256:v1b');
  });

  // Fails on a mutant with a list with the filter dangling=false: every list of the images of a pass asks for all of
  // them (no filter), as `docker image ls -a` shows them; the engine leaves out the images without any reference with
  // that filter, among them the ones that a pull replaced on the containerd store, whose layers the check "another
  // image is built on it" and the removal of the older versions need.
  it('lists every image of the engine, without a filter, in each list of a pass', async () => {
    const { engine, calls } = engineOf([...TWO_NEWEST, listedImage('sha256:old', '2026-09-01T00:00:00.000Z', [`${DEV}:2.0.12`])]);
    await pass(engine);
    const lists = calls.filter((call) => call[0] === 'images');
    expect(lists.length).toBeGreaterThanOrEqual(3);
    expect(lists.every((call) => call[1] === '{}')).toBe(true);
  });

  // Fails on a mutant where the list names the limit of a pull, or the pull names the limit of a list: a call that does
  // not answer within its time limit names that limit in the log.
  it('names the time limit of the list and of the pull that did not answer', async () => {
    const log: string[] = [];
    const { engine } = engineOf(TWO_NEWEST);
    await pass({ ...engine, images: async () => Promise.reject(abortError()) }, { log });
    expect(log).toEqual(['The images could not be maintained: the list of the images failed: Docker did not answer within 60 seconds.']);
    const pulls: string[] = [];
    await pass({ ...engine, pull: async () => Promise.reject(abortError()) }, { log: pulls, registryTransport: NEWER_TAG });
    expect(pulls).toContain(`${DEV}:2 could not be pulled: Docker did not answer within 3600 seconds.`);
  });

  // Fails on a mutant where the log names the last refusal: of the references of a version that the engine does not
  // remove, the log names the first, as the first line of the errors of `docker image rm`.
  it('names the first of two refused references of a version', async () => {
    const old = listedImage('sha256:old', '2026-08-01T00:00:00.000Z', [`${DEV}:1.0.0`, `${DEV}:1.0`]);
    const { engine } = engineOf([...TWO_NEWEST, old]);
    const log: string[] = [];
    await pass({ ...engine, removeImage: async (reference) => (reference === `${DEV}:1.0.0` ? 'inUse' : 'missing') }, { log });
    expect(log).toContain(`The unused image ${DEV} (1.0.0, 1.0) stays: ${DEV}:1.0.0 is in use (a container, or an image built on it); the engine answered 409.`);
  });

  // Fails on a mutant that takes the first colon of a reference: a repository of a registry with a port
  // (`localhost:5000/…`, a repository of a reference in use) has the rows of its tags, as `docker image ls` shows them,
  // so its older versions are maintained. The rows are exactly those of the CLI (no `<none>` row of a repository that
  // has a tag), so two mutants that are equivalent for the pass fail here too.
  it('reads the tags of a repository of a registry with a port', () => {
    expect(localImagesOf([listedImage('sha256:a', '2026-09-01T00:00:00.000Z', ['localhost:5000/team/app:1.2.3'], ['localhost:5000/team/app@sha256:' + 'a'.repeat(64)])])).toEqual([
      { repository: 'localhost:5000/team/app', tag: '1.2.3', id: 'sha256:a', createdAt: '2026-09-01T00:00:00.000Z' },
    ]);
  });

});
