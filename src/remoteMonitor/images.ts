// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The images of the Monitor on a remote Docker host (only in the remote scenario): it keeps the images in use
// up to date and removes the images of their repositories that nothing keeps. A pass is part a of the monitor's
// background run (background.ts), by the schedule of the setting cacheUpdateSchedule (its first check one minute after
// the start of the monitor, REMOTE_IMAGE_FIRST_PASS_MS).
//   1. The image tags in use (the image references of the build records of the devspaces on the engine, which each
//      open sends per computer; `monitor.js images -`, kept for IMAGES_IN_USE_MAX_AGE_MS) are pulled, anonymous
//      (`latest` as any other tag; a reference pinned by a digest is never pulled, it cannot change; a failed pull, a
//      private image, is one line of the log per pass). A tag that the engine has is pulled only when its registry has
//      another image of it and confirms the engine's, or an open recorded the engine's digest for the reference (never
//      over a build on the engine; pullDue). A registry host that does not answer is not asked again in the pass. The
//      registry is asked with the worker's registry client (imageCheck/registryClient.ts) over the HTTPS of the proxy
//      of the daemon (proxyTransport.ts), as the worker's image checks and the monitor's VS Code downloads.
//   2. What stays. The repositories that the monitor manages are those of the references in use; of them stays (a) the
//      image that each reference in use points to now, (b) every image that a container uses, running or stopped, and
//      (c) an image that another image is built on (a devspace image: its layers start with those of the other
//      one). Every other image of those repositories is removed, without force (only when its registry confirms one of
//      its digests, and an untagged one from the pass after the one that first saw it; an old version that came from a
//      pull also when its registry deleted it); an image of any other repository is never touched. A list or an inspect
//      that fails, or references in use that cannot be read, remove nothing in that pass.
// Every request to the engine goes over the Engine API (the port of engine.ts), each within its time limit; the pull
// without a login. Never throws; each problem is one line of the log.
import { RegistryClient, type DigestResult, type RegistryFailure } from '../core/imageCheck/registryClient';
import { parseImageReference as parseRegistryReference } from '../core/imageCheck/reference';
import type { HttpTransport } from '../core/http';
import { abortError } from '../core/ports';
import { isListedRepository, parseImageReference, type ImageReferenceParts } from '../core/remoteMonitor/protocol';
import { referenceText, type RegistryAnswer as TagAnswer } from '../core/remoteMonitor/registryAnswers';
import type { EngineImage } from '../core/worker/dockerEngine';
import { isNetworkError } from '../core/networkFailure';
import type { NetworkContact } from './backgroundRules';
import { engineFailure, type ImageEngine } from './engine';

/** Time from the start of the monitor to the first pass. */
export const REMOTE_IMAGE_FIRST_PASS_MS = 60_000;
/**
 * Time limits: of each request of a list or an inspect (IMAGE_LIST_TIMEOUT_MS), of a pull, and of the removal of one
 * version (all of its references).
 */
export const IMAGE_LIST_TIMEOUT_MS = 60_000;
export const IMAGE_PULL_TIMEOUT_MS = 60 * 60_000;
export const IMAGE_REMOVE_TIMEOUT_MS = 120_000;
/**
 * The time limit of each request to a registry (every request settles within it, also when the answer trickles or is
 * cut), applied to each request of the registry client (requestsWithin), the tunnel through the proxy included.
 */
export const REGISTRY_TIMEOUT_MS = 30_000;

/**
 * `transport` with the time limit `timeoutMs` on each request: its signal aborts at the limit, and the request rejects
 * with an AbortError then, also when the transport does not end on its signal; one that cannot start rejects.
 */
export function requestsWithin(transport: HttpTransport, timeoutMs: number): HttpTransport {
  return {
    request: (request, signal) => {
      const limit = AbortSignal.timeout(timeoutMs);
      const both = signal === undefined ? limit : AbortSignal.any([signal, limit]);
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(abortError());
        if (both.aborted) {
          onAbort();
          return;
        }
        both.addEventListener('abort', onAbort, { once: true });
        transport
          .request(request, both)
          .then(resolve, reject)
          .finally(() => both.removeEventListener('abort', onAbort));
      });
    },
  };
}

/** One image of a repository, as one row of `docker image ls` showed it. */
export interface LocalImage {
  repository: string;
  /** `<none>` for an image of the repository without a tag of it. */
  tag: string;
  id: string;
  /** Creation time (RFC 3339: the list of the engine, or the inspect of an image); compared as a time (createdTime). */
  createdAt: string;
}

/** A tag as the Docker reference grammar allows it. */
const TAG = /^[\w][\w.-]{0,127}$/;

/**
 * The rows of `docker image ls -a` (the Docker CLI's formatter), from the images of the list of the engine: a row per
 * repository and tag of an image (its `repository:tag` references), and a row with the tag `<none>` per repository of
 * which it has only a digest (`repository@sha256:…`, an image that a pull replaced on the classic image store). An
 * image without any reference (a `<none> <none>` row) has none. The list without `all`: the engine then
 * leaves out only intermediate images without a reference (the parents of the classic builder's images), which have no
 * row of a repository either.
 */
