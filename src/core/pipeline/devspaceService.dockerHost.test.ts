// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Each devspace records its Docker host (the current Docker context when it was created). The service acts only on
// the devspaces of the current host; the others are never cloned, restored, recreated, deleted, stopped, or given a
// token.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DockerTargets, podmanDockerTarget } from '../docker/dockerTargets';
import { UserFacingError } from '../errors';
import { Messages } from '../messages';
import { LABEL_DEVSPACE_ID, LABEL_OWNER_ID, LABEL_REPOSITORY, resourceName } from '../names';
import { silentLogger } from '../ports';
import type { RepositoryTarget } from './operationBase';
import { ACCOUNT, ENV_ID, OTHER_ID, REPO, createHarness, seedDevspace, type Harness } from './devspaceService.testkit';
import { DEFAULT_CONFIG_PATH } from './recordRules';

const TARGET: RepositoryTarget = { repository: REPO, defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };

let h: Harness;
/** The Docker host of the current Docker context, as DockerTargets.host gives it. */
let currentHost: string;

beforeEach(() => {
  currentHost = '';
  h = createHarness({ dockerHost: async () => currentHost });
});

afterEach(() => {
  h.cleanup();
});

async function rejection(promise: Promise<unknown>): Promise<UserFacingError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UserFacingError) return error;
    throw error;
  }
  throw new Error('The promise did not reject.');
}

describe('the Docker host of a new devspace', () => {
  it('a first open on a remote host records it', async () => {
    currentHost = 'build-box';
    const result = await h.service.open(TARGET, { progress: h.progress });
    expect(result.devspace.dockerHost).toBe('build-box');
    expect((await h.registry.get(result.devspace.id))?.dockerHost).toBe('build-box');
  });

  it('a first open on the local Docker records nothing (a missing field is local)', async () => {
    const result = await h.service.open(TARGET, { progress: h.progress });
    expect(result.devspace).not.toHaveProperty('dockerHost');
  });

  it('a devspace of the repository on another host is not used: the current host gets its own', async () => {
    await seedDevspace(h, { extra: { dockerHost: 'build-box' } });
    const createdVolumes = new Set(h.docker.volumes.keys());
    const result = await h.service.open(TARGET, { progress: h.progress });
    expect(result.devspace.id).not.toBe(ENV_ID);
    expect(result.devspace).not.toHaveProperty('dockerHost');
    // The other host's devspace is unchanged in the registry.
    expect((await h.registry.get(ENV_ID))?.dockerHost).toBe('build-box');
    expect((await h.registry.list()).map((env) => env.id).sort()).toEqual([ENV_ID, result.devspace.id].sort());
    expect(createdVolumes.size).toBeLessThan(h.docker.volumes.size);
  });
});

describe('a devspace of another Docker host is never acted on', () => {
  beforeEach(async () => {
    await seedDevspace(h, { container: 'running', extra: { dockerHost: 'build-box' } });
    currentHost = 'other-box';
  });

  const refused = Messages.otherDockerHost(REPO, 'build-box', 'other-box');

  it.each([
    ['openDevspace', () => h.service.openDevspace(ENV_ID, { progress: h.progress })],
    ['stop', () => h.operations.stop(ENV_ID)],
    ['delete', () => h.service.delete(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] })],
    ['safetyCheck', () => h.service.safetyCheck(ENV_ID, { progress: h.progress })],
    ['listConfigurations', () => h.service.listConfigurations(ENV_ID, { progress: h.progress })],
  ])('%s is refused with both hosts named, before Docker is asked', async (_name, operation) => {
    const changes = h.docker.log.length;
    const execs = h.docker.execs.length;
    const error = await rejection(operation());
    expect(error.code).toBe('otherDockerHost');
    expect(error.message).toBe(refused);
    // Nothing changed on the engine, no token was written, no helper ran, Docker was not started.
    expect(h.docker.log.length).toBe(changes);
    expect(h.docker.execs.length).toBe(execs);
    expect(h.dockerStarts).toBe(0);
    expect(h.helper.calls).toEqual([]);
    expect(await h.registry.get(ENV_ID)).toBeDefined();
  });

  it('reads nothing of it from Docker', async () => {
    // The reads of the window go through windowStateInWorker.
    expect(await h.operations.windowStateInWorker((await h.registry.get(ENV_ID))!, 'devspaces-x', { branch: true })).toBeUndefined();
    // The one read of the removable volumes (removableVolumesOf).
    expect((await h.service.removableVolumesOf(ENV_ID)).additional).toEqual([]);
    expect(await h.service.repositoryServiceData(ENV_ID)).toEqual([]);
    expect((await h.operations.inspectStates())?.has(ENV_ID)).toBe(false);
  });

  it('the devspace of the local Docker is refused on a remote host too', async () => {
    await seedDevspace(h, { id: OTHER_ID, repository: 'acme/web' });
    const error = await rejection(h.operations.stop(OTHER_ID));
    expect(error.message).toBe(Messages.otherDockerHost('acme/web', '', 'other-box'));
    expect(error.message).toContain('the local Docker');
  });
});

