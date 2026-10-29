// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Docker CLI of Devspaces (BootstrapDockerOptions.ownCli) runs the calls of an operation on a remote engine, in place
// of the Docker CLI of this computer, and also on a computer without one. Every other call keeps the Docker CLI of this
// computer, and fails without it as before (dockerNotInstalled).
import { describe, expect, it, vi } from 'vitest';
import { silentLogger, type ProcessRunner, type RunOptions, type RunResult, type StartedProcess } from '../ports';
import { BootstrapDocker } from './bootstrapDocker';
import { LOCAL_DOCKER_TARGET, remoteDockerTarget } from './dockerHost';
import { runWithDockerTarget } from './dockerTargets';

const OK: RunResult = { exitCode: 0, stdout: '"29.9.2"', stderr: '', timedOut: false };
const OWN = '/storage/docker-cli/29.9.2/docker';
const COMPUTER = '/usr/bin/docker';
const REMOTE = remoteDockerTarget('build-box');

/** A runner that records the program of each call and start; `missing` programs fail with ENOENT. */
function recorder(missing: string[] = []): { runner: ProcessRunner; files: string[] } {
  const files: string[] = [];
  const runner: ProcessRunner = {
    async run(file: string, _args: readonly string[], _options?: RunOptions): Promise<RunResult> {
      files.push(file);
      if (missing.includes(file)) throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' });
      return OK;
    },
    start: (file) => {
      files.push(file);
      return {} as StartedProcess;
    },
  };
  return { runner, files };
}

describe('BootstrapDocker: the Docker CLI of Devspaces', () => {
  it('runs the calls of an operation on a remote engine with the Docker CLI of Devspaces, the other calls with the one of this computer', async () => {
    const { runner, files } = recorder();
    const docker = new BootstrapDocker(runner, COMPUTER, { PATH: '/usr/bin' }, silentLogger, 'linux', { ownCli: () => OWN });
    await runWithDockerTarget(REMOTE, () => docker.run(['container', 'inspect', 'x']));
    await runWithDockerTarget(REMOTE, async () => docker.start(['run', '-i', 'helper']));
    await docker.run(['context', 'inspect']);
    await runWithDockerTarget(LOCAL_DOCKER_TARGET, () => docker.run(['container', 'inspect', 'x']));
    expect(files).toEqual([OWN, OWN, COMPUTER, COMPUTER]);
  });

  it('takes the Docker CLI of this computer for a remote engine while the one of Devspaces is not installed', async () => {
    const { runner, files } = recorder();
    const docker = new BootstrapDocker(runner, COMPUTER, { PATH: '/usr/bin' }, silentLogger, 'linux', { ownCli: () => undefined });
    await runWithDockerTarget(REMOTE, () => docker.run(['container', 'inspect', 'x']));
    expect(files).toEqual([COMPUTER]);
    expect(docker.canRunRemote()).toBe(true);
  });

  // A computer without Docker that uses a remote host: only the calls on that host run.
  it('runs the calls on a remote engine on a computer without a Docker CLI, and refuses the other calls as before', async () => {
    const { runner, files } = recorder();
    const docker = new BootstrapDocker(runner, undefined, { PATH: '/usr/bin' }, silentLogger, 'linux', { ownCli: () => OWN });
    expect(docker.isInstalled()).toBe(false);
    expect(docker.canRunRemote()).toBe(true);
    await runWithDockerTarget(REMOTE, async () => {
      expect(docker.isInstalled()).toBe(true);
      expect(await docker.isRunning()).toBe(true);
    });
    await expect(docker.run(['info'])).rejects.toMatchObject({ code: 'dockerNotInstalled' });
    await expect(runWithDockerTarget(LOCAL_DOCKER_TARGET, () => docker.run(['info']))).rejects.toMatchObject({ code: 'dockerNotInstalled' });
    expect(await docker.isRunning()).toBe(false);
    expect(files).toEqual([OWN]);
  });

  // The checks before a flow, which run outside of an operation (for example the worker's read of a container).
  it('says for each kind of engine whether a Docker CLI runs its calls, whatever operation runs now', async () => {
    const { runner } = recorder();
    const ownOnly = new BootstrapDocker(runner, undefined, { PATH: '/usr/bin' }, silentLogger, 'linux', { ownCli: () => OWN });
    expect(ownOnly.canRunOn(REMOTE)).toBe(true);
    expect(ownOnly.canRunOn(LOCAL_DOCKER_TARGET)).toBe(false);
    expect(await runWithDockerTarget(REMOTE, async () => ownOnly.canRunOn(LOCAL_DOCKER_TARGET))).toBe(false);
    expect(ownOnly.canRunOn({ kind: 'unsupported' })).toBe(false);
    const computerOnly = new BootstrapDocker(runner, COMPUTER, { PATH: '/usr/bin' }, silentLogger, 'linux', { ownCli: () => undefined });
    expect(computerOnly.canRunOn(REMOTE)).toBe(true);
    expect(computerOnly.canRunOn(LOCAL_DOCKER_TARGET)).toBe(true);
  });

  it('has no Docker CLI for a remote engine without either', async () => {
    const { runner } = recorder();
    const docker = new BootstrapDocker(runner, undefined, { PATH: '/usr/bin' }, silentLogger, 'linux', { ownCli: () => undefined });
    expect(docker.canRunRemote()).toBe(false);
    expect(await runWithDockerTarget(REMOTE, async () => docker.isInstalled())).toBe(false);
    expect(new BootstrapDocker(runner, undefined, {}, silentLogger, 'linux').canRunRemote()).toBe(false);
  });

  // The lost Docker CLI of Devspaces is not the lost Docker CLI of this computer: the Docker setup is not told.
  it('refuses a call on a remote engine whose Docker CLI of Devspaces was removed, and keeps the Docker CLI of this computer', async () => {
    const { runner, files } = recorder([OWN]);
    const onCliLost = vi.fn();
    const docker = new BootstrapDocker(runner, COMPUTER, { PATH: '/usr/bin' }, silentLogger, 'linux', {
      ownCli: () => OWN,
      findDocker: () => COMPUTER,
      onCliLost,
    });
    await expect(runWithDockerTarget(REMOTE, () => docker.run(['container', 'inspect', 'x']))).rejects.toMatchObject({ code: 'dockerNotInstalled' });
    expect(onCliLost).not.toHaveBeenCalled();
    expect(docker.dockerPath).toBe(COMPUTER);
    await docker.run(['context', 'inspect']);
    expect(files).toEqual([OWN, COMPUTER]);
  });

  it('logs a lookup of the Docker CLI of Devspaces that fails, and takes the Docker CLI of this computer', async () => {
    const { runner, files } = recorder();
    const logger = { ...silentLogger, warn: vi.fn() };
    const docker = new BootstrapDocker(runner, COMPUTER, { PATH: '/usr/bin' }, logger, 'linux', {
      ownCli: () => {
        throw new Error('EACCES');
      },
    });
    await runWithDockerTarget(REMOTE, () => docker.run(['container', 'inspect', 'x']));
    expect(files).toEqual([COMPUTER]);
    expect(logger.warn).toHaveBeenCalledWith('The Docker CLI of Devspaces could not be looked up: EACCES');
  });
});
