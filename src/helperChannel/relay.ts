// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The relay (docs/architecture.md "The relay"): the first program of the worker container, whose standard input and
// output carry the streams of src/core/relay/mux.ts. The pipe loader stores the worker's bundle and calls startRelay
// (RELAY_ENTRY) instead of startChannel. A stream to the target `worker` starts the worker as a process of its own,
// with the pipe loader and the same stored file, hash and environment, so the worker starts as it does without the
// relay; at most one worker runs at a time, and a worker stream that comes while one still ends waits for that end. A
// stream to the target `docker` is a connection to the Docker socket of the container. The relay ends when its input ends, after a frame that breaks the rules, after the silence of the
// connection, and at SIGTERM, SIGINT and SIGHUP: it closes every stream, ends the worker like the end of its input, and
// exits once the worker ended (with SIGKILL after RELAY_WORKER_STOP_MS). Loading the module starts nothing.
import * as childProcess from 'child_process';
import * as net from 'net';
import type { Readable, Writable } from 'stream';
import { CHANNEL_CLEANUP_TIMEOUT_MS, CHANNEL_ENTRY, CHANNEL_KILL_GRACE_MS } from '../core/helperChannel/protocol';
import { loaderCommand } from '../core/loader/pipeLoader';
import { HELPER_DOCKER_SOCKET } from '../core/names';
import { bridgeStream } from '../core/relay/bridge';
import type { WorkerExit } from '../core/relay/frames';
import { Mux, type FrameLink, type MuxStream } from '../core/relay/mux';

/**
 * How long the relay waits for the end of the worker before it stops it with SIGKILL and exits: the worker ends what
 * runs within its own time limits (fatalHandler of main.ts).
 */
export const RELAY_WORKER_STOP_MS = CHANNEL_KILL_GRACE_MS + CHANNEL_CLEANUP_TIMEOUT_MS + 10_000;
/** The relay exits this long after the SIGKILL of a worker that did not end, in case its end never shows. */
export const RELAY_EXIT_MARGIN_MS = 5_000;
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
  /** Exits with `code`; again with RELAY_FAILURE_EXIT_CODE when a failure comes while the exit waits for the output. */
  exit(code: number): void;
  pingIntervalMs?: number;
  silenceMs?: number;
  workerStopMs?: number;
}

/** The relay on the connection of `deps.link`: its input goes to `input` and `inputEnded`. */
export class Relay {
  private readonly mux: Mux;
  private worker: RelayWorker | undefined;
  /** The worker stream that waits for the end of the worker that runs (at most one). */
  private waiting: MuxStream | undefined;
  private stopping: { code: number; timer?: ReturnType<typeof setTimeout>; exited?: boolean } | undefined;

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
    if (this.worker === undefined) return this.startWorker(stream);
    // The extension opens the next worker of the connection while the last one still ends (its channel was closed or
    // lost): the stream waits for that end (at most RELAY_WORKER_STOP_MS after the stream of the last worker closed),
    // so that it needs no new connection; the extension limits its own wait for the answer of the worker. Its data
    // waits in the stream. A newer worker stream takes its place.
    this.waiting?.close('a newer worker stream came');
    this.waiting = stream;
    stream.onClose(() => {
      if (this.waiting === stream) this.waiting = undefined;
    });
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
    // Its end is EXIT, after all its output. A closed stream ends its input and stops it, with SIGKILL after
    // RELAY_WORKER_STOP_MS, so that a worker that does not end refuses the next worker stream only that long. A worker
    // that ended already (its EXIT waits behind its output) gets no signal.
    let ended = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    bridgeStream(stream, worker.stdout, worker.stdin, {
      pipeEndsStream: false,
      onClosed: () => {
        if (ended) return;
        worker.kill('SIGTERM');
        killTimer = setTimeout(() => worker.kill('SIGKILL'), this.deps.workerStopMs ?? RELAY_WORKER_STOP_MS);
      },
    });
    worker.onClosed((exit, error) => {
      ended = true;
      clearTimeout(killTimer);
      if (this.worker === worker) this.worker = undefined;
      if (error) stream.close(`the worker cannot be started: ${error.message}`);
      else stream.exit(exit);
      if (this.stopping) return this.exitNow();
      const next = this.waiting;
      this.waiting = undefined;
      if (next?.isOpen) this.startWorker(next);
    });
  }

  /**
   * Exits once the worker ended. `reason`: why, for the standard error (none for the end of the input). A failure
   * while it stops still changes the exit code.
   */
  private stop(reason: string | undefined, failed: boolean): void {
    if (this.stopping) {
      if (!failed) return;
      if (reason !== undefined) this.deps.log(`devspace relay: ${reason}`);
      if (this.stopping.code === RELAY_FAILURE_EXIT_CODE) return;
      this.stopping.code = RELAY_FAILURE_EXIT_CODE;
      if (this.stopping.exited) this.deps.exit(this.stopping.code);
      return;
    }
    this.stopping = { code: failed ? RELAY_FAILURE_EXIT_CODE : 0 };
    if (reason !== undefined) this.deps.log(`devspace relay: ${reason}`);
    // The mux lost every stream: the Docker connections are destroyed, and the worker's input ended; it got SIGTERM,
    // and SIGKILL follows after RELAY_WORKER_STOP_MS (startWorker). The relay exits when it ended.
    if (this.worker === undefined) return this.exitNow();
    this.stopping.timer = setTimeout(() => this.exitNow(), (this.deps.workerStopMs ?? RELAY_WORKER_STOP_MS) + RELAY_EXIT_MARGIN_MS);
  }

  private exitNow(): void {
    if (this.stopping === undefined || this.stopping.exited) return;
    clearTimeout(this.stopping.timer);
    this.stopping.exited = true;
    this.deps.exit(this.stopping.code);
  }
}

