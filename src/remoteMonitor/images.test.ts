// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it, vi } from 'vitest';
import type { HttpResponse, HttpTransport } from '../core/http';
import { RegistryClient } from '../core/imageCheck/registryClient';
import { abortError } from '../core/ports';
import { EngineError, type EngineFilters, type EngineImage } from '../core/worker/dockerEngine';
import { MAX_ENGINE_LIST_ANSWER_CHARACTERS, type EngineApi, type EngineAnswer, type EngineRequest } from '../helperChannel/engineApi';
import { dockerEngine } from '../helperChannel/engineClient';
import type { ImageEngine } from './engine';
import {
  IMAGE_LIST_TIMEOUT_MS,
  IMAGE_PULL_TIMEOUT_MS,
  IMAGE_REMOVE_TIMEOUT_MS,
  ImageMaintenance,
  localImagesOf,
  parseReplacedImages,
  pruneReplacedImages,
  requestsWithin,
  imagesById,
  type LocalImage,
  type ReplacedImages,
} from './images';

const DEV = 'ghcr.io/majikmate/devcontainer-dev';
const WEB = 'ghcr.io/majikmate/devcontainer-classroom-web';
/** The digest that the fake engine gives every image that came from a registry (its RepoDigests). */
const ENGINE_DIGEST = `sha256:${'d'.repeat(64)}`;

/**
 * The references in use that make the repositories of a test managed. `${DEV}:2` keeps the image of the tag `2` (rule
 * a).
 */
const inUse = (...references: string[]) => ({ referencesInUse: async () => ({ references, complete: true }) });
/** The registry answers `ENGINE_DIGEST` for `${DEV}:2`: unchanged, so the tag in use is not pulled (and nothing is logged). */
const CURRENT = { manifests: { 'majikmate/devcontainer-dev:2': ENGINE_DIGEST } };
/** The registry has another image of `${DEV}:2` than the engine (and confirms the engine's): the tag in use is pulled. */
const NEWER = { manifests: { 'majikmate/devcontainer-dev:2': `sha256:${'e'.repeat(64)}` } };

/**
 * One row of `docker image ls` (a repository and a tag of an image; `<none>`: the image has only a digest of the
 * repository). The fake engine lists the rows of an ID as one image with its references.
 */
function image(repository: string, tag: string, id: string, createdAt: string): LocalImage {
  return { repository, tag, id, createdAt };
}

/**
 * The engine of the test over the port: its images, the containers per image, and the calls, each as the name of the
 * method and its argument. `layers` of an image ID (default: one layer of its own, no image built on another).
 * `failInspect`: every inspect answers that the image does not exist (an image removed meanwhile). `failRemove`:
 * references whose removal the engine refuses as in use (409).
 */
function fakeEngine(options: {
  images: LocalImage[];
  usedBy?: Record<string, string>;
  failRemove?: string[];
  layers?: Record<string, string[]>;
  failInspect?: boolean;
  pulled?: Record<string, string>;
  dangling?: Record<string, string>;
  /** IDs of images built on the engine (no RepoDigests). */
  localBuilds?: string[];
}) {
  const calls: string[][] = [];
  /** The arguments of each call of removeImage (the reference and the signal: no force). */
  const removals: unknown[][] = [];
  /** The options of each pull (no login). */
  const pulls: unknown[] = [];
  let images = [...options.images];
  /** The images of the list of the engine: one per ID, a row with a tag as `repository:tag`, one without as a digest. */
  const listed = (): EngineImage[] => {
    const byId = new Map<string, EngineImage>();
    for (const row of images) {
      const entry = byId.get(row.id) ?? { id: row.id, repoTags: [], repoDigests: [], labels: {}, created: row.createdAt };
      byId.set(row.id, entry);
      if (row.tag === '<none>') entry.repoDigests.push(`${row.repository}@sha256:${'d'.repeat(64)}`);
      else entry.repoTags.push(`${row.repository}:${row.tag}`);
    }
    // The IDs of other images of the engine (built on one of the repositories), and of images that it lists without
    // a reference (the containerd image store after a pull replaced them).
    for (const id of [...Object.keys(options.layers ?? {}), ...Object.keys(options.dangling ?? {})]) {
      if (!byId.has(id)) byId.set(id, { id, repoTags: [], repoDigests: [], labels: {}, created: options.dangling?.[id] ?? '2026-01-01T00:00:00Z' });
    }
    return [...byId.values()];
  };
  const engine: ImageEngine = {
    images: async (filters: EngineFilters) => {
      calls.push(['images', JSON.stringify(filters)]);
      return listed();
    },
    // The ID of a reference, and the tags and time of an ID (`pulled`: what a pull of a reference makes it point to;
    // `dangling`: images that Docker lists without their repository, as the containerd image store does after a pull
    // replaced them), and the layers of an ID: the inspect JSON of the engine.
    inspect: async (kind, reference) => {
      calls.push(['inspect', reference]);
      if (kind !== 'image') throw new Error(`unexpected inspect of a ${kind}`);
      if (options.failInspect) return undefined;
      const id = images.find((row) => row.tag !== '<none>' && `${row.repository}:${row.tag}` === reference)?.id ?? reference;
      const rows = images.filter((row) => row.id === id);
      const dangling = options.dangling?.[id];
      if (rows.length === 0 && dangling === undefined && options.layers?.[id] === undefined) return undefined;
      const tags = rows.filter((row) => row.tag !== '<none>').map((row) => `${row.repository}:${row.tag}`);
      // Every image of the test came from a registry (a digest), but those of `localBuilds`.
      const digests = options.localBuilds?.includes(id) ? [] : [`${rows[0]?.repository ?? DEV}@sha256:${'d'.repeat(64)}`];
      return { Id: id, RepoTags: tags, RepoDigests: digests, Created: dangling ?? rows[0]?.createdAt ?? '2026-01-01T00:00:00Z', RootFS: { Type: 'layers', Layers: options.layers?.[id] ?? [`${id}/layer`] } };
    },
    pull: async (reference, pullOptions) => {
      calls.push(['pull', reference]);
      pulls.push(pullOptions);
      // A pull that moves the reference to a new image: the old one loses it (containerd: listed without repository).
      const target = options.pulled?.[reference];
      if (target !== undefined) {
        const [repository, tag] = [reference.slice(0, reference.lastIndexOf(':')), reference.slice(reference.lastIndexOf(':') + 1)];
        images = images.filter((row) => !(row.repository === repository && row.tag === tag));
        images.push(image(repository, tag, target, '2026-09-28'));
      }
    },
    containerIds: async (filters) => {
      calls.push(['containerIds', JSON.stringify(filters)]);
      const id = filters.ancestor?.[0] ?? '';
      return options.usedBy?.[id] === undefined ? [] : [options.usedBy[id]];
    },
    removeImage: async (...args) => {
      const [reference] = args;
      calls.push(['removeImage', reference]);
      removals.push(args);
      if (options.failRemove?.includes(reference)) return 'inUse';
      const before = images.length;
      images = images.filter((row) => `${row.repository}:${row.tag}` !== reference && row.id !== reference);
      return images.length < before ? 'removed' : 'missing';
    },
  };
  return { engine, calls, removals, pulls };
}

