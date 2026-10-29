// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The relay in this process: its connection in memory to the extension's side (a Mux), a real Unix socket of the test
// as the Docker socket, and fake worker processes. The real bundle with the pipe loader: relay.e2e.test.ts.
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { encodeFrame } from '../core/relay/frames';
import type { WorkerExit } from '../core/relay/frames';
import { MemoryPipe, settle } from '../core/relay/memoryPipe.testkit';
import { Mux, type MuxStream } from '../core/relay/mux';
import { RELAY_EXIT_MARGIN_MS, RELAY_FAILURE_EXIT_CODE, Relay, type RelayWorker } from './relay';

/**
 * A worker process of the test: its input and output in memory, its end when the test says, or at SIGKILL (unless
 * `hang`).
 */
class FakeWorker implements RelayWorker {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly signals: string[] = [];
  input = '';
  inputEnded = false;
  hang = false;
  private listener: ((exit: WorkerExit, error?: Error) => void) | undefined;
  private ended = false;

  constructor() {
    this.stdin.on('data', (chunk: Buffer) => (this.input += chunk.toString()));
    this.stdin.on('end', () => (this.inputEnded = true));
  }

  kill(signal: NodeJS.Signals): void {
    this.signals.push(signal);
    if (signal === 'SIGKILL' && !this.hang) this.end({ code: null, signal });
  }

  onClosed(listener: (exit: WorkerExit, error?: Error) => void): void {
    this.listener = listener;
  }

  /** The process ends after its output. */
  end(exit: WorkerExit, error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.stdout.end();
    this.listener?.(exit, error);
  }
}

const describeUnix = process.platform === 'win32' ? describe.skip : describe;

