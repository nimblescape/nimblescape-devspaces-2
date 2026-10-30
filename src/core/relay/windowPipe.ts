// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Docker pipe of this window (docs/architecture.md "The Docker pipe"): the address that the authority of the window
// names (`settings.host`) is served when it is the pipe that this computer made for the devspace of the window
// (pipeAddress.ts). Each connection goes through the connection of the relay to the host of the devspace; on an engine
// with the removal mark, through its own `docker system dial-stdio` over SSH, so that no worker sets Devspaces up there
// again. No `vscode`.
import type * as net from 'net';
import * as path from 'path';
import { dockerHostOf, hostAccessOf } from '../docker/dockerHost';
import { errorMessage } from '../errors';
import type { Logger, StartedByteProcess } from '../ports';
import type { Devspace } from '../types';
import type { RelayConnection } from './connection';
import { DockerPipe, processDockerDial, relayDockerDial } from './dockerPipe';
import { dockerPipeAddress, dockerPipeBase, dockerPipeId, existingFolder, parseDockerPipeHost } from './pipeAddress';

/** How long the answer of WindowPipeDeps.engineRemoved holds for the next connections of the pipe. */
const ENGINE_REMOVED_HOLD_MS = 2_000;
/** After the connection of the relay could not be had, the connections log in themselves for this long before it is tried again. */
export const RELAY_RETRY_AFTER_MS = 60_000;
/**
 * How long a connection of the pipe waits while the worker of the engine opens the connection of the relay (it may
 * build the helper image first); after it, the connection logs in itself, and the open goes on for the next ones.
 */
export const RELAY_WAIT_MS = 30_000;

export interface WindowPipeDeps {
  logger: Logger;
  platform: NodeJS.Platform;
  /** The ID of this computer (computer.id). */
  computerId(): string;
  /**
   * The SSH hosts that this computer knows (of the list of Devspaces and of the Docker contexts), to find the host of a pipe
   * whose devspace is not known (the registry lost it): the one for which this computer made the address.
   */
  knownHosts(): Promise<string[]>;
  /** True while the engine on the SSH host `host` has the removal mark ("Remove Devspaces from This Docker Engine…"). */
  engineRemoved(host: string): Promise<boolean>;
  /** The open connection of the relay to `host`, or undefined; asks nothing. */
  openRelayConnection(host: string): RelayConnection | undefined;
  /** The open connection of the relay to `host`, or a new one (the worker of the engine opens it). */
  relayConnection(host: string): Promise<RelayConnection>;
  /** `ssh … docker system dial-stdio` on `host`; undefined without `ssh` or for a host it cannot reach. */
  dialStdio(host: string): StartedByteProcess | undefined;
  /** Only for the tests (DockerPipeOptions.inUseWaitMs, RELAY_RETRY_AFTER_MS, RELAY_WAIT_MS). */
  inUseWaitMs?: number;
  relayRetryAfterMs?: number;
  relayWaitMs?: number;
}

/**
 * The address of the Docker pipe of the window of `devspace` (its container `containerName`), for `settings.host` in
 * the authority: for a devspace on a remote host with a transport (hostAccessOf: an SSH host, or the WSL distribution of
 * Devspaces) when the program of its transport is found (`ssh` or `wsl.exe`: the connection of the relay needs it);
 * undefined otherwise, and the window names a Docker context as before. `current`, the Docker host in the authority of
 * this window, when it is the pipe of this devspace and the folder of its socket folder exists: an extension host with
 * another runtime or temporary folder made it, and the same URI reloads this window instead of opening it again.
 */
export function windowDockerHost(
  devspace: Devspace,
  containerName: string,
  deps: {
    computerId(): string;
    platform: NodeJS.Platform;
    env: NodeJS.ProcessEnv;
    tmpdir: string;
    /** Whether the program of the transport of `host` is found on this computer (`ssh`, or `wsl.exe` for WSL). */
    transportFound(host: string): boolean;
    current?: string;
    /** Only for the tests (dockerPipeBase). */
    isFolder?: (folder: string) => boolean;
  },
): string | undefined {
  const host = dockerHostOf(devspace);
  if (host === '' || hostAccessOf(host) === undefined || !deps.transportFound(host)) return undefined;
  const id = dockerPipeId(deps.computerId(), host, containerName);
  const isFolder = deps.isFolder ?? existingFolder;
  const current = deps.current === undefined ? undefined : parseDockerPipeHost(deps.current, deps.platform);
  // A window whose runtime folder is gone (for example another login session) gets an address that it can serve.
  if (current?.id === id && (current.folder === undefined || isFolder(path.posix.dirname(current.folder)))) return current.dockerHost;
  return dockerPipeAddress(id, deps.platform, dockerPipeBase(deps.env, deps.tmpdir, isFolder)).dockerHost;
}

/**
 * What became of the Docker host in the authority of a window: `other` for an address that is no Docker pipe of
 * Devspaces (the Dev Containers extension uses it as it is); `served`; `refused` with the reason (logged) for a Docker
 * pipe of Devspaces that this window does not serve, so the window must not connect: nothing would answer, or on
 * Windows a named pipe of that name that another program serves.
 */
export type WindowPipe = { kind: 'other' } | { kind: 'served'; pipe: DockerPipe } | { kind: 'refused'; reason: string };

/**
 * Serves the Docker pipe `dockerHost` of the authority of this window, whose container is `containerName` and whose
 * devspace is `devspace`: only when it was made on this computer for this devspace (not another computer or another
 * host), and when it can listen (for example not while another program serves it). For a devspace that is not known
 * (the registry lost it), the host is the known host for which this computer made the address. Never throws.
 */