export function localImagesOf(images: readonly EngineImage[]): LocalImage[] {
  const rows: LocalImage[] = [];
  for (const image of images) {
    const tagged = new Set<string>();
    for (const reference of image.repoTags) {
      const colon = reference.lastIndexOf(':');
      // Only `repository:tag` (the colon of a registry port comes before the last slash).
      if (colon <= reference.lastIndexOf('/') || !TAG.test(reference.slice(colon + 1))) continue;
      const repository = reference.slice(0, colon);
      tagged.add(repository);
      rows.push({ repository, tag: reference.slice(colon + 1), id: image.id, createdAt: image.created });
    }
    const digestOnly = new Set<string>();
    for (const reference of image.repoDigests) {
      const at = reference.indexOf('@');
      if (at <= 0) continue;
      const repository = reference.slice(0, at);
      if (tagged.has(repository) || digestOnly.has(repository)) continue;
      digestOnly.add(repository);
      rows.push({ repository, tag: '<none>', id: image.id, createdAt: image.created });
    }
  }
  return rows;
}

/** One image of a repository: an image ID with its tags there (none: it has only a digest of it, or was replaced). */
export interface ImageVersion {
  id: string;
  tags: string[];
}

/**
 * The images of one repository, one per ID, in the order of the rows. They have no order of versions: what stays
 * follows the references in use.
 */
export function imagesById(images: readonly LocalImage[]): ImageVersion[] {
  const byId = new Map<string, ImageVersion>();
  for (const image of images) {
    const entry = byId.get(image.id) ?? { id: image.id, tags: [] };
    byId.set(image.id, entry);
    if (image.tag !== '<none>' && !entry.tags.includes(image.tag)) entry.tags.push(image.tag);
  }
  return [...byId.values()];
}

// referenceText, the reference of an image reference in use that the engine pulls and inspects; it lives in the core
// (registryAnswers.ts), where the open looks up the monitor's registry answers by it.
export { referenceText };

export interface ImageMaintenanceDeps {
  /** The engine over the Engine API (engine.ts), not the Docker CLI. */
  engine: ImageEngine;
  /**
   * The HTTPS of the registry requests, made afresh for each pass (the monitor's: the proxy of the daemon, read once
   * per transport, so a failed read or a changed proxy counts only for that pass).
   */
  registryTransport: () => HttpTransport;
  log: (message: string) => void;
  /**
   * The image references in use on the engine (the union of what the computers sent within IMAGES_IN_USE_MAX_AGE_MS),
   * as the configurations write them; `complete` false when a stored list could not be read (then nothing is removed in
   * the pass). Without it: none.
   */
  referencesInUse?: () => Promise<ReferencesInUse>;
  /**
   * The IDs that were seen as images of a repository, by repository, kept in the volume.
   * The image that a pull replaces loses its tag, and the list of the images shows it without its repository (the
   * containerd image store; `docker image ls` of the CLI 29 showed it not at all without `-a`), so without these IDs no
   * older version would ever be removed. Every ID that a pass sees with a tag of the repository, not only
   * those that the monitor's own pull replaced (the update of the extension at each open, or a user, pulls too). Without
   * it: kept for the pass.
   */
  replaced?: { read(): Promise<ReplacedImages>; write(value: ReplacedImages): Promise<void> };
  /**
   * Of the IDs of `replaced`, those that the monitor's own pull replaced (the image that its tag pointed to before the
   * pull), by repository, kept in the volume beside them: the evidence that such an image came from a registry, so an
   * old version that the registry deleted meanwhile can go too. Trimmed as `replaced`, and only IDs that `replaced`
   * still has. Without it: kept for the life of the monitor.
   */
  pulledOver?: { read(): Promise<ReplacedImages>; write(value: ReplacedImages): Promise<void> };
  /**
   * The answers of the registry to the pass for the tags in use (by referenceText), written after the pulls of the tags
   * in use; the open uses them while they are fresh (src/core/remoteMonitor/registryAnswers.ts). Without it: not kept.
   */
  registryAnswers?: { write(digests: Record<string, TagAnswer>): Promise<void> };
  /** The clock of the answers (ms); Date.now without it. */
  now?: () => number;
}

/** Image IDs that a pull replaced, by repository. */
export type ReplacedImages = Record<string, string[]>;

/** The image references in use as the monitor read them (ImageMaintenanceDeps.referencesInUse). */
export interface ReferencesInUse {
  references: string[];
  /**
   * The digests that the opens recorded for references (`buildRecord.images`: read from the registry right before a
   * build), reference → digests; the evidence that an image of the engine came from the registry.
   */
  digests?: Record<string, string[]>;
  complete: boolean;
}

/** The references in use of a pass, parsed and each once. */
interface InUse {
  references: ImageReferenceParts[];
  /** The recorded digests, by the reference as the engine pulls it (referenceText). */
  recorded: Map<string, Set<string>>;
  complete: boolean;
}

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * The answer of a registry to the request of a manifest by its digest: `confirmed` (it has it), `absent` (a definite
 * answer that it does not: 404, or 401/403 to the anonymous request, as the registry client reports them, `notFound`
 * and `authRequired`), or `unknown` (it could not be asked: no answer, no answer in time, a 5xx, a host skipped in the
 * pass, or another answer).
 */
type RegistryAnswer = 'confirmed' | 'absent' | 'unknown';

/** The fields of the inspect JSON of an image (as `docker image inspect`) that the maintenance reads. */
interface InspectedImage {
  Id?: unknown;
  RepoTags?: unknown;
  /**
   * The `<name>@<digest>` references of the image. No evidence that a registry has the image: the containerd image
   * store gives every tagged image one (the digest of its local index), also one that was built on the engine and never
   * pushed; only the registry can confirm it (RegistryConfirmation).
   */
  RepoDigests?: unknown;
  Created?: unknown;
  RootFS?: { Layers?: unknown } | null;
}

