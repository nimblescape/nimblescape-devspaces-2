// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Monitor triggers the prepare: the part of the background run (background.ts) that prepares the next
// devspace image of each devspace of the engine (the worker operation `prepare`), so that the first open of the
// morning swaps to it instead of building.
// - Which: every devspace of the engine, by its workspace volume (the labels and the name that the worker's prepare
//   takes too, devspaceOfVolume); no skip of long unused ones. The prepare itself decides cheaply that nothing moved:
//   it checks the references of the build record first, anonymously and with the monitor's fresh registry answers of this
//   run, before anything is read from the volume (DevspaceService.prepare).
// - In which order: the most recently used first, by the newest heartbeat record of each devspace in the volume (the
//   time of the last heartbeat of a window of it; the loop keeps the newest record of every devspace that has a
//   container), then those without a record, by their ID.
// - How: one prepare at a time, never two, by the worker's own script, run as a child process of the monitor in its own
//   container (PrepareWorker; childPrepareWorker): the worker that created the monitor stored its script in the volume and
//   gave the monitor its hash (MONITOR_WORKER_HASH_ENV, workerScript.ts), so the monitor runs exactly the worker of that
//   extension version, with the pipe loader (which checks the hash again) at a private path, and sends it `prepare` with
//   the devspace ID over the helper channel, as the extension does. The worker reads its own image, socket and store
//   from the monitor's container, which mounts what a worker mounts (the socket, this volume at the same path, the
//   shared VS Code server store). No token, no credential, no secret, no setting: the operation takes none, its
//   environment holds only PATH and the version of Devspaces (VERSION_ENV, the Monitor's own, for the header
//   User-Agent), and its requests to a computer (none) are refused.
// - One line of the log per devspace: prepared, skipped and why, failed, or stopped after the time limit, with the
//   duration; the worker's own log lines and the build output stay out of the monitor's log.
// - Then the prepared images (`<resource>:prepared` with the label of a prepare) of devspaces that have no volume on
//   the engine any more are removed, by their tag, never with force, never one that a container uses.
// The prepare of the worker holds the prepare lock of its devspace only; the background run (CacheSchedule) runs at
// most once at a time, so the prepares of two runs never overlap. It never touches a container or the content of a volume.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { errorMessage } from '../core/errors';
import { VERSION_ENV, userAgentVersion } from '../core/http';
import { HelperChannel } from '../core/helperChannel/helperChannel';
import { CHANNEL_ENTRY, OP_PREPARE, parsePrepareValue, type PrepareValue } from '../core/helperChannel/protocol';
import { loaderCommand } from '../core/loader/pipeLoader';
import { sourceSegment } from '../core/devspaceSource';
import { LABEL_CONFIG_PATH, LABEL_DEFAULT_IMAGE, LABEL_DEVSPACE_ID, LABEL_PREPARED, LABEL_REPOSITORY, LABEL_VOLUME, PREPARED_IMAGE_TAG, devspaceImageRepository, resourceName } from '../core/names';
import { DEFAULT_CONFIG_PATH, isRepositoryName } from '../core/pipeline/recordRules';
import type { DevspaceSource } from '../core/types';
import { NodeProcessRunner } from '../core/process';
import type { Logger, StartOptions, StartedProcess } from '../core/ports';
import { isWorkerScriptHash, readWorkerScript, removeOtherWorkerScripts } from '../core/remoteMonitor/workerScript';
import { isStorageId } from '../core/storage/paths';
import { engineFailure, type PrepareEngine } from './engine';

/** The time limit of a request to the engine of this part (a list, an inspect, a removal). */
export const PREPARE_ENGINE_TIMEOUT_MS = 60_000;
/**
 * The time limit of one operation `prepare` on the channel: the prepare stops itself after PREPARE_LIMIT_MS (30 minutes,
 * pipelineRules.ts), so this only ends a worker that does not answer.
 */
export const PREPARE_OPERATION_TIMEOUT_MS = 35 * 60_000;
/**
 * The PATH of the worker process. Its environment holds only PATH and the version of Devspaces (no token, no credential,
 * no variable of a computer).
 */
export const PREPARE_WORKER_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** A devspace of the engine as this part knows it: its ID and repository (from the labels of its workspace volume). */
export interface PrepareDevspace {
  id: string;
  repository: string;
}

