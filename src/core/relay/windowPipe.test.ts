// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Docker pipe of a window: which windows get one, which address the window serves, and the way of each connection
// (the relay, or `docker system dial-stdio` on an engine with the removal mark; here `cat`).
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeProcessRunner } from '../process';
import { silentLogger, type Logger } from '../ports';
import type { Devspace } from '../types';
import type { RelayConnection } from './connection';
import { MemoryPipe } from './memoryPipe.testkit';
import { Mux } from './mux';
import { dockerPipeAddress, dockerPipeId, parseDockerPipeHost } from './pipeAddress';
import { serveWindowPipe, windowDockerHost, type WindowPipe, type WindowPipeDeps } from './windowPipe';

const COMPUTER = '0123456789abcdef0123456789abcdef';
const CONTAINER = 'devspaces-acme-api-3f2a9c1e';
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function devspace(dockerHost?: string): Devspace {
  return {
    id: 'a1b2c3d4',
    repository: 'acme/api',
    configPath: '.devcontainer/devcontainer.json',
    volumeName: CONTAINER,
    containerName: CONTAINER,
    owner: { id: '1', login: 'octo' },
    createdAt: '2026-10-01T10:00:00.000Z',
    ...(dockerHost === undefined ? {} : { dockerHost }),
  } as Devspace;
}

function base(): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'window-pipe-'));
  cleanups.push(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}

function logger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return { ...silentLogger, lines, info: (message) => lines.push(`info ${message}`), warn: (message) => lines.push(`warn ${message}`) };
}

function deps(overrides: Partial<WindowPipeDeps> = {}): WindowPipeDeps {
  return {
    logger: silentLogger,
    platform: 'linux',
    computerId: () => COMPUTER,
    engineRemoved: async () => false,
    openRelayConnection: () => undefined,
    relayConnection: async () => {
      throw new Error('no connection in this test');
    },
    dialStdio: () => undefined,
    ...overrides,
  };
}

async function serve(dockerHost: string, shown: Devspace | undefined, windowDeps: WindowPipeDeps): Promise<WindowPipe> {
  const served = await serveWindowPipe(dockerHost, CONTAINER, shown, windowDeps);
  if (served.kind === 'served') cleanups.push(() => served.pipe.close());
  return served;
}

/** The extension and the relay in memory; the relay answers each Docker stream with `relay: ` and what it got. */
function echoRelay(): RelayConnection {
  const up = new MemoryPipe();
  const down = new MemoryPipe();
  const relay = new Mux({
    side: 'relay',
    link: down.link,
    accept: (stream) => {
      let got = '';
      stream.onData((chunk) => {
        got += chunk.toString();
        stream.consumed(chunk.length);
      });
      stream.onEnd(() => {
        stream.write(Buffer.from(`relay: ${got}`));
        stream.end();
      });
    },
  });
  const extension = new Mux({ side: 'extension', link: up.link });
  up.target = relay;
  down.target = extension;
  cleanups.push(() => {
    relay.close('the test ended');
    extension.close('the test ended');
  });
  return { openDocker: () => extension.open('docker') } as unknown as RelayConnection;
}

/** Sends `text` through the socket, ends it, and resolves with what came back once it closed. */
function roundTrip(socketPath: string, text: string): Promise<string> {
  return new Promise((resolve) => {
    const client = net.connect({ path: socketPath, allowHalfOpen: true });
    let answer = '';
    client.on('data', (chunk: Buffer) => (answer += chunk.toString()));
    client.on('error', () => {});
    client.on('close', () => resolve(answer));
    client.on('end', () => client.end());
    client.end(text);
  });
}

