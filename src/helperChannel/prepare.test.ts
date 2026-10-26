// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The headless prepare in the worker: the operation `prepare` (no request to the extension, no secret), the prepare
// lock that it takes without a wait (takePrepareLock), the stop request of a Delete (workerPrepareLock.stop, and the
// poll of runPrepare), and the files next to the prepare lock (PREPARE_FILES).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCK_BUSY_EXIT, flockNoWaitArgs, parsePrepareParams, parsePrepareValue, prepareStopFilePath, prepareStoppedFilePath, type AskKind } from '../core/helperChannel/protocol';
import { FLOCK_FD, type FlockProcess } from '../core/helperChannel/lockFile';
import { LABEL_DEVSPACE_ID, LABEL_OWNER_ID, LABEL_REPOSITORY, resourceName } from '../core/names';
import { isAbortError } from '../core/ports';
import type { DockerEngine } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import type { OwnHelper } from '../core/worker/ownHelper';
import { prepareOperation } from './flowOperations';
import type { LockDeps } from './lock';
import { contextSecrets } from './operationContext.testkit';
import { PREPARE_FILES, type PrepareFiles } from './prepareFiles';
import { runPrepare } from './prepare';
import type { OperationContext } from './server';
import { takePrepareLock, workerPrepareLock } from './workerLock';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const REPO = 'acme/api';
const NAME = resourceName(REPO, ID);
const OWN: OwnHelper = { image: { tag: 'devspaces-worker:abc', id: `sha256:${'a'.repeat(64)}` }, socket: '/run/user/1000/docker.sock' };
const HASH = `sha256:${'5'.repeat(64)}`;

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-prepare-'));
  temps.push(dir);
  return dir;
}

/** In-memory PrepareFiles with a log of their use. */
function memoryFiles(stopRequested = false): PrepareFiles & { events: string[] } {
  const events: string[] = [];
  let requested = stopRequested;
  return {
    events,
    requestStop: (_dir, id) => {
      events.push(`request ${id}`);
      requested = true;
    },
    stopRequested: () => requested,
    removeStop: (_dir, id) => {
      events.push(`remove ${id}`);
      requested = false;
    },
    readStopped: () => undefined,
    writeStopped: (_dir, id, hash) => void events.push(`stopped ${id} ${hash}`),
  };
}

/** LockDeps with a fake flock that exits with `exitCode` (or waits until it is killed: `undefined`). */
function lockDeps(exitCode: number | undefined, files?: PrepareFiles, events: string[] = []): LockDeps {
  return {
    stateDir: '/state',
    openLockFile: () => {
      events.push('open devspace lock');
      return 8;
    },
    openPrepareLockFile: (_dir, id) => {
      events.push(`open prepare lock ${id}`);
      return 9;
    },
    ...(files !== undefined ? { prepareFiles: files } : {}),
    closeFile: () => events.push('close'),
    startFlock: (args): FlockProcess => {
      events.push(`flock ${args.join(' ')}`);
      let killed: (outcome: { exitCode: number | null }) => void = () => {};
      const ended = new Promise<{ exitCode: number | null }>((resolve) => (killed = resolve));
      return {
        exited: exitCode === undefined ? ended : Promise.resolve({ exitCode }),
        kill: () => {
          events.push('kill');
          killed({ exitCode: null });
        },
      };
    },
  };
}

function contextOf(asks: string[], logs: string[] = []): { context: OperationContext; controller: AbortController } {
  const controller = new AbortController();
  const context: OperationContext = {
    signal: controller.signal,
    ...contextSecrets({}, async (kind: AskKind, payload) => {
      asks.push(`${kind} ${JSON.stringify(payload)}`);
      throw new Error('A prepare asked the extension.');
    }),
    progress: () => {},
    log: (line) => logs.push(line),
    output: () => {},
  };
  return { context, controller };
}

/** An engine with the workspace volume of the devspace (or none); its containers come after `containersAfterMs`. */
function engineWith(volume: boolean, containersAfterMs = 0): DockerEngine {
  return {
    ...unusedEngine(),
    volumeNames: async () => (volume ? [NAME] : []),
    inspect: async (kind, reference) =>
      kind === 'volume' && volume && reference === NAME ? { Name: NAME, Labels: { [LABEL_DEVSPACE_ID]: ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: '42' } } : undefined,
    containers: async () => {
      await new Promise((resolve) => setTimeout(resolve, containersAfterMs));
      return [];
    },
  };
}

