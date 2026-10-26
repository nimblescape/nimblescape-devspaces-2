// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Monitor container from the side of the pipeline (ensured right after the helper image, before the
// container is created or started; the record of this computer removed at Delete), and the flag of Close and Keep
// Running (cleared when a window connects, and by Stop). On every engine, local and remote, and an open is refused when
// the monitor cannot be ensured.
import { afterEach, describe, expect, it } from 'vitest';
import { abortError } from '../ports';
import type { DockerTarget } from '../docker/dockerHost';
import type { DevspaceSessionMonitor } from './devspacePorts';
import type { RepositoryTarget } from './operationBase';
import { ENV_ID, REPO, createHarness, seedDevspace, type Harness } from './devspaceService.testkit';
import { DEFAULT_CONFIG_PATH } from './recordRules';

const TARGET: RepositoryTarget = { repository: REPO, defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };

let h: Harness | undefined;
/** The seq of each first heartbeat. */
let seqs: number[] = [];
/** The signal of each ensure. */
let ensureSignals: Array<AbortSignal | undefined> = [];
/** For each ensure, the number of `up` and run-user-commands before it. */
let ensureAt: Array<{ ups: number; userCommands: number }> = [];

afterEach(() => {
  h?.cleanup();
  h = undefined;
});

interface Setup {
  h: Harness;
  calls: string[];
}

type Target = Pick<DockerTarget, 'kind' | 'host' | 'endpoint'>;

function setup(
  /** Or a function, for a target that changes during the open (its calls read `h.helper`). */
  target: Target | ((helper: Harness['helper']) => Target),
  behavior: {
    ensure?: (index: number) => Promise<unknown>;
    forget?: () => Promise<void>;
    heartbeat?: () => Promise<{ ok: true } | { ok: false; detail: string }>;
  } = {},
): Setup {
  const calls: string[] = [];
  seqs = [];
  ensureSignals = [];
  ensureAt = [];
  // The port takes no target; the calls name the engine of the open's target.
  const current = (): Target => (typeof target === 'function' ? target(created.helper) : target);
  const sessionMonitor: DevspaceSessionMonitor = {
    ensure: async (signal) => {
      ensureSignals.push(signal);
      ensureAt.push({ ups: created.helper.ups.length, userCommands: created.helper.userCommandRuns.length });
      const host = engineOf(current());
      calls.push(`ensure ${host}`);
      // In the order of the helper calls.
      created.helper.calls.push('remote monitor');
      return behavior.ensure?.(ensureSignals.length - 1);
    },
    heartbeat: async (devspaceId, keepRunning, seq) => {
      const host = engineOf(current());
      calls.push(`heartbeat ${host} ${devspaceId} ${keepRunning}`);
      seqs.push(seq);
      created.helper.calls.push('first heartbeat');
      return (await behavior.heartbeat?.()) ?? { ok: true };
    },
    forget: async (devspaceId) => {
      const host = engineOf(current());
      calls.push(`forget ${host} ${devspaceId}`);
      return behavior.forget?.();
    },
    images: async () => {},
  };
  const created = createHarness({ dockerTarget: async () => (typeof target === 'function' ? target(created.helper) : target), sessionMonitor });
  h = created;
  return { h: created, calls };
}

/** The engine in the calls: the host, or `local` for the local Docker. */
function engineOf(target: Pick<DockerTarget, 'kind' | 'host'>): string {
  return target.kind === 'local' ? 'local' : target.host;
}

const REMOTE = { kind: 'remote', host: 'build-box', endpoint: 'ssh://build-box' } as const;
const LOCAL = { kind: 'local', host: '', endpoint: 'unix:///var/run/docker.sock' } as const;

