// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Docker on another computer through SSH: the test of a host before it becomes the Docker host of Devspaces, the
// list of the Docker contexts (to offer their SSH hosts), the reachability check that replaces the Docker Desktop start
// for a remote host, and the rootless socket. Devspaces creates and changes no Docker context: the Docker calls of an
// operation on a host of its list get DOCKER_HOST=ssh://<host> (BootstrapDocker), or go through its Docker pipe.
//
// No questions, ever: the Docker CLI starts `ssh` for an `ssh://` endpoint in a new session without a terminal
// (docker/cli connhelper/commandconn, session_unix.go: Setsid), so ssh cannot ask for a password, a passphrase, or a host
// key on a terminal; SSH_ASKPASS_REQUIRE=never (ssh(1), OpenSSH 8.4 and later) also keeps it from opening a graphical
// askpass program for the test. The Docker CLI gives ssh a connection time limit of 30 s ("-o ConnectTimeout=30",
// connhelper.go addSSHTimeout); each call here has its own time limit on top. Our own `ssh` call (the runtime folder of
// a rootless engine) uses the documented options BatchMode=yes and ConnectTimeout. Host keys are never accepted here:
// an unknown key fails, and the message asks the user to run `ssh <host>` once in a terminal (sshCommandLine).
//
// On Windows the Docker CLI starts ssh.exe without Setsid, and the OpenSSH client of Windows asks on the hidden console
// (a host key, a password) until the time limit, so the host seems not to answer. So before the test of a host and
// before each operation on it, our own `ssh -o BatchMode=yes -o ConnectTimeout=15 -T -- <host> true` runs first
// (checkSshLogin), on every platform: BatchMode makes ssh fail at once instead of asking, and its error names the
// reason (host key, login, unreachable, closed before the login). It is one connection instead of the several of the
// Docker CLI, which also lowers the risk of a lock-out by PerSourcePenalties. A success is kept for SSH_CHECK_CACHE_MS
// per host (SshLoginCache), a failure never. Before an operation, the check is the login of the shell before the relay
// (RemoteShellAccess: `ssh … sh -s` with the same options, which the next connection of the relay takes over), so that
// the checks and the connection share one login; the test of a host before a switch (useCache false) keeps `true`.
// While the Docker calls of the extension to the host go through its Docker pipe (HostPipes, BootstrapDocker), the
// check is skipped: the Docker CLI starts no ssh for them, and the connection of the relay behind the pipe logged in
// with the options of this check. The few calls of such an operation that still log in with `ssh://<host>` come right
// after such a login to the same host: a build of the helper image, the calls that change something, and the calls
// after the connection ended.
import { errorMessage, UserFacingError } from '../errors';
import { Messages, dockerHostReason } from '../messages';
import { isAbortError, systemClock, type Clock, type Logger, type ProcessRunner, type RunOptions, type RunResult } from '../ports';
import type { RemoteDockerState } from '../storage/remoteDockerState';
import {
  RUNTIME_DIR_COMMAND,
  classifyDockerEndpoint,
  dockerHostProblem,
  isDockerContextHostTarget,
  isRootlessEngine,
  isPodmanDockerTarget,
  isUnreadableDockerTarget,
  remoteDockerTarget,
  rootlessSocketPath,
  sshCommandArgs,
  sshEndpoint,
  sshTargetOf,
  unsupportedTargetReason,
  type DockerHostProblem,
  type DockerTarget,
} from './dockerHost';
import { runWithDockerTarget } from './dockerTargets';

/** Time limit of `docker info` on a remote host: an SSH connection plus the question (the CLI gives ssh 30 s to connect). */
export const REMOTE_INFO_TIMEOUT_MS = 45_000;
/** Time limit of our own `ssh` call. */
export const SSH_TIMEOUT_MS = 30_000;
/** Time limit of `docker context ls`, which only reads files of the Docker CLI. */
export const CONTEXT_COMMAND_TIMEOUT_MS = 15_000;
/** `docker info` in one line of JSON: the server version and the security options (`name=rootless`). */
export const ENGINE_INFO_FORMAT = '{"version":{{json .ServerVersion}},"securityOptions":{{json .SecurityOptions}}}';