/** The calls of removeImage of a fake engine. */
const removed = (calls: string[][]): string[][] => calls.filter((call) => call[0] === 'removeImage');

/**
 * A registry that wants a token from its challenge, then lists `tags` per repository path: a transport of the worker's
 * registry client, which the image maintenance uses.
 */
function fakeRegistry(tags: Record<string, string[]>, options: { unknownDigests?: string[]; manifests?: Record<string, string> } = {}) {
  const requests: Array<{ url: string; auth?: string }> = [];
  const request = async ({ url, headers = {} }: { url: string; headers?: Record<string, string> }): Promise<HttpResponse> => {
    requests.push({ url, auth: headers.Authorization });
    if (url.startsWith('https://ghcr.io/token?')) return { status: 200, headers: {}, body: JSON.stringify({ token: 'anon-token' }) };
    // The manifests too (HEAD): every digest is known but `unknownDigests`; a tag by `manifests`.
    const match = /^https:\/\/ghcr\.io\/v2\/(.+)\/(?:tags\/list|manifests\/([^/]+))$/.exec(url);
    if (!match) return { status: 404, headers: {}, body: '' };
    if (headers.Authorization !== 'Bearer anon-token') {
      return {
        status: 401,
        headers: { 'www-authenticate': `Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:${match[1]}:pull"` },
        body: '',
      };
    }
    const manifest = match[2];
    if (manifest !== undefined) {
      const digest = manifest.startsWith('sha256:') ? (options.unknownDigests?.includes(manifest) ? undefined : manifest) : options.manifests?.[`${match[1]}:${manifest}`];
      return digest === undefined ? { status: 404, headers: {}, body: '' } : { status: 200, headers: { 'docker-content-digest': digest }, body: '' };
    }
    const list = tags[match[1]];
    return list ? { status: 200, headers: {}, body: JSON.stringify({ name: match[1], tags: list }) } : { status: 404, headers: {}, body: '' };
  };
  return { transport: (): HttpTransport => ({ request }), requests };
}

