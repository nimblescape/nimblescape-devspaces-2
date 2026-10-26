// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Mutation probes: findWindowDevspace waits WINDOW_RESTORE_TIMEOUT_MS, and reads the registry again only when the
// worker restored entries.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../core/ports';
import type { Devspace } from '../core/types';
import { WINDOW_RESTORE_TIMEOUT_MS, findWindowDevspace, restoreAfterPrebuild } from './windowDevspace';

const ENTRY = { id: 'e1', containerName: 'devspaces-acme-api-x' } as Devspace;

function deps(found: Array<Devspace | undefined>, added: number) {
  return {
    registry: { findByContainerName: vi.fn(async () => found.shift()) },
    needsRestore: async () => true,
    docker: { isInstalled: () => true },
    service: { reconcileInWorker: vi.fn(async (_options: { passive: boolean; signal?: AbortSignal }) => added) },
    logger: silentLogger,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('findWindowDevspace (mutation probes)', () => {
  it('the signal of the restore times out after WINDOW_RESTORE_TIMEOUT_MS', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const all = deps([undefined, ENTRY], 1);
    expect(await findWindowDevspace('devspaces-acme-api-x', all)).toBe(ENTRY);
    expect(timeout).toHaveBeenCalledWith(WINDOW_RESTORE_TIMEOUT_MS);
    expect(all.service.reconcileInWorker.mock.calls[0][0].signal).toBe(timeout.mock.results[0].value);
  });

  // Nothing added here: the registry is read again all the same (another window may have restored it first).
  it('nothing restored: the registry is read again and its entry found', async () => {
    const all = deps([undefined, ENTRY], 0);
    expect(await findWindowDevspace('devspaces-acme-api-x', all)).toBe(ENTRY);
    expect(all.registry.findByContainerName).toHaveBeenCalledTimes(2);
  });

  it('restoreAfterPrebuild waits for the restore, and fails with it', async () => {
    await expect(restoreAfterPrebuild('built', async () => Promise.reject(new Error('no Docker')))).rejects.toThrow('no Docker');
    let done = false;
    await restoreAfterPrebuild('built', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      done = true;
    });
    expect(done).toBe(true);
  });
});
