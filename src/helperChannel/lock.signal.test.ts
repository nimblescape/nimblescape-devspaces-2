// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// takeDevspaceLock after the lock was taken: flock is not killed by a later cancel (its abort listener is removed).
// Also a signal aborted before the start.
import { describe, expect, it } from 'vitest';
import { takeDevspaceLock, type LockDeps } from './lock';
import type { FlockProcess } from '../core/helperChannel/lockFile';

function fakeDeps() {
  const events: string[] = [];
  const kills: string[] = [];
  let finish!: (outcome: { exitCode: number | null }) => void;
  const deps: LockDeps = {
    stateDir: '/state',
    openLockFile: () => (events.push('open'), 42),
    closeFile: (fd) => events.push(`close ${fd}`),
    startFlock: (): FlockProcess => {
      events.push('flock');
      return {
        exited: new Promise((resolve) => (finish = resolve)),
        kill: (signal) => {
          kills.push(signal);
          finish({ exitCode: null });
        },
      };
    },
  };
  return { deps, events, kills, exit: (code: number) => finish({ exitCode: code }) };
}

describe('takeDevspaceLock and its signal', () => {
  it('a cancel of the signal after the lock was taken kills nothing and keeps the lock until the release', async () => {
    const { deps, events, kills, exit } = fakeDeps();
    const controller = new AbortController();
    const taking = takeDevspaceLock(deps, 'env', 5, controller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    exit(0);
    const release = await taking;
    controller.abort();
    expect(kills).toEqual([]);
    expect(events).not.toContain('close 42');
    release();
    expect(events.at(-1)).toBe('close 42');
  });

  it('a signal aborted before the start is cancelled without starting flock, and closes the file', async () => {
    const { deps, events } = fakeDeps();
    const controller = new AbortController();
    controller.abort();
    await expect(takeDevspaceLock(deps, 'env', 5, controller.signal)).rejects.toMatchObject({ code: 'cancelled' });
    expect(events).toEqual(['open', 'close 42']);
  });
});