describe('the images of the remote Monitor', () => {
  // The images of a repository are not ordered as versions; they are grouped by ID in the order of the list
  // (imagesById), as what stays follows the references in use.
  it('groups the images of a repository by their ID, in the order of the list', () => {
    const images: LocalImage[] = localImagesOf([
      { id: 'sha256:b', repoTags: [`${DEV}:2.0.13`], repoDigests: [], labels: {}, created: '2026-09-01T10:00:00.000Z' },
      { id: 'sha256:c', repoTags: [`${DEV}:2`, `${DEV}:2.0.14`], repoDigests: [`${DEV}@sha256:${'c'.repeat(64)}`], labels: {}, created: '2026-09-20T10:00:00.000Z' },
      { id: 'sha256:a', repoTags: [`${DEV}:1.9.0`], repoDigests: [], labels: {}, created: '2026-10-01T10:00:00.000Z' },
      { id: 'sha256:d', repoTags: [], repoDigests: [`${DEV}@sha256:${'d'.repeat(64)}`], labels: {}, created: '2026-09-25T10:00:00.000Z' },
    ]);
    expect(imagesById(images).map((version) => [version.id, version.tags])).toEqual([
      ['sha256:b', ['2.0.13']],
      ['sha256:c', ['2', '2.0.14']],
      ['sha256:a', ['1.9.0']],
      ['sha256:d', []],
    ]);
  });

  it('reads a Bearer challenge', async () => {
    // The challenge is read by the worker's registry client (listTags): its realm, service and scope make the token
    // request; a realm without TLS gets no request; a Basic challenge without credentials (the monitor has none) is no
    // token.
    const tokens: string[] = [];
    const answering = (challenge: string): HttpTransport => ({
      request: async ({ url }): Promise<HttpResponse> => {
        if (url.includes('/v2/')) return { status: 401, headers: { 'www-authenticate': challenge }, body: '' };
        tokens.push(url);
        return { status: 200, headers: {}, body: JSON.stringify({ token: 't' }) };
      },
    });
    const tagsWith = (challenge: string) => new RegistryClient(answering(challenge), async () => undefined).listTags('ghcr.io', 'a/b');
    await tagsWith('Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:a/b:pull"');
    expect(tokens).toEqual(['https://ghcr.io/token?service=ghcr.io&scope=repository%3Aa%2Fb%3Apull']);
    // Only https realms.
    expect(await tagsWith('Bearer realm="http://evil/token"')).toEqual({ kind: 'error', registry: 'ghcr.io', error: 'The registry requires an insecure token service (http://evil).' });
    expect(await tagsWith('Basic realm="x"')).toEqual({ kind: 'authRequired', registry: 'ghcr.io' });
    expect(tokens).toHaveLength(1);
  });

  // The image of the tag in use `2` stays; every other image of the repository is removed, the previous version
  // (2.0.13) too.
  it('keeps the image of a tag in use; removes every other one by its references, never with force, not when a container uses it', async () => {
    const engine = fakeEngine({
      images: [
        image(DEV, '2', 'sha256:new', '2026-09-20'),
        image(DEV, '2.0.14', 'sha256:new', '2026-09-20'),
        image(DEV, '2.0.13', 'sha256:prev', '2026-09-10'),
        image(DEV, '2.0.12', 'sha256:used', '2026-09-01'),
        image(DEV, '2.0.11', 'sha256:old', '2026-08-01'),
        image(DEV, '<none>', 'sha256:dangling', '2026-07-01'),
        image(DEV, '2.0.10', 'sha256:parent', '2026-06-01'),
      ],
      usedBy: { 'sha256:used': 'container-id\n' },
      failRemove: [`${DEV}:2.0.10`],
    });
    const registry = fakeRegistry({}, CURRENT);
    const log: string[] = [];
    // Two passes, as an untagged image goes only at the pass after the one that first saw it untagged.
    const maintenance = new ImageMaintenance({ engine: engine.engine, registryTransport: registry.transport, log: (message) => log.push(message), ...inUse(`${DEV}:2`) });
    await maintenance.pass();
    await maintenance.pass();
    // One removal of the engine per reference, each with the reference and its time limit only: never with force.
    expect(removed(engine.calls)).toEqual([
      ['removeImage', `${DEV}:2.0.13`],
      ['removeImage', `${DEV}:2.0.11`],
      ['removeImage', `${DEV}:2.0.10`],
      ['removeImage', 'sha256:dangling'],
      ['removeImage', `${DEV}:2.0.10`],
    ]);
    expect(engine.removals.every((args) => args.length === 2 && args[1] instanceof AbortSignal)).toBe(true);
    // The engine answers 409 for an image in use; the image stays and the log says why. The images in the order of the
    // list.
    expect(log).toEqual([
      `Removed the unused image ${DEV} (2.0.13).`,
      `Removed the unused image ${DEV} (2.0.11).`,
      `The unused image ${DEV} (sha256:dangling) stays until the next pass: it was replaced only now.`,
      `The unused image ${DEV} (2.0.10) stays: ${DEV}:2.0.10 is in use (a container, or an image built on it); the engine answered 409.`,
      `Removed the unused image ${DEV} (sha256:dangling).`,
      `The unused image ${DEV} (2.0.10) stays: ${DEV}:2.0.10 is in use (a container, or an image built on it); the engine answered 409.`,
    ]);
  });

  // No order of versions: the image of `${DEV}:2` (no version tag of its own) stays as the target of the tag in use;
  // `latest` works as any other tag: in use, its image stays (and is pulled); `${WEB}:1`, not on the engine yet, is
  // pulled and its image stays, `${DEV}:2` is current at its registry and not pulled; every other image goes.
  it('keeps the image that a tag in use points to after its pull, and the image of a latest in use; removes the others', async () => {
    const engine = fakeEngine({
      pulled: { [`${WEB}:1`]: 'sha256:w101' },
      images: [
        image(DEV, '2', 'sha256:new', '2026-09-28'),
        image(DEV, '2.0.14', 'sha256:v14', '2026-09-20'),
        image(DEV, '2.0.13', 'sha256:v13', '2026-09-10'),
        image(WEB, 'latest', 'sha256:wnew', '2026-09-28'),
        image(WEB, '1.0.1', 'sha256:w101', '2020-01-02'),
        image(WEB, '1.0.0', 'sha256:w100', '2020-01-01'),
        image(WEB, '0.9.0', 'sha256:w090', '2019-01-01'),
      ],
    });
    // The registry has a newer `latest` than the engine (another digest), so it is pulled.
    const registry = fakeRegistry({}, { manifests: { ...CURRENT.manifests, 'majikmate/devcontainer-classroom-web:latest': `sha256:${'f'.repeat(64)}` } });
    const log: string[] = [];
    await new ImageMaintenance({
      engine: engine.engine,
      registryTransport: registry.transport,
      log: (message) => log.push(message),
      ...inUse(`${DEV}:2`, `${WEB}:1`, `${WEB}:latest`),
    }).pass();
    expect(engine.calls.filter((call) => call[0] === 'pull')).toEqual([
      ['pull', `${WEB}:1`],
      ['pull', `${WEB}:latest`],
    ]);
    expect(removed(engine.calls)).toEqual([
      ['removeImage', `${DEV}:2.0.14`],
      ['removeImage', `${DEV}:2.0.13`],
      ['removeImage', `${WEB}:1.0.0`],
      ['removeImage', `${WEB}:0.9.0`],
    ]);
  });

  // `latest` works as any other tag: an image of `latest` that no reference in use names is removed, as is every other
  // image that no rule keeps.
  it('removes an image of latest that is not in use, and every other image that no rule keeps', async () => {
    const engine = fakeEngine({
      images: [
        image(DEV, 'latest', 'sha256:stale', '2025-01-01'),
        image(DEV, '2', 'sha256:new', '2026-09-28'),
        image(DEV, '<none>', 'sha256:prev', '2026-09-20'),
        image(DEV, '<none>', 'sha256:older', '2026-09-01'),
      ],
    });
    const log: string[] = [];
    const maintenance = new ImageMaintenance({
      engine: engine.engine,
      registryTransport: fakeRegistry({}, CURRENT).transport,
      log: (message) => log.push(message),
      ...inUse(`${DEV}:2`),
    });
    // The untagged ones at the second pass.
    await maintenance.pass();
    await maintenance.pass();
    expect(removed(engine.calls)).toEqual([
      ['removeImage', `${DEV}:latest`],
      ['removeImage', 'sha256:prev'],
      ['removeImage', 'sha256:older'],
    ]);
  });

  // An idle time limit of the socket alone would let a registry that sends a byte now and then, or a connection cut in
  // the middle of an answer, keep a pass (and every later one) open for ever. The limit of each request is
  // requestsWithin over the transport of the worker's registry client (at the limit, an AbortError); a transport that
  // never answers (a trickle), one that fails (a cut), and one that answers. The trickle and the cut over real TLS
  // through the proxy of the daemon: images.daemonProxy.test.ts.
  it('the registry request ends within its time limit, also when the answer trickles or is cut', async () => {
    const never: HttpTransport = { request: () => new Promise(() => {}) };
    const started = Date.now();
    await expect(requestsWithin(never, 400).request({ method: 'GET', url: 'https://ghcr.io/v2/' })).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(2_000);
    const cut: HttpTransport = { request: async () => Promise.reject(new Error('aborted')) };
    await expect(requestsWithin(cut, 5_000).request({ method: 'GET', url: 'https://ghcr.io/v2/' })).rejects.toThrow('aborted');
    const ok: HttpTransport = { request: async () => ({ status: 200, headers: {}, body: '{"tags":[]}' }) };
    await expect(requestsWithin(ok, 5_000).request({ method: 'GET', url: 'https://ghcr.io/v2/' })).resolves.toMatchObject({ status: 200, body: '{"tags":[]}' });
    // The signal of the transport ends at the limit, also with a signal of the caller.
    let seen: AbortSignal | undefined;
    const watching: HttpTransport = { request: (_request, signal) => ((seen = signal), new Promise(() => {})) };
    await expect(requestsWithin(watching, 50).request({ method: 'GET', url: 'https://ghcr.io/v2/' }, new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen?.aborted).toBe(true);
  });

  // A transport can throw at once for an invalid URL or header; the time limit must then not end the monitor with an
  // uncaught error (requestsWithin).
  it('a registry request that cannot start rejects and leaves no timer behind', async () => {
    const throwing: HttpTransport = {
      request: () => {
        throw new TypeError('Invalid URL');
      },
    };
    await expect(requestsWithin(throwing, 50).request({ method: 'GET', url: 'https://[bad' })).rejects.toThrow('Invalid URL');
    // Past the time limit: nothing is thrown (vitest fails on an uncaught error).
    await new Promise((resolve) => setTimeout(resolve, 120));
  });

  // With the containerd image store, the image that a pull replaced is listed without its repository; the monitor keeps
  // its ID in the volume and removes it once no rule keeps it (here after the pull of the tag in use `2`).
  it('removes the images that pulls replaced also when Docker lists them without their repository', async () => {
    const dangling: Record<string, string> = {};
    const engine = fakeEngine({ images: [image(DEV, '2', 'sha256:v1', '2026-09-01')], pulled: { [`${DEV}:2`]: 'sha256:v2' }, dangling });
    const second = fakeEngine({ images: [image(DEV, '2', 'sha256:v2', '2026-09-28')], pulled: { [`${DEV}:2`]: 'sha256:v3' }, dangling });
    let stored: ReplacedImages = {};
    const replaced = { read: async () => stored, write: async (value: ReplacedImages) => void (stored = JSON.parse(JSON.stringify(value)) as ReplacedImages) };
    // One monitor for all passes (an untagged image goes at the pass after the one that first saw it), on the engine of
    // the step.
    let current = engine.engine;
    const maintenance = new ImageMaintenance({
      engine: {
        images: (...args) => current.images(...args),
        inspect: (...args) => current.inspect(...args),
        pull: (...args) => current.pull(...args),
        containerIds: (...args) => current.containerIds(...args),
        removeImage: (...args) => current.removeImage(...args),
      },
      registryTransport: fakeRegistry({}, NEWER).transport,
      log: () => {},
      ...inUse(`${DEV}:2`),
      replaced,
    });
    // v1 is replaced by v2 and listed as <none> <none> (not in the list of the repository).
    dangling['sha256:v1'] = '2026-09-01T00:00:00Z';
    await maintenance.pass();
    // The store keeps every ID seen with a tag of the repository, so also the current v2.
    expect(Object.keys(stored)).toEqual([DEV]);
    expect([...stored[DEV]].sort()).toEqual(['sha256:v1', 'sha256:v2']);
    // The removals of the engine, here and below. v1 is removed by its ID, as no rule keeps it: at the next pass, not
    // the one of the pull that replaced it.
    expect(removed(engine.calls)).toEqual([]);
    await maintenance.pass();
    expect(removed(engine.calls)).toEqual([['removeImage', 'sha256:v1']]);
    // The next update: v2 is replaced and removed by its ID at the pass after; v1 is gone and forgotten.
    delete dangling['sha256:v1'];
    current = second.engine;
    dangling['sha256:v2'] = '2026-09-28T00:00:00Z';
    await maintenance.pass();
    expect(removed(second.calls)).toEqual([]);
    await maintenance.pass();
    expect(removed(second.calls)).toEqual([['removeImage', 'sha256:v2']]);
    expect(stored[DEV]).toContain('sha256:v2');
    expect(stored[DEV]).not.toContain('sha256:v1');
    // A repository of Docker Hub as the engine lists it (`ubuntu`) is stored too (a reference in use can name it); a
    // name that the engine never lists is not.
    expect(parseReplacedImages('{"ghcr.io/a/b":["sha256:x",3],"ubuntu":["sha256:y"],"docker.io/library/ubuntu":["sha256:z"],"Not/Valid":["sha256:w"]}')).toEqual({
      'ghcr.io/a/b': ['sha256:x'],
      ubuntu: ['sha256:y'],
    });
    expect(parseReplacedImages('not json')).toEqual({});
  });

  // The update of the extension at each open (or a user) can pull a tag before the monitor does; the image that it
  // replaced must still be known as replaced, or it would stay for ever. `2` is a tag in use, current at its registry.
  it('removes older versions also when another tool pulled the new ones', async () => {
    const dangling: Record<string, string> = {};
    let stored: ReplacedImages = {};
    const replaced = { read: async () => stored, write: async (value: ReplacedImages) => void (stored = JSON.parse(JSON.stringify(value)) as ReplacedImages) };
    // Each pass sees `:2` on the image that another tool pulled since; the monitor's own pull changes nothing. One
    // monitor for all passes, each pass on the engine of its step, and two passes per step (an untagged image goes at
    // the pass after the one that first saw it untagged).
    let current = fakeEngine({ images: [], dangling }).engine;
    const maintenance = new ImageMaintenance({
      engine: {
        images: (...args) => current.images(...args),
        inspect: (...args) => current.inspect(...args),
        pull: (...args) => current.pull(...args),
        containerIds: (...args) => current.containerIds(...args),
        removeImage: (...args) => current.removeImage(...args),
      },
      registryTransport: fakeRegistry({}, CURRENT).transport,
      log: () => {},
      ...inUse(`${DEV}:2`),
      replaced,
    });
    const pass = async (id: string, created: string) => {
      const engine = fakeEngine({ images: [image(DEV, '2', id, created)], dangling });
      current = engine.engine;
      await maintenance.pass();
      await maintenance.pass();
      return engine;
    };
    await pass('sha256:v1', '2026-09-01');
    dangling['sha256:v1'] = '2026-09-01T00:00:00Z';
    // The replaced v1 goes.
    const second = await pass('sha256:v2', '2026-09-10');
    expect(removed(second.calls)).toEqual([['removeImage', 'sha256:v1']]);
    delete dangling['sha256:v1'];
    dangling['sha256:v2'] = '2026-09-10T00:00:00Z';
    const engine = await pass('sha256:v3', '2026-09-20');
    expect(removed(engine.calls)).toEqual([['removeImage', 'sha256:v2']]);
  });

  // An ID stored for two repositories is removed by neither while one of them keeps it: an image that one repository
  // keeps (the tag in use `${DEV}:2`) and that a tag of another managed repository names, which keeps no image by that
  // tag (`${MINE}:3` is its tag in use).
  it('removes no image that another repository keeps', async () => {
    const MINE = 'ghcr.io/majikmate/devcontainer-dev-mine';
    const engine = fakeEngine({
      images: [image(DEV, '2', 'sha256:y', '2026-09-28'), image(MINE, '3', 'sha256:p', '2026-09-27'), image(MINE, '1', 'sha256:y', '2026-09-28')],
    });
    const stored: ReplacedImages = { [DEV]: ['sha256:y'], [MINE]: ['sha256:y'] };
    await new ImageMaintenance({
      engine: engine.engine,
      registryTransport: fakeRegistry({}).transport,
      log: () => {},
      ...inUse(`${DEV}:2`, `${MINE}:3`),
      replaced: { read: async () => stored, write: async () => {} },
    }).pass();
    expect(removed(engine.calls)).toEqual([]);
  });

  // Beyond the limit, the IDs that are tagged now go first, not the untagged ones. observe remembers the tagged IDs
  // between the passes.
  it('keeps untagged IDs beyond the limit and remembers tagged IDs between passes', async () => {
    const tagged = Array.from({ length: 210 }, (_, index) => image(DEV, `2.0.${index}`, `sha256:t${index}`, '2026-09-01'));
    let stored: ReplacedImages = { [DEV]: ['sha256:old1', 'sha256:old2'] };
    const maintenance = new ImageMaintenance({
      engine: fakeEngine({ images: tagged }).engine,
      registryTransport: fakeRegistry({}).transport,
      log: () => {},
      // A tag in use of the repository.
      ...inUse(`${DEV}:2.0.0`),
      replaced: { read: async () => stored, write: async (value) => void (stored = JSON.parse(JSON.stringify(value)) as ReplacedImages) },
    });
    await maintenance.observe();
    expect(stored[DEV]).toHaveLength(200);
    expect(stored[DEV].slice(0, 2)).toEqual(['sha256:old1', 'sha256:old2']);
  });

  // The store drops empty lists and keeps the other repositories: the images in use change between the computers of a
  // shared engine.
  it('prunes the stored IDs: no empty lists, and keeps the other repositories', () => {
    const OLD = 'ghcr.io/someone/else';
    const given: ReplacedImages = { [DEV]: ['sha256:a'], [WEB]: [], [OLD]: ['sha256:b'] };
    expect(pruneReplacedImages(given)).toEqual({ [DEV]: ['sha256:a'], [OLD]: ['sha256:b'] });
    // The given record is not changed.
    expect(given[WEB]).toEqual([]);
    expect(pruneReplacedImages({})).toEqual({});
  });

  // A tag in use of DEV; the stored IDs of a repository that the monitor does not manage stay in the store untouched.
  it('writes the pruned store at the end of a pass', async () => {
    const OLD = 'ghcr.io/someone/else';
    let stored: ReplacedImages = { [DEV]: ['sha256:v1'], [WEB]: [], [OLD]: ['sha256:gone'] };
    await new ImageMaintenance({
      engine: fakeEngine({ images: [image(DEV, '2', 'sha256:v1', '2026-09-01')] }).engine,
      registryTransport: fakeRegistry({}, CURRENT).transport,
      log: () => {},
      ...inUse(`${DEV}:2`),
      replaced: { read: async () => stored, write: async (value) => void (stored = JSON.parse(JSON.stringify(value)) as ReplacedImages) },
    }).pass();
    // The other repository stays in the store; only the empty list goes.
    expect(stored).toEqual({ [DEV]: ['sha256:v1'], [OLD]: ['sha256:gone'] });
  });

  // Docker removes the tag of an image that another image is built on and keeps the image. The tag in use `2` is one
  // that the engine does not have; it keeps none of these images.
  it('leaves an older image alone that another image is built on, and removes nothing when the layers cannot be read', async () => {
    const images = [
      image(DEV, '2.0.14', 'sha256:a', '2026-09-20'),
      image(DEV, '2.0.13', 'sha256:b', '2026-09-10'),
      image(DEV, '2.0.12', 'sha256:base', '2026-09-01'),
    ];
    const engine = fakeEngine({ images, layers: { 'sha256:base': ['l1', 'l2'], 'sha256:devspace': ['l1', 'l2', 'l3'] } });
    const log: string[] = [];
    const run = (target: ImageEngine) =>
      new ImageMaintenance({ engine: target, registryTransport: fakeRegistry({}).transport, log: (message) => log.push(message), ...inUse(`${DEV}:2`) }).pass();
    await run(engine.engine);
    // The two images that no rule keeps are removed; the one that another image is built on stays.
    expect(removed(engine.calls)).toEqual([
      ['removeImage', `${DEV}:2.0.14`],
      ['removeImage', `${DEV}:2.0.13`],
    ]);
    expect(log).toContain(`The unused image ${DEV} (2.0.12) stays: another image is built on it.`);
    const failing = fakeEngine({ images, failInspect: true });
    await run(failing.engine);
    expect(removed(failing.calls)).toEqual([]);
    expect(log).toContain(`The unused image ${DEV} (2.0.12) stays: its layers could not be read.`);
    // An engine whose inspect fails (it does not answer) removes nothing either: the pass stops at the inspect of the
    // tag in use.
    const brokenBase = fakeEngine({ images });
    const broken: ImageEngine = { ...brokenBase.engine, inspect: async () => Promise.reject(new EngineError('the daemon is busy', 500)) };
    const before = log.length;
    await run(broken);
    expect(removed(brokenBase.calls)).toEqual([]);
    expect(log.slice(before)).toContain(`No image is removed in this pass: the image of ${DEV}:2 could not be inspected: the daemon is busy`);
  });

  // A registry that cannot be asked confirms no image, so nothing of the repository is removed. The tag in use `2.0.14`
  // is not pulled, as its registry cannot be asked.
  it('does not pull a tag in use whose registry cannot be asked, and removes nothing that its registry cannot confirm', async () => {
    const engine = fakeEngine({
      images: [image(DEV, '2.0.14', 'sha256:a', '2026-09-20'), image(DEV, '2.0.13', 'sha256:b', '2026-09-10'), image(DEV, '2.0.12', 'sha256:c', '2026-09-01')],
    });
    const log: string[] = [];
    const registryTransport = (): HttpTransport => ({ request: async () => ({ status: 500, headers: {}, body: '' }) });
    await new ImageMaintenance({ engine: engine.engine, registryTransport, log: (message) => log.push(message), ...inUse(`${DEV}:2.0.14`) }).pass();
    expect(engine.calls.some((call) => call[0] === 'pull')).toBe(false);
    // The reason as the worker's registry client gives it.
    expect(log[0]).toBe(`${DEV}:2.0.14 is not pulled in this pass: its registry does not confirm the tag (The registry answered with HTTP 500.); the image on the engine stays.`);
    expect(removed(engine.calls)).toEqual([]);
    expect(log).toContain(`The unused image ${DEV} (2.0.12) stays: no registry confirms it (built on this engine, or the registry cannot be asked).`);
  });

  // The tests of the daily time (06:07 in Europe/Vienna, daylight saving time) and of the time zone are in
  // src/core/remoteMonitor/cron.test.ts.

  // Without images in use, nothing; with one, the failure of the engine is logged.
  it('does nothing without images in use, and never throws when Docker does not answer', async () => {
    const calls: string[] = [];
    // An engine whose every call fails.
    const failing = (name: string) => async (): Promise<never> => {
      calls.push(name);
      throw new Error('connect ECONNREFUSED /var/run/docker.sock');
    };
    const engine: ImageEngine = { images: failing('images'), inspect: failing('inspect'), pull: failing('pull'), containerIds: failing('containerIds'), removeImage: failing('removeImage') };
    const registryTransport = (): HttpTransport => ({ request: async () => ({ status: 200, headers: {}, body: '{}' }) });
    await new ImageMaintenance({ engine, registryTransport, log: () => {} }).pass();
    await new ImageMaintenance({ engine, registryTransport, log: () => {}, ...inUse() }).pass();
    expect(calls).toEqual([]);
    const log: string[] = [];
    await new ImageMaintenance({ engine, registryTransport, log: (message) => log.push(message), ...inUse(`${DEV}:2`) }).pass();
    // The failure of the list of the engine.
    expect(log).toEqual(['The images could not be maintained: the list of the images failed: connect ECONNREFUSED /var/run/docker.sock']);
    expect(calls).toEqual(['images']);
  });
});

// The image maintenance over the Engine API: the answers of the engine (an error in the stream of a pull, an image in
// use, a reference that is gone, an engine that does not answer), the time limit of each call, and the requests of the
// real port.
describe('the image maintenance over the Engine API', () => {
  // `${DEV}:2` is a tag in use; the registry answers that it is current (CURRENT), or newer when a pull is needed
  // (NEWER).
  const VERSIONS = [image(DEV, '2', 'sha256:new', '2026-09-20'), image(DEV, '2.0.14', 'sha256:new', '2026-09-20'), image(DEV, '2.0.13', 'sha256:prev', '2026-09-10')];

  it('logs a pull whose stream reports an error, records no replaced image for it, and still cleans', async () => {
    const engine = fakeEngine({ images: [...VERSIONS, image(DEV, '2.0.12', 'sha256:old', '2026-09-01')], pulled: { [`${DEV}:2`]: 'sha256:newer' } });
    let stored: ReplacedImages = {};
    const log: string[] = [];
    await new ImageMaintenance({
      // The engine answers 200, and its stream carries the error (the port rejects with its message).
      engine: { ...engine.engine, pull: async (reference) => (engine.calls.push(['pull', reference]), Promise.reject(new EngineError('manifest unknown', 200))) },
      registryTransport: fakeRegistry({}, NEWER).transport,
      log: (message) => log.push(message),
      ...inUse(`${DEV}:2`),
      replaced: { read: async () => stored, write: async (value) => void (stored = JSON.parse(JSON.stringify(value)) as ReplacedImages) },
    }).pass();
    // Every image but that of the tag in use on the engine (`2`, kept as the pull failed) is removed.
    expect(log).toEqual([`${DEV}:2 could not be pulled: manifest unknown`, `Removed the unused image ${DEV} (2.0.13).`, `Removed the unused image ${DEV} (2.0.12).`]);
    // The pull did not move the reference: no ID is recorded as replaced by it (the store has the tagged IDs only).
    expect([...stored[DEV]].sort()).toEqual(['sha256:new', 'sha256:old', 'sha256:prev']);
    expect(removed(engine.calls)).toEqual([
      ['removeImage', `${DEV}:2.0.13`],
      ['removeImage', `${DEV}:2.0.12`],
    ]);
  });

  it('tries every reference of a version; one in use (409) keeps it, and the log names the first refusal', async () => {
    const engine = fakeEngine({ images: [...VERSIONS, image(DEV, '1.0.0', 'sha256:old', '2026-08-01'), image(DEV, '1.0', 'sha256:old', '2026-08-01')], failRemove: [`${DEV}:1.0.0`] });
    const log: string[] = [];
    await new ImageMaintenance({ engine: engine.engine, registryTransport: fakeRegistry({}, CURRENT).transport, log: (message) => log.push(message), ...inUse(`${DEV}:2`) }).pass();
    // As `docker image rm a b`: each reference in turn, also after a refusal. 2.0.13 is removed first (no rule keeps
    // it).
    expect(removed(engine.calls)).toEqual([
      ['removeImage', `${DEV}:2.0.13`],
      ['removeImage', `${DEV}:1.0.0`],
      ['removeImage', `${DEV}:1.0`],
    ]);
    expect(log).toContain(`The unused image ${DEV} (1.0.0, 1.0) stays: ${DEV}:1.0.0 is in use (a container, or an image built on it); the engine answered 409.`);
    // The refusals of all of a version's references share one time limit.
    expect(engine.removals[1][1]).toBe(engine.removals[2][1]);
  });

  it('a reference that is gone (404) keeps the version in the log as "No such image"; another failure names its message', async () => {
    const engine = fakeEngine({ images: [...VERSIONS, image(DEV, '2.0.12', 'sha256:old', '2026-09-01')] });
    const log: string[] = [];
    const run = (target: ImageEngine) =>
      new ImageMaintenance({ engine: target, registryTransport: fakeRegistry({}, CURRENT).transport, log: (message) => log.push(message), ...inUse(`${DEV}:2`) }).pass();
    await run({ ...engine.engine, removeImage: async () => 'missing' });
    // 2.0.13 is not kept either.
    expect(log.filter((line) => line.startsWith('The unused image'))).toEqual([
      `The unused image ${DEV} (2.0.13) stays: No such image: ${DEV}:2.0.13`,
      `The unused image ${DEV} (2.0.12) stays: No such image: ${DEV}:2.0.12`,
    ]);
    await run({ ...engine.engine, removeImage: async () => Promise.reject(new EngineError('the daemon is busy', 500)) });
    expect(log.at(-1)).toBe(`The unused image ${DEV} (2.0.12) stays: the daemon is busy`);
    // A removal that does not answer within its time limit.
    await run({ ...engine.engine, removeImage: async () => Promise.reject(abortError()) });
    expect(log.at(-1)).toBe(`The unused image ${DEV} (2.0.12) stays: Docker did not answer within 120 seconds.`);
  });

  // The layers of one image that cannot be read (removed meanwhile: 404; or the engine fails for it) keep every older
  // version in that pass, as that image may be built on one.
  it('removes nothing in a pass in which the layers of one image cannot be read', async () => {
    const images = [image(DEV, '2.0.14', 'sha256:a', '2026-09-20'), image(DEV, '2.0.13', 'sha256:b', '2026-09-10'), image(DEV, '2.0.12', 'sha256:base', '2026-09-01')];
    const layers = { 'sha256:base': ['l1', 'l2'], 'sha256:devspace': ['l1', 'l2', 'l3'] };
    for (const answer of [async () => undefined, async () => Promise.reject(new EngineError('the daemon is busy', 500))]) {
      const engine = fakeEngine({ images, layers });
      const log: string[] = [];
      const target: ImageEngine = { ...engine.engine, inspect: async (kind, reference, signal) => (reference === 'sha256:devspace' ? answer() : engine.engine.inspect(kind, reference, signal)) };
      await new ImageMaintenance({ engine: target, registryTransport: fakeRegistry({}).transport, log: (message) => log.push(message), ...inUse(`${DEV}:2`) }).pass();
      expect(removed(engine.calls)).toEqual([]);
      expect(log).toContain(`The unused image ${DEV} (2.0.12) stays: its layers could not be read.`);
    }
  });

  // A stored replaced ID whose inspect fails is forgotten (not kept for a later pass), and nothing is removed by it.
  it('forgets a stored replaced ID whose inspect fails, and removes nothing by it', async () => {
    const engine = fakeEngine({ images: VERSIONS, dangling: { 'sha256:x': '2026-09-01T00:00:00Z' } });
    let stored: ReplacedImages = { [DEV]: ['sha256:x'] };
    const target: ImageEngine = { ...engine.engine, inspect: async (kind, reference, signal) => (reference === 'sha256:x' ? Promise.reject(new Error('connect ECONNREFUSED /var/run/docker.sock')) : engine.engine.inspect(kind, reference, signal)) };
    await new ImageMaintenance({
      engine: target,
      registryTransport: fakeRegistry({}, CURRENT).transport,
      log: () => {},
      ...inUse(`${DEV}:2`),
      replaced: { read: async () => stored, write: async (value) => void (stored = JSON.parse(JSON.stringify(value)) as ReplacedImages) },
    }).pass();
    // Nothing at all, as the layers of that image cannot be read either.
    expect(removed(engine.calls)).toEqual([]);
    expect(stored[DEV]).not.toContain('sha256:x');
  });

  it('removes no version whose containers cannot be listed (the ancestor check fails), and logs nothing for it', async () => {
    const engine = fakeEngine({ images: [...VERSIONS, image(DEV, '2.0.12', 'sha256:old', '2026-09-01')], usedBy: {} });
    const log: string[] = [];
    await new ImageMaintenance({
      engine: { ...engine.engine, containerIds: async () => Promise.reject(new Error('connect ECONNREFUSED /var/run/docker.sock')) },
      registryTransport: fakeRegistry({}, CURRENT).transport,
      log: (message) => log.push(message),
      ...inUse(`${DEV}:2`),
    }).pass();
    expect(removed(engine.calls)).toEqual([]);
    // Nothing is logged.
    expect(log).toEqual([]);
    // One used by a container (the ancestor check of the engine): kept too.
    const used = fakeEngine({ images: [...VERSIONS, image(DEV, '2.0.12', 'sha256:old', '2026-09-01')], usedBy: { 'sha256:old': 'c'.repeat(64) } });
    await new ImageMaintenance({ engine: used.engine, registryTransport: fakeRegistry({}, CURRENT).transport, log: (message) => log.push(message), ...inUse(`${DEV}:2`) }).pass();
    expect(used.calls).toContainEqual(['containerIds', JSON.stringify({ ancestor: ['sha256:old'] })]);
    // 2.0.13 goes (no rule keeps it); 2.0.12 stays.
    expect(removed(used.calls)).toEqual([['removeImage', `${DEV}:2.0.13`]]);
  });

  // Each call of the engine has its time limit, as an AbortSignal (AbortSignal.timeout, read here through a spy): a
  // list or an inspect IMAGE_LIST_TIMEOUT_MS, a pull IMAGE_PULL_TIMEOUT_MS, the removal of a version
  // IMAGE_REMOVE_TIMEOUT_MS.
  it('gives each call of the engine its time limit', async () => {
    const limits = new Map<AbortSignal, number>();
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      const signal = new AbortController().signal;
      limits.set(signal, ms);
      return signal;
    });
    try {
      const engine = fakeEngine({ images: [...VERSIONS, image(DEV, '2.0.12', 'sha256:old', '2026-09-01')], pulled: { [`${DEV}:2`]: 'sha256:newer' } });
      const timed: Array<[string, number | undefined]> = [];
      const limit = (signal: AbortSignal | undefined) => (signal === undefined ? undefined : limits.get(signal));
      const target: ImageEngine = {
        images: async (filters, signal) => (timed.push(['images', limit(signal)]), engine.engine.images(filters)),
        inspect: async (kind, reference, signal) => (timed.push(['inspect', limit(signal)]), engine.engine.inspect(kind, reference)),
        pull: async (reference, options) => (timed.push(['pull', limit(options?.signal)]), engine.engine.pull(reference)),
        containerIds: async (filters, signal) => (timed.push(['containerIds', limit(signal)]), engine.engine.containerIds(filters)),
        removeImage: async (reference, signal) => (timed.push(['removeImage', limit(signal)]), engine.engine.removeImage(reference)),
      };
      await new ImageMaintenance({ engine: target, registryTransport: fakeRegistry({}, NEWER).transport, log: () => {}, ...inUse(`${DEV}:2`) }).pass();
      const byCall = new Map<string, Set<number | undefined>>();
      for (const [call, ms] of timed) byCall.set(call, new Set([...(byCall.get(call) ?? []), ms]));
      expect(Object.fromEntries([...byCall].map(([call, values]) => [call, [...values]]))).toEqual({
        images: [IMAGE_LIST_TIMEOUT_MS],
        inspect: [IMAGE_LIST_TIMEOUT_MS],
        pull: [IMAGE_PULL_TIMEOUT_MS],
        containerIds: [IMAGE_LIST_TIMEOUT_MS],
        removeImage: [IMAGE_REMOVE_TIMEOUT_MS],
      });
      expect([IMAGE_LIST_TIMEOUT_MS, IMAGE_PULL_TIMEOUT_MS, IMAGE_REMOVE_TIMEOUT_MS]).toEqual([60_000, 3_600_000, 120_000]);
      expect(removed(engine.calls).length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  // The requests of the real port (src/helperChannel/engineClient.ts) over an Engine API in memory, with the answers as the
  // engine gives them: `Created` of the list in Unix seconds, `RepoTags` and `RepoDigests`, the inspect JSON, the pull
  // stream, and 409 for an image in use.
  it('runs a pass over the real port: the list as rows of `docker image ls -a`, the pull without a login, the ancestor list, and the removal without force', async () => {
    const requests: EngineRequest[] = [];
    const ok = (value: unknown, status = 200): EngineAnswer => ({ status, body: JSON.stringify(value), truncated: false });
    const seconds = (date: string) => Date.parse(date) / 1000;
    const listed = [
      { Id: 'sha256:new', RepoTags: [`${DEV}:2`, `${DEV}:2.0.14`], RepoDigests: [`${DEV}@sha256:${'a'.repeat(64)}`], Created: seconds('2026-09-20T00:00:00Z') },
      { Id: 'sha256:prev', RepoTags: [`${DEV}:2.0.13`], RepoDigests: [], Created: seconds('2026-09-10T00:00:00Z') },
      // An image that a pull replaced on the classic store: only a digest of the repository (a `<none>` row of it).
      { Id: 'sha256:old', RepoTags: [], RepoDigests: [`${DEV}@sha256:${'b'.repeat(64)}`], Created: seconds('2026-09-01T00:00:00Z') },
      { Id: 'sha256:used', RepoTags: [`${DEV}:2.0.11`], RepoDigests: [], Created: seconds('2026-08-01T00:00:00Z') },
      { Id: 'sha256:other', RepoTags: ['ghcr.io/someone/else:1'], RepoDigests: [], Created: seconds('2026-07-01T00:00:00Z') },
    ];
    const api: EngineApi = async (request) => {
      requests.push(request);
      const path = decodeURIComponent(request.path);
      if (request.method === 'GET' && path.startsWith('/images/json')) return ok(listed);
      if (request.method === 'GET' && path.startsWith('/images/')) {
        const id = path === `/images/${DEV}:2/json` ? 'sha256:new' : path.slice('/images/'.length, -'/json'.length);
        return ok({ Id: id, RepoTags: [], RepoDigests: [`${DEV}@sha256:${'e'.repeat(64)}`], Created: '2026-01-01T00:00:00Z', RootFS: { Type: 'layers', Layers: [`${id}/layer`] } });
      }
      if (request.method === 'POST' && path.startsWith('/images/create')) {
        request.onChunk?.('{"status":"Status: Image is up to date for ghcr.io/majikmate/devcontainer-dev:2"}\n');
        return ok('');
      }
      if (request.method === 'GET' && path.startsWith('/containers/json')) return ok(path.includes('sha256:used') ? [{ Id: 'c'.repeat(64) }] : []);
      if (request.method === 'DELETE' && path.startsWith('/images/')) return path === '/images/sha256:old' ? ok({ message: 'conflict: unable to delete sha256:old (cannot be forced) - image has dependent child images' }, 409) : ok([]);
      return ok({ message: 'not routed' }, 500);
    };
    const engine = dockerEngine(api, async () => Promise.reject(new Error('no exec in this test')));
    const log: string[] = [];
    // The registry has another image of the tag in use than the engine's (`e`), so it is pulled.
    await new ImageMaintenance({ engine, registryTransport: fakeRegistry({}, { manifests: { 'majikmate/devcontainer-dev:2': `sha256:${'f'.repeat(64)}` } }).transport, log: (message) => log.push(message), ...inUse(`${DEV}:2`) }).pass();
    const paths = requests.map((request) => `${request.method} ${decodeURIComponent(request.path)}`);
    // The list without `all` (no intermediate images; none of a repository), with no filter, within the bound of a list
    // of every image, not the 1 MiB of the other requests.
    expect(paths).toContain('GET /images/json?filters={}');
    expect(requests.filter((request) => request.path.startsWith('/images/json')).map((request) => request.maxCharacters)).toEqual([
      MAX_ENGINE_LIST_ANSWER_CHARACTERS,
      MAX_ENGINE_LIST_ANSWER_CHARACTERS,
      MAX_ENGINE_LIST_ANSWER_CHARACTERS,
    ]);
    // The pull of the tag in use, anonymous: no header of a login.
    const pull = requests.find((request) => request.path.startsWith('/images/create'))!;
    expect(decodeURIComponent(pull.path)).toBe(`/images/create?fromImage=${DEV}:2`);
    expect(pull.headers).toEqual({});
    // The image of the tag in use stays; of the others, the one a container uses stays (ancestor), the previous version
    // goes; without force: DELETE without a query. The untagged one only at the next pass.
    expect(paths).toContain('GET /containers/json?all=true&filters={"ancestor":["sha256:used"]}');
    expect(paths.filter((entry) => entry.startsWith('DELETE'))).toEqual([`DELETE /images/${DEV}:2.0.13`]);
    expect(log).toEqual([`Removed the unused image ${DEV} (2.0.13).`, `The unused image ${DEV} (sha256:old) stays until the next pass: it was replaced only now.`]);
  });
});
