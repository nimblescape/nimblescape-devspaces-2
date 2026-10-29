// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The relay (docs/architecture.md "The relay"): the first program of the worker container, whose standard input and
// output carry the streams of src/core/relay/mux.ts. The pipe loader stores the worker's bundle and calls startRelay
// (RELAY_ENTRY) instead of startChannel. A stream to the target `worker` starts the worker as a process of its own,
// with the pipe loader and the same stored file, hash and environment, so the worker starts as it does without the
// relay; at most one worker runs at a time. A stream to the target `docker` is a connection to the Docker socket of the
// container. The relay ends when its input ends, after a frame that breaks the rules, after the silence of the
// connection, and at SIGTERM, SIGINT and SIGHUP: it closes every stream, ends the worker like the end of its input, and
// exits once the worker ended (with SIGKILL after RELAY_WORKER_STOP_MS). Loading the module starts nothing.
import * as childProcess from 'child_process';
import * as net from 'net';
import type { Readable, Writable } from 'stream';
import { CHANNEL_CLEANUP_TIMEOUT_MS, CHANNEL_ENTRY, CHANNEL_KILL_GRACE_MS } from '../core/helperChannel/protocol';
import { PIPE_LOADER } from '../core/loader/pipeLoader';
import { HELPER_DOCKER_SOCKET } from '../core/names';
import { bridgeStream } from '../core/relay/bridge';
import type { WorkerExit } from '../core/relay/frames';
import { Mux, type FrameLink, type MuxStream } from '../core/relay/mux';

/**
 * How long the relay waits for the end of the worker before it stops it with SIGKILL and exits: the worker ends what
 * runs within its own time limits (fatalHandler of main.ts).
 */
export const RELAY_WORKER_STOP_MS = CHANNEL_KILL_GRACE_MS + CHANNEL_CLEANUP_TIMEOUT_MS + 10_000;
/** The exit code of the relay when the connection broke the rules or went silent, or its start failed. */
export const RELAY_FAILURE_EXIT_CODE = 1;

/** The process of a worker. */
export interface RelayWorker {
  readonly stdin: Writable;
  readonly stdout: Readable;
  kill(signal: NodeJS.Signals): void;
  /** Once: the process ended and its output closed, or it could not be started (`error`). */
  onClosed(listener: (exit: WorkerExit, error?: Error) => void): void;
}

export interface RelayDeps {
  /** The standard output of the relay. */
  link: FrameLink;
  /** A new connection to the Docker socket (half-open allowed). */
  connectDocker(): net.Socket;
  spawnWorker(): RelayWorker;
  /** One line of the standard error. */
  log(line: string): void;
  exit(code: number): void;
  pingIntervalMs?: number;
  silenceMs?: number;
  workerStopMs?: number;
}

/** The relay on the connection of `deps.link`: its input goes to `input` and `inputEnded`. */
export class Relay {
  private readonly mux: Mux;
  private worker: RelayWorker | undefined;
  private stopping: { code: number; timer?: ReturnType<typeof setTimeout> } | undefined;

  constructor(private readonly deps: RelayDeps) {
    this.mux = new Mux({
      side: 'relay',
      link: deps.link,
      accept: (stream) => this.accept(stream),
      onClose: (reason, failed) => this.stop(failed ? reason : undefined, failed),
      pingIntervalMs: deps.pingIntervalMs,
      silenceMs: deps.silenceMs,
    });
  }

  input(chunk: Buffer): void {
    this.mux.input(chunk);
  }

  inputEnded(): void {
    this.mux.inputEnded();
  }

  /**
   * Ends the relay from this side (a signal, the output is gone, an error of the relay): `reason` goes to the standard
   * error; `failed`: the exit code is RELAY_FAILURE_EXIT_CODE.
   */
  shutdown(reason: string, failed = false): void {
    this.mux.close(reason);
    this.stop(reason, failed);
  }

  private accept(stream: MuxStream): void {
    if (stream.target === 'docker') return this.connect(stream);
    if (this.worker !== undefined) return stream.close('a worker runs already');
    this.startWorker(stream);
  }

  private connect(stream: MuxStream): void {
    let socket: net.Socket;
    try {
      socket = this.deps.connectDocker();
    } catch (error) {
      return stream.close(`the Docker socket cannot be reached: ${(error as Error).message}`);
    }
    bridgeStream(stream, socket, socket);
  }

  private startWorker(stream: MuxStream): void {
    let worker: RelayWorker;
    try {
      worker = this.deps.spawnWorker();
    } catch (error) {
      return stream.close(`the worker cannot be started: ${(error as Error).message}`);
    }
    this.worker = worker;
    // Its end is EXIT, after all its output; a closed stream ends its input and stops it.
    bridgeStream(stream, worker.stdout, worker.stdin, { pipeEndsStream: false, onClosed: () => worker.kill('SIGTERM') });
    worker.onClosed((exit, error) => {
      if (this.worker === worker) this.worker = undefined;
      if (error) stream.close(`the worker cannot be started: ${error.message}`);
      else stream.exit(exit);
      if (this.stopping) this.exitNow();
    });
  }

