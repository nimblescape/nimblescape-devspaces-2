// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { Duplex } from 'stream';
import { afterEach, describe, expect, it } from 'vitest';
import { bridgeStream } from './bridge';
import { MemoryPipe, settle } from './memoryPipe.testkit';
import { Mux, type MuxStream } from './mux';

const muxes: Mux[] = [];

afterEach(() => {
  for (const mux of muxes.splice(0)) mux.close('the test ended');
});

/** The extension and the relay in memory; each stream of the relay is connected with `socket()`. */
async function connected(socket: () => Duplex) {
  const up = new MemoryPipe();
  const down = new MemoryPipe();
  const relay = new Mux({ side: 'relay', link: down.link, accept: (stream) => bridgeStream(stream, socket(), socket()) });
  const extension = new Mux({ side: 'extension', link: up.link });
  up.target = relay;
  down.target = extension;
  muxes.push(relay, extension);
  await settle();
  return { extension, down };
}

function watch(stream: MuxStream): string[] {
  const events: string[] = [];
  stream.onData((chunk) => {
    events.push(chunk.toString());
    stream.consumed(chunk.length);
  });
  stream.onEnd(() => events.push('end'));
  stream.onClose((reason) => events.push(`close ${reason}`));
  return events;
}

describe('a stream connected with a socket', () => {
  it('keeps the answer and its end when writing fails after the end of the answer', async () => {
    // A socket whose peer answered, ended, and closed: each write fails with EPIPE.
    const socket = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      },
    });
    const { extension, down } = await connected(() => socket);
    const stream = extension.open('docker');
    const events = watch(stream);
    await settle();
    // The link of the relay holds its frames: the answer and its end wait in the stream.
    down.highWater = 1;
    down.held = true;
    socket.push('first ');
    await settle();
    socket.push('answer');
    socket.push(null);
    await settle();
    stream.write(Buffer.from('more of the upload'));
    await settle();
    expect(socket.destroyed).toBe(true);
    down.release();
    await settle();
    expect(events).toEqual(['first ', 'answer', 'end']);
    // What the extension sends is dropped and counts as taken; its end finishes the stream.
    stream.write(Buffer.from('the rest'));
    stream.end();
    await settle();
    expect(stream.isOpen).toBe(false);
  });

  it('closes the stream with the error when the socket fails before its end', async () => {
    const socket = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        callback(new Error('read ECONNRESET'));
      },
    });
    const { extension } = await connected(() => socket);
    const stream = extension.open('docker');
    const events = watch(stream);
    await settle();
    socket.push('part of an answer');
    stream.write(Buffer.from('x'));
    await settle();
    expect(events).toEqual(['part of an answer', 'close read ECONNRESET']);
  });
});
