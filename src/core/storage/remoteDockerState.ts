// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// What Devspaces remembers about remote Docker hosts, in `remote-docker.json` of the global storage folder: its own list
// of SSH hosts, the Docker host of Devspaces (one host of the list, or none for the local Docker), the hosts of Docker
// contexts that it offered once, and per host the socket of a rootless engine there (the source of the helper's socket
// mount on that computer). Devspaces creates and changes no Docker context (docs/architecture.md "Remote Docker
// hosts"). Every window of this computer changes the file: each change reads and writes it under the lock folder
// `remote-docker.lock` (lockFolder.ts), so that a change of another window between the read and the write is not lost.
import * as fs from 'fs';
import * as path from 'path';
import { silentLogger, type Logger } from '../ports';
import { readJson, writeJsonAtomic } from './atomicJson';
import { DEFAULT_LOCK_STALE_MS, DEFAULT_LOCK_TIMEOUT_MS, LockLostError, withLockFolder, type LockTimings } from './lockFolder';
import { parseJson, readTextFile, retryTransient } from './paths';

export interface RemoteDockerHostRecord {
  host: string;
  /** The Docker socket of a rootless engine on that computer, for example `/run/user/1000/docker.sock`. */
  rootlessSocket?: string;
}

export interface RemoteDockerStateFile {
  /** The Docker host of Devspaces: a host of `remoteHosts`. Absent: the local Docker. */
  dockerHost?: string;
  /** The list of SSH hosts of Devspaces (an alias of the SSH config, or `user@host[:port]`), in the order they were added. */
  remoteHosts?: string[];
  /** The hosts of a Docker context or of DOCKER_HOST that Devspaces offered once for the list (claimOffer). */
  offered?: string[];
  hosts?: RemoteDockerHostRecord[];
}

export class RemoteDockerState {
  /** The lock folder of the changes: `<name>.lock` next to the file (`remote-docker.lock`). */
  readonly lockDir: string;
  private readonly lockTimings: LockTimings = { staleMs: DEFAULT_LOCK_STALE_MS, timeoutMs: DEFAULT_LOCK_TIMEOUT_MS };

  constructor(
    readonly file: string,
    private readonly logger: Logger = silentLogger,
  ) {
    this.lockDir = path.join(path.dirname(file), `${path.basename(file, '.json')}.lock`);
  }

  /** The file as it is now; a missing file or one that is not valid knows nothing. A read needs no lock (atomic writes). */
  async read(): Promise<RemoteDockerStateFile> {
    return normalize(await readJson<unknown>(this.file));
  }

  /** The Docker host of Devspaces: a host of the list, or undefined for the local Docker. */
  async dockerHost(): Promise<string | undefined> {
    return (await this.read()).dockerHost;
  }

  /** The SSH hosts of the list, in the order they were added. */
  async remoteHosts(): Promise<string[]> {
    return (await this.read()).remoteHosts ?? [];
  }

  /**
   * Makes `host` the Docker host of Devspaces (added to the end of the list when it is not in it), or with `undefined`
   * the local Docker. Writes only when something changes.
   */
  async setDockerHost(host: string | undefined): Promise<void> {
    await this.change((state) => {
      const hosts = state.remoteHosts ?? [];
      const listed = host === undefined || hosts.includes(host);
      if (state.dockerHost === host && listed) return false;
      if (host === undefined) delete state.dockerHost;
      else state.dockerHost = host;
      if (!listed) state.remoteHosts = [...hosts, host];
      return true;
    });
  }

  /**
   * Removes `host` from the list; when it is the Docker host of Devspaces, the local Docker takes its place. Its rootless
   * socket and the devspaces on it stay. `removed`: it was in the list; `wasDockerHost`: it was the Docker host of
   * Devspaces (both as found under the lock).
   */
  async removeHost(host: string): Promise<{ removed: boolean; wasDockerHost: boolean }> {
    let result = { removed: false, wasDockerHost: false };
    await this.change((state) => {
      // Set on each run: the last run counts (change).
      const hosts = state.remoteHosts ?? [];
      result = { removed: hosts.includes(host) || state.dockerHost === host, wasDockerHost: state.dockerHost === host };
      if (!result.removed) return false;
      const rest = hosts.filter((entry) => entry !== host);
      if (rest.length > 0) state.remoteHosts = rest;
      else delete state.remoteHosts;
      if (state.dockerHost === host) delete state.dockerHost;
      return true;
    });
    return result;
  }

  /**
   * The offer of `host` of a Docker context or of DOCKER_HOST (offerDockerContextHost), once on this computer: true, and
   * `host` is remembered, when it is neither in the list nor offered before; false otherwise. The check and the write
   * run under the lock, so that of several windows that start at the same time only one asks.
   */
  async claimOffer(host: string): Promise<boolean> {
    let claimed = false;
    await this.change((state) => {
      claimed = !(state.remoteHosts ?? []).includes(host) && !(state.offered ?? []).includes(host);
      if (!claimed) return false;
      state.offered = [...(state.offered ?? []), host];
      return true;
    });
    return claimed;
  }

