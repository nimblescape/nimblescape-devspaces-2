// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The connection of the relay on the side of the extension, on a fake transport: the start script, the text of the
// login before the marker, the bundle line after it, the HELLO of a relay mux of the test, the failures of the open,
// and a worker stream as the program of a helper channel.
import { afterEach, describe, expect, it } from 'vitest';
import { encodeBundle } from '../loader/pipeLoader';
import { silentLogger, type Logger, type StartedByteProcess } from '../ports';
import { MAX_OUTPUT_BEFORE_MARKER, RelayConnection, RelayConnectionError, type RelayConnectionOptions } from './connection';
import { settle } from './memoryPipe.testkit';
import { Mux, type MuxStream } from './mux';
import { relayStartScript, startMarker } from './startScript';

const BUNDLE = 'exports.startRelay = () => {}; // äü€\n"quoted"';

/** A transport whose other side is the test: the start script and the bundle line are kept; then a relay mux of the test. */
class FakeTransport implements StartedByteProcess {
  readonly written: Buffer[] = [];
  inputEnded = false;
  kills = 0;
  killsNow = 0;
  relay: Mux | undefined;
  readonly relayCloses: string[] = [];
  readonly exited: Promise<{ exitCode: number | null; error?: Error }>;
  private finish!: (result: { exitCode: number | null; error?: Error }) => void;
  private done = false;
  private stdoutListener: ((chunk: Buffer) => void) | undefined;
  private stdoutEnd: (() => void) | undefined;
  private stderrListener: ((text: string) => void) | undefined;

  constructor() {
    this.exited = new Promise((resolve) => (this.finish = resolve));
  }

  write(chunk: Buffer): boolean {
    if (this.done) return true;
    const relay = this.relay;
    if (relay) setImmediate(() => relay.input(chunk));
    else this.written.push(chunk);
    return true;
  }

  onDrain(): void {}

  pauseStdout(): void {}

  resumeStdout(): void {}

  end(): void {
    this.inputEnded = true;
    const relay = this.relay;
    if (relay) setImmediate(() => relay.inputEnded());
  }

  kill(): void {
    this.kills++;
    this.exit(null);
  }

  killNow(): void {
    this.killsNow++;
    this.exit(null);
  }

  onStdout(listener: (chunk: Buffer) => void, onEnd: () => void): void {
    this.stdoutListener = listener;
    this.stdoutEnd = onEnd;
  }

  onStderr(listener: (text: string) => void): void {
    this.stderrListener = listener;
  }

  /** What the extension wrote before the relay started, as text. */
  text(): string {
    return Buffer.concat(this.written).toString('utf8');
  }

  /** The marker of the start script that the extension wrote. */
  marker(): string {
    const match = /^printf '%s\\n' (devspaces-start-[0-9a-f]{32}); exec /.exec(this.text());
    if (!match) throw new Error(`no start script: ${this.text()}`);
    return match[1];
  }

  print(data: string | Buffer): void {
    this.stdoutListener!(Buffer.from(data));
  }

  printError(text: string): void {
    this.stderrListener!(text);
  }

  /** The output ends, and the transport keeps running. */
  endOutput(): void {
    this.stdoutEnd!();
  }

  /** The relay of the test starts: its mux on the input from now on, and its output on the output of the transport. */
  startRelay(accept: (stream: MuxStream) => void): Mux {
    this.relay = new Mux({
      side: 'relay',
      accept,
      onClose: (reason) => this.relayCloses.push(reason),
      link: {
        write: (frame) => {
          setImmediate(() => this.stdoutListener?.(frame));
          return true;
        },
        onDrain: () => {},
        end: () => setImmediate(() => this.stdoutEnd?.()),
      },
    });
    return this.relay;
  }

  exit(exitCode: number | null): void {
    if (this.done) return;
    this.done = true;
    this.relay?.close('the transport ended');
    setImmediate(() => {
      this.stdoutEnd?.();
      this.finish({ exitCode });
    });
  }
}

const connections: RelayConnection[] = [];

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close('the test ended');
});

function logger(lines: string[]): Logger {
  return { ...silentLogger, info: (line) => lines.push(line), warn: (line) => lines.push(line) };
}

function open(transport: FakeTransport, options: Partial<RelayConnectionOptions> = {}, lines: string[] = []): Promise<RelayConnection> {
  const marker = startMarker();
  return RelayConnection.open(transport, {
    logger: logger(lines),
    name: 'build-box',
    marker,
    startScript: relayStartScript(marker, ['docker', 'run', '--rm', '-i', 'image']),
    bundleLine: encodeBundle(BUNDLE),
    ...options,
  }).then((connection) => {
    connections.push(connection);
    return connection;
  });
}

/** Opens a connection whose relay runs `accept` for each stream. */
async function opened(accept: (stream: MuxStream) => void = () => {}, options: Partial<RelayConnectionOptions> = {}) {
  const transport = new FakeTransport();
  const lines: string[] = [];
  const opening = open(transport, options, lines);
  transport.print(`${transport.marker()}\n`);
  await settle();
  const relay = transport.startRelay(accept);
  const connection = await opening;
  return { transport, relay, connection, lines };
}

