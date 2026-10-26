// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// readDevspaceStates, the refresh that runs in the worker.
import { describe, expect, it } from 'vitest';
import type { ContainerInfo, ListedContainer } from '../docker/dockerObjects';
import { LABEL_DEVSPACE_ID } from '../names';
import type { RunResult } from '../ports';
import type { DockerEngine, EngineExecOptions } from '../worker/dockerEngine';
import { scriptCommand } from '../worker/containerScripts';
import { EngineDocker } from '../worker/engineDocker';
import { BRANCH_EXEC_TIMEOUT_MS, BRANCH_READ_CONCURRENCY, readDevspaceStates, type StateDocker, type StateDevspace } from './refreshStates';
import { ENV_OPS, EXPECTED_STATES, REFRESH_DEVSPACES, fixtureContainerId, fixtureEngine } from './refreshStates.testkit';

/**
 * The Docker of the refresh is the worker's EngineDocker over the engine of the fixture (fixtureEngine, whose every
 * other method fails: unusedEngine). Records the options of each exec.
 */
function engineDocker(): { docker: EngineDocker; execs: Array<{ container: string; command: readonly string[]; options: EngineExecOptions }> } {
  const { engine } = fixtureEngine();
  const execs: Array<{ container: string; command: readonly string[]; options: EngineExecOptions }> = [];
  const recording: DockerEngine = {
    ...engine,
    exec: (container, command, options = {}) => {
      execs.push({ container, command, options });
      return engine.exec(container, command, options);
    },
  };
  return { docker: new EngineDocker(recording), execs };
}

describe('readDevspaceStates', () => {
  it('reads the states of the dev containers and volumes, and the branches of the running ones that were asked for', async () => {
    expect(await readDevspaceStates(engineDocker().docker, REFRESH_DEVSPACES)).toEqual(EXPECTED_STATES);
  });

  it('only reads, and no exec has an input, a secret input or variables', async () => {
    const { docker, execs } = engineDocker();
    await readDevspaceStates(docker, REFRESH_DEVSPACES);
    // The refresh runs over the Engine API, whose fake answers only the reads of the refresh and exec (fixtureEngine
    // over unusedEngine: any other call fails the refresh), and each exec has no standard input, no secret input and no
    // variables (EngineExecOptions has no `env`).
    for (const { container, command, options } of execs) {
      expect(options.input).toBeUndefined();
      expect(options.secretInputName).toBeUndefined();
      expect(Object.keys(options).every((key) => ['user', 'timeoutMs', 'signal'].includes(key))).toBe(true);
      // The script `branch` of the registry in the folder of the devspace; the exec names the dev container by its
      // ID.
      expect(command).toEqual(scriptCommand('branch', [REFRESH_DEVSPACES.find((env) => fixtureContainerId(env.containerName) === container)!.folder]));
    }
    // No branch of a devspace whose branch was not asked for (another account).
    const containers = execs.map((exec) => exec.container);
    // The IDs of these dev containers.
    expect([...containers].sort()).toEqual(['devspaces-api', 'devspaces-detached', 'devspaces-git-fails'].map(fixtureContainerId).sort());
    const ops = REFRESH_DEVSPACES.find((env) => env.id === ENV_OPS)!.containerName;
    expect(containers).not.toContain(ops);
    expect(containers).not.toContain(fixtureContainerId(ops));
    // Every branch read has a time limit, so a stuck exec cannot hang the refresh.
    expect(execs.length).toBe(3);
    for (const exec of execs) expect(exec.options.timeoutMs).toBe(BRANCH_EXEC_TIMEOUT_MS);
  });

  // A leftover stopped dev container never hides the running one.
  for (const order of ['running first', 'stopped first'] as const) {
    it(`shows a devspace with a running and a stopped dev container as running (${order})`, async () => {
      const dev = (name: string, running: boolean): ContainerInfo => ({
        id: name,
        name,
        state: running ? 'running' : 'stopped',
        rawState: running ? 'running' : 'exited',
        labels: { [LABEL_DEVSPACE_ID]: 'env-dup' },
        image: 'img',
        volumes: [],
        volumeSubpaths: [],
        mountTargets: [],
      });
      const pair = [dev('devspaces-dup', true), dev('devspaces-dup-old', false)];
      const docker: StateDocker = {
        listDevspaceContainers: async () => (order === 'running first' ? pair : [...pair].reverse()),
        listDevspaceVolumes: async () => [{ name: 'v-dup', labels: {} }],
        volumeExists: async () => true,
        exec: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '', timedOut: false }),
      };
      const env: StateDevspace = { id: 'env-dup', containerName: 'devspaces-dup', volumeName: 'v-dup', folder: '/workspaces/r', branch: false };
      const states = await readDevspaceStates(docker, [env]);
      expect(states.runtime.get('env-dup')?.container).toBe('running');
    });
  }

  it('fails when the containers cannot be listed', async () => {
    const docker: StateDocker = {
      listDevspaceContainers: async () => {
        throw new Error('Cannot connect to the Docker daemon');
      },
      listDevspaceVolumes: async () => [],
      volumeExists: async () => false,
      exec: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '', timedOut: false }),
    };
    await expect(readDevspaceStates(docker, REFRESH_DEVSPACES)).rejects.toThrow(/Docker daemon/);
  });

  it(`reads at most ${BRANCH_READ_CONCURRENCY} branches at a time`, async () => {
    const devspaces: StateDevspace[] = Array.from({ length: 10 }, (_, index) => ({
      id: `env-${index}`,
      containerName: `c-${index}`,
      volumeName: `v-${index}`,
      folder: `/workspaces/r${index}`,
      branch: true,
    }));
    const containers: ContainerInfo[] = devspaces.map((env) => ({
      id: env.containerName,
      name: env.containerName,
      state: 'running',
      rawState: 'running',
      labels: { [LABEL_DEVSPACE_ID]: env.id },
      image: 'img',
      volumes: [],
      volumeSubpaths: [],
      mountTargets: [],
    }));
    let active = 0;
    let peak = 0;
    const docker: StateDocker = {
      listDevspaceContainers: async () => containers,
      listDevspaceVolumes: async () => devspaces.map((env) => ({ name: env.volumeName, labels: {} })),
      volumeExists: async () => true,
      exec: async (container): Promise<RunResult> => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return { exitCode: 0, stdout: `b-${container}\n`, stderr: '', timedOut: false };
      },
    };
    const states = await readDevspaceStates(docker, devspaces);
    expect(peak).toBe(BRANCH_READ_CONCURRENCY);
    expect(states.branches.size).toBe(10);
    expect(states.branches.get('env-3')).toBe('b-c-3');
  });
});

