// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Delete's forget has its own rule of `missing` (any 404, or a 409 "is not running"); a monitor container that restarts
// is not one that does not run, so a failed forget there is logged. Only forget has that rule: the image settings and
// the image list answer a 404 "No such exec instance" as a failure, not as a missing monitor.
import { describe, expect, it } from 'vitest';
import { silentLogger, type Logger } from '../ports';
import { EngineError, type DockerEngine } from './dockerEngine';
import { unusedEngine } from './dockerEngine.testkit';
import { forgetRecord, sendMonitorSettings } from './monitorFlow';
import { workerSessionMonitor } from './workerServices';

const ID = 'feed'.padEnd(64, '1');
const SOURCE = '0'.repeat(32);

function failingExec(error: unknown): DockerEngine {
  return { ...unusedEngine(), exec: async () => Promise.reject(error) };
}

describe('the rule of `missing` per command of the Monitor', () => {
  it("Delete's forget: a 409 \"is restarting\" is a failed removal that Delete logs, not a missing monitor", async () => {
    const error = new EngineError(`Container ${ID} is restarting, wait until the container is running`, 409);
    expect(await forgetRecord(failingExec(error), SOURCE, 'env')).toEqual({ ok: false, missing: false, detail: error.message });
    const lines: string[] = [];
    const logger = { ...silentLogger, warn: (text: string) => lines.push(text) } as Logger;
    await workerSessionMonitor(failingExec(error), SOURCE, logger).forget('env');
    expect(lines).toEqual([`The heartbeat record of env could not be removed from the Monitor: ${error.message}`]);
  });

  it('the image settings and the image list keep the one rule: a 404 "No such exec instance" is a failure, not a missing monitor', async () => {
    const error = new EngineError(`No such exec instance: ${ID}`, 404);
    const failed = { ok: false, missing: false, detail: error.message };
    expect(await sendMonitorSettings(failingExec(error), { settings: { schedule: '0 3 * * *', timeZone: 'UTC' } })).toEqual(failed);
    // The input: the references in use.
    expect(await sendMonitorSettings(failingExec(error), { inUse: { source: SOURCE, references: ['node:20'] } })).toEqual(failed);
  });
});