describe('the operation prepare', () => {
  it('takes only the ID of a devspace', () => {
    expect(parsePrepareParams({ devspaceId: ID })).toEqual({ devspaceId: ID });
    expect(parsePrepareParams({ devspaceId: '../x' })).toBeUndefined();
    expect(parsePrepareParams({ devspaceId: ID, token: 'x' })).toBeUndefined();
    expect(parsePrepareValue({ outcome: 'prepared', detail: 'd', seconds: 3 })).toEqual({ outcome: 'prepared', detail: 'd', seconds: 3 });
    expect(parsePrepareValue({ outcome: 'built', detail: 'd', seconds: 3 })).toBeUndefined();
    expect(parsePrepareValue({ outcome: 'skipped', detail: 'd', seconds: -1 })).toBeUndefined();
  });

  it('skips a devspace without a workspace volume, and asks the extension nothing', async () => {
    const asks: string[] = [];
    const logs: string[] = [];
    const { context } = contextOf(asks, logs);
    const events: string[] = [];
    const operation = prepareOperation(() => engineWith(false), async () => OWN, async () => Promise.reject(new Error('no batch')), lockDeps(0, memoryFiles(), events));
    const value = parsePrepareValue(await operation({ devspaceId: ID }, context));
    expect(value).toMatchObject({ outcome: 'skipped', detail: 'it has no workspace volume on this engine' });
    expect(asks).toEqual([]);
    expect(events).toEqual([]);
    expect(logs).toContain(`${ID}: no prepare: it has no workspace volume on this engine.`);
  });

  it('skips while the prepare lock is held elsewhere (taken without a wait, never the devspace lock)', async () => {
    const asks: string[] = [];
    const { context } = contextOf(asks);
    const events: string[] = [];
    const operation = prepareOperation(() => engineWith(true), async () => OWN, async () => Promise.reject(new Error('no batch')), lockDeps(LOCK_BUSY_EXIT, memoryFiles(), events));
    const value = parsePrepareValue(await operation({ devspaceId: ID }, context));
    expect(value).toMatchObject({ outcome: 'skipped', detail: 'its prepare lock is held (it is tried again at the next pass)' });
    expect(events).toEqual([`open prepare lock ${ID}`, `flock ${flockNoWaitArgs(FLOCK_FD).join(' ')}`, 'close']);
    expect(asks).toEqual([]);
  });

  it('ends as cancelled when a Delete asks it to stop while it holds the lock, and takes the request', async () => {
    const asks: string[] = [];
    const logs: string[] = [];
    const { context } = contextOf(asks, logs);
    const files = memoryFiles(true);
    const events: string[] = [];
    // The poll of the stop request (every 5 ms here) comes before the list of the containers (after 60 ms).
    const result = await runPrepare(
      {
        engine: engineWith(true, 60),
        ownHelper: OWN,
        logger: { info: (line) => logs.push(line), warn: (line) => logs.push(line), error: (line) => logs.push(line), output: () => {} },
        analyzer: { analyze: async () => Promise.reject(new Error('no analysis')) },
        lockDeps: lockDeps(0, files, events),
        openBatch: async () => Promise.reject(new Error('no batch')),
        signal: context.signal,
        stopPollMs: 5,
      },
      ID,
    );
    expect(result).toMatchObject({ outcome: 'cancelled', detail: 'it was asked to stop' });
    expect(files.events).toEqual([`remove ${ID}`]);
    expect(logs).toContain(`A Delete asked the prepare of ${ID} to stop.`);
    // The lock was taken and let go.
    expect(events.filter((event) => event === 'close')).toHaveLength(1);
    expect(asks).toEqual([]);
  });
});

