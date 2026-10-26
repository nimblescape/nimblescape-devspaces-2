// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The helper image on the engine of an operation, apart from the steps of the workspace helper (workspaceHelper.ts),
// which run in the worker on the worker's own image. The extension prepares it for the bootstrap (the image of the
// worker and of the Monitor): it is checked, and built when its tag is missing. The maintenance of
// ensureImageUse (the rebuild that a check of its base image asked for, the weekly check, the removal of old helper
// images) runs in the extension's preparation of the worker for an operation `open` (HelperMaintenance) and in the
// background prebuild (prebuildImage). No `vscode`.
import * as crypto from 'crypto';
import * as fs from 'fs';
import type { BootstrapDocker } from '../docker/bootstrapDocker';
import { UserFacingError, errorMessage, isUserFacingError } from '../errors';
import { Messages } from '../messages';
import { HELPER_DOCKER_SOCKET } from '../names';
import { abortError, isAbortError, systemClock, type Clock, type Logger } from '../ports';
import {
  HELPER_LAST_USED_INTERVAL_MS,
  currentHelperImageTag,
  ensureHelperImageUse,
  helperRefreshDue,
  recordHelperImageUse,
  type BaseDigestLookup,
  type HelperBuildKind,
  type HelperImageUse,
} from './helperImage';
import { readHelperState } from './helperState';

/** The part of BootstrapDocker that the helper image uses. */
export type HelperImageDocker = Pick<BootstrapDocker, 'imageExists' | 'imageId' | 'buildImage' | 'listImagesByLabel' | 'removeImage'>;

/** The deps of HelperImages. */
export interface HelperImagesDeps {
  docker: HelperImageDocker;
  logger: Logger;
  /** resources/helper/Dockerfile of the installed extension. */
  dockerfilePath: string;
  clock?: Clock;
  /**
   * `helper.json` in the global storage folder (StoragePaths.helperState). With it, the maintaining ensure
   * (ensureImageUse, prebuildImage: the preparation of the worker for an operation `open` and the background prebuild)
   * also checks the base image weekly (in the background), rebuilds the image when a check asked for it, and removes
   * old helper images daily (ensureHelperImageUse); the other calls (ensureImagePresent) only build a missing tag and
   * record the use. Without it, the image is only built when its tag is missing.
   */
  statePath?: string;
  /** Current digest of the base image of the helper (registryBaseDigest). Without it, the base image is not checked. */
  baseDigest?: BaseDigestLookup;
  /** Called with each check of the base image that ensureImageUse starts in the background (for tests). */
  onBaseImageCheck?: (check: Promise<void>) => void;
  /**
   * The Docker engine that the operation uses (the current Docker context). `key` names it ('' for the local Docker,
   * else the remote host): the image found or built for one engine is not reused for another, and a remote engine has
   * its own state file. Without it, the local Docker of DOCKER_HOST. The socket of the engine is not part of it
   * (HelperImages starts no container; the socket mount of the worker is extension.ts' engineSocket, and the batch
   * helpers take the worker's own).
   */
  engine?: () => Promise<HelperEngine>;
  /** Called after a build of the helper image succeeded (the worker can be opened again at once). */
  onImageBuilt?: () => void;

}

/** The options of HelperImages.ensureImagePresent. */
export interface PresentImageOptions {
  onOutput?: (text: string) => void;
  signal?: AbortSignal;
  /** Called when the call starts or joins a build of the helper image. */
  onBuild?: (kind: HelperBuildKind) => void;
}

/** See HelperImagesDeps.engine. */
export interface HelperEngine {
  key: string;
}

/**
 * The state file of the helper images of a remote engine: `helper.json` → `helper-remote-<hash>.json`. The state of
 * the local Docker stays in `helper.json`.
 */
export function helperStatePathFor(statePath: string, engineKey: string): string {
  if (engineKey === '') return statePath;
  const hash = crypto.createHash('sha256').update(engineKey).digest('hex').slice(0, 16);
  return statePath.replace(/(\.json)?$/, `-remote-${hash}.json`);
}

