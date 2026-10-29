// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Docker pipe of this window (docs/architecture.md "The Docker pipe"): the address that the authority of the window
// names (`settings.host`) is served when it is the pipe that this computer made for the devspace of the window
// (pipeAddress.ts). Each connection goes through the connection of the relay to the host of the devspace; on an engine
// with the removal mark, through its own `docker system dial-stdio` over SSH, so that no worker sets Devspaces up there
// again. No `vscode`.
import { dockerHostOf, sshTargetOf } from '../docker/dockerHost';
import { errorMessage } from '../errors';
import type { Logger, StartedByteProcess } from '../ports';
import type { Devspace } from '../types';
import type { RelayConnection } from './connection';
import { DockerPipe, processDockerDial, relayDockerDial } from './dockerPipe';
import { dockerPipeAddress, dockerPipeBase, dockerPipeId, parseDockerPipeHost } from './pipeAddress';

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
}

/**
 * The address of the Docker pipe of the window of `devspace` (its container `containerName`), for `settings.host` in
 * the authority: for a devspace on an SSH host (sshTargetOf) when `ssh` is found (the connection of the relay needs it);
 * undefined otherwise, and the window names a Docker context as before.
 */
export function windowDockerHost(
  devspace: Devspace,
  containerName: string,
  deps: { computerId(): string; platform: NodeJS.Platform; env: NodeJS.ProcessEnv; tmpdir: string; sshFound(): boolean },
): string | undefined {
  const host = dockerHostOf(devspace);
  if (host === '' || sshTargetOf(host) === undefined || !deps.sshFound()) return undefined;
  return dockerPipeAddress(dockerPipeId(deps.computerId(), host, containerName), deps.platform, dockerPipeBase(deps.env, deps.tmpdir)).dockerHost;
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
    const relay = relayDockerDial(() => deps.relayConnection(devspace));
    const direct = processDockerDial(
      () => {
        const process = deps.dialStdio(devspace);
        if (process === undefined) throw new Error(`ssh was not found, or ${host} is no SSH host`);
        return process;
      },
      logger,
      host,
    );
    const pipe = await DockerPipe.listen({
      address,
      // Each connection again: the removal mark can come or go while the window is open.
      connect: async (socket) => ((await deps.engineRemoved(devspace)) ? direct(socket) : relay(socket)),
      logger,
      name: containerName,
      platform: deps.platform,
    });
    return { kind: 'served', pipe };
  } catch (error) {
    return refuse(errorMessage(error));
  }
}
