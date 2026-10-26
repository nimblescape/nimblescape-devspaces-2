// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Clone of a public repository into a workspace volume with the real workspace helper, then the configuration files
// from the volume. Nothing of the repository is built. The steps run in the batch helper of the real worker under a
// lock, as an operation runs them; the checks of the volume run in a plain container of the helper image (runInVolume).
// The batch helper is started from the test process as the worker's own flow starts it (inProcessBatches), without the
// relay of the worker.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// The Docker CLI of the extension (BootstrapDocker).
import { BootstrapDocker } from '../../src/core/docker/bootstrapDocker';
import { DockerTargets } from '../../src/core/docker/dockerTargets';
import type { WorkspaceHelper } from '../../src/core/helper/workspaceHelper';
import { helperDockerSocket } from '../../src/core/helper/helperImages';
import { parseJsonc } from '../../src/core/jsonc';
import { newDevspaceId, splitRepository } from '../../src/core/names';
import { NodeProcessRunner } from '../../src/core/process';
import { TEST_RUN_LABEL, removeRunObjects } from './dockerRun';
import { DUMMY_TOKEN, Timings, dockerTestContext, runInVolume, testHelperImage, testWorkspaceHelper } from './harness';
import { inProcessBatches, type InProcessBatches } from './workerLocks';

/** A small public repository with a Dev Container configuration. */
const REPOSITORY = process.env.DEVSPACE_TEST_REPOSITORY ?? 'microsoft/vscode-remote-try-node';
const FOLDER = `/workspaces/${splitRepository(REPOSITORY).name}`;

describe(`clone of ${REPOSITORY}`, () => {
  const { run, env, cli, log } = dockerTestContext('clone');
  const docker = new BootstrapDocker(new NodeProcessRunner(), run.dockerPath, env, log);
  // The helper of the worker, on the helper image of the tests as its own image; set in beforeAll.
  let helper: WorkspaceHelper;
  const volumeName = `devspaces-test-clone-${run.runId}`;
  const timings = new Timings();
  // The batch helper of the worker runs the steps, started from the test process (inProcessBatches), not through the
  // lock of a worker.
  let batches: InProcessBatches | undefined;
  const lockId = newDevspaceId();
  const inBatch = <T>(fn: () => Promise<T>): Promise<T> => batches!.inScope(lockId, volumeName, fn);

  /** A command in the helper on the volume, without the Docker socket and without network. */
  async function inVolume(command: string[]): Promise<{ exitCode: number | null; stdout: string }> {
    // A plain container of the helper image.
    const result = await runInVolume(docker, volumeName, command);
    return { exitCode: result.exitCode, stdout: result.stdout.trim() };
  }

  beforeAll(async () => {
    const image = await timings.measure('workspace helper image ready', () => testHelperImage(docker, log, env));
    // The engine of the Docker context, as the worker's socket follows it.
    const socket = helperDockerSocket(env, process.platform, (await new DockerTargets(docker, env, log).current()).endpoint);
    batches = await inProcessBatches({ cli, log }, socket);
    // The steps run from that image with that socket, as in the worker.
    helper = testWorkspaceHelper(image, socket, cli, log);
    cli.ok(['volume', 'create', '--label', `${TEST_RUN_LABEL}=${run.runId}`, volumeName]);
  });

  afterAll(async () => {
    timings.print(`Timings of the clone scenario (${REPOSITORY}):`);
    // No batch helper is left over (no worker is started), also when the setup failed before the batch helpers.
    const leftovers = batches === undefined ? [] : await batches.dispose();
    removeRunObjects(cli, run.runId);
    expect(leftovers).toEqual([]);
    expect(cli.volume(volumeName)).toBeUndefined();
  });

  it('clones with a dummy token, then lists and reads the configurations', async () => {
    // Each step in the batch helper of an operation.
    await timings.measure('clone', () => inBatch(() => helper.clone({ volumeName, repository: REPOSITORY, token: DUMMY_TOKEN })));

    const remote = await inVolume(['git', '-C', FOLDER, 'remote', 'get-url', 'origin']);
    expect(remote).toEqual({ exitCode: 0, stdout: `https://github.com/${REPOSITORY}.git` });
    // The token is not in the volume. grep ends with 1 when nothing matches.
    const token = await inVolume(['grep', '-rl', DUMMY_TOKEN, '/workspaces']);
    expect(token).toEqual({ exitCode: 1, stdout: '' });

    const configPaths = await timings.measure('list configurations', () =>
      inBatch(() => helper.listConfigurations({ volumeName, repository: REPOSITORY })),
    );
    expect(configPaths.length).toBeGreaterThan(0);
    for (const configPath of configPaths) expect(configPath).toMatch(/(^|\/)\.?devcontainer\.json$/);
    if (process.env.DEVSPACE_TEST_REPOSITORY === undefined) expect(configPaths[0]).toBe('.devcontainer/devcontainer.json');

    const files = await timings.measure('read configuration files', () =>
      inBatch(() => helper.readConfigFiles({ volumeName, repository: REPOSITORY, configPath: configPaths[0] })),
    );
    expect(files).toBeDefined();
    const config = parseJsonc<Record<string, unknown>>(files!.configText);
    expect(typeof config).toBe('object');
    expect(config.image !== undefined || config.build !== undefined || config.dockerFile !== undefined).toBe(true);
    if (files!.dockerfilePath !== undefined) expect(files!.dockerfileText).toMatch(/^\s*FROM\s/im);
    expect(await inBatch(() => helper.readConfigFiles({ volumeName, repository: REPOSITORY, configPath: '.devcontainer/missing/devcontainer.json' }))).toBeUndefined();
  });

  it('a second clone finds the repository and leaves it unchanged', async () => {
    const head = await inVolume(['git', '-C', FOLDER, 'rev-parse', 'HEAD']);
    const output: string[] = [];
    // The step in the batch helper of an operation.
    await timings.measure('second clone (idempotent)', () =>
      inBatch(() => helper.clone({ volumeName, repository: REPOSITORY, token: DUMMY_TOKEN, onOutput: (text) => output.push(text) })),
    );
    expect(output.join('')).toContain('The repository is already in the volume.');
    expect(await inVolume(['git', '-C', FOLDER, 'rev-parse', 'HEAD'])).toEqual(head);
  });

  it('leaves no helper container and builds no image', () => {
    expect(cli.lines(['ps', '-a', '-q', '--filter', `volume=${volumeName}`])).toEqual([]);
    // One batch helper per operation (two clones, the listing, two reads). Counted by the in-process batch helpers, not
    // by the locks of the worker.
    expect(batches!.sessions).toHaveLength(5);
    expect(cli.lines(['image', 'ls', '-q', '--filter', `label=${TEST_RUN_LABEL}=${run.runId}`])).toEqual([]);
  });
});
