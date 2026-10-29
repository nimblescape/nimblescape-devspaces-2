// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The transports of the connection of the relay (docs/architecture.md "The connection of the relay"): the program on
// this computer whose standard input and output reach a POSIX shell on the computer of the Docker engine. That shell
// reads the start script (startScript.ts), which starts the relay. SSH for a remote host: one login, without questions.
// No `vscode`.
import { sshCommandArgs, sshTargetOf, type DockerTarget } from '../docker/dockerHost';
import { noPromptEnv } from '../docker/remoteDocker';
import type { Logger, ProcessRunner } from '../ports';
import { RelayConnection } from './connection';
import { relayStartScript, startMarker } from './startScript';

/** The program that carries a connection of the relay: started with `args` and `env`. */
export interface RelayTransport {
  file: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}

/** The command of the transport on the other computer: a POSIX shell that reads its script from its input. */
export const RELAY_SHELL_COMMAND = 'sh -s';

/**
 * The SSH transport to the engine of `target`: `ssh -o BatchMode=yes -o ConnectTimeout=15 -T [-p port] [-l user] --
 * <host> 'sh -s'` with SSH_ASKPASS_REQUIRE=never, as the SSH check (checkSshLogin). Undefined for a target that is not
 * remote and for a host that is no SSH alias or address (sshTargetOf): its worker starts with the Docker CLI.
 */
export function sshRelayTransport(target: DockerTarget, sshPath: string, env: NodeJS.ProcessEnv): RelayTransport | undefined {
  if (target.kind !== 'remote') return undefined;
  const address = sshTargetOf(target.host);
  if (address === undefined) return undefined;
  return { file: sshPath, args: sshCommandArgs(address, RELAY_SHELL_COMMAND), env: noPromptEnv(env) };
}

/**
 * Opens a connection of the relay over `transport` (RelayConnection.open): the start script with a new marker runs
 * `command` (`docker run … startRelay`, channelRunArgs with RELAY_ENTRY), and `bundle` is the first line of its pipe
 * loader. Rejects with RelayConnectionError, or with an Error for a command that the start script cannot carry.
 */
export async function openRelayConnection(
  runner: Required<Pick<ProcessRunner, 'startBytes'>>,
  transport: RelayTransport,
  command: readonly string[],
  bundle: string,
  options: { logger: Logger; name: string },
): Promise<RelayConnection> {
  const marker = startMarker();
  const startScript = relayStartScript(marker, command);
  const process = runner.startBytes(transport.file, transport.args, { env: transport.env });
  return RelayConnection.open(process, { ...options, marker, startScript, bundle });
}
