// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The refresh of the sidebar in one operation of the worker (the helper channel) against the real Docker engine of the
// runner, compared with what the Docker CLI reports. The devspaces: one running from the helper image with a Git
// repository on a branch, one stopped with a volume without the labels (found by its name), one with nothing, and one
// running whose branch is not asked for. No worker container is left over.
import * as esbuild from 'esbuild';
import { sharedBundleOptions, workerBundleOptions } from '../../scripts/bundleOptions.mjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BootstrapDocker } from '../../src/core/docker/bootstrapDocker';
import { mapContainerState } from '../../src/core/docker/dockerObjects';
import { DockerTargets } from '../../src/core/docker/dockerTargets';
import { helperDockerSocket } from '../../src/core/helper/helperImages';
import { HelperChannels, openHelperChannel } from '../../src/core/helperChannel/helperChannels';
import { LABEL_DEVSPACE_ID, LABEL_HELPER_CHANNEL, newDevspaceId } from '../../src/core/names';
import type { DevspaceRuntimeState, DevspaceStates, StateDevspace } from '../../src/core/pipeline/refreshStates';
import { NodeProcessRunner } from '../../src/core/process';
import { TEST_BASE_IMAGE, TEST_RUN_LABEL, removeRunObjects } from './dockerRun';
import { dockerTestContext, testHelperImage, testStateVolume, testVscodeVolume } from './harness';

