// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The prepare lock of a devspace as the open of the worker asks it (workerPrepareLock), with a fake flock: a probe
// without a wait, a wait with its limit, never held after it, a lock that cannot be asked counts as free, a cancel is
// an AbortError; and the prepare lock file next to the lock file.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { LOCK_BUSY_EXIT, flockArgs, flockNoWaitArgs, lockFilePath, prepareLockFilePath } from '../core/helperChannel/protocol';
import { FLOCK_FD, openPrepareLockFile, type FlockProcess } from '../core/helperChannel/lockFile';
import { isAbortError } from '../core/ports';
import type { LockDeps } from './lock';
import { contextSecrets } from './operationContext.testkit';
import type { OperationContext } from './server';
import { workerPrepareLock } from './workerLock';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';

function setup(flock: () => Promise<{ exitCode: number | null }>, options: { openFails?: boolean; withoutFile?: boolean } = {}) {
  const events: string[] = [];
  const controller = new AbortController();
  const context = { signal: controller.signal, ...contextSecrets({}), progress: () => {}, log: () => {}, output: () => {} } as unknown as OperationContext;
  const deps: LockDeps = {
    stateDir: '/state',
    openLockFile: () => {
      events.push('open devspace lock');
      return 8;
    },
    ...(options.withoutFile
      ? {}
      : {
          openPrepareLockFile: (stateDir: string, devspaceId: string) => {
            if (options.openFails) throw new Error('ELOOP');
            events.push(`open ${prepareLockFilePath(devspaceId, stateDir)}`);
            return 9;
          },
        }),
    closeFile: () => events.push('close'),
    startFlock: (args): FlockProcess => {
      events.push(`flock ${args.join(' ')}`);
      let killed: (outcome: { exitCode: number | null }) => void = () => {};
      const ended = new Promise<{ exitCode: number | null }>((resolve) => (killed = resolve));
      return {
        exited: Promise.race([flock(), ended]),
        kill: () => {
          events.push('kill');
          killed({ exitCode: null });
        },
      };
    },
  };
  return { lock: workerPrepareLock(deps, context), events, controller };
}

describe('the prepare lock of the open in the worker', () => {
  it('asks without a wait, and lets a lock that it got go at once', async () => {
    const free = setup(async () => ({ exitCode: 0 }));
    expect(await free.lock.held(ID, undefined)).toBe(false);
    expect(free.events).toEqual([`open /state/locks/${ID}.prepare.lock`, `flock ${flockNoWaitArgs(FLOCK_FD).join(' ')}`, 'close']);
    const busy = setup(async () => ({ exitCode: LOCK_BUSY_EXIT }));
    expect(await busy.lock.held(ID, undefined)).toBe(true);
    expect(busy.events.at(-1)).toBe('close');
  });

  it('waits with the given limit: true when it got free, false when it stayed held; never the devspace lock', async () => {
    const free = setup(async () => ({ exitCode: 0 }));
    expect(await free.lock.waitFree(ID, 1800, undefined)).toBe(true);
    expect(free.events).toEqual([`open /state/locks/${ID}.prepare.lock`, `flock ${flockArgs(1800, FLOCK_FD).join(' ')}`, 'close']);
    const held = setup(async () => ({ exitCode: LOCK_BUSY_EXIT }));
    expect(await held.lock.waitFree(ID, 1800, undefined)).toBe(false);
    expect([...free.events, ...held.events].some((event) => event.includes('devspace lock'))).toBe(false);
  });

  it('counts a lock that cannot be asked as free (the open builds as before), and one without its file', async () => {
    expect(await setup(async () => ({ exitCode: 1 })).lock.held(ID, undefined)).toBe(false);
    expect(await setup(async () => ({ exitCode: 0 }), { openFails: true }).lock.held(ID, undefined)).toBe(false);
    const none = setup(async () => ({ exitCode: LOCK_BUSY_EXIT }), { withoutFile: true });
    expect(await none.lock.held(ID, undefined)).toBe(false);
    expect(await none.lock.waitFree(ID, 10, undefined)).toBe(true);
    expect(none.events).toEqual([]);
  });

  it('a cancel of the open or of the operation ends the wait with an AbortError', async () => {
    const waiting = setup(() => new Promise(() => {}));
    const own = new AbortController();
    const wait = waiting.lock.waitFree(ID, 1800, own.signal);
    own.abort();
    expect(isAbortError(await wait.catch((error: unknown) => error))).toBe(true);
    expect(waiting.events).toContain('kill');
    const operation = setup(() => new Promise(() => {}));
    const second = operation.lock.waitFree(ID, 1800, undefined);
    operation.controller.abort();
    expect(isAbortError(await second.catch((error: unknown) => error))).toBe(true);
  });

  it('has its own file next to the lock file, opened as plain file 0600', () => {
    expect(prepareLockFilePath(ID)).toBe(`/state/locks/${ID}.prepare.lock`);
    expect(path.posix.dirname(prepareLockFilePath(ID))).toBe(path.posix.dirname(lockFilePath(ID)));
    expect(prepareLockFilePath(ID)).not.toBe(lockFilePath(ID));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-prepare-lock-'));
    try {
      const fd = openPrepareLockFile(root, ID);
      fs.closeSync(fd);
      expect(fs.statSync(path.join(root, 'locks', `${ID}.prepare.lock`)).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(root, 'locks')).mode & 0o777).toBe(0o700);
      expect(() => openPrepareLockFile(root, '../x')).toThrow('The devspace ID of the lock is invalid.');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
