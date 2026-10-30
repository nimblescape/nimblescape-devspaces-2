// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunOptions, RunResult } from '../ports';
import { wslCommandArgs } from './dockerHost';
import { WSL_SETUP_LOCK } from './wslSetup';
import {
  UPGRADE_CHECK_MS,
  UPGRADE_DELAY_MS,
  UPGRADE_DONE_FILE,
  UPGRADE_INTERVAL_SECONDS,
  UPGRADE_LOG,
  UPGRADE_MS,
  UPGRADE_RETRY_SECONDS,
  UPGRADE_SCRIPT,
  UPGRADE_STATE_DIR,
  UPGRADE_TRIED_FILE,
  WslUpgrade,
  upgradeCounts,
} from './wslUpgrade';

const WSL = 'C:\\Windows\\System32\\wsl.exe';
const result = (exitCode: number | null, stdout = '', stderr = '', timedOut = false): RunResult => ({ exitCode, stdout, stderr, timedOut });
const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() });

describe('WslUpgrade', () => {
  let now = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    now = 1_000_000;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function upgrade(
    answer: RunResult | Error = result(0, 'devspaces-upgrade done 3 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n'),
    own = true,
    runs: boolean | null = true,
    free = true,
  ) {
    const log = logger();
    // The lock of the setup for all windows: `free` false stands for another window that holds it.
    const lockedTask = vi.fn(async (task: () => Promise<void>) => (free ? { value: await task() } : undefined));
    const calls: { file: string; args: readonly string[]; options?: RunOptions }[] = [];
    const ownCheck = vi.fn(async () => own);
    // `null` stands for a state that is not known (a default parameter takes the place of `undefined`).
    const runsCheck = vi.fn(async (_distribution: string) => runs ?? undefined);
    const subject = new WslUpgrade({
      runner: {
        run: vi.fn(async (file: string, args: readonly string[], options?: RunOptions) => {
          calls.push({ file, args, options });
          if (answer instanceof Error) throw answer;
          return answer;
        }),
      },
      wslPath: () => WSL,
      env: {},
      logger: log,
      own: ownCheck,
      locked: lockedTask,
      runs: runsCheck,
      now: () => now,
    });
    return { subject, log, calls, ownCheck, runsCheck, lockedTask };
  }

  // Mutation: a check at once fails it (the upgrade would slow the start of a devspace); so does a check for another
  // distribution, or one at each use.
  it('checks a few minutes after the first use of the distribution of Devspaces, and then at most every 6 hours', async () => {
    const { subject, calls, log } = upgrade();
    subject.schedule('Ubuntu');
    subject.schedule('devspaces');
    subject.schedule('devspaces');
    await vi.advanceTimersByTimeAsync(UPGRADE_DELAY_MS - 1);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ file: WSL, args: wslCommandArgs('devspaces', ['sh', '-s']), options: { input: UPGRADE_SCRIPT, timeoutMs: UPGRADE_MS } });
    expect(calls[0].options?.env?.WSL_UTF8).toBe('1');
    expect(log.info).toHaveBeenCalledWith(
      'The packages of the WSL distribution devspaces were upgraded (apt-get upgrade: 3 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.). ' +
        'Docker and other services there run the new versions after the next start of the distribution; running devspaces go on.',
    );
    now += UPGRADE_CHECK_MS - 1;
    subject.schedule('devspaces');
    await vi.advanceTimersByTimeAsync(UPGRADE_DELAY_MS);
    expect(calls).toHaveLength(1);
    now += 1;
    subject.schedule('devspaces');
    await vi.advanceTimersByTimeAsync(UPGRADE_DELAY_MS);
    expect(calls).toHaveLength(2);
  });

  // Mutation: a check without the check of the owner fails it: Devspaces changes no distribution that the user made.
  it('changes no distribution that Devspaces did not set up', async () => {
    const { subject, calls, ownCheck } = upgrade(undefined, false);
    await subject.check();
    expect(ownCheck).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
  });

  // Mutation: a check without the check of the state fails it: work in the background starts no distribution that WSL
  // stopped (only a flow of the user, or a Monitor that runs permanently).
  // Mutation: a check without the lock of the setup can run between the steps of a setup or a removal in another window
  // (its `wsl --terminate` would stop the upgrade in the middle of dpkg); one that reads the state outside the lock
  // can start a distribution that a removal stopped.
  it('runs only with the lock of the setup for all windows, and skips the check while another window holds it', async () => {
    const free = upgrade();
    await free.subject.check();
    expect(free.lockedTask).toHaveBeenCalledTimes(1);
    expect(free.lockedTask.mock.invocationCallOrder[0]).toBeLessThan(free.runsCheck.mock.invocationCallOrder[0]);
    expect(free.calls).toHaveLength(1);
    const held = upgrade(undefined, true, true, false);
    await held.subject.check();
    expect(held.runsCheck).not.toHaveBeenCalled();
    expect(held.calls).toEqual([]);
    expect(held.log.warn).not.toHaveBeenCalled();
    expect(held.log.info).not.toHaveBeenCalled();
  });

  // Mutation: a check that counts without a running distribution waits 6 hours after a short use of the distribution;
  // one that reads the state before the owner leaves more time for the distribution to stop before the run.
  it('starts no distribution that does not run, or whose state is not known, and checks again at the next use', async () => {
    for (const runs of [false, null]) {
      const { subject, calls, runsCheck, ownCheck } = upgrade(undefined, true, runs);
      subject.schedule('devspaces');
      await vi.advanceTimersByTimeAsync(UPGRADE_DELAY_MS);
      expect(runsCheck).toHaveBeenCalledWith('devspaces');
      expect(ownCheck.mock.invocationCallOrder[0]).toBeLessThan(runsCheck.mock.invocationCallOrder[0]);
      expect(calls).toEqual([]);
      subject.schedule('devspaces');
      await vi.advanceTimersByTimeAsync(UPGRADE_DELAY_MS);
      expect(runsCheck).toHaveBeenCalledTimes(2);
    }
  });

  it('logs nothing when the script skipped the upgrade or another run held the lock, and warns of a failure', async () => {
    const current = upgrade(result(0, 'devspaces-upgrade done 0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n'));
    await current.subject.check();
    expect(current.log.info).toHaveBeenCalledWith(
      'The packages of the WSL distribution devspaces are up to date (apt-get upgrade: 0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.).',
    );
    const skipped = upgrade(result(0, 'devspaces-upgrade skipped\n'));
    await skipped.subject.check();
    const busy = upgrade(result(0, 'devspaces-upgrade busy\n'));
    await busy.subject.check();
    for (const { log } of [skipped, busy]) {
      expect(log.info).not.toHaveBeenCalled();
      expect(log.warn).not.toHaveBeenCalled();
    }
    const failed = upgrade(result(1, '', 'The upgrade failed. The last lines of /var/log/devspaces-upgrade.log:\nE: Could not resolve deb.debian.org'));
    await failed.subject.check();
    expect(failed.log.warn).toHaveBeenCalledWith(
      'The weekly upgrade of the packages of the WSL distribution devspaces failed (exit code 1): The upgrade failed. The last lines of /var/log/devspaces-upgrade.log:\nE: Could not resolve deb.debian.org',
    );
    const timedOut = upgrade(result(null, '', '', true));
    await timedOut.subject.check();
    expect(timedOut.log.warn).toHaveBeenCalledWith(
      'The weekly upgrade of the packages of the WSL distribution devspaces did not end within 30 minutes; it may go on in the distribution. ' +
        'Its output is in /var/log/devspaces-upgrade.log there.',
    );
    const thrown = upgrade(new Error('spawn EACCES'));
    await expect(thrown.subject.check()).resolves.toBeUndefined();
    expect(thrown.log.warn).toHaveBeenCalledWith('The weekly upgrade of the packages of the WSL distribution devspaces could not run: spawn EACCES');
  });

  // Mutation: a summary of apt 3.0 that is not read says "were upgraded" each week, also when nothing changed.
  it('reads the summary of apt before 3.0 and of apt 3.0', async () => {
    expect(upgradeCounts('3 upgraded, 1 newly installed, 0 to remove and 2 not upgraded.')).toEqual({ changed: 4, kept: 2 });
    expect(upgradeCounts('0 upgraded, 0 newly installed, 1 downgraded, 0 to remove and 0 not upgraded.')).toEqual({ changed: 0, kept: 0 });
    expect(upgradeCounts('Upgrading: 3, Installing: 1, Removing: 0, Not Upgrading: 2')).toEqual({ changed: 4, kept: 2 });
    expect(upgradeCounts('Upgrading: 0, Installing: 0, Reinstalling: 1, Removing: 0, Not Upgrading: 0')).toEqual({ changed: 0, kept: 0 });
    expect(upgradeCounts('')).toBeUndefined();
    const current = upgrade(result(0, 'devspaces-upgrade done Upgrading: 0, Installing: 0, Removing: 0, Not Upgrading: 0\n'));
    await current.subject.check();
    expect(current.log.info).toHaveBeenCalledWith(
      'The packages of the WSL distribution devspaces are up to date (apt-get upgrade: Upgrading: 0, Installing: 0, Removing: 0, Not Upgrading: 0).',
    );
    const unknown = upgrade(result(0, 'devspaces-upgrade done \n'));
    await unknown.subject.check();
    expect(unknown.log.info).toHaveBeenCalledWith(
      'The weekly upgrade of the packages of the WSL distribution devspaces ended (apt-get upgrade). Its output is in /var/log/devspaces-upgrade.log there.',
    );
  });

  it('warns of packages that the upgrade kept back', async () => {
    const kept = upgrade(result(0, 'devspaces-upgrade done 0 upgraded, 0 newly installed, 0 to remove and 2 not upgraded.\n'));
    await kept.subject.check();
    expect(kept.log.info).not.toHaveBeenCalled();
    expect(kept.log.warn).toHaveBeenCalledWith(
      'The weekly upgrade kept 2 package(s) of the WSL distribution devspaces back: their new versions need the removal of other packages, which it ' +
        'never does (apt-get upgrade: 0 upgraded, 0 newly installed, 0 to remove and 2 not upgraded.). ' +
        'To upgrade them, run "wsl -d devspaces -u root -- apt-get full-upgrade" in a terminal.',
    );
    const both = upgrade(result(0, 'devspaces-upgrade done 3 upgraded, 0 newly installed, 0 to remove and 1 not upgraded.\n'));
    await both.subject.check();
    expect(both.log.info).toHaveBeenCalledWith(expect.stringMatching(/^The packages of the WSL distribution devspaces were upgraded/));
    expect(both.log.warn).toHaveBeenCalledWith(expect.stringMatching(/^The weekly upgrade kept 1 package\(s\)/));
  });

  // Mutation: a check that does not look at `disposed` after its waits starts an upgrade of 30 minutes from a window
  // that closed.
  it('shares a check that runs, stops one that waits at dispose, and starts no run after dispose', async () => {
    const { subject, calls } = upgrade();
    await Promise.all([subject.check(), subject.check()]);
    expect(calls).toHaveLength(1);
    const closing = upgrade();
    const checked = closing.subject.check();
    closing.subject.dispose();
    await checked;
    expect(closing.calls).toEqual([]);
    const other = upgrade();
    other.subject.schedule('devspaces');
    other.subject.dispose();
    await vi.advanceTimersByTimeAsync(UPGRADE_DELAY_MS);
    other.subject.schedule('devspaces');
    await vi.advanceTimersByTimeAsync(UPGRADE_DELAY_MS);
    expect(other.calls).toEqual([]);
  });
});

