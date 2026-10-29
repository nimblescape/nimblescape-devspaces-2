// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// openHelperChannel with the connection of the relay (ChannelOpenDeps.relay): a remote engine with a transport starts
// its worker behind the relay, never with the Docker CLI; the retries of the open (another name, no network) see the
// refusals of `docker run` in the failure of the connection; the open connection of the engine is used again; a new
// connection ends when the open fails.
import { describe, expect, it, vi } from 'vitest';
import { LOCAL_DOCKER_TARGET, dockerTargetOf, remoteContextNames, type DockerTarget } from '../docker/dockerHost';
import { PIPE_LOADER, bundleHash } from '../loader/pipeLoader';
import { silentLogger, type StartedProcess } from '../ports';
import { RelayConnectionError, type RelayConnection } from '../relay/connection';
import type { RelayAccess } from '../relay/connections';
import { HelperChannelError } from './helperChannel';
import { openHelperChannel, type ChannelOpenDeps } from './helperChannels';
import { CHANNEL_PROTOCOL_VERSION, encodeMessage, parseClientMessage } from './protocol';

const REMOTE: DockerTarget = dockerTargetOf('ssh://build-box', remoteContextNames('build-box')[0]);
const ENGINE = '"7b1c7a44-2f0e-4d38-9d1d-3a8f7b0e8c11" "/var/lib/docker"';
const ENGINE_IDENTITY = { id: '7b1c7a44-2f0e-4d38-9d1d-3a8f7b0e8c11', rootDir: '/var/lib/docker' };

/** A worker that answers `hello` and the probe; its input lines are kept, and it ends at the end of its input or a kill. */
function fakeWorker() {
  let stdout: ((text: string) => void) | undefined;
  let finish: (result: { exitCode: number | null }) => void = () => {};
  const lines: string[] = [];
  const worker: StartedProcess & { lines: string[] } = {
    lines,
    write: (text) => {
      for (const line of text.split('\n').filter((part) => part !== '')) {
        lines.push(line);
        const message = parseClientMessage(line);
        if (message?.t === 'hello') queueMicrotask(() => stdout?.(encodeMessage({ t: 'hello', protocol: CHANNEL_PROTOCOL_VERSION, node: 'v24', ops: ['probe', 'sweep'] })));
        if (message?.t === 'op' && message.op === 'probe') {
          queueMicrotask(() => stdout?.(encodeMessage({ t: 'result', id: message.id, ok: true, value: { serverVersion: '27.1.0', detail: 'Docker 27.1.0', engine: ENGINE_IDENTITY } })));
        }
      }
      return true;
    },
    end: () => finish({ exitCode: 0 }),
    kill: () => finish({ exitCode: null }),
    onStdout: (listener) => (stdout = listener),
    onStderr: () => {},
    exited: new Promise((resolve) => (finish = resolve)),
  };
  return worker;
}

/** A connection whose worker is `worker`. */
function fakeConnection(worker: StartedProcess) {
  const closes: string[] = [];
  const connection = {
    closes,
    openWorker: vi.fn(() => worker),
    close: (reason = 'closed') => closes.push(reason),
  };
  return connection;
}

/** A RelayAccess with the open connection `current` (none by default), whose new connections come from `connect`. */
function access(connect: RelayAccess['connect'], current?: unknown) {
  return { current: () => current as RelayConnection | undefined, connect, use: vi.fn<RelayAccess['use']>(), retire: vi.fn<RelayAccess['retire']>() };
}

function deps(overrides: Partial<ChannelOpenDeps>): ChannelOpenDeps {
  return {
    start: () => {
      throw new Error('the Docker CLI must not start the worker');
    },
    runDirect: async (args) => (args[0] === 'ps' ? { exitCode: 0, stdout: 'devspaces-api-worker1\n', stderr: '', timedOut: false } : { exitCode: 0, stdout: `${ENGINE}\n`, stderr: '', timedOut: false }),
    logger: silentLogger,
    script: async () => 'SCRIPT',
    helperTag: async () => 'devspaces-worker:abc',
    socketPath: async () => '/var/run/docker.sock',
    stateVolume: 'devspaces-monitor',
    vscodeVolume: 'devspaces-vscode',
    windowName: () => 'api',
    ...overrides,
  };
}

