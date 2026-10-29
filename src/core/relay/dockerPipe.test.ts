// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Docker pipe with real Unix sockets: its private folder, the connections through the relay (the extension and
// the relay in memory, the engine a socket server), and the connections of `docker system dial-stdio` (here `cat`).
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeProcessRunner } from '../process';
import { silentLogger, type Logger, type StartedByteProcess } from '../ports';
import { bridgeStream } from './bridge';
import type { RelayConnection } from './connection';
import { DockerPipe, PIPE_LOGGED_CONNECTIONS, processDockerDial, relayDockerDial, requestLine } from './dockerPipe';
import { MemoryPipe } from './memoryPipe.testkit';
import { Mux } from './mux';
import { dockerPipeAddress, type DockerPipeAddress } from './pipeAddress';

const ID = '0123456789abcdef';
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** A new folder for the folder of the socket. */
function base(): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-'));
  cleanups.push(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}

function logger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return { ...silentLogger, lines, info: (message) => lines.push(`info ${message}`), warn: (message) => lines.push(`warn ${message}`) };
}

async function listen(address: DockerPipeAddress, connect: (socket: net.Socket) => Promise<void>, log: Logger = silentLogger): Promise<DockerPipe> {
  const pipe = await DockerPipe.listen({ address, connect, logger: log, name: 'devspaces-api' });
  cleanups.push(() => pipe.close());
  return pipe;
}

/** Sends `request`, ends the direction of the client, and resolves with all that came back until the end. */
function exchange(socketPath: string, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = net.connect({ path: socketPath, allowHalfOpen: true });
    let answer = '';
    client.on('data', (chunk: Buffer) => (answer += chunk.toString()));
    client.on('end', () => {
      client.end();
      resolve(answer);
    });
    client.on('error', reject);
    client.write(request);
    client.end();
  });
}

/** Sends `request` and resolves with what came back once the connection closed (also after an error of the client). */
function refused(socketPath: string, request: string): Promise<string> {
  return new Promise((resolve) => {
    const client = net.connect(socketPath);
    let answer = '';
    client.on('data', (chunk: Buffer) => (answer += chunk.toString()));
    client.on('error', () => {});
    client.on('close', () => resolve(answer));
    client.write(request);
  });
}

