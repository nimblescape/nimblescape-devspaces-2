// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The lifetime of a WSL distribution that is a Docker host of Devspaces (docs/architecture.md "The WSL distribution of
// Devspaces"). WSL stops a distribution 15 seconds after the last `wsl.exe` process for it ended, with Docker and the
// containers in it. From the first `wsl.exe` that a window starts there, it holds one idle session (`use`): a `wsl.exe`
// whose script ends itself when no devspace, no Monitor and no helper container of Devspaces (a worker, a relay) ran
// there at two checks in a row, and at the end of its input, so with the window. A Docker call in the background leaves
// a distribution that does not run stopped, unless its Monitor runs permanently (`leavesStopped`); a flow of the user
// starts it. No `vscode`.
import { errorMessage } from '../errors';
import { LABEL_DEVSPACE_ID, LABEL_HELPER } from '../names';
import type { Logger, ProcessRunner, RunResult, StartedProcess } from '../ports';
import { LABEL_MONITOR } from '../remoteMonitor/protocol';
import { sshPromptsAllowed } from '../sshAskpass';
import { hostAccessOf, parseWslList, wslCommandArgs, wslEnv, wslText } from './dockerHost';

/** The arguments of `wsl.exe` that list the names of the running WSL distributions, one per line (none: no output). */
export const WSL_RUNNING_ARGS: readonly string[] = ['--list', '--running', '--quiet'];
/** The time limit of `wsl.exe --list --running --quiet`. */
export const WSL_RUNNING_TIMEOUT_MS = 5_000;
/** How often the idle session looks whether its input ended. */
export const IDLE_INPUT_SECONDS = 15;
/** How often the idle session looks whether a container of Devspaces runs (a multiple of IDLE_INPUT_SECONDS). */
export const IDLE_CHECK_SECONDS = 60;
/** The idle session ends after this many checks in a row at which no container of Devspaces ran. */
export const IDLE_QUIET_CHECKS = 2;
/**
 * After an idle session that failed within this long after its start (it could not start, for example for a
 * distribution that is not registered), no new one starts for this long either; a use within that time starts one
 * after it, unless the distribution does not run then.
 */
export const IDLE_RETRY_MS = 60_000;
/**
 * The output of `docker ps` in the idle session: one line per running container, with the values of its labels of a
 * devspace, of the Monitor and of a helper container (a worker or a relay, which close 10 minutes after their last use;
 * they inherit the label from the helper image), or empty for a container without any of them. The names are raw
 * strings of Go (in backquotes), so that the script has no double quote (IDLE_SESSION_SCRIPT).
 */
export const IDLE_PS_FORMAT = `{{.Label \`${LABEL_DEVSPACE_ID}\`}}{{.Label \`${LABEL_MONITOR}\`}}{{.Label \`${LABEL_HELPER}\`}}`;
/** The last characters of the error output of an idle session that are logged. */
const MAX_LOGGED_ERROR = 2000;

/**
 * The script of the idle session (`sh -c`), as root in the distribution. Its output goes nowhere, so that no process
 * of it holds the output of `wsl.exe`. `cat` reads its input until the end (from the file descriptor 3: a command in
 * the background of a shell without job control reads /dev/null), so the loop ends within IDLE_INPUT_SECONDS after the
 * input ended (the window closed). Every IDLE_CHECK_SECONDS, `docker ps` looks for a running container with
 * one of the labels of IDLE_PS_FORMAT; a check that finds none, also a failed one, counts as quiet. After
 * IDLE_QUIET_CHECKS quiet checks in a row, the session ends with exit code 0. One line, so that the command line of
 * `wsl.exe` has no line break, and without a double quote and a backslash, so that the quoting of the command line on
 * Windows (Node.js) and its parsing by `wsl.exe --exec` (CommandLineToArgvW) cannot change it.
 */
export const IDLE_SESSION_SCRIPT = [
  'exec 3<&0 >/dev/null 2>&1',
  'cat <&3 >/dev/null & input=$!',
  'tick=0',
  'quiet=0',
  [
    'while kill -0 $input; do',
    `sleep ${IDLE_INPUT_SECONDS};`,
    'tick=$((tick + 1));',
    `[ $((tick % ${IDLE_CHECK_SECONDS / IDLE_INPUT_SECONDS})) -eq 0 ] || continue;`,
    `if docker ps --filter status=running --format '${IDLE_PS_FORMAT}' | grep -q .;`,
    'then quiet=0;',
    `else quiet=$((quiet + 1)); [ $quiet -lt ${IDLE_QUIET_CHECKS} ] || break;`,
    'fi;',
    'done',
  ].join(' '),
  'kill $input',
  'exit 0',
].join('; ');

