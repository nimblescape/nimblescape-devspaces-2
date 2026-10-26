// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Stop and Delete under the lock of the devspace on the Docker host (DevspaceService withDevspaceLock). The
// worker is opened before (its lock); when that fails, the operation is refused and nothing is stopped or removed. No
// helper image is prepared before the lock. A lock held elsewhere is refused after the wait, with its message. The busy
// mark comes first, then the lock; both are released in `finally`.
//
// Start, Rebuild, a change of the configuration and Clone again under the same lock. An open of an existing devspace takes it
// after the start of Docker and the wait for another window's operation, around everything through the pipeline; a
// first open after its registry entry, before the volume. A refusal leaves no busy mark and nothing changed (a first
// open removes its new registry entry again). Re-entrant: the Delete of Clone again takes no second lock; the redirects
// of a first open to an existing devspace take one lock of that devspace.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DevspaceLockError, holdsDevspaceLock, runWithDevspaceLock, type HeldDevspaceLock } from '../docker/devspaceLock';
import { CommandError, UserFacingError } from '../errors';
import { Messages } from '../messages';
import { LABEL_DEVSPACE_ID } from '../names';
import { DEVSPACE_LOCK_WAIT_SECONDS, PipelineTexts, type RepositoryTarget } from './operationBase';
import { ACCOUNT, ENV_ID, PID, REPO, T0, WINDOW_ID, createHarness, seedDevspace, type Harness } from './devspaceService.testkit';
import { isBusyMarkLive } from '../busy';
import { DEFAULT_CONFIG_PATH } from './recordRules';

let h: Harness;
/** What happened, in order: `ensureImage`, `build`, `lock <id> <wait>`, `busy=<operation>` at the lock, `docker …`, `release`. */
let events: string[];
/** How the next lock ends: held, or an error. */
let lockOutcome: Error | undefined;
let releases: number;
/** The IDs of the locks asked for, in order. */
let lockedIds: string[];
/**
 * When set, each sleep of the service (the wait for another window's busy mark) is the event `busy wait` and runs this.
 */
let onSleep: (() => Promise<void>) | undefined;

function heldLock(devspaceId: string): HeldDevspaceLock {
  return {
    devspaceId,
    lost: new Promise(() => {}),
    release: async () => {
      releases++;
      events.push('release');
    },
  };
}

beforeEach(() => {
  events = [];
  lockOutcome = undefined;
  releases = 0;
  lockedIds = [];
  onSleep = undefined;
  h = createHarness({
    sleep: async () => {
      if (onSleep === undefined) return;
      events.push('busy wait');
      await onSleep();
    },
    devspaceLock: async (devspaceId, waitSeconds) => {
      lockedIds.push(devspaceId);
      events.push(`lock ${devspaceId} ${waitSeconds}`);
      const busy = (await h.registry.get(devspaceId))?.busy;
      events.push(`busy=${busy?.operation ?? 'none'}`);
      if (lockOutcome) throw lockOutcome;
      return heldLock(devspaceId);
    },
  });
  // The image before the lock is the non-maintaining ensureImagePresent (event `ensureImage`); the maintaining
  // ensureImageUse would add its own event, which no expectation of Stop or Delete has. ensureImagePresent is called
  // only by the worker of the tests (fakeWorkerFlow: Stop), as the extension's preparation of the worker; the
  // pipeline's withDevspaceLock (Delete, the opens) prepares no image. The image of an open is the own image
  // (ownImageUse; event `ownImageUse`).
  const ensure = h.helper.ensureImagePresent.bind(h.helper);
  h.helper.ensureImagePresent = async (options) => {
    events.push('ensureImage');
    return ensure(options);
  };
  const own = h.helper.ownImageUse.bind(h.helper);
  h.helper.ownImageUse = async (signal) => {
    events.push('ownImageUse');
    return own(signal);
  };
  const remove = h.docker.removeContainer.bind(h.docker);
  h.docker.removeContainer = async (ref) => {
    events.push(`docker rm${holdsDevspaceLock(ENV_ID) ? ' (locked)' : ''}`);
    return remove(ref);
  };
  const stop = h.docker.stopContainer.bind(h.docker);
  h.docker.stopContainer = async (ref) => {
    events.push(`docker stop${holdsDevspaceLock(ENV_ID) ? ' (locked)' : ''}`);
    return stop(ref);
  };
});

afterEach(() => {
  h?.cleanup();
});

