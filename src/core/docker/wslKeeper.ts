// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The keeper of a WSL distribution that is a Docker host of Devspaces (docs/architecture.md "The WSL distribution of
// Devspaces"): a `wsl.exe` that is not a child of VS Code, so that it also holds the distribution after VS Code closed,
// while a container runs there. It ends itself when no container ran at two checks in a row; one keeper at a time runs
// in a distribution. A window that holds the idle session starts it (`keep`, at most once a minute), and while the
// Monitor of the WSL distribution of Devspaces runs permanently, a start entry of the Windows user starts it when the
// user logs on to Windows (`updateStartEntry`), so that Docker starts the Monitor again. No `vscode`.
import * as fs from 'fs';
import * as path from 'path';
import { errorMessage } from '../errors';
import type { Logger, ProcessRunner, RunResult } from '../ports';
import { envValue } from './dockerCli';
import { WSL_DISTRIBUTION, wslCommandArgs } from './dockerHost';
import { endOf, outputOf, regExePath } from './wslSetup';

/** A window that holds the idle session starts the keeper at most this often. */
export const KEEPER_LAUNCH_MS = 60_000;
/** How often the keeper looks whether a container runs. */
export const KEEPER_CHECK_SECONDS = 60;
/** The keeper ends after this many checks in a row at which no container ran. */
export const KEEPER_QUIET_CHECKS = 2;
/** The time limit of the `docker ps` of the keeper. */
export const KEEPER_PS_TIMEOUT_SECONDS = 10;
/**
 * How long a new keeper waits for the lock of the keeper that runs: longer than the two last checks of that keeper
 * (two waits and two `docker ps` at their time limit), so that a keeper that ends just after the start of a new one
 * hands over to it; and long, because a window starts its next keeper only after this one ended (about every 11
 * minutes while another keeper runs, for example the one of the start entry with a permanent Monitor).
 */
export const KEEPER_LOCK_WAIT_SECONDS = 600;
/** The lock file of the keeper in the distribution (a tmpfs, empty after each start of the distribution). */
export const KEEPER_LOCK = '/run/devspaces-keeper';

/**
 * The script of the keeper (`sh -c`), as root in the distribution. Its output goes nowhere. It holds the lock
 * KEEPER_LOCK (`flock`): while another keeper holds it, it waits for it up to KEEPER_LOCK_WAIT_SECONDS and then ends;
 * so a keeper that started while another one ran its last checks takes over when that one ends, and at most a few wait
 * while one runs. Every KEEPER_CHECK_SECONDS, `docker ps` looks for a running container, any container, because a
 * container that runs must not be stopped with the distribution; it has a time limit (`timeout`), and a check that
 * finds none, also a failed one, counts as quiet. After KEEPER_QUIET_CHECKS quiet checks in a row, it ends. `sleep`
 * does not get the lock (`9>&-`), so that the lock goes with the end of the script. `flock` (util-linux) and `timeout`
 * (coreutils) are in the distribution of Devspaces; without them, the keeper ends at once or after two minutes, as if
 * none ran. One line without a double quote and a backslash, so that the quoting of a command line on Windows cannot
 * change it, and without spaces where sh needs none, so that the start entry stays within MAX_START_ENTRY.
 */
export const KEEPER_SCRIPT = [
  `exec >/dev/null 2>&1 9>${KEEPER_LOCK}`,
  `flock -w ${KEEPER_LOCK_WAIT_SECONDS} 9||exit`,
  'q=0',
  `while [ $q -lt ${KEEPER_QUIET_CHECKS} ]`,
  `do sleep ${KEEPER_CHECK_SECONDS} 9>&-`,
  `timeout ${KEEPER_PS_TIMEOUT_SECONDS} docker ps -q|grep -q .&&q=0||q=$((q+1))`,
  'done',
].join(';');

/** The key of the start entries of the Windows user, which Windows starts at the logon of that user. */
export const START_ENTRY_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
/** Windows starts an entry of START_ENTRY_KEY only when its command line has at most this many characters. */
export const MAX_START_ENTRY = 260;

/** The name of the start entry for the WSL distribution `distribution` (the list of start apps of Windows shows it). */
export function startEntryName(distribution: string): string {
  return `nimblescape Devspaces WSL ${distribution}`;
}

