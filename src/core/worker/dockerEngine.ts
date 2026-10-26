// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The one port through which a flow in the worker acts on its engine (one way of commanding Docker). It is implemented
// over the Docker Engine API (src/helperChannel/engineClient.ts); there is no `docker` process of our own behind it.
// The Docker CLI and Docker Compose run only as tools of the Dev Container CLI in the batch helper, and in the
// extension only for the bootstrap. Pure types and checks; no I/O, no `vscode`.
import { LABEL_COMPOSE_SERVICE } from '../names';
import type { ContainerInfo } from '../docker/dockerObjects';
import type { EngineIdentity } from '../helperChannel/protocol';
import type { StartedProcess } from '../ports';

/**
 * The types of createAttached, here with the port that uses them. How the attached create of the monitor ended: its
 * ready line, its end (with a name conflict), the time limit, a cancel.
 */
export type MonitorCreated = { kind: 'ready' } | { kind: 'exited'; detail: string; conflict: boolean } | { kind: 'timeout' } | { kind: 'aborted' };

/** The container of the monitor as its create makes it (RemoteSessionMonitor.runSpec). */
export interface MonitorRunSpec {
  name: string;
  /** The helper tag, or the checked image ID of the helper image, or its monitor tag (never pulled). */
  image: string;
  /**
   * The image ID that the container must have when `image` is a tag (the monitor tag of the pinned helper image). The
   * create checks it before the start; another image is a failure of the create (`exited`), and the caller removes the
   * container by its labels.
   */
  imageId?: string;
  labels: Record<string, string>;
  /**
   * `on-failure`, or `unless-stopped` for a monitor that runs permanently (monitorRestartPolicy).
   */
  restartPolicy: 'on-failure' | 'unless-stopped';
  /**
   * The monitor always gets the default network (outbound only: the VS Code server of its background run and the image
   * maintenance; it publishes no port).
   */
  network: 'none' | 'default';
  /** The json-file driver with two files of at most 1 MB. */
  log: { driver: 'json-file'; maxSize: string; maxFile: string };
  /**
   * The socket of the engine and the state volume, and the shared VS Code server store of the engine (`store`: its
   * volume, read-write at its target, with `nocopy` as the worker mounts it), when the worker has one.
   */
  mounts: { socket: string; volume: string; volumeTarget: string; store?: { volume: string; target: string } };
  env: Record<string, string>;
  /** The pipe loader with the path, the hash of the script and its entry (loaderCommand). */
  command: string[];
}

/**
 * A container as a flow needs it: the pipeline's ContainerInfo (one shape, read by toContainerInfo of
 * dockerObjects.ts), with what `docker inspect` adds for the flows.
 */
export interface EngineContainer extends ContainerInfo {
  exitCode?: number;
  restartCount?: number;
  /** When the daemon created it (`Created`, RFC 3339). */
  created?: string;
}

/**
 * A container as the list of the engine gives it (`GET /containers/json`, what `docker ps` reads), without an inspect.
 */
export interface EngineContainerSummary {
  /** Its full ID. */
  id: string;
  /** Its first name, without the leading `/`; empty when the list names none. */
  name: string;
  /** Its state as the list names it (`State`: `running`, `exited`, `paused`, …, as `{{.State}}` of `docker ps`); empty when it names none. */
  state: string;
  labels: Record<string, string>;
}

/** The kinds of objects whose inspect JSON the port reads. */
export type EngineObjectKind = 'container' | 'image' | 'volume' | 'network';

/** The filters of a list request of the Engine API (`label`, `reference`, `dangling`, …). */
export type EngineFilters = Readonly<Record<string, readonly string[]>>;

/** An image of a list (`GET /images/json`). */
export interface EngineImage {
  /** Its full ID (`sha256:…`). */
  id: string;
  /** Its references `repository:tag` (none for a dangling image). */
  repoTags: string[];
  repoDigests: string[];
  labels: Record<string, string>;
  /** When it was created (RFC 3339). */
  created: string;
}

/** The registry login of a pull; the password or identity token is the secret `secretName` of the operation. */
export interface EnginePullLogin {
  serveraddress: string;
  /** Absent for an identity token. */
  username?: string;
  identityToken?: boolean;
  secretName: string;
}

/** What `exec` ran: the exit code of the process, and what it wrote. */
export interface EngineExecResult {
  /** `null` when the process ended through a signal. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True when the time limit ended it. */
  timedOut: boolean;
}