export interface WslLifetimeDeps {
  runner: Pick<ProcessRunner, 'run' | 'start'>;
  /** The path of `wsl.exe` (findExecutable), or undefined (not on Windows, or without WSL). */
  wslPath: () => string | undefined;
  env: NodeJS.ProcessEnv;
  /**
   * Whether the Monitor of the engine `host` runs permanently (the answer Keep Running there, and
   * devspaces.stopMonitorWhenIdle off; monitorSettingsOf). Never rejects.
   */
  monitorPermanent: (host: string) => Promise<boolean>;
  logger: Logger;
  /** For the tests. Default: Date.now. */
  now?: () => number;
  /** For the tests. Default: IDLE_RETRY_MS. */
  retryMs?: number;
}

/**
 * The idle sessions of this window, one per WSL host, and the rule for the Docker calls in the background on such a
 * host. Hosts that are no WSL distribution are not touched.
 */
export class WslLifetime {
  /** The process of the idle session of each host, while it runs. */
  private readonly sessions = new Map<string, StartedProcess>();
  /** The time of the end of the last idle session that failed, by host. */
  private readonly failedAt = new Map<string, number>();
  /** The timer of the start after the wait that follows a failed session (retryLater), by host. */
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  /** The `wsl.exe --list --running --quiet` that runs now, which the calls at the same time share. */
  private listing: Promise<RunResult> | undefined;
  /** The last state that `leavesStopped` logged, by host: true while it leaves the distribution stopped. */
  private readonly saidStopped = new Map<string, boolean>();
  /** The last warning of `running`, by distribution, so that a failure that stays is logged once. */
  private readonly runningWarnings = new Map<string, string>();
  private disposed = false;

  constructor(private readonly deps: WslLifetimeDeps) {}

  /**
   * Whether the WSL distribution `distribution` runs now (`wsl.exe --list --running --quiet`; WSL compares the names
   * without case). With `--quiet`, WSL answers exit code 0 and no line when no distribution runs (ListDistributionsHelper
   * of src/windows/common/WslClient.cpp in microsoft/WSL); without it, it would say so with an exit code that is not 0.
   * Undefined when that cannot be told: without `wsl.exe`, or when it fails or does not answer within
   * WSL_RUNNING_TIMEOUT_MS (logged once until it works again). Never rejects.
   */
  async running(distribution: string): Promise<boolean | undefined> {
    const wsl = this.deps.wslPath();
    if (wsl === undefined) return undefined;
    try {
      this.listing ??= this.deps.runner.run(wsl, WSL_RUNNING_ARGS, { env: wslEnv(this.deps.env), timeoutMs: WSL_RUNNING_TIMEOUT_MS }).finally(() => {
        this.listing = undefined;
      });
      const result = await this.listing;
      if (result.timedOut) throw new Error(`it did not answer within ${WSL_RUNNING_TIMEOUT_MS / 1000} seconds`);
      if (result.exitCode !== 0) throw new Error(`exit code ${result.exitCode}: ${wslText(result.stderr || result.stdout).trim()}`);
      this.runningWarnings.delete(distribution);
      const name = distribution.toLowerCase();
      return parseWslList(result.stdout).some((listed) => listed.toLowerCase() === name);
    } catch (error) {
      const warning = `wsl.exe ${WSL_RUNNING_ARGS.join(' ')} failed, so Devspaces does not know whether the WSL distribution ${distribution} runs: ${errorMessage(error)}`;
      if (this.runningWarnings.get(distribution) !== warning) this.deps.logger.warn(warning);
      this.runningWarnings.set(distribution, warning);
      return undefined;
    }
  }

  /**
   * Whether a Docker call on the engine `host` must not run now, because it would start a WSL distribution that does
   * not run: true only for a WSL host, outside of a flow of the user (withSshPrompts), while its Monitor does not run
   * permanently, and when `running` says that the distribution does not run. Any other host, a flow of the user, an
   * idle session of this window there (the distribution runs), a permanent Monitor, and a state that cannot be told
   * give false: the call runs, and `wsl.exe` starts the distribution when it does not run. Each change of the answer
   * for a host is logged once. Never rejects.
   */
  async leavesStopped(host: string): Promise<boolean> {
    const access = hostAccessOf(host);
    if (access?.kind !== 'wsl') return false;
    if (sshPromptsAllowed() || this.holds(host)) {
      // A flow of the user starts the distribution, and an idle session of this window holds it: the next time that a
      // call leaves it stopped is logged again.
      this.saidStopped.delete(host);
      return false;
    }
    const stopped = !(await this.deps.monitorPermanent(host)) && (await this.running(access.distribution)) === false;
    if (stopped !== (this.saidStopped.get(host) ?? false)) {
      this.saidStopped.set(host, stopped);
      this.deps.logger.info(
        stopped
          ? `The WSL distribution ${access.distribution} does not run. Devspaces does not start it for its work in the background; a Start or an Open does.`
          : `The WSL distribution ${access.distribution} runs, or may be started for the work in the background again.`,
      );
    }
    return stopped;
  }

