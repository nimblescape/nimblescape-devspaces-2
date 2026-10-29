// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// What Devspaces remembers about remote Docker hosts, in `remote-docker.json` of the global storage folder: its own list
// of SSH hosts, the Docker host of Devspaces (one host of the list, or none for the local Docker), the hosts of Docker
// contexts that it offered once, and per host the socket of a rootless engine there (the source of the helper's socket
// mount on that computer). Devspaces creates and changes no Docker context (docs/architecture.md "Remote Docker
// hosts").
import { readJson, writeJsonAtomic } from './atomicJson';

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
  /** The hosts of a Docker context or of DOCKER_HOST that Devspaces offered once for the list (offerDockerContextHost). */
  offered?: string[];
  hosts?: RemoteDockerHostRecord[];
}

export class RemoteDockerState {
  constructor(readonly file: string) {}

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
    const state = await this.read();
    const hosts = state.remoteHosts ?? [];
    const listed = host === undefined || hosts.includes(host);
    if (state.dockerHost === host && listed) return;
    if (host === undefined) delete state.dockerHost;
    else state.dockerHost = host;
    if (!listed) state.remoteHosts = [...hosts, host];
    await writeJsonAtomic(this.file, state);
  }

  /**
   * Removes `host` from the list; when it is the Docker host of Devspaces, the local Docker takes its place. Its rootless
   * socket and the devspaces on it stay. True when it was in the list.
   */
  async removeHost(host: string): Promise<boolean> {
    const state = await this.read();
    const hosts = state.remoteHosts ?? [];
    if (!hosts.includes(host) && state.dockerHost !== host) return false;
    const rest = hosts.filter((entry) => entry !== host);
    if (rest.length > 0) state.remoteHosts = rest;
    else delete state.remoteHosts;
    if (state.dockerHost === host) delete state.dockerHost;
    await writeJsonAtomic(this.file, state);
    return true;
  }

  /** True when Devspaces offered `host` of a Docker context or of DOCKER_HOST once already. */
  async wasOffered(host: string): Promise<boolean> {
    return (await this.read()).offered?.includes(host) ?? false;
  }

  /** Remembers that `host` was offered (wasOffered). */
  async setOffered(host: string): Promise<void> {
    const state = await this.read();
    if (state.offered?.includes(host)) return;
    state.offered = [...(state.offered ?? []), host];
    await writeJsonAtomic(this.file, state);
  }

  /** The socket of the rootless engine on `host`, or undefined for a rootful engine (the default socket). */
  async rootlessSocket(host: string): Promise<string | undefined> {
    return (await this.read()).hosts?.find((record) => record.host === host)?.rootlessSocket;
  }

  /** Records (or with `undefined` forgets) the rootless socket of `host`. Writes only when it changes. */
  async setRootlessSocket(host: string, socket: string | undefined): Promise<void> {
    const state = await this.read();
    const hosts = state.hosts ?? [];
    const record = hosts.find((entry) => entry.host === host);
    if (record?.rootlessSocket === socket) return;
    if (socket === undefined) {
      if (!record) return;
      state.hosts = hosts.filter((entry) => entry !== record);
    } else if (record) {
      record.rootlessSocket = socket;
    } else {
      state.hosts = [...hosts, { host, rootlessSocket: socket }];
    }
    await writeJsonAtomic(this.file, state);
  }
}

/** A list of host names without repeats or empty entries; undefined when none is left. */
function hostNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && entry !== ''))];
  return names.length > 0 ? names : undefined;
}

/**
 * The fields of the file that Devspaces knows; others (for example `previousContext` and `dontAsk` of the versions that
 * switched the Docker context) are dropped at the next write. A Docker host that is not in the list is added to it.
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
