// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Docker calls of an operation on an SSH host go through the Docker pipe of the extension for the host while a
// connection of the relay to it is open (BootstrapDockerOptions.dockerPipe): DOCKER_HOST is the pipe, without
// DOCKER_CONTEXT and the TLS variables. Without the pipe, outside of an operation, for the local Docker, for the checks
// of a new connection (runWithContext), and for the start of the worker, the calls go as before.
import { describe, expect, it, vi } from 'vitest';
import { silentLogger, type Logger, type ProcessRunner, type RunOptions, type RunResult, type StartedProcess } from '../ports';
import { BootstrapDocker } from './bootstrapDocker';
import { LOCAL_DOCKER_TARGET, dockerTargetOf, remoteContextNames, type DockerTarget } from './dockerHost';
import { runWithDockerTarget } from './dockerTargets';

const OK: RunResult = { exitCode: 0, stdout: '', stderr: '', timedOut: false };
const PIPE = 'unix:///run/user/1000/devspaces-0123456789abcdef/docker.sock';
const CONTEXT = remoteContextNames('build-box')[0];
const REMOTE = dockerTargetOf('ssh://build-box', CONTEXT);

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

  it('keeps the Docker context of the operation without the pipe, and asks for none outside of an operation or for the local Docker', async () => {
    const { runner, envs } = recorder();
    const dockerPipe = vi.fn((): string | undefined => undefined);
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, silentLogger, 'linux', { dockerPipe });
    await runWithDockerTarget(REMOTE, () => docker.run(['container', 'inspect', 'x']));
    expect(envs[0].DOCKER_CONTEXT).toBe(CONTEXT);
    expect(envs[0].DOCKER_HOST).toBeUndefined();
    expect(dockerPipe).toHaveBeenCalledTimes(1);
    dockerPipe.mockReturnValue(PIPE);
    await docker.run(['container', 'inspect', 'x']);
    await runWithDockerTarget(LOCAL_DOCKER_TARGET, () => docker.run(['container', 'inspect', 'x']));
    expect(envs[1].DOCKER_HOST).toBeUndefined();
    expect(envs[2].DOCKER_HOST).toBeUndefined();
    expect(dockerPipe).toHaveBeenCalledTimes(1);
  });

  it('runs the checks of a new connection of the relay with the Docker context also while the host has the pipe', async () => {
    const { runner, envs } = recorder();
    const dockerPipe = vi.fn(() => PIPE);
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, silentLogger, 'linux', { dockerPipe });
    await runWithDockerTarget(REMOTE, () => docker.runWithContext(['info', '--format', '{{json .ID}}']));
    expect(envs[0].DOCKER_CONTEXT).toBe(CONTEXT);
    expect(envs[0].DOCKER_HOST).toBeUndefined();
    expect(dockerPipe).not.toHaveBeenCalled();
    // `run` takes the pipe.
    await runWithDockerTarget(REMOTE, () => docker.run(['info', '--format', '{{json .ID}}']));
    expect(envs[1].DOCKER_HOST).toBe(PIPE);
  });

  it('logs each call of an operation on an SSH host that logs in with the Docker context, never a call through the pipe', async () => {
    const { runner } = recorder();
    const lines: string[] = [];
    const logger: Logger = { ...silentLogger, info: (message) => lines.push(message) };
    let pipe: string | undefined;
    let last: DockerTarget | undefined;
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, logger, 'linux', { dockerPipe: () => pipe, lastTarget: () => last });
    await runWithDockerTarget(REMOTE, () => docker.run(['image', 'inspect', 'x']));
    pipe = PIPE;
    await runWithDockerTarget(REMOTE, () => docker.run(['image', 'inspect', 'x']));
    await runWithDockerTarget(REMOTE, () => docker.runWithContext(['info', '--format', '{{json .ID}}']));
    await runWithDockerTarget(LOCAL_DOCKER_TARGET, () => docker.run(['image', 'inspect', 'x']));
    await docker.run(['image', 'inspect', 'x']);
    last = LOCAL_DOCKER_TARGET;
    await docker.run(['image', 'inspect', 'x']);
    // Outside an operation, the Docker CLI uses the current Docker context, the one of the last read.
    last = REMOTE;
    await docker.run(['info']);
    // The commands of the Docker contexts and the version of the CLI log in nowhere.
    await docker.run(['context', 'inspect', '--format', '{{json .}}']);
    await docker.run(['--version']);
    expect(lines).toEqual([
      'docker image inspect x logs in to build-box with the Docker context.',
      'docker info --format {{json .ID}} logs in to build-box with the Docker context.',
      'docker info logs in to build-box with the Docker context (outside an operation).',
    ]);
  });

  it('starts the worker (standard input open) never through the pipe', async () => {
    const { runner, starts } = recorder();
    const dockerPipe = vi.fn(() => PIPE);
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, silentLogger, 'linux', { dockerPipe });
    await runWithDockerTarget(REMOTE, async () => docker.start(['run', '-i', 'img']));
    expect(starts[0].DOCKER_CONTEXT).toBe(CONTEXT);
    expect(starts[0].DOCKER_HOST).toBeUndefined();
    expect(dockerPipe).not.toHaveBeenCalled();
  });

  it('logs in with the Docker context when the lookup of the pipe fails', async () => {
    const { runner, envs } = recorder();
    const warnings: string[] = [];
    const logger: Logger = { ...silentLogger, warn: (message) => warnings.push(message) };
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, logger, 'linux', {
      dockerPipe: () => {
        throw new Error('broken');
      },
    });
    await runWithDockerTarget(REMOTE, () => docker.run(['container', 'inspect', 'x']));
    expect(envs[0].DOCKER_CONTEXT).toBe(CONTEXT);
    expect(envs[0].DOCKER_HOST).toBeUndefined();
    expect(warnings).toEqual(['The Docker pipe of build-box could not be looked up, so the call logs in itself: broken']);
  });
});
