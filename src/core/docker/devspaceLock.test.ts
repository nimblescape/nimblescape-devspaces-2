// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The scope of a held devspace lock.
import { describe, expect, it } from 'vitest';
import { holdsDevspaceLock, runWithDevspaceLock, type HeldDevspaceLock } from './devspaceLock';

/** A held lock that is never lost. */
function fakeLock(devspaceId = 'env-1') {
  const lock: HeldDevspaceLock = { devspaceId, lost: new Promise<string>(() => {}), release: async () => {} };
  return { lock };
}

describe('the scope of a held devspace lock', () => {
  it('knows the devspaces whose lock it holds, also nested, and ends with the scope', async () => {
    const outer = fakeLock('env-1');
    const inner = fakeLock('env-2');
    expect(holdsDevspaceLock('env-1')).toBe(false);
    await runWithDevspaceLock(outer.lock, async () => {
      expect(holdsDevspaceLock('env-1')).toBe(true);
      expect(holdsDevspaceLock('env-2')).toBe(false);
      await runWithDevspaceLock(inner.lock, async () => {
        expect(holdsDevspaceLock('env-1')).toBe(true);
        expect(holdsDevspaceLock('env-2')).toBe(true);
      });
      expect(holdsDevspaceLock('env-2')).toBe(false);
    });
    expect(holdsDevspaceLock('env-1')).toBe(false);
  });

  // A timer does not see the lock of the ended scope.
  it('a timer that the scope left behind does not run in it after it ended', async () => {
    const { lock } = fakeLock();
    let later!: Promise<boolean>;
    await runWithDevspaceLock(lock, async () => {
      expect(holdsDevspaceLock('env-1')).toBe(true);
      later = new Promise((resolve) => setTimeout(() => resolve(holdsDevspaceLock('env-1')), 5));
    });
    expect(await later).toBe(false);
  });

  it('returns the result of its function and ends the scope also when it throws', async () => {
    const { lock } = fakeLock();
    expect(await runWithDevspaceLock(lock, async () => 42)).toBe(42);
    await expect(
      runWithDevspaceLock(lock, async () => {
        throw new Error('failed');
      }),
    ).rejects.toThrow('failed');
    expect(holdsDevspaceLock('env-1')).toBe(false);
  });
});
