// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Docker pipes of the Docker calls of Devspaces itself (docs/architecture.md "The Docker pipe"): one pipe per SSH
// host in this extension host, at a random address (pipeAddress.ts), served from the first time that a connection of
// the relay to the host passed its checks (RelayConnections.use) until the window closes. While a connection of the
// relay to the host is open, the Docker CLI of Devspaces gets the pipe as DOCKER_HOST (BootstrapDocker), so its calls
// need no SSH login of their own. Each connection of the pipe becomes a Docker stream of that connection
// (relayDockerDial); when it ended meanwhile, the connection runs its own `ssh … docker system dial-stdio`. No `vscode`.
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import type * as net from 'net';
import { sshTargetOf } from '../docker/dockerHost';
import { errorMessage } from '../errors';
import type { Logger, StartedByteProcess } from '../ports';
import type { RelayConnection } from './connection';
import { DockerPipe, processDockerDial, relayDockerDial } from './dockerPipe';
import { dockerPipeAddress } from './pipeAddress';

export interface HostPipesDeps {
  logger: Logger;
  platform: NodeJS.Platform;
  /** The folder for the folders of the Unix sockets (dockerPipeBase); not used on Windows. */
  base(): string;
  /** The open connection of the relay to `host` for a Docker stream (RelayConnections.get), or undefined. */
  relayConnection(host: string): RelayConnection | undefined;
  /** `ssh … docker system dial-stdio` on `host`; undefined without `ssh` or for a host it cannot reach. */
  dialStdio(host: string): StartedByteProcess | undefined;
  /** Only for the tests: the id of the next pipe (16 hexadecimal digits). */
  randomId?: () => string;
}

/** The Docker pipes of this extension host for the Docker calls of Devspaces, by the Docker host (DockerTarget.host). */
export class HostPipes {
  /** The pipe of each host that is served, or that is starting to listen (`pipe` undefined). */
  private readonly pipes = new Map<string, { pipe?: DockerPipe }>();
  private disposed = false;

  constructor(private readonly deps: HostPipesDeps) {}

  /**
   * DOCKER_HOST for a Docker call of Devspaces to the engine on `host`: the address of the pipe of the host while it
   * listens, its socket exists, and a connection of the relay to the host is open; undefined otherwise (the call uses
   * the Docker context, as before). Never throws.
   */
  dockerHost(host: string): string | undefined {
    const pipe = this.pipes.get(host)?.pipe;
    if (pipe === undefined || this.deps.relayConnection(host) === undefined) return undefined;
    const { address } = pipe;
    // A socket that a cleanup of temporary folders removed: the calls log in themselves until the pipe listens again
    // (at its next refresh).
    if (address.folder !== undefined && !fs.existsSync(address.path)) return undefined;
    return address.dockerHost;
  }

  /**
   * Serves the pipe of `host` (an SSH host) when it does not listen yet: a connection of the relay to it passed its
   * checks. A pipe that cannot listen is logged; the next connection that passes its checks tries again. Resolves when
   * the pipe listens or could not; never rejects.
   */
  async serve(host: string): Promise<void> {
    if (this.disposed || this.pipes.has(host) || sshTargetOf(host) === undefined) return;
    const { logger, platform } = this.deps;
    const entry: { pipe?: DockerPipe } = {};
    this.pipes.set(host, entry);
    const name = `the extension on ${host}`;
    const direct = processDockerDial(
      () => {
        const process = this.deps.dialStdio(host);
        if (process === undefined) throw new Error(`ssh was not found, or ${host} is no SSH host`);
        return process;
      },
      logger,
      host,
    );
    const connect = async (socket: net.Socket): Promise<void> => {
      const connection = this.deps.relayConnection(host);
      if (connection !== undefined) {
        try {
          relayDockerDial(connection, socket);
          return;
        } catch (error) {
          // The connection ended meanwhile, or has no stream left: this connection only.
          logger.info(`A Docker connection of ${name} goes without the connection of the relay: ${errorMessage(error)}`);
        }
      }
      return direct(socket);
    };
    try {
      // A new random address for each pipe: no other window and no other user knows it beforehand.
      const address = dockerPipeAddress((this.deps.randomId ?? (() => randomBytes(8).toString('hex')))(), platform, platform === 'win32' ? '' : this.deps.base());
      const pipe = await DockerPipe.listen({ address, connect, logger, name, platform, inUseWaitMs: 0 });
      if (this.disposed) pipe.close();
      else entry.pipe = pipe;
    } catch (error) {
      if (this.pipes.get(host) === entry) this.pipes.delete(host);
      logger.warn(`The Docker pipe of ${name} cannot listen, so the Docker calls of the extension log in to ${host} each time: ${errorMessage(error)}`);
    }
  }

  /** Closes every pipe; their sockets and folders are removed (the window closes). */
  dispose(): void {
    this.disposed = true;
    for (const entry of this.pipes.values()) entry.pipe?.close();
    this.pipes.clear();
  }
}
