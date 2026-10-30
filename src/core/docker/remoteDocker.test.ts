// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserFacingError } from '../errors';
import { Messages, dockerHostReason } from '../messages';
import type { RunOptions, RunResult } from '../ports';
import { RemoteDockerState } from '../storage/remoteDockerState';
import { WSL_HOST, remoteDockerTarget } from './dockerHost';
import { UNREADABLE_DOCKER_TARGET, operationDockerTarget } from './dockerTargets';
import {
  CONTEXT_COMMAND_TIMEOUT_MS,
  ENGINE_INFO_FORMAT,
  SSH_CHECK_CACHE_MS,
  SshLoginCache,
  checkCurrentEngine,
  checkSshLogin,
  ensureDockerHostReachable,
  listContextInfos,
  noPromptEnv,
  parseEngineInfo,
  readRootlessSocket,
  startDockerFor,
  testRemoteDockerHost,
  type RemoteDockerCli,
} from './remoteDocker';

const ok = (stdout: string): RunResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });
const fail = (stderr: string, exitCode = 1): RunResult => ({ exitCode, stdout: '', stderr, timedOut: false });
const info = (rootless = false) =>
  ok(`${JSON.stringify({ version: '28.1.0', securityOptions: ['name=seccomp,profile=builtin', ...(rootless ? ['name=rootless'] : [])] })}\n`);
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };
/** The ssh check before the Docker calls: `ssh … -- <host> true`. */
const isSshCheck = (args: readonly string[]): boolean => args[args.length - 1] === 'true';
/** A runner whose ssh check succeeds and whose other ssh call prints `runtimeDir`. */
function sshRunner(runtimeDir = '/run/user/1000', check: RunResult = ok('')) {
  return { run: vi.fn(async (_file: string, args: readonly string[], _options?: RunOptions) => (isSshCheck(args) ? check : ok(runtimeDir))) };
}
const sshDeps = (runner = sshRunner()) => ({ runner, sshPath: '/usr/bin/ssh', env: { PATH: '/usr/bin' } });

type Call = { args: readonly string[]; options?: RunOptions };

function fakeDocker(answer: (args: readonly string[]) => RunResult | Promise<RunResult>): RemoteDockerCli & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    isInstalled: () => true,
    processEnv: () => ({ PATH: '/usr/bin', DOCKER_CONTEXT: 'desktop-linux', SSH_AUTH_SOCK: '/tmp/agent.sock', SSH_ASKPASS_REQUIRE: 'force' }),
    run: async (args, options) => {
      calls.push({ args, options });
      return answer(args);
    },
  };
}

let dir: string;
let state: RemoteDockerState;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-remote-'));
  state = new RemoteDockerState(path.join(dir, 'remote-docker.json'));
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('parseEngineInfo', () => {
  it('reads the version and a rootless engine', () => {
    expect(parseEngineInfo(info(true).stdout)).toEqual({ version: '28.1.0', rootless: true });
    expect(parseEngineInfo(info(false).stdout)).toEqual({ version: '28.1.0', rootless: false });
  });

  it('needs a server version', () => {
    expect(parseEngineInfo('{"version":"","securityOptions":null}')).toBeUndefined();
    expect(parseEngineInfo('garbage')).toBeUndefined();
  });
});

