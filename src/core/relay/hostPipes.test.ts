// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Docker pipes of the extension: one pipe per SSH host at a random address, DOCKER_HOST only while a connection of
// the relay to the host is open, and the way of each connection (the relay, or `docker system dial-stdio`; here `cat`).
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeProcessRunner } from '../process';
import { silentLogger, type Logger } from '../ports';
import type { RelayConnection } from './connection';
import { HostPipes, type HostPipesDeps } from './hostPipes';
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
    fs.renameSync(`${address.path}.away`, address.path);
    expect(hostPipes.dockerHost('build-box')).toBe(address.dockerHost);
    // The pipe closes with the window, and its socket and folder are removed.
    hostPipes.dispose();
    expect(hostPipes.dockerHost('build-box')).toBeUndefined();
    expect(fs.existsSync(address.folder as string)).toBe(false);
    await hostPipes.serve('build-box');
    expect(fs.existsSync(address.folder as string)).toBe(false);
  });

  it('serves no pipe for a host that is no SSH alias or address', async () => {
    const folder = base();
    const hostPipes = pipes({ base: () => folder, relayConnection: () => echoRelay() });
    await hostPipes.serve('-oProxyCommand=x');
    await hostPipes.serve('me@box/path');
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
    expect(log.lines.at(-1)).toBe('warn The Docker pipe of the extension on build-box could not reach the Docker engine: ssh was not found, or build-box is no SSH host');
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
