// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The address of the Docker pipe of a devspace window (docs/architecture.md "The Docker pipe"): the Dev Containers
// extension gets it as `settings.host` in the authority of the window (DOCKER_HOST of its Docker calls), and the
// extension serves it in that window (dockerPipe.ts). On Windows a named pipe `\\.\pipe\devspaces-<id>`; elsewhere a
// Unix socket `docker.sock` in a private folder `devspaces-<id>`. The id is the start of a SHA-256 of the ID of this
// computer, the Docker host, and the container: the same window URI at each open of the devspace (so VS Code finds an
// open window of it), and an address that no other user of the computer can know beforehand. No `vscode`.
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** The start of the name of the pipe, or of its folder. */
const PIPE_PREFIX = 'devspaces-';
/** The hexadecimal digits of the id. */
const ID_LENGTH = 16;
/** The name of the Unix socket in its folder. */
const SOCKET_NAME = 'docker.sock';
/**
 * The longest path of a Unix socket, in bytes: `sun_path` has 104 bytes on macOS and 108 on Linux, with the closing zero
 * byte. The smaller limit holds on every system.
 */
export const MAX_SOCKET_PATH_BYTES = 103;
/** The folder of the socket when no other folder gives a path short enough. */
const FALLBACK_BASE = '/tmp';

const ID_PATTERN = new RegExp(`^[0-9a-f]{${ID_LENGTH}}$`);
const NAMED_PIPE_PATTERN = new RegExp(`^npipe:////\\./pipe/${PIPE_PREFIX}([0-9a-f]{${ID_LENGTH}})$`);
const UNIX_PATTERN = new RegExp(`^unix://(/.*)/${PIPE_PREFIX}([0-9a-f]{${ID_LENGTH}})/${SOCKET_NAME.replace('.', '\\.')}$`);

/** Where the Docker pipe of a window listens. */
export interface DockerPipeAddress {
  /** The id in its name. */
  id: string;
  /** The path that the server listens on: the named pipe, or the Unix socket. */
  path: string;
  /** DOCKER_HOST of the Docker calls of the Dev Containers extension: `npipe:////./pipe/…` or `unix://…`. */
  dockerHost: string;
  /** The private folder of the Unix socket; none for a named pipe. */
  folder?: string;
}

/** The id of the Docker pipe of the container `containerName` on the Docker host `host`, on the computer `computerId`. */
export function dockerPipeId(computerId: string, host: string, containerName: string): string {
  return createHash('sha256').update([computerId, host, containerName].join('\0'), 'utf8').digest('hex').slice(0, ID_LENGTH);
}

/**
 * The folder for the folders of the Unix sockets: XDG_RUNTIME_DIR (private to the user on Linux), else the temporary
 * folder of Node.js (private to the user on macOS), else /tmp; the first that is an absolute path, gives a socket path
 * of at most MAX_SOCKET_PATH_BYTES, and is a folder (`isFolder`; XDG_RUNTIME_DIR can name a folder that does not exist,
 * for example after `su`).
 */
export function dockerPipeBase(env: NodeJS.ProcessEnv, tmpdir: string, isFolder: (folder: string) => boolean = existingFolder): string {
  const candidates = [env.XDG_RUNTIME_DIR, tmpdir].map((value) => value?.trim().replace(/\/+$/, '')).filter((value): value is string => !!value);
  return candidates.find((base) => path.posix.isAbsolute(base) && socketPathFits(base) && isFolder(base)) ?? FALLBACK_BASE;
}

function existingFolder(folder: string): boolean {
  try {
    return fs.statSync(folder).isDirectory();
  } catch {
    return false;
  }
}

function socketPathFits(base: string): boolean {
  return Buffer.byteLength(unixPaths(base, '0'.repeat(ID_LENGTH)).path, 'utf8') <= MAX_SOCKET_PATH_BYTES;
}

function unixPaths(base: string, id: string): { folder: string; path: string } {
  const folder = path.posix.join(base, `${PIPE_PREFIX}${id}`);
  return { folder, path: path.posix.join(folder, SOCKET_NAME) };
}

/** The address of the Docker pipe `id`: a named pipe on Windows, else a Unix socket in a folder in `base`. */
export function dockerPipeAddress(id: string, platform: NodeJS.Platform, base: string): DockerPipeAddress {
  if (!ID_PATTERN.test(id)) throw new Error(`The id ${id} of a Docker pipe is not valid.`);
  if (platform === 'win32') {
    const name = `${PIPE_PREFIX}${id}`;
    return { id, path: `\\\\.\\pipe\\${name}`, dockerHost: `npipe:////./pipe/${name}` };
  }
  const { folder, path: socketPath } = unixPaths(base, id);
  return { id, path: socketPath, dockerHost: `unix://${socketPath}`, folder };
}

/**
 * The address of the Docker pipe in `dockerHost` (`settings.host` of the authority of a window), or undefined when it
 * is no address of a Docker pipe of Devspaces on this platform: a named pipe `devspaces-<id>` on Windows; elsewhere a
 * socket `docker.sock` in a folder `devspaces-<id>` with an absolute, normalized path of at most MAX_SOCKET_PATH_BYTES.
 */
export function parseDockerPipeHost(dockerHost: string, platform: NodeJS.Platform): DockerPipeAddress | undefined {
  if (platform === 'win32') {
    const match = NAMED_PIPE_PATTERN.exec(dockerHost);
    return match ? dockerPipeAddress(match[1], platform, '') : undefined;
  }
  const match = UNIX_PATTERN.exec(dockerHost);
  if (!match) return undefined;
  const [, base, id] = match;
  if (path.posix.normalize(base) !== base) return undefined;
  const address = dockerPipeAddress(id, platform, base);
  return address.dockerHost === dockerHost && Buffer.byteLength(address.path, 'utf8') <= MAX_SOCKET_PATH_BYTES ? address : undefined;
}
