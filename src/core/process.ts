// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { spawn, spawnSync, type ChildProcess } from 'child_process';
import * as path from 'path';
import { MAX_CAPTURED_OUTPUT_BYTES, MAX_CAPTURED_STDERR_CHARACTERS } from './helper/analysisLimits';
import { abortError, heldOutput, type ProcessRunner, type RunOptions, type RunResult, type StartOptions, type StartedByteProcess, type StartedProcess } from './ports';

/**
 * A program printed more than MAX_CAPTURED_OUTPUT_BYTES on its standard output. It was stopped,
 * and its run fails: an output cut at the limit is never used as a result.
 */
export class OutputTooLargeError extends Error {
  readonly code = 'EOUTPUTTOOLARGE';
  constructor(file: string, limitBytes: number) {
    super(`The output of ${file} is larger than ${Math.round(limitBytes / (1024 * 1024))} MB. It was stopped.`);
    this.name = 'OutputTooLargeError';
  }
}

/**
 * The programs of `start` that still run when this process exits (the extension host ends: VS Code does not end its
 * children, and no timer runs anymore) are ended synchronously by one exit handler.
 */
const runningStarted = new Set<() => void>();
let exitHookInstalled = false;
function killStartedOnExit(killNow: () => void): () => void {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', () => {
      for (const kill of [...runningStarted]) {
        try {
          kill();
        } catch {
          // The others still.
        }
      }
    });
  }
  runningStarted.add(killNow);
  return () => runningStarted.delete(killNow);
}

/** A program of `start` that did not end on `kill` gets SIGKILL after this time. */
export const START_KILL_GRACE_MS = 5_000;

/**
 * ProcessRunner with `child_process.spawn`, without a shell. At most `maxStdoutBytes` of standard output are kept;
 * beyond, the program is stopped and `run` rejects with OutputTooLargeError. Of the standard error output, only the
 * last `maxStderrCharacters` characters are kept (the program goes on; `onStderr` still gets all of it), so that an
 * endless log (for example of a lifecycle command of `devcontainer up`, which has no time limit) cannot fill the memory
 * of the extension host.
 */
export class NodeProcessRunner implements ProcessRunner {
  private readonly platform: NodeJS.Platform;
  private readonly killTree: (pid: number, fallback: () => void) => void;
  private readonly startKillGraceMs: number;
  private readonly killChildren: (pid: number, done: () => void) => void;

  constructor(
    private readonly maxStdoutBytes: number = MAX_CAPTURED_OUTPUT_BYTES,
    private readonly maxStderrCharacters: number = MAX_CAPTURED_STDERR_CHARACTERS,
    options: {
      platform?: NodeJS.Platform;
      killTree?: (pid: number, fallback: () => void) => void;
      startKillGraceMs?: number;
      killChildren?: (pid: number, done: () => void) => void;
    } = {},
  ) {
    this.killChildren = options.killChildren ?? runPkillChildren;
    this.platform = options.platform ?? process.platform;
    this.startKillGraceMs = options.startKillGraceMs ?? START_KILL_GRACE_MS;
    this.killTree = options.killTree ?? ((pid, fallback) => runTaskkill(pid, process.env, fallback));
  }

  /**
   * Stops `child` (time limit, abort, too much output). On Windows, the whole process tree
   * (`taskkill /T /F /PID <pid>`): docker.exe starts ssh.exe, which a kill of docker.exe alone leaves running. Elsewhere
   * the signal of `child.kill()`.
   */
  private stop(child: ChildProcess): void {
    if (this.platform === 'win32' && child.pid !== undefined) {
      try {
        this.killTree(child.pid, () => child.kill());
        return;
      } catch {
        // Below: at least the program itself.
      }
    }
    child.kill();
  }

  run(file: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(abortError());
        return;
      }
      const child = spawn(file, [...args], {
        env: options.env ?? process.env,
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      let tooLarge = false;
      let timedOut = false;
      let aborted = false;
      let settled = false;

      // The output is decoded with TextDecoder (streaming, so a character split between two chunks stays whole), not
      // with Readable.setEncoding: that uses Node's string_decoder module, which fails in the extension host of VS Code
      // 1.139 (Electron 43) with "StringDecoder is not a constructor", so that no program could be started at all.
      const stdoutDecoder = new TextDecoder('utf-8');
      const stderrDecoder = new TextDecoder('utf-8');
      const onStdout = (text: string) => {
        if (text === '') return;
        stdout += text;
        options.onStdout?.(text);
      };
      const onStderr = (text: string) => {
        if (text === '') return;
        stderr += text;
        // Cut to the limit only once it is twice as long: linear time, however small the chunks are.
        if (stderr.length > 2 * this.maxStderrCharacters) stderr = stderr.slice(-this.maxStderrCharacters);
        options.onStderr?.(text);
      };
      child.stdout.on('data', (chunk: Buffer) => {
        if (tooLarge) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > this.maxStdoutBytes) {
          tooLarge = true;
          stdout = '';
          this.stop(child);
          return;
        }
        onStdout(stdoutDecoder.decode(chunk, { stream: true }));
      });
      child.stderr.on('data', (chunk: Buffer) => onStderr(stderrDecoder.decode(chunk, { stream: true })));

      const timer =
        options.timeoutMs !== undefined
          ? setTimeout(() => {
              timedOut = true;
              this.stop(child);
            }, options.timeoutMs)
          : undefined;
      const onAbort = () => {
        aborted = true;
        this.stop(child);
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });

