// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The shell before the relay (docs/architecture.md "The shell before the relay"): the login of the transport of the
// relay (`ssh … sh -s`, transport.ts), opened for the checks before a connection of the relay (the SSH check, the
// engine, the runtime folder of a rootless engine, the helper image, the engine identity). They run as a line
// dialogue on that one login: each command is one line for `sh -s`, with its input as a here-document, followed by a
// marker with its exit code on the standard output and a marker on the error output. The connection of the relay then
// takes the login over (takeOver: RelayConnection.open writes its start script into the idle shell), so the open of a
// window logs in to the host once. A shell that no call used for SHELL_IDLE_CLOSE_MS is closed. No `vscode`.
import { randomBytes } from 'crypto';
import { errorMessage } from '../errors';
import { readableStderr } from '../loader/pipeLoader';
import { abortError, type Logger, type RunOptions, type RunResult, type StartedByteProcess } from '../ports';
import { MAX_OUTPUT_BEFORE_MARKER } from './connection';
import { shellWord } from './startScript';

/** The longest time from the start of the login to the answer of the shell (as SSH_TIMEOUT_MS of the SSH check). */
export const SHELL_LOGIN_TIMEOUT_MS = 30_000;
/** A shell that no call used for this long is closed (the next call logs in again). */
export const SHELL_IDLE_CLOSE_MS = 2 * 60_000;
/** The most output of one command on each stream; more ends the shell, and the call fails. */
export const MAX_SHELL_COMMAND_OUTPUT = 16 * 1024 * 1024;
/** After the end of its input, the shell gets this long to end before it is stopped. */
const SHELL_CLOSE_KILL_MS = 5_000;
/** The end of the error output of the login that is kept for the reason of a failure. */
const STDERR_TAIL_LENGTH = 8 * 1024;

/** The login of the shell failed; `detail` is the error output of `ssh`, `timedOut` when it did not answer in time. */
export class RemoteShellError extends Error {
  constructor(
    readonly detail: string,
    readonly timedOut = false,
  ) {
    super(detail);
    this.name = 'RemoteShellError';
  }
}

/** The shell ended or was taken over by the relay before a command started; the command did not run. */
export class ShellGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShellGoneError';
  }
}

/** A marker of the dialogue: `devspaces-<kind>-` and 32 hex digits, new for each use. */
function newMarker(kind: 'ready' | 'done'): string {
  return `devspaces-${kind}-${randomBytes(16).toString('hex')}`;
}

/**
 * The line of `command` for the shell: its standard input is `/dev/null`, or `input` as a here-document whose end is
 * `marker` (the text then ends with a line feed, which is added when it has none), and then the exit code after
 * `marker` on the standard output and `marker` alone on the error output, each on a line of its own. Throws for an
 * input with a NUL, or a command with a line break or a NUL.
 */
export function shellCommandLine(command: string, marker: string, input?: string): string {
  if (/[\0\r\n]/.test(command)) throw new Error('A command of the shell has a line break or a NUL.');
  const end = `printf '\\n%s %s\\n' ${marker} "$?"; printf '\\n%s\\n' ${marker} >&2`;
  if (input === undefined) return `${command} </dev/null; ${end}\n`;
  if (input.includes('\0')) throw new Error('The input of a command of the shell has a NUL.');
  return `${command} <<'${marker}'; ${end}\n${input}${input.endsWith('\n') || input === '' ? '' : '\n'}${marker}\n`;
}

/**
 * `docker <args>` as one command of the shell: each word in single quotes. Undefined for a word with a line break or a
 * NUL, which the line of the shell cannot carry.
 */
export function dockerShellCommand(args: readonly string[]): string | undefined {
  if (args.some((arg) => /[\0\r\n]/.test(arg))) return undefined;
  return ['docker', ...args].map(shellWord).join(' ');
}

export interface RemoteShellOptions {
  logger: Logger;
  /** Named in the log lines, for example the host. */
  name: string;
  loginTimeoutMs?: number;
  idleCloseMs?: number;
  /** Called once when the shell ends or is taken over. */
  onEnd?: () => void;
  /** Only for the tests. */
  closeKillMs?: number;
}

/** The command that runs now: its markers, its output so far, and how it ends. */
interface Running {
  marker: string;
  stdout: Buffer;
  stderr: string;
  exitCode?: number;
  /** Where the marker of the exit code starts in `stdout`, once it came without the end of its line. */
  endAt?: number;
  stderrDone: boolean;
  finish(result: RunResult): void;
}