describe('takePrepareLock', () => {
  it('holds the lock until release (once), with the batch helper of the prepare, and is lost when the prepare stops', async () => {
    const events: string[] = [];
    const controller = new AbortController();
    const held = await takePrepareLock(lockDeps(0, undefined, events), ID, controller.signal, async () => Promise.reject(new Error('no batch')));
    expect(held?.devspaceId).toBe(ID);
    expect(events).toEqual([`open prepare lock ${ID}`, `flock ${flockNoWaitArgs(FLOCK_FD).join(' ')}`]);
    let lost: string | undefined;
    void held!.lost.then((reason) => (lost = reason));
    controller.abort();
    await Promise.resolve();
    await Promise.resolve();
    expect(lost).toBe('the prepare was stopped');
    await held!.release();
    await held!.release();
    expect(events.filter((event) => event === 'close')).toHaveLength(1);
  });

  it('is undefined while another holder has it, rejects when it cannot be asked, and is an AbortError after a cancel', async () => {
    expect(await takePrepareLock(lockDeps(LOCK_BUSY_EXIT), ID, new AbortController().signal, async () => Promise.reject(new Error('x')))).toBeUndefined();
    await expect(takePrepareLock(lockDeps(1), ID, new AbortController().signal, async () => Promise.reject(new Error('x')))).rejects.toThrow('The prepare lock could not be taken: flock failed (exit code 1)');
    const { openPrepareLockFile: _open, ...without } = lockDeps(0);
    await expect(takePrepareLock(without, ID, new AbortController().signal, async () => Promise.reject(new Error('x')))).rejects.toThrow('The worker has no prepare lock.');
    const controller = new AbortController();
    controller.abort();
    const error = await takePrepareLock(lockDeps(undefined), ID, controller.signal, async () => Promise.reject(new Error('x'))).catch((thrown: unknown) => thrown);
    expect(isAbortError(error)).toBe(true);
  });
});

describe('the stop of a prepare by a Delete (workerPrepareLock.stop)', () => {
  function contextFor(): OperationContext {
    return { signal: new AbortController().signal, ...contextSecrets({}), progress: () => {}, log: () => {}, output: () => {} } as unknown as OperationContext;
  }

  it('requests the stop, waits for the lock at most its seconds, and removes the request after the wait', async () => {
    const files = memoryFiles();
    const events: string[] = [];
    const lock = workerPrepareLock(lockDeps(0, files, events), contextFor());
    expect(await lock.stop!(ID, 20, undefined)).toBe(true);
    expect(files.events).toEqual([`request ${ID}`, `remove ${ID}`]);
    expect(events).toContain(`flock -w 20 -E ${LOCK_BUSY_EXIT} ${FLOCK_FD}`);
  });

  it('says false when the prepare did not stop in time, and keeps the request for it', async () => {
    const files = memoryFiles();
    const lock = workerPrepareLock(lockDeps(LOCK_BUSY_EXIT, files), contextFor());
    expect(await lock.stop!(ID, 20, undefined)).toBe(false);
    expect(files.events).toEqual([`request ${ID}`]);
    expect(files.stopRequested('/state', ID)).toBe(true);
  });
});

describe('the files of a prepare next to its lock (PREPARE_FILES)', () => {
  it('writes, sees and removes the stop request as a plain file of its own', () => {
    const dir = tempDir();
    expect(PREPARE_FILES.stopRequested(dir, ID)).toBe(false);
    PREPARE_FILES.requestStop(dir, ID);
    const file = prepareStopFilePath(ID, dir);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(PREPARE_FILES.stopRequested(dir, ID)).toBe(true);
    PREPARE_FILES.removeStop(dir, ID);
    PREPARE_FILES.removeStop(dir, ID);
    expect(PREPARE_FILES.stopRequested(dir, ID)).toBe(false);
  });

  it('records the stopped hash, reads only a valid one, and never through a link', () => {
    const dir = tempDir();
    expect(PREPARE_FILES.readStopped(dir, ID)).toBeUndefined();
    PREPARE_FILES.writeStopped(dir, ID, HASH);
    expect(PREPARE_FILES.readStopped(dir, ID)).toBe(HASH);
    expect(() => PREPARE_FILES.writeStopped(dir, ID, 'not a hash')).toThrow();
    const file = prepareStoppedFilePath(ID, dir);
    fs.writeFileSync(file, 'garbage');
    expect(PREPARE_FILES.readStopped(dir, ID)).toBeUndefined();
    fs.rmSync(file);
    const target = path.join(dir, 'elsewhere');
    fs.writeFileSync(target, `${HASH}\n`);
    fs.symlinkSync(target, file);
    expect(PREPARE_FILES.readStopped(dir, ID)).toBeUndefined();
    expect(() => PREPARE_FILES.writeStopped(dir, ID, HASH)).toThrow();
    expect(fs.readFileSync(target, 'utf8')).toBe(`${HASH}\n`);
  });

  it('names no file outside the lock folder', () => {
    const dir = tempDir();
    expect(() => PREPARE_FILES.requestStop(dir, '../x')).toThrow('The devspace ID of the prepare is invalid.');
    expect(PREPARE_FILES.stopRequested(dir, '../x')).toBe(false);
    expect(PREPARE_FILES.readStopped(dir, '../x')).toBeUndefined();
  });
});
