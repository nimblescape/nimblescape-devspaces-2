// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The connection of the relay on the side of the extension (docs/architecture.md "The connection of the relay"). A
// transport program (`ssh … sh -s`) gets the start script first (startScript.ts). Its standard output up to the marker
// of the script is what the login printed (its size goes to the log, never its text); then the extension writes the
// bundle line for the pipe loader, and from then on both directions carry the frames of the streams (mux.ts). The
// connection is open once the HELLO of the relay came. The error output of the transport (the messages of `ssh`, the
// relay, and the worker) is kept as the reason of a failure, as the error output of the Docker CLI before. A stream to
// the target `worker` is the program of a helper channel (openWorker); a stream to the target `docker` is one
// connection of the Docker pipe of the window (openDocker, dockerPipe.ts). No `vscode`.
import { readableStderr } from '../loader/pipeLoader';
import { decodedOutput, type Logger, type StartedByteProcess, type StartedProcess } from '../ports';
import { Mux, type MuxStream } from './mux';

/** The longest time from the start of the transport to the HELLO of the relay: the login, the start, the bundle. */
export const RELAY_OPEN_TIMEOUT_MS = 120_000;
/** The most output of the login before the marker; more ends the start. */
export const MAX_OUTPUT_BEFORE_MARKER = 64 * 1024;
/** After the end of its input, the transport gets this long to end before it is stopped. */
export const RELAY_CLOSE_KILL_MS = 5_000;
/** The end of the error output that is kept for the reason of a failure. */
const STDERR_TAIL_LENGTH = 8 * 1024;
/**
 * After the end of the output of the transport, its end (with its error output and exit code as the reason) is awaited
 * this long. Then an open that did not get the HELLO fails with the error output so far, and an open connection ends.
 */
const EXIT_REASON_WAIT_MS = 1_000;

/** The connection could not be opened; the message says why (with the error output of the transport). */
export class RelayConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayConnectionError';
  }
}

export interface RelayConnectionOptions {
  logger: Logger;
  /** Named in the log lines and the messages, for example the host. */
  name: string;
  /** The marker that the start script prints (startMarker). */
  marker: string;
  /** The start script for `sh -s` (relayStartScript with `marker`). */
  startScript: string;
  /** The first line of the pipe loader of the relay: the bundle (dist/helperChannel.js) as bundleLine encodes it. */
  bundleLine: string;
  openTimeoutMs?: number;
  closeKillMs?: number;
  /** Only for the tests. */
  pingIntervalMs?: number;
  silenceMs?: number;
  exitReasonWaitMs?: number;
}

/** One open connection of the relay. Create it with RelayConnection.open. */
export class RelayConnection {
  private mux: Mux | undefined;
  private stderrTail = '';
  private readonly stderrListeners = new Set<(text: string) => void>();
  private readonly closeListeners = new Set<(reason: string) => void>();
  private closedReason: string | undefined;

  private constructor(
    private readonly process: StartedByteProcess,
    private readonly options: RelayConnectionOptions,
  ) {}

  /**
   * Starts the connection on `process` and resolves once the relay said HELLO. Rejects with RelayConnectionError, and
   * stops the process, when the transport or its output ends before, when the login prints more than
   * MAX_OUTPUT_BEFORE_MARKER before the marker, when the relay breaks the rules, and after `openTimeoutMs`.
   */
  static open(process: StartedByteProcess, options: RelayConnectionOptions): Promise<RelayConnection> {
    return new RelayConnection(process, options).start();
  }

  /** True until the connection ends. */
  get isOpen(): boolean {
    return this.closedReason === undefined;
  }