/** `wslg.exe` of WSL from the Microsoft Store: `%ProgramFiles%\WSL\wslg.exe`, a program without a console window. */
export function wslgPathOf(env: NodeJS.ProcessEnv): string {
  return path.win32.join(envValue(env, 'ProgramFiles', 'win32') ?? 'C:\\Program Files', 'WSL', 'wslg.exe');
}

/**
 * The arguments of `wslg.exe` that start the keeper in `distribution`: `--shell-type none` runs `sh` without a shell
 * of the user, and `wslg.exe` reads the words from the first one that is no option (`sh`) as `wsl.exe --exec` does
 * (CommandLineToArgvW; WslgMain in src/windows/common/WslClient.cpp of microsoft/WSL).
 */
export function keeperWslgArgs(distribution: string): string[] {
  return ['-d', distribution, '-u', 'root', '--cd', '/', '--shell-type', 'none', 'sh', '-c', KEEPER_SCRIPT];
}

/** The command line of the start entry: `wslg.exe` in quotes, then keeperWslgArgs, the script in quotes. */
export function startEntryCommand(wslg: string, distribution: string): string {
  const args = keeperWslgArgs(distribution);
  return [`"${wslg}"`, ...args.slice(0, -1), `"${args[args.length - 1]}"`].join(' ');
}

/** The arguments of `reg.exe` that add or replace the start entry `name` with `command`. */
export function regAddArgs(name: string, command: string): string[] {
  return ['add', START_ENTRY_KEY, '/v', name, '/t', 'REG_SZ', '/d', command, '/f'];
}

/** The arguments of `reg.exe` that read the start entry `name` (exit code 0 when it exists). */
export function regQueryArgs(name: string): string[] {
  return ['query', START_ENTRY_KEY, '/v', name];
}

/** The arguments of `reg.exe` that remove the start entry `name`. */
export function regDeleteArgs(name: string): string[] {
  return ['delete', START_ENTRY_KEY, '/v', name, '/f'];
}

/** The time limit of each call of `reg.exe`. */
const REG_TIMEOUT_MS = 15_000;

/**
 * The data of the value `name` (REG_SZ) in the output of `reg.exe query` (regQueryArgs): the line
 * `    <name>    REG_SZ    <data>`; undefined when there is none.
 */
export function startEntryValueOf(output: string, name: string): string | undefined {
  const separator = '    REG_SZ    ';
  for (const line of output.split(/\r?\n/)) {
    const at = line.indexOf(separator);
    if (at >= 0 && line.slice(0, at).trim() === name) return line.slice(at + separator.length);
  }
  return undefined;
}

export interface WslKeeperDeps {
  runner: Pick<ProcessRunner, 'run'>;
  /** The path of `wsl.exe` (findExecutable), or undefined (not on Windows, or without WSL); read only without `wslg.exe`. */
  wslPath: () => string | undefined;
  env: NodeJS.ProcessEnv;
  /**
   * Starts a program that is not a child of this process and outlives it, without a window (launchDetachedProcess);
   * `onExit` runs when it ended while this process runs.
   */
  launch: (file: string, args: readonly string[], onExit: () => void) => Promise<void>;
  /**
   * Whether WSL lists the distribution `distribution` (`wsl.exe --list --quiet`); undefined when that cannot be told.
   * Asked only before a start entry is kept or added. Never rejects.
   */
  registered: (distribution: string) => Promise<boolean | undefined>;
  /**
   * Whether the Monitor of the engine `host` runs permanently (monitorSettingsOf(...).permanentIfKnown): false also
   * after "Remove Devspaces from This Docker Engine…" there, whose mark forgets the answer; undefined when the answer
   * cannot be read (logged there). Never rejects.
   */
  monitorPermanent: (host: string) => Promise<boolean | undefined>;
  logger: Logger;
  /** For the tests. Default: whether the file exists. */
  exists?: (file: string) => boolean;
  /** For the tests. Default: Date.now. */
  now?: () => number;
}

/**
 * The keeper of the WSL distribution of Devspaces (WSL_DISTRIBUTION; a distribution of the user keeps its own rules:
 * the keeper would hold it while any container of the user runs there), and the start entry of a distribution (the
 * caller names only the WSL distribution of Devspaces).
 */
