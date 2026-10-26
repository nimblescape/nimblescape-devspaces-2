// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// isNotRunning, the one rule for "the container of an exec does not exist or does not run", and its callers (a 404 that
// names no container is no evidence).
import { describe, expect, it } from 'vitest';
import { silentLogger, type Logger } from '../ports';
import { REMOTE_MONITOR_CONTAINER } from '../remoteMonitor/protocol';
import { EngineError, isNotRunning, type DockerEngine } from './dockerEngine';
import { unusedEngine } from './dockerEngine.testkit';
import { forgetRecord, sendHeartbeat } from './monitorFlow';
import { workerSessionMonitor } from './workerServices';

const ID = 'feed'.padEnd(64, '1');

describe('isNotRunning', () => {
  it('a missing container (404 "No such container") or one that does not run (409 "is not running"); not one that restarts', () => {
    const cases: [unknown, boolean][] = [
      [new EngineError(`No such container: ${ID}`, 404), true],
      // Podman's compatible API names it in lower case.
      [new EngineError(`no container with name or ID "x" found: no such container`, 404), true],
      [new EngineError(`Container ${ID} is not running`, 409), true],
      [new EngineError(`Container ${ID} is restarting, wait until the container is running`, 409), false],
      [new EngineError(`Container ${ID} is paused, unpause the container before exec`, 409), false],
      [new EngineError(`No such exec instance: ${ID}`, 404), false],
      [new EngineError(`Container ${ID} is not running`, 500), false],
      [new Error(`No such container: ${ID}`), false],
      ['No such container', false],
    ];
    for (const [error, expected] of cases) expect(isNotRunning(error), String(error)).toBe(expected);
  });
});

describe('the callers of the rule', () => {
  const failingExec = (error: Error): DockerEngine => ({ ...unusedEngine(), exec: async () => Promise.reject(error) });

  // A 404 that names no container (the exec instance is gone) is no evidence that the monitor container is missing; the
  // other answers are in monitorFlow.test.ts.
  it('a heartbeat: a 404 "No such exec instance" is a failure, not a missing monitor', async () => {
    const answer = await sendHeartbeat(failingExec(new EngineError(`No such exec instance: ${ID}`, 404)), { source: '0'.repeat(32), limitSeconds: 600, devspaces: [] }, undefined, REMOTE_MONITOR_CONTAINER);
    expect(answer).toEqual({ ok: false, missing: false, detail: `No such exec instance: ${ID}` });
  });

  // Delete's forget treats any 404 as `missing`, so that the race of a monitor container that went away between the
  // create and the start of the exec is not logged as a failed removal; a monitor that does not run has no record that
  // matters (workerSessionMonitor).
  it("Delete's forget: a 404 \"No such exec instance\" is a missing monitor, and is not logged", async () => {
    const vanished = failingExec(new EngineError(`No such exec instance: ${ID}`, 404));
    expect(await forgetRecord(vanished, '0'.repeat(32), 'env', REMOTE_MONITOR_CONTAINER)).toEqual({ ok: false, missing: true, detail: `No such exec instance: ${ID}` });
    const lines: string[] = [];
    const logger = { ...silentLogger, warn: (text: string) => lines.push(text) } as Logger;
    await workerSessionMonitor(vanished, '0'.repeat(32), logger).forget('env');
    expect(lines).toEqual([]);
    // A paused monitor (409, not "is not running") is still a failure that Delete logs.
    await workerSessionMonitor(failingExec(new EngineError(`Container ${ID} is paused, unpause the container before exec`, 409)), '0'.repeat(32), logger).forget('env');
    expect(lines).toEqual([`The heartbeat record of env could not be removed from the Monitor: Container ${ID} is paused, unpause the container before exec`]);
  });
});
