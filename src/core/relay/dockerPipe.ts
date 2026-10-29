// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Docker pipe of a devspace window (docs/architecture.md "The Docker pipe"): a named pipe or a Unix socket on this
// computer (pipeAddress.ts) that the Docker calls of the Dev Containers extension reach through `settings.host` in the
// authority of the window (windowPipe.ts), and the Docker calls of the extension itself through DOCKER_HOST
// (hostPipes.ts). Each connection of the pipe becomes one Docker stream of the connection of the relay to the host
// (relayDockerDial), which the worker channel of the window shares, so the window logs in to the host once. A window
// of a devspace on an engine with the removal mark gets one `docker system dial-stdio` over SSH per connection instead
// (processDockerDial): the relay would set Devspaces up there again. No `vscode`.
import * as fs from 'fs';
import * as net from 'net';
import { errorMessage } from '../errors';
import type { Logger, StartedByteProcess } from '../ports';
import { bridgeStream } from './bridge';
import type { RelayConnection } from './connection';
import type { DockerPipeAddress } from './pipeAddress';

/** The errors of a connect to a socket file that nobody serves (or a file that is no socket). */
const STALE_SOCKET_CODES = new Set(['ECONNREFUSED', 'ENOENT', 'ENOTSOCK']);
/** The end of the error output of a `docker system dial-stdio` that is logged when it fails. */
const DIAL_STDERR_TAIL = 2048;
/**
 * How long `listen` waits while another program serves the address: the extension host of this window before a reload
 * can still serve it while the new one starts.
 */
export const PIPE_IN_USE_WAIT_MS = 15_000;
const PIPE_IN_USE_POLL_MS = 250;
/**
 * How often the socket and its folder get a new time: the cleanups of temporary folders remove files that nobody used
 * for days (macOS 3 days, systemd-tmpfiles 10 days), and files in XDG_RUNTIME_DIR that keep their time for 6 hours.
 * The number of the connections that were not logged one by one is logged as often.
 */
export const PIPE_REFRESH_INTERVAL_MS = 60 * 60_000;
/** The first connections of a pipe that are logged one by one (the Dev Containers extension makes many short ones). */
export const PIPE_LOGGED_CONNECTIONS = 50;
/** A connection whose first bytes do not come within this long is closed (a Docker client asks at once). */
export const PIPE_FIRST_BYTES_TIMEOUT_MS = 30_000;

export interface DockerPipeOptions {
  address: DockerPipeAddress;
  /**
   * Connects one connection of the pipe, a paused socket whose first bytes came, with the Docker engine (relayDockerDial,
   * processDockerDial). Rejects when it cannot; the socket is destroyed then.
   */
  connect(socket: net.Socket): Promise<void>;
  logger: Logger;
  /** Named in the log lines, for example the container of the devspace. */
  name: string;
  /** Only for the tests. */
  platform?: NodeJS.Platform;
  inUseWaitMs?: number;
  refreshIntervalMs?: number;
  firstBytesTimeoutMs?: number;
}

/**
 * The address of the pipe is served by another program; `listen` waits for its end. Also when the folder of the socket
 * was removed between its check and the listen (the extension host before a reload closed its pipe meanwhile).
 */
class PipeInUseError extends Error {
  constructor(socketPath: string) {
    super(`${socketPath} is in use: another window serves it.`);
  }
}

/** The pipe that listens. Create it with DockerPipe.listen. */
export class DockerPipe {
  private readonly sockets = new Set<net.Socket>();
  private closed = false;
  private server: net.Server | undefined;
  /** The socket file of `server` (a Unix socket only), so that a socket of another program is never taken for it. */
  private socketFile: { dev: number; ino: number } | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  /** The connections that were logged one by one (at most PIPE_LOGGED_CONNECTIONS), and those since the last count. */
  private loggedConnections = 0;
  private uncountedConnections = 0;
  /** Another file is at the address of the socket, and this was logged. */
  private replacedLogged = false;

