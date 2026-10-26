// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The refresh over EngineDocker keeps going when the branch read of one container fails with a rejection
// (EngineDocker.exec rejects for a failure that is no refusal of the engine).
import { describe, expect, it } from 'vitest';
import { LABEL_DEVSPACE_ID } from '../names';
import type { DockerEngine } from '../worker/dockerEngine';
import { unusedEngine } from '../worker/dockerEngine.testkit';
import { EngineDocker } from '../worker/engineDocker';
import { readBranch, readDevspaceStates, type StateDevspace } from './refreshStates';

const container = (name: string, env: string) => ({ id: name, name, state: 'running' as const, rawState: 'running', labels: { [LABEL_DEVSPACE_ID]: env }, image: 'img' });

describe('readDevspaceStates over EngineDocker', () => {
  it('a branch read that rejects (a dropped connection) loses only that branch, never the refresh', async () => {
    const engine: DockerEngine = {
      ...unusedEngine(),
      containers: async () => [container('c-a', 'a'), container('c-b', 'b')],
      volumeNames: async () => [],
      inspect: async () => undefined,
      exec: async (name) => {
        if (name === 'c-a') throw new Error('socket hang up');
        return { exitCode: 0, stdout: 'main\n', stderr: '', timedOut: false };
      },
    };
    const envs: StateDevspace[] = [
      { id: 'a', containerName: 'c-a', volumeName: 'v-a', folder: '/w/a', branch: true },
      { id: 'b', containerName: 'c-b', volumeName: 'v-b', folder: '/w/b', branch: true },
    ];
    const states = await readDevspaceStates(new EngineDocker(engine), envs);
    expect(states.runtime.get('a')).toEqual({ container: 'running', volume: false });
    expect([...states.branches]).toEqual([['b', 'main']]);
  });

  it('readBranch: a failed Git is no branch, even when it printed something', async () => {
    const docker = { exec: async () => ({ exitCode: 128, stdout: 'garbage\n', stderr: 'fatal', timedOut: false }) };
    expect(await readBranch(docker, 'c', undefined, '/w')).toBeUndefined();
  });
});