  /**
   * Devspaces starts a `wsl.exe` for the WSL host `host` now (a shell, a connection of the relay, a connection of a
   * Docker pipe): this window holds the idle session of the host from now on, unless it holds one already, or `wsl.exe`
   * cannot be found. Within a minute after the last one failed (IDLE_RETRY_MS: it ended with an error within a minute
   * after its start), the session starts only after that minute, and not when the distribution does not run then
   * (`retryLater`). Nothing for any other host, and after `dispose`. Never throws.
   */
  use(host: string): void {
    const access = hostAccessOf(host);
    if (this.disposed || access?.kind !== 'wsl' || this.holds(host)) return;
    const failed = this.failedAt.get(host);
    const wait = failed === undefined ? 0 : this.retryMs() - Math.abs(this.now() - failed);
    if (wait > 0) this.retryLater(host, access.distribution, wait);
    else this.start(host, access.distribution);
  }

  /**
   * A use within the wait after a failed session: the session starts once the wait is over, unless the distribution
   * does not run then (as for leavesStopped, a state that cannot be told counts as running), because the `wsl.exe` of
   * this use (for example a connection of the relay) may stay the only one for a long time. One timer per host;
   * `dispose` stops it.
   */
  private retryLater(host: string, distribution: string, waitMs: number): void {
    if (this.retries.has(host)) return;
    const timer = setTimeout(() => {
      this.retries.delete(host);
      void this.running(distribution).then((runs) => {
        if (runs !== false && !this.disposed && !this.holds(host)) this.start(host, distribution);
      });
    }, waitMs);
    timer.unref?.();
    this.retries.set(host, timer);
  }

  /** Starts the idle session of `host` (the distribution `distribution`), unless `wsl.exe` cannot be found. */
  private start(host: string, distribution: string): void {
    const wsl = this.deps.wslPath();
    if (wsl === undefined || this.deps.runner.start === undefined) return;
    // Never throws: a `wsl.exe` that cannot start resolves `exited` with the error, a failed session below.
    const process = this.deps.runner.start(wsl, wslCommandArgs(distribution, ['sh', '-c', IDLE_SESSION_SCRIPT]), { env: wslEnv(this.deps.env) });
    const startedAt = this.now();
    this.sessions.set(host, process);
    let errorOutput = '';
    process.onStdout(() => undefined);
    process.onStderr((text) => {
      errorOutput = (errorOutput + wslText(text)).slice(-MAX_LOGGED_ERROR);
    });
    this.deps.logger.info(`Devspaces starts an idle session of the WSL distribution ${distribution}, so that it runs while this window is open and a container of Devspaces runs there.`);
    void process.exited.then(({ exitCode, error }) => {
      if (this.sessions.get(host) === process) this.sessions.delete(host);
      if (this.disposed) return;
      if (exitCode === 0 && error === undefined) {
        this.deps.logger.info(`The idle session of the WSL distribution ${distribution} ended: no container of Devspaces ran there.`);
        return;
      }
      const reason = error !== undefined ? errorMessage(error) : `exit code ${exitCode}${errorOutput.trim() ? `: ${errorOutput.trim()}` : ''}`;
      // One that ran for a while ended with the distribution (`wsl --terminate`, `wsl --shutdown`, the removal): the
      // next `wsl.exe` starts a new one at once.
      if (Math.abs(this.now() - startedAt) >= this.retryMs()) {
        this.deps.logger.info(`The idle session of the WSL distribution ${distribution} ended (${reason}).`);
        return;
      }
      this.failedAt.set(host, this.now());
      this.deps.logger.warn(`The idle session of the WSL distribution ${distribution} failed (${reason}), so the next one starts in a minute at the earliest.`);
    });
  }

  /** Whether this window holds the idle session of `host` now. */
  holds(host: string): boolean {
    return this.sessions.has(host);
  }

  /**
   * Ends the idle sessions of this window (the window closes): their input ends, and their `wsl.exe` is stopped at once.
   * No new one starts after this.
   */
  dispose(): void {
    this.disposed = true;
    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
    for (const process of this.sessions.values()) {
      process.end();
      if (process.killNow !== undefined) process.killNow();
      else process.kill();
    }
    this.sessions.clear();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private retryMs(): number {
    return this.deps.retryMs ?? IDLE_RETRY_MS;
  }
}
