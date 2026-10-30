// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The weekly upgrade of the packages of the WSL distribution of Devspaces (docs/architecture.md "The WSL distribution
// of Devspaces"): `apt-get upgrade` as root there, about once a week, with its result in the log of Devspaces. No
// service starts again during it (the policy-rc.d of the setup), so Docker and the running devspaces go on, and the
// new versions of Docker and other services run after the next start of the distribution. A window that uses the
// distribution checks a few minutes after its first use, and then at most every 6 hours; the time of the last upgrade
// is in the distribution, so all windows and VS Code products share it. Only in a distribution that Devspaces set up,
// and only with the lock of its setup for all windows, so that no setup or removal comes between. No `vscode`.
import { errorMessage } from '../errors';
import type { Logger, ProcessRunner, RunResult } from '../ports';
import { WSL_DISTRIBUTION, wslCommandArgs, wslEnv, wslText } from './dockerHost';
import { WSL_POLICY_INSTALL, WSL_POLICY_MARK, WSL_SETUP_LOCK, duration, endOf, outputOf } from './wslSetup';

/** The folder of the times of the upgrade in the distribution. */
export const UPGRADE_STATE_DIR = '/var/lib/devspaces';
/** The time (seconds since 1970) of the last upgrade that ended well. */
export const UPGRADE_DONE_FILE = `${UPGRADE_STATE_DIR}/upgraded`;
/**
 * The time (seconds since 1970) of the last upgrade that began, so that one that did not end well (a failure, the stop
 * of the distribution, the time limit) is tried again only after a day.
 */
export const UPGRADE_TRIED_FILE = `${UPGRADE_STATE_DIR}/upgrade-tried`;
/** The log of the last upgrade in the distribution. */
export const UPGRADE_LOG = '/var/log/devspaces-upgrade.log';
/** An upgrade runs when the last one that ended well is this old. */
export const UPGRADE_INTERVAL_SECONDS = 7 * 24 * 60 * 60;
/** An upgrade runs only when the last one that began is this old. */
export const UPGRADE_RETRY_SECONDS = 24 * 60 * 60;
/** While dpkg has packages that a run left unfinished (`dpkg --audit`), the last one that began needs only be this old. */
export const UPGRADE_REPAIR_SECONDS = 60 * 60;
/** The start of the line of the script that tells its result: `busy`, `skipped`, or `done <the summary of apt-get>`. */
export const UPGRADE_PREFIX = 'devspaces-upgrade ';
/** The time limit of the script. */
export const UPGRADE_MS = 30 * 60_000;
/** The wait after the first use of the distribution in a window, so that the upgrade does not slow the start of a devspace. */
export const UPGRADE_DELAY_MS = 5 * 60_000;
/** A window checks at most this often. */
export const UPGRADE_CHECK_MS = 6 * 60 * 60_000;