describe('inspectStates shows the devspaces of the current host only', () => {
  it('leaves out the other hosts (which would otherwise show "files missing")', async () => {
    await seedDevspace(h, { container: 'running' });
    await seedDevspace(h, { id: OTHER_ID, repository: 'acme/web', container: null, volume: false, extra: { dockerHost: 'build-box' } });
    const states = await h.operations.inspectStates();
    expect([...(states?.keys() ?? [])]).toEqual([ENV_ID]);
    currentHost = 'build-box';
    expect([...((await h.operations.inspectStates())?.keys() ?? [])]).toEqual([OTHER_ID]);
  });
});

describe('restore after a lost registry reads only the current host', () => {
  it('stamps the restored entries with the current host', async () => {
    const name = resourceName(REPO, OTHER_ID);
    h.docker.volumes.set(name, { [LABEL_DEVSPACE_ID]: OTHER_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id });
    currentHost = 'build-box';
    expect(await h.service.reconcileFromVolumes()).toBe(1);
    expect((await h.registry.get(OTHER_ID))?.dockerHost).toBe('build-box');
  });

  it('a devspace of the same repository and account on another host does not keep it from being restored', async () => {
    await seedDevspace(h, { extra: { dockerHost: 'other-box' } });
    const name = resourceName(REPO, OTHER_ID);
    h.docker.volumes.set(name, { [LABEL_DEVSPACE_ID]: OTHER_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id });
    expect(await h.service.reconcileFromVolumes()).toBe(1);
    expect((await h.registry.get(OTHER_ID))?.dockerHost).toBeUndefined();
    expect((await h.registry.get(ENV_ID))?.dockerHost).toBe('other-box');
  });
});