  /** Exits once the worker ended. `reason`: why, for the standard error (none for the end of the input). */
  private stop(reason: string | undefined, failed: boolean): void {
    if (this.stopping) return;
    this.stopping = { code: failed ? RELAY_FAILURE_EXIT_CODE : 0 };
    if (reason !== undefined) this.deps.log(`devspace relay: ${reason}`);
    // The mux lost every stream: the Docker connections are destroyed, the worker's input ended and it got SIGTERM.
    const worker = this.worker;
    if (worker === undefined) return this.exitNow();
    this.stopping.timer = setTimeout(() => {
      worker.kill('SIGKILL');
      this.exitNow();
    }, this.deps.workerStopMs ?? RELAY_WORKER_STOP_MS);
  }

  private exitNow(): void {
    if (this.stopping === undefined) return;
    clearTimeout(this.stopping.timer);
    this.deps.exit(this.stopping.code);
  }
}

/** A worker process of the pipe loader: the stored file `file` with `hash`, entry CHANNEL_ENTRY. */
export function spawnLoaderWorker(file: string, hash: string): RelayWorker {
  const child = childProcess.spawn(process.execPath, ['-e', PIPE_LOADER, file, hash, CHANNEL_ENTRY], { stdio: ['pipe', 'pipe', 'inherit'] });
  let listener: ((exit: WorkerExit, error?: Error) => void) | undefined;
  let result: [WorkerExit, Error?] | undefined;
  const settle = (exit: WorkerExit, error?: Error) => {
    if (result !== undefined) return;
    result = [exit, error];
    listener?.(exit, error);
  };
  child.on('error', (error) => {
    // An error after the start (a failed kill) is no end of the process.
    if (child.pid === undefined) settle({ code: null, signal: null }, error);
  });
  child.once('close', (code, signal) => settle({ code, signal }));
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    kill: (signal) => {
      child.kill(signal);
    },
    onClosed: (next) => {
      listener = next;
      if (result !== undefined) next(...result);
    },
  };
}

/**
 * The entry of the relay (RELAY_ENTRY) for the pipe loader: `initial` is the input that the loader read together with
 * the bundle line, decoded as UTF-8, which must be empty (the extension writes nothing more before the HELLO of the
 * relay). The relay reads its input as bytes: the loader set it to UTF-8, which `latin1` replaces here, before any
 * later read (one character per byte, so no byte is changed). The worker runs the stored file of the loader with its
 * hash (the command line of this process).
 */
export function startRelay(initial: string, dockerSocket: string = HELPER_DOCKER_SOCKET): void {
  const [, file, hash] = process.argv;
  const fail = (reason: string) => {
    process.stderr.write(`devspace relay: ${reason}\n`);
    process.exit(RELAY_FAILURE_EXIT_CODE);
  };
  if (initial !== '') return fail('input came before the hello of the relay');
  if (!file || !/^[0-9a-f]{64}$/.test(hash ?? '')) return fail('the command line names no stored file of the pipe loader');
  process.stdin.setEncoding('latin1');
  const relay = new Relay({
    link: {
      write: (chunk) => process.stdout.write(chunk),
      onDrain: (listener) => process.stdout.once('drain', listener),
      end: () => process.stdout.end(),
    },
    connectDocker: () => net.createConnection({ path: dockerSocket, allowHalfOpen: true }),
    spawnWorker: () => spawnLoaderWorker(file, hash),
    log: (line) => process.stderr.write(`${line}\n`),
    exit: (code) => process.exit(code),
  });
  process.stdout.on('error', (error) => relay.shutdown(`the output cannot be written (${error.message})`));
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => relay.shutdown(`stopped by ${signal}`));
  // A defect of the relay never leaves the container running: a timer ends it in any case, and at once when the
  // shutdown itself fails (as fatalHandler of main.ts).
  const fatal = (error: unknown) => {
    setTimeout(() => process.exit(RELAY_FAILURE_EXIT_CODE), RELAY_WORKER_STOP_MS + 5_000);
    try {
      relay.shutdown(`an error of the relay: ${error instanceof Error ? error.message : String(error)}`, true);
    } catch {
      process.exit(RELAY_FAILURE_EXIT_CODE);
    }
  };
  process.on('uncaughtException', fatal);
  process.on('unhandledRejection', fatal);
  process.stdin.on('data', (chunk: string) => relay.input(Buffer.from(chunk, 'latin1')));
  process.stdin.on('end', () => relay.inputEnded());
  process.stdin.on('close', () => relay.inputEnded());
  process.stdin.on('error', (error) => relay.shutdown(`the input cannot be read (${error.message})`, true));
  process.stdin.resume();
}