  private constructor(private readonly options: DockerPipeOptions) {}

  /**
   * Listens on the address: for a Unix socket, in its folder, which is made private to this user first (0700; a folder
   * of another user or a link is refused), after a socket of an earlier extension host that nobody serves was removed.
   * While another program serves the address, it waits up to PIPE_IN_USE_WAIT_MS for its end. Rejects when the address
   * stays in use (another window serves it) or cannot be had.
   */
  static async listen(options: DockerPipeOptions): Promise<DockerPipe> {
    const { address, logger, name } = options;
    const pipe = new DockerPipe(options);
    const waitMs = options.inUseWaitMs ?? PIPE_IN_USE_WAIT_MS;
    const deadline = Date.now() + waitMs;
    for (let waited = false; ; waited = true) {
      try {
        pipe.server = await pipe.serve();
        break;
      } catch (error) {
        if (!(error instanceof PipeInUseError) || Date.now() >= deadline) throw error;
        if (!waited) logger.info(`${address.dockerHost} is in use. The Docker pipe of ${name} waits up to ${waitMs / 1000} s for the program that serves it to end.`);
        await new Promise((resolve) => setTimeout(resolve, PIPE_IN_USE_POLL_MS));
      }
    }
    pipe.refreshTimer = setInterval(() => {
      pipe.logCount();
      void pipe.refresh();
    }, options.refreshIntervalMs ?? PIPE_REFRESH_INTERVAL_MS);
    pipe.refreshTimer.unref?.();
    logger.info(`The Docker pipe of ${name} listens on ${address.dockerHost}.`);
    return pipe;
  }

  /** The address that the pipe listens on. */
  get address(): DockerPipeAddress {
    return this.options.address;
  }

  /**
   * True while a connection to the address reaches this pipe: it is not closed, and a Unix socket is still its own file
   * (not removed by a cleanup of temporary folders, not replaced by another file; refresh repairs only the first). One
   * lstat of the socket; never throws.
   */
  isServing(): boolean {
    if (this.closed || this.server === undefined) return false;
    const { address } = this.options;
    if (address.folder === undefined) return true;
    try {
      const stat = fs.lstatSync(address.path);
      return stat.dev === this.socketFile?.dev && stat.ino === this.socketFile.ino;
    } catch {
      return false;
    }
  }

