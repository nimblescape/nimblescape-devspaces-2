// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { PassThrough } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNEL_CLEANUP_TIMEOUT_MS, CHANNEL_KILL_GRACE_MS } from '../core/helperChannel/protocol';
import { fatalHandler, readAsText, timesFromEnv } from './main';

describe('the input of the channel script', () => {
  // The worker of the relay: the loader started the stored file and did not set the encoding of the input.
  it('is read as UTF-8 text, also when a character comes in two reads', async () => {
    const input = new PassThrough();
    readAsText(input as unknown as NodeJS.ReadStream);
    let text = '';
    input.on('data', (chunk: string) => (text += chunk));
    const bytes = Buffer.from('{"t":"ping","n":1,"x":"Übung €"}\n', 'utf8');
    const split = bytes.indexOf(0xe2) + 1;
    input.write(bytes.subarray(0, split));
    await new Promise((resolve) => setImmediate(resolve));
    input.write(bytes.subarray(split));
    await new Promise((resolve) => setImmediate(resolve));
    expect(text).toBe('{"t":"ping","n":1,"x":"Übung €"}\n');
  });

  it('keeps the decoder of an input that is UTF-8 already', () => {
    const input = { readableEncoding: 'utf8' as BufferEncoding | null, setEncoding: vi.fn() };
    readAsText(input as unknown as NodeJS.ReadStream);
    expect(input.setEncoding).not.toHaveBeenCalled();
  });
});

describe('the entry of the channel script', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('an uncaught error shuts the channel down (cancel and cleanup), and ends the process later in any case', async () => {
    const exits: number[] = [];
    const shutdown = vi.fn();
    fatalHandler({ shutdown }, (code) => exits.push(code))();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exits).toEqual([]);
    await vi.advanceTimersByTimeAsync(CHANNEL_KILL_GRACE_MS + CHANNEL_CLEANUP_TIMEOUT_MS + 10_000);
    expect(exits).toEqual([1]);
  });

  it('ends the process at once when the shutdown itself fails', () => {
    const exits: number[] = [];
    fatalHandler(
      {
        shutdown: () => {
          throw new Error('broken');
        },
      },
      (code) => exits.push(code),
    )();
    expect(exits).toEqual([1]);
  });

  it('takes the shorter times of the Docker tests only in their range', () => {
    expect(timesFromEnv({ DEVSPACE_CHANNEL_SILENCE_MS: '3000' })).toEqual({ silenceMs: 3000, idleMs: 6000 });
    expect(timesFromEnv({ DEVSPACE_CHANNEL_SILENCE_MS: '100' })).toEqual({});
    expect(timesFromEnv({ DEVSPACE_CHANNEL_SILENCE_MS: '99999' })).toEqual({});
    expect(timesFromEnv({})).toEqual({});
  });
});
