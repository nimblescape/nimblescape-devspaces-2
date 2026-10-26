// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Mutation testing: probes for the end of the scope of a held devspace lock.
import { describe, expect, it } from 'vitest';
import { holdsDevspaceLock, runWithDevspaceLock, type HeldDevspaceLock } from './devspaceLock';

function fakeLock(devspaceId: string): HeldDevspaceLock {
  return { devspaceId, lost: new Promise<string>(() => {}), release: async () => {} };
}

const later = <T>(fn: () => T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(fn()), 5));

describe('the end of the scope of a held devspace lock', () => {
  it('a timer left behind by a function that threw does not see the lock', async () => {
    let seen!: Promise<boolean>;
    await expect(
      runWithDevspaceLock(fakeLock('env-1'), async () => {
        seen = later(() => holdsDevspaceLock('env-1'));
        throw new Error('failed');
      }),
    ).rejects.toThrow('failed');
    expect(await seen).toBe(false);
  });

  it('a lock taken from a timer of an ended scope does not inherit the devspaces of that scope', async () => {
    let inner!: Promise<[boolean, boolean]>;
    await runWithDevspaceLock(fakeLock('env-1'), async () => {
      inner = new Promise((resolve) =>
        setTimeout(() => {
          void runWithDevspaceLock(fakeLock('env-2'), async () => [holdsDevspaceLock('env-1'), holdsDevspaceLock('env-2')] as [boolean, boolean]).then(resolve);
        }, 5),
      );
    });
    expect(await inner).toEqual([false, true]);
  });
});