describe('an endpoint that is neither local nor SSH is never reached', () => {
  const ENDPOINT = 'tcp://10.0.0.5:2375';
  let u: Harness;
  let dockerReads: Array<ReturnType<typeof vi.spyOn>>;

  beforeEach(async () => {
    u = createHarness({ dockerTarget: async () => ({ kind: 'unsupported', host: ENDPOINT, endpoint: ENDPOINT }) });
    // Seeded with a recorded endpoint that is neither local nor SSH (the registry is a file that anything can change),
    // and one of the local Docker.
    await seedDevspace(u, { container: 'running', extra: { dockerHost: ENDPOINT } });
    await seedDevspace(u, { id: OTHER_ID, repository: 'acme/web', container: 'running' });
    const docker = u.docker as unknown as Record<string, (...args: unknown[]) => unknown>;
    dockerReads = [
      'isRunning',
      'listDevspaceContainers',
      // The containers of one devspace are a call of the port.
      'devspaceContainers',
      'listDevspaceVolumes',
      'volumeExists',
      'findContainer',
      'inspectVolumes',
      'stopContainer',
      'exec',
    ]
      .filter((name) => typeof docker[name] === 'function')
      .map((name) => vi.spyOn(docker, name as never));
  });

  afterEach(() => {
    u.cleanup();
  });

  const noDockerCall = (): void => {
    for (const spy of dockerReads) expect(spy).not.toHaveBeenCalled();
    expect(u.dockerStarts).toBe(0);
    expect(u.helper.calls).toEqual([]);
  };

  it.each([
    ['open', () => u.service.open(TARGET, { progress: u.progress })],
    ['openDevspace', () => u.service.openDevspace(ENV_ID, { progress: u.progress })],
    ['stop', () => u.operations.stop(ENV_ID)],
    ['stop (local devspace)', () => u.operations.stop(OTHER_ID)],
    ['delete', () => u.service.delete(ENV_ID, { progress: u.progress, additionalVolumesToRemove: [] })],
    ['safetyCheck', () => u.service.safetyCheck(ENV_ID, { progress: u.progress })],
    ['listConfigurations', () => u.service.listConfigurations(ENV_ID, { progress: u.progress })],
  ])('%s is refused with dockerEndpointUnsupported, before any Docker call', async (_name, operation) => {
    const error = await rejection(operation());
    expect(error.code).toBe('dockerEndpointUnsupported');
    expect(error.message).toBe(Messages.dockerEndpointUnsupported(ENDPOINT));
    noDockerCall();
    expect(u.docker.log).toEqual([]);
  });

  it('the reads of the view and the restore do nothing, and the message is shown once', async () => {
    const name = resourceName('acme/lost', OTHER_ID.replace(/^./, 'f'));
    u.docker.volumes.set(name, { [LABEL_DEVSPACE_ID]: OTHER_ID.replace(/^./, 'f'), [LABEL_REPOSITORY]: 'acme/lost', [LABEL_OWNER_ID]: ACCOUNT.id });
    // The reads of the window (DevspaceOperations) and those of the pipeline (DevspaceService, which runs in the
    // worker) each show the message once.
    const shown = () => u.ui.warnings.filter((warning) => warning === Messages.dockerEndpointUnsupported(ENDPOINT));
    expect(await u.operations.inspectStates()).toEqual(new Map());
    // The reads of the window go through windowStateInWorker.
    expect(await u.operations.windowStateInWorker((await u.registry.get(ENV_ID))!, 'devspaces-x', { branch: true })).toBeUndefined();
    expect(await u.operations.inspectStates()).toEqual(new Map());
    expect(shown()).toHaveLength(1);
    expect(await u.service.reconcileFromVolumes()).toBe(0);
    // The one read of the removable volumes (removableVolumesOf).
    expect((await u.service.removableVolumesOf(ENV_ID)).additional).toEqual([]);
    expect((await u.service.removableVolumesOf(ENV_ID)).serviceData).toEqual([]);
    expect(await u.service.repositoryServiceData(ENV_ID)).toEqual([]);
    noDockerCall();
    // Never recorded as the host of a restored entry.
    expect((await u.registry.list()).filter((env) => env.repository === 'acme/lost')).toEqual([]);
    expect(shown()).toHaveLength(2);
  });
});

