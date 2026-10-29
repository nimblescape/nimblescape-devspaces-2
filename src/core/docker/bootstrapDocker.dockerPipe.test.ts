// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Docker calls of an operation on an SSH host go through the Docker pipe of the extension for the host while a
// connection of the relay to it is open (BootstrapDockerOptions.dockerPipe): DOCKER_HOST is the pipe, without
// DOCKER_CONTEXT and the TLS variables. Without the pipe, for the checks of a new connection (runWithoutPipe), and for
// the start of the worker, DOCKER_HOST is `ssh://<host>`, and each such call logs in itself. Outside of an operation and
// for the local Docker, the calls go as before.
import { describe, expect, it, vi } from 'vitest';
import { silentLogger, type Logger, type ProcessRunner, type RunOptions, type RunResult, type StartedProcess } from '../ports';
import { BootstrapDocker, isShellCall } from './bootstrapDocker';
import { LOCAL_DOCKER_TARGET, remoteDockerTarget, type DockerTarget } from './dockerHost';
import { runWithDockerTarget } from './dockerTargets';

const OK: RunResult = { exitCode: 0, stdout: '', stderr: '', timedOut: false };
const PIPE = 'unix:///run/user/1000/devspaces-0123456789abcdef/docker.sock';
const SSH = 'ssh://build-box';
const REMOTE = remoteDockerTarget('build-box');

function recorder(): { runner: ProcessRunner; envs: NodeJS.ProcessEnv[]; starts: NodeJS.ProcessEnv[] } {
  const envs: NodeJS.ProcessEnv[] = [];
  const starts: NodeJS.ProcessEnv[] = [];
  const runner: ProcessRunner = {
    async run(_file: string, _args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
      envs.push(options.env ?? {});
      return OK;
    },
    start: (_file, _args, options) => {
      starts.push(options?.env ?? {});
      return {} as StartedProcess;
    },
  };
  return { runner, envs, starts };
}