describe('windowDockerHost', () => {
  const sources = { computerId: () => COMPUTER, platform: 'linux' as const, env: { XDG_RUNTIME_DIR: '/run/user/1000' }, tmpdir: '/tmp', sshFound: () => true, isFolder: () => true };

  it('gives a devspace on an SSH host the pipe of this computer for its container', () => {
    const address = windowDockerHost(devspace('me@build-box:2222'), CONTAINER, sources);
    expect(address).toBe(dockerPipeAddress(dockerPipeId(COMPUTER, 'me@build-box:2222', CONTAINER), 'linux', '/run/user/1000').dockerHost);
    expect(parseDockerPipeHost(address as string, 'linux')).toBeDefined();
    expect(windowDockerHost(devspace('build-box'), CONTAINER, { ...sources, platform: 'win32' })).toMatch(/^npipe:\/\/\/\/\.\/pipe\/devspaces-[0-9a-f]{16}$/);
  });

  it('keeps the address in the authority of this window when it is the pipe of the devspace (another runtime folder made it)', () => {
    const id = dockerPipeId(COMPUTER, 'build-box', CONTAINER);
    const made = dockerPipeAddress(id, 'linux', '/tmp').dockerHost;
    expect(windowDockerHost(devspace('build-box'), CONTAINER, { ...sources, current: made })).toBe(made);
    const fresh = dockerPipeAddress(id, 'linux', '/run/user/1000').dockerHost;
    // Another container, another host, or no pipe: the address of this extension host.
    expect(windowDockerHost(devspace('build-box'), CONTAINER, { ...sources, current: dockerPipeAddress(dockerPipeId(COMPUTER, 'build-box', 'other'), 'linux', '/tmp').dockerHost })).toBe(fresh);
    expect(windowDockerHost(devspace('build-box'), CONTAINER, { ...sources, current: dockerPipeAddress(dockerPipeId(COMPUTER, 'other-box', CONTAINER), 'linux', '/tmp').dockerHost })).toBe(fresh);
    expect(windowDockerHost(devspace('build-box'), CONTAINER, { ...sources, current: 'ssh://build-box' })).toBe(fresh);
  });

  it('gives none to a local devspace, to a host that is no SSH host, and without ssh', () => {
    expect(windowDockerHost(devspace(), CONTAINER, sources)).toBeUndefined();
    expect(windowDockerHost(devspace('-oProxyCommand=x'), CONTAINER, sources)).toBeUndefined();
    expect(windowDockerHost(devspace('build-box'), CONTAINER, { ...sources, sshFound: () => false })).toBeUndefined();
  });
});