describe('the Monitor in the open pipeline', () => {
  it('a first open on a remote host ensures it once, after the helper image and before up', async () => {
    const { h, calls } = setup(REMOTE);
    const result = await h.service.open(TARGET, { progress: h.progress });
    // Then the first heartbeat of this computer for the new devspace, not kept. The monitor runs the image ID that
    // the open pinned for the current tag too; the label keeps the tag. Ensured again right after `up` started the
    // container. The port takes no target, helper tag or image (the worker's monitor runs its own helper image); the
    // engine is the target of the open.
    const ensure = 'ensure build-box';
    expect(calls).toEqual([ensure, `heartbeat build-box ${result.devspace.id} false`, ensure]);
    const order = h.helper.calls;
    expect(order.indexOf('ensureImage')).toBeLessThan(order.indexOf('remote monitor'));
    expect(order.indexOf('remote monitor')).toBeLessThan(order.indexOf('first heartbeat'));
    const up = order.findIndex((call) => call.startsWith('up '));
    expect(up).toBeGreaterThan(order.indexOf('first heartbeat'));
    expect(order.lastIndexOf('remote monitor')).toBeGreaterThan(up);
  });

  it('an open of a stopped devspace on a remote host ensures it before the container starts', async () => {
    const { h, calls } = setup(REMOTE);
    await seedDevspace(h, { container: 'stopped', extra: { dockerHost: 'build-box' } });
    await h.service.openDevspace(ENV_ID, { progress: h.progress });
    // The monitor runs the image ID that the open pinned. Ensured again right after `up` started the container. The
    // port takes no target, helper tag or image (the worker's monitor runs its own helper image); the engine is the
    // target of the open.
    const ensure = 'ensure build-box';
    expect(calls).toEqual([ensure, `heartbeat build-box ${ENV_ID} false`, ensure]);
    // The stopped container is started with `up` of the Dev Container CLI.
    const up = h.helper.calls.findIndex((call) => call.startsWith('up '));
    expect(up).toBeGreaterThan(h.helper.calls.indexOf('first heartbeat'));
    expect(h.helper.calls.indexOf('remote monitor')).toBeGreaterThan(h.helper.calls.indexOf('ensureImage'));
  });

  it('sends the keep-running flag of the usual rules in the first heartbeat', async () => {
    const { h, calls } = setup(REMOTE);
    await seedDevspace(h, { container: 'stopped', extra: { dockerHost: 'build-box', keepRunning: true } });
    await h.service.openDevspace(ENV_ID, { progress: h.progress });
    expect(calls).toContain(`heartbeat build-box ${ENV_ID} true`);
  });

  it('reads the flags from the registry again, with seq = the time before that read', async () => {
    const { h, calls } = setup(REMOTE);
    await seedDevspace(h, { container: 'stopped', extra: { dockerHost: 'build-box' } });
    await h.service.openDevspace(ENV_ID, { progress: h.progress });
    expect(seqs).toHaveLength(1);
    expect(Number.isSafeInteger(seqs[0]) && seqs[0] > 0).toBe(true);
    expect(calls).toContain(`heartbeat build-box ${ENV_ID} false`);
  });

  it('sends the flag for every devspace while stopOnClose is off', async () => {
    const { h, calls } = setup(REMOTE);
    h.settings.stopOnClose = false;
    await seedDevspace(h, { container: 'stopped', extra: { dockerHost: 'build-box' } });
    await h.service.openDevspace(ENV_ID, { progress: h.progress });
    expect(calls).toContain(`heartbeat build-box ${ENV_ID} true`);
  });

  it.each<[string, () => Promise<{ ok: true } | { ok: false; detail: string }>]>([
    ['fails', async () => ({ ok: false, detail: 'No such container: devspaces-monitor' })],
    ['throws', async () => Promise.reject(new Error('Docker Desktop is not installed.'))],
  ])('a first heartbeat that %s is a warning, and the open goes on', async (_name, heartbeat) => {
    const { h } = setup(REMOTE, { heartbeat });
    await seedDevspace(h, { container: 'stopped', extra: { dockerHost: 'build-box' } });
    await h.service.openDevspace(ENV_ID, { progress: h.progress });
    expect(h.helper.calls.some((call) => call.startsWith('up '))).toBe(true);
    expect(h.logger.warnings.some((line) => line.includes('The first heartbeat for') && line.includes('build-box'))).toBe(true);
  });

  // A monitor that cannot be ensured refuses the open, so no first heartbeat is sent and nothing is started.
  it('refuses the open of a stopped devspace when the monitor could not be ensured, before anything starts', async () => {
    const { h, calls } = setup(REMOTE, { ensure: async () => Promise.reject(new Error('unreachable')) });
    await seedDevspace(h, { container: 'stopped', extra: { dockerHost: 'build-box' } });
    await expect(h.service.openDevspace(ENV_ID, { progress: h.progress })).rejects.toMatchObject({ code: 'sessionMonitorFailed' });
    expect(calls.filter((call) => call.startsWith('heartbeat'))).toEqual([]);
    expect(h.helper.calls.some((call) => call.startsWith('up '))).toBe(false);
  });

  // The local Docker gets the same monitor.
  it('a first open on the local Docker ensures it once, then sends the first heartbeat, before up', async () => {
    const { h, calls } = setup(LOCAL);
    const result = await h.service.open(TARGET, { progress: h.progress });
    // Ensured again right after `up` started the container. The port takes no target, helper tag or image (the worker's
    // monitor runs its own helper image); the engine is the target of the open.
    const ensure = 'ensure local';
    expect(calls).toEqual([ensure, `heartbeat local ${result.devspace.id} false`, ensure]);
    const order = h.helper.calls;
    expect(order.indexOf('ensureImage')).toBeLessThan(order.indexOf('remote monitor'));
    expect(order.findIndex((call) => call.startsWith('up '))).toBeGreaterThan(order.indexOf('first heartbeat'));
  });

  // A failure fails the open, with a message that names the cause.
  it('a failure refuses the open with the cause', async () => {
    const { h } = setup(REMOTE, { ensure: async () => Promise.reject(new Error('ssh: connect to host build-box: timed out')) });
    const error = await h.service.open(TARGET, { progress: h.progress }).then(
      () => undefined,
      (failure: unknown) => failure as { code?: string; message?: string; detail?: string },
    );
    expect(error?.code).toBe('sessionMonitorFailed');
    expect(error?.message).toContain('the Monitor on the Docker engine could not be started (ssh: connect to host build-box: timed out)');
    expect(h.logger.warnings.some((line) => line.includes('The Monitor on build-box could not be started'))).toBe(true);
    expect(h.helper.calls.some((call) => call.startsWith('up '))).toBe(false);
  });

  // Also on the local Docker, and also a running container is not opened as it is.
  it('refuses the open on the local Docker, also of a running container', async () => {
    const { h } = setup(LOCAL, { ensure: async () => Promise.reject(new Error('docker run failed: image not found')) });
    await seedDevspace(h, { container: 'running' });
    await expect(h.service.openDevspace(ENV_ID, { progress: h.progress })).rejects.toMatchObject({ code: 'sessionMonitorFailed' });
    expect(h.logger.warnings.some((line) => line.includes('The Monitor on the local Docker could not be started'))).toBe(true);
  });

  it('a cancellation during it cancels the open', async () => {
    const controller = new AbortController();
    const { h } = setup(REMOTE, {
      ensure: async () => {
        controller.abort();
        throw abortError();
      },
    });
    await expect(h.service.open(TARGET, { progress: h.progress, signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
  });

  // The ensure gets the signal of the open, and a cancellation in it is a cancellation, never the refusal of a monitor
  // that could not be started.
  it('passes the signal of the open to the ensure; a cancellation in it is not reported as a refusal', async () => {
    const controller = new AbortController();
    const { h } = setup(REMOTE, {
      ensure: async () => {
        controller.abort();
        throw abortError();
      },
    });
    await seedDevspace(h, { container: 'stopped', extra: { dockerHost: 'build-box' } });
    await expect(h.service.openDevspace(ENV_ID, { progress: h.progress, signal: controller.signal })).rejects.not.toMatchObject({ code: 'sessionMonitorFailed' });
    expect(ensureSignals).toHaveLength(1);
    expect(ensureSignals[0]?.aborted).toBe(true);
    expect(h.logger.warnings.some((line) => line.includes('could not be started'))).toBe(false);
  });

  // The first heartbeat takes the flags of the entry as it is at that time (read again), with seq = the time before
  // that read.
  it('the first heartbeat reads the entry again (a flag set meanwhile counts), with seq taken before the read', async () => {
    const readAt: number[] = [];
    const { h, calls } = setup(REMOTE, {
      ensure: async () => {
        // Another window sets Keep Running When Closed while this open runs.
        await h.registry.updateDevspace(ENV_ID, (entry) => {
          entry.keepRunning = true;
        });
        const get = h.registry.get.bind(h.registry);
        h.registry.get = async (id: string) => {
          readAt.push(h.clock.now());
          return get(id);
        };
      },
    });
    await seedDevspace(h, { container: 'stopped', extra: { dockerHost: 'build-box' } });
    await h.service.openDevspace(ENV_ID, { progress: h.progress });
    expect(calls).toContain(`heartbeat build-box ${ENV_ID} true`);
    expect(seqs).toHaveLength(1);
    expect(readAt.length).toBeGreaterThan(0);
    expect(seqs[0]).toBeLessThan(readAt[0]);
  });
});

// The monitor may have exited when idle during the clone and the build; the open ensures it again right after `up`
// created or started the container, before the lifecycle commands, once per run. A failure there does not refuse the
// open (the container runs already): it is logged, and the user is warned.
describe('the Monitor again after the container started', () => {
  it('ensures it again after `up` and before the lifecycle commands, with the same image and the signal of the open', async () => {
    const { h, calls } = setup(REMOTE);
    await seedDevspace(h, { container: 'stopped', extra: { dockerHost: 'build-box' } });
    const controller = new AbortController();
    await h.service.openDevspace(ENV_ID, { progress: h.progress, signal: controller.signal });
    expect(calls.filter((call) => call.startsWith('ensure'))).toHaveLength(2);
    expect(ensureAt).toEqual([
      { ups: 0, userCommands: 0 },
      { ups: 1, userCommands: 0 },
    ]);
    expect(h.helper.userCommandRuns).toHaveLength(1);
    expect(ensureSignals[1]).toBe(ensureSignals[0]);
    expect(ensureSignals[1]).toBeDefined();
  });

  it('a first open (clone, build, create) ensures it again after the container was created', async () => {
    const { h } = setup(LOCAL);
    await h.service.open(TARGET, { progress: h.progress });
    expect(ensureAt).toEqual([
      { ups: 0, userCommands: 0 },
      { ups: 1, userCommands: 0 },
    ]);
  });

  it('a running container that opens as it is: the first ensure only (it ran all along)', async () => {
    const { h } = setup(LOCAL);
    await seedDevspace(h, { container: 'running' });
    await h.service.openDevspace(ENV_ID, { progress: h.progress });
    expect(ensureAt).toEqual([{ ups: 0, userCommands: 0 }]);
  });

  it('a failure after the start is logged and shown as a warning, and the open goes on', async () => {
    const { h } = setup(REMOTE, { ensure: async (index) => (index === 1 ? Promise.reject(new Error('ssh: connect to host build-box: timed out')) : undefined) });
    await seedDevspace(h, { container: 'stopped', extra: { dockerHost: 'build-box' } });
    const result = await h.service.openDevspace(ENV_ID, { progress: h.progress });
    expect(result.devspace.id).toBe(ENV_ID);
    expect(h.helper.userCommandRuns).toHaveLength(1);
    expect(h.logger.warnings.some((line) => line.includes(`The Monitor on build-box could not be started again after the container of ${REPO} started`))).toBe(true);
    expect(h.ui.warnings).toContainEqual(expect.stringContaining('The Monitor on the Docker host build-box could not be started after the container of'));
    expect(h.ui.warnings).toContainEqual(expect.stringContaining('(ssh: connect to host build-box: timed out)'));
  });

  it('a cancellation in it cancels the open, and is not reported as a failure', async () => {
    const controller = new AbortController();
    const { h } = setup(REMOTE, {
      ensure: async (index) => {
        if (index !== 1) return;
        controller.abort();
        throw abortError();
      },
    });
    await seedDevspace(h, { container: 'stopped', extra: { dockerHost: 'build-box' } });
    await expect(h.service.openDevspace(ENV_ID, { progress: h.progress, signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(h.ui.warnings.some((line) => line.includes('could not be started after the container'))).toBe(false);
  });

  it('a failed `up` that may have left a container running ensures it too, and keeps the error of `up`', async () => {
    const { h } = setup(REMOTE);
    await seedDevspace(h, { container: 'stopped', extra: { dockerHost: 'build-box' } });
    h.helper.upError = () => new Error('devcontainer up failed: port is already allocated');
    await expect(h.service.openDevspace(ENV_ID, { progress: h.progress })).rejects.toMatchObject({ code: 'startFailed' });
    expect(ensureAt).toEqual([
      { ups: 0, userCommands: 0 },
      { ups: 1, userCommands: 0 },
    ]);
  });

  // Third verifier: lifecycle commands that fail leave the container running ("It is left running"); the monitor was
  // ensured before them, so it exists to stop the container after the limit of its record.
  it('lifecycle commands that cannot run come after it, and a failed second ensure keeps the error of the open', async () => {
    const { h } = setup(REMOTE, { ensure: async (index) => (index === 1 ? Promise.reject(new Error('unreachable')) : undefined) });
    await seedDevspace(h, { container: 'stopped', extra: { dockerHost: 'build-box' } });
    h.helper.userCommandsError = new Error('devcontainer run-user-commands failed');
    await expect(h.service.openDevspace(ENV_ID, { progress: h.progress })).rejects.toMatchObject({ code: 'startFailed' });
    expect(ensureAt).toEqual([
      { ups: 0, userCommands: 0 },
      { ups: 1, userCommands: 0 },
    ]);
    expect(h.ui.warnings).toContainEqual(expect.stringContaining('could not be started after the container of'));
  });
});

// The failure paths of the second ensure of runUp.
describe('the Monitor again after the container started: failure paths', () => {
  /** True once the helper ran `up`. */
  const afterUp = (helper: Harness['helper']) => helper.calls.some((call) => call.startsWith('up '));
  const UNSUPPORTED = { kind: 'unsupported', host: 'tcp://x', endpoint: 'tcp://x' } as const;

  // A cancellation of the open's signal itself ends any open as cancelled (toUserError); here the second ensure rejects
  // with an AbortError while the signal of the open is not aborted, which must not replace the error of `up`.
  it('a failed `up` keeps its error when the second ensure rejects with an AbortError', async () => {
    const controller = new AbortController();
    const { h } = setup(REMOTE, { ensure: async (index) => (index === 1 ? Promise.reject(abortError()) : undefined) });
    await seedDevspace(h, { container: 'stopped', extra: { dockerHost: 'build-box' } });
    h.helper.upError = () => new Error('devcontainer up failed: port is already allocated');
    const error = await h.service.openDevspace(ENV_ID, { progress: h.progress, signal: controller.signal }).then(
      () => undefined,
      (failure: unknown) => failure as { code?: string; detail?: string },
    );
    expect(error?.code).toBe('startFailed');
    expect(error?.detail).toContain('port is already allocated');
    expect(ensureAt).toHaveLength(2);
  });

  it('a cancelled `up` does not ensure it again: the first ensure only', async () => {
    const controller = new AbortController();
    const { h } = setup(REMOTE);
    await seedDevspace(h, { container: 'stopped', extra: { dockerHost: 'build-box' } });
    h.helper.upError = () => {
      controller.abort();
      return abortError();
    };
    await expect(h.service.openDevspace(ENV_ID, { progress: h.progress, signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(ensureAt).toEqual([{ ups: 0, userCommands: 0 }]);
  });

  it('never ensures it after `up` when the first ensure did not run', async () => {
    // The target reads as unsupported only while the first ensure would run (after the helper image, before `up`).
    const { h, calls } = setup((helper) => (helper.calls.includes('ensureImage') && !afterUp(helper) ? UNSUPPORTED : LOCAL));
    await seedDevspace(h, { container: 'stopped' });
    await h.service.openDevspace(ENV_ID, { progress: h.progress });
    expect(h.helper.ups).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith('ensure'))).toEqual([]);
  });

  it('does not ensure it after `up` on a target that is neither local nor remote', async () => {
    const { h, calls } = setup((helper) => (afterUp(helper) ? UNSUPPORTED : LOCAL));
    await seedDevspace(h, { container: 'stopped' });
    await h.service.openDevspace(ENV_ID, { progress: h.progress });
    expect(h.helper.ups).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith('ensure'))).toHaveLength(1);
    expect(h.ui.warnings.some((line) => line.includes('could not be started after the container'))).toBe(false);
  });

  it('a failure on the local Docker names the local Docker, not a Docker host', async () => {
    const { h } = setup(LOCAL, { ensure: async (index) => (index === 1 ? Promise.reject(new Error('docker run failed')) : undefined) });
    await seedDevspace(h, { container: 'stopped' });
    await h.service.openDevspace(ENV_ID, { progress: h.progress });
    expect(h.ui.warnings).toContainEqual(expect.stringContaining(`The Monitor on the local Docker could not be started after the container of ${REPO}`));
    expect(h.ui.warnings.some((line) => line.includes('Docker host '))).toBe(false);
    expect(h.logger.warnings.some((line) => line.includes(`The Monitor on the local Docker could not be started again after the container of ${REPO}`))).toBe(true);
  });

  it('a target that cannot be read after `up` is a warning, and the open goes on (code note)', async () => {
    let thrown = false;
    const { h, calls } = setup((helper) => {
      if (afterUp(helper) && !thrown) {
        thrown = true;
        throw new Error('docker context inspect failed');
      }
      return LOCAL;
    });
    await seedDevspace(h, { container: 'stopped' });
    const result = await h.service.openDevspace(ENV_ID, { progress: h.progress });
    expect(result.devspace.id).toBe(ENV_ID);
    expect(thrown).toBe(true);
    expect(calls.filter((call) => call.startsWith('ensure'))).toHaveLength(1);
    expect(h.helper.userCommandRuns).toHaveLength(1);
    expect(h.ui.warnings).toContainEqual(expect.stringContaining('The Monitor on the Docker engine could not be started after the container of'));
    expect(h.ui.warnings).toContainEqual(expect.stringContaining('(docker context inspect failed)'));
    expect(h.logger.warnings.some((line) => line.includes('The Monitor on the Docker engine could not be started again'))).toBe(true);
  });
});

describe('Close and Keep Running in the registry', () => {
  it('an open clears keepRunningOnce (a window connects again) and keeps keepRunning', async () => {
    const { h } = setup(LOCAL);
    await seedDevspace(h, { container: 'running', extra: { keepRunningOnce: true, keepRunning: true } });
    await h.service.openDevspace(ENV_ID, { progress: h.progress });
    const entry = await h.registry.get(ENV_ID);
    expect(entry).not.toHaveProperty('keepRunningOnce');
    expect(entry?.keepRunning).toBe(true);
  });

  it('Stop clears keepRunningOnce, also when the container does not run', async () => {
    const { h } = setup(LOCAL);
    await seedDevspace(h, { container: 'stopped', extra: { keepRunningOnce: true } });
    await h.operations.stop(ENV_ID);
    expect(await h.registry.get(ENV_ID)).not.toHaveProperty('keepRunningOnce');
  });
});

describe('Delete and the record of this computer', () => {
  it('removes the record of this computer on the remote monitor', async () => {
    const { h, calls } = setup(REMOTE);
    await seedDevspace(h, { container: 'stopped', extra: { dockerHost: 'build-box' } });
    await h.service.delete(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] });
    expect(await h.registry.get(ENV_ID)).toBeUndefined();
    expect(calls).toContain(`forget build-box ${ENV_ID}`);
  });

  it('a failure of the removal is only logged', async () => {
    const { h } = setup(REMOTE, { forget: async () => Promise.reject(new Error('unreachable')) });
    await seedDevspace(h, { container: 'stopped', extra: { dockerHost: 'build-box' } });
    await h.service.delete(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] });
    expect(await h.registry.get(ENV_ID)).toBeUndefined();
    // The text names the Monitor of any engine.
    expect(h.logger.warnings.some((line) => line.includes('remove the heartbeat record from the Monitor'))).toBe(true);
  });

  it('removes the record of this computer on the local Docker too', async () => {
    const { h, calls } = setup(LOCAL);
    await seedDevspace(h, { container: 'stopped' });
    await h.service.delete(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] });
    expect(await h.registry.get(ENV_ID)).toBeUndefined();
    expect(calls.filter((call) => call.startsWith('forget'))).toEqual([`forget local ${ENV_ID}`]);
  });
});