describe('BootstrapDocker: the Docker pipe of the extension', () => {
  it('gives the calls of an operation on an SSH host the pipe as DOCKER_HOST, without the context and the TLS variables', async () => {
    const { runner, envs } = recorder();
    const dockerPipe = vi.fn((target: { host: string }) => (target.host === 'build-box' ? PIPE : undefined));
    const env = { PATH: '/usr/bin', Docker_Context: 'desktop-linux', DOCKER_HOST: 'ssh://build-box', DOCKER_TLS_VERIFY: '1', DOCKER_CERT_PATH: '/certs', DOCKER_TLS: '1', DOCKER_CONFIG: '/home/me/.docker' };
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', env, silentLogger, 'win32', { dockerPipe });
    await runWithDockerTarget(REMOTE, () => docker.run(['container', 'inspect', 'x']));
    expect(dockerPipe).toHaveBeenCalledWith(REMOTE);
    const keys = Object.keys(envs[0]).filter((key) => key.toUpperCase().startsWith('DOCKER_'));
    expect(keys.sort()).toEqual(['DOCKER_CONFIG', 'DOCKER_HOST']);
    expect(envs[0].DOCKER_HOST).toBe(PIPE);
    expect(envs[0].DOCKER_CONFIG).toBe('/home/me/.docker');
  });

  it('gives the calls of an operation on an SSH host ssh://<host> without the pipe, and asks for no pipe outside of an operation or for the local Docker', async () => {
    const { runner, envs } = recorder();
    const dockerPipe = vi.fn((): string | undefined => undefined);
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, silentLogger, 'linux', { dockerPipe });
    await runWithDockerTarget(REMOTE, () => docker.run(['container', 'inspect', 'x']));
    expect(envs[0].DOCKER_HOST).toBe(SSH);
    expect(envs[0].DOCKER_CONTEXT).toBeUndefined();
    expect(dockerPipe).toHaveBeenCalledTimes(1);
    dockerPipe.mockReturnValue(PIPE);
    await docker.run(['container', 'inspect', 'x']);
    await runWithDockerTarget(LOCAL_DOCKER_TARGET, () => docker.run(['container', 'inspect', 'x']));
    expect(envs[1].DOCKER_HOST).toBeUndefined();
    expect(envs[2].DOCKER_HOST).toBeUndefined();
    expect(dockerPipe).toHaveBeenCalledTimes(1);
  });

  it('runs the checks of a new connection of the relay with ssh://<host> also while the host has the pipe', async () => {
    const { runner, envs } = recorder();
    const dockerPipe = vi.fn(() => PIPE);
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, silentLogger, 'linux', { dockerPipe });
    await runWithDockerTarget(REMOTE, () => docker.runWithoutPipe(['info', '--format', '{{json .ID}}']));
    expect(envs[0].DOCKER_HOST).toBe(SSH);
    expect(envs[0].DOCKER_CONTEXT).toBeUndefined();
    expect(dockerPipe).not.toHaveBeenCalled();
    // `run` takes the pipe.
    await runWithDockerTarget(REMOTE, () => docker.run(['info', '--format', '{{json .ID}}']));
    expect(envs[1].DOCKER_HOST).toBe(PIPE);
  });

  it('logs each call of an operation on an SSH host that logs in over SSH, never a call through the pipe', async () => {
    const { runner } = recorder();
    const lines: string[] = [];
    const logger: Logger = { ...silentLogger, info: (message) => lines.push(message) };
    let pipe: string | undefined;
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, logger, 'linux', { dockerPipe: () => pipe });
    await runWithDockerTarget(REMOTE, () => docker.run(['image', 'inspect', 'x']));
    pipe = PIPE;
    await runWithDockerTarget(REMOTE, () => docker.run(['image', 'inspect', 'x']));
    await runWithDockerTarget(REMOTE, () => docker.runWithoutPipe(['info', '--format', '{{json .ID}}']));
    await runWithDockerTarget(LOCAL_DOCKER_TARGET, () => docker.run(['image', 'inspect', 'x']));
    // Outside an operation, the Docker CLI uses the local Docker.
    await docker.run(['info']);
    // The commands of the Docker contexts and the version of the CLI log in nowhere.
    pipe = undefined;
    await runWithDockerTarget(REMOTE, () => docker.run(['context', 'inspect', '--format', '{{json .}}']));
    await runWithDockerTarget(REMOTE, () => docker.run(['--version']));
    expect(lines).toEqual(['docker image inspect x logs in to build-box over SSH.', 'docker info --format {{json .ID}} logs in to build-box over SSH.']);
  });

  it('starts the worker (standard input open) never through the pipe', async () => {
    const { runner, starts } = recorder();
    const dockerPipe = vi.fn(() => PIPE);
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, silentLogger, 'linux', { dockerPipe });
    await runWithDockerTarget(REMOTE, async () => docker.start(['run', '-i', 'img']));
    expect(starts[0].DOCKER_HOST).toBe(SSH);
    expect(starts[0].DOCKER_CONTEXT).toBeUndefined();
    expect(dockerPipe).not.toHaveBeenCalled();
  });

  it('logs in over SSH when the lookup of the pipe fails', async () => {
    const { runner, envs } = recorder();
    const warnings: string[] = [];
    const logger: Logger = { ...silentLogger, warn: (message) => warnings.push(message) };
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, logger, 'linux', {
      dockerPipe: () => {
        throw new Error('broken');
      },
    });
    await runWithDockerTarget(REMOTE, () => docker.run(['container', 'inspect', 'x']));
    expect(envs[0].DOCKER_HOST).toBe(SSH);
    expect(envs[0].DOCKER_CONTEXT).toBeUndefined();
    expect(warnings).toEqual(['The Docker pipe of build-box could not be looked up, so the call logs in itself: broken']);
  });
});

