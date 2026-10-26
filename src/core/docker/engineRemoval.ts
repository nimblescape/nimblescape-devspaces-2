// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// "Remove Devspaces from This Docker Engine…" (controller.ts): what Devspaces keeps on a Docker engine besides the
// devspaces, and its removal. With the Docker CLI of the extension (BootstrapDocker.run, within the operation: with the
// Docker context of the engine), never through the worker, which the removal ends: besides the bootstrap
// (bootstrapDocker.ts), the one place where the extension runs Docker commands without the worker. The caller checks
// first that the engine answers (Docker is never started for this). Removes, in this order: the Monitor containers, the
// helper containers (the workers of every window and their batch helpers), the helper images (never with force, and
// only their tags of devspaces-monitor and devspaces-worker), and the shared volumes. Never anything of a devspace: the
// caller deletes the user's own devspaces before, each as Delete does. Every item is logged with its outcome, and each
// one that is left with the command that removes it. No `vscode`.
import { CommandError, errorMessage } from '../errors';
import { HELPER_CACHE_VOLUME, LABEL_DEVSPACE_ID, LABEL_HELPER, LABEL_HELPER_RUN, VSCODE_STORE_VOLUME } from '../names';
import { isAbortError, type Logger, type RunOptions, type RunResult } from '../ports';
import { LABEL_MONITOR, LABEL_MONITOR_OWNER, REMOTE_MONITOR_VOLUME } from '../remoteMonitor/protocol';
import { isRecord } from '../valueChecks';
import { IMAGE_IN_USE_PATTERN, commandText, parseJsonLines, type BootstrapDocker } from './bootstrapDocker';
import { describeDockerHost } from './dockerHost';
import { DOCKER_QUERY_TIMEOUT_MS } from './dockerTimeouts';

/**
 * The volumes that the devspaces of an engine share: the Monitor's (its heartbeat records and the lock files of the
 * devspaces), the cache of the worker, and the store of the VS Code Server, which every dev container mounts.
 */
export const SHARED_VOLUMES: readonly string[] = [REMOTE_MONITOR_VOLUME, HELPER_CACHE_VOLUME, VSCODE_STORE_VOLUME];

/** The repositories of the tags of the helper images: the Monitor's second tag, then the worker's. */
const MONITOR_REPOSITORY = 'devspaces-monitor:';
const WORKER_REPOSITORY = 'devspaces-worker:';

/** Time limit of `docker volume rm`: the store of the VS Code Server can hold many files. */
export const VOLUME_REMOVE_TIMEOUT_MS = 5 * 60_000;

/** What Docker says of an object that is not there (anymore). */
const MISSING_PATTERN = /no such (container|image|volume|object)/i;
/** What Docker says when another removal of the container runs already (for example the `--rm` of a closing worker). */
const REMOVAL_IN_PROGRESS_PATTERN = /removal of container .* is already in progress/i;

export type RemovalOutcome = 'removed' | 'missing' | 'inUse' | 'failed';

export interface RemovalItem {
  kind: 'container' | 'image' | 'volume';
  /**
   * The container name, the image tag or ID, or the volume name; `label=<key>` for the containers or images of a
   * label that could not be listed.
   */
  name: string;
  outcome: RemovalOutcome;
  /** What Docker said (the end of its error output) of an item that is left. */
  detail?: string;
}

export interface RemovalResult {
  items: RemovalItem[];
  /** The removal ended before its last step: cancelled, or the engine stopped answering. */
  ended?: 'cancelled' | 'notAnswering';
}

/** What `docker ps --all` and `docker volume ls` list of an object: its ID (containers), name and labels. */
interface ListedObject {
  id: string;
  name: string;
  labels: ReadonlyMap<string, string>;
}

/** What the removal would remove, and whether others use Devspaces on the engine (read before the confirmation). */
export interface EngineInventory {
  /** The Monitor containers (label nimblescape.devspaces.monitor, any version), by name. */
  monitors: string[];
  /** The helper containers (label nimblescape.devspaces.worker-run): the workers and their batch helpers, by name. */
  helpers: string[];
  /** The helper images (label nimblescape.devspaces.worker=true), with their tags. */
  images: Array<{ id: string; tags: string[] }>;
  /** Of SHARED_VOLUMES, those that exist. */
  volumes: string[];
  /**
   * The IDs of the devspaces on the engine (label nimblescape.devspaces.id of its containers and volumes) that this
   * computer does not know: for example those of other computers.
   */
  unknownDevspaces: string[];
  /** A Monitor that another computer keeps running: its label nimblescape.devspaces.monitor-owner names another computer. */
  otherComputerMonitor: boolean;
}