describe('RelayConnection.open', () => {
  it('writes the start script, ignores the text of the login, writes the bundle after the marker, and opens at the HELLO', async () => {
    const transport = new FakeTransport();
    const lines: string[] = [];
    let opened = false;
    const opening = open(transport, {}, lines).then((connection) => {
      opened = true;
      return connection;
    });
    const marker = transport.marker();
    expect(transport.text()).toBe(relayStartScript(marker, ['docker', 'run', '--rm', '-i', 'image']));
    // The login prints a greeting, the last line without a line feed; the marker comes in two pieces.
    transport.print(`Welcome to build-box\r\nno line feed${marker.slice(0, 10)}`);
    await settle();
    expect(transport.written).toHaveLength(1);
    transport.print(`${marker.slice(10)}\n`);
    await settle();
    expect(transport.text()).toBe(relayStartScript(marker, ['docker', 'run', '--rm', '-i', 'image']) + encodeBundle(BUNDLE));
    // Not open before the HELLO of the relay.
    expect(opened).toBe(false);
    transport.startRelay(() => {});
    const connection = await opening;
    expect(connection.isOpen).toBe(true);
    expect(lines).toEqual([
      `The login on build-box printed ${Buffer.byteLength('Welcome to build-box\r\nno line feed')} bytes before the start; they are ignored.`,
      'The connection to build-box is open.',
    ]);
  });

  it('takes frames that come in the same piece as the marker', async () => {
    const transport = new FakeTransport();
    const opening = open(transport);
    const marker = transport.marker();
    // The relay of the test sends its HELLO into the piece of the marker.
    const frames: Buffer[] = [];
    const relay = new Mux({ side: 'relay', link: { write: (frame) => frames.push(frame) > 0, onDrain: () => {}, end: () => {} }, accept: () => {} });
    await settle();
    transport.print(Buffer.concat([Buffer.from(`${marker}\n`), ...frames]));
    await expect(opening).resolves.toBeInstanceOf(RelayConnection);
    relay.close('the test ended');
  });

  it('rejects with the error output when the transport ends before the marker', async () => {
    const transport = new FakeTransport();
    const opening = open(transport);
    transport.printError('ssh: connect to host build-box port 22: Connection refused\r\n');
    transport.exit(255);
    await expect(opening).rejects.toThrow(new RelayConnectionError('The connection to build-box could not be opened: it ended (ssh: connect to host build-box port 22: Connection refused)'));
    expect(transport.inputEnded).toBe(true);
  });

  it('rejects when the output ends and the transport keeps running, before and after the marker', async () => {
    const before = new FakeTransport();
    const beforeOpening = open(before, { exitReasonWaitMs: 20 });
    before.printError('Welcome\n');
    before.endOutput();
    await expect(beforeOpening).rejects.toThrow(new RelayConnectionError('The connection to build-box could not be opened: its output ended (Welcome)'));
    expect(before.inputEnded).toBe(true);

    const after = new FakeTransport();
    const afterOpening = open(after, { exitReasonWaitMs: 20 });
    after.print(`${after.marker()}\n`);
    after.printError('docker: Error response from daemon: Conflict. The container name "/w-worker1" is already in use by container "abc".\n');
    after.endOutput();
    await expect(afterOpening).rejects.toThrow('could not be opened: its output ended (docker: Error response from daemon: Conflict. The container name "/w-worker1" is already in use by container "abc".)');
    expect(after.inputEnded).toBe(true);
  });

  it('rejects with the refusal of `docker run` after the marker, and with the exit code without error output', async () => {
    const transport = new FakeTransport();
    const opening = open(transport);
    transport.print(`${transport.marker()}\n`);
    transport.printError('docker: Error response from daemon: Conflict. The container name "/w-worker1" is already in use by container "abc".\n');
    transport.exit(125);
    await expect(opening).rejects.toThrow('could not be opened: it ended (docker: Error response from daemon: Conflict. The container name "/w-worker1" is already in use by container "abc".)');

    const silent = new FakeTransport();
    const silentOpening = open(silent);
    silent.exit(127);
    await expect(silentOpening).rejects.toThrow('could not be opened: it ended (exit code 127)');
  });

  it('rejects when the login prints too much before the marker, and stops the transport after its time', async () => {
    const transport = new FakeTransport();
    const opening = open(transport, { closeKillMs: 10 });
    transport.print('x'.repeat(MAX_OUTPUT_BEFORE_MARKER / 2));
    await settle();
    transport.print('x'.repeat(MAX_OUTPUT_BEFORE_MARKER));
    await expect(opening).rejects.toThrow('the login printed more than 64 KiB before the start');
    expect(transport.inputEnded).toBe(true);
    // What comes after the failure is not read: the marker writes no bundle.
    transport.print(`${transport.marker()}\n`);
    expect(transport.written).toHaveLength(1);
    await transport.exited;
    expect(transport.kills).toBe(1);
  });

  it('rejects without an answer in time', async () => {
    const transport = new FakeTransport();
    const opening = open(transport, { openTimeoutMs: 30 });
    transport.print(`${transport.marker()}\n`);
    await expect(opening).rejects.toThrow('could not be opened: no answer within 0.03 seconds');
    expect(transport.inputEnded).toBe(true);
  });

  it('rejects a relay that breaks the rules before its HELLO', async () => {
    const transport = new FakeTransport();
    const opening = open(transport);
    transport.print(`${transport.marker()}\n`);
    await settle();
    // A frame of an unknown kind.
    transport.print(Buffer.from([99, 0, 0, 0, 0, 0, 0, 0, 0]));
    await expect(opening).rejects.toThrow('could not be opened: the other side sent a frame of the unknown kind 99');
  });
});

