// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The script that sets up the WSL distribution of Devspaces (src/core/docker/wslSetup.ts PROVISION_SCRIPT), as root in a
// container of Debian 13, the release of the Debian file of WSL. Without a network it stops at its first step and names
// the last lines of its log; with the network it installs Docker Engine from download.docker.com, enables its service
// for systemd without starting it, and can run again. WSL itself (the registration, systemd, the restart) is not here.
// The Debian images of Docker have a /usr/sbin/policy-rc.d that keeps services from starting; the Debian file of WSL has
// none, so the tests remove it first, and the script brings its own for the time of the installation. Only one run at a
// time: a second one fails at once.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROVISION_SCRIPT, WSL_CONF, WSL_POLICY, WSL_SETUP_LOG } from '../../src/core/docker/wslSetup';
import { TEST_RUN_LABEL, removeRunObjects } from './dockerRun';
import { dockerTestContext } from './harness';

/** Debian 13 (trixie) that the engine has: the base of the helper image (resources/helper/Dockerfile). */
const DEBIAN_IMAGE = process.env.DEVSPACE_TEST_GLIBC_IMAGE ?? 'node:24-trixie-slim';
const PACKAGES = ['docker-ce', 'docker-ce-cli', 'containerd.io', 'docker-buildx-plugin', 'docker-compose-plugin'];

describe('the setup script of the WSL distribution', () => {
  const { run, cli, log } = dockerTestContext('wslProvision');

  /**
   * A running container of Debian 13 with the label of the run, without the policy-rc.d of the image unless `keepPolicy`;
   * `network none` has no network.
   */
  function startDebian(name: string, options: { network?: 'none'; keepPolicy?: boolean } = {}): string {
    const container = `devspaces-test-${name}-${run.runId}`;
    const network = options.network ? ['--network', options.network] : [];
    cli.ok(['run', '-d', '--name', container, '--label', `${TEST_RUN_LABEL}=${run.runId}`, ...network, DEBIAN_IMAGE, 'sleep', 'infinity']);
    if (!options.keepPolicy) shell(container, 'rm -f /usr/sbin/policy-rc.d');
    return container;
  }

  function shell(container: string, script: string): string {
    return cli.ok(['exec', container, 'sh', '-c', script]);
  }

  /** The policy-rc.d that the script writes, as a run that `wsl --terminate` stopped leaves it. */
  function writePolicy(container: string): void {
    shell(container, `cat > /usr/sbin/policy-rc.d <<'POLICY'\n${WSL_POLICY}\nPOLICY\nchmod 755 /usr/sbin/policy-rc.d`);
  }

  /** Another run holds the lock of the script for two minutes. */
  function holdLock(container: string): void {
    cli.ok(['exec', '-d', container, 'flock', '/run/devspaces-setup.lock', 'sleep', '120']);
    // Until it holds the lock.
    shell(container, 'i=0; while flock -n /run/devspaces-setup.lock true; do i=$((i + 1)); [ "$i" -lt 100 ] || exit 1; sleep 0.1; done');
  }

  function provision(container: string): { code: number | null; out: string; err: string } {
    const result = cli.run(['exec', '-i', container, 'sh', '-s'], PROVISION_SCRIPT);
    log.info(`The script in ${container} ended with ${result.code}.\n${result.out}\n${result.err}`);
    return result;
  }

  beforeAll(() => {
    if (cli.image(DEBIAN_IMAGE) === undefined) cli.ok(['pull', DEBIAN_IMAGE]);
  });

  afterAll(() => {
    removeRunObjects(cli, run.runId);
  });

  it('stops at its first step without a network and names the last lines of its log', () => {
    const container = startDebian('wsl-offline', { network: 'none' });
    const result = provision(container);
    expect(result.code).toBe(1);
    expect(result.out).toBe('devspaces-step packages');
    expect(result.err).toMatch(new RegExp(`^The setup failed\\. The last lines of ${WSL_SETUP_LOG}:\\n== packages\\n`));
    // systemd is not turned on without its installation.
    expect(shell(container, 'test -e /etc/wsl.conf && echo present || echo absent')).toBe('absent');
    // Its guard against the start of services is gone again, also after the failure.
    expect(shell(container, 'test -e /usr/sbin/policy-rc.d && echo present || echo absent')).toBe('absent');
  });

  it('keeps a policy-rc.d that was there before', () => {
    const container = startDebian('wsl-policy', { network: 'none', keepPolicy: true });
    const before = shell(container, 'cat /usr/sbin/policy-rc.d');
    expect(provision(container).code).toBe(1);
    expect(shell(container, 'cat /usr/sbin/policy-rc.d')).toBe(before);
  });

  it('takes over the policy-rc.d of a run that was stopped, and removes it', () => {
    const container = startDebian('wsl-stopped', { network: 'none' });
    writePolicy(container);
    expect(provision(container).code).toBe(1);
    expect(shell(container, 'test -e /usr/sbin/policy-rc.d && echo present || echo absent')).toBe('absent');
  });

  it('keeps services from starting only while a run holds its lock, also with the policy-rc.d of a run that was stopped', () => {
    const container = startDebian('wsl-guard', { network: 'none' });
    writePolicy(container);
    expect(shell(container, '/usr/sbin/policy-rc.d docker start; echo $?')).toBe('0');
    holdLock(container);
    expect(shell(container, '/usr/sbin/policy-rc.d docker start; echo $?')).toBe('101');
  });

  it('fails at once while another run holds its lock, and keeps the log of that run', () => {
    const container = startDebian('wsl-locked', { network: 'none' });
    shell(container, `echo 'the other run' > ${WSL_SETUP_LOG}`);
    holdLock(container);
    const result = provision(container);
    expect(result.code).toBe(1);
    expect(result.out).toBe('');
    expect(result.err).toBe('Another setup of Docker, or the weekly upgrade of the packages, runs in the distribution. Try again after it.');
    expect(shell(container, `cat ${WSL_SETUP_LOG}`)).toBe('the other run');
  });

  it('installs Docker Engine from the repository of Docker and enables it for systemd without a start, and runs again', () => {
    const container = startDebian('wsl-online');
    const first = provision(container);
    expect(first.err).toBe('');
    expect(first.code).toBe(0);
    expect(first.out).toBe('devspaces-step packages\ndevspaces-step repository\ndevspaces-step docker');
    expect(shell(container, `dpkg-query -W -f '\${Status}\\n' ${PACKAGES.join(' ')}`).split('\n')).toEqual(PACKAGES.map(() => 'install ok installed'));
    expect(shell(container, 'cat /etc/apt/sources.list.d/docker.sources')).toContain('Suites: trixie');
    expect(shell(container, 'readlink /etc/systemd/system/multi-user.target.wants/docker.service')).toMatch(/docker\.service$/);
    expect(shell(container, 'test -e /usr/sbin/policy-rc.d && echo present || echo absent')).toBe('absent');
    // No Docker engine was started in the container.
    expect(shell(container, 'test -S /var/run/docker.sock && echo running || echo stopped')).toBe('stopped');
    expect(shell(container, 'cat /etc/wsl.conf')).toBe(WSL_CONF);

    const again = provision(container);
    expect(again.err).toBe('');
    expect(again.code).toBe(0);
  });
});
