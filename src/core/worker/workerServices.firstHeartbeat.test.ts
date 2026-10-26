// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.
// Mutation probes: the open's Monitor in the worker: the time limit of the first heartbeat is the clamped one
// of the settings (stopAfterSeconds), and without the settings the heartbeat is answered as not sent (it does not
// reject) also when the operation names the computer.
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../ports';
import { scriptCommand } from './containerScripts';
import { unusedEngine } from './dockerEngine.testkit';
import type { DockerEngine } from './dockerEngine';
import type { HostSide } from './hostSide';
import { workerServiceDeps, type WorkerServicesDeps } from './workerServices';

const ID = 'e0123456789a';

function setup() {
  const commands: (readonly string[])[] = [];
  const engine: DockerEngine = {
    ...unusedEngine(),
    exec: async (_container, command) => (commands.push(command), { exitCode: 0, stdout: '', stderr: '', timedOut: false }),
  };
  const deps = (overrides: Partial<WorkerServicesDeps>) =>
    workerServiceDeps({
      host: {} as HostSide,
      engine,
      secretOf: () => undefined,
      forgetSecret: () => undefined,
      logger: silentLogger,
      ownHelper: { image: { tag: 'devspaces-worker:abc', id: `sha256:${'e'.repeat(64)}` }, socket: '/s.sock' },
      dockerHost: '',
      owner: { windowId: 'w', pid: 1 },
      devspaceLock: async () => Promise.reject(new Error('no lock in this test')),
      ...overrides,
    });
  return { commands, deps };
}

/** The ID of the computer of the operation, as computer.id makes it (the worker refuses any other form). */
const COMPUTER = 'c'.repeat(32);

describe('the first heartbeat of the open in the worker', () => {
  it('the time limit is clamped as the protocol allows (one day at most, one minute at least)', async () => {
    const { commands, deps } = setup();
    for (const [minutes, seconds] of [[2000, 86_400], [0.5, 60]] as const) {
      const services = deps({ monitorSource: COMPUTER, settings: { stopAfterMinutes: minutes } as never });
      expect(await services.sessionMonitor!.heartbeat(ID, false, 5)).toEqual({ ok: true });
      // The command of the entry monitorHeartbeat.
      expect(commands.pop()).toEqual(scriptCommand('monitorHeartbeat', [JSON.stringify({ source: COMPUTER, limitSeconds: seconds, devspaces: [{ id: ID, keepRunning: false, seq: 5 }] })]));
    }
  });

  it('with the computer but without the settings: not sent, answered with its cause (no rejection)', async () => {
    const { commands, deps } = setup();
    const services = deps({ monitorSource: COMPUTER });
    expect(await services.sessionMonitor!.heartbeat(ID, true, 1)).toEqual({
      ok: false,
      detail: 'The operation has no settings for the time limit of the heartbeat.',
    });
    expect(commands).toEqual([]);
  });
});
