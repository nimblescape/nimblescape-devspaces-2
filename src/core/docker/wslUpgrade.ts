// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The weekly upgrade of the packages of the WSL distribution of Devspaces (docs/architecture.md "The WSL distribution
// of Devspaces"): `apt-get upgrade` as root there, about once a week, with its result in the log of Devspaces. No
// service starts again during it (the policy-rc.d of the setup), so Docker and the running devspaces go on, and the
// new versions of Docker and other services run after the next start of the distribution. A window that uses the
// distribution checks a few minutes after its first use, and then at most every 6 hours; the time of the last upgrade
// is in the distribution, so all windows and VS Code products share it. Only in a distribution that Devspaces set up.
// No `vscode`.
import { errorMessage } from '../errors';
import type { Logger, ProcessRunner, RunResult } from '../ports';
import { WSL_DISTRIBUTION, wslCommandArgs, wslEnv, wslText } from './dockerHost';
import { WSL_POLICY_INSTALL, WSL_SETUP_LOCK, endOf, outputOf } from './wslSetup';

/** The folder of the times of the upgrade in the distribution. */
export const UPGRADE_STATE_DIR = '/var/lib/devspaces';
/** The time (seconds since 1970) of the last upgrade that ended well. */
export const UPGRADE_DONE_FILE = `${UPGRADE_STATE_DIR}/upgraded`;
/** The time (seconds since 1970) of the last upgrade that failed, so that a failure is tried again only after a day. */
export const UPGRADE_FAILED_FILE = `${UPGRADE_STATE_DIR}/upgrade-failed`;
/** There while an upgrade runs: still there at the start of a run, the last one was interrupted (the stop of the distribution). */
export const UPGRADE_RUNNING_FILE = `${UPGRADE_STATE_DIR}/upgrade-running`;
/** The log of the last upgrade in the distribution. */
export const UPGRADE_LOG = '/var/log/devspaces-upgrade.log';
/** An upgrade runs when the last one that ended well is this old. */
export const UPGRADE_INTERVAL_SECONDS = 7 * 24 * 60 * 60;
/** An upgrade runs only when the last one that failed is this old. */
export const UPGRADE_RETRY_SECONDS = 24 * 60 * 60;
/** The start of the line of the script that tells its result: `busy`, `skipped`, or `done <the summary of apt-get>`. */
export const UPGRADE_PREFIX = 'devspaces-upgrade ';
/** The time limit of the script. */
export const UPGRADE_MS = 30 * 60_000;
/** The wait after the first use of the distribution in a window, so that the upgrade does not slow the start of a devspace. */
export const UPGRADE_DELAY_MS = 5 * 60_000;
/** A window checks at most this often. */
export const UPGRADE_CHECK_MS = 6 * 60 * 60_000;

/**
 * The script of the upgrade (`sh -s`, as root). It runs only with the lock of the setup (another setup or upgrade runs:
 * `busy`), and only when the last upgrade that ended well is a week old and the last one that failed is a day old;
 * else `skipped`. A run that the stop of the distribution interrupted (UPGRADE_RUNNING_FILE is still there) is no
 * failure: the next check runs again, and `dpkg --configure -a` ends the interrupted one. A time after now (a clock
 * that went back) counts as none. `apt-get upgrade` waits up to 5 minutes for the lock of dpkg; `dpkg
 * --configure -a` and `apt-get update` fail at once while another program holds a lock of dpkg or apt. `--with-new-pkgs`
 * also installs a new package that an upgrade needs, but removes none. On a failure, standard error gets the last lines
 * of its log.
 */
export const UPGRADE_SCRIPT = `set -eu
main() {
log=${UPGRADE_LOG}
exec 9> ${WSL_SETUP_LOCK}
if ! flock -n 9; then
echo "${UPGRADE_PREFIX}busy"
exit 0
fi
mkdir -p ${UPGRADE_STATE_DIR}
now=$(date +%s)
since() { last=$(cat "$1" 2>/dev/null || echo 0); case "$last" in ''|*[!0-9]*) last=0;; esac; [ "$last" -le "$now" ] || last=0; echo $((now - last)); }
if [ ! -e ${UPGRADE_RUNNING_FILE} ] && { [ "$(since ${UPGRADE_DONE_FILE})" -lt ${UPGRADE_INTERVAL_SECONDS} ] || [ "$(since ${UPGRADE_FAILED_FILE})" -lt ${UPGRADE_RETRY_SECONDS} ]; }; then
echo "${UPGRADE_PREFIX}skipped"
exit 0
fi
: > ${UPGRADE_RUNNING_FILE}
: > "$log"
fail() { echo "$now" > ${UPGRADE_FAILED_FILE}; rm -f ${UPGRADE_RUNNING_FILE}; echo "The upgrade failed. The last lines of $log:" >&2; tail -n 40 "$log" >&2; exit 1; }
run() { "$@" >> "$log" 2>&1 || fail; }
export DEBIAN_FRONTEND=noninteractive
${WSL_POLICY_INSTALL}
run dpkg --configure -a
run apt-get update
run apt-get -o DPkg::Lock::Timeout=300 -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade --with-new-pkgs
run apt-get clean
echo "$now" > ${UPGRADE_DONE_FILE}
rm -f ${UPGRADE_FAILED_FILE} ${UPGRADE_RUNNING_FILE}
echo "${UPGRADE_PREFIX}done $(grep -E '^[0-9]+ upgraded' "$log" | tail -n 1)"
}
main < /dev/null
`;

