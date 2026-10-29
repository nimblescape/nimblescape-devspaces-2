// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Docker pipe of a devspace window (docs/architecture.md "The Docker pipe"): a named pipe or a Unix socket on this
// computer (pipeAddress.ts) that the Docker calls of the Dev Containers extension reach through `settings.host` in the
// authority of the window. Each connection of the pipe becomes one Docker stream of the connection of the relay to the
// host of the devspace (relayDockerDial), which the worker channel of the window shares, so the window logs in to the
// host once. A window of a devspace on an engine with the removal mark gets one `docker system dial-stdio` over SSH per
// connection instead (processDockerDial): the relay would set Devspaces up there again. No `vscode`.
import * as fs from 'fs';
import * as net from 'net';
import { errorMessage } from '../errors';
import type { Logger, StartedByteProcess } from '../ports';
import { bridgeStream } from './bridge';
import type { RelayConnection } from './connection';
import type { DockerPipeAddress } from './pipeAddress';

/** The end of the error output of a `docker system dial-stdio` that is logged when it fails. */
const DIAL_STDERR_TAIL = 2048;

export interface DockerPipeOptions {
  address: DockerPipeAddress;
  /**
   * Connects one connection of the pipe, a paused socket, with the Docker engine (relayDockerDial, processDockerDial).
   * Rejects when it cannot; the socket is destroyed then.
   */
  connect(socket: net.Socket): Promise<void>;
  logger: Logger;
  /** Named in the log lines, for example the container of the devspace. */
  name: string;
  /** Only for the tests. */
  platform?: NodeJS.Platform;
}

/** The pipe that listens. Create it with DockerPipe.listen. */
export class DockerPipe {
  private readonly sockets = new Set<net.Socket>();
  private closed = false;

  private constructor(
    private readonly server: net.Server,
    private readonly options: DockerPipeOptions,
  ) {}

  /**
   * Listens on the address: for a Unix socket, in its folder, which is made private to this user first (0700; a folder
   * of another user or a link is refused), after a socket of an earlier extension host that nobody serves was removed.
   * Rejects when the address is in use (another window serves it) or cannot be had.
   */
  static async listen(options: DockerPipeOptions): Promise<DockerPipe> {
    const { address } = options;
    if (address.folder !== undefined) {
      await preparePrivateFolder(address.folder);
      await removeStaleSocket(address.path);
    }
    const server = net.createServer({ allowHalfOpen: true, pauseOnConnect: true });
    const pipe = new DockerPipe(server, options);
    server.on('connection', (socket) => pipe.accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(address.path, () => {
        server.off('error', reject);
        resolve();
      });
    });
    server.on('error', (error: Error) => options.logger.warn(`The Docker pipe of ${options.name} failed: ${error.message}`));
    // The folder already keeps other users away; the socket itself too.
    if (address.folder !== undefined) await fs.promises.chmod(address.path, 0o600);
    options.logger.info(`The Docker pipe of ${options.name} listens on ${address.dockerHost}.`);
    return pipe;
  }

  /** The connections that are open now. */
  get connectionCount(): number {
    return this.sockets.size;
  }

  /**
   * Stops listening and ends every connection; the socket file and its folder are removed at once (the window closes,
   * and no timer of the extension host may run after it).
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.server.close();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const { folder, path: socketPath } = this.options.address;
    if (folder === undefined) return;
    for (const remove of [() => fs.unlinkSync(socketPath), () => fs.rmdirSync(folder)]) {
      try {
        remove();
      } catch {
        // Gone already, or the next listen removes it.
      }
    }
  }

  private accept(socket: net.Socket): void {
    if (this.closed) {
      socket.destroy();
      return;
    }
    const { logger, name } = this.options;
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    // The connection reports its own errors (bridgeStream); without a listener, an error would end the extension host.
    socket.on('error', () => {});
    socket.once('data', (chunk: Buffer) => logger.info(`Docker pipe of ${name}: ${requestLine(chunk)}`));
    this.options.connect(socket).then(
      () => {
        if (!socket.destroyed) socket.resume();
      },
      (error: unknown) => {
        logger.warn(`The Docker pipe of ${name} could not reach the Docker engine: ${errorMessage(error)}`);
        socket.destroy();
      },
    );
  }
}

/**
 * The method and path of the first request of a connection, for the log: without the query (it may name filters or
 * other values) and without the version of the API; `a connection` when the start is not an HTTP request line.
 */