/** A started worker that prepares one devspace at a time (childPrepareWorker). */
export interface PrepareSession {
  /** The prepare of `devspaceId` (its value, checked strictly); rejects when the worker fails or is lost. */
  prepare(devspaceId: string): Promise<PrepareValue>;
  /** Ends the worker. Never rejects. */
  close(): Promise<void>;
}

/** Starts a worker for the prepares (one session per run, again after a failure). */
export interface PrepareWorker {
  open(): Promise<PrepareSession>;
}

/** What the part needs (prepareDevspaces). */
export interface PreparesDeps {
  engine: PrepareEngine;
  log: (message: string) => void;
  /** The monotonic clock of the durations (ms). */
  monotonic: () => number;
  /** The time of the last use of each devspace (ms since the epoch): its newest heartbeat record. Never rejects. */
  lastUsed: () => Promise<Map<string, number>>;
  /** The worker of the prepares, or why there is none (no script). */
  worker: () => PrepareWorker | { reason: string };
}

/**
 * The devspaces of the engine: one per workspace volume with the labels of a devspace (a valid ID, a repository
 * `owner/name`, no label of an additional volume) and the name that the extension gives it (resourceName), as the
 * worker's prepare finds them (devspaceOfVolume). Throws when the volumes cannot be listed.
 */
export async function workspaceDevspaces(engine: Pick<PrepareEngine, 'volumeNames' | 'inspect'>): Promise<PrepareDevspace[]> {
  const names = await engine.volumeNames({ label: [LABEL_DEVSPACE_ID] }, AbortSignal.timeout(PREPARE_ENGINE_TIMEOUT_MS));
  const found = new Map<string, PrepareDevspace>();
  for (const name of new Set(names)) {
    const volume = (await engine.inspect('volume', name, AbortSignal.timeout(PREPARE_ENGINE_TIMEOUT_MS))) as { Name?: unknown; Labels?: unknown } | undefined;
    const labels = volume?.Labels;
    if (typeof volume?.Name !== 'string' || typeof labels !== 'object' || labels === null) continue;
    const { [LABEL_DEVSPACE_ID]: id, [LABEL_REPOSITORY]: repository, [LABEL_VOLUME]: additional, [LABEL_DEFAULT_IMAGE]: defaultImage, [LABEL_CONFIG_PATH]: configPath } = labels as Record<string, unknown>;
    if (additional !== undefined || !isStorageId(id) || !isPreparedRepository(repository)) continue;
    // The name of the devspace of these labels: with the word of its source (the labels of the volume name it), or
    // without (a volume of version 0.5.0 or older). The worker's prepare checks the labels in full (devspaceOfVolume).
    const source: DevspaceSource =
      typeof defaultImage === 'string' ? { kind: 'defaultImage', image: defaultImage } : { kind: 'configuration', configPath: typeof configPath === 'string' ? configPath : DEFAULT_CONFIG_PATH };
    const expected = [resourceName(repository, id, sourceSegment(source)), resourceName(repository, id)].map((name) => name.toLowerCase());
    if (!expected.includes(volume.Name.toLowerCase())) continue;
    found.set(id, { id, repository });
  }
  return [...found.values()];
}