/** True when the inventory found nothing of Devspaces besides devspaces. */
export function inventoryIsEmpty(inventory: EngineInventory): boolean {
  return inventory.monitors.length === 0 && inventory.helpers.length === 0 && inventory.images.length === 0 && inventory.volumes.length === 0;
}

/**
 * The labels of a line of `docker ps` or `docker volume ls` with `--format '{{json .}}'`: `key=value` pairs joined with
 * commas. A value with a comma is cut there; the values that this module reads (IDs) have none.
 */
function labelsOf(value: unknown): Map<string, string> {
  const labels = new Map<string, string>();
  if (typeof value !== 'string') return labels;
  for (const pair of value.split(',')) {
    const index = pair.indexOf('=');
    if (index > 0) labels.set(pair.slice(0, index), pair.slice(index + 1));
  }
  return labels;
}

/** A Docker call that only reads; throws CommandError when it fails. */
async function read(docker: Pick<BootstrapDocker, 'run'>, args: string[], signal: AbortSignal | undefined): Promise<string> {
  const options: RunOptions = { timeoutMs: DOCKER_QUERY_TIMEOUT_MS, ...(signal !== undefined ? { signal } : {}) };
  const result = await docker.run(args, options);
  if (result.exitCode !== 0 || result.timedOut) {
    throw new CommandError(commandText(args), result.exitCode, result.stdout, result.timedOut ? `${result.stderr}\nThe command did not end within the time limit.`.trim() : result.stderr);
  }
  return result.stdout;
}

/** The containers with the label `label` (any value), also those that do not run. */
async function containersWithLabel(docker: Pick<BootstrapDocker, 'run'>, label: string, signal: AbortSignal | undefined): Promise<ListedObject[]> {
  const stdout = await read(docker, ['ps', '--all', '--no-trunc', '--filter', `label=${label}`, '--format', '{{json .}}'], signal);
  return parseJsonLines(stdout).flatMap((item) =>
    isRecord(item) && typeof item.ID === 'string' && item.ID !== '' && typeof item.Names === 'string'
      ? [{ id: item.ID, name: item.Names, labels: labelsOf(item.Labels) }]
      : [],
  );
}

/** The volumes that `docker volume ls` lists with the filter `filter`. */
async function volumesWith(docker: Pick<BootstrapDocker, 'run'>, filter: string, signal: AbortSignal | undefined): Promise<ListedObject[]> {
  const stdout = await read(docker, ['volume', 'ls', '--filter', filter, '--format', '{{json .}}'], signal);
  return parseJsonLines(stdout).flatMap((item) => (isRecord(item) && typeof item.Name === 'string' && item.Name !== '' ? [{ id: item.Name, name: item.Name, labels: labelsOf(item.Labels) }] : []));
}

/** The images with the label nimblescape.devspaces.worker=true (also the dangling ones). */
async function helperImages(docker: Pick<BootstrapDocker, 'listImagesByLabel'>): Promise<Array<{ id: string; tags: string[] }>> {
  return (await docker.listImagesByLabel(`${LABEL_HELPER}=true`)).map((image) => ({ id: image.id, tags: [...image.tags] }));
}

/**
 * Lists what the removal would remove on the engine of the operation, and what shows that others use Devspaces there:
 * devspaces that `knownDevspaces` (the IDs of the devspaces of this computer) does not name, and a Monitor that another
 * computer than `computerId` keeps running. Only calls that read. Throws when a list fails.
 */
