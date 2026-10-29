// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { LOCAL_DOCKER_TARGET, dockerTargetOf } from '../docker/dockerHost';
import { MAX_BUNDLE_LINE_LENGTH } from '../loader/pipeLoader';
import { silentLogger, type StartOptions, type StartedByteProcess } from '../ports';
import { RelayConnectionError } from './connection';
import { RELAY_SHELL_COMMAND, openRelayConnection, sshRelayTransport } from './transport';

describe('sshRelayTransport', () => {
  const env = { PATH: '/usr/bin', ssh_askpass_require: 'force' };

  it('logs in once without questions and runs sh -s, for an alias and for an address', () => {
    expect(sshRelayTransport(dockerTargetOf('ssh://build-box', 'build-box'), '/usr/bin/ssh', env)).toEqual({
      file: '/usr/bin/ssh',
      args: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-T', '--', 'build-box', RELAY_SHELL_COMMAND],
      env: { PATH: '/usr/bin', SSH_ASKPASS_REQUIRE: 'never' },
    });
    expect(sshRelayTransport(dockerTargetOf('ssh://me@[::1]:2222', undefined), '/usr/bin/ssh', env)?.args).toEqual([
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

  it('has no transport for the local engine and for a host that is no SSH alias or address', () => {
    expect(sshRelayTransport(LOCAL_DOCKER_TARGET, '/usr/bin/ssh', env)).toBeUndefined();
    expect(sshRelayTransport({ kind: 'remote', host: 'box/path', endpoint: 'ssh://box/path' }, '/usr/bin/ssh', env)).toBeUndefined();
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
      onStderr: () => {},
      exited: new Promise((resolve) => (finish = resolve)),
    };
    const runner = {
      startBytes: (file: string, args: readonly string[], options?: StartOptions) => {
        starts.push({ file, args, options });
        return process;
      },
    };
    const transport = { file: '/usr/bin/ssh', args: ['--', 'build-box', 'sh -s'], env: { PATH: '/usr/bin' } };
    const opening = openRelayConnection(runner, transport, ['docker', 'run', "it's"], 'bundle', { logger: silentLogger, name: 'build-box' });
    expect(starts).toEqual([{ file: '/usr/bin/ssh', args: ['--', 'build-box', 'sh -s'], options: { env: { PATH: '/usr/bin' } } }]);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^printf '%s\\n' devspaces-start-[0-9a-f]{32}; exec 'docker' 'run' 'it'\\''s'\n$/);
    finish({ exitCode: 255 });
    await expect(opening).rejects.toBeInstanceOf(RelayConnectionError);
  });

  it('refuses a bundle longer than the pipe loader takes, before any start', async () => {
    const runner = {
      startBytes: (): StartedByteProcess => {
        throw new Error('started');
      },
    };
    const transport = { file: 'ssh', args: [], env: {} };
    const opening = openRelayConnection(runner, transport, ['docker'], 'x'.repeat(MAX_BUNDLE_LINE_LENGTH - 1), { logger: silentLogger, name: 'x' });
    await expect(opening).rejects.toBeInstanceOf(RelayConnectionError);
    await expect(opening).rejects.toThrow(`The connection to x could not be opened: the bundle is too long (${MAX_BUNDLE_LINE_LENGTH + 1} characters as JSON).`);
  });

  it('refuses a command that the start script cannot carry, before any start', async () => {
    const runner = {
      startBytes: (): StartedByteProcess => {
        throw new Error('started');
      },
    };
    const transport = { file: 'ssh', args: [], env: {} };
    await expect(openRelayConnection(runner, transport, ['docker', 'a\nb'], 'bundle', { logger: silentLogger, name: 'x' })).rejects.toThrow('line break');
  });
});
