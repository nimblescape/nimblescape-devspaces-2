// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The shells before the relay of this window (docs/architecture.md "The shell before the relay"): at most one per SSH
// host, opened by the first check or Docker call before a connection of the relay to the host, used by the calls after
// it, and taken over by the next connection of the relay to the host (takeOver). No `vscode`.
import { abortError, isAbortError, type Logger, type RunOptions, type RunResult, type StartedByteProcess } from '../ports';
import { currentSshPromptFlow, type SshLoginPrompts } from '../sshAskpass';
import { RemoteShell, RemoteShellError, ShellGoneError, dockerShellCommand } from './remoteShell';

/** A login that started: its process, and the questions it may ask in VS Code (a login of a flow of the user). */
export interface RemoteShellStart {
  process: StartedByteProcess;
  prompts?: SshLoginPrompts;
}

export interface RemoteShellsOptions {
  logger: Logger;
  /** Starts the login `ssh … sh -s` to `host` (sshRelayTransport); undefined when the host has no transport. */
  start(host: string): RemoteShellStart | undefined;
  /** Only for the tests. */
  loginTimeoutMs?: number;
  idleCloseMs?: number;
}

/** A shell of `RemoteShells`: open, or still logging in on `process`. */
interface Entry {
  process: StartedByteProcess;
  /** The flow of the user that started this login (currentSshPromptFlow), or none (the background). */
  flow?: object;
  shell?: RemoteShell;
  opening?: Promise<RemoteShell>;
}

/** `promise`, or an AbortError as soon as `signal` aborts; the work of `promise` goes on for its other callers. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** The shells before the relay of this window, by the Docker host (DockerTarget.host). */
export class RemoteShells {
  private readonly entries = new Map<string, Entry>();
  private disposed = false;

  constructor(private readonly options: RemoteShellsOptions) {}

  /**
   * The open shell to `host`, or a new one (one SSH login, RemoteShell.open), which callers at the same time share.
   * Undefined when the host has no transport, and after `dispose`. Rejects with RemoteShellError when the login failed,
   * and with an AbortError when `signal` aborts (the login goes on for the others). A flow of the user whose login may
   * ask (currentSshPromptFlow) that finds a login of the background or of another flow in progress waits for it, and
   * logs in anew when it failed: a login without questions fails for a host that needs a password or an unknown host
   * key, and the Cancel of the other flow ends the questions of its login. After the time limit of the login of another
   * flow, which could ask, it does not log in anew.
   */
  open(host: string, signal?: AbortSignal): Promise<RemoteShell | undefined> {
    if (this.disposed) return Promise.resolve(undefined);
    const current = this.entries.get(host);
    if (current?.shell?.isOpen) return Promise.resolve(current.shell);
    if (current?.opening) {
      const flow = currentSshPromptFlow();
      if (flow === undefined || current.flow === flow) return untilAborted(current.opening, signal);
      return untilAborted(
        current.opening.catch((error: unknown) => {
          if (!(error instanceof RemoteShellError) || (error.timedOut && current.flow !== undefined) || signal?.aborted) throw error;
          return this.open(host, signal);
        }),
        signal,
      );
    }
    const started = this.options.start(host);
    if (started === undefined) return Promise.resolve(undefined);
    const { process, prompts } = started;
    const entry: Entry = { process, flow: currentSshPromptFlow() };
    const forget = () => {
      if (this.entries.get(host) === entry) this.entries.delete(host);
    };
    const { logger, loginTimeoutMs, idleCloseMs } = this.options;
    entry.opening = RemoteShell.open(process, { logger, name: host, loginTimeoutMs, idleCloseMs, onEnd: forget, prompts }).then(
      (shell) => {
        entry.shell = shell;
        entry.opening = undefined;
        if (this.disposed) shell.killNow();
        else logger.info(`The shell on ${host} is open: one SSH login for the checks before the relay.`);
        return shell;
      },
      (error: unknown) => {
        forget();
        throw error;
      },
    );
    this.entries.set(host, entry);
    return untilAborted(entry.opening, signal);
  }

  /**
   * The login of the shell to `host` (`open`), for the SSH check (RemoteShellAccess.login): undefined when the host has
   * no transport; a failure with the error output of `ssh`. Rejects only with an AbortError.
   */
  async login(host: string, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; detail: string; timedOut: boolean } | undefined> {
    try {
      return (await this.open(host, signal)) === undefined ? undefined : { ok: true };
    } catch (error) {
      if (error instanceof RemoteShellError) return { ok: false, detail: error.detail, timedOut: error.timedOut };
      throw error;
    }
  }

  /**
   * Runs `command` (one line for the shell) on the shell of `host` (`open`): its result as ProcessRunner.run gives it
   * (RemoteShell.run). A shell that was closed or taken over before the command started is replaced by a new one, once.
   * Undefined when the host has no transport, and after `dispose`. A failed login gives the result of `ssh`: exit code
   * 255 (none after its time limit) and its error output. Rejects with an AbortError when `options.signal` aborts.
   */
  async run(host: string, command: string, options: Pick<RunOptions, 'input' | 'timeoutMs' | 'signal'> = {}): Promise<RunResult | undefined> {
    for (let attempt = 0; ; attempt++) {
      let shell: RemoteShell | undefined;
      try {
        shell = await this.open(host, options.signal);
      } catch (error) {
        if (!(error instanceof RemoteShellError)) throw error;
        return { exitCode: error.timedOut ? null : 255, stdout: '', stderr: error.detail, timedOut: error.timedOut };
      }
      if (shell === undefined) return undefined;
      try {
        return await shell.run(command, options);
      } catch (error) {
        if (!(error instanceof ShellGoneError) || attempt > 0 || isAbortError(error)) throw error;
      }
    }
  }

  /**
   * `docker <args>` on the shell of `host` (`run` with dockerShellCommand), with the Docker CLI of that computer.
   * Undefined also for a word that the line of the shell cannot carry.
   */
  docker(host: string, args: readonly string[], options: Pick<RunOptions, 'timeoutMs' | 'signal'> = {}): Promise<RunResult | undefined> {
    const command = dockerShellCommand(args);
    return command === undefined ? Promise.resolve(undefined) : this.run(host, command, options);
  }

  /**
   * The process of the shell to `host` for a connection of the relay (RemoteShell.takeOver), also of a login that is
   * in progress; undefined when there is none or it failed. The shell is no longer one of this window then.
   */
  async takeOver(host: string): Promise<StartedByteProcess | undefined> {
    const entry = this.entries.get(host);
    if (entry === undefined) return undefined;
    let shell: RemoteShell | undefined;
    try {
      shell = entry.shell ?? (await entry.opening);
    } catch {
      return undefined;
    }
    return shell?.takeOver();
  }

  /** Stops every shell at once (the window closes), also a login in progress. */
  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) {
      if (entry.shell) entry.shell.killNow();
      else if (entry.process.killNow) entry.process.killNow();
      else entry.process.kill();
    }
    this.entries.clear();
  }
}