/** The part of BootstrapDocker used here. */
export interface RemoteDockerCli {
  isInstalled(): boolean;
  /** Whether a Docker CLI runs the calls on a remote engine (BootstrapDocker.canRunRemote). Without it: isInstalled. */
  canRunRemote?(): boolean;
  run(args: readonly string[], options?: RunOptions): Promise<RunResult>;
  /** The environment of the Docker calls outside of an operation. */
  processEnv(): NodeJS.ProcessEnv;
}

export type EngineCheck =
  | { ok: true; version: string; rootless: boolean }
  | { ok: false; problem: DockerHostProblem; detail: string };

/** The result of `docker info --format ENGINE_INFO_FORMAT`; `undefined` without a server version. */
export function parseEngineInfo(stdout: string): { version: string; rootless: boolean } | undefined {
  const line = stdout.trim().split(/\r?\n/).pop() ?? '';
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const { version, securityOptions } = value as Record<string, unknown>;
  if (typeof version !== 'string' || version === '') return undefined;
  return { version, rootless: isRootlessEngine(securityOptions) };
}

/** The environment of a Docker call that must never ask a question: SSH_ASKPASS_REQUIRE=never (see the module comment). */
export function noPromptEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'SSH_ASKPASS_REQUIRE') delete env[key];
  env.SSH_ASKPASS_REQUIRE = 'never';
  return env;
}

function engineCheckOf(result: RunResult, timeoutMs: number): EngineCheck {
  if (result.timedOut) {
    return { ok: false, problem: 'unreachable', detail: `docker info did not answer within ${Math.round(timeoutMs / 1000)} seconds.` };
  }
  const info = result.exitCode === 0 ? parseEngineInfo(result.stdout) : undefined;
  if (info) return { ok: true, ...info };
  const detail = (result.stderr || result.stdout).trim() || `docker info failed with exit code ${result.exitCode}.`;
  return { ok: false, problem: dockerHostProblem(detail), detail };
}

async function runEngineInfo(
  docker: RemoteDockerCli,
  args: readonly string[],
  options: RunOptions,
  timeoutMs: number,
): Promise<EngineCheck> {
  try {
    return engineCheckOf(await docker.run(args, { ...options, timeoutMs }), timeoutMs);
  } catch (error) {
    if (isAbortError(error)) throw error;
    const detail = errorMessage(error);
    return { ok: false, problem: dockerHostProblem(detail), detail };
  }
}

/**
 * The test before a host becomes the Docker host of Devspaces: the SSH check (checkSshLogin), then
 * `docker -H ssh://<host> info`, without questions (see the module comment). The current context is not used and not
 * changed.
 */
export async function testRemoteDockerHost(
  docker: RemoteDockerCli,
  host: string,
  ssh: SshCheckDeps,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<EngineCheck> {
  // Our own ssh without questions first; it always connects (no cached success).
  const login = await checkSshLogin(host, ssh, { signal: options.signal, useCache: false });
  if (!login.ok) return login;
  const timeoutMs = options.timeoutMs ?? REMOTE_INFO_TIMEOUT_MS;
  const env = noPromptEnv(docker.processEnv());
  // -H decides the endpoint; DOCKER_CONTEXT would conflict with it.
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'DOCKER_CONTEXT' || key.toUpperCase() === 'DOCKER_HOST') delete env[key];
  // As a call on the remote engine: with the Docker CLI of Devspaces when it is installed (BootstrapDocker.ownCli).
  return runWithDockerTarget(remoteDockerTarget(host), () =>
    runEngineInfo(docker, ['-H', sshEndpoint(host), 'info', '--format', ENGINE_INFO_FORMAT], { env, signal: options.signal }, timeoutMs),
  );
}

