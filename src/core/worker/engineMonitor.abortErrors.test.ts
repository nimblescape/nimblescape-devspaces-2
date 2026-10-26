// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// engineMonitor as remoteSessionMonitor.test.ts runs it. Its fixtures cancel the ensure's signal before a call rejects
// with an AbortError, so an AbortError without that cancel (a failure of the call) is checked here for each call.
import { describe, expect, it } from 'vitest';
import type { DockerEngine } from './dockerEngine';
import { unusedEngine } from './dockerEngine.testkit';
import { engineMonitor } from './engineMonitor';

const ID = 'feed'.padEnd(64, '1');
const abortError = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
const aborted = async (): Promise<never> => Promise.reject(abortError());
const with_ = (methods: Partial<DockerEngine>) => engineMonitor({ ...unusedEngine(), ...methods });

describe('engineMonitor: an AbortError without a cancel', () => {
  it('an AbortError without a cancel of the ensure is a failure of the clock, the removal, the start, the check and the list', async () => {
    const live = new AbortController().signal;
    for (const signal of [undefined, live]) {
      expect(await with_({ systemTime: aborted }).daemonTime(signal)).toEqual({ reason: 'The operation was aborted.' });
      await expect(with_({ removeContainer: aborted }).remove(ID, signal)).rejects.toThrow('docker rm failed: The operation was aborted.');
      await expect(with_({ start: aborted }).start(ID, signal)).rejects.toThrow('docker start failed: The operation was aborted.');
      expect(await with_({ containerFile: aborted }).storedScript('devspaces-monitor', signal)).toBe('unknown');
      expect(await with_({ containerIds: aborted }).idsWithLabel('a=b', signal)).toBeUndefined();
    }
  });

});
