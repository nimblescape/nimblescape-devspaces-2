// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Mutation probes: the image settings and list of an open reach the Monitor of the worker's services
// (workerServiceDeps passes monitorImages on; without it there are none).
import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../ports';
import { unusedEngine } from './dockerEngine.testkit';
import type { HostSide } from './hostSide';
import { workerServiceDeps, type WorkerServicesDeps } from './workerServices';


const deps = (overrides: Partial<WorkerServicesDeps>) =>
  workerServiceDeps({
    host: {} as HostSide,
    engine: unusedEngine(),
    secretOf: () => undefined,
    forgetSecret: () => undefined,
    logger: silentLogger,
    ownHelper: { image: { tag: 'devspaces-worker:abc', id: `sha256:${'e'.repeat(64)}` }, socket: '/s.sock' },
    dockerHost: '',
    owner: { windowId: 'w', pid: 1 },
    devspaceLock: async () => Promise.reject(new Error('no lock in this test')),
    ...overrides,
  });

describe("the images of an open in the worker's services", () => {
  it('the monitorImages of the operation are the Monitor\'s images, with the signal of the pipeline', async () => {
    const monitorImages = vi.fn(async (_signal: AbortSignal | undefined) => {});
    const signal = new AbortController().signal;
    await deps({ monitorImages }).sessionMonitor!.images(signal);
    expect(monitorImages).toHaveBeenCalledWith(signal);
    // `images` is required by the port; without monitorImages it sends nothing and resolves. The engine of these deps
    // (unusedEngine) throws on any call.
    await expect(deps({}).sessionMonitor!.images(signal)).resolves.toBeUndefined();
  });
});