function deleteOptions() {
  return { progress: h.progress, additionalVolumesToRemove: [] as string[] };
}

async function rejection(promise: Promise<unknown>): Promise<UserFacingError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UserFacingError) return error;
    throw error;
  }
  throw new Error('The promise did not reject.');
}

describe('Delete under the devspace lock', () => {
  it('takes the busy mark first, then the lock (10 s wait), removes under the lock, and releases both', async () => {
    await seedDevspace(h, { container: 'running' });
    await h.service.delete(ENV_ID, deleteOptions());
    // No helper image before the lock (the worker's own image).
    expect(events.slice(0, 4)).toEqual([`lock ${ENV_ID} ${DEVSPACE_LOCK_WAIT_SECONDS}`, 'busy=delete', 'docker stop (locked)', 'docker rm (locked)']);
    expect(events.at(-1)).toBe('release');
    expect(DEVSPACE_LOCK_WAIT_SECONDS).toBe(10);
    expect(await h.registry.get(ENV_ID)).toBeUndefined();
    expect(releases).toBe(1);
  });

  it('a lock held elsewhere refuses with its message, clears the busy mark, and removes nothing', async () => {
    await seedDevspace(h, { container: 'running' });
    lockOutcome = new DevspaceLockError('busy', 'The lock stayed held by another holder for 10 s.');
    const error = await rejection(h.service.delete(ENV_ID, deleteOptions()));
    expect(error.message).toBe(PipelineTexts.devspaceLockBusy(REPO));
    expect(error.message).toBe(`${REPO} is busy with an operation from another window or computer; try again in a moment.`);
    expect(h.docker.log).toEqual([]);
    expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
    expect(h.docker.volumes.size).toBeGreaterThan(0);
  });

  it('the worker cannot be opened: refused with the cause, nothing removed, the busy mark cleared', async () => {
    await seedDevspace(h, { container: 'running' });
    lockOutcome = new DevspaceLockError('unavailable', 'The helper channel to build-box was closed: it reaches another Docker engine.');
    const error = await rejection(h.service.delete(ENV_ID, deleteOptions()));
    expect(error.message).toBe(PipelineTexts.devspaceLockUnavailable(REPO, lockOutcome.message));
    expect(error.message).toContain('reaches another Docker engine');
    expect(h.docker.log).toEqual([]);
    expect(await h.registry.get(ENV_ID)).toMatchObject({ id: ENV_ID });
    expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
  });

  it('releases the lock and the busy mark when a removal fails under the lock', async () => {
    await seedDevspace(h, { container: 'running' });
    h.docker.removeContainer = async () => {
      events.push('docker rm fails');
      throw new CommandError('docker rm', 1, '', 'Error response from daemon: device or resource busy');
    };
    await expect(h.service.delete(ENV_ID, deleteOptions())).rejects.toThrow(/resource busy/);
    expect(events.slice(-2)).toEqual(['docker rm fails', 'release']);
    expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
  });

  it('is re-entrant: within a held lock of the devspace it takes no second one', async () => {
    await seedDevspace(h, { container: 'running' });
    await runWithDevspaceLock(heldLock(ENV_ID), () => h.service.delete(ENV_ID, deleteOptions()));
    expect(events.filter((event) => event.startsWith('lock') || event === 'ensureImage')).toEqual([]);
    expect(events).toContain('docker rm (locked)');
    // Only the release of the outer holder (the test) counts; the delete released nothing.
    expect(releases).toBe(0);
    expect(await h.registry.get(ENV_ID)).toBeUndefined();
  });
});