      const finish = () => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };

      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        finish();
        reject(error);
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        finish();
        if (aborted) {
          reject(abortError());
          return;
        }
        if (tooLarge) {
          reject(new OutputTooLargeError(file, this.maxStdoutBytes));
          return;
        }
        // The rest of an incomplete character at the end of the output.
        onStdout(stdoutDecoder.decode());
        onStderr(stderrDecoder.decode());
        if (stderr.length > this.maxStderrCharacters) stderr = stderr.slice(-this.maxStderrCharacters);
        resolve({ exitCode: code, stdout, stderr, timedOut });
      });

      // Ignore EPIPE when the process ends before it reads its input.
      child.stdin.on('error', () => {});
      if (options.input !== undefined) child.stdin.end(options.input);
      else child.stdin.end();
    });
  }

  /**
   * The helper channel: a program whose standard input stays open. Its output goes to the
   * listeners as it comes, without a limit (the channel checks the length of its lines). `kill` stops it as `run` does
   * after a time limit (on Windows the process tree: docker.exe starts ssh.exe).
   */
  start(file: string, args: readonly string[], options: StartOptions = {}): StartedProcess {
    const stdoutDecoder = new TextDecoder('utf-8');
    const stderrDecoder = new TextDecoder('utf-8');
    const stdout = heldOutput<string>();
    const stderr = heldOutput<string>();
    const deliver = (output: ReturnType<typeof heldOutput<string>>, text: string) => {
      if (text !== '') output.deliver(text);
    };
    const started = this.spawnStarted(file, args, options, () => {
      // The rest of an incomplete character at the end of the output.
      deliver(stdout, stdoutDecoder.decode());
      deliver(stderr, stderrDecoder.decode());
    });
    const { child } = started;
    child.stdout.on('data', (chunk: Buffer) => deliver(stdout, stdoutDecoder.decode(chunk, { stream: true })));
    child.stderr.on('data', (chunk: Buffer) => deliver(stderr, stderrDecoder.decode(chunk, { stream: true })));
    return {
      killNow: started.killNow,
      write: (text) => {
        if (started.ended() || child.stdin.destroyed || !child.stdin.writable) return false;
        child.stdin.write(text);
        return true;
      },
      end: () => {
        if (!child.stdin.destroyed) child.stdin.end();
      },
      kill: started.kill,
      onStdout: stdout.listen,
      onStderr: stderr.listen,
      exited: started.exited,
      pid: child.pid,
    };
  }

  /**
   * A program whose standard input and output are bytes with their flow (the connection of the relay: `ssh … sh -s`).
   * Stopped as `start` does.
   */
  startBytes(file: string, args: readonly string[], options: StartOptions = {}): StartedByteProcess {
    const stderrDecoder = new TextDecoder('utf-8');
    // `null`: the end of the output.
    const stdout = heldOutput<Buffer | null>();
    const stderr = heldOutput<string>();
    const deliverStderr = (text: string) => {
      if (text !== '') stderr.deliver(text);
    };
    const started = this.spawnStarted(file, args, options, () => deliverStderr(stderrDecoder.decode()));
    const { child } = started;
    child.stdout.on('data', (chunk: Buffer) => stdout.deliver(chunk));
    child.stdout.on('end', () => stdout.deliver(null));
    child.stderr.on('data', (chunk: Buffer) => deliverStderr(stderrDecoder.decode(chunk, { stream: true })));
    return {
      killNow: started.killNow,
      write: (chunk) => {
        if (started.ended() || child.stdin.destroyed || !child.stdin.writable) return true;
        return child.stdin.write(chunk);
      },
      onDrain: (listener) => {
        child.stdin.once('drain', listener);
      },
      end: () => {
        if (!child.stdin.destroyed) child.stdin.end();
      },
      kill: started.kill,
      onStdout: (listener, onEnd) => stdout.listen((chunk) => (chunk === null ? onEnd() : listener(chunk))),
      onStderr: stderr.listen,
      exited: started.exited,
      pid: child.pid,
    };
  }

  /**
   * The process of `start` and `startBytes`: its end (`exited`, after `beforeExit` delivered the rest of its output), and
   * its stop. `kill` stops it (on Windows with its tree), and SIGKILL follows after START_KILL_GRACE_MS; `killNow` stops
   * it and the programs that it started at once, also when the extension host exits.
   */
  private spawnStarted(file: string, args: readonly string[], options: StartOptions, beforeExit: () => void) {
    const child = spawn(file, [...args], {
      env: options.env ?? process.env,
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // EPIPE after the program ended; `exited` reports the end.
    child.stdin.on('error', () => {});
    let ended = false;
    const exited = new Promise<{ exitCode: number | null; error?: Error }>((resolve) => {
      child.on('error', (error) => {
        if (ended) return;
        ended = true;
        resolve({ exitCode: null, error });
      });
      child.on('close', (code) => {
        if (ended) return;
        ended = true;
        beforeExit();
        resolve({ exitCode: code });
      });
    });
    // Synchronous, for the end of the extension host: the programs that it started first (pkill -P; Windows: taskkill
    // /T /F of the tree), then it.
    const killNow = () => {
      if (ended || child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
      try {
        if (this.platform === 'win32') {
          const { file, args } = windowsTreeKillCommand(child.pid, process.env);
          spawnSync(file, args, { shell: false, windowsHide: true, stdio: 'ignore', timeout: 2_000 });
        } else {
          spawnSync('pkill', ['-KILL', '-P', String(child.pid)], { shell: false, stdio: 'ignore', timeout: 2_000 });
        }
      } catch {
        // SIGKILL below still.
      }
      child.kill('SIGKILL');
    };
    const forget = killStartedOnExit(killNow);
    void exited.then(forget);
    const kill = () => {
      if (ended) return;
      this.stop(child);
      // `docker run -i` passes SIGTERM on to its container over its connection and waits; over a hung connection it
      // would never end. So SIGKILL after START_KILL_GRACE_MS (Windows: taskkill /F ended it).
      const timer = setTimeout(() => {
        // `exitCode`/`signalCode` are set on 'exit', which can come well before 'close' (a program that still holds
        // its pipes); after it, the pid may belong to another program already.
        if (ended || child.exitCode !== null || child.signalCode !== null) return;
        // First the programs that it started (the Docker CLI starts `ssh` in a session of its own, which no signal to
        // docker reaches; on Linux it would die with it, on macOS it would stay), then docker. Only after pkill ended
        // (at most 1 s): a docker killed before would leave its children to process 1, where `pkill -P` does not find
        // them.
        const killDocker = () => {
          if (!ended) child.kill('SIGKILL');
        };
        if (this.platform === 'win32' || child.pid === undefined) {
          killDocker();
          return;
        }
        const fallback = setTimeout(killDocker, 1_000);
        fallback.unref?.();
        this.killChildren(child.pid, () => {
          clearTimeout(fallback);
          killDocker();
        });
      }, this.startKillGraceMs);
      timer.unref?.();
    };
    return { child, exited, killNow, kill, ended: () => ended };
  }
}

/**
 * The command that ends the process `pid` and all processes that it started, on Windows: `taskkill /T /F /PID <pid>`
 * (taskkill of Windows: /T the tree, /F by force), from the System32 folder of Windows (SystemRoot), never through a
 * shell or a PATH lookup.
 */
export function windowsTreeKillCommand(pid: number, env: NodeJS.ProcessEnv): { file: string; args: string[] } {
  const root = Object.keys(env).find((key) => key.toUpperCase() === 'SYSTEMROOT');
  const systemRoot = (root !== undefined ? env[root] : undefined) || 'C:\\Windows';
  return { file: path.win32.join(systemRoot, 'System32', 'taskkill.exe'), args: ['/T', '/F', '/PID', String(Math.trunc(pid))] };
}

/**
 * SIGKILL to the programs that `pid` started (`pkill -KILL -P <pid>`, macOS and Linux), never
 * through a shell. A failure changes nothing (the program ended already, or pkill is missing).
 */
function runPkillChildren(pid: number, done: () => void): void {
  const killer = spawn('pkill', ['-KILL', '-P', String(Math.trunc(pid))], { shell: false, stdio: 'ignore' });
  killer.on('error', done);
  killer.on('close', done);
}

function runTaskkill(pid: number, env: NodeJS.ProcessEnv, fallback: () => void): void {
  const { file, args } = windowsTreeKillCommand(pid, env);
  const killer = spawn(file, args, { shell: false, windowsHide: true, stdio: 'ignore' });
  // taskkill could not be started: at least the program itself. A taskkill that fails (for example because the process
  // ended already) changes nothing.
  killer.on('error', fallback);
}