  /** The socket of the rootless engine on `host`, or undefined for a rootful engine (the default socket). */
  async rootlessSocket(host: string): Promise<string | undefined> {
    return (await this.read()).hosts?.find((record) => record.host === host)?.rootlessSocket;
  }

  /** Records (or with `undefined` forgets) the rootless socket of `host`. Writes only when it changes. */
  async setRootlessSocket(host: string, socket: string | undefined): Promise<void> {
    await this.change((state) => {
      const hosts = state.hosts ?? [];
      const record = hosts.find((entry) => entry.host === host);
      if (record?.rootlessSocket === socket) return false;
      if (socket === undefined) {
        if (!record) return false;
        state.hosts = hosts.filter((entry) => entry !== record);
      } else if (record) {
        record.rootlessSocket = socket;
      } else {
        state.hosts = [...hosts, { host, rootlessSocket: socket }];
      }
      return true;
    });
  }

  /**
   * Changes the file: `update` changes the state that was read and returns whether to write it. A first run on the file
   * without the lock decides whether there is anything to write (most calls change nothing, for example the rootful
   * engine at each Docker start); only then the read and the write run under the lock folder `lockDir`. If another
   * process took over the lock meanwhile (this process stalled longer than the stale time, see withLockFolder), nothing
   * is written and the whole change runs once more on the current file, as for registry.json. So `update` runs up to
   * three times, and its last run counts. Throws, and writes nothing, when the lock is not free within the wait or the
   * file cannot be read (readForChange).
   */
  private async change(update: (state: RemoteDockerStateFile) => boolean): Promise<void> {
    if (!update(await this.read())) return;
    const run = () =>
      withLockFolder(
        this.lockDir,
        async (held) => {
          const { state, invalid } = await this.readForChange();
          if (!update(state)) return;
          const checkHeld = async (): Promise<void> => {
            if (!(await held())) throw new LockLostError(this.lockDir);
          };
          await checkHeld();
          if (invalid) await this.keepCopy();
          await retryTransient(() => writeJsonAtomic(this.file, state, { beforeRename: checkHeld }));
        },
        this.lockTimings,
      );
    try {
      await run();
    } catch (error) {
      if (!(error instanceof LockLostError)) throw error;
      this.logger.warn(`${error.message} The change of the remote Docker hosts runs again on the current file.`);
      await run();
    }
  }

  /**
   * The file for a change: a transient error of Windows is tried again, and any other error of the read is thrown
   * (readTextFile), so that a change never writes over a list that it could not read. A file that is not valid JSON
   * knows nothing (`invalid`: a copy is kept before the write).
   */
  private async readForChange(): Promise<{ state: RemoteDockerStateFile; invalid: boolean }> {
    const text = await readTextFile(this.file);
    if (text === undefined) return { state: {}, invalid: false };
    const value = parseJson(text);
    return { state: normalize(value), invalid: value === undefined };
  }

  /** Keeps a copy of a file that is not valid before a change writes over it: `<file>.backup-<time>`. */
  private async keepCopy(): Promise<void> {
    const copy = `${this.file}.backup-${Date.now()}`;
    await retryTransient(() => fs.promises.copyFile(this.file, copy));
    this.logger.warn(`The list of the remote Docker hosts was not valid, so it counts as empty. A copy was saved as ${copy}.`);
  }
}

/** A list of host names without repeats or empty entries; undefined when none is left. */
function hostNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && entry !== ''))];
  return names.length > 0 ? names : undefined;
}

/**
 * The fields of the file that Devspaces knows; others are dropped at the next write. A Docker host that is not in the
 * list is added to it.
 */
function normalize(value: unknown): RemoteDockerStateFile {
  const result: RemoteDockerStateFile = {};
  if (typeof value !== 'object' || value === null) return result;
  const record = value as Record<string, unknown>;
  const remoteHosts = hostNames(record.remoteHosts);
  if (typeof record.dockerHost === 'string' && record.dockerHost !== '') {
    result.dockerHost = record.dockerHost;
    result.remoteHosts = remoteHosts?.includes(record.dockerHost) ? remoteHosts : [...(remoteHosts ?? []), record.dockerHost];
  } else if (remoteHosts !== undefined) {
    result.remoteHosts = remoteHosts;
  }
  const offered = hostNames(record.offered);
  if (offered !== undefined) result.offered = offered;
  if (Array.isArray(record.hosts)) {
    result.hosts = record.hosts.flatMap((entry): RemoteDockerHostRecord[] => {
      if (typeof entry !== 'object' || entry === null) return [];
      const { host, rootlessSocket } = entry as Record<string, unknown>;
      if (typeof host !== 'string' || host === '') return [];
      return [typeof rootlessSocket === 'string' && rootlessSocket.startsWith('/') ? { host, rootlessSocket } : { host }];
    });
  }
  return result;
}
