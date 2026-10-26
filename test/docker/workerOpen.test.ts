// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The open of a seeded devspace as the extension sends it (DevspaceService.openDevspaceInWorker, extensionFlow
// and the extension's HostSide over a real registry and real session files) to a real worker, whose own pipeline builds
// the image, runs `up` and the lifecycle commands in its batch helper, writes the token, makes sure that the Session
// Monitor runs, and records the open through the requests of the operation. The window would connect with the answer.
// The test makes sure of the Monitor of the engine (devspaces-monitor); it is skipped where one exists
// before the tests (a monitor of the user is never touched), and removes the one it made. The window has a version, as
// activate sets it from the manifest: the worker gets it at its start and gives it to the Monitor that it creates.
import * as fs from 'fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// The Docker CLI of the extension (BootstrapDocker).
import { BootstrapDocker } from '../../src/core/docker/bootstrapDocker';
import { setUserAgentVersion } from '../../src/core/http';
import { GITHUB_TOKEN_FILE, LABEL_DEVSPACE_ID, LABEL_REPOSITORY, newDevspaceId, resourceName } from '../../src/core/names';
import { isoTime, systemClock } from '../../src/core/ports';
import { NodeProcessRunner } from '../../src/core/process';
import { REMOTE_MONITOR_CONTAINER } from '../../src/core/remoteMonitor/protocol';
import { TEST_BASE_IMAGE, TEST_RUN_LABEL, removeRunObjects } from './dockerRun';
import {
  RecordingProgress,
  TEST_ACCOUNT,
  createVolume,
  dockerTestContext,
  runInVolume,
  testHelperImage,
} from './harness';
import { monitorOfUser as engineHadMonitor, removeTestMonitor, seedTestMonitorRun, workerWindow } from './workerWindow';

const REPOSITORY = 'devspaces-test/worker-open';
const FOLDER = '/workspaces/worker-open';
const CONFIG_PATH = '.devcontainer/devcontainer.json';
const REMOTE_USER = 'dev';
const CREATED_LOG = '/tmp/devspace-post-create';
/** The version of Devspaces of the window (activate: the version of the manifest). */
const VERSION = '1.20.3';

/** Creates the repository in the volume as the helper creates a clone: as root, on the branch main, with one commit. */
const SEED_SCRIPT = `set -eu
mkdir -p "$1/.devcontainer"
printf '%s\\n' "$2" > "$1/.devcontainer/devcontainer.json"
printf '%s\\n' "$3" > "$1/.devcontainer/Dockerfile"
cd "$1"
git init -q -b main
git add -A
git -c user.name=Test -c user.email=test@example.invalid commit -q -m 'Initial commit'
`;

