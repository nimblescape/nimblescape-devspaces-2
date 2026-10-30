// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The transports of the connection of the relay (docs/architecture.md "The connection of the relay"): the program on
// this computer whose standard input and output reach a POSIX shell on the computer of the Docker engine. That shell
// reads the start script (startScript.ts), which starts the relay. SSH for a remote host: one login, which asks only in
// a flow of the user (sshAskpass.ts). `wsl.exe` for the WSL distribution of Devspaces: no login and no question. No
// `vscode`.
import { sshCommandArgs, sshTargetOf, wslCommandArgs, wslEnv, type DockerTarget } from '../docker/dockerHost';
import { noPromptEnv } from '../docker/remoteDocker';
import { bundleLine } from '../loader/pipeLoader';
import type { Logger, StartedByteProcess } from '../ports';
import { RelayConnection, RelayConnectionError } from './connection';
import type { RemoteShellStart } from './remoteShells';
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
 * The `wsl.exe` transport to the engine in the WSL distribution `distribution`: `wsl.exe -d <distribution> -u root --cd /
 * --exec sh -s` (wslCommandArgs), with WSL_UTF8=1 (wslEnv). It starts the distribution when it does not run, and asks
 * nothing: the Windows user owns the distribution, and its root user runs the Docker engine.
 */
export function wslHostTransport(distribution: string, wslPath: string, env: NodeJS.ProcessEnv): RelayTransport {
  return { file: wslPath, args: wslCommandArgs(distribution, RELAY_SHELL_COMMAND.split(' ')), env: wslEnv(env) };
}

/**
 * The SSH transport to the engine of `target`: `ssh -o BatchMode=yes -o ConnectTimeout=15 -T [-i key] [-p port] [-l
 * user] -- <host> 'sh -s'` with SSH_ASKPASS_REQUIRE=never, as the SSH check (checkSshLogin). With `prompts` (a login of
 * a flow of the user), without BatchMode and with the environment of the helper that asks in VS Code (askpassEnv), so
 * the login asks for a password or an unknown host key. `identity`: the key of Devspaces (sshKey.ts). Undefined for a target that is not remote and for a host that is no
 * SSH alias or address (sshTargetOf): its worker starts with the Docker CLI.
 */
export function sshRelayTransport(target: DockerTarget, sshPath: string, env: NodeJS.ProcessEnv, options: SshLoginOptions = {}): RelayTransport | undefined {
  return target.kind === 'remote' ? sshHostTransport(target.host, sshPath, env, options) : undefined;
}

/** How an SSH login of Devspaces runs: with the questions of a flow of the user, and with the key of Devspaces (`-i`). */
export interface SshLoginOptions {
  prompts?: TransportPrompts;
  identity?: string;
}

/** The questions of a login of a flow of the user: the environment of its `ssh` (askpassEnv of the login). */
export interface TransportPrompts {
  env(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
}

/** sshRelayTransport for the SSH host `host` (DockerTarget.host); undefined for a host that is no SSH alias or address. */
export function sshHostTransport(host: string, sshPath: string, env: NodeJS.ProcessEnv, options: SshLoginOptions = {}): RelayTransport | undefined {
  const address = sshTargetOf(host);
  if (address === undefined) return undefined;
  const { prompts, identity } = options;
  const args = sshCommandArgs(address, RELAY_SHELL_COMMAND, undefined, { prompts: prompts !== undefined, identity });
  return { file: sshPath, args, env: prompts !== undefined ? prompts.env(env) : noPromptEnv(env) };
}

/**
 * Opens a connection of the relay on a new login of `start` (the transport, sshRelayTransport; RelayConnection.open):
 * the start script with a new marker runs `command` (`docker run … startRelay`, channelRunArgs with RELAY_ENTRY), and
 * `bundle` is the first line of its pipe loader. A login that may ask holds the time limit of the open while a question
 * is open. `takeOver`: the login of the shell before the relay to the host when one is open (RemoteShells.takeOver),
 * whose shell runs the start script instead of a new login. Rejects with RelayConnectionError (also, before the start,
 * for a bundle longer than the pipe loader takes), or with an Error for a command that the start script cannot carry.
 */
export async function openRelayConnection(
  start: () => RemoteShellStart,
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
  if (shell !== undefined) options.logger.info(`The connection to ${options.name} starts on the login of the shell before the relay.`);
  const { process, prompts } = shell === undefined ? start() : { process: shell, prompts: undefined };
  return RelayConnection.open(process, { ...connectionOptions, prompts, marker, startScript, bundleLine: line });
}