export async function serveWindowPipe(dockerHost: string, containerName: string, devspace: Devspace | undefined, deps: WindowPipeDeps): Promise<WindowPipe> {
  const { logger } = deps;
  const address = parseDockerPipeHost(dockerHost, deps.platform);
  if (address === undefined) {
    logger.info(`The authority of this window names the Docker host ${dockerHost}; it is no Docker pipe of Devspaces.`);
    return { kind: 'other' };
  }
  const refuse = (reason: string): WindowPipe => {
    logger.warn(`The Docker pipe ${dockerHost} of this window is not served: ${reason}`);
    return { kind: 'refused', reason };
  };
  try {
    let host: string;
    if (devspace !== undefined) {
      host = dockerHostOf(devspace);
      if (host === '' || address.id !== dockerPipeId(deps.computerId(), host, containerName)) {
        return refuse(`it was not made on this computer for the devspace of the container ${containerName}.`);
      }
    } else {
      const known = await deps.knownHosts().catch((error: unknown) => {
        logger.warn(`The known SSH hosts could not be read for the Docker pipe ${dockerHost}: ${errorMessage(error)}`);
        return [];
      });
      const found = known.find((candidate) => address.id === dockerPipeId(deps.computerId(), candidate, containerName));
      if (found === undefined) return refuse(`the devspace of the container ${containerName} is not known, and the address was not made on this computer for a known host.`);
      host = found;
      logger.info(`The devspace of the container ${containerName} is not known. Its Docker pipe goes to ${host}, for which this computer made the address.`);
    }
    const direct = processDockerDial(
      () => {
        const process = deps.dialStdio(host);
        if (process === undefined) throw new Error(`ssh was not found, or ${host} is no SSH host`);
        return process;
      },
      logger,
      host,
    );
    // The removal mark can come or go while the window is open: read again after ENGINE_REMOVED_HOLD_MS.
    let removed: { at: number; answer: Promise<boolean> } | undefined;
    const engineRemoved = (): Promise<boolean> => {
      const now = Date.now();
      if (removed === undefined || Math.abs(now - removed.at) >= ENGINE_REMOVED_HOLD_MS) removed = { at: now, answer: deps.engineRemoved(host) };
      return removed.answer;
    };
    // Without the connection of the relay, the window still works: each connection logs in as without the pipe until
    // the connection of the relay is open (also by another open, for example the worker of an operation), and the
    // relay is tried again after RELAY_RETRY_AFTER_MS.
    let withoutRelaySince: number | undefined;
    const throughRelayAgain = () => {
      if (withoutRelaySince !== undefined) logger.info(`The Docker pipe of ${containerName} goes through the connection of the relay again.`);
      withoutRelaySince = undefined;
    };
    // One open of the connection of the relay at a time, for every connection of the pipe that waits for it. Once a
    // connection waited RELAY_WAIT_MS for it, the next ones log in themselves at once while it goes on. Its end decides,
    // also when no connection waits for it any more.
    let opening: { connection: Promise<RelayConnection>; waited: boolean } | undefined;
    const relayConnection = () => {
      if (opening === undefined) {
        const current = { connection: deps.relayConnection(host), waited: false };
        opening = current;
        current.connection.then(
          () => {
            if (opening === current) opening = undefined;
            throughRelayAgain();
          },
          (error: unknown) => {
            if (opening === current) opening = undefined;
            if (withoutRelaySince === undefined) {
              logger.warn(`The Docker pipe of ${containerName} goes without the connection of the relay, with an SSH login for each Docker connection: ${errorMessage(error)}`);
            }
            withoutRelaySince = Date.now();
          },
        );
      }
      return opening;
    };
    const waitMs = deps.relayWaitMs ?? RELAY_WAIT_MS;
    const throughRelay = async (connection: RelayConnection, socket: net.Socket): Promise<void> => {
      try {
        relayDockerDial(connection, socket);
      } catch (error) {
        // The connection ended meanwhile, or has no stream left: this connection only.
        logger.warn(`A Docker connection of ${containerName} goes without the connection of the relay: ${errorMessage(error)}`);
        return direct(socket);
      }
    };
    const connect = async (socket: net.Socket): Promise<void> => {
      if (await engineRemoved()) return direct(socket);
      const open = deps.openRelayConnection(host);
      if (open !== undefined) {
        throughRelayAgain();
        return throughRelay(open, socket);
      }
      if (withoutRelaySince !== undefined && Math.abs(Date.now() - withoutRelaySince) < (deps.relayRetryAfterMs ?? RELAY_RETRY_AFTER_MS)) return direct(socket);
      const pending = relayConnection();
      if (pending.waited) return direct(socket);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        pending.connection.then(
          (connection) => ({ connection }),
          (error: unknown) => ({ error }),
        ),
        new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), waitMs))),
      ]);
      clearTimeout(timer);
      if (outcome === undefined) {
        if (!pending.waited) logger.info(`The connection of the relay to ${host} is not open after ${waitMs / 1000} s. Until it is, each Docker connection of ${containerName} logs in itself.`);
        pending.waited = true;
        return direct(socket);
      }
      // The end of the open logged it.
      if ('error' in outcome) return direct(socket);
      return throughRelay(outcome.connection, socket);
    };
    const pipe = await DockerPipe.listen({ address, connect, logger, name: containerName, platform: deps.platform, inUseWaitMs: deps.inUseWaitMs });
    return { kind: 'served', pipe };
  } catch (error) {
    return refuse(errorMessage(error));
  }
}
