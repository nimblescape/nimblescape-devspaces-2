// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Docker pipe of this window (docs/architecture.md "The Docker pipe"): the address that the authority of the window
// names (`settings.host`) is served when it is the pipe that this computer made for the devspace of the window
// (pipeAddress.ts). Each connection goes through the connection of the relay to the host of the devspace; on an engine
// with the removal mark, through its own `docker system dial-stdio` over SSH, so that no worker sets Devspaces up there
// again. No `vscode`.
import type * as net from 'net';
import { dockerHostOf, sshTargetOf } from '../docker/dockerHost';
import { errorMessage } from '../errors';
import type { Logger, StartedByteProcess } from '../ports';
import type { Devspace } from '../types';
import type { RelayConnection } from './connection';
import { DockerPipe, processDockerDial, relayDockerDial } from './dockerPipe';
import { dockerPipeAddress, dockerPipeBase, dockerPipeId, parseDockerPipeHost } from './pipeAddress';

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
  /** True while the engine of `devspace` has the removal mark ("Remove Devspaces from This Docker Engine…"). */
  engineRemoved(devspace: Devspace): Promise<boolean>;
  /** The open connection of the relay to the host of `devspace`, or a new one (the worker of the engine opens it). */
  relayConnection(devspace: Devspace): Promise<RelayConnection>;
  /** `ssh … docker system dial-stdio` on the host of `devspace`; undefined without `ssh` or for a host it cannot reach. */
  dialStdio(devspace: Devspace): StartedByteProcess | undefined;
  /** Only for the tests (DockerPipeOptions.inUseWaitMs, RELAY_RETRY_AFTER_MS, RELAY_WAIT_MS). */
  inUseWaitMs?: number;
  relayRetryAfterMs?: number;
  relayWaitMs?: number;
}

/**
 * The address of the Docker pipe of the window of `devspace` (its container `containerName`), for `settings.host` in
 * the authority: for a devspace on an SSH host (sshTargetOf) when `ssh` is found (the connection of the relay needs it);
 * undefined otherwise, and the window names a Docker context as before. `current`, the Docker host in the authority of
 * this window, when it is the pipe of this devspace: an extension host with another runtime or temporary folder made
 * it, and the same URI reloads this window instead of opening it again.
 */
export function windowDockerHost(
  devspace: Devspace,
  containerName: string,
  deps: {
    computerId(): string;
    platform: NodeJS.Platform;
    env: NodeJS.ProcessEnv;
    tmpdir: string;
    sshFound(): boolean;
    current?: string;
    /** Only for the tests (dockerPipeBase). */
    isFolder?: (folder: string) => boolean;
  },
): string | undefined {
  const host = dockerHostOf(devspace);
  if (host === '' || sshTargetOf(host) === undefined || !deps.sshFound()) return undefined;
  const id = dockerPipeId(deps.computerId(), host, containerName);
  const current = deps.current === undefined ? undefined : parseDockerPipeHost(deps.current, deps.platform);
  if (current?.id === id) return current.dockerHost;
  return dockerPipeAddress(id, deps.platform, dockerPipeBase(deps.env, deps.tmpdir, deps.isFolder)).dockerHost;
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
 * devspace is `devspace`: only when it was made on this computer for this devspace (not another computer, another
 * host, or an unknown devspace), and when it can listen (for example not while another program serves it). Never
 * throws.
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
  if (devspace === undefined) return refuse(`the devspace of the container ${containerName} is not known.`);
  const host = dockerHostOf(devspace);
  try {
    if (host === '' || address.id !== dockerPipeId(deps.computerId(), host, containerName)) {
      return refuse(`it was not made on this computer for the devspace of the container ${containerName}.`);
    }
    const direct = processDockerDial(
      () => {
        const process = deps.dialStdio(devspace);
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
      if (removed === undefined || Math.abs(now - removed.at) >= ENGINE_REMOVED_HOLD_MS) removed = { at: now, answer: deps.engineRemoved(devspace) };
      return removed.answer;
    };
    // Without the connection of the relay, the window still works: each connection logs in as without the pipe, and
    // the relay is tried again after RELAY_RETRY_AFTER_MS.
    let withoutRelaySince: number | undefined;
    // One open of the connection of the relay at a time, for every connection of the pipe that waits for it. Once a
    // connection waited RELAY_WAIT_MS for it, the next ones log in themselves at once while it goes on. Its end decides,
    // also when no connection waits for it any more.
    let opening: { connection: Promise<RelayConnection>; waited: boolean } | undefined;
    const relayConnection = () => {
      if (opening === undefined) {
        const current = { connection: deps.relayConnection(devspace), waited: false };
        opening = current;
        current.connection.then(
          () => {
            if (opening === current) opening = undefined;
            if (withoutRelaySince !== undefined) logger.info(`The Docker pipe of ${containerName} goes through the connection of the relay again.`);
            withoutRelaySince = undefined;
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
    const connect = async (socket: net.Socket): Promise<void> => {
      if (await engineRemoved()) return direct(socket);
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
      try {
        relayDockerDial(outcome.connection, socket);
      } catch (error) {
        // The connection ended meanwhile, or has no stream left: this connection only.
        logger.warn(`A Docker connection of ${containerName} goes without the connection of the relay: ${errorMessage(error)}`);
        return direct(socket);
      }
    };
    const pipe = await DockerPipe.listen({ address, connect, logger, name: containerName, platform: deps.platform, inUseWaitMs: deps.inUseWaitMs });
    return { kind: 'served', pipe };
  } catch (error) {
    return refuse(errorMessage(error));
  }
}