/** `docker info` of the Docker host of the operation. */
export async function checkCurrentEngine(
  docker: Pick<RemoteDockerCli, 'run'>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<EngineCheck> {
  const timeoutMs = options.timeoutMs ?? REMOTE_INFO_TIMEOUT_MS;
  return runEngineInfo(docker as RemoteDockerCli, ['info', '--format', ENGINE_INFO_FORMAT], { signal: options.signal }, timeoutMs);
}

/**
 * The folder of the runtime files of the SSH user on `host` ($XDG_RUNTIME_DIR), for the socket of a rootless engine:
 * `ssh -o BatchMode=yes -o ConnectTimeout=15 -T [-p port] [-l user] -- <host> 'printf %s "$XDG_RUNTIME_DIR"'`. The
 * command is a constant; the host is a checked alias or address, after `--`.
 */
export async function readRootlessSocket(
  runner: ProcessRunner,
  sshPath: string | undefined,
  host: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  shells?: RemoteShellAccess,
): Promise<{ ok: true; socket: string } | { ok: false; problem: DockerHostProblem; detail: string }> {
  if (sshPath === undefined) return { ok: false, problem: 'sshMissing', detail: 'The SSH client (ssh) was not found.' };
  const target = sshTargetOf(host);
  if (!target) return { ok: false, problem: 'unknown', detail: `${host} is no SSH alias or address that Devspaces can use.` };
  let result: RunResult;
  try {
    // On the shell before the relay when the host has one (`shells`), else with a login of its own.
    result =
      (await shells?.run(host, RUNTIME_DIR_COMMAND, { timeoutMs: SSH_TIMEOUT_MS, signal })) ??
      (await runner.run(sshPath, sshCommandArgs(target, RUNTIME_DIR_COMMAND), {
        env: noPromptEnv(env),
        timeoutMs: SSH_TIMEOUT_MS,
        signal,
      }));
  } catch (error) {
    if (isAbortError(error)) throw error;
    const detail = errorMessage(error);
    return { ok: false, problem: dockerHostProblem(detail), detail };
  }
  if (result.timedOut) return { ok: false, problem: 'unreachable', detail: `ssh did not answer within ${SSH_TIMEOUT_MS / 1000} seconds.` };
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || `ssh failed with exit code ${result.exitCode}.`;
    return { ok: false, problem: dockerHostProblem(detail), detail };
  }
  const socket = rootlessSocketPath(result.stdout);
  if (!socket) {
    return { ok: false, problem: 'unknown', detail: `XDG_RUNTIME_DIR of the SSH user is not set or not a plain path: ${JSON.stringify(result.stdout.trim())}` };
  }
  return { ok: true, socket };
}

/** A successful SSH login to a host is not checked again for this time. */
export const SSH_CHECK_CACHE_MS = 60_000;

/** The hosts whose SSH login succeeded within the last SSH_CHECK_CACHE_MS. Failures are never kept. */
export class SshLoginCache {
  private readonly succeededAt = new Map<string, number>();

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly maxAgeMs: number = SSH_CHECK_CACHE_MS,
  ) {}

  /** True when the login to `host` succeeded less than maxAgeMs ago. */
  isFresh(host: string): boolean {
    const at = this.succeededAt.get(host);
    if (at === undefined) return false;
    const age = this.clock.now() - at;
    if (age >= 0 && age < this.maxAgeMs) return true;
    this.succeededAt.delete(host);
    return false;
  }

  remember(host: string): void {
    this.succeededAt.set(host, this.clock.now());
  }

  forget(host: string): void {
    this.succeededAt.delete(host);
  }
}

/**
 * The shells before the relay (RemoteShells): one SSH login per host for the checks before a connection of the relay,
 * which that connection then takes over.
 */
export interface RemoteShellAccess {
  /**
   * The login of the shell to `host` (the open shell, or a new one): undefined when the host has no transport (then the
   * caller uses its own `ssh`); a failure has the error output of `ssh`, `timedOut` when it did not answer in time.
   * Rejects only with an AbortError.
   */
  login(host: string, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; detail: string; timedOut: boolean } | undefined>;
  /** `command` (one line for the shell) on the shell of `host`, as RemoteShells.run; undefined without a transport. */
  run(host: string, command: string, options?: Pick<RunOptions, 'timeoutMs' | 'signal'>): Promise<RunResult | undefined>;
}

