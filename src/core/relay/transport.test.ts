// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it, vi } from 'vitest';
import { WSL_HOST } from '../docker/dockerHost';
import { MAX_BUNDLE_LINE_LENGTH } from '../loader/pipeLoader';
import { silentLogger, type StartOptions, type StartedByteProcess } from '../ports';
import { RelayConnectionError } from './connection';
import { RELAY_SHELL_COMMAND, openRelayConnection, sshHostTransport, wslHostTransport } from './transport';

describe('sshHostTransport', () => {
  const env = { PATH: '/usr/bin', ssh_askpass_require: 'force' };

  it('logs in once without questions and runs sh -s, for an alias and for an address', () => {
    expect(sshHostTransport('build-box', '/usr/bin/ssh', env)).toEqual({
      file: '/usr/bin/ssh',
      args: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-T', '--', 'build-box', RELAY_SHELL_COMMAND],
      env: { PATH: '/usr/bin', SSH_ASKPASS_REQUIRE: 'never' },
    });
    expect(sshHostTransport('me@[::1]:2222', '/usr/bin/ssh', env)?.args).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=15',
      '-T',
      '-p',
      '2222',
      '-l',
      'me',
      '--',
      '::1',
      'sh -s',
    ]);
  });

  // A login of a flow of the user: ssh may ask, through the helper of askpassEnv, in VS Code.
  it('leaves out BatchMode and X11 and takes the environment of the questions for a login that may ask', () => {
    const prompts = { env: vi.fn((base: NodeJS.ProcessEnv) => ({ ...base, SSH_ASKPASS: '/storage/askpass/askpass.sh', SSH_ASKPASS_REQUIRE: 'force' })) };
    expect(sshHostTransport('me@box:2222', '/usr/bin/ssh', env, { prompts })).toEqual({
      file: '/usr/bin/ssh',
      args: ['-x', '-o', 'ConnectTimeout=15', '-T', '-p', '2222', '-l', 'me', '--', 'box', RELAY_SHELL_COMMAND],
      env: { ...env, SSH_ASKPASS: '/storage/askpass/askpass.sh', SSH_ASKPASS_REQUIRE: 'force' },
    });
    expect(prompts.env).toHaveBeenCalledWith(env);
  });

  // A host with the key of Devspaces (sshKey.ts): every login of Devspaces gives it to ssh.
  it('gives the key of Devspaces with -i, before the destination', () => {
    expect(sshHostTransport('box', '/usr/bin/ssh', env, { identity: '/home/me/.ssh/devspaces_ed25519' })?.args).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=15',
      '-T',
      '-i',
      '/home/me/.ssh/devspaces_ed25519',
      '--',
      'box',
      RELAY_SHELL_COMMAND,
    ]);
  });

  it('has no transport for a host that is no SSH alias or address', () => {
    expect(sshHostTransport('box/path', '/usr/bin/ssh', env)).toBeUndefined();
    // The WSL distribution of Devspaces has no SSH transport (wslHostTransport).
    expect(sshHostTransport(WSL_HOST, '/usr/bin/ssh', env)).toBeUndefined();
  });
});

describe('wslHostTransport', () => {
  it('runs sh -s as root in the distribution with wsl.exe, without a shell of the distribution and without questions', () => {
    const wsl = 'C:\\Windows\\System32\\wsl.exe';
    expect(wslHostTransport('devspaces', wsl, { Path: 'C:\\Windows' })).toEqual({
      file: wsl,
      args: ['-d', 'devspaces', '-u', 'root', '--cd', '/', '--exec', 'sh', '-s'],
      env: { Path: 'C:\\Windows', WSL_UTF8: '1' },
    });
  });
});