describe('the script of the upgrade', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-upgrade-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const state = () => path.join(dir, 'state');
  const file = (name: string) => path.join(dir, name);
  /** The file of a time (UPGRADE_DONE_FILE, UPGRADE_FAILED_FILE) in the temporary folder. */
  const stamp = (name: string) => path.join(state(), path.basename(name));

  /**
   * Runs the script with the real `sh`, `flock` and `date`, its paths in the temporary folder, and stubs of `dpkg` and
   * `apt-get` that write their arguments (and whether the policy-rc.d is there) to the file `calls`. `failUpdate`: the
   * number of runs of `apt-get update` that fail (all: true). `summary`: the summary line of the stub of
   * `apt-get upgrade`. `sleep` writes its argument to `calls` and returns at once.
   */
  function runScript(options: { failUpdate?: boolean | number; summary?: string } = {}) {
    const bin = file('bin');
    fs.mkdirSync(bin, { recursive: true });
    const stub = (name: string, first: string[], extra: string[] = []) =>
      fs.writeFileSync(
        path.join(bin, name),
        ['#!/bin/sh', ...first, `echo "${name} $* policy=$([ -e '${file('policy-rc.d')}' ] && echo yes || echo no)" >> '${file('calls')}'`, ...extra].join('\n'),
        { mode: 0o755 },
      );
    stub('dpkg', []);
    stub('sleep', []);
    const failures = options.failUpdate === true ? 1000 : (options.failUpdate ?? 0);
    stub('apt-get', [], [
      `case "$*" in update) n=$(grep -c '^apt-get update' '${file('calls')}'); [ "$n" -gt ${failures} ] || { echo "E: Could not resolve deb.debian.org"; exit 100; };; esac`,
      `case "$*" in *upgrade*) echo '${options.summary ?? '3 upgraded, 1 newly installed, 0 to remove and 0 not upgraded.'}';; esac`,
    ]);
    const script = UPGRADE_SCRIPT.split(UPGRADE_STATE_DIR)
      .join(state())
      .split(UPGRADE_LOG)
      .join(file('upgrade.log'))
      .split(WSL_SETUP_LOCK)
      .join(file('lock'))
      .split('/usr/sbin/policy-rc.d')
      .join(file('policy-rc.d'));
    expect(script).not.toContain('/var/');
    expect(script).not.toContain('/run/');
    expect(script).not.toContain('/usr/sbin/');
    return spawnSync('sh', ['-s'], { input: script, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` } });
  }

  const calls = () => (fs.existsSync(file('calls')) ? fs.readFileSync(file('calls'), 'utf8').trim().split('\n') : []);
  const seconds = () => Math.floor(Date.now() / 1000);

  // Mutation: an upgrade without the policy-rc.d fails it (Docker would start again and stop the running devspaces);
  // so does one without `dpkg --configure -a` (an upgrade that the stop of the distribution interrupted stays so).
  it('upgrades with the policy-rc.d of the setup, writes the time, and tells the summary of apt-get', () => {
    const run = runScript();
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe('devspaces-upgrade done 3 upgraded, 1 newly installed, 0 to remove and 0 not upgraded.');
    expect(calls()).toEqual([
      'dpkg --configure -a policy=yes',
      'apt-get update policy=yes',
      'apt-get -o DPkg::Lock::Timeout=300 -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade --with-new-pkgs policy=yes',
      'apt-get clean policy=yes',
    ]);
    expect(fs.existsSync(file('policy-rc.d'))).toBe(false);
    for (const name of [UPGRADE_DONE_FILE, UPGRADE_TRIED_FILE]) {
      const written = Number(fs.readFileSync(stamp(name), 'utf8').trim());
      expect(Math.abs(written - seconds())).toBeLessThan(60);
    }
  });

  // Mutation: a script without LC_ALL=C gets a summary in the language of the distribution; one that reads only the
  // format before apt 3.0 tells no summary on Debian 13.
  it('tells the summary of apt 3.0, in English', () => {
    const run = runScript({ summary: '  Upgrading: 2, Installing: 0, Removing: 0, Not Upgrading: 1' });
    expect(run.stdout.trim()).toBe('devspaces-upgrade done Upgrading: 2, Installing: 0, Removing: 0, Not Upgrading: 1');
    expect(UPGRADE_SCRIPT).toContain('export DEBIAN_FRONTEND=noninteractive LC_ALL=C\n');
  });

  // Mutation: a script that does not try `apt-get update` again fails for a day while `apt-get check` of the timer
  // apt-daily holds the lock for a moment.
  it('runs apt-get update up to 3 times, 30 seconds apart', () => {
    expect(runScript({ failUpdate: 2 }).stdout.trim()).toMatch(/^devspaces-upgrade done /);
    expect(calls().filter((call) => /^(apt-get update|sleep)/.test(call))).toEqual([
      'apt-get update policy=yes',
      'sleep 30 policy=yes',
      'apt-get update policy=yes',
      'sleep 30 policy=yes',
      'apt-get update policy=yes',
    ]);
  });

  // Mutation: a script without the check of the times upgrades at each window start; one that tries a run that did not
  // end well again at once runs `apt-get update` at each check while the network is down, or a hung upgrade again.
  it('skips the upgrade within a week after the last one, and within a day after the last try', () => {
    fs.mkdirSync(state(), { recursive: true });
    const write = (name: string, ago: number) => fs.writeFileSync(stamp(name), `${seconds() - ago}\n`);
    write(UPGRADE_DONE_FILE, UPGRADE_INTERVAL_SECONDS - 60);
    expect(runScript().stdout.trim()).toBe('devspaces-upgrade skipped');
    // A try that did not end (the stop of the distribution, the time limit) leaves only its start.
    write(UPGRADE_DONE_FILE, UPGRADE_INTERVAL_SECONDS + 60);
    write(UPGRADE_TRIED_FILE, UPGRADE_RETRY_SECONDS - 60);
    expect(runScript().stdout.trim()).toBe('devspaces-upgrade skipped');
    expect(calls()).toEqual([]);
    write(UPGRADE_TRIED_FILE, UPGRADE_RETRY_SECONDS + 60);
    expect(runScript().stdout.trim()).toMatch(/^devspaces-upgrade done /);
    expect(calls()[0]).toBe('dpkg --configure -a policy=yes');
    // A time after now (a clock that went back) counts as none.
    write(UPGRADE_DONE_FILE, -UPGRADE_INTERVAL_SECONDS);
    write(UPGRADE_TRIED_FILE, -UPGRADE_RETRY_SECONDS);
    expect(runScript().stdout.trim()).toMatch(/^devspaces-upgrade done /);
    // A time that is not a number counts as none.
    fs.writeFileSync(stamp(UPGRADE_DONE_FILE), 'x\n');
    fs.writeFileSync(stamp(UPGRADE_TRIED_FILE), '\n');
    expect(runScript().stdout.trim()).toMatch(/^devspaces-upgrade done /);
  });

  it('fails with the last lines of its log, and tries again only after a day', () => {
    const run = runScript({ failUpdate: true });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`The upgrade failed. The last lines of ${file('upgrade.log')}:\nE: Could not resolve deb.debian.org`);
    expect(fs.existsSync(stamp(UPGRADE_DONE_FILE))).toBe(false);
    expect(Math.abs(Number(fs.readFileSync(stamp(UPGRADE_TRIED_FILE), 'utf8').trim()) - seconds())).toBeLessThan(60);
    expect(calls().filter((call) => call.startsWith('apt-get update'))).toHaveLength(3);
    expect(fs.existsSync(file('policy-rc.d'))).toBe(false);
    expect(runScript().stdout.trim()).toBe('devspaces-upgrade skipped');
  });

  // Mutation: a script without the lock runs next to a setup of Docker.
  it('runs nothing while a setup or another upgrade holds the lock', () => {
    // `flock` holds the lock while the script runs, as another run would.
    const script = UPGRADE_SCRIPT.split(WSL_SETUP_LOCK).join(file('lock'));
    const busy = spawnSync('flock', [file('lock'), 'sh', '-s'], { input: script, encoding: 'utf8' });
    expect(busy.status).toBe(0);
    expect(busy.stdout.trim()).toBe('devspaces-upgrade busy');
  });
});