/** Options of HelperImages.ensureImageUse. */
export interface EnsureImageOptions {
  onOutput?: (text: string) => void;
  signal?: AbortSignal;
  /** `false` when the setting updateImagesOnConnect is off: no check of the base image (default `true`). */
  checkBaseImage?: boolean;
  /** Called right before a build of the helper image: `create` for a missing tag, `refresh` for a rebuild. */
  onBuild?: (kind: HelperBuildKind) => void;
}

/**
 * The helper image maintenance of the preparation of the worker for an operation `open`
 * (HelperChannelsOptions.prepare): that preparation runs the maintaining ensure (ensureImageUse) instead of
 * ensureImagePresent. Only the open passes it; every other operation, a heartbeat and a repair use ensureImagePresent.
 */
export interface HelperMaintenance {
  /** The setting updateImagesOnConnect of the open: the check of the base image and the rebuild that a check asks for. */
  checkBaseImage: boolean;
  /** The progress of the open: the preparation starts or joins a build of the helper image (`create` or `refresh`). */
  onBuild?: (kind: HelperBuildKind) => void;
  /** The progress of the open: the preparation that called onBuild ended (its build succeeded or failed). */
  onBuildEnd?: () => void;
}

/**
 * The maintaining ensure (ensureImageUse, prebuildImage) reuses its result for this long. After that, it runs
 * ensureHelperImageUse again, so that a window that stays open for days still checks the base image and cleans up when that
 * is due (at the next preparation of a worker for an open in that window).
 */
export const HELPER_IMAGE_RECHECK_MS = 60 * 60 * 1000;


/**
 * Source of the socket mount. The source is a path on the machine of the Docker engine.
 * Assumption: Docker Desktop (macOS, Windows, and Linux) runs the engine in a VM, where the socket is
 * /var/run/docker.sock, whatever DOCKER_HOST points to on the computer. So a `unix://` DOCKER_HOST is used only on
 * Linux without Docker Desktop (for example rootless Docker Engine).
 */
export function helperDockerSocket(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, endpoint?: string): string {
  // The endpoint of the current Docker context (DOCKER_HOST when it is set), so a context of a local rootless engine is
  // followed like DOCKER_HOST.
  const host = (endpoint?.trim() || env.DOCKER_HOST?.trim()) ?? '';
  if (platform !== 'linux' || !host || !host.startsWith('unix://')) return HELPER_DOCKER_SOCKET;
  const socketPath = host.slice('unix://'.length);
  if (!socketPath.startsWith('/') || socketPath.includes('/.docker/desktop/')) return HELPER_DOCKER_SOCKET;
  return socketPath;
}

/** The helper image of the operations of a window (see the module comment). */
export class HelperImages {
  private imagePromise: Promise<HelperImageUse> | undefined;
  /** Whether the cached image promise comes from ensureImageUse (with the maintenance), not from a helper run. */
  private imageMaintained = false;
  /** When the cached image promise resolved, and its tag. */
  private imageReadyAt: number | undefined;
  private imageTag: string | undefined;
  /**
   * The image ID of the cached result (HelperImageUse.id), set when it resolved; ensureImageUse and ensureImagePresent
   * check it before they reuse the cache (cachedImageCurrent).
   */
  private imageCachedId: string | undefined;
  /** Last time this instance recorded a use of the tag in the state file. */
  private imageUsedAt: number | undefined;
  private readonly clock: Clock;
  /** The engine of the cached image (HelperImagesDeps.engine). */
  private imageEngine = '';
  /**
   * The build that the cached image promise has started (HelperBuildKind), until it settles, and the onBuild callbacks
   * of the callers that await it. A caller that joins the promise gets the progress too: at once when the build has
   * started, otherwise when it starts.
   */
  private imageBuilding: HelperBuildKind | undefined;
  private imageBuildListeners: Set<(kind: HelperBuildKind) => void> | undefined;

  private readonly logOutput = (text: string): void => this.deps.logger.output(text);