describe('Stop under the devspace lock', () => {
  // The Stop runs in the worker under the lock that it took itself, so no lock is held in this window.
  it('stops under the lock and releases it', async () => {
    await seedDevspace(h, { container: 'running' });
    await h.operations.stop(ENV_ID);
    expect(events).toEqual(['ensureImage', `lock ${ENV_ID} ${DEVSPACE_LOCK_WAIT_SECONDS}`, 'busy=none', 'docker stop', 'release']);
    expect(h.docker.containersOf(ENV_ID)[0].state).toBe('stopped');
  });

  it('a lock held elsewhere refuses with its message and stops nothing', async () => {
    await seedDevspace(h, { container: 'running' });
    lockOutcome = new DevspaceLockError('busy', 'held');
    const error = await rejection(h.operations.stop(ENV_ID));
    expect(error.message).toBe(PipelineTexts.devspaceLockBusy(REPO));
    expect(h.docker.log).toEqual([]);
    expect(h.docker.containersOf(ENV_ID)[0].state).toBe('running');
  });

  it('without a worker or a helper image it refuses and stops nothing; never the direct way', async () => {
    await seedDevspace(h, { container: 'running' });
    lockOutcome = new DevspaceLockError('unavailable', 'no image');
    expect((await rejection(h.operations.stop(ENV_ID))).message).toBe(PipelineTexts.devspaceLockUnavailable(REPO, 'no image'));
    lockOutcome = undefined;
    h.helper.ensureImageError = new UserFacingError('helperFailed', Messages.helperFailed, 'no space left on device');
    expect((await rejection(h.operations.stop(ENV_ID))).message).toContain('no space left on device');
    expect(h.docker.log).toEqual([]);
    expect(h.docker.execs).toEqual([]);
    expect(h.docker.containersOf(ENV_ID)[0].state).toBe('running');
  });

  // An earlier check recorded a new base digest, so the maintaining ensure would wait for a `--pull --no-cache` rebuild
  // (here: forever). Stop does not run it: it only ensures that the tag exists.
  it('a pending rebuild of the maintaining ensure does not delay Stop: only the tag is ensured, then the lock', async () => {
    await seedDevspace(h, { container: 'running' });
    // The image of an open is ownImageUse.
    h.helper.ownImageUse = () => {
      events.push('ownImageUse');
      return new Promise(() => {});
    };
    await h.operations.stop(ENV_ID);
    // `docker stop`, not `(locked)`, as above.
    expect(events).toEqual(['ensureImage', `lock ${ENV_ID} ${DEVSPACE_LOCK_WAIT_SECONDS}`, 'busy=none', 'docker stop', 'release']);
    expect(h.helper.calls).toContain('ensureImagePresent');
    expect(h.helper.calls).not.toContain('ensureImage');
    expect(h.docker.containersOf(ENV_ID)[0].state).toBe('stopped');
  });

  it('a failed build of the missing tag refuses Stop with the message of an unavailable lock, before the lock, with no fallback', async () => {
    await seedDevspace(h, { container: 'running' });
    h.helper.ensureImageError = new UserFacingError('helperFailed', Messages.helperFailed, 'failed to solve: node:22');
    const error = await rejection(h.operations.stop(ENV_ID));
    expect(error.message).toBe(PipelineTexts.devspaceLockUnavailable(REPO, `${Messages.helperFailed} failed to solve: node:22`));
    expect(events).toEqual(['ensureImage']);
    expect(h.docker.log).toEqual([]);
    expect(h.docker.containersOf(ENV_ID)[0].state).toBe('running');
  });

  it('Docker not running: no image, no lock', async () => {
    await seedDevspace(h, { container: 'running' });
    h.docker.running = false;
    await h.operations.stop(ENV_ID);
    expect(events).toEqual([]);
  });
});