/** What the SSH check before a Docker call over SSH needs. */
export interface SshCheckDeps {
  runner: ProcessRunner;
  /** The path of `ssh` (findExecutable). */
  sshPath: string | undefined;
  env: NodeJS.ProcessEnv;
  /** Keeps successes for a while; without it, every check opens a connection. */
  sshLogins?: SshLoginCache;
  /**
   * True while the Docker calls of the extension to `host` go through its Docker pipe (HostPipes.dockerHost): the
   * Docker CLI starts no `ssh` then, so the check is skipped.
   */
  viaDockerPipe?(host: string): boolean;
  /**
   * The shells before the relay: the check is the login of the shell of the host (the checks after it run there, and
   * the next connection of the relay takes it over), instead of `ssh … true`.
   */
  shells?: RemoteShellAccess;
}

export type SshLoginCheck =
  | { ok: true; skipped?: 'cached' | 'dockerPipe' | 'notAnSshTarget' }
  | { ok: false; problem: DockerHostProblem; detail: string };

/**
 * The SSH check before a Docker call to `host` (see the module comment): `ssh -o BatchMode=yes -o ConnectTimeout=15 -T
 * [-p port] [-l user] -- <host> true`, without questions, or the login of the shell before the relay with the same
 * options (`deps.shells`, not for `useCache` false). `useCache`: a success of the last SSH_CHECK_CACHE_MS counts,
 * and so do Docker calls that go through the Docker pipe of the extension (the test before a switch always connects). A
 * host that is no usable alias or address (for example of a context of the user with a path) is left to the Docker CLI.
 */