  /** `listener` is called once when the connection ends, with the reason. */
  onClose(listener: (reason: string) => void): () => void {
    if (this.closedReason !== undefined) {
      listener(this.closedReason);
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /**
   * A stream to the worker as the program of a helper channel (HelperChannel.open without its bundle line): the relay
   * starts the worker from the stored file. Its output is the output of the worker; its error output is the error
   * output of the connection (the relay, the worker, and the transport share it); its end is the EXIT of the worker,
   * or the close of the stream or of the connection. `kill` closes the stream, and the relay stops the worker.
   */
  openWorker(): StartedProcess {
    if (this.mux === undefined || this.closedReason !== undefined) throw new Error(`The connection to ${this.options.name} is closed.`);
    const stream = this.mux.open('worker');
    const stdout = decodedOutput();
    let settle: (result: { exitCode: number | null; error?: Error }) => void = () => {};
    const exited = new Promise<{ exitCode: number | null; error?: Error }>((resolve) => {
      let settled = false;
      settle = (result) => {
        if (settled) return;
        settled = true;
        stdout.end();
        resolve(result);
      };
    });
    stream.onData((chunk) => {
      stdout.push(chunk);
      stream.consumed(chunk.length);
    });
    stream.onExit((exit) => settle({ exitCode: exit.code }));
    stream.onClose((reason) => settle({ exitCode: null, error: new Error(reason) }));
    let stderrListener: ((text: string) => void) | undefined;
    return {
      write: (text) => {
        if (!stream.isOpen) return false;
        stream.write(Buffer.from(text, 'utf8'));
        return true;
      },
      end: () => stream.end(),
      kill: () => {
        stream.close('stopped by the extension');
        settle({ exitCode: null });
      },
      killNow: () => {
        settle({ exitCode: null });
        this.killNow();
      },
      onStdout: stdout.listen,
      onStderr: (listener) => {
        if (stderrListener) this.stderrListeners.delete(stderrListener);
        stderrListener = listener;
        this.stderrListeners.add(listener);
        void exited.then(() => this.stderrListeners.delete(listener));
      },
      exited,
    };
  }

  /**
   * A stream to the Docker socket of the container: one connection of the Docker pipe of the window (dockerPipe.ts).
   * Throws when the connection is closed or has MAX_STREAMS streams.
   */
  openDocker(): MuxStream {
    if (this.mux === undefined || this.closedReason !== undefined) throw new Error(`The connection to ${this.options.name} is closed.`);
    return this.mux.open('docker');
  }

  /** The streams that are open now: the worker and the Docker streams (RelayConnections closes an idle connection). */
  get streamCount(): number {
    return this.closedReason === undefined ? (this.mux?.streamCount ?? 0) : 0;
  }

  /** Ends the connection: every stream is lost, and the transport is stopped when it does not end by itself. */
  close(reason = 'closed by the extension'): void {
    this.shutdown(reason);
  }

  /** Ends the connection and stops the transport at once (the end of the extension host). */
  killNow(): void {
    if (this.process.killNow) this.process.killNow();
    else this.process.kill();
    this.shutdown('stopped by the extension');
  }

  /** The readable end of the error output of the transport (readableStderr), or empty. */
  private stderrReason(): string {
    return readableStderr(this.stderrTail, STDERR_TAIL_LENGTH);
  }

  private start(): Promise<RelayConnection> {
    const { process, options } = this;
    const { logger, name } = options;
    const timeoutMs = options.openTimeoutMs ?? RELAY_OPEN_TIMEOUT_MS;
    return new Promise<RelayConnection>((resolve, reject) => {
      let settled = false;
      const fail = (reason: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.shutdown(reason);
        reject(new RelayConnectionError(`The connection to ${name} could not be opened: ${reason}`));
      };
      const timer = setTimeout(() => fail(`no answer within ${timeoutMs / 1000} seconds`), timeoutMs);
      process.onStderr((text) => {
        this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_LENGTH);
        for (const listener of this.stderrListeners) listener(text);
      });
      const marker = Buffer.from(`${options.marker}\n`, 'utf8');
      // The output before the marker; undefined once the marker came.
      let before: Buffer | undefined = Buffer.alloc(0);
      process.onStdout(
        (chunk) => {
          // After a failed open, nothing more is kept or read.
          if (this.closedReason !== undefined) return;
          if (before === undefined) {
            this.mux?.input(chunk);
            return;
          }
          before = Buffer.concat([before, chunk]);
          // Also after text without a line feed (`printf Welcome` in a login script). The marker is random, so no
          // other output has it.
          const at = before.indexOf(marker);
          if (at < 0) {
            if (before.length > MAX_OUTPUT_BEFORE_MARKER + marker.length) fail(`the login printed more than ${MAX_OUTPUT_BEFORE_MARKER / 1024} KiB before the start`);
            return;
          }
          // Text of the login scripts of the host (for example a greeting); the relay never sees it.
          if (at > 0) logger.info(`The login on ${name} printed ${at} bytes before the start; they are ignored.`);
          const rest = before.subarray(at + marker.length);
          before = undefined;
          // The first line of the pipe loader, then the frames (the extension sends none before the HELLO of the relay).
          process.write(Buffer.from(options.bundleLine, 'utf8'));
          this.mux = new Mux({
            side: 'extension',
            link: {
              write: (frame) => process.write(frame),
              onDrain: (listener) => process.onDrain(listener),
              end: () => process.end(),
            },
            onHello: () => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              logger.info(`The connection to ${name} is open.`);
              resolve(this);
            },
            onClose: (reason) => {
              if (settled) this.shutdown(reason);
              else fail(reason);
            },
            pingIntervalMs: options.pingIntervalMs,
            silenceMs: options.silenceMs,
          });
          if (rest.length > 0) this.mux.input(rest);
        },
        // The end of the transport says why (its error output): the open fails, or the connection ends, with it when
        // the transport ends within EXIT_REASON_WAIT_MS (the handler of `exited` below). A transport that keeps running
        // after the end of its output (for example `ssh` that waits for a program of the session) fails the open then,
        // also with its error output, or ends the open connection.
        () => {
          const wait = setTimeout(() => {
            if (!settled) fail(`its output ended (${this.stderrReason() || 'no error output'})`);
            else this.mux?.inputEnded();
          }, options.exitReasonWaitMs ?? EXIT_REASON_WAIT_MS);
          wait.unref?.();
          void process.exited.then(() => clearTimeout(wait));
        },
      );
      void process.exited.then(({ exitCode, error }) => {
        const why = error ? error.message : this.stderrReason() || `exit code ${exitCode}`;
        if (!settled) fail(`it ended (${why})`);
        else this.shutdown(`the connection ended (${why})`);
      });
      process.write(Buffer.from(options.startScript, 'utf8'));
    });
  }

  private shutdown(reason: string): void {
    if (this.closedReason !== undefined) return;
    this.closedReason = reason;
    this.mux?.close(reason);
    this.process.end();
    const timer = setTimeout(() => this.process.kill(), this.options.closeKillMs ?? RELAY_CLOSE_KILL_MS);
    timer.unref?.();
    void this.process.exited.then(() => clearTimeout(timer));
    for (const listener of [...this.closeListeners]) listener(reason);
    this.closeListeners.clear();
  }
}
