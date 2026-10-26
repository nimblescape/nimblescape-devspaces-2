// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// engineMonitor: the time limits, the cancels and the failures of its calls.
import { describe, expect, it, vi } from 'vitest';
import { EngineError, type DockerEngine } from './dockerEngine';
import { unusedEngine } from './dockerEngine.testkit';
import { REMOTE_MONITOR_CHECK_TIMEOUT_MS } from '../remoteMonitor/remoteSessionMonitor';
import { engineMonitor, limited, monitorInspected } from './engineMonitor';

const ID = 'feed'.padEnd(64, '1');
const abortError = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const with_ = (methods: Partial<DockerEngine>) => engineMonitor({ ...unusedEngine(), ...methods });
/** A call that answers after 30 ms, unless its signal aborted by then. */
const slow = <T>(value: T) => async (signal?: AbortSignal): Promise<T> => {
  await delay(30);
  if (signal?.aborted) throw abortError();
  return value;
};
/** A call that rejects with an AbortError once its signal aborts. */
const untilAborted = (signal?: AbortSignal) => new Promise<never>((_resolve, reject) => signal?.addEventListener('abort', () => reject(abortError())));

describe('engineMonitor: time limits, cancels and failures', () => {
  it('limited: a cancel passes as such also when the time limit ran out meanwhile', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(limited(1, controller.signal, async () => (await delay(30), Promise.reject(abortError())))).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('monitorInspected: null labels, a fractional restart count and an ID with more than 64 hex digits are not read', () => {
    expect(monitorInspected({ Config: { Labels: null }, RestartCount: 1.5, Id: `x${ID}` })).toMatchObject({ label: '', restartCount: 0, id: undefined });
  });

  it('each call has the time limit of a Docker call (60 s), not less', async () => {
    expect(await with_({ inspect: (_kind, _name, signal) => slow({ Id: ID })(signal) }).inspect('m')).toMatchObject({ exists: true, id: ID });
    expect(await with_({ systemTime: (signal) => slow('2026-10-04T12:00:00Z')(signal) }).daemonTime()).toBe(Date.parse('2026-10-04T12:00:00Z'));
    await expect(with_({ removeContainer: (_id, signal) => slow(undefined)(signal) }).remove(ID)).resolves.toBeUndefined();
    await expect(with_({ start: (_id, signal) => slow(undefined)(signal) }).start(ID)).resolves.toBeUndefined();
    expect(await with_({ containerIds: (_filters, signal) => slow([ID])(signal) }).idsWithLabel('a=b')).toEqual([ID]);
  });

  it('a cancel passes from the clock, the removal, the start and the list', async () => {
    const cancelled = () => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 10);
      return controller.signal;
    };
    await expect(with_({ systemTime: untilAborted }).daemonTime(cancelled())).rejects.toMatchObject({ name: 'AbortError' });
    await expect(with_({ removeContainer: (_id, signal) => untilAborted(signal) }).remove(ID, cancelled())).rejects.toMatchObject({ name: 'AbortError' });
    await expect(with_({ start: (_id, signal) => untilAborted(signal) }).start(ID, cancelled())).rejects.toMatchObject({ name: 'AbortError' });
    await expect(with_({ containerIds: (_filters, signal) => untilAborted(signal) }).idsWithLabel('a=b', cancelled())).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('an AbortError without a cancel is a failure of the inspect; a failure after a cancel is a reason of the clock', async () => {
    await expect(with_({ inspect: async () => Promise.reject(abortError()) }).inspect('m')).rejects.toThrow('docker container inspect failed: The operation was aborted.');
    const controller = new AbortController();
    controller.abort();
    expect(await with_({ systemTime: async () => Promise.reject(new Error('socket hang up')) }).daemonTime(controller.signal)).toEqual({ reason: 'socket hang up' });
  });

  it('the clock: an odd answer is cut to 64 characters in the reason', async () => {
    const text = 'y'.repeat(100);
    expect(await with_({ systemTime: async () => text }).daemonTime()).toEqual({ reason: `the engine gave the time ${JSON.stringify('y'.repeat(64))}` });
  });

  it('remove: only the engine\'s refusal (any case) is a removal in progress', async () => {
    await expect(with_({ removeContainer: async () => Promise.reject(new Error(`removal of container ${ID} is already in progress`)) }).remove(ID)).rejects.toThrow('docker rm failed');
    await expect(with_({ removeContainer: async () => Promise.reject(new EngineError(`Removal of container ${ID} is already in progress`, 409)) }).remove(ID)).resolves.toBeUndefined();
  });

  it('start: by the ID', async () => {
    const start = vi.fn(async () => {});
    await with_({ start }).start(ID);
    expect(start).toHaveBeenCalledWith(ID, expect.any(AbortSignal));
  });

  it('storedScript: within the time limit of the check (20 s), not less; a cancel passes; a 404 failure alone is no evidence', async () => {
    expect(REMOTE_MONITOR_CHECK_TIMEOUT_MS).toBe(20_000);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      await with_({ containerFile: async () => undefined }).storedScript('m');
      expect(timeout).toHaveBeenCalledWith(REMOTE_MONITOR_CHECK_TIMEOUT_MS);
    } finally {
      timeout.mockRestore();
    }
    const script = Buffer.from('x');
    expect(await with_({ containerFile: (_name, _path, _max, signal) => slow(script)(signal) }).storedScript('m')).toEqual({ hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    await expect(with_({ containerFile: (_name, _path, _max, signal) => untilAborted(signal) }).storedScript('m', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(await with_({ containerFile: async () => Promise.reject(new EngineError('page not found', 404)) }).storedScript('m')).toBe('unknown');
  });
});