/** One shell before the relay. Create it with RemoteShell.open. */
export class RemoteShell {
  /** The stage: the login, ready for a command, a command, taken over by the relay, or ended. */
  private stage: 'login' | 'ready' | 'running' | 'taken' | 'ended' = 'login';
  private queue: Promise<unknown> = Promise.resolve();
  private running: Running | undefined;
  private stderrTail = '';
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** After the takeover: the listeners of the connection of the relay, and what came before they listened. */
  private taken: {
    stdout?: (chunk: Buffer) => void;
    onEnd?: () => void;
    stderr?: (text: string) => void;
    heldStdout: Buffer[];
    heldStderr: string;
    stdoutEnded: boolean;
  } = { heldStdout: [], heldStderr: '', stdoutEnded: false };
  private onLogin: { stdout(chunk: Buffer): void; stderr(text: string): void; ended(): void } | undefined;

  private constructor(
    private readonly process: StartedByteProcess,
    private readonly options: RemoteShellOptions,
  ) {}

  /**
   * Starts the dialogue on `process` (`ssh … sh -s`) and resolves once the shell answered: it printed a new marker on
   * both outputs. What the login printed before is ignored (its size is logged, never its text). Rejects with
   * RemoteShellError, and stops the process, when it ends before, prints more than MAX_OUTPUT_BEFORE_MARKER before,
   * or does not answer within `loginTimeoutMs`; with an AbortError when `signal` aborts.
   */
  static open(process: StartedByteProcess, options: RemoteShellOptions, signal?: AbortSignal): Promise<RemoteShell> {
    return new RemoteShell(process, options).start(signal);
  }

  /** True while the shell takes commands (not ended, not taken over). */
  get isOpen(): boolean {
    return this.stage === 'ready' || this.stage === 'running';
  }

  private start(signal: AbortSignal | undefined): Promise<RemoteShell> {
    const { process, options } = this;
    process.onStdout(
      (chunk) => this.stdout(chunk),
      () => this.stdoutEnded(),
    );
    process.onStderr((text) => this.stderr(text));
    void process.exited.then(({ exitCode, error }) => this.exited(exitCode, error));
    return new Promise<RemoteShell>((resolve, reject) => {
      const marker = newMarker('ready');
      const line = Buffer.from(`${marker}\n`, 'utf8');
      let before = Buffer.alloc(0);
      let stdoutReady = false;
      let stderrBefore = '';
      let stderrReady = false;
      let settled = false;
      const timeoutMs = options.loginTimeoutMs ?? SHELL_LOGIN_TIMEOUT_MS;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.onLogin = undefined;
        if (error === undefined) {
          this.stage = 'ready';
          this.armIdle();
          resolve(this);
          return;
        }
        this.end();
        reject(error);
      };
      const fail = (detail: string, timedOut = false) => settle(new RemoteShellError(detail, timedOut));
      const timer = setTimeout(() => fail(`ssh did not answer within ${timeoutMs / 1000} seconds.`, true), timeoutMs);
      const onAbort = () => settle(abortError());
      if (signal?.aborted) {
        settle(abortError());
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      const check = () => {
        if (stdoutReady && stderrReady) settle();
      };
      this.onLogin = {
        stdout: (chunk) => {
          if (stdoutReady) return;
          before = Buffer.concat([before, chunk]);
          const at = before.indexOf(line);
          if (at < 0) {
            if (before.length > MAX_OUTPUT_BEFORE_MARKER + line.length) fail(`The login printed more than ${MAX_OUTPUT_BEFORE_MARKER / 1024} KiB before the shell answered.`);
            return;
          }
          // Text of the login scripts of the host (for example a greeting); no command sees it.
          if (at > 0) options.logger.info(`The login on ${options.name} printed ${at} bytes before the shell answered; they are ignored.`);
          stdoutReady = true;
          check();
        },
        stderr: (text) => {
          if (stderrReady) return;
          stderrBefore += text;
          if (!stderrBefore.includes(`${marker}\n`)) {
            if (stderrBefore.length > MAX_OUTPUT_BEFORE_MARKER + line.length) fail(`The login printed more than ${MAX_OUTPUT_BEFORE_MARKER / 1024} KiB of errors before the shell answered.`);
            return;
          }
          stderrReady = true;
          check();
        },
        ended: () => fail(this.stderrReason() || 'The login ended before the shell answered.'),
      };
      process.write(Buffer.from(`printf '%s\\n' ${marker}; printf '%s\\n' ${marker} >&2\n`, 'utf8'));
    });
  }

