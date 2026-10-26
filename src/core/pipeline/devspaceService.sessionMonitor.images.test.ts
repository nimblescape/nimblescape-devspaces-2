// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The open gives `images` of the Monitor the signal of its run (the one its ensure gets), so a cancel of the
// open also ends the sending of the image list.
import { afterEach, describe, expect, it } from 'vitest';
import type { DevspaceSessionMonitor } from './devspacePorts';
import { ENV_ID, createHarness, seedDevspace, type Harness } from './devspaceService.testkit';

let h: Harness | undefined;

afterEach(() => {
  h?.cleanup();
  h = undefined;
});

describe('the Monitor in the open pipeline: images', () => {
  it('gets the signal of the run, as the ensure does', async () => {
    const ensureSignals: (AbortSignal | undefined)[] = [];
    const imageSignals: (AbortSignal | undefined)[] = [];
    const sessionMonitor: DevspaceSessionMonitor = {
      ensure: async (signal) => void ensureSignals.push(signal),
      heartbeat: async () => ({ ok: true }),
      forget: async () => undefined,
      images: async (signal) => void imageSignals.push(signal),
    };
    const created = createHarness({ dockerTarget: async () => ({ kind: 'remote', host: 'build-box', endpoint: 'ssh://build-box' }), sessionMonitor });
    h = created;
    await seedDevspace(created, { container: 'stopped', extra: { dockerHost: 'build-box' } });
    await created.service.openDevspace(ENV_ID, { progress: created.progress, signal: new AbortController().signal });
    expect(imageSignals).toHaveLength(1);
    expect(imageSignals[0]).toBeDefined();
    expect(imageSignals[0]).toBe(ensureSignals[0]);
  });
});