export async function checkSshLogin(
  host: string,
  deps: SshCheckDeps,
  options: { signal?: AbortSignal; useCache?: boolean } = {},
): Promise<SshLoginCheck> {
  if (options.useCache !== false && deps.sshLogins?.isFresh(host)) return { ok: true, skipped: 'cached' };
  if (options.useCache !== false && deps.viaDockerPipe?.(host) === true) return { ok: true, skipped: 'dockerPipe' };
  const target = sshTargetOf(host);
  if (!target) return { ok: true, skipped: 'notAnSshTarget' };
  if (deps.sshPath === undefined) return { ok: false, problem: 'sshMissing', detail: 'The SSH client (ssh) was not found.' };
  // The login of the shell before the relay is the check (not for the test before a switch, which always logs in anew).
  const shell = options.useCache === false ? undefined : await deps.shells?.login(host, options.signal);
  if (shell !== undefined) {
    if (shell.ok) {
      deps.sshLogins?.remember(host);
      return { ok: true };
    }
    deps.sshLogins?.forget(host);
    return { ok: false, problem: shell.timedOut ? 'unreachable' : dockerHostProblem(shell.detail), detail: shell.detail };
  }
  let result: RunResult;
  try {
    result = await deps.runner.run(deps.sshPath, sshCommandArgs(target, 'true'), {
      env: noPromptEnv(deps.env),
      timeoutMs: SSH_TIMEOUT_MS,
      signal: options.signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    const detail = errorMessage(error);
    return { ok: false, problem: dockerHostProblem(detail), detail };
  }
  if (result.timedOut) return { ok: false, problem: 'unreachable', detail: `ssh did not answer within ${SSH_TIMEOUT_MS / 1000} seconds.` };
  if (result.exitCode !== 0) {
    deps.sshLogins?.forget(host);
    const detail = result.stderr.trim() || `ssh failed with exit code ${result.exitCode}.`;
    return { ok: false, problem: dockerHostProblem(detail), detail };
  }
  deps.sshLogins?.remember(host);
  return { ok: true };
}

/** UserFacingError('dockerHostUnreachable') for `host`. */
export function dockerHostUnreachable(host: string, problem: DockerHostProblem, detail: string): UserFacingError {
  return new UserFacingError('dockerHostUnreachable', Messages.dockerHostUnreachable(host, dockerHostReason(problem, host)), detail);
}

/**
 * The message of a target that is not supported: an endpoint that is neither local nor SSH, a context or DOCKER_HOST of
 * the user that reaches a host over SSH (isDockerContextHostTarget), a current Docker context that could not be read
 * (isUnreadableDockerTarget), or a docker command that is Podman (isPodmanDockerTarget).
 */
export function unsupportedTargetMessage(target: Pick<DockerTarget, 'kind' | 'endpoint' | 'podman' | 'sshHost' | 'context'>): string {
  if (isPodmanDockerTarget(target)) return Messages.podmanNotSupported;
  if (isDockerContextHostTarget(target)) return Messages.dockerContextHost(target.sshHost, target.context);
  return isUnreadableDockerTarget(target) ? Messages.dockerContextUnreadable : Messages.dockerEndpointUnsupported(target.endpoint);
}

/** UserFacingError('dockerEndpointUnsupported') for a target that is not supported (unsupportedTargetMessage). */
export function dockerEndpointUnsupported(target: Pick<DockerTarget, 'kind' | 'endpoint' | 'podman' | 'sshHost' | 'context'>): UserFacingError {
  const detail = isPodmanDockerTarget(target)
    ? target.podman
    : isUnreadableDockerTarget(target) || isDockerContextHostTarget(target)
      ? unsupportedTargetReason(target)
      : `Docker endpoint: ${target.endpoint}`;
  return new UserFacingError('dockerEndpointUnsupported', unsupportedTargetMessage(target), detail);
}

export interface RemoteReachabilityDeps {
  docker: Pick<RemoteDockerCli, 'run'>;
  runner: ProcessRunner;
  state: Pick<RemoteDockerState, 'rootlessSocket' | 'setRootlessSocket'>;
  logger: Logger;
  /** The path of `ssh` (findExecutable), for the runtime folder of a rootless engine. */
  sshPath: string | undefined;
  env: NodeJS.ProcessEnv;
  /** The successes of the SSH check, per host (one cache for the extension). */
  sshLogins?: SshLoginCache;
  /** True while the Docker calls of the extension to `host` go through its Docker pipe (SshCheckDeps.viaDockerPipe). */
  viaDockerPipe?(host: string): boolean;
  /** The shells before the relay (SshCheckDeps.shells), also for the runtime folder of a rootless engine. */
  shells?: RemoteShellAccess;
}

/**
 * The step "Docker start" for a remote host: the SSH check (checkSshLogin), then one `docker info` of the host (no Docker
 * Desktop start, no setup, no "Starting Docker" step). Throws UserFacingError('dockerHostUnreachable') with the plain reason. A rootless
 * engine gets its socket recorded (read once with ssh), a rootful one has it forgotten, so the helper mounts the right
 * socket of that computer.
 */
export async function ensureDockerHostReachable(
  target: DockerTarget,
  deps: RemoteReachabilityDeps,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  // Our own ssh without questions first (a success of the last minute counts).
  const login = await checkSshLogin(target.host, deps, { signal: options.signal });
  if (!login.ok) {
    deps.logger.warn(`The Docker host ${target.host} cannot be reached over SSH: ${login.detail}`);
    throw dockerHostUnreachable(target.host, login.problem, login.detail);
  }
  const check = await checkCurrentEngine(deps.docker, options);
  if (!check.ok) {
    deps.logger.warn(`The Docker host ${target.host} cannot be reached: ${check.detail}`);
    throw dockerHostUnreachable(target.host, check.problem, check.detail);
  }
  deps.logger.info(`Docker host ${target.host}: Docker engine ${check.version}${check.rootless ? ' (rootless)' : ''}.`);
  await recordRootlessSocket(target.host, check.rootless, deps, options.signal);
}

/** Records the rootless socket of `host` (reads it with ssh once), or forgets it for a rootful engine. */
export async function recordRootlessSocket(
  host: string,
  rootless: boolean,
  deps: Omit<RemoteReachabilityDeps, 'docker'>,
  signal?: AbortSignal,
): Promise<void> {
  if (!rootless) {
    await deps.state.setRootlessSocket(host, undefined);
    return;
  }
  if ((await deps.state.rootlessSocket(host)) !== undefined) return;
  const read = await readRootlessSocket(deps.runner, deps.sshPath, host, deps.env, signal, deps.shells);
  if (!read.ok) {
    deps.logger.warn(`The socket of the rootless Docker engine on ${host} could not be read: ${read.detail}`);
    throw dockerHostUnreachable(host, read.problem, read.detail);
  }
  deps.logger.info(`The Docker engine on ${host} runs rootless; its socket is ${read.socket}.`);
  await deps.state.setRootlessSocket(host, read.socket);
}

/** The environment of `docker context ls`: without DOCKER_CONTEXT and DOCKER_HOST, which do not change the list. */
function contextCommandEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'DOCKER_CONTEXT' || key.toUpperCase() === 'DOCKER_HOST') delete env[key];
  return env;
}