/** The options of `exec` (the one primitive through which every script runs in a container). */
export interface EngineExecOptions {
  /** The user of the process, as `docker exec -u` takes it. */
  user?: string;
  /** Its working folder. */
  workdir?: string;
  /** Its standard input, then closed. */
  input?: string;
  /**
   * The name of the secret of the operation (OperationContext.secrets) whose value is its standard input instead: never
   * an argument, never a log line. A name, not a value; an exec fails when the operation holds no such secret.
   */
  secretInputName?: string;
  /**
   * The output as it comes, in addition to the result. Masked with every secret of the operation, like the result; a
   * tail that could start a secret comes with the next piece.
   */
  onOutput?: (stream: 'stdout' | 'stderr', text: string) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** The proxy of the daemon, as `docker info` shows it (Docker masks a password in it as `xxxxx`). */
export interface EngineProxy {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
}

/** A mount of an attached run (`--mount type=<type>,source=<source>,target=<target>` of `docker run`). */
export interface EngineMount {
  type: 'volume' | 'bind';
  source: string;
  target: string;
}

/**
 * A container that DockerEngine.runAttached runs as `docker run --rm -i` would: the image by its ID and never pulled,
 * the command as the arguments after the image (the entrypoint of the image stays), the labels, the mounts, the tmpfs
 * mounts with their options, the security options, no log of the engine, and the default network. No variable: a secret
 * or a script goes only to the standard input of the process.
 */
export interface EngineAttachedSpec {
  name: string;
  image: string;
  command: readonly string[];
  labels: Readonly<Record<string, string>>;
  mounts: readonly EngineMount[];
  /** The target of each tmpfs mount, with its options (`--tmpfs <target>:<options>`). */
  tmpfs: Readonly<Record<string, string>>;
  securityOpt: readonly string[];
}

/** The options of DockerEngine.runAttached. */
export interface EngineAttachedOptions {
  /** Ends the run: before it started, nothing runs (the call rejects with an AbortError); after, as `process.kill()`. */
  signal?: AbortSignal;
  /** The time from the SIGTERM of `process.kill()` to its SIGKILL (as `docker stop -t`); 10 s when not given. */
  stopSeconds?: number;
}

/**
 * A container that runs attached (DockerEngine.runAttached). `process` is its standard input and output as a process of
 * this worker: `end` closes its input (the engine closes it in the container, StdinOnce), `kill` stops it (SIGTERM,
 * then SIGKILL after `stopSeconds`) and removes it, and `exited` resolves with its exit code once it ended (null with
 * `error` when that cannot be read). `pause` and `resume` stop and resume the reading of its output.
 */
export interface EngineAttachedRun {
  /** Its full ID. */
  id: string;
  process: StartedProcess;
  pause(): void;
  resume(): void;
}

/**
 * The port of the engine. Every method here is one request to the Engine API, and every script that runs in a container
 * goes through `exec` (containerScripts.ts). Each method rejects with an EngineError, or with an AbortError when the
 * signal aborts.
 */
export interface DockerEngine {
  /** The container `reference` (a name or an ID), or undefined when it does not exist. */
  container(reference: string, signal?: AbortSignal): Promise<EngineContainer | undefined>;
  /** The containers with the label `label` (`<key>` or `<key>=<value>`), stopped ones included. */
  containers(label: string, signal?: AbortSignal): Promise<EngineContainer[]>;
  /**
   * The containers with the label `label` (`<key>` or `<key>=<value>`), stopped ones included, as the list of the
   * engine gives them, with no inspect (`containers` inspects each one): an inspect takes the lock of the container,
   * which a start holds until it ends, and fails for a container whose layer is broken, while the list, as `docker ps`,
   * reads neither. An entry without an ID is left out. The Monitor's loop reads its containers only so.
   */
  containerSummaries(label: string, signal?: AbortSignal): Promise<EngineContainerSummary[]>;
  /** One process in a running container (the one primitive for the scripts of containerScripts.ts). */
  exec(container: string, command: readonly string[], options?: EngineExecOptions): Promise<EngineExecResult>;
  /**
   * Stops the container (SIGTERM, then SIGKILL after `timeoutSeconds`, or after its own stop time when it is not given,
   * as `docker stop`); a container that is not running is left alone.
   */
  stop(container: string, timeoutSeconds?: number, signal?: AbortSignal): Promise<void>;
  /** Starts the container; one that runs already is left alone. */
  start(container: string, signal?: AbortSignal): Promise<void>;
  /**
   * Changes the restart policy of the container (`POST /containers/<id>/update`, as `docker update --restart`); a
   * running container goes on, and the new policy counts from its next end. The Monitor sets `no` before it ends itself
   * (src/remoteMonitor/main.ts).
   */
  updateRestartPolicy(container: string, policy: 'no' | 'on-failure' | 'unless-stopped', signal?: AbortSignal): Promise<void>;
  /**
   * The API version (`GET /version`, for example `1.48`) and the version of the engine (empty when the engine names
   * none). The version is also the answer of the worker's probe (ProbeValue).
   */
  version(signal?: AbortSignal): Promise<{ apiVersion: string; version: string }>;
  /**
   * The identity of the engine (`GET /info`: its `ID` and `DockerRootDir`), which the probe of the worker answers so
   * that the extension can check that the worker reaches the engine of the target. Rejects with an EngineError when the
   * answer has no such identity (parseEngineIdentity).
   */
  identity(signal?: AbortSignal): Promise<EngineIdentity>;
  /**
   * Removes the stopped containers that match `filters` (`POST /containers/prune`, as `docker container prune -f
   * --filter …`; a running container is never removed), and answers the IDs of the removed ones.
   */
  pruneContainers(filters: EngineFilters, signal?: AbortSignal): Promise<string[]>;
  /** The inspect JSON of an object (the same as `docker inspect`), or undefined when it does not exist. */
  inspect(kind: EngineObjectKind, reference: string, signal?: AbortSignal): Promise<unknown>;
  /** The full IDs of the containers that match `filters`, stopped ones included. */
  containerIds(filters: EngineFilters, signal?: AbortSignal): Promise<string[]>;
  /** The images that match `filters` (`dangling` included only when asked for). */
  images(filters: EngineFilters, signal?: AbortSignal): Promise<EngineImage[]>;
  /** The names of the volumes that match `filters`. */
  volumeNames(filters: EngineFilters, signal?: AbortSignal): Promise<string[]>;
  /** The names of the networks that match `filters`. */
  networkNames(filters: EngineFilters, signal?: AbortSignal): Promise<string[]>;
  /** Removes a container, running or not (`docker rm -f`); a missing one is no failure. */
  removeContainer(container: string, signal?: AbortSignal): Promise<void>;
  /** Renames a container (`docker rename`). */
  renameContainer(container: string, name: string, signal?: AbortSignal): Promise<void>;
  /** Removes an image without force: `missing` and `inUse` (409) are answers, not failures. */
  removeImage(reference: string, signal?: AbortSignal): Promise<'removed' | 'missing' | 'inUse'>;
  /** Tags the image `image` (an ID) as `reference` (`repository:tag`); a tag of another image moves. */
  tagImage(image: string, reference: string, signal?: AbortSignal): Promise<void>;
  /** Creates a volume with its labels; an existing one of the name is kept as it is (as `docker volume create`). */
  createVolume(name: string, labels: Record<string, string>, signal?: AbortSignal): Promise<void>;
  /** Removes a volume; a missing one is no failure, one in use is (409). */
  removeVolume(name: string, signal?: AbortSignal): Promise<void>;
  /** Removes a network; a missing one is no failure, one in use is. */
  removeNetwork(name: string, signal?: AbortSignal): Promise<void>;
  /**
   * Pulls `reference` (`POST /images/create`), the login only in the header X-Registry-Auth; each line of `docker pull`
   * goes to `onLine`. Throws with the message of the engine when the pull fails.
   */
  pull(reference: string, options?: { login?: EnginePullLogin; onLine?: (line: string) => void; signal?: AbortSignal }): Promise<void>;
  /**
   * Gives the image `image` the labels `labels` without a build (no extra containers where the API suffices): a
   * container is created from it (never started), committed under the same name with `LABEL` changes, and removed.
   * Answers the ID of the new image.
   */
  labelImage(image: string, labels: Record<string, string>, signal?: AbortSignal): Promise<string>;
  /**
   * The content of the regular file at the absolute path `path` of the image `image`, as UTF-8 text, read without
   * running anything (no extra containers where the API suffices): a container is created from the image (never
   * started), the file is read through `GET /containers/<id>/archive`, and the container is removed. Undefined when the
   * path is missing, is no regular file (a link, a folder), or is larger than MAX_IMAGE_FILE_BYTES; rejects with an
   * EngineError for a missing image and the other failures.
   */
  imageFile(image: string, path: string, signal?: AbortSignal): Promise<string | undefined>;
  /**
   * The bytes of the regular file at the absolute path `path` of the container `container` (its name or ID), read
   * through `GET /containers/<id>/archive` as `docker cp` does: nothing runs in the container, so the read works in any
   * of its states (running, restarting, exited). `missing` when the engine answers that the container or the path does
   * not exist (404 with the message of a missing container or file). Undefined when the path is no regular file (a
   * link, a folder), the file is larger than `maxBytes`, or the answer is longer than can be read; rejects with an
   * EngineError for every other failure, also for a 404 without such a message.
   */
  containerFile(container: string, path: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer | 'missing' | undefined>;
  /** The clock of the daemon (`GET /info`, its SystemTime as Docker writes it). */
  systemTime(signal?: AbortSignal): Promise<string>;
  /**
   * The proxy of the daemon (`GET /info`: HttpProxy, HttpsProxy, NoProxy), an empty one left out; the worker's outbound
   * requests use it.
   */
  proxy(signal?: AbortSignal): Promise<EngineProxy>;
  /**
   * The architecture of the engine's host (`GET /info`, its `Architecture` as the daemon writes it, for example
   * `x86_64` or `aarch64`); rejects with an EngineError when the answer has none.
   */
  architecture(signal?: AbortSignal): Promise<string>;
  /**
   * The processes of a running container as the engine lists them (`GET
   * /containers/<id>/top`, `ps -ef` in its namespace, read from the host: nothing runs in the container), each the fields
   * of its line (the last one its command line). Undefined when the container does not exist or does not run (404, 409);
   * rejects with an EngineError for any other failure, an answer that is too long, or one of another form.
   */
  processes(container: string, signal?: AbortSignal): Promise<string[][] | undefined>;
  /**
   * For the Monitor container, loaded through a pipe: creates the container of `spec` with an open input,
   * attaches to it, starts it, writes `input`, and waits for `readyText` on its output, its end, `timeoutMs`, or the
   * cancellation; then its input is closed (the container goes on alone). A create that the engine refuses is `exited`
   * (`conflict`: the name is in use); any other failure after the create request was sent is `exited`, `timeout`
   * (`timeoutMs` covers the create request too) or `aborted`, so the caller removes the container of this create by its
   * labels. Rejects only when nothing was sent.
   */
  createAttached(spec: MonitorRunSpec, options: { input: string; readyText: string; timeoutMs: number; signal?: AbortSignal }): Promise<MonitorCreated>;
  /**
   * `docker run --rm -i` of `spec` over the API (no `docker` process of the worker's own): the create with an open
   * input and AutoRemove, the attach (stdin, stdout, stderr) over a hijacked connection, the wait for its removal, and
   * the start; the run goes on until it ends or is killed. Rejects with an EngineError when the engine refuses a
   * request (409 for a name in use, 404 for a missing image), and with an AbortError when the signal aborts first; the
   * container of a create that answered is then removed (by its ID). When the create itself did not answer, the caller
   * removes what it may have created by its labels.
   */
  runAttached(spec: EngineAttachedSpec, options?: EngineAttachedOptions): Promise<EngineAttachedRun>;
}

/** The largest file that DockerEngine.imageFile reads (in bytes). */
export const MAX_IMAGE_FILE_BYTES = 512 * 1024;

/** A failure of the engine: its message, and the HTTP status that it answered with. */
export class EngineError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

/** True when the engine answered that the container, image, volume or network does not exist. */
export function isMissing(error: unknown): boolean {
  return error instanceof EngineError && error.status === 404;
}

/**
 * True when the engine refused an exec because its container does not exist (404 "No such container") or does not run
 * (409 "is not running"). Not for a restarting or paused container, another 404 (for example "No such exec instance"),
 * or another status. One rule for the token removal (tokenRemoveFlow) and the commands in the Monitor container
 * (monitorFlow).
 */
export function isNotRunning(error: unknown): boolean {
  if (!(error instanceof EngineError)) return false;
  if (error.status === 404) return /no such container/i.test(error.message);
  return error.status === 409 && /is not running/i.test(error.message);
}

/**
 * Whether a container of a devspace is its dev container: without the label nimblescape.devspaces.compose-service of
 * the other services of Docker Compose, or with the name of the devspace.
 */
export function isDevContainer(container: { name: string; labels: Record<string, string> }, containerName: string): boolean {
  return container.labels[LABEL_COMPOSE_SERVICE] === undefined || container.name === containerName;
}