export class WslKeeper {
  /** The time of the last start of the keeper, by distribution. */
  private readonly launchedAt = new Map<string, number>();
  /** The distributions where the keeper that this window started still runs or waits for the lock. */
  private readonly running = new Set<string>();
  /** The work on the start entries, one after the other. */
  private entryWork: Promise<void> = Promise.resolve();
  /** The distributions whose update of the start entry waits in entryWork and has not begun yet. */
  private readonly updatesWaiting = new Set<string>();
  /** The last warning about the start of the keeper, so that a failure that stays is logged once. */
  private launchWarning: string | undefined;
  /** The last warning about a start entry that cannot be written, so that it is logged once while it stays. */
  private entryWarning: string | undefined;
  private disposed = false;

  constructor(private readonly deps: WslKeeperDeps) {}

  /**
   * This window holds the idle session of the WSL distribution `distribution` and uses it now: starts the keeper
   * there, only in the WSL distribution of Devspaces, and unless the keeper that this window started there still runs or waits for the lock, or this window started
   * one within the last minute (KEEPER_LAUNCH_MS). `wslg.exe` when it exists, so that no console window opens; else
   * `wsl.exe`. While another keeper runs there, the new one waits for its end (KEEPER_LOCK_WAIT_SECONDS). Nothing after
   * `dispose`. Never throws.
   */
  keep(distribution: string): void {
    if (this.disposed || distribution !== WSL_DISTRIBUTION || this.running.has(distribution)) return;
    const now = (this.deps.now ?? Date.now)();
    const last = this.launchedAt.get(distribution);
    if (last !== undefined && Math.abs(now - last) < KEEPER_LAUNCH_MS) return;
    this.launchedAt.set(distribution, now);
    void this.launchKeeper(distribution, last === undefined);
  }

  /**
   * Adds the start entry of the WSL distribution `distribution` while the Monitor of its host `host` runs permanently and
   * WSL lists the distribution, and removes it otherwise; an entry with another command is replaced. Without
   * `wslg.exe`, or with a command line longer than MAX_START_ENTRY, there is no entry (logged). While the answer about
   * the Monitor cannot be read, or WSL does not tell whether it lists the distribution, the entry stays as it is. The
   * caller calls it when that state may have changed; an update that waits and has not begun yet covers a second call
   * (it reads the state when it begins). Never rejects.
   */
  updateStartEntry(host: string, distribution: string): Promise<void> {
    if (this.updatesWaiting.has(distribution)) return this.entryWork;
    this.updatesWaiting.add(distribution);
    return this.enqueue(() => {
      this.updatesWaiting.delete(distribution);
      return this.writeStartEntry(distribution, host);
    });
  }

  /**
   * Removes the start entry of the WSL distribution `distribution` (its removal). An update that waits before it does
   * not cover a later call of updateStartEntry, which then runs after this removal. Never rejects.
   */
  removeStartEntry(distribution: string): Promise<void> {
    this.updatesWaiting.delete(distribution);
    return this.enqueue(() => this.writeStartEntry(distribution, undefined));
  }

  /** No keeper starts after this; a keeper that runs goes on. */
  dispose(): void {
    this.disposed = true;
  }

  /** Runs `task` after the work on the start entries before it, so that two never run at the same time. */
  private enqueue(task: () => Promise<void>): Promise<void> {
    this.entryWork = this.entryWork.then(task).catch(() => undefined);
    return this.entryWork;
  }

  private async launchKeeper(distribution: string, first: boolean): Promise<void> {
    const program = this.keeperProgram(distribution);
    if (program === undefined) return;
    this.running.add(distribution);
    try {
      await this.deps.launch(program.file, program.args, () => this.running.delete(distribution));
      this.launchWarning = undefined;
      if (first) {
        this.deps.logger.info(
          `Devspaces starts the keeper of the WSL distribution ${distribution} (${path.win32.basename(program.file)}), so that it runs while a container runs there, also after VS Code closed.`,
        );
      }
    } catch (error) {
      this.running.delete(distribution);
      const warning = `The keeper of the WSL distribution ${distribution} could not start, so WSL stops the distribution 15 seconds after VS Code closed: ${errorMessage(error)}`;
      if (warning !== this.launchWarning) this.deps.logger.warn(warning);
      this.launchWarning = warning;
    }
  }