/** A Docker context as `docker context ls` lists it. */
export interface ContextInfo {
  name: string;
  description: string;
  /** The endpoint of its Docker, for example `ssh://htldvm`; empty when not listed. */
  endpoint: string;
}

/** The contexts of the Docker CLI (`docker context ls --format '{{json .}}'`, one object per line). */
export async function listContextInfos(docker: RemoteDockerCli): Promise<ContextInfo[]> {
  const args = ['context', 'ls', '--format', '{{json .}}'];
  const result = await docker.run(args, { env: contextCommandEnv(docker.processEnv()), timeoutMs: CONTEXT_COMMAND_TIMEOUT_MS });
  if (result.exitCode !== 0) {
    throw new Error(`docker ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim() || `exit code ${result.exitCode}`}`);
  }
  const contexts: ContextInfo[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`docker ${args.join(' ')} printed a line that is not JSON: ${line.trim().slice(0, 200)}`);
    }
    if (typeof value !== 'object' || value === null) continue;
    const record = value as Record<string, unknown>;
    if (typeof record.Name !== 'string' || record.Name === '') continue;
    contexts.push({
      name: record.Name,
      description: typeof record.Description === 'string' ? record.Description : '',
      endpoint: typeof record.DockerEndpoint === 'string' ? record.DockerEndpoint : '',
    });
  }
  return contexts;
}

/**
 * The SSH hosts of the Docker contexts of the user that Devspaces can use (sshTargetOf), each once with the name of the
 * first context that reaches it (`docker context ls`). Throws when the contexts cannot be listed.
 */
export async function sshHostsOfContexts(docker: RemoteDockerCli): Promise<Array<{ host: string; context: string }>> {
  const hosts: Array<{ host: string; context: string }> = [];
  for (const context of await listContextInfos(docker)) {
    const endpoint = classifyDockerEndpoint(context.endpoint);
    if (endpoint.kind !== 'remote' || sshTargetOf(endpoint.host) === undefined || hosts.some((known) => known.host === endpoint.host)) continue;
    hosts.push({ host: endpoint.host, context: context.name });
  }
  return hosts;
}

/**
 * The step "Docker start" of an operation on `target`: the local Docker (`startLocal`, which starts Docker Desktop or
 * offers the setup); a remote host only gets the reachability check (never a Docker Desktop start); a target that is
 * not supported is refused with its message (unsupportedTargetMessage).
 */
export async function startDockerFor(
  target: DockerTarget,
  startLocal: () => Promise<void>,
  remote: RemoteReachabilityDeps,
  signal?: AbortSignal,
): Promise<void> {
  switch (target.kind) {
    case 'local':
      return startLocal();
    case 'unsupported':
      remote.logger.warn(`${unsupportedTargetReason(target)} Nothing is started.`);
      throw dockerEndpointUnsupported(target);
    case 'remote':
      return ensureDockerHostReachable(target, remote, { signal });
  }
}