export async function engineInventory(
  docker: Pick<BootstrapDocker, 'run' | 'listImagesByLabel'>,
  options: { computerId: string; knownDevspaces: ReadonlySet<string>; signal?: AbortSignal },
): Promise<EngineInventory> {
  const { signal } = options;
  const monitors = await containersWithLabel(docker, LABEL_MONITOR, signal);
  const helpers = await containersWithLabel(docker, LABEL_HELPER_RUN, signal);
  const devspaceObjects = [...(await containersWithLabel(docker, LABEL_DEVSPACE_ID, signal)), ...(await volumesWith(docker, `label=${LABEL_DEVSPACE_ID}`, signal))];
  // `name` filters by a part of the name.
  const volumes = new Set((await volumesWith(docker, 'name=devspaces-', signal)).map((volume) => volume.name));
  const images = await helperImages(docker);
  const unknown = new Set<string>();
  for (const object of devspaceObjects) {
    const id = object.labels.get(LABEL_DEVSPACE_ID);
    if (id !== undefined && id !== '' && !options.knownDevspaces.has(id)) unknown.add(id);
  }
  return {
    monitors: monitors.map((container) => container.name),
    helpers: helpers.map((container) => container.name),
    images,
    volumes: SHARED_VOLUMES.filter((name) => volumes.has(name)),
    unknownDevspaces: [...unknown].sort(),
    otherComputerMonitor: monitors.some((container) => {
      const owner = container.labels.get(LABEL_MONITOR_OWNER);
      return owner !== undefined && owner !== '' && owner !== options.computerId;
    }),
  };
}

/** `docker` with `--context <context>` for a remote engine, so that a command of the log reaches the same engine. */
function dockerWord(context: string | undefined): string {
  return context === undefined ? 'docker' : `docker --context ${context}`;
}

/**
 * The command that removes an item that is left (`context`: the Docker context of a remote engine). For the containers
 * or images of a label that could not be listed (`label=<key>`), the command removes all of them; for the images with
 * `docker image prune`, which removes an image with all its tags and leaves an image that a container uses.
 */
export function manualCommand(item: Pick<RemovalItem, 'kind' | 'name'>, context?: string): string {
  const docker = dockerWord(context);
  const byLabel = item.name.startsWith('label=');
  switch (item.kind) {
    case 'container':
      return byLabel ? `${docker} rm -f $(${docker} ps -aq --filter ${item.name})` : `${docker} rm -f ${item.name}`;
    case 'image':
      return byLabel ? `${docker} image prune -a -f --filter ${item.name}` : `${docker} image rm ${item.name}`;
    case 'volume':
      return `${docker} volume rm ${item.name}`;
  }
}

/**
 * The commands that remove all that this removal removes, for the log of a removal that ended early. The section
 * "Uninstall" of docs/guide.md shows the same commands.
 */
export function uninstallCommands(context?: string): string[] {
  const docker = dockerWord(context);
  return [
    `${docker} rm -f $(${docker} ps -aq --filter label=${LABEL_MONITOR})`,
    `${docker} rm -f $(${docker} ps -aq --filter label=${LABEL_HELPER_RUN})`,
    `${docker} image prune -a -f --filter label=${LABEL_HELPER}`,
    `${docker} volume rm ${SHARED_VOLUMES.join(' ')}`,
  ];
}

/** The outcome of a removal call (its result, or the error of a call that could not run). */
function outcomeOf(result: RunResult | undefined): RemovalOutcome {
  if (result === undefined) return 'failed';
  if (result.exitCode === 0 && !result.timedOut) return 'removed';
  if (result.timedOut) return 'failed';
  const text = `${result.stderr}\n${result.stdout}`;
  if (MISSING_PATTERN.test(text)) return 'missing';
  if (REMOVAL_IN_PROGRESS_PATTERN.test(text)) return 'removed';
  if (IMAGE_IN_USE_PATTERN.test(text)) return 'inUse';
  return 'failed';
}