export function requestLine(chunk: Buffer): string {
  const end = chunk.indexOf('\r\n');
  const line = chunk.subarray(0, end < 0 ? Math.min(chunk.length, 512) : Math.min(end, 512)).toString('latin1');
  const match = /^([A-Z]{3,7}) (\/[^\s?]*)(?:\?\S*)? HTTP\/1\.[01]$/.exec(line);
  if (!match) return 'a connection';
  const [, method, requestPath] = match;
  return `${method} ${requestPath.replace(/^\/v\d+\.\d+(?=\/)/, '').replace(/[^\x21-\x7e]/g, '?')}`;
}

/**
 * The connect of the pipe through the relay: one Docker stream of the connection that `connection` gives (the open one
 * of the host, or a new one), connected with the socket. Rejects when no connection can be had or it has no stream left.
 */
export function relayDockerDial(connection: () => Promise<RelayConnection>): (socket: net.Socket) => Promise<void> {
  return async (socket) => {
    const stream = (await connection()).openDocker();
    // The Docker CLI gave up while the connection was opened.
    if (socket.destroyed) {
      stream.close('the connection closed');
      return;
    }
    bridgeStream(stream, socket, socket);
  };
}

/**
 * The connect of the pipe without the relay: a program (`ssh … docker system dial-stdio`) whose standard input and
 * output carry the bytes of the connection, as the Docker CLI does for an SSH host itself. It ends with the
 * connection; its error output is logged when it fails.
 */
export function processDockerDial(start: () => StartedByteProcess, logger: Logger, name: string): (socket: net.Socket) => Promise<void> {
  return async (socket) => {
    const process = start();
    let stderr = '';
    process.onStderr((text) => (stderr = (stderr + text).slice(-DIAL_STDERR_TAIL)));
    process.onStdout(
      (chunk) => {
        if (!socket.destroyed) socket.write(chunk);
      },
      () => {
        if (!socket.destroyed && !socket.writableEnded) socket.end();
      },
    );
    socket.on('data', (chunk: Buffer) => {
      if (process.write(chunk)) return;
      socket.pause();
      process.onDrain(() => socket.resume());
    });
    socket.on('end', () => process.end());
    socket.on('close', () => process.kill());
    void process.exited.then(({ exitCode, error }) => {
      if (error !== undefined || (exitCode !== 0 && exitCode !== null)) {
        logger.warn(`The Docker connection of ${name} ended: ${error ? error.message : stderr.trim() || `exit code ${exitCode}`}`);
      }
      if (!socket.destroyed && !socket.writableEnded) socket.end();
    });
  };
}

/** Makes `folder` (whose parent exists) a folder of this user that nobody else may use. Throws when it cannot. */
async function preparePrivateFolder(folder: string): Promise<void> {
  try {
    await fs.promises.mkdir(folder, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = await fs.promises.lstat(folder);
  if (!stat.isDirectory()) throw new Error(`${folder} is not a folder.`);
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) throw new Error(`${folder} belongs to another user.`);
  if ((stat.mode & 0o077) !== 0) await fs.promises.chmod(folder, 0o700);
}

/** Removes the socket at `socketPath` when no program serves it (an extension host that ended). Throws when one does. */
async function removeStaleSocket(socketPath: string): Promise<void> {
  try {
    await fs.promises.lstat(socketPath);
  } catch {
    return;
  }
  const served = await new Promise<boolean>((resolve) => {
    const probe = net.connect(socketPath);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
  if (served) throw new Error(`${socketPath} is in use: another window serves it.`);
  await fs.promises.unlink(socketPath);
}