describe('testRemoteDockerHost (the test before the switch)', () => {
  it('runs docker -H ssh://<host> info without questions, and without the context of VS Code', async () => {
    const docker = fakeDocker(() => info());
    await expect(testRemoteDockerHost(docker, 'me@box:2222', sshDeps())).resolves.toEqual({ ok: true, version: '28.1.0', rootless: false });
    expect(docker.calls).toHaveLength(1);
    const [{ args, options }] = docker.calls;
    expect(args).toEqual(['-H', 'ssh://me@box:2222', 'info', '--format', ENGINE_INFO_FORMAT]);
    expect(options?.timeoutMs).toBe(45_000);
    expect(options?.env?.SSH_ASKPASS_REQUIRE).toBe('never');
    expect(options?.env).not.toHaveProperty('DOCKER_CONTEXT');
    expect(options?.env).not.toHaveProperty('DOCKER_HOST');
    // The SSH agent of the user stays as it is.
    expect(options?.env?.SSH_AUTH_SOCK).toBe('/tmp/agent.sock');
  });

  // The key of Devspaces (sshKey.ts): the SSH check with -i, and the ssh of the Docker CLI through the wrapper.
  it('logs in with the key of Devspaces of a host that has it, also in the ssh of the Docker CLI', async () => {
    const docker = fakeDocker(() => info());
    const runner = sshRunner();
    const deps = {
      ...sshDeps(runner),
      identityFor: (host: string) => (host === 'box' ? '/home/me/.ssh/devspaces_ed25519' : undefined),
      sshEnv: (host: string, env: NodeJS.ProcessEnv) => {
        if (host === 'box') env.DEVSPACES_SSH_IDENTITY = '/home/me/.ssh/devspaces_ed25519';
      },
    };
    await expect(testRemoteDockerHost(docker, 'box', deps)).resolves.toMatchObject({ ok: true });
    expect(runner.run.mock.calls[0][1]).toEqual(expect.arrayContaining(['-i', '/home/me/.ssh/devspaces_ed25519']));
    expect(docker.calls[0].options?.env?.DEVSPACES_SSH_IDENTITY).toBe('/home/me/.ssh/devspaces_ed25519');
    await testRemoteDockerHost(docker, 'other', deps);
    expect(runner.run.mock.calls[1][1]).not.toContain('-i');
    expect(docker.calls[1].options?.env).not.toHaveProperty('DEVSPACES_SSH_IDENTITY');
  });

  // As a call on that host, so that BootstrapDocker runs it with the Docker CLI of Devspaces when it is installed.
  it('runs docker info as a call of an operation on the tested host', async () => {
    const targets: unknown[] = [];
    const docker = fakeDocker(() => {
      targets.push(operationDockerTarget());
      return info();
    });
    await testRemoteDockerHost(docker, 'me@box:2222', sshDeps());
    expect(targets).toEqual([remoteDockerTarget('me@box:2222')]);
    expect(operationDockerTarget()).toBeUndefined();
  });

  it.each([
    ['Permission denied (publickey).', 'login'],
    ['Host key verification failed.', 'hostKey'],
    ['ssh: Could not resolve hostname box: Name or service not known', 'unreachable'],
    ['bash: docker: command not found', 'dockerMissing'],
    ['Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?', 'dockerNotRunning'],
  ])('maps %s to %s', async (stderr, problem) => {
    const docker = fakeDocker(() => fail(`error during connect: ${stderr}`));
    await expect(testRemoteDockerHost(docker, 'box', sshDeps())).resolves.toMatchObject({ ok: false, problem });
  });

  it('counts a time-out as unreachable', async () => {
    const docker = fakeDocker(() => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }));
    await expect(testRemoteDockerHost(docker, 'box', sshDeps(), { timeoutMs: 1000 })).resolves.toEqual({
      ok: false,
      problem: 'unreachable',
      detail: 'docker info did not answer within 1 seconds.',
    });
  });

  // One login, which may ask for a password or a host key in a flow of the user: docker info of the host on its shell.
  it('logs in once with the shell of the host and runs docker info on it, when the window has shells', async () => {
    const docker = fakeDocker(() => info());
    const commands: string[] = [];
    const shells = {
      login: vi.fn(async () => ({ ok: true as const })),
      run: vi.fn(async (_host: string, command: string) => {
        commands.push(command);
        return info(true);
      }),
    };
    const sshLogins = new SshLoginCache();
    await expect(testRemoteDockerHost(docker, 'me@box:2222', { ...sshDeps(), shells, sshLogins })).resolves.toEqual({ ok: true, version: '28.1.0', rootless: true });
    // Always a new login, also when a shell to the host is open.
    expect(shells.login).toHaveBeenCalledWith('me@box:2222', undefined, { fresh: true });
    expect(commands).toEqual([`'docker' 'info' '--format' '${ENGINE_INFO_FORMAT}'`]);
    expect(docker.calls).toEqual([]);
    expect(sshLogins.isFresh('me@box:2222')).toBe(true);
    // A failed login names its reason, and the earlier success no longer counts; docker info does not run.
    shells.login.mockResolvedValueOnce({ ok: false, detail: 'Permission denied (publickey,password).', timedOut: false } as never);
    await expect(testRemoteDockerHost(docker, 'me@box:2222', { ...sshDeps(), shells, sshLogins })).resolves.toEqual({
      ok: false,
      problem: 'login',
      detail: 'Permission denied (publickey,password).',
    });
    expect(sshLogins.isFresh('me@box:2222')).toBe(false);
    shells.login.mockResolvedValueOnce({ ok: false, detail: 'ssh did not answer within 30 seconds.', timedOut: true } as never);
    await expect(testRemoteDockerHost(docker, 'box', { ...sshDeps(), shells })).resolves.toMatchObject({ ok: false, problem: 'unreachable' });
    expect(commands).toHaveLength(1);
    // A host without a transport (no alias or address) takes the way without the shell.
    shells.login.mockResolvedValueOnce(undefined as never);
    await expect(testRemoteDockerHost(docker, 'box', { ...sshDeps(), shells })).resolves.toMatchObject({ ok: true });
    expect(docker.calls).toHaveLength(1);
  });

  it('noPromptEnv replaces every spelling of SSH_ASKPASS_REQUIRE', () => {
    expect(noPromptEnv({ ssh_askpass_require: 'force', A: '1' })).toEqual({ A: '1', SSH_ASKPASS_REQUIRE: 'never' });
  });
});