async function bundleScript(): Promise<string> {
  const result = await esbuild.build({
    // The worker's bundle as a production build of esbuild.mjs builds it: also the program of the Monitor and of
    // the analysis thread.
    ...workerBundleOptions(sharedBundleOptions({ production: true })),
    write: false,
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

async function waitUntil(condition: () => boolean, what: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe('the refresh through the worker', () => {
  const { run, env, cli, log } = dockerTestContext('workerRefresh');
  // The Docker CLI of the extension (BootstrapDocker: the Docker context, the start of the worker).
  const docker = new BootstrapDocker(new NodeProcessRunner(), run.dockerPath, env, log);
  const targets = new DockerTargets(docker, env, log);
  const runLabel = `${TEST_RUN_LABEL}=${run.runId}`;
  const names = { git: `devspaces-refresh-git-${run.runId}`, stopped: `devspaces-refresh-stopped-${run.runId}`, none: `devspaces-refresh-none-${run.runId}`, other: `devspaces-refresh-other-${run.runId}` };
  const devspaces: StateDevspace[] = [
    { id: newDevspaceId(), containerName: names.git, volumeName: names.git, user: 'root', folder: '/workspaces/refresh', branch: true },
    { id: newDevspaceId(), containerName: names.stopped, volumeName: names.stopped, folder: '/workspaces/refresh', branch: true },
    { id: newDevspaceId(), containerName: names.none, volumeName: names.none, folder: '/workspaces/refresh', branch: true },
    { id: newDevspaceId(), containerName: names.other, volumeName: names.other, folder: '/workspaces/refresh', branch: false },
  ];
  let helperTag = '';
  let channels: HelperChannels;

  const workerContainers = () =>
    cli.lines(['ps', '-a', '--filter', `label=${LABEL_HELPER_CHANNEL}`, '--filter', `label=${runLabel}`, '--format', '{{.Names}}']);

  beforeAll(async () => {
    const script = await bundleScript();
    // The helper image through the harness.
    helperTag = (await testHelperImage(docker, log, env)).tag;
    channels = new HelperChannels({
      logger: log,
      open: (target) =>
        openHelperChannel(
          {
            start: (args) => {
              const all = [...args];
              all.splice(all.indexOf(helperTag), 0, '--label', runLabel);
              return docker.start(all);
            },
            runDirect: (args, options) => docker.run(args, options),
            logger: log,
            script: async () => script,
            helperTag: async () => helperTag,
            socketPath: async () => helperDockerSocket(env, process.platform, target.endpoint),
            // The lock files in a volume of the test, never the one of the Monitor.
            stateVolume: testStateVolume({ run, cli }, 'workerRefresh'),
            // The shared VS Code server store, a volume of the test.
            vscodeVolume: testVscodeVolume({ run, cli }, 'workerRefresh'),
          },
          target,
        ),
    });
    const [git, stopped, , other] = devspaces;
    // Running from the helper image, with a labelled volume and a Git repository on a branch.
    cli.ok(['volume', 'create', '--label', `${LABEL_DEVSPACE_ID}=${git.id}`, '--label', runLabel, names.git]);
    cli.ok([
      'run', '-d', '--name', names.git, '--label', `${LABEL_DEVSPACE_ID}=${git.id}`, '--label', runLabel,
      '--mount', `type=volume,source=${names.git},target=/workspaces`, helperTag, 'sleep', '3600',
    ]);
    cli.ok(['exec', names.git, 'git', 'init', '-q', '-b', 'feature/refresh', '/workspaces/refresh']);
    // Stopped (created, never started), with a volume without the labels of the extension.
    cli.ok(['volume', 'create', '--label', runLabel, names.stopped]);
    cli.ok([
      'create', '--name', names.stopped, '--label', `${LABEL_DEVSPACE_ID}=${stopped.id}`, '--label', runLabel,
      '--mount', `type=volume,source=${names.stopped},target=/workspaces`, TEST_BASE_IMAGE, 'sleep', '3600',
    ]);
    // Running, but its branch is not asked for (a devspace of another account).
    cli.ok(['volume', 'create', '--label', `${LABEL_DEVSPACE_ID}=${other.id}`, '--label', runLabel, names.other]);
    cli.ok(['run', '-d', '--init', '--name', names.other, '--label', `${LABEL_DEVSPACE_ID}=${other.id}`, '--label', runLabel, TEST_BASE_IMAGE, 'sleep', '3600']);
  });

  afterAll(async () => {
    channels?.dispose();
    // The worker ends by the end of its input and `--rm` removes it.
    let leftovers: string[] = [];
    try {
      await waitUntil(() => workerContainers().length === 0, 'the removal of the worker container');
    } catch {
      leftovers = workerContainers();
    }
    removeRunObjects(cli, run.runId);
    expect(leftovers).toEqual([]);
  });

  /**
   * The states and branches as the Docker CLI of the test harness reports them (`docker inspect` of each container and
   * volume, `git branch --show-current` by `docker exec` in each running dev container whose branch is asked for).
   */
  const reported = (): DevspaceStates => {
    const runtime = new Map<string, DevspaceRuntimeState>();
    const branches = new Map<string, string>();
    for (const devspace of devspaces) {
      const container = cli.container(devspace.containerName);
      const state = container === undefined ? 'missing' : mapContainerState(container.State.Status);
      runtime.set(devspace.id, { container: state, volume: cli.volume(devspace.volumeName) !== undefined });
      if (state !== 'running' || !devspace.branch) continue;
      const branch = cli.run(['exec', ...(devspace.user ? ['-u', devspace.user] : []), devspace.containerName, 'git', '-C', devspace.folder, 'branch', '--show-current']);
      if (branch.code === 0 && branch.out !== '') branches.set(devspace.id, branch.out);
    }
    return { runtime, branches };
  };

  // The same as the Docker CLI reports, which are the states and the branch below.
  it('gives the states and branches through the worker that the Docker CLI reports, and changes nothing', async () => {
    const target = await targets.current();
    expect(target.kind).toBe('local');
    expect(await channels.get(target)).toBeDefined();
    const before = cli.lines(['ps', '-a', '--filter', `label=${runLabel}`, '--format', '{{.Names}} {{.State}}']).sort();

    const viaWorker = await channels.refresh(target, devspaces);
    const cliStates = reported();
    expect(viaWorker).toBeDefined();
    expect(viaWorker).toEqual(cliStates);
    const [git, stopped, none, other] = devspaces;
    expect(cliStates.runtime).toEqual(
      new Map([
        [git.id, { container: 'running', volume: true }],
        [stopped.id, { container: 'stopped', volume: true }],
        [none.id, { container: 'missing', volume: false }],
        [other.id, { container: 'running', volume: true }],
      ]),
    );
    expect(cliStates.branches).toEqual(new Map([[git.id, 'feature/refresh']]));

    // It only read: the same containers in the same states.
    expect(cli.lines(['ps', '-a', '--filter', `label=${runLabel}`, '--format', '{{.Names}} {{.State}}']).sort()).toEqual(before);
    expect(workerContainers()).toHaveLength(1);
  });
});
