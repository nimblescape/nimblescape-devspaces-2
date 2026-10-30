// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The `docker ps` of the idle session of a WSL distribution (src/core/docker/wslLifetime.ts IDLE_SESSION_SCRIPT), with the
// real Docker CLI and engine: one line per running container, with the values of its labels of a devspace, of the
// Monitor and of a helper container, and an empty line for a container without any of them, so that `grep -q .` finds
// only the others. Only the containers of this run are listed, so that other containers of the engine do not change the
// answer.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LABEL_DEVSPACE_ID, LABEL_HELPER } from '../../src/core/names';
import { LABEL_MONITOR } from '../../src/core/remoteMonitor/protocol';
import { IDLE_PS_FORMAT, IDLE_SESSION_SCRIPT } from '../../src/core/docker/wslLifetime';
import { TEST_RUN_LABEL, removeRunObjects } from './dockerRun';
import { dockerTestContext } from './harness';

const IMAGE = process.env.DEVSPACE_TEST_GLIBC_IMAGE ?? 'node:24-trixie-slim';

describe('the docker ps of the idle session of a WSL distribution', () => {
  const { run, cli } = dockerTestContext('wslIdle');

  /** A running container of this run with the labels `labels`, or a stopped one. */
  function container(name: string, labels: Record<string, string>, options: { stopped?: boolean } = {}): void {
    const flags = Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
    const command = options.stopped ? ['true'] : ['sleep', 'infinity'];
    cli.ok(['run', options.stopped ? '--detach=false' : '-d', '--name', `devspaces-test-${name}-${run.runId}`, '--label', `${TEST_RUN_LABEL}=${run.runId}`, ...flags, IMAGE, ...command]);
  }

  /**
   * The lines of the `docker ps` of the script for the containers of this run. Each line is in brackets here, because the
   * test CLI trims its output, which would drop an empty first or last line.
   */
  function lines(): string[] {
    return cli
      .ok(['ps', '--filter', `label=${TEST_RUN_LABEL}=${run.runId}`, '--filter', 'status=running', '--format', `[${IDLE_PS_FORMAT}]`])
      .split('\n')
      .map((line) => line.replace(/^\[(.*)\]$/, '$1'))
      .sort();
  }

  beforeAll(() => {
    if (cli.image(IMAGE) === undefined) cli.ok(['pull', IMAGE]);
  });

  afterAll(() => {
    removeRunObjects(cli, run.runId);
  });

  it('lists the label of a running devspace, of the Monitor and of a helper container, and an empty line for another container', () => {
    // The script uses this format with the filter status=running.
    expect(IDLE_SESSION_SCRIPT).toContain(`docker ps --filter status=running --format '${IDLE_PS_FORMAT}' | grep -q .`);
    container('idle-other', {});
    expect(lines()).toEqual(['']);
    container('idle-devspace', { [LABEL_DEVSPACE_ID]: 'acme-api-1a2b3c' });
    container('idle-monitor', { [LABEL_MONITOR]: '0123456789ab' });
    // A worker or a relay: the label comes from the helper image.
    container('idle-helper', { [LABEL_HELPER]: 'true' });
    container('idle-stopped', { [LABEL_DEVSPACE_ID]: 'acme-web-4d5e6f' }, { stopped: true });
    expect(lines()).toEqual(['', '0123456789ab', 'acme-api-1a2b3c', 'true']);
  });
});
