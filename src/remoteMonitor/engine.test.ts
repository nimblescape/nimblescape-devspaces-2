// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.
// Mutation probes of src/remoteMonitor/engine.ts: the socket of the engine of the Monitor container and the
// reason of a failed call in the log. The comment of each test names the mutants that fail it.
import { describe, expect, it, vi } from 'vitest';
import { HELPER_DOCKER_SOCKET } from '../core/names';
import { abortError } from '../core/ports';
import { EngineError } from '../core/worker/dockerEngine';

const sockets = vi.hoisted(() => ({ api: [] as unknown[][], hijack: [] as unknown[][] }));

vi.mock('../helperChannel/engineApi', async (original) => {
  const actual = await original<typeof import('../helperChannel/engineApi')>();
  return {
    ...actual,
    engineApi: (...args: Parameters<typeof actual.engineApi>) => (sockets.api.push(args), actual.engineApi(...args)),
    engineHijack: (...args: Parameters<typeof actual.engineHijack>) => (sockets.hijack.push(args), actual.engineHijack(...args)),
  };
});

describe('the engine of the Monitor', () => {
  // Fails on the API on another socket and on the hijacked connection of an exec on another socket: the monitor talks
  // to the engine of its container at /var/run/docker.sock only. An argument left out takes the default socket of the
  // port, which is the same one (so `engineApi()` without the argument is equivalent and passes here).
  it('builds the port over the socket of its container, for the requests and the hijacked connections', async () => {
    const { socketEngine } = await import('./engine');
    const engine = socketEngine();
    // The list of the loop is the list-only containerSummaries (MonitorEngineParts has no `containers`, so
    // `engine.containers` fails tsc), so the check that the port is built names that method.
    expect(typeof engine.containerSummaries).toBe('function');
    expect(sockets.api).toHaveLength(1);
    expect(sockets.hijack).toHaveLength(1);
    expect(sockets.api[0][0] ?? HELPER_DOCKER_SOCKET).toBe('/var/run/docker.sock');
    expect(sockets.hijack[0][0] ?? HELPER_DOCKER_SOCKET).toBe('/var/run/docker.sock');
  });

  // Fails on no fallback for an empty message and on a message that is not trimmed: the log line always names a reason,
  // without the blank lines that an engine or a connection may end its message with.
  it('names a reason for every failure: the trimmed message, "Docker gave no reason." for none, the time limit for an abort', async () => {
    const { engineFailure } = await import('./engine');
    expect(engineFailure(new Error(''), 30_000)).toBe('Docker gave no reason.');
    expect(engineFailure(new EngineError(' \n', 500), 30_000)).toBe('Docker gave no reason.');
    expect(engineFailure(new EngineError('conflict: cannot stop\n', 409), 60_000)).toBe('conflict: cannot stop');
    expect(engineFailure('  connect ECONNREFUSED /var/run/docker.sock  ', 30_000)).toBe('connect ECONNREFUSED /var/run/docker.sock');
    expect(engineFailure(abortError(), 120_000)).toBe('Docker did not answer within 120 seconds.');
  });
});