/** The `<name>@sha256:<hex>` entries of RepoDigests of an inspect, as name and digest. */
function repoDigestsOf(inspected: InspectedImage): Array<{ name: string; digest: string }> {
  if (!Array.isArray(inspected.RepoDigests)) return [];
  const result: Array<{ name: string; digest: string }> = [];
  for (const entry of inspected.RepoDigests) {
    if (typeof entry !== 'string') continue;
    const at = entry.lastIndexOf('@');
    const digest = entry.slice(at + 1);
    if (at > 0 && /^sha256:[0-9a-f]{64}$/.test(digest)) result.push({ name: entry.slice(0, at), digest });
  }
  return result;
}
/**
 * At most this many IDs are kept per repository; beyond it the IDs that are tagged now go first (the listing finds them
 * again), then the oldest untagged ones (trimReplaced).
 */
const MAX_REPLACED_PER_REPOSITORY = 200;

/** Trims the IDs of a repository to MAX_REPLACED_PER_REPOSITORY: tagged ones first, then the oldest. */
function trimReplaced(ids: string[], tagged: ReadonlySet<string>): string[] {
  const result = [...ids];
  while (result.length > MAX_REPLACED_PER_REPOSITORY) {
    const index = result.findIndex((id) => tagged.has(id));
    result.splice(index >= 0 ? index : 0, 1);
  }
  return result;
}
const IMAGE_ID = /^[A-Za-z0-9:]{1,100}$/;