// The image maintenance of the monitor in the open pipeline, on every engine.
describe('the image list for the Monitor in the open pipeline', () => {
  function withImages(target: Pick<DockerTarget, 'kind' | 'host' | 'endpoint'>, images: (host: string) => Promise<void>) {
    const calls: string[] = [];
    const sessionMonitor: DevspaceSessionMonitor = {
      // The port takes no target; the calls name the engine of the open's target.
      ensure: async () => {
        calls.push(`ensure ${engineOf(target)}`);
      },
      heartbeat: async () => {
        calls.push(`heartbeat ${engineOf(target)}`);
        return { ok: true };
      },
      forget: async () => {},
      images: async () => {
        calls.push(`images ${engineOf(target)}`);
        return images(engineOf(target));
      },
    };
    const created = createHarness({ dockerTarget: async () => target, sessionMonitor });
    h = created;
    return { h: created, calls };
  }

  it('sends it after the monitor is ensured and before the first heartbeat, on every engine', async () => {
    const remote = withImages(REMOTE, async () => {});
    await seedDevspace(remote.h, { container: 'stopped', extra: { dockerHost: 'build-box' } });
    await remote.h.service.openDevspace(ENV_ID, { progress: remote.h.progress });
    // The monitor is ensured again after `up` (no image list then).
    expect(remote.calls).toEqual(['ensure build-box', 'images build-box', 'heartbeat build-box', 'ensure build-box']);
    const local = withImages(LOCAL, async () => {});
    await seedDevspace(local.h, { container: 'stopped' });
    await local.h.service.openDevspace(ENV_ID, { progress: local.h.progress });
    // On the local Docker too, and ensured again after `up`.
    expect(local.calls).toEqual(['ensure local', 'images local', 'heartbeat local', 'ensure local']);
  });

  it('a failure is a warning, and the open goes on', async () => {
    const { h, calls } = withImages(REMOTE, async () => Promise.reject(new Error('GitHub answered HTTP 403')));
    await seedDevspace(h, { container: 'stopped', extra: { dockerHost: 'build-box' } });
    await h.service.openDevspace(ENV_ID, { progress: h.progress });
    expect(calls).toContain('heartbeat build-box');
    // The line names the image settings and the images in use.
    expect(h.logger.warnings).toContain('The image settings and the images in use for the Monitor on build-box could not be sent: GitHub answered HTTP 403');
  });
});