/** The end of what Docker said of a call that failed. */
function detailOf(result: RunResult): string {
  if (result.timedOut) return 'Docker did not answer in time.';
  return (result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`).slice(-500);
}

/** What an item is, for the progress and the log: `the container devspaces-monitor`. */
export function itemText(item: Pick<RemovalItem, 'kind' | 'name'>): string {
  if (item.name.startsWith('label=')) return `the ${item.kind}s with the ${item.name.replace('=', ' ')}`;
  return `the ${item.kind} ${item.name}`;
}

export interface RemovalOptions {
  /** Asked after a removal that failed: whether the engine still answers. When it does not, the removal ends. */
  answers(signal: AbortSignal | undefined): Promise<boolean>;
  logger: Logger;
  /** The Docker context of a remote engine, for the commands in the log. */
  context?: string;
  /** Before each removal, what it removes (itemText), for the progress. */
  onItem?(text: string): void;
  /** Cancel: the removal ends before its next call. */
  signal?: AbortSignal;
}

/** One removal: its items and why it ended early. */
class RemovalRun {
  readonly items: RemovalItem[] = [];
  ended: RemovalResult['ended'];

  constructor(
    private readonly docker: Pick<BootstrapDocker, 'run' | 'listImagesByLabel'>,
    private readonly options: RemovalOptions,
  ) {}

  result(): RemovalResult {
    return this.ended === undefined ? { items: this.items } : { items: this.items, ended: this.ended };
  }

  /** False when the run ends: cancelled. */
  private goOn(): boolean {
    if (this.options.signal?.aborted) this.ended ??= 'cancelled';
    return this.ended === undefined;
  }

  /** A list that failed: logged as an item that is left; false when the run ends (cancelled, or no answer). */
  private async listFailed(kind: RemovalItem['kind'], label: string, error: unknown): Promise<boolean> {
    if (isAbortError(error) || this.options.signal?.aborted) {
      this.ended ??= 'cancelled';
      return false;
    }
    return this.record({ kind, name: `label=${label}`, outcome: 'failed', detail: errorMessage(error).slice(-500) });
  }

  /** Logs `item`; after a failure, false when the engine does not answer anymore (the run ends). */
  private async record(item: RemovalItem): Promise<boolean> {
    this.items.push(item);
    const { logger, context } = this.options;
    const text = itemText(item);
    switch (item.outcome) {
      case 'removed':
        logger.info(`Removed ${text}.`);
        return true;
      case 'missing':
        logger.info(`${capitalized(text)} was not there anymore.`);
        return true;
      case 'inUse':
        logger.warn(`${capitalized(text)} is in use and was not removed (${item.detail ?? ''}). Remove it later with: ${manualCommand(item, context)}`);
        return true;
      case 'failed':
        logger.warn(`${capitalized(text)} could not be removed (${item.detail ?? ''}). Remove it with: ${manualCommand(item, context)}`);
        break;
    }
    let answers = false;
    try {
      answers = await this.options.answers(this.options.signal);
    } catch (error) {
      if (isAbortError(error) || this.options.signal?.aborted) {
        this.ended ??= 'cancelled';
        return false;
      }
      logger.warn(`Whether Docker still answers could not be checked: ${errorMessage(error)}`);
    }
    if (!answers) this.ended ??= 'notAnswering';
    return this.goOn();
  }

  /** Removes one item with `args`; false when the run ends. */
  async remove(kind: RemovalItem['kind'], name: string, args: string[], timeoutMs = DOCKER_QUERY_TIMEOUT_MS): Promise<boolean> {
    if (!this.goOn()) return false;
    this.options.onItem?.(itemText({ kind, name }));
    let result: RunResult | undefined;
    let error: unknown;
    try {
      result = await this.docker.run(args, { timeoutMs, ...(this.options.signal !== undefined ? { signal: this.options.signal } : {}) });
    } catch (caught) {
      error = caught;
    }
    if (isAbortError(error) || (result === undefined && this.options.signal?.aborted)) {
      this.ended ??= 'cancelled';
      return false;
    }
    const outcome = outcomeOf(result);
    const detail = result !== undefined ? detailOf(result) : errorMessage(error);
    return this.record({ kind, name, outcome, ...(outcome === 'inUse' || outcome === 'failed' ? { detail } : {}) });
  }

  /** `docker rm -f` of each container with the label `label`, listed now. False when the run ends. */
  async containers(label: string): Promise<boolean> {
    if (!this.goOn()) return false;
    let containers: ListedObject[];
    try {
      containers = await containersWithLabel(this.docker, label, this.options.signal);
    } catch (error) {
      return this.listFailed('container', label, error);
    }
    for (const container of containers) {
      // By its ID (a name can change); the log names it.
      if (!(await this.remove('container', container.name, ['rm', '-f', container.id]))) return false;
    }
    return true;
  }

  /**
   * `docker image rm` (never with force) of the helper images, listed now: the tags of devspaces-monitor first, then
   * those of devspaces-worker (the last tag of an image removes the image), then the images without a tag, by ID. A
   * tag of another repository stays, and with it its image. False when the run ends.
   */
  async images(): Promise<boolean> {
    if (!this.goOn()) return false;
    let images: Array<{ id: string; tags: string[] }>;
    try {
      images = await helperImages(this.docker);
    } catch (error) {
      return this.listFailed('image', `${LABEL_HELPER}=true`, error);
    }
    const tags = images.flatMap((image) => image.tags);
    const ordered = [
      ...tags.filter((tag) => tag.startsWith(MONITOR_REPOSITORY)),
      ...tags.filter((tag) => tag.startsWith(WORKER_REPOSITORY)),
      ...images.filter((image) => image.tags.length === 0).map((image) => image.id),
    ];
    for (const reference of ordered) {
      if (!(await this.remove('image', reference, ['image', 'rm', reference]))) return false;
    }
    return true;
  }
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Removes what Devspaces keeps on the engine of the operation (see the module comment), each item listed right before
 * its step, so an item that appeared after the confirmation goes too. An item that fails does not stop the later ones;
 * after a failure, the removal ends when the engine does not answer anymore (`answers`). Never throws.
 */
export async function removeEngineInfrastructure(docker: Pick<BootstrapDocker, 'run' | 'listImagesByLabel'>, options: RemovalOptions): Promise<RemovalResult> {
  const run = new RemovalRun(docker, options);
  // The Monitor first: it starts batch helpers of its own for its background run.
  if (!(await run.containers(LABEL_MONITOR))) return finish(run, options);
  // The workers of every window (also of other computers on a shared engine) and their batch helpers.
  if (!(await run.containers(LABEL_HELPER_RUN))) return finish(run, options);
  if (!(await run.images())) return finish(run, options);
  for (const volume of SHARED_VOLUMES) {
    if (!(await run.remove('volume', volume, ['volume', 'rm', volume], VOLUME_REMOVE_TIMEOUT_MS))) return finish(run, options);
  }
  return finish(run, options);
}

/** The result; for a removal that ended early, the log names the commands that remove the rest. */
function finish(run: RemovalRun, options: RemovalOptions): RemovalResult {
  const result = run.result();
  if (result.ended !== undefined) options.logger.warn(removalEndedNote(result.ended, options.context));
  return result;
}

/**
 * The log line of a removal that ended early (`ended`): why, and the commands that remove the rest
 * (uninstallCommands, with the Docker context `context` of a remote engine). Also for a removal that the user
 * cancelled while it deleted the devspaces, before anything else was removed (Controller.removeFromEngine).
 */
export function removalEndedNote(ended: NonNullable<RemovalResult['ended']>, context?: string): string {
  const why = ended === 'cancelled' ? 'The removal was cancelled.' : 'The removal ended: Docker does not answer anymore.';
  return `${why} The rest can be removed with these commands (the error "requires at least 1 argument" means there is nothing to remove):\n${uninstallCommands(context).join('\n')}`;
}

/**
 * The log line of a refusal while the engine `engine` (describeDockerHost) has the removal mark: the background work
 * of this computer there waits for the user.
 */
export function removedEngineNote(engine: string): string {
  return `Devspaces was removed from ${engine}. Nothing runs there by itself until a Start, a Rebuild or "Update All Images Now" there.`;
}

/**
 * The log line when an operation that keeps the removal mark (a Stop or a Delete of a devspace that the user kept)
 * built the helper image on the engine `engine` (describeDockerHost) again.
 */
export function removedEngineImageNote(engine: string): string {
  return `The helper image was built again on ${engine}, which Devspaces was removed from. Nothing runs there by itself; "Remove Devspaces from This Docker Engine…" removes it again.`;
}

/**
 * The refresh of the sidebar reads no states on the engine `host` ('' for the local Docker) while it has the removal
 * mark (extension.ts reads the mark); its message is removedEngineNote. DevspaceOperations.refreshStates logs it once
 * per engine in a window.
 */
export class RemovedEngineError extends Error {
  constructor(readonly host: string) {
    super(removedEngineNote(describeDockerHost(host)));
    this.name = 'RemovedEngineError';
  }
}