describe('openHelperChannel with the connection of the relay', () => {
  it('starts the worker behind the relay with the bundle, without a second bundle, and keeps the connection after the worker', async () => {
    const worker = fakeWorker();
    const connection = fakeConnection(worker);
    const connects: { command: readonly string[]; bundle: string }[] = [];
    const relayAccess = access(async (command, bundle) => {
      connects.push({ command, bundle });
      return connection as unknown as RelayConnection;
    });
    const relay = vi.fn(() => relayAccess);
    const channel = await openHelperChannel(deps({ relay }), REMOTE);
    expect(relay).toHaveBeenCalledWith(REMOTE);
    expect(connects).toHaveLength(1);
    // The engine uses the new connection only after the checks of the worker.
    expect(relayAccess.use).toHaveBeenCalledWith(connection);
    const [{ command, bundle }] = connects;
    // `docker run` of the worker container, with the relay as its first program.
    expect(command.slice(0, 3)).toEqual(['docker', 'run', '--rm']);
    expect(command[command.indexOf('--name') + 1]).toBe('devspaces-api-worker1');
    expect(command.slice(-6)).toEqual(['node', '-e', PIPE_LOADER, '/opt/devspace/channel.js', bundleHash('SCRIPT'), 'startRelay']);
    expect(bundle).toBe('SCRIPT');
    // The worker starts from the file that the relay stored: its first line is `hello`.
    expect(parseClientMessage(worker.lines[0])).toMatchObject({ t: 'hello' });
    expect(worker.lines.some((line) => line.includes('SCRIPT'))).toBe(false);
    expect(channel.isOpen).toBe(true);
    channel.close();
    await worker.exited;
    await new Promise((resolve) => setImmediate(resolve));
    // RelayConnections closes it after a time without a stream.
    expect(connection.closes).toEqual([]);
  });

  it('starts the worker on the open connection of the engine, without a new connection and without the checks of a start', async () => {
    const worker = fakeWorker();
    const connection = fakeConnection(worker);
    const connect = vi.fn<RelayAccess['connect']>();
    const socketPath = vi.fn(async () => '/var/run/docker.sock');
    const runDirect = vi.fn<ChannelOpenDeps['runDirect']>(async () => ({ exitCode: 0, stdout: `${ENGINE}\n`, stderr: '', timedOut: false }));
    const relay = () => access(connect, connection);
    const channel = await openHelperChannel(deps({ relay, socketPath, runDirect }), REMOTE);
    expect(connect).not.toHaveBeenCalled();
    expect(connection.openWorker).toHaveBeenCalledTimes(1);
    expect(socketPath).not.toHaveBeenCalled();
    // No list of the names; only the engine identity.
    expect(runDirect.mock.calls.map(([args]) => args[0])).toEqual(['info']);
    expect(channel.isOpen).toBe(true);
    channel.close();
  });

  it('closes a new connection when the worker on it reaches another engine, and only retires the open connection of the engine', async () => {
    const otherEngine = async () => ({ exitCode: 0, stdout: '"another-engine" "/var/lib/docker"\n', stderr: '', timedOut: false });
    const fresh = fakeConnection(fakeWorker());
    const freshAccess = access(async () => fresh as unknown as RelayConnection);
    await expect(openHelperChannel(deps({ relay: () => freshAccess, runDirect: otherEngine }), REMOTE)).rejects.toMatchObject({
      code: 'open',
      message: expect.stringContaining('it reaches another Docker engine'),
    });
    expect(fresh.closes).toEqual(['the worker could not be opened']);
    expect(freshAccess.use).not.toHaveBeenCalled();
    // The open connection keeps its streams (the Docker pipe of the window); the next worker opens a new one.
    const shared = fakeConnection(fakeWorker());
    const sharedAccess = access(vi.fn<RelayAccess['connect']>(), shared);
    await expect(openHelperChannel(deps({ relay: () => sharedAccess, runDirect: otherEngine }), REMOTE)).rejects.toMatchObject({ code: 'open' });
    expect(shared.closes).toEqual([]);
    expect(sharedAccess.retire).toHaveBeenCalledWith(shared);
  });

  it('takes the next name when `docker run` refused the name in use, and starts without network on a daemon without bridge', async () => {
    const worker = fakeWorker();
    const commands: (readonly string[])[] = [];
    const failures = [
      'The connection to build-box could not be opened: it ended (docker: Error response from daemon: Conflict. The container name "/devspaces-api-worker1" is already in use by container "abc".)',
      'The connection to build-box could not be opened: it ended (docker: Error response from daemon: network bridge not found.)',
    ];
    const relay = () =>
      access(async (command) => {
        commands.push(command);
        const failure = failures.shift();
        if (failure !== undefined) throw new RelayConnectionError(failure);
        return fakeConnection(worker) as unknown as RelayConnection;
      });
    const channel = await openHelperChannel(deps({ relay }), REMOTE);
    expect(commands.map((command) => [command[command.indexOf('--name') + 1], command[command.indexOf('--network') + 1]])).toEqual([
      ['devspaces-api-worker1', 'bridge'],
      ['devspaces-api-worker2', 'bridge'],
      ['devspaces-api-worker2', 'none'],
    ]);
    expect(channel.isOpen).toBe(true);
    channel.close();
  });

  it('gives the answer to hello what is left of the time of the open, at least 15 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
    try {
      // A worker that never answers.
      const silent: StartedProcess = { write: () => true, end: () => {}, kill: () => {}, onStdout: () => {}, onStderr: () => {}, exited: new Promise(() => {}) };
      const relay = () =>
        access(async () => {
          // The login and the start of the container took 110 seconds.
          await new Promise((resolve) => setTimeout(resolve, 110_000));
          return fakeConnection(silent) as unknown as RelayConnection;
        });
      let failure: unknown;
      void openHelperChannel(deps({ relay }), REMOTE).catch((error: unknown) => (failure = error));
      await vi.advanceTimersByTimeAsync(110_000 + 14_000);
      expect(failure).toBeUndefined();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(failure).toMatchObject({ code: 'open', message: 'The helper channel to build-box could not be opened: no answer within 15 seconds' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails the open with the reason of the connection', async () => {
    const relay = () =>
      access(async () => {
        throw new RelayConnectionError('The connection to build-box could not be opened: it ended (ssh: connect to host build-box port 22: Connection refused)');
      });
    const opening = openHelperChannel(deps({ relay }), REMOTE);
    await expect(opening).rejects.toBeInstanceOf(HelperChannelError);
    await expect(opening).rejects.toMatchObject({ code: 'open', message: expect.stringContaining('Connection refused') });
  });

  it('closes the connection when no worker stream can be opened', async () => {
    const connection = fakeConnection(fakeWorker());
    connection.openWorker.mockImplementation(() => {
      throw new Error('The connection to build-box is closed.');
    });
    const relay = () => access(async () => connection as unknown as RelayConnection);
    await expect(openHelperChannel(deps({ relay }), REMOTE)).rejects.toMatchObject({ code: 'open', message: 'The connection to build-box is closed.' });
    expect(connection.closes).toEqual(['the worker could not be opened']);
  });

  it('starts with the Docker CLI for the local engine and for a host without a transport', async () => {
    for (const [target, relay] of [
      [LOCAL_DOCKER_TARGET, vi.fn(() => undefined)],
      [REMOTE, vi.fn(() => undefined)],
    ] as const) {
      const worker = fakeWorker();
      // The worker of the Docker CLI gets the bundle as its first line.
      const bundled: StartedProcess = { ...worker, write: (text) => (text.startsWith('"') ? true : worker.write(text)) };
      const start = vi.fn((_args: readonly string[]) => bundled);
      const channel = await openHelperChannel(deps({ start, relay }), target);
      expect(relay).toHaveBeenCalledTimes(target.kind === 'remote' ? 1 : 0);
      expect(start).toHaveBeenCalledTimes(1);
      expect(start.mock.calls[0][0].at(-1)).toBe('startChannel');
      channel.close();
    }
  });
});
