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
  UPGRADE_FAILED_FILE,
  UPGRADE_INTERVAL_SECONDS,
  UPGRADE_LOG,
  UPGRADE_MS,
  UPGRADE_RETRY_SECONDS,
  UPGRADE_SCRIPT,
  UPGRADE_STATE_DIR,
  WslUpgrade,
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

  function upgrade(answer: RunResult | Error = result(0, 'devspaces-upgrade done 3 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n'), own = true, runs: boolean | null = true) {
    const log = logger();
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
      runs: runsCheck,
      now: () => now,
    });
    return { subject, log, calls, ownCheck, runsCheck };
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
  // Mutation: a check that counts without a running distribution waits 6 hours after a short use of the distribution.
  it('starts no distribution that does not run, or whose state is not known, and checks again at the next use', async () => {
    for (const runs of [false, null]) {
      const { subject, calls, runsCheck, ownCheck } = upgrade(undefined, true, runs);
      subject.schedule('devspaces');
      await vi.advanceTimersByTimeAsync(UPGRADE_DELAY_MS);
      expect(runsCheck).toHaveBeenCalledWith('devspaces');
      expect(ownCheck).not.toHaveBeenCalled();
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

  it('shares a check that runs, and stops one that waits at dispose', async () => {
    const { subject, calls } = upgrade();
    await Promise.all([subject.check(), subject.check()]);
    expect(calls).toHaveLength(1);
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
   * `apt-get` that write their arguments (and whether the policy-rc.d is there) to the file `calls`. `dpkg --audit`
   * prints `audit` and writes nothing.
   */
  function runScript(options: { failUpdate?: boolean; audit?: string } = {}) {
    const bin = file('bin');
    fs.mkdirSync(bin, { recursive: true });
    const stub = (name: string, first: string[], extra: string[] = []) =>
      fs.writeFileSync(
        path.join(bin, name),
        ['#!/bin/sh', ...first, `echo "${name} $* policy=$([ -e '${file('policy-rc.d')}' ] && echo yes || echo no)" >> '${file('calls')}'`, ...extra].join('\n'),
        { mode: 0o755 },
      );
    stub('dpkg', [`[ "$1" = --audit ] && { printf '%s' '${options.audit ?? ''}'; exit 0; }`]);
    stub('apt-get', [], [
      options.failUpdate ? 'case "$*" in update) echo "E: Could not resolve deb.debian.org"; exit 100;; esac' : ':',
      'case "$*" in *upgrade*) echo "3 upgraded, 1 newly installed, 0 to remove and 0 not upgraded.";; esac',
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
    const written = Number(fs.readFileSync(stamp(UPGRADE_DONE_FILE), 'utf8').trim());
    expect(Math.abs(written - seconds())).toBeLessThan(60);
    expect(fs.existsSync(stamp(UPGRADE_FAILED_FILE))).toBe(false);
  });

  // Mutation: a script without the check of the times upgrades at each window start; one that tries a failure again at
  // once runs `apt-get update` at each window start while the network is down; one that skips packages that `dpkg
  // --audit` names leaves an interrupted upgrade for a week.
  it('skips the upgrade within a week after the last one and within a day after a failure, and ends an interrupted one', () => {
    fs.mkdirSync(state(), { recursive: true });
    const write = (name: string, ago: number) => fs.writeFileSync(stamp(name), `${seconds() - ago}\n`);
    write(UPGRADE_DONE_FILE, UPGRADE_INTERVAL_SECONDS - 60);
    expect(runScript().stdout.trim()).toBe('devspaces-upgrade skipped');
    write(UPGRADE_DONE_FILE, UPGRADE_INTERVAL_SECONDS + 60);
    write(UPGRADE_FAILED_FILE, UPGRADE_RETRY_SECONDS - 60);
    expect(runScript().stdout.trim()).toBe('devspaces-upgrade skipped');
    // Within a day after a failure, also with packages that `dpkg --audit` names (a package that never configures).
    expect(runScript({ audit: 'The following packages are only half configured' }).stdout.trim()).toBe('devspaces-upgrade skipped');
    expect(calls()).toEqual([]);
    // An upgrade that the stop of the distribution interrupted (no failure written) is ended within the week.
    fs.rmSync(stamp(UPGRADE_FAILED_FILE));
    write(UPGRADE_DONE_FILE, 60);
    expect(runScript({ audit: 'The following packages are only half configured' }).stdout.trim()).toMatch(/^devspaces-upgrade done /);
    expect(calls()[0]).toBe('dpkg --configure -a policy=yes');
    fs.rmSync(file('calls'));
    write(UPGRADE_DONE_FILE, UPGRADE_INTERVAL_SECONDS + 60);
    write(UPGRADE_FAILED_FILE, UPGRADE_RETRY_SECONDS + 60);
    expect(runScript().stdout.trim()).toMatch(/^devspaces-upgrade done /);
    expect(fs.existsSync(stamp(UPGRADE_FAILED_FILE))).toBe(false);
    // A time after now (a clock that went back) counts as none.
    write(UPGRADE_DONE_FILE, -UPGRADE_INTERVAL_SECONDS);
    write(UPGRADE_FAILED_FILE, -UPGRADE_RETRY_SECONDS);
    expect(runScript().stdout.trim()).toMatch(/^devspaces-upgrade done /);
    // A time that is not a number counts as none.
    fs.writeFileSync(stamp(UPGRADE_DONE_FILE), 'x\n');
    fs.writeFileSync(stamp(UPGRADE_FAILED_FILE), '\n');
    expect(runScript().stdout.trim()).toMatch(/^devspaces-upgrade done /);
  });

  it('fails with the last lines of its log, and tries again only after a day', () => {
    const run = runScript({ failUpdate: true });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`The upgrade failed. The last lines of ${file('upgrade.log')}:\nE: Could not resolve deb.debian.org`);
    expect(fs.existsSync(stamp(UPGRADE_DONE_FILE))).toBe(false);
    expect(Math.abs(Number(fs.readFileSync(stamp(UPGRADE_FAILED_FILE), 'utf8').trim()) - seconds())).toBeLessThan(60);
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