  /**
   * Runs `command` (one line for the shell, for example dockerShellCommand) after the commands before it, with `input`
   * as its standard input (else none), and resolves with its exit code and output as ProcessRunner.run does. After
   * `timeoutMs`, the shell is stopped and the result has `timedOut`; when `signal` aborts, the shell is stopped and the
   * call rejects with an AbortError. When the shell ends during the command (the connection broke), the result has
   * the exit code of `ssh` and its error output. Rejects with ShellGoneError when the shell ended or was taken over
   * before the command started, and with an Error for a command or input that the line cannot carry (shellCommandLine).
   */
  run(command: string, options: Pick<RunOptions, 'input' | 'timeoutMs' | 'signal'> = {}): Promise<RunResult> {
    const marker = newMarker('done');
    let line: string;
    try {
      line = shellCommandLine(command, marker, options.input);
    } catch (error) {
      return Promise.reject(error);
    }
    const call = this.queue.then(() => this.runNow(line, marker, options));
    this.queue = call.catch(() => undefined);
    return call;
  }

  private runNow(line: string, marker: string, options: Pick<RunOptions, 'timeoutMs' | 'signal'>): Promise<RunResult> {
    if (this.stage !== 'ready') return Promise.reject(new ShellGoneError(`The shell on ${this.options.name} is ${this.stage === 'taken' ? 'taken over by the relay' : 'closed'}.`));
    if (options.signal?.aborted) return Promise.reject(abortError());
    this.disarmIdle();
    this.stage = 'running';
    return new Promise<RunResult>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (outcome: { result: RunResult } | { error: Error }) => {
        if (this.running !== running) return;
        this.running = undefined;
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        if (this.stage === 'running') {
          this.stage = 'ready';
          this.armIdle();
        }
        if ('result' in outcome) resolve(outcome.result);
        else reject(outcome.error);
      };
      const running: Running = { marker, stdout: Buffer.alloc(0), stderr: '', stderrDone: false, finish: (result) => done({ result }) };
      const onAbort = () => {
        done({ error: abortError() });
        this.end();
      };
      this.running = running;
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          const { stdout, stderr } = running;
          done({ result: { exitCode: null, stdout: stdout.toString('utf8'), stderr, timedOut: true } });
          this.end();
        }, options.timeoutMs);
      }
      this.process.write(Buffer.from(line, 'utf8'));
    });
  }

  /**
   * The process of the shell for the connection of the relay (RelayConnection.open), after the commands before: from
   * now on, its output goes to the listeners of that connection, and the shell takes no command anymore. Undefined when
   * the shell ended. Its `kill` and `killNow` stop the shell.
   */
  takeOver(): Promise<StartedByteProcess | undefined> {
    const taking = this.queue.then(() => {
      if (this.stage !== 'ready') return undefined;
      this.disarmIdle();
      this.stage = 'taken';
      this.options.onEnd?.();
      return this.facade();
    });
    this.queue = taking.catch(() => undefined);
    return taking;
  }

  /** Ends the shell (its input), unless the relay took it over; a shell that does not end is stopped. */
  close(): void {
    if (this.stage === 'taken' || this.stage === 'ended') return;
    this.end();
  }

  /** Stops the shell at once (the window closes), also after the takeover. */
  killNow(): void {
    if (this.process.killNow) this.process.killNow();
    else this.process.kill();
    this.markEnded();
  }

  private facade(): StartedByteProcess {
    const { process, taken } = this;
    return {
      write: (chunk) => process.write(chunk),
      onDrain: (listener) => process.onDrain(listener),
      end: () => process.end(),
      kill: () => process.kill(),
      ...(process.killNow ? { killNow: () => process.killNow?.() } : {}),
      pid: process.pid,
      onStdout: (listener, onEnd) => {
        taken.stdout = listener;
        taken.onEnd = onEnd;
        for (const chunk of taken.heldStdout.splice(0)) listener(chunk);
        if (taken.stdoutEnded) onEnd();
      },
      pauseStdout: () => process.pauseStdout(),
      resumeStdout: () => process.resumeStdout(),
      onStderr: (listener) => {
        taken.stderr = listener;
        if (taken.heldStderr !== '') listener(taken.heldStderr);
        taken.heldStderr = '';
      },
      exited: process.exited,
    };
  }

  private stdout(chunk: Buffer): void {
    if (this.stage === 'login') return this.onLogin?.stdout(chunk);
    if (this.stage === 'taken') {
      if (this.taken.stdout) this.taken.stdout(chunk);
      else this.taken.heldStdout.push(chunk);
      return;
    }
    const running = this.running;
    // Output without a command (a program that a command left running), or after the exit code, is not read.
    if (running === undefined || running.exitCode !== undefined) return;
    const end = Buffer.from(`\n${running.marker} `, 'utf8');
    // The marker may start in the output before this chunk, or was found there without the end of its line.
    const from = running.endAt ?? Math.max(0, running.stdout.length - end.length);
    running.stdout = Buffer.concat([running.stdout, chunk]);
    const at = running.stdout.indexOf(end, from);
    if (at < 0) {
      if (running.stdout.length > MAX_SHELL_COMMAND_OUTPUT + end.length) this.tooMuch(running);
      return;
    }
    const lineEnd = running.stdout.indexOf(0x0a, at + end.length);
    if (lineEnd < 0) {
      // The rest of the exit code comes with the next chunk.
      running.endAt = at;
      return;
    }
    const code = Number(running.stdout.subarray(at + end.length, lineEnd).toString('utf8'));
    running.stdout = running.stdout.subarray(0, at);
    running.exitCode = Number.isInteger(code) ? code : 255;
    this.finishIfDone(running);
  }

  private stderr(text: string): void {
    this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_LENGTH);
    if (this.stage === 'login') return this.onLogin?.stderr(text);
    if (this.stage === 'taken') {
      if (this.taken.stderr) this.taken.stderr(text);
      else this.taken.heldStderr += text;
      return;
    }
    const running = this.running;
    if (running === undefined || running.stderrDone) return;
    running.stderr += text;
    const end = `\n${running.marker}\n`;
    const at = running.stderr.indexOf(end);
    if (at >= 0) {
      running.stderr = running.stderr.slice(0, at);
      running.stderrDone = true;
    } else if (running.stderr.length > MAX_SHELL_COMMAND_OUTPUT + end.length) {
      return this.tooMuch(running);
    }
    this.finishIfDone(running);
  }

  private finishIfDone(running: Running): void {
    if (running.exitCode === undefined || !running.stderrDone) return;
    running.finish({ exitCode: running.exitCode, stdout: running.stdout.toString('utf8'), stderr: running.stderr, timedOut: false });
  }

  private tooMuch(running: Running): void {
    running.finish({ exitCode: null, stdout: '', stderr: `The command printed more than ${MAX_SHELL_COMMAND_OUTPUT / 1024 / 1024} MiB on the shell of ${this.options.name}.`, timedOut: false });
    this.end();
  }

  private stdoutEnded(): void {
    if (this.stage === 'taken') {
      this.taken.stdoutEnded = true;
      this.taken.onEnd?.();
    }
  }

  private exited(exitCode: number | null, error: Error | undefined): void {
    if (this.stage === 'taken') return;
    if (this.stage === 'login') {
      if (error !== undefined) this.stderrTail = (this.stderrTail + error.message).slice(-STDERR_TAIL_LENGTH);
      this.onLogin?.ended();
      return;
    }
    const running = this.running;
    if (running !== undefined) {
      // The connection ended during the command: its error output so far, and the reason of `ssh`.
      const reason = error ? errorMessage(error) : '';
      running.finish({
        exitCode: exitCode ?? 255,
        stdout: running.stdout.toString('utf8'),
        stderr: [running.stderr.trim(), reason].filter((text) => text !== '').join('\n') || `The shell on ${this.options.name} ended.`,
        timedOut: false,
      });
    }
    this.markEnded();
  }

  /** The readable end of the error output of the login (readableStderr), or empty. */
  private stderrReason(): string {
    return readableStderr(this.stderrTail, STDERR_TAIL_LENGTH);
  }

  private armIdle(): void {
    this.disarmIdle();
    this.idleTimer = setTimeout(() => {
      this.options.logger.info(`The shell on ${this.options.name} was closed after a time without use.`);
      this.close();
    }, this.options.idleCloseMs ?? SHELL_IDLE_CLOSE_MS);
    this.idleTimer.unref?.();
  }

  private disarmIdle(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  /** Ends the input of the shell; the process is stopped when it does not end by itself. */
  private end(): void {
    const wasLogin = this.stage === 'login';
    this.markEnded();
    this.process.end();
    // A login that did not answer may wait for the network: it is stopped at once.
    if (wasLogin) this.process.kill();
    const timer = setTimeout(() => this.process.kill(), this.options.closeKillMs ?? SHELL_CLOSE_KILL_MS);
    timer.unref?.();
    void this.process.exited.then(() => clearTimeout(timer));
  }

  private markEnded(): void {
    if (this.stage === 'ended') return;
    const wasTaken = this.stage === 'taken';
    this.stage = 'ended';
    this.disarmIdle();
    if (!wasTaken) this.options.onEnd?.();
  }
}