describeUnix('the relay', () => {
  let dir = '';
  let socketPath = '';
  let server: net.Server;
  /** What each connection to the socket sent, by the order of the connections. */
  const received: string[] = [];
  const relays: Relay[] = [];
  const allWorkers: FakeWorker[] = [];

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-relay-'));
    socketPath = path.join(dir, 'docker.sock');
    // Reads its input to the end, then answers it and ends: the order of `docker exec -i` (input before output).
    server = net.createServer({ allowHalfOpen: true }, (socket) => {
      const at = received.push('') - 1;
      socket.on('data', (chunk: Buffer) => (received[at] += chunk.toString()));
      socket.on('end', () => socket.end(`got ${received[at]}`));
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const relay of relays.splice(0)) relay.shutdown('the test ended');
    for (const worker of allWorkers.splice(0)) worker.end({ code: 0, signal: null });
  });

  function start(options: { spawn?: () => RelayWorker; workerStopMs?: number; socket?: string } = {}) {
    const up = new MemoryPipe();
    const down = new MemoryPipe();
    const workers: FakeWorker[] = [];
    const exits: number[] = [];
    const lines: string[] = [];
    const relay = new Relay({
      link: down.link,
      connectDocker: () => net.createConnection({ path: options.socket ?? socketPath, allowHalfOpen: true }),
      spawnWorker:
        options.spawn ??
        (() => {
          const worker = new FakeWorker();
          workers.push(worker);
          allWorkers.push(worker);
          return worker;
        }),
      log: (line) => lines.push(line),
      exit: (code) => exits.push(code),
      workerStopMs: options.workerStopMs,
    });
    relays.push(relay);
    const extension = new Mux({ side: 'extension', link: up.link });
    up.target = relay;
    down.target = extension;
    return { relay, extension, up, down, workers, exits, lines };
  }

  /** The data, the end, the exit and the close of a stream, as text. */
  function watch(stream: MuxStream): string[] {
    const events: string[] = [];
    stream.onData((chunk) => {
      events.push(chunk.toString());
      stream.consumed(chunk.length);
    });
    stream.onEnd(() => events.push('end'));
    stream.onExit((exit) => events.push(`exit ${JSON.stringify(exit)}`));
    stream.onClose((reason) => events.push(`close ${reason}`));
    return events;
  }

  async function until(condition: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 500 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    if (!condition()) throw new Error(`Timed out waiting for ${what}`);
  }

  it('says HELLO first and connects a Docker stream to the socket, each direction with its own end', async () => {
    const { extension, down } = start();
    const stream = extension.open('docker');
    const events = watch(stream);
    stream.write(Buffer.from('GET /version'));
    stream.end();
    await until(() => events.includes('end'), 'the end of the answer');
    expect(down.frames[0].kind).toBe('hello');
    expect(events.join('')).toBe('got GET /versionend');
    expect(received.at(-1)).toBe('GET /version');
    await settle();
    expect(stream.isOpen).toBe(false);
    expect(extension.streamCount).toBe(0);
  });

  it('closes a Docker stream with the reason when the socket cannot be reached', async () => {
    const { extension } = start({ socket: path.join(dir, 'missing.sock') });
    const events = watch(extension.open('docker'));
    await until(() => events.length > 0, 'the close of the stream');
    expect(events).toEqual([expect.stringMatching(/^close connect ENOENT .*missing\.sock$/)]);
  });

  it('starts one worker at a time and ends its stream with its exit after its last output', async () => {
    const { extension, workers } = start();
    const stream = extension.open('worker');
    const events = watch(stream);
    stream.write(Buffer.from('{"t":"hello","protocol":3}\n'));
    await until(() => (workers[0]?.input ?? '') !== '', 'the input of the worker');
    expect(workers[0].input).toBe('{"t":"hello","protocol":3}\n');
    const second = watch(extension.open('worker'));
    await until(() => second.length > 0, 'the refusal of a second worker');
    expect(second).toEqual(['close a worker runs already']);
    workers[0].stdout.write('{"t":"hello"}\n');
    workers[0].end({ code: 0, signal: null });
    await until(() => events.length >= 2, 'the exit of the worker');
    expect(events).toEqual(['{"t":"hello"}\n', 'exit {"code":0,"signal":null}']);
    // The next worker stream starts a new worker on the same connection.
    extension.open('worker');
    await until(() => workers.length === 2, 'the second worker');
  });

  it('ends the input of the worker at the end of its stream', async () => {
    const { extension, workers } = start();
    const stream = extension.open('worker');
    watch(stream);
    stream.end();
    await until(() => workers[0]?.inputEnded === true, 'the end of the input of the worker');
    expect(workers[0].signals).toEqual([]);
  });

  it('closes a worker stream whose worker cannot be started', async () => {
    const { extension } = start({
      spawn: () => {
        throw new Error('spawn node ENOENT');
      },
    });
    const events = watch(extension.open('worker'));
    await until(() => events.length > 0, 'the close of the stream');
    expect(events).toEqual(['close the worker cannot be started: spawn node ENOENT']);
  });

  it('at the end of its input, ends the worker and exits once the worker ended', async () => {
    const { relay, extension, workers, exits, lines } = start();
    watch(extension.open('worker'));
    await until(() => workers.length === 1, 'the worker');
    relay.inputEnded();
    expect(workers[0].signals).toEqual(['SIGTERM']);
    expect(workers[0].stdin.destroyed).toBe(true);
    expect(exits).toEqual([]);
    workers[0].end({ code: 0, signal: null });
    expect(exits).toEqual([0]);
    expect(lines).toEqual([]);
  });

  it('exits with RELAY_FAILURE_EXIT_CODE when a failure comes while it waits for the worker', async () => {
    const { relay, extension, workers, exits, lines } = start();
    watch(extension.open('worker'));
    await until(() => workers.length === 1, 'the worker');
    relay.inputEnded();
    relay.shutdown('an error of the relay: boom', true);
    workers[0].end({ code: 0, signal: null });
    expect(exits).toEqual([RELAY_FAILURE_EXIT_CODE]);
    expect(lines).toEqual(['devspace relay: an error of the relay: boom']);
  });

  it('stops a worker that does not end with SIGKILL after the stop time, and exits', async () => {
    const { relay, extension, workers, exits, lines } = start({ workerStopMs: 50 });
    watch(extension.open('worker'));
    await until(() => workers.length === 1, 'the worker');
    relay.shutdown('stopped by SIGTERM');
    await until(() => exits.length > 0, 'the exit');
    expect(workers[0].signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(exits).toEqual([0]);
    expect(lines).toEqual(['devspace relay: stopped by SIGTERM']);
  });

  it('exits a little after the SIGKILL when the end of the worker never shows', async () => {
    const { relay, extension, workers, exits } = start({ workerStopMs: 50 });
    watch(extension.open('worker'));
    await until(() => workers.length === 1, 'the worker');
    workers[0].hang = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    relay.shutdown('stopped by SIGTERM');
    vi.advanceTimersByTime(50);
    expect(workers[0].signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(exits).toEqual([]);
    vi.advanceTimersByTime(RELAY_EXIT_MARGIN_MS);
    expect(exits).toEqual([0]);
  });

  it('stops the worker of a stream that the extension closed, with SIGKILL when it does not end, and then starts the next', async () => {
    const { extension, workers } = start({ workerStopMs: 50 });
    const first = extension.open('worker');
    watch(first);
    await until(() => workers.length === 1, 'the worker');
    first.close('the channel was closed');
    const refused = watch(extension.open('worker'));
    await until(() => refused.length > 0, 'the refusal while the first worker stops');
    expect(refused).toEqual(['close a worker runs already']);
    await until(() => workers[0].signals.length === 2, 'the SIGKILL');
    expect(workers[0].signals).toEqual(['SIGTERM', 'SIGKILL']);
    watch(extension.open('worker'));
    await until(() => workers.length === 2, 'the next worker');
  });

  it('exits at once without a worker; after a frame that breaks the rules with a line and RELAY_FAILURE_EXIT_CODE', () => {
    const { relay, exits, lines } = start();
    relay.input(encodeFrame('data', 7, Buffer.from('x')));
    expect(lines).toEqual(['devspace relay: the other side sent a frame data on the stream 7, which was never opened']);
    expect(exits).toEqual([RELAY_FAILURE_EXIT_CODE]);
  });
});