describe('serveWindowPipe', () => {
  it('serves only the pipe that this computer made for the devspace of the window', async () => {
    const log = logger();
    const address = dockerPipeAddress(dockerPipeId(COMPUTER, 'build-box', CONTAINER), 'linux', base());
    const notMade = `it was not made on this computer for the devspace of the container ${CONTAINER}.`;
    expect(await serve('ssh://build-box', devspace('build-box'), deps({ logger: log }))).toEqual({ kind: 'other' });
    expect(await serve(address.dockerHost, undefined, deps({ logger: log }))).toEqual({ kind: 'refused', reason: `the devspace of the container ${CONTAINER} is not known.` });
    expect(await serve(address.dockerHost, devspace('other-box'), deps({ logger: log }))).toEqual({ kind: 'refused', reason: notMade });
    expect(await serve(address.dockerHost, devspace(), deps({ logger: log }))).toEqual({ kind: 'refused', reason: notMade });
    expect(await serve(address.dockerHost, devspace('build-box'), deps({ logger: log, computerId: () => 'f'.repeat(32) }))).toEqual({ kind: 'refused', reason: notMade });
    expect(fs.existsSync(address.folder as string)).toBe(false);
    const notServed = `warn The Docker pipe ${address.dockerHost} of this window is not served`;
    expect(log.lines).toEqual([
      'info The authority of this window names the Docker host ssh://build-box; it is no Docker pipe of Devspaces.',
      `${notServed}: the devspace of the container ${CONTAINER} is not known.`,
      ...Array(3).fill(`${notServed}: ${notMade}`),
    ]);
    expect((await serve(address.dockerHost, devspace('build-box'), deps({ logger: log }))).kind).toBe('served');
    expect(log.lines.at(-1)).toBe(`info The Docker pipe of ${CONTAINER} listens on ${address.dockerHost}.`);
    // A second window of the same address: it is in use.
    expect(await serve(address.dockerHost, devspace('build-box'), deps({ logger: log, inUseWaitMs: 0 }))).toEqual({ kind: 'refused', reason: `${address.path} is in use: another window serves it.` });
    expect(log.lines.at(-1)).toBe(`${notServed}: ${address.path} is in use: another window serves it.`);
  });

  it('carries each connection through the relay, and through its own dial-stdio while the engine has the removal mark', async () => {
    const runner = new NodeProcessRunner();
    const address = dockerPipeAddress(dockerPipeId(COMPUTER, 'build-box', CONTAINER), 'linux', base());
    let removed = false;
    const engineRemoved = vi.fn(async () => removed);
    const relayConnection = vi.fn<WindowPipeDeps['relayConnection']>(async () => echoRelay());
    const dialStdio = vi.fn<WindowPipeDeps['dialStdio']>(() => runner.startBytes('cat', []));
    const log = logger();
    await serve(address.dockerHost, devspace('build-box'), deps({ logger: log, engineRemoved, relayConnection, dialStdio }));
    await expect(roundTrip(address.path, 'GET /_ping HTTP/1.1\r\n\r\n')).resolves.toBe('relay: GET /_ping HTTP/1.1\r\n\r\n');
    expect(relayConnection).toHaveBeenCalledWith(devspace('build-box'));
    expect(dialStdio).not.toHaveBeenCalled();
    // The answer about the removal mark holds for the connections of the next 2 seconds.
    await expect(roundTrip(address.path, 'x')).resolves.toBe('relay: x');
    expect(engineRemoved).toHaveBeenCalledTimes(1);
    // A pipe that is served while the engine has the removal mark: each connection runs its own dial-stdio.
    removed = true;
    const marked = dockerPipeAddress(dockerPipeId(COMPUTER, 'marked-box', CONTAINER), 'linux', base());
    await serve(marked.dockerHost, devspace('marked-box'), deps({ logger: log, engineRemoved, relayConnection, dialStdio }));
    await expect(roundTrip(marked.path, 'GET /_ping HTTP/1.1\r\n\r\n')).resolves.toBe('GET /_ping HTTP/1.1\r\n\r\n');
    expect(dialStdio).toHaveBeenCalledTimes(1);
    expect(relayConnection).toHaveBeenCalledTimes(2);
    // Without ssh, the connection ends with the reason.
    dialStdio.mockReturnValue(undefined);
    await expect(roundTrip(marked.path, 'x')).resolves.toBe('');
    expect(log.lines.at(-1)).toBe(`warn The Docker pipe of ${CONTAINER} could not reach the Docker engine: ssh was not found, or marked-box is no SSH host`);
  });

  it('waits for one open of the connection of the relay at most a while, and goes without it for one connection that it cannot carry', async () => {
    const runner = new NodeProcessRunner();
    const dialStdio = vi.fn<WindowPipeDeps['dialStdio']>(() => runner.startBytes('cat', []));
    const log = logger();
    const address = dockerPipeAddress(dockerPipeId(COMPUTER, 'build-box', CONTAINER), 'linux', base());
    let open: (connection: RelayConnection) => void = () => {};
    const relayConnection = vi.fn<WindowPipeDeps['relayConnection']>(() => new Promise((resolve) => (open = resolve)));
    await serve(address.dockerHost, devspace('build-box'), deps({ logger: log, relayConnection, dialStdio, relayWaitMs: 1_000 }));
    // Two connections while the worker opens the connection: one open, and each logs in itself after the wait.
    await expect(Promise.all([roundTrip(address.path, 'first'), roundTrip(address.path, 'second')])).resolves.toEqual(['first', 'second']);
    expect(relayConnection).toHaveBeenCalledTimes(1);
    expect(log.lines.filter((line) => line.includes('is not open'))).toEqual([
      `info The connection of the relay to build-box is not open after 1 s. Until it is, each Docker connection of ${CONTAINER} logs in itself.`,
    ]);
    // The next one logs in itself at once while the open goes on.
    const startedAt = Date.now();
    await expect(roundTrip(address.path, 'between')).resolves.toBe('between');
    expect(Date.now() - startedAt).toBeLessThan(900);
    expect(relayConnection).toHaveBeenCalledTimes(1);
    // The open goes on; the next connections go through the connection that it opened (as relayConnections.get).
    const opened = echoRelay();
    open(opened);
    relayConnection.mockResolvedValue(opened);
    await expect(roundTrip(address.path, 'third')).resolves.toBe('relay: third');
    // A connection that the relay cannot carry (it has no stream left) logs in itself; the next one tries the relay again.
    const full = { openDocker: () => { throw new Error('The connection to build-box has no stream left.'); } } as unknown as RelayConnection;
    relayConnection.mockResolvedValueOnce(full).mockResolvedValue(echoRelay());
    await expect(roundTrip(address.path, 'fourth')).resolves.toBe('fourth');
    expect(log.lines.filter((line) => line.startsWith('warn'))).toEqual([`warn A Docker connection of ${CONTAINER} goes without the connection of the relay: The connection to build-box has no stream left.`]);
    await expect(roundTrip(address.path, 'fifth')).resolves.toBe('relay: fifth');
  });

  it('goes without the connection of the relay after an open that failed when no connection waited for it any more', async () => {
    const runner = new NodeProcessRunner();
    const dialStdio = vi.fn<WindowPipeDeps['dialStdio']>(() => runner.startBytes('cat', []));
    const log = logger();
    const address = dockerPipeAddress(dockerPipeId(COMPUTER, 'build-box', CONTAINER), 'linux', base());
    let fail: (error: Error) => void = () => {};
    const relayConnection = vi.fn<WindowPipeDeps['relayConnection']>(() => new Promise((_, reject) => (fail = reject)));
    await serve(address.dockerHost, devspace('build-box'), deps({ logger: log, relayConnection, dialStdio, relayWaitMs: 50 }));
    await expect(roundTrip(address.path, 'first')).resolves.toBe('first');
    fail(new Error('the helper image could not be prepared: it is missing'));
    await vi.waitFor(() =>
      expect(log.lines).toContain(
        `warn The Docker pipe of ${CONTAINER} goes without the connection of the relay, with an SSH login for each Docker connection: the helper image could not be prepared: it is missing`,
      ),
    );
    await expect(roundTrip(address.path, 'second')).resolves.toBe('second');
    expect(relayConnection).toHaveBeenCalledTimes(1);
  });

  it('goes without the connection of the relay while it cannot be had, and tries it again after a while', async () => {
    const runner = new NodeProcessRunner();
    const dialStdio = vi.fn<WindowPipeDeps['dialStdio']>(() => runner.startBytes('cat', []));
    const failure = new Error('The connection to build-box could not be opened: it ended (Permission denied (publickey).)');
    const without = `warn The Docker pipe of ${CONTAINER} goes without the connection of the relay, with an SSH login for each Docker connection: ${failure.message}`;
    // Not again within RELAY_RETRY_AFTER_MS.
    const log = logger();
    const address = dockerPipeAddress(dockerPipeId(COMPUTER, 'build-box', CONTAINER), 'linux', base());
    const relayConnection = vi.fn<WindowPipeDeps['relayConnection']>(async () => {
      throw failure;
    });
    await serve(address.dockerHost, devspace('build-box'), deps({ logger: log, relayConnection, dialStdio }));
    await expect(roundTrip(address.path, 'first')).resolves.toBe('first');
    await expect(roundTrip(address.path, 'second')).resolves.toBe('second');
    expect(relayConnection).toHaveBeenCalledTimes(1);
    expect(dialStdio).toHaveBeenCalledTimes(2);
    expect(log.lines.filter((line) => line.startsWith('warn'))).toEqual([without]);
    // Again after the time (here at once): the relay carries the connections again.
    const again = logger();
    const retried = dockerPipeAddress(dockerPipeId(COMPUTER, 'other-box', CONTAINER), 'linux', base());
    relayConnection.mockRejectedValueOnce(failure).mockResolvedValue(echoRelay());
    await serve(retried.dockerHost, devspace('other-box'), deps({ logger: again, relayConnection, dialStdio, relayRetryAfterMs: 0 }));
    await expect(roundTrip(retried.path, 'first')).resolves.toBe('first');
    await expect(roundTrip(retried.path, 'second')).resolves.toBe('relay: second');
    expect(again.lines.filter((line) => !line.includes('listens on'))).toEqual([
      `info Docker pipe of ${CONTAINER}: a connection`,
      without,
      `info Docker pipe of ${CONTAINER}: a connection`,
      `info The Docker pipe of ${CONTAINER} goes through the connection of the relay again.`,
    ]);
  });

  it('goes through a connection of the relay that another open made at once, also while it waits to try the relay again', async () => {
    const runner = new NodeProcessRunner();
    const dialStdio = vi.fn<WindowPipeDeps['dialStdio']>(() => runner.startBytes('cat', []));
    const log = logger();
    const address = dockerPipeAddress(dockerPipeId(COMPUTER, 'build-box', CONTAINER), 'linux', base());
    const relayConnection = vi.fn<WindowPipeDeps['relayConnection']>(async () => {
      throw new Error('the worker on build-box is still being opened');
    });
    let open: RelayConnection | undefined;
    await serve(address.dockerHost, devspace('build-box'), deps({ logger: log, relayConnection, dialStdio, openRelayConnection: () => open }));
    await expect(roundTrip(address.path, 'first')).resolves.toBe('first');
    // The worker of an operation opened the connection (relayConnections.get): the next connection uses it, within RELAY_RETRY_AFTER_MS.
    open = echoRelay();
    await expect(roundTrip(address.path, 'second')).resolves.toBe('relay: second');
    expect(relayConnection).toHaveBeenCalledTimes(1);
    expect(dialStdio).toHaveBeenCalledTimes(1);
    expect(log.lines.filter((line) => !line.includes('listens on') && !line.includes(': a connection'))).toEqual([
      `warn The Docker pipe of ${CONTAINER} goes without the connection of the relay, with an SSH login for each Docker connection: the worker on build-box is still being opened`,
      `info The Docker pipe of ${CONTAINER} goes through the connection of the relay again.`,
    ]);
  });
});