describe('the ssh check before the Docker calls', () => {
  it('runs ssh with BatchMode, a connection time limit, no terminal, the host after --, and the command true', async () => {
    const runner = sshRunner();
    await expect(checkSshLogin('me@box:2222', { runner, sshPath: '/usr/bin/ssh', env: { PATH: '/usr/bin', SSH_ASKPASS_REQUIRE: 'force' } })).resolves.toEqual({ ok: true });
    const [file, args, options] = runner.run.mock.calls[0];
    expect(file).toBe('/usr/bin/ssh');
    expect(args).toEqual(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-T', '-p', '2222', '-l', 'me', '--', 'box', 'true']);
    expect(options?.env?.SSH_ASKPASS_REQUIRE).toBe('never');
    expect(options?.timeoutMs).toBe(30_000);
    await checkSshLogin('me@[2001:db8::1]:22', { runner, sshPath: '/usr/bin/ssh', env: {} });
    expect(runner.run.mock.calls[1][1]).toEqual(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-T', '-p', '22', '-l', 'me', '--', '2001:db8::1', 'true']);
  });

  it.each([
    ['Host key verification failed.', 'hostKey'],
    ['me@box: Permission denied (publickey,password).', 'login'],
    ['ssh: Could not resolve hostname box: Name or service not known', 'unreachable'],
    ['ssh: connect to host box port 22: Connection timed out', 'unreachable'],
    ['Connection closed by 192.0.2.10 port 22', 'closedBeforeLogin'],
  ])('names the reason of %s: %s', async (stderr, problem) => {
    const runner = sshRunner('', { exitCode: 255, stdout: '', stderr, timedOut: false });
    await expect(checkSshLogin('box', { runner, sshPath: '/usr/bin/ssh', env: {} })).resolves.toEqual({ ok: false, problem, detail: stderr });
  });

  it('counts a time-out as unreachable, and fails without ssh', async () => {
    const runner = sshRunner('', { exitCode: null, stdout: '', stderr: '', timedOut: true });
    await expect(checkSshLogin('box', { runner, sshPath: '/usr/bin/ssh', env: {} })).resolves.toMatchObject({ ok: false, problem: 'unreachable' });
    await expect(checkSshLogin('box', { runner, sshPath: undefined, env: {} })).resolves.toMatchObject({ ok: false, problem: 'sshMissing' });
  });

  it('leaves a host that is no SSH alias or address to the Docker CLI', async () => {
    const runner = sshRunner();
    await expect(checkSshLogin('me@box/path', { runner, sshPath: '/usr/bin/ssh', env: {} })).resolves.toEqual({ ok: true, skipped: 'notAnSshTarget' });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('keeps a success for a minute per host, never a failure', async () => {
    let now = 1_000_000;
    const sshLogins = new SshLoginCache({ now: () => now });
    const runner = sshRunner();
    const deps = { runner, sshPath: '/usr/bin/ssh', env: {}, sshLogins };
    await checkSshLogin('box', deps);
    await checkSshLogin('box', deps);
    expect(runner.run).toHaveBeenCalledTimes(1);
    await checkSshLogin('other', deps);
    expect(runner.run).toHaveBeenCalledTimes(2);
    now += SSH_CHECK_CACHE_MS;
    await checkSshLogin('box', deps);
    expect(runner.run).toHaveBeenCalledTimes(3);
    // A failure is not kept, and ends a kept success.
    runner.run.mockImplementation(async () => fail('Permission denied (publickey).', 255));
    await expect(checkSshLogin('box', deps, { useCache: false })).resolves.toMatchObject({ ok: false, problem: 'login' });
    await expect(checkSshLogin('box', deps)).resolves.toMatchObject({ ok: false, problem: 'login' });
    expect(runner.run).toHaveBeenCalledTimes(5);
  });

  it('skips the check while the Docker calls to the host go through the Docker pipe of the extension, except for the test before a switch', async () => {
    const runner = sshRunner();
    const viaDockerPipe = vi.fn((host: string) => host === 'box');
    const deps = { runner, sshPath: '/usr/bin/ssh', env: {}, viaDockerPipe };
    await expect(checkSshLogin('box', deps)).resolves.toEqual({ ok: true, skipped: 'dockerPipe' });
    expect(runner.run).not.toHaveBeenCalled();
    await expect(checkSshLogin('other', deps)).resolves.toEqual({ ok: true });
    await expect(checkSshLogin('box', deps, { useCache: false })).resolves.toEqual({ ok: true });
    expect(runner.run).toHaveBeenCalledTimes(2);
    expect(viaDockerPipe.mock.calls.map(([host]) => host)).toEqual(['box', 'other']);
  });

  it('is the login of the shell before the relay when the host has one, except for the test before a switch', async () => {
    const runner = sshRunner();
    const sshLogins = new SshLoginCache();
    const login = vi.fn(async (host: string): Promise<{ ok: true } | { ok: false; detail: string; timedOut: boolean } | undefined> =>
      host === 'box' ? { ok: true } : host === 'down' ? { ok: false, detail: 'ssh: connect to host down port 22: Connection refused', timedOut: false } : undefined,
    );
    const shells = { login, run: vi.fn(async () => undefined) };
    const deps = { runner, sshPath: '/usr/bin/ssh', env: {}, sshLogins, shells };
    const signal = new AbortController().signal;
    await expect(checkSshLogin('box', deps, { signal })).resolves.toEqual({ ok: true });
    expect(login).toHaveBeenCalledWith('box', signal);
    expect(sshLogins.isFresh('box')).toBe(true);
    await expect(checkSshLogin('down', deps)).resolves.toEqual({ ok: false, problem: 'unreachable', detail: 'ssh: connect to host down port 22: Connection refused' });
    login.mockResolvedValueOnce({ ok: false, detail: 'ssh did not answer within 30 seconds.', timedOut: true });
    await expect(checkSshLogin('slow', deps)).resolves.toEqual({ ok: false, problem: 'unreachable', detail: 'ssh did not answer within 30 seconds.' });
    expect(runner.run).not.toHaveBeenCalled();
    // A host without a shell (no transport), and the test before a switch: `ssh … true`.
    await expect(checkSshLogin('other', deps)).resolves.toEqual({ ok: true });
    await expect(checkSshLogin('box', deps, { useCache: false })).resolves.toEqual({ ok: true });
    expect(runner.run).toHaveBeenCalledTimes(2);
    expect(login.mock.calls.map(([host]) => host)).toEqual(['box', 'down', 'slow', 'other']);
  });

  it('runs before docker -H ssh://… info of the test, always connects, and stops at its failure', async () => {
    const sshLogins = new SshLoginCache();
    sshLogins.remember('box');
    const docker = fakeDocker(() => info());
    const failing = sshRunner('', fail('Host key verification failed.', 255));
    await expect(testRemoteDockerHost(docker, 'box', { ...sshDeps(failing), sshLogins })).resolves.toEqual({
      ok: false,
      problem: 'hostKey',
      detail: 'Host key verification failed.',
    });
    expect(failing.run).toHaveBeenCalledTimes(1);
    expect(docker.calls).toEqual([]);
  });

  it('runs before docker info of each operation (a success of the last minute counts), and stops at its failure', async () => {
    const target = remoteDockerTarget('me@box:2222');
    const docker = fakeDocker(() => info());
    const runner = sshRunner();
    const sshLogins = new SshLoginCache();
    const deps = { docker, runner, state, logger, sshPath: '/usr/bin/ssh', env: {}, sshLogins };
    await ensureDockerHostReachable(target, deps);
    await ensureDockerHostReachable(target, deps);
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(docker.calls).toHaveLength(2);
    sshLogins.forget('me@box:2222');
    runner.run.mockImplementation(async () => fail('Host key verification failed.', 255));
    await expect(ensureDockerHostReachable(target, deps)).rejects.toMatchObject({
      code: 'dockerHostUnreachable',
      message: Messages.dockerHostUnreachable('me@box:2222', dockerHostReason('hostKey', 'me@box:2222')),
    });
    expect(docker.calls).toHaveLength(2);
  });
});

describe('the WSL distribution of Devspaces: no SSH', () => {
  type Login = { ok: true } | { ok: false; detail: string; timedOut: boolean } | undefined;
  // `null`: the window has no shell for the distribution (no wsl.exe).
  const wslShells = (login: Login | null = { ok: true }, answer: RunResult | null = info()) => ({
    login: vi.fn(async (_host: string, _signal?: AbortSignal, _options?: { fresh?: boolean }): Promise<Login> => login ?? undefined),
    run: vi.fn(async (_host: string, _command: string, _options?: Pick<RunOptions, 'timeoutMs' | 'signal'>): Promise<RunResult | undefined> => answer ?? undefined),
  });
  const missing = { ok: false, detail: 'There is no distribution with the supplied name.\r\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND', timedOut: false } as const;

  it('tests the distribution on a new shell before the relay (wsl.exe), never with ssh or docker -H', async () => {
    const docker = fakeDocker(() => info());
    const runner = sshRunner();
    const shells = wslShells();
    const sshLogins = new SshLoginCache();
    await expect(testRemoteDockerHost(docker, WSL_HOST, { runner, sshPath: undefined, env: {}, shells, sshLogins })).resolves.toEqual({ ok: true, version: '28.1.0', rootless: false });
    expect(shells.login).toHaveBeenCalledWith(WSL_HOST, undefined, { fresh: true });
    expect(shells.run.mock.calls.map((call) => call[1])).toEqual([`'docker' 'info' '--format' '${ENGINE_INFO_FORMAT}'`]);
    expect(sshLogins.isFresh(WSL_HOST)).toBe(true);
    expect(docker.calls).toEqual([]);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('names a distribution that is not registered, a missing wsl.exe, and a missing Docker in it', async () => {
    const docker = fakeDocker(() => info());
    const deps = { runner: sshRunner(), sshPath: '/usr/bin/ssh', env: {} };
    await expect(testRemoteDockerHost(docker, WSL_HOST, { ...deps, shells: wslShells(missing) })).resolves.toMatchObject({ ok: false, problem: 'wslDistributionMissing' });
    // The UTF-16 text of an older wsl.exe: its NUL bytes are dropped from the detail.
    const utf16 = { ...missing, detail: Buffer.from('There is no distribution with the supplied name.', 'utf16le').toString('utf8') };
    await expect(testRemoteDockerHost(docker, WSL_HOST, { ...deps, shells: wslShells(utf16) })).resolves.toEqual({
      ok: false,
      problem: 'wslDistributionMissing',
      detail: 'There is no distribution with the supplied name.',
    });
    await expect(testRemoteDockerHost(docker, WSL_HOST, { ...deps, shells: wslShells(null) })).resolves.toMatchObject({ ok: false, problem: 'wslMissing' });
    await expect(testRemoteDockerHost(docker, WSL_HOST, deps)).resolves.toMatchObject({ ok: false, problem: 'wslMissing' });
    await expect(testRemoteDockerHost(docker, WSL_HOST, { ...deps, shells: wslShells({ ok: true }, fail('sh: 1: docker: not found', 127)) })).resolves.toMatchObject({
      ok: false,
      problem: 'dockerMissing',
    });
    expect(docker.calls).toEqual([]);
    expect(deps.runner.run).not.toHaveBeenCalled();
    expect(dockerHostReason('wslDistributionMissing', WSL_HOST)).toBe('The WSL distribution devspaces is not installed on this computer.');
    expect(dockerHostReason('wslMissing', WSL_HOST)).toBe('WSL (wsl.exe) was not found on this computer.');
  });

  it('checks the distribution with the start of its shell before an operation, also while its Docker pipe listens', async () => {
    const runner = sshRunner();
    const sshLogins = new SshLoginCache();
    const shells = wslShells();
    const deps = { runner, sshPath: '/usr/bin/ssh', env: {}, sshLogins, shells, viaDockerPipe: () => true };
    await expect(checkSshLogin(WSL_HOST, deps)).resolves.toEqual({ ok: true });
    // A success of the last minute counts.
    await expect(checkSshLogin(WSL_HOST, deps)).resolves.toEqual({ ok: true, skipped: 'cached' });
    expect(shells.login).toHaveBeenCalledTimes(1);
    sshLogins.forget(WSL_HOST);
    shells.login.mockResolvedValueOnce(missing);
    await expect(checkSshLogin(WSL_HOST, deps)).resolves.toMatchObject({ ok: false, problem: 'wslDistributionMissing' });
    expect(sshLogins.isFresh(WSL_HOST)).toBe(false);
    await expect(checkSshLogin(WSL_HOST, { ...deps, shells: undefined })).resolves.toMatchObject({ ok: false, problem: 'wslMissing' });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('reaches the engine of an operation there after the check, and says why it cannot', async () => {
    const docker = fakeDocker(() => info());
    const runner = sshRunner();
    const shells = wslShells();
    await ensureDockerHostReachable(remoteDockerTarget(WSL_HOST), { docker, runner, state, logger, sshPath: undefined, env: {}, shells });
    expect(docker.calls.map((call) => call.args)).toEqual([['info', '--format', ENGINE_INFO_FORMAT]]);
    const error = await ensureDockerHostReachable(remoteDockerTarget(WSL_HOST), { docker, runner, state, logger, sshPath: undefined, env: {}, shells: wslShells(missing) }).catch(
      (caught: unknown) => caught,
    );
    expect((error as UserFacingError).message).toBe(Messages.dockerHostUnreachable(WSL_HOST, dockerHostReason('wslDistributionMissing', WSL_HOST)));
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('reads the runtime folder of a rootless engine only on its shell', async () => {
    const runner = { run: vi.fn(async () => ok('/run/user/9')) };
    await expect(readRootlessSocket(runner, undefined, WSL_HOST, {}, undefined, wslShells({ ok: true }, ok('/run/user/0')))).resolves.toEqual({ ok: true, socket: '/run/user/0/docker.sock' });
    await expect(readRootlessSocket(runner, '/usr/bin/ssh', WSL_HOST, {}, undefined, wslShells({ ok: true }, null))).resolves.toMatchObject({ ok: false, problem: 'wslMissing' });
    await expect(readRootlessSocket(runner, '/usr/bin/ssh', WSL_HOST, {})).resolves.toMatchObject({ ok: false, problem: 'wslMissing' });
    expect(runner.run).not.toHaveBeenCalled();
  });
});

describe('readRootlessSocket', () => {
  it('asks ssh with BatchMode for XDG_RUNTIME_DIR; the host after --', async () => {
    const runner = { run: vi.fn(async (_file: string, _args: readonly string[], _options?: RunOptions) => ok('/run/user/1001')) };
    await expect(readRootlessSocket(runner, '/usr/bin/ssh', 'me@box:2222', { PATH: '/usr/bin' })).resolves.toEqual({
      ok: true,
      socket: '/run/user/1001/docker.sock',
    });
    const [file, args, options] = runner.run.mock.calls[0];
    expect(file).toBe('/usr/bin/ssh');
    expect(args).toEqual(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-T', '-p', '2222', '-l', 'me', '--', 'box', 'printf %s "$XDG_RUNTIME_DIR"']);
    expect(options?.env?.SSH_ASKPASS_REQUIRE).toBe('never');
  });

  it('asks the shell before the relay when the host has one', async () => {
    const runner = { run: vi.fn(async () => ok('/run/user/9')) };
    const run = vi.fn(async (host: string, _command: string, _options?: Pick<RunOptions, 'timeoutMs' | 'signal'>) => (host === 'box' ? ok('/run/user/1001') : undefined));
    const shells = { login: vi.fn(async () => undefined), run };
    await expect(readRootlessSocket(runner, '/usr/bin/ssh', 'box', {}, undefined, shells)).resolves.toEqual({ ok: true, socket: '/run/user/1001/docker.sock' });
    expect(run).toHaveBeenCalledWith('box', 'printf %s "$XDG_RUNTIME_DIR"', { timeoutMs: 30_000, signal: undefined });
    expect(runner.run).not.toHaveBeenCalled();
    await expect(readRootlessSocket(runner, '/usr/bin/ssh', 'other', {}, undefined, shells)).resolves.toEqual({ ok: true, socket: '/run/user/9/docker.sock' });
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it('fails without ssh, for an unusable host, and without XDG_RUNTIME_DIR', async () => {
    const runner = { run: vi.fn(async () => ok('')) };
    await expect(readRootlessSocket(runner, undefined, 'box', {})).resolves.toMatchObject({ ok: false, problem: 'sshMissing' });
    await expect(readRootlessSocket(runner, '/usr/bin/ssh', 'box/path', {})).resolves.toMatchObject({ ok: false, problem: 'unknown' });
    await expect(readRootlessSocket(runner, '/usr/bin/ssh', 'box', {})).resolves.toMatchObject({ ok: false, problem: 'unknown' });
    expect(runner.run).toHaveBeenCalledTimes(1);
  });
});

describe('ensureDockerHostReachable (the Docker start of a remote host)', () => {
  const target = remoteDockerTarget('box');

  it('asks docker info of the host; a rootful engine has no recorded socket', async () => {
    await state.setRootlessSocket('box', '/run/user/1000/docker.sock');
    const docker = fakeDocker(() => info(false));
    const runner = sshRunner();
    await ensureDockerHostReachable(target, { docker, runner, state, logger, sshPath: '/usr/bin/ssh', env: {} });
    expect(docker.calls.map((call) => call.args)).toEqual([['info', '--format', ENGINE_INFO_FORMAT]]);
    // Only the ssh check runs; no read of a socket.
    expect(runner.run.mock.calls.map((call) => call[1])).toEqual([['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-T', '--', 'box', 'true']]);
    expect(await state.rootlessSocket('box')).toBeUndefined();
  });

  it('asks only docker info while the Docker calls to the host go through the Docker pipe of the extension', async () => {
    const docker = fakeDocker(() => info(false));
    const runner = sshRunner();
    await ensureDockerHostReachable(target, { docker, runner, state, logger, sshPath: '/usr/bin/ssh', env: {}, viaDockerPipe: (host) => host === 'box' });
    expect(docker.calls.map((call) => call.args)).toEqual([['info', '--format', ENGINE_INFO_FORMAT]]);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('records the socket of a rootless engine once', async () => {
    const docker = fakeDocker(() => info(true));
    const runner = sshRunner('/run/user/1000');
    const deps = { docker, runner, state, logger, sshPath: '/usr/bin/ssh', env: {} };
    await ensureDockerHostReachable(target, deps);
    await ensureDockerHostReachable(target, deps);
    // The ssh checks are not counted here.
    expect(runner.run.mock.calls.filter((call) => !isSshCheck(call[1]))).toHaveLength(1);
    expect(await state.rootlessSocket('box')).toBe('/run/user/1000/docker.sock');
  });

  it('throws dockerHostUnreachable with the plain reason', async () => {
    const docker = fakeDocker(() => fail('me@box: Permission denied (publickey).'));
    // With ssh (without it, the ssh check reports sshMissing).
    const error = await ensureDockerHostReachable(target, { docker, runner: sshRunner(), state, logger, sshPath: '/usr/bin/ssh', env: {} }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(UserFacingError);
    expect((error as UserFacingError).code).toBe('dockerHostUnreachable');
    expect((error as UserFacingError).message).toBe(Messages.dockerHostUnreachable('box', dockerHostReason('login', 'box')));
    expect((error as UserFacingError).detail).toContain('Permission denied');
  });

  it('checkCurrentEngine passes the signal and never adds -H', async () => {
    const docker = fakeDocker(() => info());
    const signal = new AbortController().signal;
    await checkCurrentEngine(docker, { signal });
    expect(docker.calls[0].options?.signal).toBe(signal);
    expect(docker.calls[0].args).not.toContain('-H');
  });
});

describe('startDockerFor (remote mode skips the Docker Desktop start)', () => {
  it('starts the local Docker as before', async () => {
    const startLocal = vi.fn(async () => {});
    const docker = fakeDocker(() => info());
    await startDockerFor({ kind: 'local', host: '', endpoint: 'unix:///var/run/docker.sock' }, startLocal, {
      docker,
      runner: { run: vi.fn() },
      state,
      logger,
      sshPath: undefined,
      env: {},
    });
    expect(startLocal).toHaveBeenCalledTimes(1);
    expect(docker.calls).toEqual([]);
  });

  it('only checks a remote host: no Docker Desktop start, no desktop command', async () => {
    const startLocal = vi.fn(async () => {});
    const docker = fakeDocker(() => fail('ssh: connect to host box port 22: Connection refused'));
    const runner = sshRunner();
    await expect(
      startDockerFor({ kind: 'remote', host: 'box', endpoint: 'ssh://box' }, startLocal, { docker, runner, state, logger, sshPath: '/usr/bin/ssh', env: {} }),
    ).rejects.toMatchObject({ code: 'dockerHostUnreachable', message: Messages.dockerHostUnreachable('box', dockerHostReason('unreachable', 'box')) });
    expect(startLocal).not.toHaveBeenCalled();
    // The ssh check ran; nothing else.
    expect(runner.run.mock.calls.every((call) => isSshCheck(call[1]))).toBe(true);
    expect(docker.calls.flatMap((call) => call.args)).not.toContain('desktop');
  });

  it('refuses an endpoint that is neither local nor SSH', async () => {
    const startLocal = vi.fn(async () => {});
    const docker = fakeDocker(() => info());
    await expect(
      startDockerFor({ kind: 'unsupported', host: 'tcp://box:2376', endpoint: 'tcp://box:2376' }, startLocal, {
        docker,
        runner: { run: vi.fn() },
        state,
        logger,
        sshPath: undefined,
        env: {},
      }),
    ).rejects.toMatchObject({ code: 'dockerEndpointUnsupported', message: Messages.dockerEndpointUnsupported('tcp://box:2376') });
    expect(startLocal).not.toHaveBeenCalled();
    expect(docker.calls).toEqual([]);
  });

  // Docker Desktop is not started for a Docker that is not known.
  it('refuses a current context that could not be read, with its own message', async () => {
    const startLocal = vi.fn(async () => {});
    const docker = fakeDocker(() => info());
    await expect(
      startDockerFor(UNREADABLE_DOCKER_TARGET, startLocal, { docker, runner: { run: vi.fn() }, state, logger, sshPath: undefined, env: {} }),
    ).rejects.toMatchObject({ code: 'dockerEndpointUnsupported', message: Messages.dockerContextUnreadable });
    expect(startLocal).not.toHaveBeenCalled();
    expect(docker.calls).toEqual([]);
  });
});

const LS_ARGS = ['context', 'ls', '--format', '{{json .}}'];

// The contexts of the user: Devspaces only reads them, for the SSH hosts that "Use a Remote Docker Host…" offers.
describe('listContextInfos', () => {
  it('lists the name, the description and the endpoint of every context, without DOCKER_CONTEXT and DOCKER_HOST in its environment', async () => {
    const docker = fakeDocker(() =>
      ok(
        [
          JSON.stringify({ Name: 'default', Description: 'Current DOCKER_HOST based configuration', DockerEndpoint: 'unix:///var/run/docker.sock', Current: true }),
          '',
          JSON.stringify({ Name: 'htldvm', Description: 'my box', DockerEndpoint: 'ssh://htldvm' }),
          JSON.stringify({ Name: 'bare' }),
          JSON.stringify({ Name: '' }),
          'null',
        ].join('\n'),
      ),
    );
    await expect(listContextInfos(docker)).resolves.toEqual([
      { name: 'default', description: 'Current DOCKER_HOST based configuration', endpoint: 'unix:///var/run/docker.sock' },
      { name: 'htldvm', description: 'my box', endpoint: 'ssh://htldvm' },
      { name: 'bare', description: '', endpoint: '' },
    ]);
    expect(docker.calls.map((call) => call.args)).toEqual([LS_ARGS]);
    expect(docker.calls[0].options?.env).not.toHaveProperty('DOCKER_CONTEXT');
    expect(docker.calls[0].options?.env).not.toHaveProperty('DOCKER_HOST');
    expect(docker.calls[0].options?.timeoutMs).toBe(CONTEXT_COMMAND_TIMEOUT_MS);
  });

  it('refuses a line of `docker context ls` that is not JSON, and throws when the command fails', async () => {
    await expect(listContextInfos(fakeDocker(() => ok('default\n')))).rejects.toThrow('printed a line that is not JSON: default');
    await expect(listContextInfos(fakeDocker(() => fail('broken')))).rejects.toThrow('docker context ls --format {{json .}} failed: broken');
  });
});

describe('RemoteDockerState', () => {
  it('remembers the rootless sockets per host', async () => {
    expect(await state.read()).toEqual({});
    await state.setRootlessSocket('box', '/run/user/1000/docker.sock');
    await state.setRootlessSocket('__proto__', '/run/user/1/docker.sock');
    expect(await state.rootlessSocket('box')).toBe('/run/user/1000/docker.sock');
    expect(await state.rootlessSocket('__proto__')).toBe('/run/user/1/docker.sock');
    expect(await state.rootlessSocket('other')).toBeUndefined();
    await state.setRootlessSocket('box', undefined);
    expect(await state.read()).toEqual({ hosts: [{ host: '__proto__', rootlessSocket: '/run/user/1/docker.sock' }] });
  });

  it('ignores invalid content', async () => {
    fs.writeFileSync(state.file, JSON.stringify({ other: 3, dockerHost: 7, hosts: [{ host: 'a', rootlessSocket: 'relative' }, 'x', { host: '' }] }));
    expect(await state.read()).toEqual({ hosts: [{ host: 'a' }] });
  });
});