describe('BootstrapDocker: the shell before the relay', () => {
  const SHELL: RunResult = { exitCode: 0, stdout: 'from the shell', stderr: '', timedOut: false };

  it('runs a call of an operation on an SSH host that only reads on the shell while the host has no pipe', async () => {
    const { runner, envs } = recorder();
    let pipe: string | undefined;
    const remoteShell = vi.fn(async () => SHELL);
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, silentLogger, 'linux', { dockerPipe: () => pipe, remoteShell });
    const signal = new AbortController().signal;
    await expect(runWithDockerTarget(REMOTE, () => docker.run(['image', 'inspect', '--format', '{{json .Id}}', 'x'], { timeoutMs: 5_000, signal }))).resolves.toEqual(SHELL);
    // runWithoutPipe too: the checks of a new connection of the relay.
    await expect(runWithDockerTarget(REMOTE, () => docker.runWithoutPipe(['info', '--format', '{{json .ID}}']))).resolves.toEqual(SHELL);
    expect(remoteShell.mock.calls).toEqual([
      [REMOTE, ['image', 'inspect', '--format', '{{json .Id}}', 'x'], { timeoutMs: 5_000, signal }],
      [REMOTE, ['info', '--format', '{{json .ID}}'], { timeoutMs: undefined, signal: undefined }],
    ]);
    expect(envs).toEqual([]);
    // With the pipe, the call goes through it, and runWithoutPipe still on the shell.
    pipe = PIPE;
    await runWithDockerTarget(REMOTE, () => docker.run(['image', 'inspect', 'x']));
    await runWithDockerTarget(REMOTE, () => docker.runWithoutPipe(['info']));
    expect(envs.map((env) => env.DOCKER_HOST)).toEqual([PIPE]);
    expect(remoteShell).toHaveBeenCalledTimes(3);
  });

  it('logs in over SSH for the calls that the shell does not take, and when the host has no shell', async () => {
    const { runner, envs } = recorder();
    const lines: string[] = [];
    const logger: Logger = { ...silentLogger, info: (message) => lines.push(message) };
    const remoteShell = vi.fn(async (_target: DockerTarget, args: readonly string[]) => (args[0] === 'ps' ? undefined : SHELL));
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, logger, 'linux', { remoteShell });
    await runWithDockerTarget(REMOTE, async () => {
      // A call that changes something, a CLI option of this computer, the client version, the contexts, input, a folder,
      // output listeners, and the environment of the caller.
      await docker.run(['volume', 'create', 'x']);
      await docker.run(['--config', '/home/me/.docker', 'info']);
      await docker.run(['version', '--format', '{{json .Server}}']);
      await docker.run(['context', 'inspect']);
      await docker.run(['image', 'inspect', 'x'], { input: 'x' });
      await docker.run(['image', 'inspect', 'x'], { cwd: '/tmp' });
      await docker.run(['image', 'inspect', 'x'], { onStdout: () => {} });
      await docker.run(['image', 'inspect', 'x'], { env: { PATH: '/usr/bin' } });
      // The host has no shell for it.
      await docker.run(['ps']);
    });
    await runWithDockerTarget(LOCAL_DOCKER_TARGET, () => docker.run(['image', 'inspect', 'x']));
    await docker.run(['image', 'inspect', 'x']);
    expect(remoteShell.mock.calls.map(([, args]) => args)).toEqual([['ps']]);
    expect(envs).toHaveLength(11);
    expect(lines.filter((line) => line.endsWith('logs in to build-box over SSH.'))).toEqual([
      'docker volume create x logs in to build-box over SSH.',
      'docker --config /home/me/.docker info logs in to build-box over SSH.',
      'docker version --format {{json .Server}} logs in to build-box over SSH.',
      'docker image inspect x logs in to build-box over SSH.',
      'docker image inspect x logs in to build-box over SSH.',
      'docker image inspect x logs in to build-box over SSH.',
      'docker ps logs in to build-box over SSH.',
    ]);
  });

  it('logs a failure of the shell and logs in over SSH; an abort is no failure', async () => {
    const { runner, envs } = recorder();
    const lines: string[] = [];
    const logger: Logger = { ...silentLogger, warn: (message) => lines.push(message) };
    const remoteShell = vi.fn(async (): Promise<RunResult | undefined> => {
      throw new Error('broken');
    });
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, logger, 'linux', { remoteShell });
    await expect(runWithDockerTarget(REMOTE, () => docker.run(['image', 'inspect', 'x']))).resolves.toEqual(OK);
    expect(lines).toEqual(['docker image inspect could not run on the shell before the relay on build-box, so it logs in over SSH itself: broken']);
    expect(envs).toHaveLength(1);
    remoteShell.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await expect(runWithDockerTarget(REMOTE, () => docker.run(['image', 'inspect', 'x']))).rejects.toMatchObject({ name: 'AbortError' });
    expect(envs).toHaveLength(1);
  });
});

describe('isShellCall', () => {
  it('takes the calls that only read and reach the engine, without a global option and without docker version', () => {
    expect(isShellCall(['info', '--format', '{{json .ServerVersion}}'])).toBe(true);
    expect(isShellCall(['image', 'inspect', 'x'])).toBe(true);
    expect(isShellCall(['ps', '--all'])).toBe(true);
    expect(isShellCall(['volume', 'ls'])).toBe(true);
    expect(isShellCall(['version'])).toBe(false);
    expect(isShellCall(['context', 'ls'])).toBe(false);
    expect(isShellCall(['-H', 'ssh://box', 'info'])).toBe(false);
    expect(isShellCall(['--version'])).toBe(false);
    expect(isShellCall(['run', 'x'])).toBe(false);
    expect(isShellCall(['build', '-'])).toBe(false);
    expect(isShellCall([])).toBe(false);
  });
});