export interface WslUpgradeDeps {
  runner: ProcessRunner;
  /** The path of `wsl.exe` (findExecutable), or undefined (not on Windows, or without WSL). */
  wslPath: () => string | undefined;
  env: NodeJS.ProcessEnv;
  logger: Logger;
  /** Whether Devspaces set up the distribution (WslSetup.registration `own`): Devspaces changes no other one. */
  own: () => Promise<boolean>;
  /**
   * Whether the distribution runs (WslLifetime.running): a check never starts it, because only a flow of the user
   * starts it (the Monitor that runs permanently starts it anyway). Undefined: not known.
   */
  runs: (distribution: string) => Promise<boolean | undefined>;
  /** For the tests. Default: Date.now. */
  now?: () => number;
  /** For the tests. Default: UPGRADE_DELAY_MS. */
  delayMs?: number;
}

export class WslUpgrade {
  /** The time of the last check of this window. */
  private checkedAt: number | undefined;
  /** The timer of the next check, while it waits. */
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The check that runs now. */
  private checking: Promise<void> | undefined;
  private disposed = false;

  constructor(private readonly deps: WslUpgradeDeps) {}

  /**
   * The window uses the distribution `distribution` (WslLifetime.use): a check follows after UPGRADE_DELAY_MS, unless
   * one waits or runs, or the last one of this window is less than UPGRADE_CHECK_MS ago. Only for the distribution of
   * Devspaces, and not after `dispose`. Never throws.
   */
  schedule(distribution: string): void {
    if (this.disposed || distribution !== WSL_DISTRIBUTION || this.timer !== undefined || this.checking !== undefined) return;
    if (this.checkedAt !== undefined && Math.abs(this.now() - this.checkedAt) < UPGRADE_CHECK_MS) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.check();
    }, this.deps.delayMs ?? UPGRADE_DELAY_MS);
    this.timer.unref?.();
  }

  /**
   * Runs the script of the upgrade (UPGRADE_SCRIPT) in the distribution of Devspaces, while it runs and when Devspaces
   * set it up, and logs an upgrade that ended, or failed. Calls at the same time share one check. Never throws (logged).
   */
  check(): Promise<void> {
    this.checking ??= this.runCheck().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  /** Stops a check that waits; one that runs ends by itself. */
  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /**
   * A check counts for UPGRADE_CHECK_MS unless it found the distribution stopped: then the next use schedules a check
   * again. The state of the distribution is read last, right before the run, so that the run starts no distribution
   * that stopped during the check of the owner.
   */
  private async runCheck(): Promise<void> {
    let counts = true;
    try {
      const wsl = this.deps.wslPath();
      if (wsl === undefined || this.disposed || !(await this.deps.own()) || this.disposed) return;
      if ((await this.deps.runs(WSL_DISTRIBUTION)) !== true) {
        counts = false;
        return;
      }
      if (this.disposed) return;
      const result = await this.deps.runner.run(wsl, wslCommandArgs(WSL_DISTRIBUTION, ['sh', '-s']), {
        input: UPGRADE_SCRIPT,
        timeoutMs: UPGRADE_MS,
        env: wslEnv(this.deps.env),
      });
      this.report(result);
    } catch (error) {
      this.deps.logger.warn(`The weekly upgrade of the packages of the WSL distribution ${WSL_DISTRIBUTION} could not run: ${errorMessage(error)}`);
    } finally {
      if (counts) this.checkedAt = this.now();
    }
  }

  private report(result: RunResult): void {
    const line = wslText(result.stdout)
      .split(/\r?\n/)
      .find((text) => text.startsWith(UPGRADE_PREFIX));
    if (result.timedOut) {
      this.deps.logger.warn(
        `The weekly upgrade of the packages of the WSL distribution ${WSL_DISTRIBUTION} did not end within ${UPGRADE_MS / 60_000} minutes; ` +
          `it may go on in the distribution. Its output is in ${UPGRADE_LOG} there.`,
      );
      return;
    }
    if (result.exitCode !== 0 || line === undefined) {
      this.deps.logger.warn(`The weekly upgrade of the packages of the WSL distribution ${WSL_DISTRIBUTION} failed (${endOf(result, UPGRADE_MS)}): ${outputOf(result)}`);
      return;
    }
    const answer = line.slice(UPGRADE_PREFIX.length).trim();
    if (!answer.startsWith('done')) return;
    const summary = answer.slice('done'.length).trim();
    const of = `(apt-get upgrade${summary ? `: ${summary}` : ''})`;
    const kept = Number(/\b(\d+) not upgraded\b/.exec(summary)?.[1] ?? 0);
    if (!/^0 upgraded, 0 newly installed\b/.test(summary)) {
      this.deps.logger.info(
        `The packages of the WSL distribution ${WSL_DISTRIBUTION} were upgraded ${of}. ` +
          `Docker and other services there run the new versions after the next start of the distribution; running devspaces go on.`,
      );
    } else if (kept === 0) {
      this.deps.logger.info(`The packages of the WSL distribution ${WSL_DISTRIBUTION} are up to date ${of}.`);
    }
    if (kept > 0) {
      this.deps.logger.warn(
        `The weekly upgrade kept ${kept} package(s) of the WSL distribution ${WSL_DISTRIBUTION} back: their new versions need the removal of ` +
          `other packages, which it never does ${of}. To upgrade them, run "wsl -d ${WSL_DISTRIBUTION} -u root -- apt-get full-upgrade" in a terminal.`,
      );
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}