// `docker context inspect` fails (a context that was removed, a configuration file that cannot be read, a time-out).
// Without a context name, the Docker calls would go to the context that the Docker CLI finds, perhaps on another
// computer, while the devspace would record the local Docker. So nothing is done, with a message that says why.
describe('a current Docker context that cannot be read is never used', () => {
  let u: Harness;
  /** `docker context inspect` fails while this is false. */
  let readable: boolean;
  const NOT_READ = 'The current Docker context could not be read. Its containers and volumes are not read.';

  beforeEach(async () => {
    readable = false;
    const cli = {
      isInstalled: () => true,
      run: async () =>
        readable
          ? { exitCode: 0, stdout: JSON.stringify({ Name: 'default', Endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } }), stderr: '', timedOut: false }
          : { exitCode: 1, stdout: '', stderr: 'context "gone": context not found', timedOut: false },
    };
    const targets = new DockerTargets(cli, {}, silentLogger, 'linux');
    u = createHarness({ dockerTarget: () => targets.current() });
    await seedDevspace(u, { container: 'running' });
  });

  afterEach(() => {
    u.cleanup();
  });

  it('an operation is refused with the message before any Docker call, and the reads only log it', async () => {
    for (const operation of [() => u.service.open(TARGET, { progress: u.progress }), () => u.operations.stop(ENV_ID)]) {
      const error = await rejection(operation());
      expect(error.code).toBe('dockerEndpointUnsupported');
      expect(error.message).toBe(Messages.dockerContextUnreadable);
    }
    expect(await u.operations.inspectStates()).toEqual(new Map());
    expect(await u.operations.inspectStates()).toEqual(new Map());
    // No message from the reads: the sidebar names the context that cannot be read.
    expect(u.ui.warnings).toEqual([]);
    expect(u.logger.infos.filter((line) => line === NOT_READ)).toHaveLength(2);
    expect(u.dockerStarts).toBe(0);
    expect(u.helper.calls).toEqual([]);
    expect(u.docker.log).toEqual([]);
    // The devspace keeps its host (the local Docker).
    expect((await u.registry.get(ENV_ID))?.dockerHost).toBeUndefined();
  });

  // For example a time-out of `docker context inspect` during a refresh in the background (the window got the focus).
  it('a short failure in a background read shows no message and marks nothing: an operation shows it later', async () => {
    expect(await u.operations.inspectStates()).toEqual(new Map());
    readable = true;
    expect([...((await u.operations.inspectStates())?.keys() ?? [])]).toEqual([ENV_ID]);
    // A later failure: the reads still only log it, and an operation of the user is refused with the message.
    readable = false;
    expect(await u.operations.inspectStates()).toEqual(new Map());
    expect(u.ui.warnings).toEqual([]);
    expect(u.logger.infos.filter((line) => line === NOT_READ)).toHaveLength(2);
    const error = await rejection(u.operations.stop(ENV_ID));
    expect(error.message).toBe(Messages.dockerContextUnreadable);
  });
});

// The docker command is Podman (the package podman-docker): `docker context inspect` gives nothing, and the check of
// the CLI names Podman. Every operation says that Podman is not supported, not that the context cannot be read.
describe('a docker command that is Podman is never used', () => {
  const DETAIL = 'docker --version: podman version 5.2.2';
  let u: Harness;
  let targets: DockerTargets;

  beforeEach(async () => {
    const cli = {
      isInstalled: () => true,
      run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
      podmanCli: async () => DETAIL,
    };
    targets = new DockerTargets(cli, {}, silentLogger, 'linux');
    u = createHarness({ dockerTarget: () => targets.current() });
    await seedDevspace(u, { container: 'running' });
  });

  afterEach(() => {
    u.cleanup();
  });

  it('an operation is refused with the Podman message before any Docker call', async () => {
    await expect(targets.resolve()).resolves.toEqual(podmanDockerTarget(DETAIL));
    for (const operation of [() => u.service.open(TARGET, { progress: u.progress }), () => u.operations.stop(ENV_ID)]) {
      const error = await rejection(operation());
      expect(error.code).toBe('dockerEndpointUnsupported');
      expect(error.message).toBe(Messages.podmanNotSupported);
      expect(error.detail).toBe(DETAIL);
    }
    expect(u.dockerStarts).toBe(0);
    expect(u.helper.calls).toEqual([]);
    expect(u.docker.log).toEqual([]);
    expect((await u.registry.get(ENV_ID))?.dockerHost).toBeUndefined();
  });

  // Podman does not go away by itself, as an endpoint that is not supported.
  it('the reads show the Podman message once', async () => {
    expect(await u.operations.inspectStates()).toEqual(new Map());
    expect(await u.operations.inspectStates()).toEqual(new Map());
    expect(u.ui.warnings).toEqual([Messages.podmanNotSupported]);
  });
});
