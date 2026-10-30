// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The keeper of a WSL distribution that is a Docker host of Devspaces (docs/architecture.md "The WSL distribution of
// Devspaces"): a `wsl.exe` that is not a child of VS Code, so that it also holds the distribution after VS Code closed,
// while a container runs there. It ends itself when no container ran at two checks in a row; one keeper at a time runs
// in a distribution. A window that holds the idle session starts it (`keep`, at most once a minute), and while the
// Monitor of the distribution runs permanently, a start entry of the Windows user starts it when the user logs on to
// Windows (`updateStartEntry`), so that Docker starts the Monitor again. No `vscode`.
import * as fs from 'fs';
import * as path from 'path';
import { errorMessage } from '../errors';
import type { Logger, ProcessRunner } from '../ports';
import { envValue } from './dockerCli';
import { wslCommandArgs } from './dockerHost';

/** A window that holds the idle session starts the keeper at most this often. */
export const KEEPER_LAUNCH_MS = 60_000;
/** How often the keeper looks whether a container runs. */
export const KEEPER_CHECK_SECONDS = 60;
/** The keeper ends after this many checks in a row at which no container ran. */
export const KEEPER_QUIET_CHECKS = 2;
/** The time limit of the `docker ps` of the keeper. */
export const KEEPER_PS_TIMEOUT_SECONDS = 10;
/** The lock file of the keeper in the distribution (a tmpfs, empty after each start of the distribution). */
export const KEEPER_LOCK = '/run/devspaces-keeper';

/**
 * The script of the keeper (`sh -c`), as root in the distribution. Its output goes nowhere. It holds the lock
 * KEEPER_LOCK (`flock`): when another keeper holds it, it ends at once. Every KEEPER_CHECK_SECONDS, `docker ps` looks
 * for a running container, any container, because a container that runs must not be stopped with the distribution; it
 * has a time limit (`timeout`), and a check that finds none, also a failed one, counts as quiet. After
 * KEEPER_QUIET_CHECKS quiet checks in a row, it ends. `flock` (util-linux) and `timeout` (coreutils) are in the
 * distribution of Devspaces; without them, the keeper ends at once or after two minutes, as if none ran. One line
 * without a double quote and a backslash, so that the quoting of a command line on Windows cannot change it, and
 * without spaces where sh needs none, so that the start entry stays within MAX_START_ENTRY.
 */
