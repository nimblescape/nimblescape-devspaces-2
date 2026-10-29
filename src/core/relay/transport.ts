// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The transports of the connection of the relay (docs/architecture.md "The connection of the relay"): the program on
// this computer whose standard input and output reach a POSIX shell on the computer of the Docker engine. That shell
// reads the start script (startScript.ts), which starts the relay. SSH for a remote host: one login, without questions.
// No `vscode`.
import { sshCommandArgs, sshTargetOf, type DockerTarget } from '../docker/dockerHost';
import { noPromptEnv } from '../docker/remoteDocker';
import { bundleLine } from '../loader/pipeLoader';
import type { Logger, ProcessRunner, StartedByteProcess } from '../ports';
import { RelayConnection, RelayConnectionError } from './connection';
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
  return target.kind === 'remote' ? sshHostTransport(target.host, sshPath, env) : undefined;
}

/** sshRelayTransport for the SSH host `host` (DockerTarget.host); undefined for a host that is no SSH alias or address. */
export function sshHostTransport(host: string, sshPath: string, env: NodeJS.ProcessEnv): RelayTransport | undefined {
  const address = sshTargetOf(host);
  if (address === undefined) return undefined;
  return { file: sshPath, args: sshCommandArgs(address, RELAY_SHELL_COMMAND), env: noPromptEnv(env) };
}

/**
 * Opens a connection of the relay over `transport` (RelayConnection.open): the start script with a new marker runs
 * `command` (`docker run … startRelay`, channelRunArgs with RELAY_ENTRY), and `bundle` is the first line of its pipe
 * loader. `takeOver`: the login of the shell before the relay to the host when one is open (RemoteShells.takeOver),
 * whose shell runs the start script instead of a new login. Rejects with RelayConnectionError (also, before the start,
 * for a bundle longer than the pipe loader takes), or with an Error for a command that the start script cannot carry.
 */
export async function openRelayConnection(
  runner: Required<Pick<ProcessRunner, 'startBytes'>>,
  transport: RelayTransport,
  command: readonly string[],
  bundle: string,
  options: { logger: Logger; name: string; takeOver?: () => Promise<StartedByteProcess | undefined> },
): Promise<RelayConnection> {
  const { takeOver, ...connectionOptions } = options;
  // The loader limits the escaped line (the memory guard of the pipe loader), so the same is checked here.
  const { line, length, tooLong } = bundleLine(bundle);
  if (tooLong) throw new RelayConnectionError(`The connection to ${options.name} could not be opened: the bundle is too long (${length} characters as JSON).`);
  const marker = startMarker();
  const startScript = relayStartScript(marker, command);
  const shell = takeOver === undefined ? undefined : await takeOver();
  if (shell !== undefined) options.logger.info(`The connection to ${options.name} starts on the SSH login of the shell before the relay.`);
  const process = shell ?? runner.startBytes(transport.file, transport.args, { env: transport.env });
  return RelayConnection.open(process, { ...connectionOptions, marker, startScript, bundleLine: line });
}