  constructor(private readonly deps: HelperImagesDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  /** The engine of the operation (HelperImagesDeps.engine); the local Docker without it. */
  async currentEngine(): Promise<HelperEngine> {
    return (await this.deps.engine?.()) ?? { key: '' };
  }

  private statePathFor(engine: HelperEngine): string | undefined {
    const statePath = this.deps.statePath;
    return statePath === undefined ? undefined : helperStatePathFor(statePath, engine.key);
  }

  /**
   * ensureHelperImageUse, shared by concurrent callers (cached promise; retried after a failure). With `statePath`, it
   * also does the maintenance that is due: a rebuild that a check asked for, the check of the base image (in the
   * background), the cleanup of old helper images. The preparation of the worker for an operation `open` calls it
   * (heartbeatHelperImage, with HelperMaintenance), before the worker of the open starts, and the background prebuild
   * (as prebuildImage). A result older than HELPER_IMAGE_RECHECK_MS, or one of a call without the maintenance, is not
   * reused. A failed build throws UserFacingError('helperFailed', Messages.helperFailed, detail); AbortError and other
   * UserFacingErrors pass through. Returns the helper image that this call awaited (HelperImageUse: the tag and the ID
   * of its image), also when the cache of this instance, which all operations of the window share, was replaced
   * meanwhile (another engine).
   */
  async ensureImageUse(options: EnsureImageOptions = {}): Promise<HelperImageUse> {
    return this.image(options, true);
  }

  /**
   * The helper image for the worker of an operation or a heartbeat (HelperChannelsOptions.prepare), on the engine of
   * the operation, local or remote alike. It only builds a missing tag: no check of the base image, no rebuild of an
   * existing tag, no cleanup, so nothing long runs before the lock. A cached result whose image is gone (a prune, or
   * another window moved the tag) is not trusted: the cache is reset and the tag ensured again. It does not join a
   * pending maintaining ensure (a `--pull --no-cache` rebuild, the cleanup: that of the preparation of the worker for
   * an open, or of the background prebuild), which the caller could not cancel: when the tag exists, its image is used
   * at once (the worker started from it keeps it; a rebuild that moves the tag later cannot remove an image that a
   * container uses). Only a missing tag, or a tag that cannot be checked, joins it. Throws like ensureImageUse.
   * `onBuild` is called when the call starts or joins a build (a failure before it, such as an engine that does not
   * answer, is no failed build).
   */
  async ensureImagePresent(options: PresentImageOptions = {}): Promise<HelperImageUse> {
    const engine = await this.currentEngine();
    this.adoptEngine(engine.key);
    if (this.imagePromise && this.imageReadyAt !== undefined && !(await this.cachedImageCurrent())) this.resetImage();
    this.adoptEngine(engine.key);
    if (this.imagePromise && this.imageReadyAt === undefined && this.imageMaintained) {
      const present = await this.presentTag(options.signal);
      if (present !== undefined) return present;
      // The cache may have been replaced during the await (another engine): image() joins a promise of this engine.
      this.adoptEngine(engine.key);
    }
    return this.image({ onOutput: options.onOutput, signal: options.signal, onBuild: options.onBuild }, false);
  }

  /**
   * Whether the current helper tag exists on the engine of the operation, for the refresh of the sidebar, which never
   * builds it and never joins a pending build (its checks have time limits). Throws
   * UserFacingError('helperFailed') when the tag is missing or cannot be checked; an AbortError when `signal` aborts.
   */
  async checkImagePresent(options: { signal?: AbortSignal } = {}): Promise<void> {
    const present = await this.presentTag(options.signal);
    if (present === undefined) throw new UserFacingError('helperFailed', Messages.helperImageNotPresent);
  }

  /**
   * The current helper tag with the ID of its image when the tag exists on the engine of the operation, else
   * `undefined` (missing, or it cannot be checked); never builds and never joins a build (its check has a time limit).
   * An AbortError when `signal` aborts.
   */
  async presentImage(options: { signal?: AbortSignal } = {}): Promise<HelperImageUse | undefined> {
    return this.presentTag(options.signal);
  }

  /**
   * The current helper tag with the ID of its image, when the tag exists; `undefined` when
   * it is missing or cannot be checked (the caller then joins or builds). It leaves the cache untouched and records no
   * use. An abort of `signal` passes through.
   */
  private async presentTag(signal: AbortSignal | undefined): Promise<HelperImageUse | undefined> {
    if (signal?.aborted) throw abortError();
    let tag: string | undefined;
    let id: string | undefined;
    try {
      tag = await currentHelperImageTag(this.deps.dockerfilePath);
      id = await this.deps.docker.imageId(tag);
    } catch (error) {
      this.deps.logger.warn(`The workspace helper image${tag !== undefined ? ` ${tag}` : ''} could not be checked: ${errorMessage(error)}`);
      id = undefined;
    }
    if (signal?.aborted) throw abortError();
    return tag !== undefined && id !== undefined ? { tag, id } : undefined;
  }

  /**
   * The key of the engine of the operation (HelperImagesDeps.engine; '' for the local Docker). The background prebuild
   * reads the state file of this engine (helperStatePathFor), the one that an open on it writes.
   */
  async engineKey(): Promise<string> {
    return (await this.currentEngine()).key;
  }

  /**
   * The helper image of a step of the workspace helper without the image of an open (the cache, without its
   * maintenance: only a missing tag is built). WorkspaceHelper does not call it (it runs in the worker, from the
   * worker's own image), so it has no caller outside the tests.
   */
  runImage(options: EnsureImageOptions): Promise<HelperImageUse> {
    return this.image(options, false);
  }

  /**
   * The background prebuild (no previous helper image; HelperPrebuild): makes sure that the helper tag exists on the
   * engine of the operation, and builds it when it is missing. With the maintenance of ensureImageUse
   * (`checkBaseImage`: the setting updateImagesOnConnect): the rebuild that a check asked for (so the next open does
   * not wait for it), the weekly check of the base image, the daily cleanup, when they are due. It shares the cached
   * promise of this instance with the preparation of a worker (ensureImagePresent; ensureImageUse before an open), so a
   * preparation that needs the missing tag meanwhile waits for this build instead of building a second time (one before
   * an open also for the rebuild, with its progress); when `signal` aborts, the build is cancelled, and a preparation
   * that waited for it builds again for itself (a rebuild that the time limit of `signal` ends, helperTimeLimit, counts
   * as a failed rebuild instead, so that preparation gets the existing image). On every engine, local or remote. Throws
   * like ensureImageUse.
   */
  async prebuildImage(options: { signal: AbortSignal; onBuild?: (kind: HelperBuildKind) => void; checkBaseImage?: boolean }): Promise<HelperImageUse> {
    return this.image({ signal: options.signal, onBuild: options.onBuild, checkBaseImage: options.checkBaseImage }, true);
  }

  /**
   * Whether the refresh of the current tag is due on the engine of the operation, by its state file alone
   * (helperRefreshDue: no Docker call): with `checkBaseImage` (the setting updateImagesOnConnect), the rebuild that a
   * check asked for, or the weekly check of the base image (with a lookup of its digest; a week also after an attempt
   * that the registry did not answer). Never for the daily cleanup alone.
   * `false` without a state file. The background prebuild asks Docker only then, or when the state file has no record
   * of the current tag.
   */
  async refreshDue(options: { checkBaseImage: boolean }): Promise<boolean> {
    const statePath = this.statePathFor(await this.currentEngine());
    if (statePath === undefined) return false;
    const content = await fs.promises.readFile(this.deps.dockerfilePath, 'utf8');
    return helperRefreshDue(await readHelperState(statePath), content, {
      now: this.clock.now(),
      checkBaseImage: options.checkBaseImage,
      baseDigest: this.deps.baseDigest !== undefined,
    });
  }

  /**
   * The helper image (HelperImageUse). `recheck` (the maintaining ensure: ensureImageUse, prebuildImage: the
   * preparation of the worker for an operation `open`, and the background prebuild): ensureHelperImageUse with the
   * maintenance; a result older than HELPER_IMAGE_RECHECK_MS, or one without the maintenance, is not reused. The other
   * calls (`recheck` false: ensureImagePresent, runImage) reuse any result and only record the use (at most once per
   * hour); without a result (a new window), they run ensureHelperImageUse without the maintenance, which only builds a
   * missing tag. So no check of the base image, no rebuild, and no cleanup delays another operation or a heartbeat.
   */
  private async image(options: EnsureImageOptions, recheck: boolean): Promise<HelperImageUse> {
    const engine = await this.currentEngine();
    // An image of another engine (the Docker context changed) is not reused.
    this.adoptEngine(engine.key);
    const statePath = this.statePathFor(engine);
    if (recheck && this.imagePromise && !this.imageMaintained) {
      // The result of a helper run: wait until it is ready (a missing tag is built only once), then maintain.
      const pending = this.imagePromise;
      if (this.imageReadyAt === undefined) {
        try {
          await this.join(pending, options);
        } catch (error) {
          // The abort of this caller ends this call; a failure of the shared build does not (it is tried again below).
          if (isAbortError(error) && options.signal?.aborted) throw error;
        }
      }
      if (this.imagePromise === pending) this.resetImage();
      // Another open with another engine may have replaced the cache during the join.
      this.adoptEngine(engine.key);
    }
    if (this.imagePromise && this.imageReadyAt !== undefined) {
      const now = this.clock.now();
      if (recheck && Math.abs(now - this.imageReadyAt) >= HELPER_IMAGE_RECHECK_MS) this.resetImage();
      else if (recheck && !(await this.cachedImageCurrent())) this.resetImage();
      else await this.recordUse(now, statePath);
    }
    // Another open with another engine may have replaced the cache during the awaits above. No await follows until the
    // join below, so the caller joins a promise of its own engine.
    this.adoptEngine(engine.key);
    if (!this.imagePromise) {
      // A caller cancelled during the awaits above starts no shared ensure, whose rejection nothing would handle (join
      // rejects at once for an aborted signal) and which could start a build.
      if (options.signal?.aborted) throw abortError();
      const listeners = new Set<(kind: HelperBuildKind) => void>();
      let built = false;
      const promise: Promise<HelperImageUse> = ensureHelperImageUse(this.deps.docker, this.deps.dockerfilePath, {
        onOutput: options.onOutput ?? this.logOutput,
        signal: options.signal,
        statePath,
        baseDigest: this.deps.baseDigest,
        maintain: recheck,
        checkBaseImage: options.checkBaseImage,
        // The progress reaches every caller that awaits this promise (join), not only the caller that started it.
        onBuild: (kind) => {
          built = true;
          if (this.imagePromise === promise) this.imageBuilding = kind;
          for (const listener of [...listeners]) listener(kind);
        },
        onBaseImageCheck: this.deps.onBaseImageCheck,
        clock: this.clock,
        logger: this.deps.logger,
      }).then(
        (use) => {
          if (this.imagePromise === promise) {
            this.imageBuilding = undefined;
            this.imageReadyAt = this.clock.now();
            this.imageUsedAt = this.imageReadyAt;
            this.imageTag = use.tag;
            this.imageCachedId = use.id;
          }
          if (built) {
            try {
              this.deps.onImageBuilt?.();
            } catch (error) {
              this.deps.logger.warn(`The built helper image could not be reported: ${errorMessage(error)}`);
            }
          }
          return use;
        },
        (error: unknown) => {
          if (this.imagePromise === promise) {
            this.imagePromise = undefined;
            this.imageBuilding = undefined;
          }
          if (isAbortError(error) || isUserFacingError(error)) throw error;
          this.deps.logger.error('The workspace helper image could not be built.', error);
          throw new UserFacingError('helperFailed', Messages.helperFailed, errorMessage(error));
        },
      );
      this.imagePromise = promise;
      this.imageMaintained = recheck;
      this.imageBuilding = undefined;
      this.imageBuildListeners = listeners;
    }
    try {
      // The caller gets the image that it awaited, also when the cache was replaced meanwhile (resetImage). Its own
      // signal ends its wait (join).
      return await this.join(this.imagePromise, options);
    } catch (error) {
      // Another caller cancelled the shared build: build again for this caller.
      if (isAbortError(error) && !options.signal?.aborted) return this.image(options, recheck);
      throw error;
    }
  }

  /**
   * Makes `key` the engine of the cache; a cache of another engine is reset (its image is not reused). Called again
   * after each await of `image`, because the operations of a window (each with the engine of its operation) share the
   * cache.
   */
  private adoptEngine(key: string): void {
    if (this.imagePromise && key !== this.imageEngine) this.resetImage();
    this.imageEngine = key;
  }

  private resetImage(): void {
    this.imagePromise = undefined;
    this.imageMaintained = false;
    this.imageReadyAt = undefined;
    this.imageCachedId = undefined;
    this.imageBuilding = undefined;
    this.imageBuildListeners = undefined;
  }

  /**
   * Awaits the cached image promise `pending` (the current one) for one caller. The
   * signal of the caller ends only its own wait: it rejects with an AbortError at once (also when it was aborted before),
   * and the shared build goes on with the signal of the caller that started it. The onBuild of the caller gets the
   * progress of the shared build: at once when a build has started, otherwise when it starts, until `pending` settles.
   */
  private join(pending: Promise<HelperImageUse>, options: EnsureImageOptions): Promise<HelperImageUse> {
    const { signal, onBuild } = options;
    if (signal?.aborted) return Promise.reject(abortError());
    const listeners = this.imageBuildListeners;
    let listener: ((kind: HelperBuildKind) => void) | undefined;
    if (onBuild !== undefined) {
      if (this.imageBuilding !== undefined) onBuild(this.imageBuilding);
      else if (listeners !== undefined) {
        listener = (kind) => onBuild(kind);
        listeners.add(listener);
      }
    }
    if (signal === undefined && listener === undefined) return pending;
    return new Promise<HelperImageUse>((resolve, reject) => {
      const cleanup = (): void => {
        signal?.removeEventListener('abort', onAbort);
        if (listener !== undefined) listeners?.delete(listener);
      };
      const onAbort = (): void => {
        cleanup();
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      pending.then(
        (use) => {
          cleanup();
          resolve(use);
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
    });
  }

  /**
   * Whether the resolved result in the cache is still the image of its tag, before it is reused (by ensureImageUse
   * within HELPER_IMAGE_RECHECK_MS, by ensureImagePresent always). Another window may have rebuilt the tag (its old
   * image is then removed, or the containerd store drops it) or a prune may have removed it: the result would then name
   * an image that does not exist any more. `false` when the tag is gone or has another image; `true` when Docker cannot
   * answer (the cache stays) or when the cache changed meanwhile (the caller then awaits the new promise).
   */
  private async cachedImageCurrent(): Promise<boolean> {
    const promise = this.imagePromise;
    const tag = this.imageTag;
    const cachedId = this.imageCachedId;
    if (promise === undefined || tag === undefined) return true;
    let current: string | undefined;
    try {
      current = await this.deps.docker.imageId(tag);
    } catch (error) {
      this.deps.logger.warn(`The workspace helper image ${tag} could not be checked: ${errorMessage(error)}`);
      return true;
    }
    if (this.imagePromise !== promise) return true;
    if (current === cachedId) return true;
    this.deps.logger.info(
      current === undefined
        ? `The workspace helper image ${tag} was removed. It is prepared again.`
        : `The workspace helper image ${tag} has another image now. It is prepared again.`,
    );
    return false;
  }

  /** `lastUsedAt` of the tag in the state file, at most once per hour per instance. Never throws. */
  private async recordUse(now: number, statePath: string | undefined): Promise<void> {
    const tag = this.imageTag;
    if (statePath === undefined || tag === undefined) return;
    if (this.imageUsedAt !== undefined && Math.abs(now - this.imageUsedAt) < HELPER_LAST_USED_INTERVAL_MS) return;
    this.imageUsedAt = now;
    await recordHelperImageUse(statePath, tag, { clock: this.clock, logger: this.deps.logger });
  }
}
