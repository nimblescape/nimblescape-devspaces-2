// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Docker pipes of the extension: one pipe per remote host at a random address, DOCKER_HOST for an SSH host only while
// a connection of the relay to the host is open, and the way of each connection (the relay, or `docker system
// dial-stdio`; here `cat`). The pipe of the WSL distribution of Devspaces never uses the relay.
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WSL_HOST } from '../docker/dockerHost';
import { NodeProcessRunner } from '../process';
import { silentLogger, type Logger } from '../ports';
import type { RelayConnection } from './connection';
import { HostPipes, WSL_PIPE_RETRY_MS, type HostPipesDeps } from './hostPipes';
import { MemoryPipe } from './memoryPipe.testkit';
import { Mux } from './mux';
import { dockerPipeAddress } from './pipeAddress';

const ID = '0123456789abcdef';
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function base(): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'host-pipes-'));
  cleanups.push(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}

function logger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return { ...silentLogger, lines, info: (message) => lines.push(`info ${message}`), warn: (message) => lines.push(`warn ${message}`) };
}

function pipes(deps: Partial<HostPipesDeps> & Pick<HostPipesDeps, 'base'>): HostPipes {
  const hostPipes = new HostPipes({
    logger: silentLogger,
    platform: 'linux',
    relayConnection: () => undefined,
    dialStdio: () => undefined,
    randomId: () => ID,
    ...deps,
  });
  cleanups.push(() => hostPipes.dispose());
  return hostPipes;
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

describe('HostPipes', () => {
  it('names the pipe of a host as DOCKER_HOST only while it listens and a connection of the relay to the host is open', async () => {
    const folder = base();
    const address = dockerPipeAddress(ID, 'linux', folder);
    let connection: RelayConnection | undefined = echoRelay();
    const log = logger();
    const hostPipes = pipes({ base: () => folder, logger: log, relayConnection: (host) => (host === 'build-box' ? connection : undefined) });
    expect(hostPipes.dockerHost('build-box')).toBeUndefined();
    await hostPipes.serve('build-box');
    expect(hostPipes.dockerHost('build-box')).toBe(address.dockerHost);
    expect(fs.statSync(address.folder as string).mode & 0o777).toBe(0o700);
    expect(log.lines).toEqual([`info The Docker pipe of the extension on build-box listens on ${address.dockerHost}.`]);
    // Another host has no pipe; without a connection of the relay, the calls use the Docker context.
    expect(hostPipes.dockerHost('other-box')).toBeUndefined();
    connection = undefined;
    expect(hostPipes.dockerHost('build-box')).toBeUndefined();
    // A second serve keeps the pipe.
    connection = echoRelay();
    await hostPipes.serve('build-box');
    expect(hostPipes.dockerHost('build-box')).toBe(address.dockerHost);
    expect(log.lines).toHaveLength(1);
    // A socket that a cleanup of temporary folders removed: the calls use the Docker context.
    fs.renameSync(address.path, `${address.path}.away`);
    expect(hostPipes.dockerHost('build-box')).toBeUndefined();
    // Another file at the address: the calls use the Docker context.
    fs.writeFileSync(address.path, '');
    expect(hostPipes.dockerHost('build-box')).toBeUndefined();
    fs.rmSync(address.path);
    fs.renameSync(`${address.path}.away`, address.path);
    expect(hostPipes.dockerHost('build-box')).toBe(address.dockerHost);
    // The pipe closes with the window, and its socket and folder are removed.
    hostPipes.dispose();
    expect(hostPipes.dockerHost('build-box')).toBeUndefined();
    expect(fs.existsSync(address.folder as string)).toBe(false);
    await hostPipes.serve('build-box');
    expect(fs.existsSync(address.folder as string)).toBe(false);
  });

  it('serves no pipe for a host that has no transport', async () => {
    const folder = base();
    const hostPipes = pipes({ base: () => folder, relayConnection: () => echoRelay() });
    await hostPipes.serve('-oProxyCommand=x');
    await hostPipes.serve('me@box/path');
    await hostPipes.serve('wsl:-x');
    expect(hostPipes.dockerHost('-oProxyCommand=x')).toBeUndefined();
    expect(fs.readdirSync(folder)).toEqual([]);
  });

  it('carries each connection through the relay, and through its own dial-stdio when the connection ended or cannot carry it', async () => {
    const runner = new NodeProcessRunner();
    const folder = base();
    const address = dockerPipeAddress(ID, 'linux', folder);
    let connection: RelayConnection | undefined = echoRelay();
    const dialStdio = vi.fn<HostPipesDeps['dialStdio']>(() => runner.startBytes('cat', []));
    const log = logger();
    const hostPipes = pipes({ base: () => folder, logger: log, relayConnection: () => connection, dialStdio });
    await hostPipes.serve('build-box');
    await expect(roundTrip(address.path, 'GET /_ping HTTP/1.1\r\n\r\n')).resolves.toBe('relay: GET /_ping HTTP/1.1\r\n\r\n');
    expect(dialStdio).not.toHaveBeenCalled();
    // The connection ended between the choice of the pipe and the connect of the Docker CLI.
    connection = undefined;
    await expect(roundTrip(address.path, 'GET /info HTTP/1.1\r\n\r\n')).resolves.toBe('GET /info HTTP/1.1\r\n\r\n');
    expect(dialStdio).toHaveBeenCalledWith('build-box');
    // A connection that has no stream left.
    connection = {
      openDocker: () => {
        throw new Error('the connection has no stream left');
      },
    } as unknown as RelayConnection;
    await expect(roundTrip(address.path, 'x')).resolves.toBe('x');
    expect(dialStdio).toHaveBeenCalledTimes(2);
    expect(log.lines).toContain('info A Docker connection of the extension on build-box goes without the connection of the relay: the connection has no stream left');
    // Without ssh, the connection is closed, and the log says why.
    dialStdio.mockReturnValue(undefined);
    connection = undefined;
    await expect(roundTrip(address.path, 'y')).resolves.toBe('');
    expect(log.lines.at(-1)).toBe('warn The Docker pipe of the extension on build-box could not reach the Docker engine: ssh was not found');
  });

  it('replaces a pipe whose socket another file replaced at the next serve, at a new address', async () => {
    const folder = base();
    const ids = ['0123456789abcdef', 'fedcba9876543210'];
    const log = logger();
    const hostPipes = pipes({ base: () => folder, logger: log, relayConnection: () => echoRelay(), randomId: () => ids.shift() ?? 'ffffffffffffffff' });
    await hostPipes.serve('build-box');
    const first = dockerPipeAddress('0123456789abcdef', 'linux', folder);
    fs.rmSync(first.path);
    fs.writeFileSync(first.path, '');
    expect(hostPipes.dockerHost('build-box')).toBeUndefined();
    await hostPipes.serve('build-box');
    const second = dockerPipeAddress('fedcba9876543210', 'linux', folder);
    expect(hostPipes.dockerHost('build-box')).toBe(second.dockerHost);
    expect(log.lines).toContain(`info The Docker pipe of the extension on build-box does not serve ${first.dockerHost} anymore, so a new pipe takes its place.`);
    // A pipe that serves stays.
    await hostPipes.serve('build-box');
    expect(hostPipes.dockerHost('build-box')).toBe(second.dockerHost);
    await expect(roundTrip(second.path, 'z')).resolves.toBe('relay: z');
  });

  it('logs a pipe that cannot listen, and tries again at the next serve', async () => {
    const folder = base();
    // A file where the folder of the socket would be.
    const blocked = path.join(folder, 'file');
    fs.writeFileSync(blocked, '');
    let where = blocked;
    const log = logger();
    const hostPipes = pipes({ base: () => where, logger: log, relayConnection: () => echoRelay() });
    await hostPipes.serve('build-box');
    expect(hostPipes.dockerHost('build-box')).toBeUndefined();
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]).toMatch(/^warn The Docker pipe of the extension on build-box cannot listen, so the Docker calls of the extension log in to build-box each time: /);
    where = folder;
    await hostPipes.serve('build-box');
    expect(hostPipes.dockerHost('build-box')).toBe(dockerPipeAddress(ID, 'linux', folder).dockerHost);
  });

  it('closes a pipe that starts to listen while the window closes', async () => {
    const folder = base();
    const address = dockerPipeAddress(ID, 'linux', folder);
    const hostPipes = pipes({ base: () => folder, relayConnection: () => echoRelay() });
    const serving = hostPipes.serve('build-box');
    hostPipes.dispose();
    await serving;
    expect(hostPipes.dockerHost('build-box')).toBeUndefined();
    expect(fs.existsSync(address.folder as string)).toBe(false);
  });

  it('names the pipe of the WSL distribution as DOCKER_HOST while it listens, and carries each connection through its own dial-stdio', async () => {
    const runner = new NodeProcessRunner();
    const folder = base();
    const address = dockerPipeAddress(ID, 'linux', folder);
    // An open connection of the relay to the distribution is never used by this pipe.
    const relayConnection = vi.fn(() => echoRelay());
    const dialStdio = vi.fn<HostPipesDeps['dialStdio']>(() => runner.startBytes('cat', []));
    const log = logger();
    const hostPipes = pipes({ base: () => folder, logger: log, relayConnection, dialStdio });
    expect(hostPipes.dockerHost(WSL_HOST)).toBeUndefined();
    await hostPipes.serve(WSL_HOST);
    expect(hostPipes.dockerHost(WSL_HOST)).toBe(address.dockerHost);
    await expect(roundTrip(address.path, 'GET /_ping HTTP/1.1\r\n\r\n')).resolves.toBe('GET /_ping HTTP/1.1\r\n\r\n');
    expect(dialStdio).toHaveBeenCalledWith(WSL_HOST);
    expect(relayConnection).not.toHaveBeenCalled();
    // Without wsl.exe, the connection is closed, and the log says why.
    dialStdio.mockReturnValue(undefined);
    await expect(roundTrip(address.path, 'y')).resolves.toBe('');
    expect(log.lines.at(-1)).toBe(`warn The Docker pipe of the extension on ${WSL_HOST} could not reach the Docker engine: wsl.exe was not found`);
  });

  it('lets every serve that comes while the pipe starts to listen wait for it', async () => {
    const folder = base();
    const hostPipes = pipes({ base: () => folder });
    const calls = [hostPipes.serve(WSL_HOST), hostPipes.serve(WSL_HOST), hostPipes.serve(WSL_HOST)];
    const seen: Array<string | undefined> = [];
    await Promise.all(calls.map((call) => call.then(() => seen.push(hostPipes.dockerHost(WSL_HOST)))));
    expect(seen).toEqual(Array(3).fill(dockerPipeAddress(ID, 'linux', folder).dockerHost));
  });

  it('logs a pipe of the WSL distribution that cannot listen once, and tries again only after a minute', async () => {
    const folder = base();
    const blocked = path.join(folder, 'file');
    fs.writeFileSync(blocked, '');
    let where = blocked;
    let now = 1_000_000;
    const log = logger();
    const hostPipes = pipes({ base: () => where, logger: log, now: () => now });
    await hostPipes.serve(WSL_HOST);
    expect(hostPipes.dockerHost(WSL_HOST)).toBeUndefined();
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]).toMatch(
      new RegExp(`^warn The Docker pipe of the extension on ${WSL_HOST} cannot listen, so the Docker calls of the extension cannot reach ${WSL_HOST}; it tries again in 60 seconds: `),
    );
    // Every call within the minute: no new try, no new warning.
    where = folder;
    now += WSL_PIPE_RETRY_MS - 1;
    await hostPipes.serve(WSL_HOST);
    expect(hostPipes.dockerHost(WSL_HOST)).toBeUndefined();
    expect(log.lines).toHaveLength(1);
    now += 1;
    await hostPipes.serve(WSL_HOST);
    expect(hostPipes.dockerHost(WSL_HOST)).toBe(dockerPipeAddress(ID, 'linux', folder).dockerHost);
  });

  it('gives each pipe a new random address', async () => {
    const ids: string[] = [];
    const folder = base();
    const hostPipes = new HostPipes({
      logger: silentLogger,
      platform: 'linux',
      base: () => folder,
      relayConnection: () => echoRelay(),
      dialStdio: () => undefined,
    });
    cleanups.push(() => hostPipes.dispose());
    await hostPipes.serve('build-box');
    await hostPipes.serve('other-box');
    for (const host of ['build-box', 'other-box']) {
      const match = /\/devspaces-([0-9a-f]{16})\/docker\.sock$/.exec(hostPipes.dockerHost(host) ?? '');
      expect(match).not.toBeNull();
      ids.push(match?.[1] ?? '');
    }
    expect(new Set(ids).size).toBe(2);
  });
});