describe('RelayConnection', () => {
  it('runs a worker stream as the program of a helper channel: text both ways, the error output, the exit', async () => {
    let workerStream: MuxStream | undefined;
    const received: Buffer[] = [];
    const { transport, connection } = await opened((stream) => {
      workerStream = stream;
      stream.onData((chunk) => {
        received.push(chunk);
        stream.consumed(chunk.length);
      });
    });
    const worker = connection.openWorker();
    const output: string[] = [];
    const errors: string[] = [];
    expect(worker.write('{"t":"hello"} äü\n')).toBe(true);
    await settle();
    expect(workerStream?.target).toBe('worker');
    expect(Buffer.concat(received).toString('utf8')).toBe('{"t":"hello"} äü\n');
    // Output before the listener waits for it; a character split between two frames is whole.
    const euro = Buffer.from('€', 'utf8');
    workerStream!.write(Buffer.concat([Buffer.from('first '), euro.subarray(0, 1)]));
    await settle();
    worker.onStdout((text) => output.push(text));
    worker.onStderr((text) => errors.push(text));
    workerStream!.write(Buffer.concat([euro.subarray(1), Buffer.from(' second\n')]));
    transport.printError('a line of the worker\n');
    workerStream!.exit({ code: 3, signal: null });
    await expect(worker.exited).resolves.toEqual({ exitCode: 3 });
    expect(output.join('')).toBe('first € second\n');
    expect(errors).toEqual(['a line of the worker\n']);
    // The connection stays open for another worker.
    expect(connection.isOpen).toBe(true);
  });

  it('closes the stream at kill, and the relay gets the reason', async () => {
    const closes: string[] = [];
    const { connection } = await opened((stream) => stream.onClose((reason) => closes.push(reason)));
    const worker = connection.openWorker();
    worker.kill();
    await expect(worker.exited).resolves.toEqual({ exitCode: null });
    await settle();
    expect(closes).toEqual(['stopped by the extension']);
    // Writes after the end are refused.
    expect(worker.write('late\n')).toBe(false);
  });

  it('ends: the workers end with the reason, the transport input ends, then it is stopped after its time', async () => {
    const { transport, connection } = await opened(() => {}, { closeKillMs: 10 });
    const worker = connection.openWorker();
    const reasons: string[] = [];
    connection.onClose((reason) => reasons.push(reason));
    connection.close('the window closed');
    await expect(worker.exited).resolves.toEqual({ exitCode: null, error: new Error('the window closed') });
    expect(reasons).toEqual(['the window closed']);
    expect(connection.isOpen).toBe(false);
    expect(transport.inputEnded).toBe(true);
    await transport.exited;
    expect(transport.kills).toBe(1);
    // A listener after the end is called at once; no new stream.
    connection.onClose((reason) => reasons.push(`late: ${reason}`));
    expect(reasons).toEqual(['the window closed', 'late: the window closed']);
    expect(() => connection.openWorker()).toThrow('The connection to build-box is closed (the window closed).');
  });

  it('ends when the transport ends, with its error output as the reason', async () => {
    const { transport, connection } = await opened();
    const worker = connection.openWorker();
    const reasons: string[] = [];
    connection.onClose((reason) => reasons.push(reason));
    transport.printError('Connection to build-box closed by remote host.\n');
    transport.exit(255);
    const reason = 'the connection ended (Connection to build-box closed by remote host.)';
    await expect(worker.exited).resolves.toEqual({ exitCode: null, error: new Error(reason) });
    await transport.exited;
    await settle();
    expect(reasons).toEqual([reason]);
    expect(connection.isOpen).toBe(false);
    expect(transport.kills).toBe(0);
  });

  it('stops the transport at once at killNow', async () => {
    const { transport, connection } = await opened();
    const worker = connection.openWorker();
    const reasons: string[] = [];
    connection.onClose((reason) => reasons.push(reason));
    worker.killNow!();
    expect(connection.isOpen).toBe(false);
    expect(reasons).toEqual(['stopped by the extension']);
    await expect(worker.exited).resolves.toEqual({ exitCode: null });
    expect(transport.killsNow).toBe(1);
    await transport.exited;
    await settle();
    expect(connection.isOpen).toBe(false);
  });
});
