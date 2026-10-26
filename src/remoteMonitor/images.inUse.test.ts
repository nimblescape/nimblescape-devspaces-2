// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Monitor keeps every image tag in use up to date (anonymous pulls; `latest` as any other tag; never a
// reference pinned by a digest), and of the repositories that it manages (those of the references in use) it keeps (a)
// the image that each tag in use points to, (b) every image that a container uses, (c) an image that another image is
// built on, and removes every other one; never an image of another repository. The registry, asked anonymously, decides
// whether an image can be removed (a pull can bring it back) and whether a tag in use is pulled (never over a build on
// the engine); the engine is shaped as the containerd image store answers (every tagged image has a RepoDigests entry,
// also one built on the engine and never pushed).
import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import type { HttpResponse, HttpTransport } from '../core/http';
import { EngineError, type EngineImage } from '../core/worker/dockerEngine';
import type { ImageEngine } from './engine';
import { ImageMaintenance, referenceText, type ReferencesInUse, type ReplacedImages } from './images';
import type { NetworkContact } from './backgroundRules';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const OLD_DIGEST = `sha256:${'b'.repeat(64)}`;
const NEWER = `sha256:${'c'.repeat(64)}`;
const DEV = 'ghcr.io/majikmate/devcontainer-dev';

/** The digest that the engine of the test gives an image ID (the digest of its local index on the containerd store). */
function digestOf(id: string): string {
  return `sha256:${createHash('sha256').update(id).digest('hex')}`;
}

/** An image of the list of the engine. */
function listed(id: string, repoTags: string[] = [], repoDigests: string[] = []): EngineImage {
  return { id, repoTags, repoDigests, labels: {}, created: '2026-10-01T00:00:00.000Z' };
}

/**
 * An engine of images: its list, the inspect of an ID, a tag or a digest reference, a pull that moves a tag to another
 * image (`moves`), the containers of an image (`usedBy`), and the removals. Every call is recorded. The inspect answers
 * RepoDigests as the containerd image store does: the listed ones, else `<name>@<digestOf(id)>` for each tag (the ID
 * itself when it is a digest, as the containerd store has it); none only for the IDs of `noDigests` (the classic image
 * store and a local build). `containerd`: an image that a pull replaced keeps no RepoDigests entry (else the one of the
 * repository, as the classic store keeps it).
 */
function engineOf(images: EngineImage[], options: { moves?: Record<string, string>; usedBy?: string[]; layers?: Record<string, string[]>; noDigests?: string[]; containerd?: boolean } = {}) {
  let current = [...images];
  const calls: string[][] = [];
  const pullOptions: unknown[] = [];
  const find = (reference: string) => current.find((image) => image.id === reference || image.repoTags.includes(reference) || image.repoDigests.includes(reference));
  const digestsOf = (image: EngineImage): string[] =>
    options.noDigests?.includes(image.id)
      ? []
      : image.repoDigests.length > 0
        ? image.repoDigests
        : [...new Set(image.repoTags.map((tag) => tag.slice(0, tag.lastIndexOf(':'))))].map((name) => `${name}@${/^sha256:[0-9a-f]{64}$/.test(image.id) ? image.id : digestOf(image.id)}`);
  const engine: ImageEngine = {
    images: async () => (calls.push(['images']), [...current, ...Object.keys(options.layers ?? {}).filter((id) => !current.some((image) => image.id === id)).map((id) => listed(id))]),
    inspect: async (_kind, reference) => {
      calls.push(['inspect', reference]);
      const image = find(reference) ?? (options.layers?.[reference] !== undefined ? listed(reference) : undefined);
      return image === undefined
        ? undefined
        : { Id: image.id, RepoTags: image.repoTags, RepoDigests: digestsOf(image), Created: image.created, RootFS: { Type: 'layers', Layers: options.layers?.[image.id] ?? [`${image.id}/layer`] } };
    },
    pull: async (reference, pullOption) => {
      calls.push(['pull', reference]);
      pullOptions.push(pullOption);
      const target = options.moves?.[reference];
      if (target === undefined) return;
      // The image that the pull replaced keeps its digest of the repository (the classic store lists it as `<none>`).
      const name = reference.slice(0, reference.lastIndexOf(':'));
      current = current.map((image) =>
        image.repoTags.includes(reference) ? { ...image, repoTags: image.repoTags.filter((tag) => tag !== reference), repoDigests: options.containerd ? [] : [...digestsOf(image).filter((entry) => entry.startsWith(`${name}@`))] } : image,
      );
      const existing = current.find((image) => image.id === target);
      if (existing) existing.repoTags.push(reference);
      else current.push(listed(target, [reference]));
    },
    containerIds: async (filters) => (calls.push(['containerIds', filters.ancestor?.[0] ?? '']), options.usedBy?.includes(filters.ancestor?.[0] ?? '') ? ['c'.repeat(64)] : []),
    removeImage: async (reference) => {
      calls.push(['removeImage', reference]);
      const image = find(reference);
      if (image === undefined) return 'missing';
      if (image.id === reference || image.repoTags.length <= 1) current = current.filter((other) => other !== image);
      else image.repoTags = image.repoTags.filter((tag) => tag !== reference);
      return 'removed';
    },
  };
  return { engine, calls, pullOptions, removed: () => calls.filter((call) => call[0] === 'removeImage').map((call) => call[1]) };
}