/**
 * A worker process of the pipe loader: the stored file `file` with `hash`, entry CHANNEL_ENTRY. Throws when it has no
 * pipes (Node.js creates none when the process has no free file descriptor; its error comes later).
 */
export function spawnLoaderWorker(file: string, hash: string): RelayWorker {
  const [, ...args] = loaderCommand({ path: file, hash, entry: CHANNEL_ENTRY });
  const child = childProcess.spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'inherit'] });
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
  if (!child.stdin || !child.stdout) {
    child.kill('SIGKILL');
    throw new Error('it got no pipes (too many open files)');
  }
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
 * An exit of the process once the frames that wait in the standard output went, within RELAY_EXIT_MARGIN_MS
 * (process.exit drops what waits in a pipe). A later call while it waits changes only the exit code.
 */
function exitAfterOutput(): (code: number) => void {
  let waiting = false;
  return (code) => {
    process.exitCode = code;
    if (waiting) return;
    waiting = true;
    const exit = () => process.exit();
    if (process.stdout.writableFinished || process.stdout.destroyed) return exit();
    setTimeout(exit, RELAY_EXIT_MARGIN_MS);
    process.stdout.once('finish', exit);
    process.stdout.once('close', exit);
    process.stdout.end();
  };
}

/**
 * The entry of the relay (RELAY_ENTRY) for the pipe loader, which hands the input over as bytes. The worker runs the
 * stored file of the loader with its hash (the command line of this process).
 */
export function startRelay(dockerSocket: string = HELPER_DOCKER_SOCKET): void {
  const [, file, hash] = process.argv;
  const fail = (reason: string) => {
    process.stderr.write(`devspace relay: ${reason}\n`);
    process.exit(RELAY_FAILURE_EXIT_CODE);
  };
  if (!file || !/^[0-9a-f]{64}$/.test(hash ?? '')) return fail('the command line names no stored file of the pipe loader');
  const relay = new Relay({
    link: {
      write: (chunk) => process.stdout.write(chunk),
      onDrain: (listener) => process.stdout.once('drain', listener),
      end: () => process.stdout.end(),
    },
    connectDocker: () => net.createConnection({ path: dockerSocket, allowHalfOpen: true }),
    spawnWorker: () => spawnLoaderWorker(file, hash),
    log: (line) => process.stderr.write(`${line}\n`),
    exit: exitAfterOutput(),
  });
  process.stdout.on('error', (error) => relay.shutdown(`the output cannot be written (${error.message})`, true));
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => relay.shutdown(`stopped by ${signal}`));
  // A defect of the relay never leaves the container running: a timer ends it in any case, and at once when the
  // shutdown itself fails (as fatalHandler of main.ts).
  const fatal = (error: unknown) => {
    setTimeout(() => process.exit(RELAY_FAILURE_EXIT_CODE), RELAY_WORKER_STOP_MS + RELAY_EXIT_MARGIN_MS);
    try {
      relay.shutdown(`an error of the relay: ${error instanceof Error ? error.message : String(error)}`, true);
    } catch {
      process.exit(RELAY_FAILURE_EXIT_CODE);
    }
  };
  process.on('uncaughtException', fatal);
  process.on('unhandledRejection', fatal);
  process.stdin.on('data', (chunk: Buffer) => relay.input(chunk));
  process.stdin.on('end', () => relay.inputEnded());
  process.stdin.on('close', () => relay.inputEnded());
  process.stdin.on('error', (error) => relay.shutdown(`the input cannot be read (${error.message})`, true));
  process.stdin.resume();
}