describe('openRelayConnection', () => {
  it('starts the transport and writes the start script of the command with a new marker', async () => {
    const starts: { file: string; args: readonly string[]; options?: StartOptions }[] = [];
    const written: string[] = [];
    let finish: (result: { exitCode: number | null }) => void = () => {};
    const process: StartedByteProcess = {
      write: (chunk) => written.push(chunk.toString('utf8')) > 0,
      onDrain: () => {},
      end: () => {},
      kill: () => {},
      onStdout: () => {},
      pauseStdout: () => {},
      resumeStdout: () => {},
      onStderr: () => {},
      exited: new Promise((resolve) => (finish = resolve)),
    };
    const runner = {
      startBytes: (file: string, args: readonly string[], options?: StartOptions) => {
        starts.push({ file, args, options });
        return process;
      },
    };
    const start = () => ({ process: runner.startBytes('/usr/bin/ssh', ['--', 'build-box', 'sh -s'], { env: { PATH: '/usr/bin' } }) });
    const opening = openRelayConnection(start, ['docker', 'run', "it's"], 'bundle', { logger: silentLogger, name: 'build-box' });
    expect(starts).toEqual([{ file: '/usr/bin/ssh', args: ['--', 'build-box', 'sh -s'], options: { env: { PATH: '/usr/bin' } } }]);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^printf '%s\\n' devspaces-start-[0-9a-f]{32}; exec 'docker' 'run' 'it'\\''s'\n$/);
    finish({ exitCode: 255 });
    await expect(opening).rejects.toBeInstanceOf(RelayConnectionError);
  });

  it('writes the start script into the shell before the relay that it takes over, without a new login', async () => {
    const written: string[] = [];
    let finish: (result: { exitCode: number | null }) => void = () => {};
    const shell: StartedByteProcess = {
      write: (chunk) => written.push(chunk.toString('utf8')) > 0,
      onDrain: () => {},
      end: () => {},
      kill: () => {},
      onStdout: () => {},
      pauseStdout: () => {},
      resumeStdout: () => {},
      onStderr: () => {},
      exited: new Promise((resolve) => (finish = resolve)),
    };
    const start = (): { process: StartedByteProcess } => {
      throw new Error('a new login');
    };
    const lines: string[] = [];
    const logger = { ...silentLogger, info: (line: string) => lines.push(line) };
    const opening = openRelayConnection(start, ['docker', 'run'], 'bundle', { logger, name: 'build-box', takeOver: async () => shell });
    await new Promise((resolve) => setImmediate(resolve));
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^printf '%s\\n' devspaces-start-[0-9a-f]{32}; exec 'docker' 'run'\n$/);
    expect(lines).toEqual(['The connection to build-box starts on the login of the shell before the relay.']);
    finish({ exitCode: 255 });
    await expect(opening).rejects.toBeInstanceOf(RelayConnectionError);
  });

  it('logs in anew when there is no shell to take over', async () => {
    const start = vi.fn((): { process: StartedByteProcess } => {
      throw new Error('started');
    });
    await expect(openRelayConnection(start, ['docker'], 'bundle', { logger: silentLogger, name: 'x', takeOver: async () => undefined })).rejects.toThrow('started');
    expect(start).toHaveBeenCalledTimes(1);
  });

  // The own login of a flow of the user: a question in VS Code holds the time limit of the open.
  it('holds the time limit of the open while a question of its own login is open', async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<(open: boolean) => void>();
      let finish: (result: { exitCode: number | null }) => void = () => {};
      const process: StartedByteProcess = {
        write: () => true,
        onDrain: () => {},
        end: () => {},
        kill: () => {},
        killNow: () => finish({ exitCode: null }),
        onStdout: () => {},
        pauseStdout: () => {},
        resumeStdout: () => {},
        onStderr: () => {},
        exited: new Promise((resolve) => (finish = resolve)),
      };
      const prompts = {
        onPrompt: (listener: (open: boolean) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      let failed: unknown;
      const opening = openRelayConnection(() => ({ process, prompts }), ['docker'], 'bundle', { logger: silentLogger, name: 'x' });
      opening.catch((error: unknown) => (failed = error));
      await vi.advanceTimersByTimeAsync(1_000);
      listeners.forEach((listener) => listener(true));
      // Much longer than the time limit of 120 seconds: the question waits for the user.
      await vi.advanceTimersByTimeAsync(600_000);
      expect(failed).toBeUndefined();
      listeners.forEach((listener) => listener(false));
      await vi.advanceTimersByTimeAsync(119_000);
      expect(failed).toBeUndefined();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(failed).toBeInstanceOf(RelayConnectionError);
      expect(String(failed)).toContain('no answer within 120 seconds');
      expect(listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a bundle longer than the pipe loader takes, before any start', async () => {
    const start = (): { process: StartedByteProcess } => {
      throw new Error('started');
    };
    const takeOver = vi.fn(async () => undefined);
    const opening = openRelayConnection(start, ['docker'], 'x'.repeat(MAX_BUNDLE_LINE_LENGTH - 1), { logger: silentLogger, name: 'x', takeOver });
    await expect(opening).rejects.toBeInstanceOf(RelayConnectionError);
    await expect(opening).rejects.toThrow(`The connection to x could not be opened: the bundle is too long (${MAX_BUNDLE_LINE_LENGTH + 1} characters as JSON).`);
    // The shell before the relay stays the window's.
    expect(takeOver).not.toHaveBeenCalled();
  });

  it('refuses a command that the start script cannot carry, before any start', async () => {
    const start = (): { process: StartedByteProcess } => {
      throw new Error('started');
    };
    await expect(openRelayConnection(start, ['docker', 'a\nb'], 'bundle', { logger: silentLogger, name: 'x' })).rejects.toThrow('line break');
  });
});
