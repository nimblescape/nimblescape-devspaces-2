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
  const sources = { computerId: () => COMPUTER, platform: 'linux' as const, env: { XDG_RUNTIME_DIR: '/run/user/1000' }, tmpdir: '/tmp', sshFound: () => true };

  it('gives a devspace on an SSH host the pipe of this computer for its container', () => {
    const address = windowDockerHost(devspace('me@build-box:2222'), CONTAINER, sources);
    expect(address).toBe(dockerPipeAddress(dockerPipeId(COMPUTER, 'me@build-box:2222', CONTAINER), 'linux', '/run/user/1000').dockerHost);
    expect(parseDockerPipeHost(address as string, 'linux')).toBeDefined();
    expect(windowDockerHost(devspace('build-box'), CONTAINER, { ...sources, platform: 'win32' })).toMatch(/^npipe:\/\/\/\/\.\/pipe\/devspaces-[0-9a-f]{16}$/);
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
    expect(await serve(address.dockerHost, devspace('build-box'), deps({ logger: log }))).toEqual({ kind: 'refused', reason: `${address.path} is in use: another window serves it.` });
    expect(log.lines.at(-1)).toBe(`${notServed}: ${address.path} is in use: another window serves it.`);
  });

  it('carries each connection through the relay, and through its own dial-stdio while the engine has the removal mark', async () => {
    const runner = new NodeProcessRunner();
    const address = dockerPipeAddress(dockerPipeId(COMPUTER, 'build-box', CONTAINER), 'linux', base());
    let removed = false;
    const relayConnection = vi.fn<WindowPipeDeps['relayConnection']>(async () => {
      throw new Error('The connection to build-box could not be opened: it ended (Permission denied (publickey).)');
    });
    const dialStdio = vi.fn<WindowPipeDeps['dialStdio']>(() => runner.startBytes('cat', []));
    const log = logger();
    await serve(address.dockerHost, devspace('build-box'), deps({ logger: log, engineRemoved: async () => removed, relayConnection, dialStdio }));
    await expect(roundTrip(address.path, 'GET /_ping HTTP/1.1\r\n\r\n')).resolves.toBe('');
    expect(relayConnection).toHaveBeenCalledWith(devspace('build-box'));
    expect(log.lines.at(-1)).toBe(`warn The Docker pipe of ${CONTAINER} could not reach the Docker engine: The connection to build-box could not be opened: it ended (Permission denied (publickey).)`);
    removed = true;
    await expect(roundTrip(address.path, 'GET /_ping HTTP/1.1\r\n\r\n')).resolves.toBe('GET /_ping HTTP/1.1\r\n\r\n');
    expect(dialStdio).toHaveBeenCalledTimes(1);
    expect(relayConnection).toHaveBeenCalledTimes(1);
    // Without ssh, the connection ends with the reason.
    dialStdio.mockReturnValue(undefined);
    await expect(roundTrip(address.path, 'x')).resolves.toBe('');
    expect(log.lines.at(-1)).toBe(`warn The Docker pipe of ${CONTAINER} could not reach the Docker engine: ssh was not found, or build-box is no SSH host`);
  });
});