/**
 * A registry of every host, without a sign-in, that answers the manifests (HEAD): by digest every one but those of
 * `unknown` (an image built on an engine and never pushed), by tag those of `tags` (`<path>:<tag>` as the registry has
 * it: `library/node:20` on Docker Hub); every other request 404. `fails`: every request fails (500). It records each
 * URL.
 */
function registry(options: { tags?: Record<string, string>; unknown?: string[]; fails?: boolean; absentStatus?: number } = {}) {
  const requests: string[] = [];
  const transport = (): HttpTransport => ({
    request: async (request): Promise<HttpResponse> => {
      requests.push(request.url);
      if (options.fails) return { status: 500, headers: {}, body: '' };
      const match = /^https:\/\/[^/]+\/v2\/(.+)\/manifests\/([^/]+)$/.exec(request.url);
      if (match === null) return { status: 404, headers: {}, body: '' };
      const [, path, manifest] = match;
      const digest = manifest.startsWith('sha256:') ? (options.unknown?.includes(manifest) ? undefined : manifest) : options.tags?.[`${path}:${manifest}`];
      // An unknown digest answers `absentStatus` (default 404; 401 as Docker Hub answers anonymously).
      if (digest === undefined) return { status: manifest.startsWith('sha256:') ? (options.absentStatus ?? 404) : 404, headers: {}, body: '' };
      return { status: 200, headers: { 'docker-content-digest': digest }, body: '' };
    },
  });
  return { transport, requests };
}

async function pass(
  engine: ImageEngine,
  references: string[] | (() => Promise<ReferencesInUse>),
  options: { log?: string[]; registryTransport?: () => HttpTransport; replaced?: ReplacedImages; passes?: number; reached?: NetworkContact[] } = {},
): Promise<ReplacedImages> {
  let stored: ReplacedImages = options.replaced ?? {};
  const maintenance = new ImageMaintenance({
    engine,
    registryTransport: options.registryTransport ?? registry().transport,
    log: (message) => options.log?.push(message),
    referencesInUse: typeof references === 'function' ? references : async () => ({ references, complete: true }),
    replaced: { read: async () => stored, write: async (value) => void (stored = JSON.parse(JSON.stringify(value)) as ReplacedImages) },
  });
  // `passes` of one monitor (an untagged image goes at the pass after the first).
  // What each pass found of the network goes to `reached`.
  for (let index = 0; index < (options.passes ?? 1); index++) {
    const reached = await maintenance.pass();
    options.reached?.push(reached);
  }
  return stored;
}

