// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The connection of the relay on the side of the extension (docs/architecture.md "The connection of the relay"). A
// transport program (`ssh … sh -s`) gets the start script first (startScript.ts). Its output up to the marker of the
// script is what the login printed (its size goes to the log, never its text); then the extension writes the bundle
// line for the pipe loader, and from then on both directions carry the frames of the streams (mux.ts). The connection
// is open once the HELLO of the relay came. A stream to the target `worker` is the program of a helper channel
// (openWorker). No `vscode`.
import { MAX_BUNDLE_LINE_LENGTH, encodeBundle, readableStderr } from '../loader/pipeLoader';
import type { Logger, StartedByteProcess, StartedProcess } from '../ports';
import { Mux } from './mux';

/** The longest time from the start of the transport to the HELLO of the relay: the login, the start, the bundle. */
export const RELAY_OPEN_TIMEOUT_MS = 120_000;
/** The most output of the login before the marker; more ends the start. */
export const MAX_OUTPUT_BEFORE_MARKER = 64 * 1024;
/** After the end of its input, the transport gets this long to end before it is stopped. */
export const RELAY_CLOSE_KILL_MS = 5_000;
/** The end of the error output that is kept for the reason of a failure. */
const STDERR_TAIL_LENGTH = 8 * 1024;

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
  /** The bundle (dist/helperChannel.js): the first line of the pipe loader of the relay. */
  bundle: string;
  openTimeoutMs?: number;
  closeKillMs?: number;
  /** Only for the tests. */
  pingIntervalMs?: number;
  silenceMs?: number;
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
   * stops the process, when the bundle is longer than the pipe loader takes, when the transport ends before, when the
   * login prints more than MAX_OUTPUT_BEFORE_MARKER before the marker, when the relay breaks the rules, and after
   * `openTimeoutMs`.
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
    const decoder = new TextDecoder('utf-8');
    let stdoutListener: ((text: string) => void) | undefined;
    let heldStdout = '';
    const deliver = (text: string) => {
      if (text === '') return;
      if (stdoutListener) stdoutListener(text);
      else heldStdout += text;
    };
    let settle: (result: { exitCode: number | null; error?: Error }) => void = () => {};
    const exited = new Promise<{ exitCode: number | null; error?: Error }>((resolve) => {
      let settled = false;
      settle = (result) => {
        if (settled) return;
        settled = true;
        deliver(decoder.decode());
        resolve(result);
      };
    });
    stream.onData((chunk) => {
      deliver(decoder.decode(chunk, { stream: true }));
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
        this.killNow();
        settle({ exitCode: null });
      },
      onStdout: (listener) => {
        stdoutListener = listener;
        const text = heldStdout;
        heldStdout = '';
        if (text !== '') listener(text);
      },
      onStderr: (listener) => {
        if (stderrListener) this.stderrListeners.delete(stderrListener);
        stderrListener = listener;
        this.stderrListeners.add(listener);
        void exited.then(() => this.stderrListeners.delete(listener));
      },
      exited,
    };
  }

  /** Ends the connection: every stream is lost, and the transport is stopped when it does not end by itself. */
  close(reason = 'closed by the extension'): void {
    this.shutdown(reason);
  }

  /** Stops the transport at once (the end of the extension host). */
  killNow(): void {
    if (this.process.killNow) this.process.killNow();
    else this.process.kill();
  }

  private start(): Promise<RelayConnection> {
    const { process, options } = this;
    const { logger, name } = options;
    const timeoutMs = options.openTimeoutMs ?? RELAY_OPEN_TIMEOUT_MS;
    // The loader limits the escaped line (the memory guard of the pipe loader), so the same is checked here.
    const bundleLine = encodeBundle(options.bundle);
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
          if (before === undefined) {
            this.mux?.input(chunk);
            return;
          }
          before = Buffer.concat([before, chunk]);
          const at = markerAt(before, marker);
          if (at < 0) {
            if (before.length > MAX_OUTPUT_BEFORE_MARKER + marker.length) fail(`the login printed more than ${MAX_OUTPUT_BEFORE_MARKER / 1024} KiB before the start`);
            return;
          }
          // Text of the login scripts of the host (for example a greeting); the relay never sees it.
          if (at > 0) logger.info(`The login on ${name} printed ${at} bytes before the start; they are ignored.`);
          const rest = before.subarray(at + marker.length);
          before = undefined;
          // The first line of the pipe loader, then the frames (the extension sends none before the HELLO of the relay).
          process.write(Buffer.from(bundleLine, 'utf8'));
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
        // Before the HELLO, the end of the transport says why (its error output).
        () => {
          if (settled) this.mux?.inputEnded();
        },
      );
      void process.exited.then(({ exitCode, error }) => {
        const why = error ? error.message : readableStderr(this.stderrTail, STDERR_TAIL_LENGTH) || `exit code ${exitCode}`;
        if (!settled) fail(`it ended (${why})`);
        else this.shutdown(`the connection ended (${why})`);
      });
      if (bundleLine.length - 1 > MAX_BUNDLE_LINE_LENGTH) return fail(`the bundle is too long (${bundleLine.length - 1} characters as JSON)`);
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

/** Where the line `marker` (with its line feed) starts in `output`: at its start or after a line feed; -1 when not. */
function markerAt(output: Buffer, marker: Buffer): number {
  for (let at = output.indexOf(marker); at >= 0; at = output.indexOf(marker, at + 1)) {
    if (at === 0 || output[at - 1] === 0x0a) return at;
  }
  return -1;
}