describe('the open through a real worker', () => {
  const { run, env, cli, log } = dockerTestContext('workerOpen');
  const runner = new NodeProcessRunner();
  const docker = new BootstrapDocker(runner, run.dockerPath, env, log);
  // The window of the shared harness (workerWindow.ts). No registry question: the open builds from the base image that
  // the engine has or pulls (updateImagesOnConnect off).
  const window = workerWindow({ run, env, cli, log }, docker, { name: 'workerOpen', windowId: 'docker-test-window' });
  const { registry, sessionFiles, service, paths } = window;

  const devspaceId = newDevspaceId();
  const volumeName = resourceName(REPOSITORY, devspaceId);
  const containerName = volumeName;
  // A Monitor of the user (or of another run) is never touched: the test is skipped then.
  const monitorOfUser = engineHadMonitor({ run });

  function execIn(user: string, script: string): { code: number | null; out: string } {
    const result = cli.run(['exec', '-u', user, containerName, 'sh', '-c', script]);
    return { code: result.code, out: result.out.trim() };
  }

  beforeAll(async () => {
    if (monitorOfUser) {
      log.info(`The engine has a Monitor (${REMOTE_MONITOR_CONTAINER}) before the tests; the open through a real worker is skipped.`);
      return;
    }
    // The helper image through the harness.
    await testHelperImage(docker, log, env);
    // Before the first worker starts.
    setUserAgentVersion(VERSION);
    // The real monitor of the opens runs no background run during the tests.
    await seedTestMonitorRun(docker, { run });
    paths.ensureDirectoriesSync();
    const devcontainerJson = JSON.stringify(
      {
        name: 'Worker open',
        build: { dockerfile: 'Dockerfile' },
        remoteUser: REMOTE_USER,
        // The containers of the run carry the label of the run, so the cleanup finds them.
        runArgs: ['--label', `${TEST_RUN_LABEL}=${run.runId}`],
        postCreateCommand: `echo created >> ${CREATED_LOG}`,
      },
      null,
      2,
    );
    const dockerfile = [`FROM ${TEST_BASE_IMAGE}`, 'RUN apk add --no-cache git && adduser -D dev', `LABEL ${TEST_RUN_LABEL}=${run.runId}`].join('\n');
    await createVolume(docker, volumeName, { [LABEL_DEVSPACE_ID]: devspaceId, [LABEL_REPOSITORY]: REPOSITORY, [TEST_RUN_LABEL]: run.runId });
    const seeded = await runInVolume(docker, volumeName, ['sh', '-c', SEED_SCRIPT, 'sh', FOLDER, devcontainerJson, dockerfile]);
    expect(seeded.exitCode, seeded.stderr).toBe(0);
    const now = isoTime(systemClock);
    await registry.add({ id: devspaceId, repository: REPOSITORY, configPath: CONFIG_PATH, volumeName, containerName, createdAt: now, lastUsedAt: now, owner: TEST_ACCOUNT });
  });

  afterAll(async () => {
    setUserAgentVersion(undefined);
    const leftovers = await window.dispose();
    removeRunObjects(cli, run.runId);
    // The Monitor that the open made sure of, its state volume and its tag (nothing when the engine had one
    // before the tests).
    removeTestMonitor({ run, cli });
    expect(leftovers).toEqual([]);
    expect(cli.container(containerName)).toBeUndefined();
    expect(cli.volume(volumeName)).toBeUndefined();
  });

  it.skipIf(monitorOfUser)('builds, starts and records the devspace in the worker; the window gets what it connects with', async () => {
    const progress = new RecordingProgress();
    const result = await service.openDevspaceInWorker(devspaceId, { progress });
    expect(result.containerName).toBe(containerName);
    expect(result.remoteWorkspaceFolder).toBe(FOLDER);
    expect(result.devspace).toMatchObject({ id: devspaceId, remoteUser: REMOTE_USER, remoteWorkspaceFolder: FOLDER });
    // The records of the open came through the requests: no busy mark is left, the build is recorded, the pending file is written.
    const entry = await registry.get(devspaceId);
    expect(entry?.busy).toBeUndefined();
    expect(entry?.buildRecord?.buildNumber).toBe(1);
    expect((await sessionFiles.readPendings()).map((pending) => pending.devspaceId)).toEqual([devspaceId]);
    // The steps of the worker were the progress of the open.
    expect(progress.steps).toContain('preparing');
    expect(progress.steps).toContain('starting');
    // The container runs with its lifecycle commands done and the token of the operation in its memory.
    expect(cli.container(containerName)?.State.Running).toBe(true);
    expect(execIn(REMOTE_USER, `cat ${CREATED_LOG}`).out).toBe('created');
    expect(execIn('root', `cat ${GITHUB_TOKEN_FILE}`).out).not.toBe('');
    // The Monitor of the engine runs (the open made sure of it), with the version of the window, which the worker
    // passed on.
    expect(cli.container(REMOTE_MONITOR_CONTAINER)?.State.Running).toBe(true);
    expect(cli.container(REMOTE_MONITOR_CONTAINER)?.Config.Env).toContain(`DEVSPACES_VERSION=${VERSION}`);
    // The token never reached the log of the window unmasked.
    expect(fs.readFileSync(log.file, 'utf8')).not.toContain('dummy-token-of-the-docker-tests');
  });

  it.skipIf(monitorOfUser)('a second open opens the running container as it is', async () => {
    const id = cli.container(containerName)?.Id;
    const progress = new RecordingProgress();
    await service.openDevspaceInWorker(devspaceId, { progress });
    expect(cli.container(containerName)?.Id).toBe(id);
    expect(progress.steps).not.toContain('preparing');
    expect(execIn(REMOTE_USER, `cat ${CREATED_LOG}`).out).toBe('created');
  });
});