  /** The connections that are open now (for the tests). */
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
    clearInterval(this.refreshTimer);
    this.logCount();
    // Node.js removes the socket file of a server at its close, before it closes the socket: so a new window never
    // finds this socket after the close. It removes the file at the address also when another file replaced the socket
    // (refresh logged it); only a program of this user can do that in the private folder.
    this.server?.close();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (this.options.address.folder === undefined) return;
    try {
      fs.rmdirSync(this.options.address.folder);
    } catch {
      // Gone already, or not empty: the next listen uses it.
    }
  }

  /** A new server that listens on the address (for listen, and again for refresh). */
  private async serve(): Promise<net.Server> {
    const { address, logger, name } = this.options;
    if (address.folder !== undefined) {
      await preparePrivateFolder(address.folder);
      await removeStaleSocket(address.path);
    }
    const server = net.createServer({ allowHalfOpen: true, pauseOnConnect: true });
    server.on('connection', (socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      const failed = (error: NodeJS.ErrnoException) =>
        reject(error.code === 'EADDRINUSE' || (error.code === 'ENOENT' && address.folder !== undefined) ? new PipeInUseError(address.path) : error);
      server.once('error', failed);
      server.listen(address.path, () => {
        server.off('error', failed);
        resolve();
      });
    });
    server.on('error', (error: Error) => logger.warn(`The Docker pipe of ${name} failed: ${error.message}`));
    try {
      if (address.folder !== undefined) {
        // The folder already keeps other users away; the socket itself too.
        await fs.promises.chmod(address.path, 0o600);
        const stat = await fs.promises.lstat(address.path);
        this.socketFile = { dev: stat.dev, ino: stat.ino };
      }
    } catch (error) {
      // Never a server that nobody closes; its socket file goes with it.
      server.close();
      throw error;
    }
    return server;
  }

  /** Logs the number of the connections since the last count that were not logged one by one. */
  private logCount(): void {
    if (this.uncountedConnections === 0) return;
    this.options.logger.info(`The Docker pipe of ${this.options.name} had ${this.uncountedConnections} more connections.`);
    this.uncountedConnections = 0;
  }

  /**
   * Gives the socket and its folder a new time, so that no cleanup of temporary folders removes them. When the socket
   * was removed anyway, the pipe listens again; another file at the address is left as it is (logged once). Never
   * rejects.
   */
  private async refresh(): Promise<void> {
    const { address, logger, name } = this.options;
    if (address.folder === undefined || this.closed) return;
    let stat: fs.Stats | undefined;
    try {
      stat = await fs.promises.lstat(address.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
    }
    if (stat !== undefined) {
      if (stat.dev !== this.socketFile?.dev || stat.ino !== this.socketFile.ino) {
        if (!this.replacedLogged) {
          logger.warn(
            `Another file replaced the socket of the Docker pipe of ${name} at ${address.path}. The Docker calls of this window do not reach the pipe until the window is reloaded.`,
          );
        }
        this.replacedLogged = true;
        return;
      }
      this.replacedLogged = false;
      const now = new Date();
      try {
        await fs.promises.utimes(address.folder, now, now);
        await fs.promises.utimes(address.path, now, now);
      } catch {
        // The next refresh again.
      }
      return;
    }
    if (this.closed) return;
    try {
      // First the old server (Node.js removes the file of its address at its close), then the new one.
      this.server?.close();
      this.server = undefined;
      const server = await this.serve();
      if (this.closed) {
        server.close();
        return;
      }
      this.server = server;
      logger.info(`The socket of the Docker pipe of ${name} was removed. The pipe listens again on ${address.dockerHost}.`);
    } catch (error) {
      logger.warn(`The Docker pipe of ${name} could not listen again on ${address.dockerHost}: ${errorMessage(error)}`);
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
    // The engine is reached only after the first bytes of the client (a Docker client always asks first): a connection
    // that closes at once, as the check of another extension host whether the address is in use, opens nothing.
    const endedEmpty = () => socket.destroy();
    socket.once('end', endedEmpty);
    const silent = setTimeout(() => socket.destroy(), this.options.firstBytesTimeoutMs ?? PIPE_FIRST_BYTES_TIMEOUT_MS);
    socket.once('close', () => clearTimeout(silent));
    socket.once('data', (chunk: Buffer) => {
      clearTimeout(silent);
      socket.off('end', endedEmpty);
      socket.pause();
      socket.unshift(chunk);
      if (this.loggedConnections < PIPE_LOGGED_CONNECTIONS) {
        this.loggedConnections += 1;
        logger.info(`Docker pipe of ${name}: ${requestLine(chunk)}`);
        if (this.loggedConnections === PIPE_LOGGED_CONNECTIONS) {
          logger.info(`The Docker pipe of ${name} logs no further connection one by one, only their number each hour.`);
        }
      } else {
        this.uncountedConnections += 1;
      }
      this.options.connect(socket).then(
        () => {
          if (!socket.destroyed) socket.resume();
        },
        (error: unknown) => {
          logger.warn(`The Docker pipe of ${name} could not reach the Docker engine: ${errorMessage(error)}`);
          socket.destroy();
        },
      );
    });
    socket.resume();
  }
}

/**
 * The method and path of the first request of a connection, for the log: without the query (it may name filters or
 * other values, and make the line long) and without the version of the API; `a connection` when the first 512 bytes
 * do not start with an HTTP method and a path.
 */
export function requestLine(chunk: Buffer): string {
  const start = chunk.subarray(0, 512).toString('latin1');
  const match = /^([A-Z]{3,7}) (\/[^\s?]*)[?\s]/.exec(start);
  if (!match) return 'a connection';
  const [, method, requestPath] = match;
  return `${method} ${requestPath.replace(/^\/v\d+\.\d+(?=\/)/, '').replace(/[^\x21-\x7e]/g, '?')}`;
}

/**
 * Connects `socket`, a connection of the pipe, with a new Docker stream of `connection` (the connection of the relay to
 * the host). Throws when the connection is closed or has no stream left.
 */
export function relayDockerDial(connection: RelayConnection, socket: net.Socket): void {
  const stream = connection.openDocker();
  // The Docker CLI gave up meanwhile.
  if (socket.destroyed) {
    stream.close('the connection closed');
    return;
  }
  bridgeStream(stream, socket, socket);
}

/**
 * The connect of the pipe without the relay: a program (`ssh … docker system dial-stdio`) whose standard input and
 * output carry the bytes of the connection, as the Docker CLI does for an SSH host itself. It ends with the
 * connection; its error output is logged when it fails.
 */
export function processDockerDial(start: () => StartedByteProcess, logger: Logger, name: string): (socket: net.Socket) => Promise<void> {
  return async (socket) => {
    // The Docker CLI gave up already (while the relay was tried): no program that nobody ends.
    if (socket.destroyed) return;
    const process = start();
    let stderr = '';
    process.onStderr((text) => (stderr = (stderr + text).slice(-DIAL_STDERR_TAIL)));
    let waiting = false;
    process.onStdout(
      (chunk) => {
        if (socket.destroyed || socket.write(chunk) || waiting) return;
        // The Docker CLI reads slower than the engine writes: the program waits until the socket drained.
        waiting = true;
        process.pauseStdout();
        socket.once('drain', () => {
          waiting = false;
          process.resumeStdout();
        });
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
    socket.on('close', () => {
      // A paused output would keep the program from ending (its output never ends): what it still writes is dropped.
      if (waiting) {
        waiting = false;
        process.resumeStdout();
      }
      process.kill();
    });
    void process.exited.then(({ exitCode, error }) => {
      if (error !== undefined || (exitCode !== 0 && exitCode !== null)) {
        logger.warn(`The Docker connection of ${name} ended: ${error ? error.message : stderr.trim() || `exit code ${exitCode}`}`);
      }
      // Nothing more comes from the engine, and nothing that the client still sends goes there (also not while the
      // socket waits for a drain of the program): the connection ends once its output is written.
      if (socket.destroyed) return;
      if (socket.writableFinished) {
        socket.destroy();
        return;
      }
      socket.once('finish', () => socket.destroy());
      if (!socket.writableEnded) socket.end();
    });
  };
}

/**
 * Makes `folder` (whose parent exists) a folder of this user that nobody else may use. Throws when it cannot; a
 * PipeInUseError when the folder went away after the mkdir (the extension host before a reload closed its pipe).
 */
async function preparePrivateFolder(folder: string): Promise<void> {
  try {
    await fs.promises.mkdir(folder, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  try {
    const stat = await fs.promises.lstat(folder);
    if (!stat.isDirectory()) throw new Error(`${folder} is not a folder.`);
    const uid = process.getuid?.();
    if (uid !== undefined && stat.uid !== uid) throw new Error(`${folder} belongs to another user.`);
    if ((stat.mode & 0o077) !== 0) await fs.promises.chmod(folder, 0o700);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new PipeInUseError(folder);
    throw error;
  }
}

/**
 * Removes the socket at `socketPath` when no program serves it (an extension host that ended: the connect is refused).
 * Throws when one does, also when its connect fails otherwise (for example while its queue of connections is full).
 */
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
    probe.once('error', (error: NodeJS.ErrnoException) => resolve(!STALE_SOCKET_CODES.has(error.code ?? '')));
  });
  if (served) throw new PipeInUseError(socketPath);
  try {
    await fs.promises.unlink(socketPath);
  } catch (error) {
    // Its extension host removed it meanwhile.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
