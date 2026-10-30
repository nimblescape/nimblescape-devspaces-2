// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The weekly upgrade of the WSL distribution of Devspaces (src/core/docker/wslUpgrade.ts UPGRADE_SCRIPT), as root in a
// container of Debian 13, the release of the Debian file of WSL, with the real dpkg and apt: the summary line of apt,
// the times of the run, the policy-rc.d only for the time of the run, and a skip within the week. Without a
// network, `apt-get update` with APT::Update::Error-Mode=any fails (by default it only warns). The Debian images of
// Docker have a /usr/sbin/policy-rc.d; the Debian file of WSL has none, so the tests remove it first.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UPGRADE_DONE_FILE, UPGRADE_SCRIPT, UPGRADE_TRIED_FILE, upgradeCounts } from '../../src/core/docker/wslUpgrade';
import { TEST_RUN_LABEL, removeRunObjects } from './dockerRun';
import { dockerTestContext } from './harness';

/** Debian 13 (trixie) that the engine has: the base of the helper image (resources/helper/Dockerfile). */
const DEBIAN_IMAGE = process.env.DEVSPACE_TEST_GLIBC_IMAGE ?? 'node:24-trixie-slim';

describe('the weekly upgrade of the WSL distribution', () => {
  const { run, cli, log } = dockerTestContext('wslUpgrade');

  /** A running container of Debian 13 with the label of the run, without the policy-rc.d of the image. */
  function startDebian(name: string, options: { network?: 'none' } = {}): string {
    const container = `devspaces-test-${name}-${run.runId}`;
    const network = options.network ? ['--network', options.network] : [];
    cli.ok(['run', '-d', '--name', container, '--label', `${TEST_RUN_LABEL}=${run.runId}`, ...network, DEBIAN_IMAGE, 'sleep', 'infinity']);
    shell(container, 'rm -f /usr/sbin/policy-rc.d');
    return container;
  }

  function shell(container: string, script: string): string {
    return cli.ok(['exec', container, 'sh', '-c', script]);
  }

  beforeAll(() => {
    if (cli.image(DEBIAN_IMAGE) === undefined) cli.ok(['pull', DEBIAN_IMAGE]);
  });

  afterAll(() => {
    removeRunObjects(cli, run.runId);
  });

  it('upgrades with the real apt, tells its summary, writes the times, and skips within the week', () => {
    const container = startDebian('wsl-upgrade');
    const result = cli.run(['exec', '-i', container, 'sh', '-s'], UPGRADE_SCRIPT);
    log.info(`The upgrade in ${container} ended with ${result.code}.\n${result.out}\n${result.err}`);
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    const summary = /^devspaces-upgrade done (.*)$/.exec(result.out)?.[1] ?? '';
    // The summary of apt (the format of apt 3.0, or the one before), which the extension reads.
    expect(summary).toMatch(/^(\d+ upgraded, |Upgrading: \d+, )/);
    expect(upgradeCounts(summary)).toBeDefined();
    const seconds = Math.floor(Date.now() / 1000);
    for (const name of [UPGRADE_DONE_FILE, UPGRADE_TRIED_FILE]) {
      expect(Math.abs(Number(shell(container, `cat ${name}`)) - seconds)).toBeLessThan(600);
    }
    expect(shell(container, 'test -e /usr/sbin/policy-rc.d && echo present || echo absent')).toBe('absent');
    expect(cli.run(['exec', '-i', container, 'sh', '-s'], UPGRADE_SCRIPT).out).toBe('devspaces-upgrade skipped');
  });

  it('fails apt-get update without a network with APT::Update::Error-Mode=any, which only warns by default', () => {
    const container = startDebian('wsl-upgrade-offline', { network: 'none' });
    expect(shell(container, 'apt-get update >/dev/null 2>&1; echo $?')).toBe('0');
    expect(shell(container, 'apt-get -o APT::Update::Error-Mode=any update >/dev/null 2>&1; echo $?')).not.toBe('0');
    expect(UPGRADE_SCRIPT).toContain('apt-get -o APT::Update::Error-Mode=any update');
  });
});
