// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Mutation tests of readDevspaceStates by the rule of the dev container. Each test names the check of
// refreshStates.ts that it guards.
import { describe, expect, it } from 'vitest';
import type { ListedContainer } from '../docker/dockerObjects';
import { LABEL_DEVSPACE_ID } from '../names';
import { readDevspaceStates, type StateDocker, type StateDevspace } from './refreshStates';

const ENV: StateDevspace = { id: 'env-r1', containerName: 'devspaces-r1', volumeName: 'v-r1', folder: '/workspaces/r1', branch: true };

function listed(id: string, name: string, state: 'running' | 'stopped', created?: string): ListedContainer {
  return {
    id,
    name,
    state,
    rawState: state === 'running' ? 'running' : 'exited',
    labels: { [LABEL_DEVSPACE_ID]: ENV.id },
    image: 'img',
    ...(created !== undefined ? { created } : {}),
  };
}

function docker(containers: ListedContainer[], execs: string[]): StateDocker {
  return {
    listDevspaceContainers: async () => containers,
    listDevspaceVolumes: async () => [{ name: ENV.volumeName, labels: {} }],
    volumeExists: async () => true,
    exec: async (container) => (execs.push(container), { exitCode: 0, stdout: `branch-of-${container}\n`, stderr: '', timedOut: false }),
  };
}

describe('servicesRunning is another container than the dev container of the rule', () => {
  // Guards `other.id !== dev?.id` of refreshStates.ts (it fails with `other.name !== env.containerName`): the dev
  // container of the rule has another name than the recorded one (created again under another name); it is the dev
  // container, not "another container of the devspace", so the answer has no servicesRunning.
  it('a lone running dev container of another name: running, its branch by its ID, and no servicesRunning', async () => {
    const execs: string[] = [];
    const states = await readDevspaceStates(docker([listed('id-renamed', 'devspaces-r1-again', 'running', '2026-10-08T09:00:00Z')], execs), [ENV]);
    expect(states.runtime.get(ENV.id)).toEqual({ container: 'running', volume: true });
    expect(execs).toEqual(['id-renamed']);
    expect(states.branches.get(ENV.id)).toBe('branch-of-id-renamed');
  });
});