  /** `wslg.exe` with keeperWslgArgs when it exists, else `wsl.exe --exec`; undefined without either. */
  private keeperProgram(distribution: string): { file: string; args: string[] } | undefined {
    const wslg = this.wslg();
    if (wslg !== undefined) return { file: wslg, args: keeperWslgArgs(distribution) };
    const wsl = this.deps.wslPath();
    return wsl === undefined ? undefined : { file: wsl, args: wslCommandArgs(distribution, ['sh', '-c', KEEPER_SCRIPT]) };
  }

  /**
   * Brings the start entry of `distribution` into the state that the Monitor of `host` wants (updateStartEntry), or
   * removes it (no `host`). The registry is read first, and the state of the Monitor after it: an answer that another
   * window records meanwhile is either seen here, or that window updates the entry after this read. A removal that
   * fails because another window removed the entry meanwhile counts as done. Failures are logged.
   */
  private async writeStartEntry(distribution: string, host: string | undefined): Promise<void> {
    const name = startEntryName(distribution);
    const reg = regExePath(this.deps.env);
    const run = async (args: string[], what: string): Promise<RunResult> => {
      const result = await this.deps.runner.run(reg, args, { timeoutMs: REG_TIMEOUT_MS });
      if (result.timedOut) throw new Error(`reg.exe ${what} had ${endOf(result, REG_TIMEOUT_MS)}`);
      return result;
    };
    let action = 'read';
    try {
      const query = await run(regQueryArgs(name), 'query');
      const present = query.exitCode === 0;
      let wanted = host === undefined ? false : await this.deps.monitorPermanent(host);
      if (wanted === true && host !== undefined) {
        // A distribution that was removed by hand (`wsl --unregister`) gets no entry: WSL would fail at each logon. The
        // state of the Monitor is read again after the list of WSL, which can take seconds.
        const listed = await this.deps.registered(distribution);
        wanted = listed === true ? await this.deps.monitorPermanent(host) : listed;
      }
      if (wanted === undefined) return;
      const command = wanted ? this.startCommand(distribution) : undefined;
      if (command === undefined) {
        if (!present) return;
        action = 'removed';
        const removed = await run(regDeleteArgs(name), 'delete');
        if (removed.exitCode !== 0) {
          if ((await run(regQueryArgs(name), 'query')).exitCode !== 0) return;
          throw new Error(`reg.exe delete ended with ${endOf(removed, REG_TIMEOUT_MS)}: ${outputOf(removed)}`);
        }
        this.deps.logger.info(`Devspaces removed the start entry "${name}": WSL no longer starts the distribution ${distribution} when you log on to Windows.`);
        return;
      }
      // An entry with another command (another folder of the programs, or another script) is replaced.
      if (present && startEntryValueOf(query.stdout, name) === command) return;
      action = 'added';
      const added = await run(regAddArgs(name, command), 'add');
      if (added.exitCode !== 0) throw new Error(`reg.exe add ended with ${endOf(added, REG_TIMEOUT_MS)}: ${outputOf(added)}`);
      this.deps.logger.info(`Devspaces added the start entry "${name}": WSL starts the distribution ${distribution} when you log on to Windows, so that its Monitor runs again.`);
    } catch (error) {
      this.deps.logger.warn(`The start entry "${name}" could not be ${action}: ${errorMessage(error)}`);
    }
  }

  /**
   * The command of the start entry of `distribution` with `wslg.exe`; undefined, logged, without `wslg.exe` (`wsl.exe`
   * would open a console window at each logon) or when it would be longer than MAX_START_ENTRY.
   */
  private startCommand(distribution: string): string | undefined {
    const wslg = this.wslg();
    const command = startEntryCommand(wslg ?? wslgPathOf(this.deps.env), distribution);
    const warning = wslg === undefined
      ? `There is no ${wslgPathOf(this.deps.env)}, so WSL does not start the distribution ${distribution} when you log on to Windows; its Monitor runs again at the next start of Devspaces there.`
      : command.length > MAX_START_ENTRY
        ? `The start entry for the WSL distribution ${distribution} would be longer than ${MAX_START_ENTRY} characters, so WSL does not start it when you log on to Windows.`
        : undefined;
    if (warning !== undefined && warning !== this.entryWarning) this.deps.logger.warn(warning);
    this.entryWarning = warning;
    return warning === undefined ? command : undefined;
  }

  /** The path of `wslg.exe` (wslgPathOf) when it exists. */
  private wslg(): string | undefined {
    const file = wslgPathOf(this.deps.env);
    return (this.deps.exists ?? fs.existsSync)(file) ? file : undefined;
  }
}