describe('the images in use of the Monitor', () => {
  it('pulls every tag in use anonymously: `latest` as any other tag, a name without a tag as latest, never one pinned by a digest', async () => {
    const { engine, calls, pullOptions } = engineOf([]);
    const asked = registry();
    const log: string[] = [];
    await pass(
      engine,
      ['node:20', 'docker.io/library/node:20', 'mcr.microsoft.com/devcontainers/base:ubuntu', 'ghcr.io/majikmate/devcontainer-classroom-web:latest', 'redis', `ghcr.io/acme/pinned@${DIGEST}`, `postgres:16@${DIGEST}`, 'Not a reference'],
      { log, registryTransport: asked.transport },
    );
    expect(calls.filter((call) => call[0] === 'pull').map((call) => call[1])).toEqual(['node:20', 'mcr.microsoft.com/devcontainers/base:ubuntu', 'ghcr.io/majikmate/devcontainer-classroom-web:latest', 'redis:latest']);
    // Without a login (only the time limit): a tag that the engine does not have is pulled, after one anonymous request
    // for the digest of each tag in use (the registry answer for the opens); none for a pinned one.
    expect(pullOptions.map((option) => Object.keys(option as object))).toEqual([['signal'], ['signal'], ['signal'], ['signal']]);
    expect(asked.requests).toEqual([
      'https://registry-1.docker.io/v2/library/node/manifests/20',
      'https://mcr.microsoft.com/v2/devcontainers/base/manifests/ubuntu',
      'https://ghcr.io/v2/majikmate/devcontainer-classroom-web/manifests/latest',
      'https://registry-1.docker.io/v2/library/redis/manifests/latest',
    ]);
    expect(log).toEqual([]);
    expect(referenceText({ repository: 'node' })).toBe('node:latest');
    expect(referenceText({ repository: 'node', tag: '20', digest: DIGEST })).toBe(`node@${DIGEST}`);
  });

  it('a pass whose registries did not answer is offline', async () => {
    const { engine } = engineOf([listed('sha256:n20', ['node:20'])]);
    const silent: NetworkContact[] = [];
    await pass(engine, ['node:20'], { registryTransport: registry({ fails: true }).transport, passes: 2, reached: silent });
    expect(silent).toEqual(['offline', 'offline']);
  });

  it('a pass reached the network when a registry answered: also with a pull that failed (for the network or refused); none without images in use', async () => {
    const { engine } = engineOf([]);
    const refused: ImageEngine = { ...engine, pull: async () => Promise.reject(new EngineError('pull access denied for ghcr.io/private/x, repository does not exist or may require authorization', 404)) };
    const offline: ImageEngine = { ...engine, pull: async () => Promise.reject(new EngineError('Get "https://ghcr.io/v2/": dial tcp: lookup ghcr.io: no such host', 500)) };
    const reached: NetworkContact[] = [];
    await pass(refused, ['ghcr.io/private/x:1'], { reached });
    await pass(offline, ['ghcr.io/acme/app:1'], { reached });
    await pass(engine, ['node:20'], { reached });
    await pass(engine, [], { reached });
    expect(reached).toEqual(['reached', 'reached', 'reached', 'none']);
  });

  it('a failure of the engine itself (its list) is none of the network', async () => {
    const { engine } = engineOf([]);
    const reached: NetworkContact[] = [];
    await pass({ ...engine, images: async () => Promise.reject(Object.assign(new Error('connect ECONNREFUSED /var/run/docker.sock'), { code: 'ECONNREFUSED' })) }, ['node:20'], { reached });
    expect(reached).not.toContain('offline');
  });

  it('a pass without images in use after an offline one is none (nothing of the pass before counts)', async () => {
    const { engine } = engineOf([listed('sha256:n20', ['node:20'])]);
    let references = ['node:20'];
    const reached: NetworkContact[] = [];
    await pass(engine, async () => ({ references, complete: true }), {
      registryTransport: registry({ fails: true }).transport,
      passes: 1,
      reached,
    });
    references = [];
    const maintenance = new ImageMaintenance({
      engine,
      registryTransport: registry({ fails: true }).transport,
      log: () => {},
      referencesInUse: async () => ({ references, complete: true }),
    });
    references = ['node:20'];
    reached.push(await maintenance.pass());
    references = [];
    reached.push(await maintenance.pass());
    expect(reached).toEqual(['offline', 'offline', 'none']);
  });

  it('a failed pull (a private image) is one line of the log per pass', async () => {
    const { engine } = engineOf([]);
    const failing: ImageEngine = { ...engine, pull: async () => Promise.reject(new EngineError('pull access denied for ghcr.io/private/x, repository does not exist or may require authorization', 404)) };
    const log: string[] = [];
    await pass(failing, ['ghcr.io/private/x:1'], { log });
    expect(log).toEqual(['ghcr.io/private/x:1 could not be pulled: pull access denied for ghcr.io/private/x, repository does not exist or may require authorization']);
    await pass(failing, ['ghcr.io/private/x:1'], { log });
    expect(log).toHaveLength(2);
  });

  it('keeps the image each tag in use points to now, removes every other image of those repositories, never one of another repository', async () => {
    const { engine, calls, removed } = engineOf(
      [
        listed('sha256:n20old', ['node:20']),
        listed('sha256:n18', ['node:18']),
        listed('sha256:n16', ['node:16']),
        listed('sha256:nold', [], [`node@${OLD_DIGEST}`]),
        listed('sha256:p3', ['python:3']),
        listed('sha256:pin', [], [`ghcr.io/acme/pinned@${DIGEST}`]),
        listed('sha256:pinold', ['ghcr.io/acme/pinned:old']),
      ],
      { moves: { 'node:20': 'sha256:n20new' }, usedBy: ['sha256:n16'] },
    );
    const log: string[] = [];
    // The registry has a newer `node:20` (Docker Hub: `library/node`).
    const asked = registry({ tags: { 'library/node:20': NEWER } });
    await pass(engine, ['node:20', `ghcr.io/acme/pinned@${DIGEST}`], { log, registryTransport: asked.transport, passes: 2 });
    expect(calls).toContainEqual(['pull', 'node:20']);
    expect(asked.requests).toContain('https://registry-1.docker.io/v2/library/node/manifests/20');
    // The image that `node:20` pointed to before the pull is replaced: it goes too, at the next pass (no devspace image
    // is built on it here); the one a container uses (node:16) stays.
    expect(removed().sort()).toEqual(['ghcr.io/acme/pinned:old', 'node:18', 'sha256:n20old', 'sha256:nold'].sort());
    expect(removed()).not.toContain('python:3');
    expect(log.filter((line) => line.startsWith('Removed'))).toHaveLength(4);
  });

  // A build that resolved the old ID a moment before the pull keeps its base.
  it('removes an image that a pull replaced only from the next pass on, never at the pass of the pull or after a restart', async () => {
    const images = () => [listed('sha256:n20old', ['node:20'])];
    const first = engineOf(images(), { moves: { 'node:20': 'sha256:n20new' } });
    const log: string[] = [];
    const asked = registry({ tags: { 'library/node:20': NEWER } });
    await pass(first.engine, ['node:20'], { log, registryTransport: asked.transport });
    expect(first.calls).toContainEqual(['pull', 'node:20']);
    expect(first.removed()).toEqual([]);
    expect(log).toContain('The unused image node (sha256:n20old) stays until the next pass: it was replaced only now.');
    // A new monitor (a restart): its first pass removes no untagged image either; its second does.
    await pass(first.engine, ['node:20'], { registryTransport: asked.transport });
    expect(first.removed()).toEqual([]);
    await pass(first.engine, ['node:20'], { registryTransport: asked.transport, passes: 2 });
    expect(first.removed()).toEqual(['sha256:n20old']);
  });

  it('an image that a devspace image is built on stays, also when no tag in use points to it any more', async () => {
    const { engine, removed } = engineOf([listed('sha256:n20old', ['node:20'])], {
      moves: { 'node:20': 'sha256:n20new' },
      layers: { 'sha256:n20old': ['l1'], 'sha256:devspace': ['l1', 'l2'] },
    });
    const log: string[] = [];
    await pass(engine, ['node:20'], { log, registryTransport: registry({ tags: { 'library/node:20': NEWER } }).transport, passes: 2 });
    expect(removed()).toEqual([]);
    expect(log).toContain('The unused image node (sha256:n20old) stays: another image is built on it.');
  });

  it('removes nothing when the references in use could not all be read (the pulls still run)', async () => {
    const { engine, calls, removed } = engineOf([listed('sha256:n18', ['node:18']), listed('sha256:n20', ['node:20'])]);
    const log: string[] = [];
    await pass(engine, async () => ({ references: ['node:20'], complete: false }), { log, registryTransport: registry({ tags: { 'library/node:20': NEWER } }).transport });
    expect(calls).toContainEqual(['pull', 'node:20']);
    expect(removed()).toEqual([]);
    expect(log).toEqual(['No image is removed in this pass: the images in use could not be read.']);
    // A read that throws: the same.
    const second = engineOf([listed('sha256:n18', ['node:18'])], {});
    await pass(second.engine, async () => Promise.reject(new Error('EIO')), { log });
    expect(second.removed()).toEqual([]);
    expect(log).toContain('The images in use could not be read: EIO');
  });

  it('removes nothing when the image of a reference in use cannot be inspected', async () => {
    const { engine, removed } = engineOf([listed('sha256:n18', ['node:18']), listed('sha256:n20', ['node:20'])]);
    const log: string[] = [];
    // The inspect before the pull (what the engine has) and the two around the pull answer; the fourth, of the rule (what
    // `node:20` points to now), fails.
    let inspects = 0;
    const busy: ImageEngine = { ...engine, inspect: async (kind, reference, signal) => (reference === 'node:20' && ++inspects > 3 ? Promise.reject(new EngineError('the daemon is busy', 500)) : engine.inspect(kind, reference, signal)) };
    await pass(busy, ['node:20'], { log, registryTransport: registry({ tags: { 'library/node:20': NEWER } }).transport });
    expect(removed()).toEqual([]);
    expect(log).toEqual(['No image is removed in this pass: the image of node:20 could not be inspected: the daemon is busy']);
  });

  it('never removes by its ID an image that a tag of another repository names', async () => {
    const { engine, removed } = engineOf([listed('sha256:n20', ['node:20']), listed('sha256:copy', ['registry.example.com/someone/copy:1'], [`node@${OLD_DIGEST}`])]);
    const log: string[] = [];
    await pass(engine, ['node:20'], { log, registryTransport: registry({ tags: { 'library/node:20': digestOf('sha256:n20') } }).transport, passes: 2 });
    expect(removed()).toEqual([]);
    expect(log).toContain('The unused image node (sha256:copy) stays: a tag of another repository names it.');
  });

  // The monitor neither pulls nor removes an image of a repository that no reference in use names (it only reads the
  // layers of every image, rule c), also when the store of the volume still holds its IDs from an earlier pass (they
  // stay as they are).
  it('never touches the images of a repository that no reference in use names, nor their stored IDs', async () => {
    const { engine, calls, removed } = engineOf([
      listed('sha256:one', [`${DEV}:1`]),
      listed('sha256:two', [`${DEV}:2`]),
      listed('sha256:patch', [`${DEV}:2.0.1`]),
      listed('sha256:n20', ['node:20']),
    ]);
    const asked = registry({ tags: { 'library/node:20': digestOf('sha256:n20') } });
    const stored = await pass(engine, ['node:20'], { registryTransport: asked.transport, replaced: { [DEV]: ['sha256:one', 'sha256:gone'] }, passes: 2 });
    expect(removed()).toEqual([]);
    // Only the read of the layers of every image (rule c) inspects them, by their IDs.
    const own = ['sha256:one', 'sha256:two', 'sha256:patch', 'sha256:gone'];
    expect(calls.filter((call) => call[0] !== 'images' && !(call[0] === 'inspect' && own.includes(call[1])) && call.some((part) => part.includes(DEV) || own.includes(part)))).toEqual([]);
    expect(calls.filter((call) => call[0] === 'inspect' && call[1] === 'sha256:gone')).toEqual([]);
    expect(asked.requests.filter((url) => url.includes('devcontainer-dev'))).toEqual([]);
    expect(stored[DEV]).toEqual(['sha256:one', 'sha256:gone']);
  });

  it('manages the repositories of the references in use, and remembers their images between the passes', async () => {
    let stored: ReplacedImages = {};
    const maintenance = new ImageMaintenance({
      engine: engineOf([listed('sha256:n20', ['node:20']), listed('sha256:p3', ['python:3'])]).engine,
      registryTransport: registry().transport,
      log: () => {},
      referencesInUse: async () => ({ references: ['node:20'], complete: true }),
      replaced: { read: async () => stored, write: async (value) => void (stored = JSON.parse(JSON.stringify(value)) as ReplacedImages) },
    });
    await maintenance.observe();
    expect(stored).toEqual({ node: ['sha256:n20'] });
  });

  // A tagged image is removed only when its registry confirms one of its digests (a pull can bring it back). The
  // containerd store gives a build on the engine a digest too, which no registry has.
  it('never removes an image that no registry confirms: a build on the engine (with or without a digest); one from a registry goes', async () => {
    const { engine, removed } = engineOf(
      [listed('sha256:dev', ['myapp:dev']), listed('sha256:dev2', ['myapp:dev2']), listed('sha256:dev3', ['myapp:dev3']), listed('sha256:old', ['myapp:old'], [`myapp@${OLD_DIGEST}`])],
      { noDigests: ['sha256:dev3'] },
    );
    const log: string[] = [];
    const asked = registry({ unknown: [digestOf('sha256:dev'), digestOf('sha256:dev2')] });
    await pass(engine, ['myapp:dev'], { log, registryTransport: asked.transport });
    expect(removed()).toEqual(['myapp:old']);
    const stays = 'stays: no registry confirms it (built on this engine, or the registry cannot be asked).';
    expect(log).toContain(`The unused image myapp (dev2) ${stays}`);
    expect(log).toContain(`The unused image myapp (dev3) ${stays}`);
    expect(log.filter((line) => line.includes('dev2'))).toHaveLength(1);
    // The confirmation of the image of the registry: a HEAD of its digest at Docker Hub.
    expect(asked.requests).toContain(`https://registry-1.docker.io/v2/library/myapp/manifests/${OLD_DIGEST}`);
  });

  it('an untagged image goes only when its registry confirms its digest (not the previous build of a tag built again)', async () => {
    const { engine, removed } = engineOf([listed('sha256:n20', ['node:20']), listed('sha256:built', [], [`node@${DIGEST}`]), listed('sha256:pulled', [], [`node@${OLD_DIGEST}`])]);
    const log: string[] = [];
    await pass(engine, ['node:20'], { log, registryTransport: registry({ tags: { 'library/node:20': digestOf('sha256:n20') }, unknown: [DIGEST] }).transport, passes: 2 });
    expect(removed()).toEqual(['sha256:pulled']);
    expect(log).toContain('The unused image node (sha256:built) stays: no registry confirms it (built on this engine, or the registry cannot be asked).');
  });

  it('a registry that cannot be asked: no pull of a tag that the engine has, and nothing removed', async () => {
    const { engine, calls, removed } = engineOf([listed('sha256:n20', ['node:20']), listed('sha256:n18', ['node:18'])]);
    const log: string[] = [];
    await pass(engine, ['node:20'], { log, registryTransport: registry({ fails: true }).transport });
    expect(calls.filter((call) => call[0] === 'pull')).toEqual([]);
    expect(removed()).toEqual([]);
    expect(log[0]).toMatch(/^node:20 is not pulled in this pass: its registry does not confirm the tag \(/);
    expect(log).toContain('The unused image node (18) stays: no registry confirms it (built on this engine, or the registry cannot be asked).');
  });

  // A pull would replace the build on the engine with the image of the registry of that name (name squatting on Docker
  // Hub), and the build would then go as an untagged image.
  it('never pulls a tag in use over a build on the engine, nor one that the registry does not know; an unchanged tag is not pulled', async () => {
    const { engine, calls, removed } = engineOf([listed('sha256:dev', ['myapp:dev']), listed('sha256:own', ['myapp:own']), listed('sha256:n20', ['node:20']), listed('sha256:n22', ['node:22'])]);
    const log: string[] = [];
    const asked = registry({
      // Someone else's `myapp:dev` at Docker Hub; the engine's digests of myapp are unknown there.
      tags: { 'library/myapp:dev': NEWER, 'library/node:20': digestOf('sha256:n20'), 'library/node:22': NEWER },
      unknown: [digestOf('sha256:dev'), digestOf('sha256:own')],
    });
    await pass(engine, ['myapp:dev', 'myapp:own', 'node:20', 'node:22'], { log, registryTransport: asked.transport });
    // node:20 is unchanged (the digest of the registry is the engine's): no pull; node:22 changed: pulled.
    expect(calls.filter((call) => call[0] === 'pull').map((call) => call[1])).toEqual(['node:22']);
    // The text names both causes.
    expect(log).toContain('myapp:dev is not pulled: its registry does not have the image on the engine (removed there, or built on this engine); it stays.');
    expect(log).toContain('myapp:own is not pulled in this pass: its registry does not confirm the tag (HTTP 404); the image on the engine stays.');
    expect(removed()).toEqual([]);
    // Only HEAD requests of manifests: none counts against the pull limit of Docker Hub.
    expect(asked.requests.every((url) => url.includes('/manifests/'))).toBe(true);
    // An inspect that fails before the pull: no pull of that tag in this pass, logged.
    const failing = engineOf([listed('sha256:n20', ['node:20'])]);
    const busy: ImageEngine = { ...failing.engine, inspect: async () => Promise.reject(new EngineError('the daemon is busy', 500)) };
    const lines: string[] = [];
    await pass(busy, ['node:20'], { log: lines });
    expect(failing.calls.filter((call) => call[0] === 'pull')).toEqual([]);
    expect(lines[0]).toBe('node:20 is not pulled in this pass: its image could not be inspected: the daemon is busy');
  });

  // On the containerd store the image that a pull replaced is untagged without any RepoDigests entry; its ID is the
  // digest of its index, which the registry of the repository confirms.
  it('removes an untagged image without RepoDigests from the next pass on when the registry confirms its ID (containerd)', async () => {
    const replaced = digestOf('the old index');
    const unknown = digestOf('a local build');
    const { engine, removed } = engineOf([listed('sha256:n20', ['node:20'])], { noDigests: [replaced, unknown] });
    // The images that the store remembers for `node` (untagged, listed without a reference).
    const images: ImageEngine = {
      ...engine,
      images: async (filters, signal) => [...(await engine.images(filters, signal)), listed(replaced), listed(unknown)],
      inspect: async (kind, reference, signal) =>
        reference === replaced || reference === unknown
          ? { Id: reference, RepoTags: [], RepoDigests: [], Created: '2026-10-01T00:00:00Z', RootFS: { Type: 'layers', Layers: [`${reference}/layer`] } }
          : engine.inspect(kind, reference, signal),
    };
    const asked = registry({ tags: { 'library/node:20': digestOf('sha256:n20') }, unknown: [unknown] });
    const log: string[] = [];
    await pass(images, ['node:20'], { log, registryTransport: asked.transport, replaced: { node: [replaced, unknown] }, passes: 2 });
    expect(removed()).toEqual([replaced]);
    expect(asked.requests).toContain(`https://registry-1.docker.io/v2/library/node/manifests/${replaced}`);
    expect(log).toContain(`The unused image node (${unknown.slice(0, 19)}) stays: no registry confirms it (built on this engine, or the registry cannot be asked).`);
  });

  // The registry no longer has the engine's old manifest (a cleanup of untagged versions, a lifecycle rule); the digest
  // that an open recorded for the reference shows that the image came from it.
  it('pulls a tag whose old manifest the registry no longer has when an open recorded its digest (both stores)', async () => {
    const recordedDigest = digestOf('the index that the open read');
    // The classic store: the RepoDigests entry of the repository is the recorded digest.
    const classic = engineOf([listed('sha256:n20', ['node:20'], [`node@${recordedDigest}`])]);
    // The containerd store: the ID is the recorded digest.
    const containerd = engineOf([listed(recordedDigest, ['node:20'])]);
    for (const { engine, calls } of [classic, containerd]) {
      const log: string[] = [];
      const asked = registry({ tags: { 'library/node:20': NEWER }, unknown: [recordedDigest, digestOf(recordedDigest)] });
      await pass(engine, async () => ({ references: ['docker.io/library/node:20'], digests: { 'docker.io/library/node:20': [recordedDigest] }, complete: true }), { log, registryTransport: asked.transport });
      expect(calls).toContainEqual(['pull', 'node:20']);
      expect(log.filter((line) => line.includes('is not pulled'))).toEqual([]);
    }
    // Without that evidence (another recorded digest): no pull, and the log names both causes.
    const other = engineOf([listed('sha256:n20', ['node:20'], [`node@${recordedDigest}`])]);
    const log: string[] = [];
    await pass(other.engine, async () => ({ references: ['node:20'], digests: { 'node:20': [OLD_DIGEST] }, complete: true }), {
      log,
      registryTransport: registry({ tags: { 'library/node:20': NEWER }, unknown: [recordedDigest] }).transport,
    });
    expect(other.calls.filter((call) => call[0] === 'pull')).toEqual([]);
    expect(log).toContain('node:20 is not pulled: its registry does not have the image on the engine (removed there, or built on this engine); it stays.');
    // An unchanged tag on the containerd store (the registry's digest is the ID): no pull.
    const unchanged = engineOf([listed(NEWER, ['node:22'])], { noDigests: [NEWER] });
    const quiet: string[] = [];
    await pass(unchanged.engine, ['node:22'], { log: quiet, registryTransport: registry({ tags: { 'library/node:22': NEWER } }).transport });
    expect(unchanged.calls.filter((call) => call[0] === 'pull')).toEqual([]);
    expect(quiet).toEqual([]);
  });

  // A registry that does not answer is asked once per pass, not once per image.
  it('does not ask a registry host again in a pass after it did not answer', async () => {
    const { engine, calls, removed } = engineOf([listed('sha256:n20', ['node:20']), listed('sha256:n22', ['node:22']), listed('sha256:n18', ['node:18']), listed('sha256:n16', ['node:16'])]);
    const asked = registry({ fails: true });
    const log: string[] = [];
    // Two passes of one monitor: per pass one HEAD (the first answers 500, which the registry client counts as no
    // answer); the other requests of the pass are skipped; the next pass asks again.
    await pass(engine, ['node:20', 'node:22'], { log, registryTransport: asked.transport, passes: 2 });
    expect(asked.requests).toHaveLength(2);
    expect(log.filter((line) => line === 'The registry registry-1.docker.io did not answer; it is not asked again in this pass.')).toHaveLength(2);
    expect(calls.filter((call) => call[0] === 'pull')).toEqual([]);
    expect(removed()).toEqual([]);
  });

  // An old version that came from a registry goes also when the registry deleted it; one without that evidence stays.
  it('removes an old version that the monitor pulled over also when its registry deleted it; the evidence survives a restart (both stores)', async () => {
    for (const containerd of [true, false]) {
      const oldId = containerd ? digestOf('the old index') : 'sha256:n20old';
      const oldDigest = containerd ? oldId : digestOf(oldId);
      const { engine, removed } = engineOf([listed(oldId, ['node:20'])], { moves: { 'node:20': digestOf('the new index') }, containerd });
      const unknown: string[] = [];
      const asked = registry({ tags: { 'library/node:20': NEWER }, unknown });
      let replaced: ReplacedImages = {};
      let pulledOver: ReplacedImages = {};
      const log: string[] = [];
      const monitor = () =>
        new ImageMaintenance({
          engine,
          registryTransport: asked.transport,
          log: (message) => log.push(message),
          referencesInUse: async () => ({ references: ['node:20'], complete: true }),
          replaced: { read: async () => replaced, write: async (value) => void (replaced = JSON.parse(JSON.stringify(value)) as ReplacedImages) },
          pulledOver: { read: async () => pulledOver, write: async (value) => void (pulledOver = JSON.parse(JSON.stringify(value)) as ReplacedImages) },
        });
      // The pull replaces the old version (the registry confirms the engine's image, and has a newer one).
      await monitor().pass();
      expect(pulledOver).toEqual({ node: [oldId] });
      // The registry deletes the old manifest; a restart of the monitor: its first pass sees the old version untagged,
      // its second removes it by the evidence in the volume.
      unknown.push(oldDigest);
      const restarted = monitor();
      await restarted.pass();
      expect(removed()).toEqual([]);
      await restarted.pass();
      expect(removed()).toEqual([oldId]);
      expect(log).toContain(`Removed the old version node (${oldId.slice(0, 19)}) (its registry no longer has it; it came from a pull).`);
      // The store keeps no ID of an image that is gone.
      await restarted.pass();
      expect(pulledOver).toEqual({});
    }
  });

  // Only on a definite answer of the registry (404, or 401 to the anonymous request); a registry that cannot be asked
  // keeps the old version.
  it('removes an old version that the registry deleted only on its definite answer; one that cannot be asked keeps it', async () => {
    for (const absentStatus of [404, 401]) {
      const oldId = digestOf('the old index');
      const { engine, removed } = engineOf([listed(oldId, ['node:20'])], { moves: { 'node:20': digestOf('the new index') }, containerd: true });
      const options: { tags: Record<string, string>; unknown: string[]; fails: boolean; absentStatus: number } = { tags: { 'library/node:20': NEWER }, unknown: [], fails: false, absentStatus };
      const asked = registry(options);
      const log: string[] = [];
      const monitor = new ImageMaintenance({
        engine,
        registryTransport: asked.transport,
        log: (message) => log.push(message),
        referencesInUse: async () => ({ references: ['node:20'], complete: true }),
      });
      await monitor.pass();
      options.unknown.push(oldId);
      // The registry does not answer (a 5xx): the old version stays in these passes (also when the host is skipped).
      options.fails = true;
      await monitor.pass();
      await monitor.pass();
      expect(removed()).toEqual([]);
      expect(log).toContain(`The unused image node (${oldId.slice(0, 19)}) stays: no registry confirms it (built on this engine, or the registry cannot be asked).`);
      // It answers again: the definite answer that it no longer has the old version.
      options.fails = false;
      await monitor.pass();
      expect(removed()).toEqual([oldId]);
    }
  });

  it('removes an old version whose digest an open recorded also when its registry deleted it; without evidence, or used, it stays (both stores)', async () => {
    const recordedDigest = digestOf('the index that the open read');
    // The containerd store: the ID of the old version is the recorded digest; the classic store: its RepoDigests entry.
    const containerd = { id: recordedDigest, repoDigests: [] as string[] };
    const classic = { id: 'sha256:old', repoDigests: [`node@${recordedDigest}`] };
    for (const shape of [containerd, classic]) {
      const run = async (recorded: string, usedBy: string[] = []) => {
        const { engine, removed } = engineOf([listed('sha256:n20', ['node:20']), listed(shape.id, [], shape.repoDigests)], { usedBy, noDigests: shape.repoDigests.length === 0 ? [shape.id] : [] });
        const inspecting: ImageEngine = {
          ...engine,
          inspect: async (kind, reference, signal) =>
            reference === shape.id ? { Id: shape.id, RepoTags: [], RepoDigests: shape.repoDigests, Created: '2026-10-01T00:00:00Z', RootFS: { Type: 'layers', Layers: [`${shape.id}/layer`] } } : engine.inspect(kind, reference, signal),
        };
        const log: string[] = [];
        await pass(inspecting, async () => ({ references: ['node:20'], digests: { 'node:20': [recorded] }, complete: true }), {
          log,
          registryTransport: registry({ tags: { 'library/node:20': digestOf('sha256:n20') }, unknown: [recordedDigest] }).transport,
          replaced: { node: [shape.id] },
          passes: 2,
        });
        return { removed: removed(), log };
      };
      const evidence = await run(recordedDigest);
      expect(evidence.removed).toEqual([shape.id]);
      expect(evidence.log).toContain(`Removed the old version node (${shape.id.slice(0, 19)}) (its registry no longer has it; it came from a pull).`);
      // Another recorded digest: no evidence; the image may be a build on this engine.
      const none = await run(OLD_DIGEST);
      expect(none.removed).toEqual([]);
      expect(none.log).toContain(`The unused image node (${shape.id.slice(0, 19)}) stays: no registry confirms it (built on this engine, or the registry cannot be asked).`);
      // A container uses it: it stays.
      expect((await run(recordedDigest, [shape.id])).removed).toEqual([]);
    }
    // A tagged image with that evidence that its registry does not confirm stays: the rule is only for old versions.
    const tagged = engineOf([listed('sha256:n20', ['node:20']), listed('sha256:n18', ['node:18'], [`node@${recordedDigest}`])]);
    await pass(tagged.engine, async () => ({ references: ['node:20'], digests: { 'node:20': [recordedDigest] }, complete: true }), {
      registryTransport: registry({ tags: { 'library/node:20': digestOf('sha256:n20') }, unknown: [recordedDigest] }).transport,
      passes: 2,
    });
    expect(tagged.removed()).toEqual([]);
  });

  it('does nothing without references in use', async () => {
    const { engine, calls } = engineOf([listed('sha256:n18', ['node:18'])]);
    await pass(engine, []);
    expect(calls).toEqual([]);
  });
});

describe("the Monitor's registry answers", () => {
  it('keeps the digest of each tag in use that the registry confirmed, with the time of the pass', async () => {
    const { engine } = engineOf([]);
    const asked = registry({ tags: { 'library/node:20': DIGEST } });
    const written: Record<string, { digest: string; at: number }>[] = [];
    const maintenance = new ImageMaintenance({
      engine,
      registryTransport: asked.transport,
      log: () => undefined,
      referencesInUse: async () => ({ references: ['node:20', 'redis', `ghcr.io/acme/pinned@${DIGEST}`], complete: true }),
      replaced: { read: async () => ({}), write: async () => undefined },
      registryAnswers: { write: async (digests) => void written.push(digests) },
      now: () => 1_000,
    });
    await maintenance.pass();
    // node:20 confirmed; redis unknown to the registry (no answer); a pinned reference is never asked.
    expect(written).toEqual([{ 'node:20': { digest: DIGEST, at: 1_000 } }]);
  });
});