/** The stored replaced IDs; an empty record for anything invalid. */
export function parseReplacedImages(text: string): ReplacedImages {
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    const result: ReplacedImages = {};
    for (const [repository, ids] of Object.entries(value)) {
      // Any repository as the engine lists it (those of Docker Hub too, which a reference in use can name).
      if (isListedRepository(repository) && Array.isArray(ids)) result[repository] =ids.filter((id): id is string => typeof id === 'string' && IMAGE_ID.test(id)).slice(-MAX_REPLACED_PER_REPOSITORY);
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * The stored IDs without the repositories that keep none. A new record; the given one is not changed. Every other
 * repository stays, also one that the current pass does not manage: on a shared engine the images in use change between
 * computers, and the replaced images of the others would otherwise be left on the disk for ever.
 */
export function pruneReplacedImages(replaced: ReplacedImages): ReplacedImages {
  const result: ReplacedImages = {};
  for (const [repository, ids] of Object.entries(replaced)) {
    if (ids.length > 0) result[repository] = ids;
  }
  return result;
}

/** The passes of the image maintenance. */
export class ImageMaintenance {
  private replaced: ReplacedImages = {};
  /** The IDs that the monitor's own pull replaced, by repository. */
  private pulledOver: ReplacedImages = {};
  /** The digests that the opens recorded, by repository, of the pass. */
  private recordedByRepository = new Map<string, Set<string>>();
  /** The registry client of the current pass (anonymous; see `pass`). */
  private registry: RegistryClient | undefined;
  /**
   * The digests that the registry of their name confirmed or did not confirm in the current pass (`<name>@<digest>` →
   * true when the registry has that manifest), so each is asked once per pass.
   */
  private confirmations = new Map<string, Promise<RegistryAnswer>>();
  /**
   * The untagged images (old versions) that a pass saw; one is removed only when an earlier pass of this monitor saw it
   * untagged already, so a pull replaces an image at least one pass before its removal (a build that resolved the old
   * ID a moment before keeps its base). In memory: after a start of the monitor, its first pass removes no untagged
   * image.
   */
  private seenUntagged = new Set<string>();
  private untaggedNow = new Set<string>();
  /**
   * The registry hosts that did not answer in the current pass (`unreachable`: no connection, no answer in time, a
   * 5xx); each is not asked again in that pass (one line of the log), so a registry that does not answer cannot stretch
   * a pass by the time limit of every request.
   */
  private unreachable = new Set<string>();
  /** A pull of the current pass failed for the network (isNetworkError). */
  private pullOffline = false;
  /** A registry answered in the current pass, or a pull of it succeeded. */
  private reachedRegistry = false;
  private skipLogged = new Set<string>();

  constructor(private readonly deps: ImageMaintenanceDeps) {}

  /**
   * The references in use, parsed (parseImageReference) and each once; an invalid one is left out. Never throws: a
   * failed read is none, and not complete.
   */
  private async inUse(): Promise<InUse> {
    let read: ReferencesInUse;
    try {
      read = this.deps.referencesInUse === undefined ? { references: [], complete: true } : await this.deps.referencesInUse();
    } catch (error) {
      this.deps.log(`The images in use could not be read: ${error instanceof Error ? error.message : String(error)}`);
      return { references: [], recorded: new Map(), complete: false };
    }
    const references = new Map<string, ImageReferenceParts>();
    const recorded = new Map<string, Set<string>>();
    for (const text of read.references) {
      const parts = parseImageReference(text);
      if (parts === undefined) continue;
      const key = referenceText(parts);
      references.set(key, parts);
      // `node:20` and `docker.io/library/node:20` are one reference, with the digests of both.
      const digests = (read.digests?.[text] ?? []).filter((digest) => SHA256_DIGEST.test(digest));
      if (digests.length > 0) recorded.set(key, new Set([...(recorded.get(key) ?? []), ...digests]));
    }
    return { references: [...references.values()], recorded, complete: read.complete };
  }

  /**
   * Whether the monitor manages the images of a repository: one of a reference in use. It never touches an image of any
   * other repository.
   */
  private managedBy(inUse: InUse): (repository: string) => boolean {
    const used = new Set(inUse.references.map((parts) => parts.repository));
    return (repository) => used.has(repository);
  }

  /**
   * One pass: the pulls of the references in use, then the removal of the images that nothing keeps. Never throws.
   * Resolves what it found of the network (NetworkContact): `reached` when a registry answered or a pull succeeded;
   * else `offline` when a registry that it asked did not answer (`unreachable`) or a pull failed for the network
   * (isNetworkError); else `none` (also without images in use). A failure of the engine itself (a list, an inspect) is
   * none of the network.
   */
  async pass(): Promise<NetworkContact> {
    this.unreachable = new Set();
    this.pullOffline = false;
    this.reachedRegistry = false;
    await this.passOnce();
    if (this.reachedRegistry) return 'reached';
    return this.unreachable.size > 0 || this.pullOffline ? 'offline' : 'none';
  }

  private async passOnce(): Promise<void> {
    const inUse = await this.inUse();
    if (inUse.references.length === 0) return;
    try {
      // The worker's registry client, anonymous (no credentials), each request within REGISTRY_TIMEOUT_MS; its warnings
      // go to the log.
      const log = (message: string) => this.deps.log(message);
      this.registry = new RegistryClient(requestsWithin(this.deps.registryTransport(), REGISTRY_TIMEOUT_MS), async () => undefined, {
        info: log,
        warn: log,
        error: log,
        output: () => {},
      });
      this.confirmations = new Map();
      this.skipLogged = new Set();
      this.untaggedNow = new Set();
      if (this.deps.replaced) this.replaced = await this.deps.replaced.read();
      if (this.deps.pulledOver) this.pulledOver = await this.deps.pulledOver.read();
      // The digests that the opens recorded, by repository.
      this.recordedByRepository = new Map();
      for (const parts of inUse.references) {
        const recorded = inUse.recorded.get(referenceText(parts));
        if (recorded !== undefined) this.recordedByRepository.set(parts.repository, new Set([...(this.recordedByRepository.get(parts.repository) ?? []), ...recorded]));
      }
      const managed = this.managedBy(inUse);
      await this.remember(await this.repositories(managed));
      // The references whose image stays (rule a), and those pulled in this pass (each once).
      const keep: string[] = [];
      const pulled = new Set<string>();
      // Each tag in use, anonymous; never one pinned by a digest. The registry's digest of each tag in use is asked
      // first (one anonymous HEAD request, which does not count against the pull limit of Docker Hub), kept as the
      // answer for the opens, and decides the pull.
      const answers: Record<string, TagAnswer> = {};
      for (const parts of inUse.references) {
        const reference = referenceText(parts);
        keep.push(reference);
        if (parts.digest !== undefined) continue;
        const current = await this.currentDigest(parts.repository, reference);
        if (current?.kind === 'digest') answers[reference] = { digest: current.digest, at: (this.deps.now ?? Date.now)() };
        if (pulled.has(reference)) continue;
        pulled.add(reference);
        if (!(await this.pullDue(parts.repository, reference, inUse.recorded.get(reference) ?? new Set(), current))) continue;
        await this.pull(parts.repository, reference);
      }
      await this.deps.registryAnswers?.write(answers).catch((error: unknown) => this.deps.log(`The registry answers could not be kept: ${error instanceof Error ? error.message : String(error)}`));
      const after = await this.repositories(managed);
      await this.remember(after);
      for (const repository of Object.keys(this.replaced)) {
        if (!after.has(repository) && managed(repository)) after.set(repository, []);
      }
      if (after.size === 0) return;
      // When in doubt, an image stays: references in use that could not be read, or an image of a reference that could
      // not be inspected, remove nothing in this pass.
      if (!inUse.complete) {
        this.deps.log('No image is removed in this pass: the images in use could not be read.');
        return;
      }
      const kept = await this.keptIds(keep);
      if (kept === undefined) return;
      const layers = await this.layersById();
      // An ID can be an image of two repositories; one that a rule keeps is removed by none of them.
      const all = new Map<string, LocalImage[]>();
      for (const [repository, images] of after) all.set(repository, [...images, ...(await this.replacedImages(repository, images))]);
      for (const [repository, images] of all) await this.clean(repository, images, layers, kept);
      // The untagged images of this pass are the ones that the next pass may remove.
      this.seenUntagged = this.untaggedNow;
    } catch (error) {
      this.deps.log(`The images could not be maintained: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      // No empty lists (the other repositories stay: pruneReplacedImages).
      this.replaced = pruneReplacedImages(this.replaced);
      await this.deps.replaced?.write(this.replaced).catch(() => undefined);
      // Only the IDs that the store of replaced IDs still has.
      this.pulledOver = pruneReplacedImages(Object.fromEntries(Object.entries(this.pulledOver).map(([repository, ids]) => [repository, ids.filter((id) => (this.replaced[repository] ?? []).includes(id))])));
      await this.deps.pulledOver?.write(this.pulledOver).catch(() => undefined);
    }
  }

  /**
   * Keeps the IDs that carry a tag of a repository now, and writes the store at once (a monitor that ends in the middle
   * of a pass loses nothing).
   */
  async remember(images: ReadonlyMap<string, readonly LocalImage[]>): Promise<void> {
    let changed = false;
    for (const [repository, list] of images) {
      const tagged = new Set(list.filter((image) => image.tag !== '<none>').map((image) => image.id));
      for (const id of tagged) {
        if ((this.replaced[repository] ?? []).includes(id)) continue;
        this.replaced[repository] = [...(this.replaced[repository] ?? []), id];
        changed = true;
      }
      this.replaced[repository] = trimReplaced(this.replaced[repository] ?? [], tagged);
    }
    if (changed) await this.deps.replaced?.write(this.replaced).catch(() => undefined);
  }

  /**
   * Remembers the IDs that carry a tag of a repository now, between the passes too (the
   * schedule calls it every minute; one list of the images), so an image that the extension pulls at an open and
   * replaces at the next one before a pass is known. Never throws.
   */
  async observe(): Promise<void> {
    // Only the repositories of the references in use.
    const inUse = await this.inUse();
    if (inUse.references.length === 0) return;
    try {
      if (this.deps.replaced) this.replaced = await this.deps.replaced.read();
      await this.remember(await this.repositories(this.managedBy(inUse)));
    } catch {
      // The next minute or pass tries again.
    }
  }

  /**
   * The inspect JSON of an image (as `docker image inspect`), within the time limit of a list; undefined when it does
   * not exist or cannot be read (the engine does not answer).
   */
  private async inspectImage(reference: string): Promise<InspectedImage | undefined> {
    try {
      return (await this.deps.engine.inspect('image', reference, AbortSignal.timeout(IMAGE_LIST_TIMEOUT_MS))) as InspectedImage | undefined;
    } catch {
      return undefined;
    }
  }

  /** The ID of an image reference, or undefined. */
  private async imageId(reference: string): Promise<string | undefined> {
    const id = (await this.inspectImage(reference))?.Id;
    return typeof id === 'string' && IMAGE_ID.test(id) ? id : undefined;
  }

  /**
   * The stored replaced IDs of `repository` that still exist without any tag, as untagged images of it; the others are
   * forgotten (removed, or tagged again). An image whose inspect fails is forgotten too.
   */
  private async replacedImages(repository: string, listed: readonly LocalImage[]): Promise<LocalImage[]> {
    const ids = (this.replaced[repository] ?? []).filter((id) => !listed.some((image) => image.id === id));
    const result: LocalImage[] = [];
    const kept: string[] = [];
    for (const id of ids) {
      const inspected = await this.inspectImage(id);
      // Untagged: RepoTags `[]` or null (as `{{json .RepoTags}}` printed them); a time of its creation as text.
      const tags = inspected?.RepoTags;
      const created = inspected?.Created;
      if (typeof created !== 'string' || !(tags === null || (Array.isArray(tags) && tags.length === 0))) continue;
      kept.push(id);
      result.push({ repository, tag: '<none>', id, createdAt: created });
    }
    // In the order they were seen (the oldest first), so the trim keeps the newest.
    this.replaced[repository] = (this.replaced[repository] ?? []).filter((id) => kept.includes(id) || listed.some((image) => image.id === id));
    return result;
  }

  /** The images of the repositories that the monitor manages (managedBy), by repository. */
  private async repositories(managed: (repository: string) => boolean): Promise<Map<string, LocalImage[]>> {
    // With the untagged images (`<repository> <none>`): the list of the engine has them, as rows of `docker image ls
    // -a` (localImagesOf).
    let listed: EngineImage[];
    try {
      listed = await this.deps.engine.images({}, AbortSignal.timeout(IMAGE_LIST_TIMEOUT_MS));
    } catch (error) {
      throw new Error(`the list of the images failed: ${engineFailure(error, IMAGE_LIST_TIMEOUT_MS)}`);
    }
    const byRepository = new Map<string, LocalImage[]>();
    for (const image of localImagesOf(listed)) {
      if (!managed(image.repository)) continue;
      const list = byRepository.get(image.repository) ?? [];
      list.push(image);
      byRepository.set(image.repository, list);
    }
    return byRepository;
  }

  /**
   * Whether a tag in use is pulled (RepoDigests alone are no evidence: see InspectedImage). A tag that the engine does
   * not have is pulled. For one that it has, the registry decides,
   * anonymously, with manifest requests (HEAD; they do not count against the pull limit of Docker Hub):
   *   - the registry does not know the tag, or cannot be asked: no pull (logged);
   *   - its digest of the tag is one of the image's RepoDigests of the repository: unchanged, no pull;
   *   - the registry confirms none of the image's digests of the repository: a build on this engine under that name,
   *     which a pull would replace with the image of the registry (the build would then go as an untagged image): no
   *     pull (logged);
   *   - otherwise the pull.
   * An inspect that fails: no pull in this pass (logged). An image not pulled stays by rule a.
   */
  private async pullDue(repository: string, reference: string, recorded: ReadonlySet<string>, current: DigestResult | RegistryFailure | undefined): Promise<boolean> {
    let inspected: InspectedImage | undefined;
    try {
      inspected = (await this.deps.engine.inspect('image', reference, AbortSignal.timeout(IMAGE_LIST_TIMEOUT_MS))) as InspectedImage | undefined;
    } catch (error) {
      this.deps.log(`${reference} is not pulled in this pass: its image could not be inspected: ${engineFailure(error, IMAGE_LIST_TIMEOUT_MS)}`);
      return false;
    }
    if (inspected === undefined || inspected === null) return true;
    if (current === undefined || current.kind !== 'digest') {
      this.deps.log(`${reference} is not pulled in this pass: its registry ${current === undefined ? 'cannot be asked' : `does not confirm the tag (${registryFailureText(current)})`}; the image on the engine stays.`);
      return false;
    }
    const own = repoDigestsOf(inspected).filter((entry) => entry.name === repository);
    // Unchanged: the registry's digest is one of the image's, or its ID (the containerd store: the ID of an image is the
    // digest of its index or manifest).
    if (own.some((entry) => entry.digest === current.digest) || inspected.Id === current.digest) return false;
    // The image came from the registry when an open recorded its digest (its ID on the
    // containerd store, one of its RepoDigests of the repository on both stores) for the reference, read from the
    // registry right before a build; also when the registry no longer has that manifest (a cleanup of untagged versions,
    // a lifecycle rule, a garbage collection).
    if ((typeof inspected.Id === 'string' && recorded.has(inspected.Id)) || own.some((entry) => recorded.has(entry.digest))) return true;
    for (const entry of own) if (await this.confirmed(entry.name, entry.digest)) return true;
    this.deps.log(`${reference} is not pulled: its registry does not have the image on the engine (removed there, or built on this engine); it stays.`);
    return false;
  }

  /**
   * The registry's digest of the tag `reference` of `repository` (anonymous; asked before pullDue, which decides by
   * it), or undefined when the repository has no registry that can be asked.
   */
  private async currentDigest(repository: string, reference: string): Promise<DigestResult | RegistryFailure | undefined> {
    const target = registryTarget(repository);
    const registry = this.registry;
    if (target === undefined || registry === undefined) return undefined;
    const tag = reference.slice(repository.length + 1);
    return this.ask(target.registry, () => registry.getDigest({ original: reference, ...target, tag }));
  }

  /**
   * A request of the registry client to the registry host `host`, unless that host did
   * not answer before in this pass (then `unreachable` without a request; one line of the log per host and pass).
   */
  private async ask<T extends { kind: string }>(host: string, request: () => Promise<T>): Promise<T | RegistryFailure> {
    if (this.unreachable.has(host)) {
      if (!this.skipLogged.has(host)) {
        this.skipLogged.add(host);
        this.deps.log(`The registry ${host} did not answer; it is not asked again in this pass.`);
      }
      return { kind: 'unreachable', registry: host, error: 'it did not answer before in this pass' };
    }
    const result = await request();
    if (result.kind === 'unreachable') this.unreachable.add(host);
    else this.reachedRegistry = true;
    return result;
  }

  /**
   * Whether the registry of `name` has the manifest `digest` (an anonymous HEAD of
   * `<name>@<digest>` that answers it); asked once per pass. Any other answer, a failure or no answer in time: false.
   */
  private async confirmed(name: string, digest: string): Promise<boolean> {
    return (await this.registryAnswer(name, digest)) === 'confirmed';
  }

  /** The answer of the registry of `name` for the manifest `digest` (RegistryAnswer); asked once per pass. */
  private registryAnswer(name: string, digest: string): Promise<RegistryAnswer> {
    const key = `${name}@${digest}`;
    let answer = this.confirmations.get(key);
    if (answer === undefined) {
      const target = registryTarget(name);
      const registry = this.registry;
      // The digest in place of the tag: the request of the manifest by its digest.
      answer =
        target === undefined || registry === undefined
          ? Promise.resolve<RegistryAnswer>('unknown')
          : this.ask(target.registry, () => registry.getDigest({ original: key, ...target, tag: digest })).then(
              (result): RegistryAnswer =>
                result.kind === 'digest' ? (result.digest === digest ? 'confirmed' : 'unknown') : result.kind === 'notFound' || result.kind === 'authRequired' ? 'absent' : 'unknown',
              (): RegistryAnswer => 'unknown',
            );
      this.confirmations.set(key, answer);
    }
    return answer;
  }

  /**
   * Whether the registry confirms one of the RepoDigests of an inspect, or `byId`, the ID of an untagged image of
   * `repository` that is a digest. `absent` only when every digest that was asked got a definite answer that the
   * registry does not have it (and at least one was asked); else `unknown`.
   */
  private async inRegistry(inspected: InspectedImage, repository: string, byId: string | undefined): Promise<RegistryAnswer> {
    const asked = [...repoDigestsOf(inspected), ...(byId !== undefined ? [{ name: repository, digest: byId }] : [])];
    let definite = asked.length > 0;
    for (const entry of asked) {
      const answer = await this.registryAnswer(entry.name, entry.digest);
      if (answer === 'confirmed') return 'confirmed';
      if (answer === 'unknown') definite = false;
    }
    return definite ? 'absent' : 'unknown';
  }

  /**
   * Pulls `reference` of `repository`, a tag in use; false when the pull failed (logged).
   */
  private async pull(repository: string, reference: string): Promise<boolean> {
    const before = await this.imageId(reference);
    // The pull of the engine without a login (anonymous); an error in its stream fails it.
    try {
      await this.deps.engine.pull(reference, { signal: AbortSignal.timeout(IMAGE_PULL_TIMEOUT_MS) });
      this.reachedRegistry = true;
    } catch (error) {
      if (isNetworkError(error)) this.pullOffline = true;
      this.deps.log(`${reference} could not be pulled: ${engineFailure(error, IMAGE_PULL_TIMEOUT_MS)}`);
      return false;
    }
    // The image that the pull replaced, also when Docker lists it without its repository.
    const now = await this.imageId(reference);
    if (before !== undefined && now !== undefined && before !== now) {
      this.replaced[repository] = trimReplaced([...(this.replaced[repository] ?? []).filter((id) => id !== before), before], new Set([now]));
      await this.deps.replaced?.write(this.replaced).catch(() => undefined);
      // The evidence that this old version came from a registry.
      this.pulledOver[repository] = trimReplaced([...(this.pulledOver[repository] ?? []).filter((id) => id !== before), before], new Set([now]));
      await this.deps.pulledOver?.write(this.pulledOver).catch(() => undefined);
    }
    return true;
  }

  /**
   * The IDs of the images that `references` point to now (rule a); one
   * that does not exist keeps nothing. Undefined (logged) when an inspect fails: then nothing is removed in the pass.
   */
  private async keptIds(references: readonly string[]): Promise<Set<string> | undefined> {
    const kept = new Set<string>();
    for (const reference of new Set(references)) {
      let inspected: InspectedImage | undefined;
      try {
        inspected = (await this.deps.engine.inspect('image', reference, AbortSignal.timeout(IMAGE_LIST_TIMEOUT_MS))) as InspectedImage | undefined;
      } catch (error) {
        this.deps.log(`No image is removed in this pass: the image of ${reference} could not be inspected: ${engineFailure(error, IMAGE_LIST_TIMEOUT_MS)}`);
        return undefined;
      }
      if (inspected === undefined || inspected === null) continue;
      if (typeof inspected.Id !== 'string' || !IMAGE_ID.test(inspected.Id)) {
        this.deps.log(`No image is removed in this pass: the image of ${reference} has no valid ID.`);
        return undefined;
      }
      kept.add(inspected.Id);
    }
    return kept;
  }

  /**
   * The layers of every image of the engine, by ID; undefined when they cannot be read.
   * Docker removes the tag of an image that another image is built on (a devspace image) and keeps the image, so
   * the maintenance itself leaves such an image alone.
   */
  private async layersById(): Promise<Map<string, string[]> | undefined> {
    // The IDs of the list of the engine (as `docker image ls -a -q`; without
    // `all`, an intermediate image of the classic builder is left out, while the image built on it, whose layers start
    // with the same ones, is listed), then the inspect of each (as `docker image inspect` of chunks of IDs).
    let ids: string[];
    try {
      ids = [...new Set((await this.deps.engine.images({}, AbortSignal.timeout(IMAGE_LIST_TIMEOUT_MS))).map((image) => image.id).filter((id) => IMAGE_ID.test(id)))];
    } catch {
      return undefined;
    }
    const byId = new Map<string, string[]>();
    for (const id of ids) {
      const inspected = await this.inspectImage(id);
      // An image removed meanwhile, or an engine that does not answer: nothing is removed in this pass.
      if (inspected === undefined) return undefined;
      const layers = inspected.RootFS?.Layers;
      if (Array.isArray(layers) && layers.every((layer) => typeof layer === 'string')) byId.set(typeof inspected.Id === 'string' ? inspected.Id : id, layers as string[]);
    }
    return byId;
  }

  /**
   * Removes every image of a managed repository that no rule keeps: not one of `kept` (rule a), no container uses it
   * (b), and no other image is
   * built on it (c: its layers are the start of the layers of another image). `layers` undefined: nothing is removed.
   * Never with force; only one that a pull can bring back (its registry confirms one of its digests); by its references
   * in this repository, by its ID only when no repository names it.
   */
  private async clean(repository: string, images: readonly LocalImage[], layers: Map<string, string[]> | undefined, kept: ReadonlySet<string>): Promise<void> {
    for (const version of imagesById(images)) {
      if (kept.has(version.id)) continue;
      const label = version.tags.length > 0 ? version.tags.join(', ') : version.id.slice(0, 19);
      // An untagged image only from the pass after the one that first saw it untagged.
      if (version.tags.length === 0) {
        this.untaggedNow.add(version.id);
        if (!this.seenUntagged.has(version.id)) {
          this.deps.log(`The unused image ${repository} (${label}) stays until the next pass: it was replaced only now.`);
          continue;
        }
      }
      const own = layers?.get(version.id);
      if (!layers || !own) {
        this.deps.log(`The unused image ${repository} (${label}) stays: its layers could not be read.`);
        continue;
      }
      const builtOn = [...layers].some(([id, other]) => id !== version.id && other.length > own.length && own.every((layer, index) => other[index] === layer));
      if (builtOn) {
        this.deps.log(`The unused image ${repository} (${label}) stays: another image is built on it.`);
        continue;
      }
      // The containers of the image or of one built on it, stopped ones
      // included (as `docker ps -a -q --filter ancestor=<id>`); one, or a list that fails, keeps it.
      let users: string[];
      try {
        users = await this.deps.engine.containerIds({ ancestor: [version.id] }, AbortSignal.timeout(IMAGE_LIST_TIMEOUT_MS));
      } catch {
        continue;
      }
      if (users.length > 0) continue;
      // By its references in this repository, then by its ID when no reference is left; never with force.
      const references = version.tags.map((tag) => `${repository}:${tag}`);
      // Never an image of another repository: by its ID only while the engine names it by no tag at all (an image with
      // only a digest of this repository may carry a tag of another).
      const inspected = await this.inspectImage(version.id);
      if (inspected === undefined) {
        this.deps.log(`The unused image ${repository} (${label}) stays: it could not be inspected.`);
        continue;
      }
      if (references.length === 0) {
        const tags = inspected.RepoTags;
        if (!(tags === null || (Array.isArray(tags) && tags.length === 0))) {
          this.deps.log(`The unused image ${repository} (${label}) stays: a tag of another repository names it.`);
          continue;
        }
      }
      // An image is removed only when a pull can bring it back: the registry of one of its RepoDigests confirms that
      // digest (the containerd image store gives a local build a digest too). One built on this engine and never pushed
      // (`myapp:dev2`, or the previous build of a tag built again), or one whose registry cannot be asked, stays. On
      // the containerd store, the image that a pull replaced is untagged without any RepoDigests entry, and its ID is
      // the digest of its index or manifest: the registry of the repository confirms that one. On the classic store the
      // ID is the digest of its configuration, which no registry answers (it keeps its RepoDigests entry there).
      const byId = references.length === 0 && typeof inspected.Id === 'string' && SHA256_DIGEST.test(inspected.Id) ? inspected.Id : undefined;
      const answer = await this.inRegistry(inspected, repository, byId);
      if (answer !== 'confirmed') {
        // An old version (untagged, seen untagged at an earlier pass, no container, no image built on it: the rules
        // above) that came from a registry goes also when the registry no longer has it (a cleanup of untagged
        // versions, a lifecycle rule, a garbage collection); without that evidence it may be a build on this engine,
        // and it stays. Only on a definite answer of the registry (`absent`): one that could not be asked keeps it in
        // this pass.
        if (answer === 'absent' && references.length === 0 && this.cameFromPull(repository, inspected)) {
          const failure = await this.removeReferences([version.id]);
          if (failure === undefined) this.deps.log(`Removed the old version ${repository} (${label}) (its registry no longer has it; it came from a pull).`);
          else this.deps.log(`The unused image ${repository} (${label}) stays: ${failure}`);
          continue;
        }
        this.deps.log(`The unused image ${repository} (${label}) stays: no registry confirms it (built on this engine, or the registry cannot be asked).`);
        continue;
      }
      const failure = await this.removeReferences(references.length > 0 ? references : [version.id]);
      if (failure === undefined) this.deps.log(`Removed the unused image ${repository} (${label}).`);
      else this.deps.log(`The unused image ${repository} (${label}) stays: ${failure}`);
    }
  }

  /**
   * The evidence that an image of `repository` came from a registry:
   * (a) the monitor's own pull replaced it (pulledOver), or (b) its ID (the containerd store) or one of its RepoDigests of
   * the repository (both stores) is a digest that an open recorded for a reference of the repository.
   */
  private cameFromPull(repository: string, inspected: InspectedImage): boolean {
    const id = typeof inspected.Id === 'string' ? inspected.Id : '';
    if ((this.pulledOver[repository] ?? []).includes(id)) return true;
    const recorded = this.recordedByRepository.get(repository);
    if (recorded === undefined) return false;
    return recorded.has(id) || repoDigestsOf(inspected).some((entry) => entry.name === repository && recorded.has(entry.digest));
  }

  /**
   * `docker image rm <references…>` over the Engine API: one DELETE of each
   * reference without force (the engine removes the untagged parents with it, as the CLI asks), each tried even after a
   * refusal, all within one time limit. Undefined when the engine removed every one; else the reason of the first that it
   * did not remove, as the first line of the CLI's errors: an image in use (409) or one that is gone (404) is an answer of
   * the engine (removeImage), any other failure its message.
   */
  private async removeReferences(references: readonly string[]): Promise<string | undefined> {
    const signal = AbortSignal.timeout(IMAGE_REMOVE_TIMEOUT_MS);
    let failure: string | undefined;
    for (const reference of references) {
      let reason: string | undefined;
      try {
        const outcome = await this.deps.engine.removeImage(reference, signal);
        if (outcome === 'inUse') reason = `${reference} is in use (a container, or an image built on it); the engine answered 409.`;
        else if (outcome === 'missing') reason = `No such image: ${reference}`;
      } catch (error) {
        reason = engineFailure(error, IMAGE_REMOVE_TIMEOUT_MS);
      }
      failure ??= reason;
    }
    return failure;
  }

}

/**
 * The registry host and the path of a repository as the engine lists it, for the requests of
 * the registry client (Docker Hub `registry-1.docker.io`, its official images under `library/`); undefined for none.
 */
function registryTarget(repository: string): { registry: string; repository: string } | undefined {
  const parsed = parseRegistryReference(repository);
  return parsed === undefined || parsed.digest !== undefined ? undefined : { registry: parsed.registry, repository: parsed.repository };
}

/** The reason of a registry answer that is no digest, for the log. */
function registryFailureText(failure: RegistryFailure): string {
  switch (failure.kind) {
    case 'authRequired':
      return 'the registry asks for a sign-in';
    case 'notFound':
      return 'HTTP 404';
    case 'unreachable':
    case 'error':
      return failure.error;
  }
}