describe('no unlocked path', () => {
  // Stop takes no lock in this window (withDevspaceLock); the worker takes it. The re-entrance of
  // withDevspaceLock is covered by "is re-entrant" (Delete) above.
  it('the default lock of the testkit is taken and released by Stop and Delete (the lock is required)', async () => {
    const plain = createHarness();
    try {
      await seedDevspace(plain, { container: 'running' });
      await plain.operations.stop(ENV_ID);
      await plain.service.delete(ENV_ID, { progress: plain.progress, additionalVolumesToRemove: [] });
      expect(plain.lock.acquired).toEqual([ENV_ID, ENV_ID]);
      expect(plain.lock.released).toEqual([ENV_ID, ENV_ID]);
    } finally {
      plain.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Start, Rebuild, a change of the configuration and Clone again under the devspace lock.

const TARGET: RepositoryTarget = { repository: REPO, defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };

function openOptions<T extends object = object>(extra?: T): { progress: typeof h.progress } & T {
  return { progress: h.progress, ...(extra ?? ({} as T)) };
}

/** The devspace ID of a workspace volume (by its label; the seeded devspace for a volume that is gone). */
function idOfVolume(name: string): string {
  return h.docker.volumes.get(name)?.[LABEL_DEVSPACE_ID] ?? lockedIds.at(-1) ?? ENV_ID;
}

/** ` (locked)` while the running operation holds the lock of the devspace of `volumeName`. */
function lockedSuffix(volumeName: string): string {
  return holdsDevspaceLock(idOfVolume(volumeName)) ? ' (locked)' : '';
}

/**
 * The events without the container steps of Delete (`docker stop`, `docker rm`) and the image of the open
 * (ownImageUse).
 */
function openEvents(): string[] {
  return events.filter((event) => !event.startsWith('docker stop') && !event.startsWith('docker rm') && event !== 'ownImageUse');
}

/**
 * The reads of a first open before its registry entry (unusedDevspaceId: the volume name with the word of the source
 * and the one without it are free); nothing is created.
 */
const FREE_NAME_CHECKS = ['docker volume exists', 'docker volume exists'];

describe('Start, Rebuild, a change of the configuration and Clone again under the devspace lock', () => {
  beforeEach(() => {
    // The Docker and helper steps of the open, each with whether it ran under the lock of its devspace.
    const volumeExists = h.docker.volumeExists.bind(h.docker);
    h.docker.volumeExists = async (name) => {
      events.push(`docker volume exists${lockedSuffix(name)}`);
      return volumeExists(name);
    };
    // The read of whose the workspace volume is (workspaceVolumeOwnership).
    const inspectVolumes = h.docker.inspectVolumes.bind(h.docker);
    h.docker.inspectVolumes = async (names) => {
      if (names.length === 1 && names[0].startsWith('devspaces-')) events.push(`docker volume inspect${lockedSuffix(names[0])}`);
      return inspectVolumes(names);
    };
    const createVolume = h.docker.createVolume.bind(h.docker);
    h.docker.createVolume = async (name, labels) => {
      events.push(`docker volume create${holdsDevspaceLock(labels[LABEL_DEVSPACE_ID]) ? ' (locked)' : ''}`);
      return createVolume(name, labels);
    };
    const removeVolume = h.docker.removeVolume.bind(h.docker);
    h.docker.removeVolume = async (name) => {
      events.push(`docker volume rm${lockedSuffix(name)}`);
      return removeVolume(name);
    };
    const clone = h.helper.clone.bind(h.helper);
    h.helper.clone = async (p) => {
      events.push(`clone${lockedSuffix(p.volumeName)}`);
      return clone(p);
    };
    const build = h.helper.build.bind(h.helper);
    h.helper.build = async (p) => {
      events.push(`build${lockedSuffix(p.volumeName)}`);
      return build(p);
    };
    const up = h.helper.up.bind(h.helper);
    h.helper.up = async (p) => {
      events.push(`up${lockedSuffix(p.volumeName)}`);
      return up(p);
    };
  });

  it('Start: the lock after the start of Docker and the wait for another window, before the volume check and the pipeline', async () => {
    // Another live window holds a busy mark; it ends during the first wait.
    await seedDevspace(h, { extra: { busy: { operation: 'rebuild', since: new Date(h.clock.now()).toISOString(), pid: 7777, windowId: 'window-2' } } });
    h.alivePids.add(7777);
    onSleep = async () => {
      await h.registry.updateDevspace(ENV_ID, (entry) => {
        delete entry.busy;
      });
    };
    await h.service.open(TARGET, openOptions());
    expect(h.dockerStarts).toBe(1);
    // The open reads whose the volume is; no helper image before the lock.
    expect(openEvents().slice(0, 4)).toEqual(['busy wait', `lock ${ENV_ID} ${DEVSPACE_LOCK_WAIT_SECONDS}`, 'busy=none', 'docker volume inspect (locked)']);
    expect(openEvents()).toContain('up (locked)');
    expect(openEvents()).not.toContain('up');
    expect(openEvents().at(-1)).toBe('release');
    expect(lockedIds).toEqual([ENV_ID]);
    expect(releases).toBe(1);
    expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
  });

  // withDevspaceLock prepares no helper image; a cancel before the lock ends the operation with its AbortError
  // before the lock is asked for.
  it('a cancel before the lock asks for no lock and starts nothing', async () => {
    await seedDevspace(h, { extra: { busy: { operation: 'rebuild', since: new Date(h.clock.now()).toISOString(), pid: 7777, windowId: 'window-2' } } });
    h.alivePids.add(7777);
    const controller = new AbortController();
    onSleep = async () => {
      await h.registry.updateDevspace(ENV_ID, (entry) => {
        delete entry.busy;
      });
      controller.abort();
    };
    const error = await rejection(h.service.open(TARGET, openOptions({ signal: controller.signal })));
    expect(error.code).toBe('cancelled');
    expect(openEvents()).toEqual(['busy wait']);
    expect(lockedIds).toEqual([]);
    expect(h.helper.calls).toEqual([]);
    expect(h.docker.log).toEqual([]);
  });

  it('Rebuild: builds and starts under the lock', async () => {
    await seedDevspace(h, { container: 'running' });
    await h.service.openDevspace(ENV_ID, openOptions({ forceRebuild: true }));
    expect(lockedIds).toEqual([ENV_ID]);
    expect(openEvents()).toEqual(expect.arrayContaining(['build (locked)', 'up (locked)']));
    expect(openEvents().filter((event) => event === 'build' || event === 'up')).toEqual([]);
    expect(openEvents().at(-1)).toBe('release');
    expect(releases).toBe(1);
  });

  it('a change of the configuration: applies the selected configuration under the lock', async () => {
    await seedDevspace(h, { container: 'running' });
    await h.service.openDevspace(ENV_ID, openOptions({ configPath: DEFAULT_CONFIG_PATH }));
    expect(lockedIds).toEqual([ENV_ID]);
    expect(openEvents()).toEqual(expect.arrayContaining(['build (locked)', 'up (locked)']));
    expect(openEvents().filter((event) => event === 'build' || event === 'up')).toEqual([]);
    expect(openEvents().at(-1)).toBe('release');
    expect(releases).toBe(1);
  });

  it('Clone again: the question, the new volume and the clone under the lock', async () => {
    await seedDevspace(h, { volume: false, container: null });
    h.ui.filesMissingAnswer = 'cloneAgain';
    await h.service.open(TARGET, openOptions());
    expect(lockedIds).toEqual([ENV_ID]);
    // No helper image before the lock.
    expect(openEvents().slice(0, 6)).toEqual([
      `lock ${ENV_ID} ${DEVSPACE_LOCK_WAIT_SECONDS}`,
      'busy=none',
      // The open reads whose the volume is.
      'docker volume inspect (locked)',
      'docker volume create (locked)',
      // And whose the new volume is before the clone.
      'docker volume inspect (locked)',
      'clone (locked)',
    ]);
    expect(openEvents()).toContain('up (locked)');
    expect(openEvents().at(-1)).toBe('release');
    expect(h.ui.prompts).toEqual([`filesMissing ${REPO}`]);
  });

  it('re-entrant: the Delete of "files missing" runs under the held lock and takes no second one', async () => {
    await seedDevspace(h, { volume: false, container: 'stopped' });
    h.ui.filesMissingAnswer = 'deleteDevspace';
    const error = await rejection(h.service.open(TARGET, openOptions()));
    expect(error.code).toBe('cancelled');
    expect(lockedIds).toEqual([ENV_ID]);
    // No helper image before the lock, neither of the open nor of the Delete within its lock.
    expect(events.filter((event) => event === 'ensureImage')).toEqual([]);
    expect(events).toContain('docker rm (locked)');
    expect(events).toContain('docker volume rm (locked)');
    expect(events.at(-1)).toBe('release');
    expect(releases).toBe(1);
    expect(await h.registry.get(ENV_ID)).toBeUndefined();
  });

  it('the resumed clone of an interrupted first open runs under the lock', async () => {
    const staleCreate = { operation: 'create' as const, since: '2026-09-24T15:00:00.000Z', pid: 999, windowId: 'window-old' };
    await seedDevspace(h, { record: null, container: null, extra: { busy: staleCreate } });
    await h.service.open(TARGET, openOptions());
    // The open reads whose the volume is; no helper image before the lock.
    expect(openEvents().slice(0, 4)).toEqual([`lock ${ENV_ID} ${DEVSPACE_LOCK_WAIT_SECONDS}`, 'busy=create', 'docker volume inspect (locked)', 'clone (locked)']);
    expect(openEvents()).toContain('up (locked)');
    expect(openEvents().at(-1)).toBe('release');
  });

  it.each([
    ['D3: busy', () => new DevspaceLockError('busy', 'The lock stayed held by another holder for 10 s.'), PipelineTexts.devspaceLockBusy(REPO)],
    ['D1: no worker', () => new DevspaceLockError('unavailable', 'no worker'), PipelineTexts.devspaceLockUnavailable(REPO, 'no worker')],
  ] as const)('a refused lock (%s) of Start changes nothing and leaves no busy mark or pending file', async (_name, refusal, message) => {
    await seedDevspace(h, { container: 'stopped' });
    lockOutcome = refusal();
    const error = await rejection(h.service.open(TARGET, openOptions()));
    expect(error.message).toBe(message);
    // No helper image before the lock (no call of ensureImagePresent).
    expect(events).toEqual([`lock ${ENV_ID} ${DEVSPACE_LOCK_WAIT_SECONDS}`, 'busy=none']);
    expect(h.docker.log).toEqual([]);
    expect(h.helper.calls).toEqual([]);
    expect(h.docker.containersOf(ENV_ID)[0].state).toBe('stopped');
    expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
    expect(await h.sessionFiles.readPendings()).toEqual([]);
  });

  it('a refused lock of Rebuild and of a change of the configuration builds nothing', async () => {
    await seedDevspace(h, { container: 'running' });
    lockOutcome = new DevspaceLockError('busy', 'held');
    expect((await rejection(h.service.openDevspace(ENV_ID, openOptions({ forceRebuild: true })))).message).toBe(PipelineTexts.devspaceLockBusy(REPO));
    expect((await rejection(h.service.openDevspace(ENV_ID, openOptions({ configPath: DEFAULT_CONFIG_PATH })))).message).toBe(PipelineTexts.devspaceLockBusy(REPO));
    // No helper image before the lock (no call of ensureImagePresent).
    expect(h.helper.calls).toEqual([]);
    expect(h.docker.log).toEqual([]);
    expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
  });

  it('a refused lock of Clone again asks nothing, creates no volume, and keeps a stale create mark as it was', async () => {
    const staleCreate = { operation: 'create' as const, since: '2026-09-24T15:00:00.000Z', pid: 999, windowId: 'window-old' };
    await seedDevspace(h, { volume: false, container: null, extra: { busy: staleCreate } });
    h.ui.filesMissingAnswer = 'cloneAgain';
    lockOutcome = new DevspaceLockError('busy', 'held');
    await rejection(h.service.open(TARGET, openOptions()));
    expect(h.ui.prompts).toEqual([]);
    expect(h.helper.clones).toEqual([]);
    expect(h.docker.volumes.size).toBe(0);
    expect((await h.registry.get(ENV_ID))?.busy).toEqual(staleCreate);
  });

  describe('first open', () => {
    it('takes the lock after the registry entry (with its create mark), before the volume, and clones and starts under it', async () => {
      await h.service.open(TARGET, openOptions());
      const [id] = lockedIds;
      expect(lockedIds).toEqual([id]);
      expect((await h.registry.list()).map((entry) => entry.id)).toEqual([id]);
      // No helper image before the lock.
      expect(openEvents().slice(0, 7)).toEqual([
        ...FREE_NAME_CHECKS,
        `lock ${id} ${DEVSPACE_LOCK_WAIT_SECONDS}`,
        'busy=create',
        'docker volume create (locked)',
        // The labels of the new volume are read (requireOwnVolume).
        'docker volume inspect (locked)',
        'clone (locked)',
      ]);
      expect(openEvents()).toContain('up (locked)');
      expect(openEvents().at(-1)).toBe('release');
      expect((await h.registry.get(id))?.busy).toBeUndefined();
    });

    it.each([
      ['D3: busy', () => new DevspaceLockError('busy', 'held'), PipelineTexts.devspaceLockBusy(REPO)],
      ['D1: no worker', () => new DevspaceLockError('unavailable', 'no worker'), PipelineTexts.devspaceLockUnavailable(REPO, 'no worker')],
    ] as const)('a refused lock (%s) removes the new registry entry and creates nothing on Docker', async (_name, refusal, message) => {
      lockOutcome = refusal();
      const error = await rejection(h.service.open(TARGET, openOptions()));
      expect(error.message).toBe(message);
      // No helper image before the lock (no call of ensureImagePresent).
      expect(events).toEqual([...FREE_NAME_CHECKS, `lock ${lockedIds[0]} ${DEVSPACE_LOCK_WAIT_SECONDS}`, 'busy=create']);
      expect(await h.registry.list()).toEqual([]);
      expect(h.docker.log).toEqual([]);
      expect(h.docker.volumes.size).toBe(0);
      expect(h.helper.calls).toEqual([]);
      expect(await h.sessionFiles.readPendings()).toEqual([]);
    });

    it('a lock wait that is cancelled removes the new registry entry too', async () => {
      const controller = new AbortController();
      h = recreateWithLock(async () => {
        controller.abort();
        throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
      });
      const error = await rejection(h.service.open(TARGET, openOptions({ signal: controller.signal })));
      expect(error.code).toBe('cancelled');
      expect(await h.registry.list()).toEqual([]);
      expect(h.docker.log).toEqual([]);
    });

    it('a failed clone is removed again under the lock, before the release', async () => {
      h.helper.cloneError = new CommandError('git clone', 128, '', 'Repository not found');
      await rejection(h.service.open(TARGET, openOptions()));
      const [id] = lockedIds;
      // No helper image before the lock.
      expect(openEvents()).toEqual([
        ...FREE_NAME_CHECKS,
        `lock ${id} ${DEVSPACE_LOCK_WAIT_SECONDS}`,
        'busy=create',
        'docker volume create (locked)',
        // The labels of the volume are read after its creation and before its removal, both under the lock.
        'docker volume inspect (locked)',
        'clone (locked)',
        'docker volume inspect (locked)',
        'docker volume rm (locked)',
        'release',
      ]);
      expect(await h.registry.list()).toEqual([]);
      expect(h.docker.volumes.size).toBe(0);
    });

    it('redirect: a first open that restores the devspace from its volume opens it with one lock of its ID', async () => {
      await seedDevspace(h, { container: 'stopped' });
      // The registry lost the entry; the labelled volume stays.
      await h.registry.remove(ENV_ID);
      await h.service.open(TARGET, openOptions());
      expect(lockedIds).toEqual([ENV_ID]);
      expect(releases).toBe(1);
      expect(openEvents()).toContain('up (locked)');
      expect((await h.registry.get(ENV_ID))?.owner.id).toBe(ACCOUNT.id);
    });

    it('redirect: a first open whose entry another window created meanwhile opens that one with one lock of its ID', async () => {
      await seedDevspace(h, { container: 'stopped' });
      // The lookup of `open` misses the entry (it is created "meanwhile"), so `add` of the first open conflicts.
      const find = h.registry.findForAccount.bind(h.registry);
      let lookups = 0;
      h.registry.findForAccount = async (...args: Parameters<typeof find>) => (++lookups === 1 ? undefined : find(...args));
      const add = h.registry.add.bind(h.registry);
      h.registry.add = async (devspace) => {
        if (devspace.id !== ENV_ID) throw new Error('One devspace per repository and account.');
        return add(devspace);
      };
      await h.service.open(TARGET, openOptions());
      expect(lockedIds).toEqual([ENV_ID]);
      expect(releases).toBe(1);
      expect(openEvents()).toContain('up (locked)');
      expect((await h.registry.list()).map((entry) => entry.id)).toEqual([ENV_ID]);
    });
  });

  // The listing of the configurations reads whose the volume is under the lock, so the volume cannot change between
  // the check and the listing of the helper.
  it('the listing of the configurations reads whose the volume is under the lock, before the listing of the helper', async () => {
    await seedDevspace(h, { container: 'running' });
    const listConfigurations = h.helper.listConfigurations.bind(h.helper);
    h.helper.listConfigurations = async (p) => {
      events.push(`listConfigurations${lockedSuffix(p.volumeName)}`);
      return listConfigurations(p);
    };
    await h.service.listConfigurations(ENV_ID, openOptions());
    const listing = openEvents().filter((event) => !event.startsWith('docker volume exists'));
    const lock = listing.indexOf(`lock ${ENV_ID} ${DEVSPACE_LOCK_WAIT_SECONDS}`);
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(listing.slice(lock + 1).filter((event) => event.startsWith('docker volume inspect') || event.startsWith('listConfigurations'))).toEqual([
      'docker volume inspect (locked)',
      'listConfigurations (locked)',
    ]);
    expect(listing.filter((event) => event === 'docker volume inspect')).toEqual([]);
    expect(lockedIds).toEqual([ENV_ID]);
  });
});

/** A harness of this file whose lock is `take` (for a lock that does something else than hold or refuse). */
function recreateWithLock(take: () => Promise<HeldDevspaceLock>): Harness {
  h.cleanup();
  return createHarness({ devspaceLock: take });
}

// A failed first open whose volume cannot be removed (for example the lock was lost, so every Docker call fails) keeps
// its registry entry with the create mark, so the interrupted clone is completed later.
describe('a failed first open whose volume cannot be removed', () => {
  function failing() {
    const h = createHarness({});
    h.helper.cloneError = new Error('clone cut off');
    const remove = h.docker.removeVolume.bind(h.docker);
    let lost = true;
    h.docker.removeVolume = async (name: string) => {
      if (lost) throw new CommandError(`docker volume rm ${name}`, null, '', 'The lock of the devspace on the Docker host was lost (worker lost); docker volume rm was not run.');
      return remove(name);
    };
    return {
      h,
      heal: () => {
        lost = false;
        h.helper.cloneError = undefined;
      },
    };
  }

  it('keeps the entry with its create mark and the volume; the next open completes the clone', async () => {
    const { h, heal } = failing();
    await expect(h.service.open(TARGET, { progress: h.progress })).rejects.toThrow();
    const [entry] = await h.registry.list();
    expect(entry?.busy?.operation).toBe('create');
    expect(h.docker.volumes.has(entry!.volumeName)).toBe(true);
    heal();
    const before = h.helper.calls.length;
    await h.service.open(TARGET, { progress: h.progress });
    expect(h.helper.calls.slice(before)).toContain('clone main');
    expect((await h.registry.get(entry!.id))?.busy).toBeUndefined();
  });

  it('keeps the create mark when the resumed clone fails again in the same window, so a later open still clones', async () => {
    const { h, heal } = failing();
    await expect(h.service.open(TARGET, { progress: h.progress })).rejects.toThrow();
    const [entry] = await h.registry.list();
    await expect(h.service.open(TARGET, { progress: h.progress })).rejects.toThrow();
    expect((await h.registry.get(entry!.id))?.busy?.operation).toBe('create');
    heal();
    const before = h.helper.calls.length;
    await h.service.open(TARGET, { progress: h.progress });
    expect(h.helper.calls.slice(before)).toContain('clone main');
    expect((await h.registry.get(entry!.id))?.busy).toBeUndefined();
  });

  it('Delete in the same window removes the kept devspace', async () => {
    const { h, heal } = failing();
    await expect(h.service.open(TARGET, { progress: h.progress })).rejects.toThrow();
    const [entry] = await h.registry.list();
    heal();
    await h.service.delete(entry!.id, { progress: h.progress, additionalVolumesToRemove: [] });
    expect(await h.registry.list()).toEqual([]);
    expect(h.docker.volumes.size).toBe(0);
  });

  // The kept create mark of this window counts as ended, so it blocks nothing while this window lives (the sidebar of
  // every window, other windows' Start and Delete); any window's next open completes the clone.
  const statuses = (now: number) =>
    [
      { windowId: WINDOW_ID, pid: PID, updatedAt: new Date(now).toISOString(), devspaceId: null, state: 'idle' },
      { windowId: 'window-2', pid: 777, updatedAt: new Date(now).toISOString(), devspaceId: null, state: 'idle' },
    ] as never[];

  it.each([
    ['after the failed first open', false],
    ['after a resume that fails again in the same window', true],
  ])('%s, the kept create mark is not live; another window resumes the clone', async (_name, resumeFailsFirst) => {
    const { h, heal } = failing();
    await expect(h.service.open(TARGET, { progress: h.progress })).rejects.toThrow();
    if (resumeFailsFirst) await expect(h.service.open(TARGET, { progress: h.progress })).rejects.toThrow();
    const [entry] = await h.registry.list();
    expect(entry?.busy?.operation).toBe('create');
    const now = T0 + 60_000;
    expect(isBusyMarkLive(entry!.busy!, { now, isAlive: (pid) => pid === PID || pid === 777, windowStatuses: statuses(now) })).toBe(false);
    const other = createHarness({
      registry: h.registry,
      sessionFiles: h.sessionFiles,
      docker: h.docker,
      helper: h.helper,
      owner: { windowId: 'window-2', pid: 777 },
      isProcessAlive: (pid) => pid === PID || pid === 777,
      windowStatuses: async () => statuses(Date.now()),
      sleep: async () => {},
    });
    heal();
    const before = h.helper.calls.length;
    await other.service.openDevspace(entry!.id, { progress: h.progress });
    expect(h.helper.calls.slice(before)).toContain('clone');
    expect((await h.registry.get(entry!.id))?.busy).toBeUndefined();
  });
});