describe('readDevspaceStates: the dev container by the rule', () => {
  const env: StateDevspace = { id: 'env-u4', containerName: 'devspaces-u4', volumeName: 'v-u4', folder: '/workspaces/u4', branch: true };
  const listed = (id: string, name: string, state: 'running' | 'stopped', created?: string): ListedContainer => ({
    id,
    name,
    state,
    rawState: state === 'running' ? 'running' : 'exited',
    labels: { [LABEL_DEVSPACE_ID]: env.id },
    image: 'img',
    ...(created !== undefined ? { created } : {}),
  });
  function docker(containers: ListedContainer[], execs: string[]): StateDocker {
    return {
      listDevspaceContainers: async () => containers,
      listDevspaceVolumes: async () => [{ name: env.volumeName, labels: {} }],
      volumeExists: async () => true,
      exec: async (container) => (execs.push(container), { exitCode: 0, stdout: `branch-of-${container}\n`, stderr: '', timedOut: false }),
    };
  }

  it('the state of the named dev container while another dev container runs; that one sets servicesRunning, so Stop is offered', async () => {
    const execs: string[] = [];
    const states = await readDevspaceStates(docker([listed('id-named', env.containerName, 'stopped'), listed('id-other', 'devspaces-u4-old', 'running', '2026-10-08T09:00:00Z')], execs), [env]);
    expect(states.runtime.get(env.id)).toEqual({ container: 'stopped', volume: true, servicesRunning: true });
    expect(states.branches.size).toBe(0);
    expect(execs).toEqual([]);
  });

  it('without the named one: the newest running dev container by its time, its branch read by its ID; another running one sets servicesRunning', async () => {
    const execs: string[] = [];
    const containers = [
      listed('id-older', 'devspaces-a', 'running', '2026-10-08T08:00:00Z'),
      // Half a second later than id-text, which sorts after it as text.
      listed('id-newer', 'devspaces-b', 'running', '2026-10-08T09:00:00.5Z'),
      listed('id-text', 'devspaces-c', 'running', '2026-10-08T09:00:00Z'),
    ];
    const states = await readDevspaceStates(docker(containers, execs), [env]);
    expect(states.runtime.get(env.id)).toEqual({ container: 'running', volume: true, servicesRunning: true });
    expect(execs).toEqual(['id-newer']);
    expect(states.branches.get(env.id)).toBe('branch-of-id-newer');
  });

  it('the named running dev container alone: no servicesRunning, its branch by its ID', async () => {
    const execs: string[] = [];
    const states = await readDevspaceStates(docker([listed('id-named', env.containerName, 'running'), listed('id-old', 'devspaces-u4-old', 'stopped', '2026-10-08T09:00:00Z')], execs), [env]);
    expect(states.runtime.get(env.id)).toEqual({ container: 'running', volume: true });
    expect(execs).toEqual(['id-named']);
  });
});
