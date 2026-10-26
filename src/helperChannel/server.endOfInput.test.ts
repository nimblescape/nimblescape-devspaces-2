// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The end of input waits for the results of the cancelled operations before it exits (a shutdown that exits at once,
// without the Promise.all of the runs, fails this test).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeMessage, type ServerMessage } from '../core/helperChannel/protocol';
import { ChannelServer, type OperationHandler } from './server';

function setup(operations: Record<string, OperationHandler>) {
  const messages: ServerMessage[] = [];
  const exits: number[] = [];
  // No `spawnDocker`: the server starts no Docker call.
  const server = new ChannelServer({
    write: (text) => {
      for (const line of text.split('\n').filter((part) => part !== '')) messages.push(JSON.parse(line) as ServerMessage);
      return true;
    },
    operations,
    exit: (code) => exits.push(code),
  });
  server.start();
  return { server, messages, exits };
}

describe('ChannelServer end of input', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('exits only after a handler that ends late gave its result', async () => {
    let finish!: () => void;
    const held = new Promise<void>((resolve) => (finish = resolve));
    const { server, messages, exits } = setup({ hold: async () => (await held, {}) });
    server.input(encodeMessage({ t: 'op', id: 1, op: 'hold', params: null }));
    server.inputEnded();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(exits).toEqual([]);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(exits).toEqual([0]);
    expect(messages.find((message) => message.t === 'result')).toMatchObject({ id: 1, ok: false, error: { code: 'cancelled' } });
  });
});