export const KEEPER_SCRIPT = [
  `exec >/dev/null 2>&1 9>${KEEPER_LOCK}`,
  'flock -n 9||exit',
  'q=0',
  `while [ $q -lt ${KEEPER_QUIET_CHECKS} ]`,
  `do sleep ${KEEPER_CHECK_SECONDS}`,
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

export interface WslKeeperDeps {
  runner: Pick<ProcessRunner, 'run'>;
  /** The path of `wsl.exe` (findExecutable), or undefined (not on Windows, or without WSL). */
  wslPath: () => string | undefined;
  env: NodeJS.ProcessEnv;
  /** Starts a program that is not a child of this process and outlives it (launchDetachedProcess). */
  launch: (file: string, args: readonly string[]) => Promise<void>;
  /** Whether the Monitor of the engine `host` runs permanently (monitorSettingsOf(...).permanent). Never rejects. */
  monitorPermanent: (host: string) => Promise<boolean>;
  /** Whether Devspaces was removed from the engine `host` (its removal mark), so that no Monitor runs there. */
  engineRemoved: (host: string) => Promise<boolean>;
  logger: Logger;
  /** For the tests. Default: whether the file exists. */
  exists?: (file: string) => boolean;
  /** For the tests. Default: Date.now. */
  now?: () => number;
}

/**
 * The keeper of each WSL distribution that this window uses, and its start entry. Hosts that are no WSL distribution
 * are not touched by the caller (WslLifetime).
 */
export class WslKeeper {
  /** The time of the last start of the keeper, by distribution. */
  private readonly launchedAt = new Map<string, number>();
  /** The state of the start entry that this window found or wrote, by distribution. */
  private readonly entryWanted = new Map<string, boolean>();
  /** The work on the start entries, one after the other. */
  private entryWork: Promise<void> = Promise.resolve();
  /** The last warning about the start of the keeper, so that a failure that stays is logged once. */
  private launchWarning: string | undefined;
  private disposed = false;

  constructor(private readonly deps: WslKeeperDeps) {}

  /**
   * This window holds the idle session of the WSL host `host` (the distribution `distribution`) and uses it now:
   * starts the keeper there, unless this window started it within the last minute (KEEPER_LAUNCH_MS), and updates the
   * start entry (updateStartEntry). `wslg.exe` when it exists, so that no console window opens; else `wsl.exe`. The
   * keeper ends at once when another one runs there. Nothing after `dispose`. Never throws.
   */
  keep(host: string, distribution: string): void {
    if (this.disposed) return;
    const now = (this.deps.now ?? Date.now)();
    const last = this.launchedAt.get(distribution);
    if (last !== undefined && Math.abs(now - last) < KEEPER_LAUNCH_MS) return;
    this.launchedAt.set(distribution, now);
    const first = last === undefined;
    void this.launchKeeper(distribution, first);
    void this.updateStartEntry(host, distribution);
  }

  /**
   * Adds the start entry of the WSL distribution `distribution` while the Monitor of its host `host` runs permanently
   * and Devspaces was not removed from there, and removes it otherwise. An entry with another command is replaced. It
   * reads the registry only when this window did not find or write the wanted state yet. Without `wslg.exe`, or with a
   * command line longer than MAX_START_ENTRY, no entry is added (logged). Never rejects.
   */
  updateStartEntry(host: string, distribution: string): Promise<void> {
    const work = this.entryWork.then(async () => {
      const wanted = (await this.deps.monitorPermanent(host)) && !(await this.deps.engineRemoved(host).catch(() => false));
      if (this.entryWanted.get(distribution) === wanted) return;
      if (await this.writeStartEntry(distribution, wanted)) this.entryWanted.set(distribution, wanted);
    });
    this.entryWork = work.catch(() => undefined);
    return this.entryWork;
  }

  /** Removes the start entry of the WSL distribution `distribution` (its removal). Never rejects. */
  removeStartEntry(distribution: string): Promise<void> {
    const work = this.entryWork.then(async () => {
      if (await this.writeStartEntry(distribution, false)) this.entryWanted.set(distribution, false);
    });
    this.entryWork = work.catch(() => undefined);
    return this.entryWork;
  }

  /** No keeper starts after this; a keeper that runs goes on. */
  dispose(): void {
    this.disposed = true;
  }

  private async launchKeeper(distribution: string, first: boolean): Promise<void> {
    const wslg = wslgPathOf(this.deps.env);
    const wsl = this.deps.wslPath();
    const program = this.exists(wslg) ? { file: wslg, args: keeperWslgArgs(distribution) } : wsl === undefined ? undefined : { file: wsl, args: wslCommandArgs(distribution, ['sh', '-c', KEEPER_SCRIPT]) };
    if (program === undefined) return;
    try {
      await this.deps.launch(program.file, program.args);
      this.launchWarning = undefined;
      if (first) {
        this.deps.logger.info(
          `Devspaces starts the keeper of the WSL distribution ${distribution} (${path.win32.basename(program.file)}), so that it runs while a container runs there, also after VS Code closed.`,
        );
      }
    } catch (error) {
      const warning = `The keeper of the WSL distribution ${distribution} could not start, so WSL stops the distribution 15 seconds after VS Code closed: ${errorMessage(error)}`;
      if (warning !== this.launchWarning) this.deps.logger.warn(warning);
      this.launchWarning = warning;
    }
  }

  /** Adds (`wanted`) or removes the start entry; true when the registry has the wanted state now. */
  private async writeStartEntry(distribution: string, wanted: boolean): Promise<boolean> {
    const name = startEntryName(distribution);
    const reg = this.regPath();
    try {
      const query = await this.deps.runner.run(reg, regQueryArgs(name), { timeoutMs: REG_TIMEOUT_MS });
      if (query.timedOut) throw new Error(`reg.exe did not answer within ${REG_TIMEOUT_MS / 1000} seconds`);
      const present = query.exitCode === 0;
      if (!wanted) {
        if (!present) return true;
        const removed = await this.deps.runner.run(reg, regDeleteArgs(name), { timeoutMs: REG_TIMEOUT_MS });
        if (removed.exitCode !== 0) throw new Error(`reg.exe delete ended with ${removed.timedOut ? 'its time limit' : `exit code ${removed.exitCode}`}`);
        this.deps.logger.info(`Devspaces removed the start entry "${name}": WSL no longer starts the distribution ${distribution} when you log on to Windows.`);
        return true;
      }
      const wslg = wslgPathOf(this.deps.env);
      if (!this.exists(wslg)) {
        this.deps.logger.warn(`There is no ${wslg}, so WSL does not start the distribution ${distribution} when you log on to Windows; its Monitor runs again at the next start of Devspaces there.`);
        return true;
      }
      const command = startEntryCommand(wslg, distribution);
      // An entry with another command (another folder of the programs, or another script) is replaced.
      if (present && query.stdout.includes(command)) return true;
      if (command.length > MAX_START_ENTRY) {
        this.deps.logger.warn(`The start entry for the WSL distribution ${distribution} would be longer than ${MAX_START_ENTRY} characters, so WSL does not start it when you log on to Windows.`);
        return true;
      }
      const added = await this.deps.runner.run(reg, regAddArgs(name, command), { timeoutMs: REG_TIMEOUT_MS });
      if (added.exitCode !== 0) throw new Error(`reg.exe add ended with ${added.timedOut ? 'its time limit' : `exit code ${added.exitCode}`}`);
      this.deps.logger.info(`Devspaces added the start entry "${name}": WSL starts the distribution ${distribution} when you log on to Windows, so that its Monitor runs again.`);
      return true;
    } catch (error) {
      this.deps.logger.warn(`The start entry "${name}" could not be ${wanted ? 'added' : 'removed'}: ${errorMessage(error)}`);
      return false;
    }
  }

  /** `reg.exe` in System32 of SystemRoot, not from PATH. */
  private regPath(): string {
    const systemRoot = envValue(this.deps.env, 'SystemRoot', 'win32') ?? 'C:\\Windows';
    return path.win32.join(systemRoot, 'System32', 'reg.exe');
  }

  private exists(file: string): boolean {
    return (this.deps.exists ?? fs.existsSync)(file);
  }
}