/** A repository as the worker's prepare takes it from the labels of a volume (devspaceOfVolume). */
function isPreparedRepository(value: unknown): value is string {
  return isRepositoryName(value) && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

/**
 * The order of the prepares: the most recently used devspace first (`lastUsed`, the newest heartbeat record of each),
 * then those without a record; equal times by the ID. None is left out.
 */
export function prepareOrder(devspaces: readonly PrepareDevspace[], lastUsed: ReadonlyMap<string, number>): PrepareDevspace[] {
  return [...devspaces].sort((a, b) => {
    const at = lastUsed.get(a.id) ?? -Infinity;
    const bt = lastUsed.get(b.id) ?? -Infinity;
    if (at !== bt) return bt - at;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** A duration for the log: `12 s` or `3 min 5 s`. */
export function durationText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/** Text of the worker for one line of the log: no control characters, at most `max` characters, no final period. */
function oneLine(text: string, max = 500): string {
  const line = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return (line.length > max ? `${line.slice(0, max - 1)}…` : line).replace(/\.$/, '');
}

/** The one line of the log of the prepare of `env` (`value` of the worker). */
export function prepareLine(env: PrepareDevspace, value: PrepareValue): string {
  const took = durationText(value.seconds * 1000);
  const detail = oneLine(value.detail);
  switch (value.outcome) {
    case 'prepared':
      return `${env.repository}: prepared in ${took} (${detail}).`;
    case 'skipped':
      return `${env.repository}: no prepare (${took}): ${detail}.`;
    case 'stopped':
      return `${env.repository}: the prepare was stopped after ${took} by its time limit; the next open builds it.`;
    case 'cancelled':
      return `${env.repository}: the prepare was stopped after ${took}: ${detail}.`;
    case 'failed':
      return `${env.repository}: the prepare failed after ${took}: ${detail}.`;
  }
}

/**
 * The part of the background run (see the module comment): the prepares, one at a time, the most recently used
 * devspace first, then the removal of the stale prepared images. Throws only when the devspaces cannot be listed
 * (the run logs it and goes on); every prepare is logged on its own.
 */
export async function prepareDevspaces(deps: PreparesDeps): Promise<void> {
  const { log } = deps;
  const devspaces = prepareOrder(await workspaceDevspaces(deps.engine), await deps.lastUsed());
  if (devspaces.length > 0) {
    const worker = deps.worker();
    if ('reason' in worker) log(`No devspace image is prepared: ${worker.reason}.`);
    else await prepareEach(deps, worker, devspaces);
  }
  await removeStalePreparedImages(deps.engine, log);
}

/** The prepares of `devspaces` in their order, each after the end of the one before (one worker, again after a failure). */
async function prepareEach(deps: PreparesDeps, worker: PrepareWorker, devspaces: readonly PrepareDevspace[]): Promise<void> {
  const { log } = deps;
  let session: PrepareSession | undefined;
  try {
    for (const [index, env] of devspaces.entries()) {
      if (session === undefined) {
        try {
          session = await worker.open();
        } catch (error) {
          log(`The worker of the prepares could not be started, so ${devspaces.length - index} devspace(s) are prepared at the next run: ${oneLine(errorMessage(error))}.`);
          return;
        }
      }
      const started = deps.monotonic();
      try {
        log(prepareLine(env, await session.prepare(env.id)));
      } catch (error) {
        log(`${env.repository}: the prepare failed after ${durationText(deps.monotonic() - started)}: ${oneLine(errorMessage(error))}.`);
        // The worker may be lost: the next devspace gets a new one.
        await session.close();
        session = undefined;
      }
    }
  } finally {
    await session?.close();
  }
}

/**
 * The prepared images of devspaces without a volume on the engine: an image with the label of a prepare
 * (LABEL_PREPARED, not empty: an image that an open took over has it empty) and a valid devspace ID, tagged
 * `<resource>:prepared` of its devspace, when no volume has the label of that devspace ID and no container (running
 * or not) uses the image; removed by that tag, never with force (Docker refuses an image in use). A failure of one is one
 * line; the list of the images or of the volumes failing removes nothing.
 */
export async function removeStalePreparedImages(engine: Pick<PrepareEngine, 'images' | 'volumeNames' | 'containerIds' | 'removeImage'>, log: (message: string) => void): Promise<void> {
  let images;
  try {
    images = await engine.images({ label: [LABEL_PREPARED] }, AbortSignal.timeout(PREPARE_ENGINE_TIMEOUT_MS));
  } catch (error) {
    log(`The prepared images could not be listed, so none is removed: ${engineFailure(error, PREPARE_ENGINE_TIMEOUT_MS)}`);
    return;
  }
  for (const image of images) {
    const id = image.labels[LABEL_DEVSPACE_ID];
    const repository = image.labels[LABEL_REPOSITORY];
    if ((image.labels[LABEL_PREPARED] ?? '') === '' || !isStorageId(id) || !isPreparedRepository(repository)) continue;
    const tag = `${devspaceImageRepository(repository, id)}:${PREPARED_IMAGE_TAG}`;
    if (!image.repoTags.includes(tag)) continue;
    try {
      const volumes = await engine.volumeNames({ label: [`${LABEL_DEVSPACE_ID}=${id}`] }, AbortSignal.timeout(PREPARE_ENGINE_TIMEOUT_MS));
      if (volumes.length > 0) continue;
      const users = await engine.containerIds({ ancestor: [image.id] }, AbortSignal.timeout(PREPARE_ENGINE_TIMEOUT_MS));
      if (users.length > 0) {
        log(`The prepared image ${tag} of the removed devspace ${id} stays: a container uses it.`);
        continue;
      }
      const removed = await engine.removeImage(tag, AbortSignal.timeout(PREPARE_ENGINE_TIMEOUT_MS));
      if (removed === 'removed') log(`Removed the prepared image ${tag}: its devspace ${id} has no volume on this engine.`);
      else if (removed === 'inUse') log(`The prepared image ${tag} of the removed devspace ${id} stays: Docker says it is in use.`);
    } catch (error) {
      log(`The prepared image ${tag} could not be removed: ${engineFailure(error, PREPARE_ENGINE_TIMEOUT_MS)}`);
    }
  }
}

/** The log of the worker's channel: nothing (the part logs one line per devspace). */
const QUIET: Logger = { info: () => {}, warn: () => {}, error: () => {}, output: () => {} };

/** What childPrepareWorker needs: the checked script and its hash; the tests give their own start and folder. */
export interface ChildWorkerDeps {
  script: string;
  hash: string;
  /** Starts the process (default: NodeProcessRunner.start). */
  start?: (file: string, args: readonly string[], options: StartOptions) => StartedProcess;
  /** The folder of the private folders of the workers (default: the temporary folder of the container). */
  tempRoot?: string;
  /** Node.js (default: this process's). */
  node?: string;
  openTimeoutMs?: number;
}

/**
 * The worker of the prepares as a child process of the monitor in its own container: `node -e <pipe loader>` with a
 * private folder of its own for the script (so a worker never reads a script that another start or a store changes),
 * the hash of the script and CHANNEL_ENTRY; the script goes over its input as the first line (HelperChannel.open), never
 * on the command line; its environment holds only PATH and the version of Devspaces that the Monitor got (VERSION_ENV),
 * for the header User-Agent of its HTTPS requests. Its operations get no secret, its requests are refused (none
 * are made), and its output and log stay out of the monitor's log. Its folder is removed when it ends.
 */
export function childPrepareWorker(deps: ChildWorkerDeps): PrepareWorker {
  const start = deps.start ?? ((file, args, options) => new NodeProcessRunner().start(file, args, options));
  return {
    async open(): Promise<PrepareSession> {
      const folder = await fs.promises.mkdtemp(path.join(deps.tempRoot ?? os.tmpdir(), 'devspaces-prepare-'));
      const remove = () => fs.promises.rm(folder, { recursive: true, force: true }).catch(() => undefined);
      const [, ...args] = loaderCommand({ path: path.join(folder, 'channel.js'), hash: deps.hash, entry: CHANNEL_ENTRY });
      const version = userAgentVersion();
      const env = { PATH: PREPARE_WORKER_PATH, ...(version === undefined ? {} : { [VERSION_ENV]: version }) };
      const child = start(deps.node ?? process.execPath, args, { env, cwd: folder });
      let channel: HelperChannel;
      try {
        channel = await HelperChannel.open(child, deps.script, { logger: QUIET, name: 'the worker of the prepares', ...(deps.openTimeoutMs !== undefined ? { openTimeoutMs: deps.openTimeoutMs } : {}) });
      } catch (error) {
        child.kill();
        await child.exited;
        await remove();
        throw error;
      }
      let closed: Promise<void> | undefined;
      return {
        async prepare(devspaceId) {
          const value = parsePrepareValue(await channel.flow(OP_PREPARE, { devspaceId }, { timeoutMs: PREPARE_OPERATION_TIMEOUT_MS }));
          if (value === undefined) throw new Error('the worker answered with an invalid value');
          return value;
        },
        close: () =>
          (closed ??= (async () => {
            channel.close();
            await child.exited;
            await remove();
          })()),
      };
    },
  };
}

/**
 * The worker of the prepares of the monitor: the script with the hash that the worker which created the monitor gave it
 * (`hash`, MONITOR_WORKER_HASH_ENV), read afresh from the volume `stateDir` for each run (readWorkerScript), or why there
 * is none. The scripts of other hashes are removed after a day (removeOtherWorkerScripts).
 */
export function storedPrepareWorker(hash: string | undefined, stateDir: string, now: () => number, extra: Partial<ChildWorkerDeps> = {}): () => PrepareWorker | { reason: string } {
  return () => {
    if (hash === undefined) return { reason: 'the Monitor was created without the hash of a worker script' };
    if (!isWorkerScriptHash(hash)) return { reason: 'the hash of its worker script is invalid' };
    removeOtherWorkerScripts(stateDir, hash, now());
    const found = readWorkerScript(stateDir, hash);
    if ('reason' in found) return found;
    return childPrepareWorker({ ...extra, script: found.script, hash });
  };
}
