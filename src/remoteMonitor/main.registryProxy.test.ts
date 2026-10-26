// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Probes of the wiring: `monitor.js run` reads the tags of its image maintenance through the proxy of the daemon of its
// engine by default (MainDeps.registryTransport unset), and daemonProxyTransport reads that proxy within
// BACKGROUND_ENGINE_TIMEOUT_MS. The volume is a temporary folder; the registry is 127.0.0.1:1 (refused at once);
// nothing needs root.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineContainerSummary } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import { BACKGROUND_ENGINE_TIMEOUT_MS } from './background';
import { daemonProxyTransport, main, writeImagesInUse } from './main';

const T0 = Date.parse('2026-10-10T10:00:00Z');
let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-remote-monitor-pc5r1-'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('the registry requests of monitor.js run', () => {
  // A tag in use that the engine has; its registry is asked through the proxy.
  it('go through the proxy of the daemon of the engine by default', async () => {
    await writeImagesInUse(stateDir, '0123456789abcdef0123456789abcdef', ['127.0.0.1:1/team/app:1'], T0);
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    let proxyReads = 0;
    let mono = 0;
    let out = '';
    void main(['run'], {
      env: { DEVSPACE_MONITOR_PERMANENT: '1', DEVSPACE_IMAGE_FIRST_MS: '1000' },
      stateDir,
      engine: {
        ...unusedEngine(),
        containerSummaries: async (): Promise<EngineContainerSummary[]> => [],
        images: async () => [],
        inspect: async (_kind: string, reference: string) => (reference === '127.0.0.1:1/team/app:1' ? { Id: `sha256:${'1'.repeat(64)}`, RepoTags: [reference], RepoDigests: [] } : undefined),
        proxy: async () => (proxyReads++, {}),
      },
      vscodeBackground: () => undefined,
      lockDevspace: async () => ({ kind: 'locked', release: () => {} }),
      exec: (_file, _args, _options, callback) => callback(null, 'removed\n', ''),
      monotonic: () => mono,
      now: () => T0 + mono,
      sleep: async (ms) => {
        mono += ms;
        await new Promise(() => {});
      },
      out: (text) => (out += text),
    });
    await vi.waitFor(() => expect(out).toContain('first check in 1 s'));
    await vi.advanceTimersByTimeAsync(1_000);
    // The registry refuses the connection, so the run did not reach the network and waits for its retry.
    await vi.waitFor(() => expect(out).toContain('The background run ended without reaching the network.'), { timeout: 4_000 });
    expect(out).toContain('127.0.0.1:1/team/app:1 is not pulled in this pass: its registry does not confirm the tag (');
    expect(proxyReads).toBe(1);
  });
});

describe('daemonProxyTransport', () => {
  it('reads the proxy of the daemon within BACKGROUND_ENGINE_TIMEOUT_MS', async () => {
    const original = AbortSignal.timeout.bind(AbortSignal);
    const limits: AbortSignal[] = [];
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      const signal = original(ms);
      if (ms === BACKGROUND_ENGINE_TIMEOUT_MS) limits.push(signal);
      return signal;
    });
    const given: (AbortSignal | undefined)[] = [];
    const transport = daemonProxyTransport({ proxy: async (signal) => (given.push(signal), {}) });
    await transport.request({ method: 'GET', url: 'https://127.0.0.1:1/v2/', headers: {} }).catch(() => undefined);
    expect(given).toHaveLength(1);
    expect(limits).toContain(given[0]);
  });
});