/**
 * The script of the upgrade (`sh -s`, as root). It runs only with the lock of the setup in the distribution (another
 * setup or upgrade runs: `busy`), and only when the last upgrade that ended well is a week old and the last one that
 * began is a day old; else `skipped`. While dpkg has packages that a run left unfinished (`dpkg --audit`, for example
 * after the stop of the distribution in the middle of dpkg), it runs when the last one that began is an hour old, and
 * `dpkg --configure -a` ends the unfinished one. A time after now (a clock that went back) counts as none. Without its
 * own policy-rc.d (one of another program is there), it fails and keeps the log of the last run: then the packages
 * could start Docker again. `APT::Update::Error-Mode=any` makes a network failure of `apt-get update` a failure (by
 * default only a warning, and the upgrade would count as done with the old lists). `apt-get upgrade` waits up to 5 minutes for the lock of dpkg; `dpkg --configure -a`
 * and `apt-get update`, which do not wait for a lock, run up to 3 times, 30 seconds apart (`apt-get check` of the timer
 * apt-daily, or apt of the user). `--with-new-pkgs` also installs a new package that an upgrade needs, but removes
 * none. The summary line of apt is in the format of apt before 3.0 or in that of apt 3.0 (`Upgrading: …`); `LC_ALL=C`
 * keeps it in English. On a failure, standard error gets the last lines of its log.
 *
 * The commands get no copy of the descriptor of the lock (`9>&-`): a process that a maintainer script leaves behind
 * would hold the lock until the next start of the distribution. The script ignores SIGHUP, and so do the commands: when
 * `wsl.exe` ends at the time limit, a hangup must not end the script in the middle of dpkg, and its trap must not
 * remove the policy-rc.d while dpkg still runs.
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
retry=${UPGRADE_RETRY_SECONDS}
if [ -n "$(dpkg --audit 2>/dev/null)" ]; then
retry=${UPGRADE_REPAIR_SECONDS}
elif [ "$(since ${UPGRADE_DONE_FILE})" -lt ${UPGRADE_INTERVAL_SECONDS} ]; then
echo "${UPGRADE_PREFIX}skipped"
exit 0
fi
if [ "$(since ${UPGRADE_TRIED_FILE})" -lt "$retry" ]; then
echo "${UPGRADE_PREFIX}skipped"
exit 0
fi
echo "$now" > ${UPGRADE_TRIED_FILE}
fail() { echo "The upgrade failed. The last lines of $log:" >&2; tail -n 40 "$log" >&2; exit 1; }
run() { "$@" 9>&- >> "$log" 2>&1 || fail; }
again() { tries=1; until "$@" 9>&- >> "$log" 2>&1; do [ "$tries" -lt 3 ] || fail; tries=$((tries + 1)); sleep 30 9>&-; done; }
export DEBIAN_FRONTEND=noninteractive LC_ALL=C
${WSL_POLICY_INSTALL}
if ! grep -qxF '${WSL_POLICY_MARK}' /usr/sbin/policy-rc.d 2>/dev/null; then
echo "The upgrade did not run: /usr/sbin/policy-rc.d of another program is there, so the packages could start Docker again and stop the running devspaces." >&2
exit 1
fi
trap '' HUP
: > "$log"
again dpkg --configure -a
again apt-get -o APT::Update::Error-Mode=any update
run apt-get -o DPkg::Lock::Timeout=300 -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade --with-new-pkgs
run apt-get clean
echo "$now" > ${UPGRADE_DONE_FILE}
echo "${UPGRADE_PREFIX}done $(grep -E '^[0-9]+ upgraded, |^ *Upgrading: [0-9]+, ' "$log" | tail -n 1 | sed 's/^ *//')"
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
   * Runs `task` with the lock of the setup for all windows (WslSetup.locked); undefined, without `task`, while a setup,
   * a removal or an upgrade of a window holds it.
   */
  locked: (task: () => Promise<void>) => Promise<{ value: void } | undefined>;
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
    if (this.disposed || distribution.toLowerCase() !== WSL_DISTRIBUTION || this.timer !== undefined || this.checking !== undefined) return;
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
   * A check counts for UPGRADE_CHECK_MS unless it found the distribution stopped (a state that is not known counts):
   * then the next use schedules a check again. The state of the distribution is read last, under the lock and right before the run, so that the run starts
   * no distribution that stopped meanwhile. A lock that another window holds skips the check.
   */
  private async runCheck(): Promise<void> {
    let counts = true;
    try {
      const wsl = this.deps.wslPath();
      if (wsl === undefined || this.disposed || !(await this.deps.own()) || this.disposed) return;
      await this.deps.locked(async () => {
        // Again under the lock: a removal in another window may have come before it.
        if (this.disposed || !(await this.deps.own()) || this.disposed) return;
        const runs = await this.deps.runs(WSL_DISTRIBUTION);
        if (runs !== true) {
          // A state that is not known counts, so that a `wsl.exe` that fails does not get a check at each use.
          counts = runs === undefined;
          return;
        }
        if (this.disposed) return;
        const result = await this.deps.runner.run(wsl, wslCommandArgs(WSL_DISTRIBUTION, ['sh', '-s']), {
          input: UPGRADE_SCRIPT,
          timeoutMs: UPGRADE_MS,
          env: wslEnv(this.deps.env),
        });
        this.report(result);
      });
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
        `The weekly upgrade of the packages of the WSL distribution ${WSL_DISTRIBUTION} did not end within ${duration(UPGRADE_MS)}; ` +
          `it goes on in the distribution while the distribution runs. When the distribution stops before its end, the next try is a day later, or an hour later when dpkg did not finish. ` +
          `Its output is in ${UPGRADE_LOG} there.`,
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
    const counts = upgradeCounts(summary);
    if (counts === undefined) {
      this.deps.logger.info(`The weekly upgrade of the packages of the WSL distribution ${WSL_DISTRIBUTION} ended ${of}. Its output is in ${UPGRADE_LOG} there.`);
      return;
    }
    const { changed, kept } = counts;
    if (changed > 0) {
      this.deps.logger.info(
        `The packages of the WSL distribution ${WSL_DISTRIBUTION} were upgraded ${of}. ` +
          `Docker and other services there run the new versions after the next start of the distribution; running devspaces go on.`,
      );
    } else if (kept === 0) {
      this.deps.logger.info(`The packages of the WSL distribution ${WSL_DISTRIBUTION} are up to date ${of}.`);
    }
    if (kept > 0) {
      this.deps.logger.info(
        `The weekly upgrade kept ${kept} package(s) of the WSL distribution ${WSL_DISTRIBUTION} back ${of}: packages on hold (apt-mark hold), ` +
          `or new versions that need the removal of other packages, which it never does. ` +
          `"wsl -d ${WSL_DISTRIBUTION} -u root -- apt-get full-upgrade" in a terminal upgrades the latter; it restarts Docker, so stop your devspaces there first.`,
      );
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

/**
 * The numbers of the summary line of `apt-get upgrade`: the packages that it upgraded or installed (`changed`), and
 * those that it kept back (`kept`). Both formats: `3 upgraded, 1 newly installed, 0 to remove and 2 not upgraded.`
 * (apt before 3.0) and `Upgrading: 3, Installing: 1, Removing: 0, Not Upgrading: 2` (apt 3.0). Undefined for another
 * text.
 */
export function upgradeCounts(summary: string): { changed: number; kept: number } | undefined {
  const match =
    /^(\d+) upgraded, (\d+) newly installed, .*\b(\d+) not upgraded\b/.exec(summary) ?? /^Upgrading: (\d+), Installing: (\d+), .*\bNot Upgrading: (\d+)\b/.exec(summary);
  if (match === null) return undefined;
  return { changed: Number(match[1]) + Number(match[2]), kept: Number(match[3]) };
}