/** A server like the Docker engine: it answers what it read once the client ended its direction. */
async function engine(): Promise<{ path: string; requests: string[] }> {
  const folder = base();
  const socketPath = path.join(folder, 'engine.sock');
  const requests: string[] = [];
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    let request = '';
    socket.on('data', (chunk: Buffer) => (request += chunk.toString()));
    socket.on('end', () => {
      requests.push(request);
      socket.end(`answer to ${request}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanups.push(() => server.close());
  return { path: socketPath, requests };
}

/** The extension and the relay in memory; the relay connects each Docker stream with the socket at `enginePath`. */
function relayConnection(enginePath: string): RelayConnection {
  const up = new MemoryPipe();
  const down = new MemoryPipe();
  const relay = new Mux({
    side: 'relay',
    link: down.link,
    accept: (stream) => {
      const socket = net.connect({ path: enginePath, allowHalfOpen: true });
      bridgeStream(stream, socket, socket);
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

describe('the Docker pipe', () => {
  it('listens in a folder of this user that nobody else may use, and removes both at close', async () => {
    const address = dockerPipeAddress(ID, 'linux', base());
    const log = logger();
    const pipe = await listen(address, async () => {}, log);
    const folder = address.folder as string;
    expect(fs.statSync(folder).mode & 0o777).toBe(0o700);
    expect(fs.lstatSync(address.path).isSocket()).toBe(true);
    expect(fs.statSync(address.path).mode & 0o777).toBe(0o600);
    expect(log.lines).toEqual([`info The Docker pipe of devspaces-api listens on ${address.dockerHost}.`]);
    pipe.close();
    expect(fs.existsSync(folder)).toBe(false);
  });

  it('makes an existing folder private, removes a socket that nobody serves, and refuses one that is served', async () => {
    const address = dockerPipeAddress(ID, 'linux', base());
    const folder = address.folder as string;
    fs.mkdirSync(folder, { mode: 0o755 });
    fs.chmodSync(folder, 0o755);
    // A socket of an extension host that ended.
    const stale = net.createServer();
    await new Promise<void>((resolve) => stale.listen(address.path, resolve));
    // Closing the server removes the file; a copy of its kind stays (a socket file without a server).
    fs.renameSync(address.path, `${address.path}.kept`);
    await new Promise<void>((resolve) => stale.close(() => resolve()));
    fs.renameSync(`${address.path}.kept`, address.path);
    const first = await listen(address, async () => {});
    expect(fs.statSync(folder).mode & 0o777).toBe(0o700);
    await expect(DockerPipe.listen({ address, connect: async () => {}, logger: silentLogger, name: 'other window', inUseWaitMs: 0 })).rejects.toThrow(
      'is in use: another window serves it',
    );
    first.close();
  });

  it('waits while another program serves the address, and listens once it ended (the extension host before a reload)', async () => {
    const address = dockerPipeAddress(ID, 'linux', base());
    const log = logger();
    const before = await DockerPipe.listen({ address, connect: async () => {}, logger: silentLogger, name: 'devspaces-api' });
    setTimeout(() => before.close(), 300);
    const after = await listen(address, async () => {}, log);
    expect(log.lines).toEqual([
      `info ${address.dockerHost} is in use. The Docker pipe of devspaces-api waits up to 15 s for the program that serves it to end.`,
      `info The Docker pipe of devspaces-api listens on ${address.dockerHost}.`,
    ]);
    expect(after.connectionCount).toBe(0);
    expect(fs.lstatSync(address.path).isSocket()).toBe(true);
  });

  it('gives the socket and its folder a new time, and listens again when the socket was removed', async () => {
    const address = dockerPipeAddress(ID, 'linux', base());
    const folder = address.folder as string;
    const log = logger();
    const pipe = await DockerPipe.listen({ address, connect: async (socket) => void socket.end('hello'), logger: log, name: 'devspaces-api', refreshIntervalMs: 50 });
    cleanups.push(() => pipe.close());
    const old = new Date('2026-01-01T00:00:00Z');
    fs.utimesSync(folder, old, old);
    fs.utimesSync(address.path, old, old);
    await vi.waitFor(() => {
      expect(fs.statSync(folder).mtimeMs).toBeGreaterThan(old.getTime());
      expect(fs.statSync(address.path).mtimeMs).toBeGreaterThan(old.getTime());
    });
    // A cleanup of the temporary folder removed the socket and its folder.
    fs.rmSync(folder, { recursive: true });
    await vi.waitFor(() => expect(log.lines.at(-1)).toBe(`info The socket of the Docker pipe of devspaces-api was removed. The pipe listens again on ${address.dockerHost}.`));
    expect(fs.statSync(folder).mode & 0o777).toBe(0o700);
    await expect(exchange(address.path, 'x')).resolves.toBe('hello');
  });

  it('logs once that another file replaced the socket, and leaves that file as it is', async () => {
    const address = dockerPipeAddress(ID, 'linux', base());
    const log = logger();
    const pipe = await DockerPipe.listen({ address, connect: async (socket) => void socket.end('hello'), logger: log, name: 'devspaces-api', refreshIntervalMs: 20 });
    cleanups.push(() => pipe.close());
    const other = path.join(address.folder as string, 'other');
    fs.writeFileSync(other, 'another program');
    fs.renameSync(other, address.path);
    const replaced = `warn Another file replaced the socket of the Docker pipe of devspaces-api at ${address.path}. The Docker calls of this window do not reach the pipe until the window is reloaded.`;
    await vi.waitFor(() => expect(log.lines).toContain(replaced));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(log.lines.filter((line) => line === replaced)).toHaveLength(1);
    expect(fs.readFileSync(address.path, 'utf8')).toBe('another program');
  });

  it('logs the first connections one by one, and the number of the next ones each hour', async () => {
    const address = dockerPipeAddress(ID, 'linux', base());
    const log = logger();
    const pipe = await DockerPipe.listen({ address, connect: async (socket) => void socket.end('hello'), logger: log, name: 'devspaces-api', refreshIntervalMs: 200 });
    cleanups.push(() => pipe.close());
    for (let index = 0; index < PIPE_LOGGED_CONNECTIONS + 3; index += 1) await expect(exchange(address.path, 'GET /_ping HTTP/1.1\r\n\r\n')).resolves.toBe('hello');
    expect(log.lines.filter((line) => line === 'info Docker pipe of devspaces-api: GET /_ping')).toHaveLength(PIPE_LOGGED_CONNECTIONS);
    expect(log.lines).toContain('info The Docker pipe of devspaces-api logs no further connection one by one, only their number each hour.');
    // The counts of the hours (here 200 ms) add up to the connections that were not logged one by one.
    const counted = () =>
      log.lines.map((line) => /^info The Docker pipe of devspaces-api had (\d+) more connections\.$/.exec(line)?.[1]).reduce((sum, count) => sum + Number(count ?? 0), 0);
    await vi.waitFor(() => expect(counted()).toBe(3));
    // The number since the last count also at the close.
    for (let index = 0; index < 2; index += 1) await expect(exchange(address.path, 'GET /_ping HTTP/1.1\r\n\r\n')).resolves.toBe('hello');
    pipe.close();
    expect(counted()).toBe(5);
  });

  it('refuses a folder that is a link', async () => {
    const parent = base();
    const address = dockerPipeAddress(ID, 'linux', parent);
    fs.symlinkSync(base(), address.folder as string);
    await expect(DockerPipe.listen({ address, connect: async () => {}, logger: silentLogger, name: 'devspaces-api' })).rejects.toThrow('is not a folder');
  });

  it('carries a connection through the relay, both directions and their ends, and logs its request line', async () => {
    const target = await engine();
    const log = logger();
    const connection = vi.fn(() => relayConnection(target.path));
    const address = dockerPipeAddress(ID, 'linux', base());
    const pipe = await listen(address, async (socket) => relayDockerDial(connection(), socket), log);
    const request = 'GET /v1.47/containers/json?all=1 HTTP/1.1\r\nHost: api.moby.localhost\r\n\r\n';
    await expect(exchange(address.path, request)).resolves.toBe(`answer to ${request}`);
    expect(target.requests).toEqual([request]);
    expect(log.lines).toContain('info Docker pipe of devspaces-api: GET /containers/json');
    // Several connections at the same time, each its own stream.
    const answers = await Promise.all(['one', 'two', 'three'].map((text) => exchange(address.path, text)));
    expect(answers).toEqual(['answer to one', 'answer to two', 'answer to three']);
    expect(connection).toHaveBeenCalledTimes(4);
    await vi.waitFor(() => expect(pipe.connectionCount).toBe(0));
  });

  it('ends a connection when the engine cannot be reached, with the reason in the log', async () => {
    const log = logger();
    const address = dockerPipeAddress(ID, 'linux', base());
    const closed = {
      openDocker: () => {
        throw new Error('The connection to build-box is closed.');
      },
    } as unknown as RelayConnection;
    await listen(address, async (socket) => relayDockerDial(closed, socket), log);
    await expect(refused(address.path, 'GET /_ping HTTP/1.1\r\n\r\n')).resolves.toBe('');
    expect(log.lines).toContain('warn The Docker pipe of devspaces-api could not reach the Docker engine: The connection to build-box is closed.');
  });

  it('carries a connection through a program of its own (`cat` in place of `docker system dial-stdio`)', async () => {
    const runner = new NodeProcessRunner();
    const log = logger();
    const address = dockerPipeAddress(ID, 'linux', base());
    const pipe = await listen(address, processDockerDial(() => runner.startBytes('cat', []), log, 'build-box'), log);
    const request = 'POST /v1.47/exec/abc/start HTTP/1.1\r\n\r\n{"Detach":false}';
    await expect(exchange(address.path, request)).resolves.toBe(request);
    await vi.waitFor(() => expect(pipe.connectionCount).toBe(0));
    expect(log.lines.filter((line) => line.startsWith('warn'))).toEqual([]);
    // A program that fails: its error output is logged, and the connection ends.
    const failingAddress = dockerPipeAddress('fedcba9876543210', 'linux', base());
    const fail = () => runner.startBytes('sh', ['-c', 'echo "ssh: connect to host build-box port 22: Connection refused" >&2; exit 255']);
    await listen(failingAddress, processDockerDial(fail, log, 'build-box'));
    await expect(refused(failingAddress.path, 'x')).resolves.toBe('');
    expect(log.lines).toContain('warn The Docker connection of build-box ended: ssh: connect to host build-box port 22: Connection refused');
  });

  it('ends the connection when the program ended, also while the client still sends', async () => {
    const runner = new NodeProcessRunner();
    const address = dockerPipeAddress(ID, 'linux', base());
    const pipe = await listen(address, processDockerDial(() => runner.startBytes('head', ['-c', '1']), silentLogger, 'build-box'));
    const closed = new Promise<void>((resolve) => {
      const client = net.connect({ path: address.path, allowHalfOpen: true });
      client.on('error', () => {});
      client.on('close', () => resolve());
      // More than the pipes hold, and no end: the socket waits for a drain of the program, which ended.
      client.write(Buffer.alloc(4_000_000));
    });
    await closed;
    await vi.waitFor(() => expect(pipe.connectionCount).toBe(0));
  });

  it('ends the program when the client leaves while the program waits for it', async () => {
    const runner = new NodeProcessRunner();
    const address = dockerPipeAddress(ID, 'linux', base());
    let started: StartedByteProcess | undefined;
    const start = () => (started = runner.startBytes('head', ['-c', '80000000', '/dev/zero']));
    await listen(address, processDockerDial(start, silentLogger, 'build-box'));
    await new Promise<void>((resolve) => {
      const client = net.connect({ path: address.path, allowHalfOpen: true });
      client.pause();
      client.on('error', () => {});
      client.on('close', () => resolve());
      client.write('x');
      // The client never reads, so the program waits; then the client leaves.
      setTimeout(() => client.destroy(), 300);
    });
    await vi.waitFor(() => expect(started).toBeDefined());
    await expect(started!.exited).resolves.toBeDefined();
  });

  it('lets the program wait while the client reads slower than the program writes', async () => {
    const runner = new NodeProcessRunner();
    const address = dockerPipeAddress(ID, 'linux', base());
    const calls: string[] = [];
    const start = () => {
      const started = runner.startBytes('head', ['-c', '8000000', '/dev/zero']);
      return {
        ...started,
        pauseStdout: () => {
          calls.push('pause');
          started.pauseStdout();
        },
        resumeStdout: () => {
          calls.push('resume');
          started.resumeStdout();
        },
      };
    };
    await listen(address, processDockerDial(start, silentLogger, 'build-box'));
    const received = await new Promise<number>((resolve, reject) => {
      const client = net.connect({ path: address.path, allowHalfOpen: true });
      let bytes = 0;
      client.pause();
      client.on('data', (chunk: Buffer) => (bytes += chunk.length));
      client.on('end', () => {
        client.end();
        resolve(bytes);
      });
      client.on('error', reject);
      client.write('x');
      // The client reads only after a while: the program waits in the meantime.
      setTimeout(() => client.resume(), 300);
    });
    expect(received).toBe(8_000_000);
    expect(calls.slice(0, 2)).toEqual(['pause', 'resume']);
  });

  it('reaches the engine only after the first bytes of a connection', async () => {
    const address = dockerPipeAddress(ID, 'linux', base());
    const connect = vi.fn(async (socket: net.Socket) => void socket.end('answer'));
    const pipe = await listen(address, connect);
    // A check whether the address is in use: it connects and closes at once.
    await new Promise<void>((resolve) => {
      const probe = net.connect(address.path);
      probe.on('connect', () => probe.destroy());
      probe.on('close', () => resolve());
    });
    // A client that ends without a request.
    await expect(exchange(address.path, '')).resolves.toBe('');
    await vi.waitFor(() => expect(pipe.connectionCount).toBe(0));
    expect(connect).not.toHaveBeenCalled();
    await expect(exchange(address.path, 'GET /_ping HTTP/1.1\r\n\r\n')).resolves.toBe('answer');
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('closes a connection whose first bytes do not come in time', async () => {
    const address = dockerPipeAddress(ID, 'linux', base());
    const connect = vi.fn(async () => {});
    const pipe = await DockerPipe.listen({ address, connect, logger: silentLogger, name: 'devspaces-api', firstBytesTimeoutMs: 50 });
    cleanups.push(() => pipe.close());
    await new Promise<void>((resolve) => {
      const client = net.connect(address.path);
      client.on('error', () => {});
      client.on('close', () => resolve());
    });
    await vi.waitFor(() => expect(pipe.connectionCount).toBe(0));
    expect(connect).not.toHaveBeenCalled();
  });

  it('ends every connection at close', async () => {
    const address = dockerPipeAddress(ID, 'linux', base());
    // A connect that never connects anything: the connection waits.
    const pipe = await listen(address, () => new Promise(() => {}));
    const closed = new Promise<void>((resolve) => {
      const client = net.connect(address.path);
      client.on('connect', () => setTimeout(() => pipe.close(), 20));
      client.on('close', () => resolve());
      client.on('error', () => {});
    });
    await closed;
    expect(pipe.connectionCount).toBe(0);
  });
});

describe('the request line in the log', () => {
  it('names the method and the path without the query and the version of the API', () => {
    expect(requestLine(Buffer.from('POST /v1.47/containers/abc/exec HTTP/1.1\r\nHost: x\r\n'))).toBe('POST /containers/abc/exec');
    expect(requestLine(Buffer.from('HEAD /_ping HTTP/1.1\r\n'))).toBe('HEAD /_ping');
    expect(requestLine(Buffer.from('GET /v1.47/events?filters=%7B%22type%22%3A%5B%22container%22%5D%7D HTTP/1.1\r\n'))).toBe('GET /events');
    expect(requestLine(Buffer.from('GET /info HTTP/1.0'))).toBe('GET /info');
    expect(requestLine(Buffer.from('\x16\x03\x01 binary'))).toBe('a connection');
    expect(requestLine(Buffer.from(`GET /${'a'.repeat(600)} HTTP/1.1\r\n`))).toBe('a connection');
    // A long query: only the method and the path count.
    expect(requestLine(Buffer.from(`GET /v1.47/containers/json?filters=${'x'.repeat(800)} HTTP/1.1\r\n`))).toBe('GET /containers/json');
  });
});
