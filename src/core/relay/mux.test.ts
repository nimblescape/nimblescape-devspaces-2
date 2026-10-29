// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as crypto from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_FRAME_PAYLOAD, MAX_STREAMS, STREAM_WINDOW, encodeCredit, encodeFrame, encodeHello, encodeTarget } from './frames';
import { MemoryPipe as Pipe, settle } from './memoryPipe.testkit';
import { Mux, type MuxOptions, type MuxStream } from './mux';

interface Pair {
  extension: Mux;
  relay: Mux;
  /** The extension → the relay. */
  up: Pipe;
  /** The relay → the extension. */
  down: Pipe;
  closes: { side: string; reason: string; failed: boolean }[];
}

const muxes: Mux[] = [];

afterEach(() => {
  for (const mux of muxes.splice(0)) mux.close('the test ended');
  vi.useRealTimers();
});

function pair(accept: (stream: MuxStream) => void, options: Partial<MuxOptions> = {}): Pair {
  const up = new Pipe();
  const down = new Pipe();
  const closes: Pair['closes'] = [];
  const relay = new Mux({ side: 'relay', link: down.link, accept, onClose: (reason, failed) => closes.push({ side: 'relay', reason, failed }), ...options });
  const extension = new Mux({ side: 'extension', link: up.link, onClose: (reason, failed) => closes.push({ side: 'extension', reason, failed }), ...options });
  up.target = relay;
  down.target = extension;
  muxes.push(relay, extension);
  return { extension, relay, up, down, closes };
}

/** A mux of the relay whose input comes from the test as frames. */
function relayOnly(accept: (stream: MuxStream) => void = () => {}) {
  const down = new Pipe();
  const closes: { reason: string; failed: boolean }[] = [];
  const relay = new Mux({ side: 'relay', link: down.link, accept, onClose: (reason, failed) => closes.push({ reason, failed }) });
  muxes.push(relay);
  return { relay, down, closes };
}

/** Echoes each stream: its data back as it comes (taken once written), its end as the end. */
function echo(stream: MuxStream): void {
  stream.onData((chunk) => {
    stream.write(chunk);
    stream.consumed(chunk.length);
  });
  stream.onEnd(() => stream.end());
}

/** Collects the data of a stream, taking it at once. */
function collect(stream: MuxStream): { data: () => Buffer; ended: () => boolean } {
  const chunks: Buffer[] = [];
  let ended = false;
  stream.onData((chunk) => {
    chunks.push(chunk);
    stream.consumed(chunk.length);
  });
  stream.onEnd(() => (ended = true));
  return { data: () => Buffer.concat(chunks), ended: () => ended };
}

describe('the streams of a connection of the relay', () => {
  it('send nothing of the extension before the HELLO of the relay', async () => {
    const up = new Pipe();
    const extension = new Mux({ side: 'extension', link: up.link });
    muxes.push(extension);
    extension.open('docker').write(Buffer.from('x'));
    await settle();
    expect(up.frames).toEqual([]);
    extension.input(encodeFrame('hello', 0, encodeHello()));
    expect(up.frames.map((frame) => [frame.kind, frame.stream])).toEqual([
      ['open', 1],
      ['data', 1],
    ]);
  });

  it('end at a first frame that is no HELLO, or the HELLO of another version', () => {
    for (const [first, reason] of [
      [encodeFrame('ping', 0), 'the relay did not start with its hello'],
      [encodeFrame('hello', 0, Buffer.from('{"relay":2}')), 'the relay speaks version 2, not 1'],
    ] as const) {
      const up = new Pipe();
      const closes: string[] = [];
      const extension = new Mux({ side: 'extension', link: up.link, onClose: (text, failed) => closes.push(`${text} ${failed}`) });
      muxes.push(extension);
      const lost: string[] = [];
      extension.open('worker').onClose((text) => lost.push(text));
      extension.input(first);
      expect(closes).toEqual([`${reason} true`]);
      expect(lost).toEqual([reason]);
      expect(up.ended).toBe(true);
      expect(extension.isOpen).toBe(false);
    }
  });

  it('carry every byte of a stream in both directions, in order, and end in both directions', async () => {
    const { extension, relay, up } = pair(echo);
    const sent = crypto.randomBytes(1024 * 1024 + 17);
    const stream = extension.open('docker');
    const received = collect(stream);
    for (let at = 0; at < sent.length; at += 50_000) {
      if (!stream.write(sent.subarray(at, at + 50_000))) await new Promise<void>((resolve) => stream.onDrain(resolve));
    }
    stream.end();
    await settle(200);
    expect(received.ended()).toBe(true);
    expect(received.data().equals(sent)).toBe(true);
    expect([extension.streamCount, relay.streamCount]).toEqual([0, 0]);
    expect(stream.isOpen).toBe(false);
    // Each frame at most MAX_FRAME_PAYLOAD bytes; the receiver gave credit back.
    expect(Math.max(...up.frames.map((frame) => frame.payload.length))).toBe(MAX_FRAME_PAYLOAD);
    expect(up.frames.filter((frame) => frame.kind === 'credit').length).toBeGreaterThan(0);
  });

  it('hold the sender at the window until the receiver took the bytes, then go on', async () => {
    const accepted: MuxStream[] = [];
    const chunks: Buffer[] = [];
    const { extension } = pair((stream) => {
      accepted.push(stream);
      stream.onData((chunk) => chunks.push(chunk));
    });
    const stream = extension.open('docker');
    // Before the HELLO of the relay, all of it waits.
    const writes = [1, 2, 3].map((value) => stream.write(Buffer.alloc(200 * 1024, value)));
    expect(writes).toEqual([true, false, false]);
    let drained = false;
    stream.onDrain(() => (drained = true));
    await settle();
    const held = () => chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    expect(held()).toBe(STREAM_WINDOW);
    // 344 KiB wait.
    expect(drained).toBe(false);
    accepted[0].consumed(held());
    await settle();
    expect(held()).toBe(2 * STREAM_WINDOW);
    // 88 KiB wait.
    expect(drained).toBe(true);
    accepted[0].consumed(held() - STREAM_WINDOW);
    await settle();
    expect(held()).toBe(600 * 1024);
    expect(Buffer.concat(chunks).equals(Buffer.concat([1, 2, 3].map((value) => Buffer.alloc(200 * 1024, value))))).toBe(true);
  });

  it('send the frames of the worker before those of other streams, and the other streams in turn', async () => {
    const { extension, up } = pair((stream) => stream.onData((chunk) => stream.consumed(chunk.length)));
    await settle();
    // Every write of the link waits for its drain, so one frame goes at a time.
    up.highWater = 1;
    const first = extension.open('docker');
    const second = extension.open('docker');
    const worker = extension.open('worker');
    first.write(Buffer.alloc(3 * MAX_FRAME_PAYLOAD));
    second.write(Buffer.alloc(3 * MAX_FRAME_PAYLOAD));
    worker.write(Buffer.from('{"t":"ping"}\n'));
    await settle(100);
    const order = up.frames.filter((frame) => frame.kind === 'data').map((frame) => frame.stream);
    expect(order).toEqual([worker.id, first.id, second.id, first.id, second.id, first.id, second.id]);
  });

  it('close a stream at once with a reason, drop what waits, and ignore its frames that still come', async () => {
    const { extension, closes } = pair((stream) => {
      stream.onData(() => stream.close('connect ENOENT /var/run/docker.sock'));
    });
    const stream = extension.open('docker');
    const reasons: string[] = [];
    stream.onClose((reason) => reasons.push(reason));
    stream.write(Buffer.from('a'));
    await settle();
    expect(reasons).toEqual(['connect ENOENT /var/run/docker.sock']);
    expect(stream.write(Buffer.from('b'))).toBe(false);
    // The extension closes a stream the relay closed already: its CLOSE comes after the relay's.
    const late = extension.open('docker');
    late.write(Buffer.from('c'));
    late.close('the window closed');
    await settle();
    expect(closes).toEqual([]);
    expect(extension.streamCount).toBe(0);
  });

  it('end a worker stream with the exit of its worker after its last output', async () => {
    const { extension, relay } = pair((stream) => {
      stream.write(Buffer.from('{"t":"hello"}\n'));
      stream.exit({ code: 3, signal: null });
    });
    const stream = extension.open('worker');
    const events: string[] = [];
    stream.onData((chunk) => events.push(chunk.toString()));
    stream.onExit((exit) => events.push(JSON.stringify(exit)));
    await settle();
    expect(events).toEqual(['{"t":"hello"}\n', '{"code":3,"signal":null}']);
    expect([extension.streamCount, relay.streamCount]).toEqual([0, 0]);
    expect(() => extension.open('docker').exit({ code: 0, signal: null })).toThrow();
  });

  it('keep the data, the end and the exit that came before their listeners', async () => {
    const { extension } = pair((stream) => {
      stream.write(Buffer.from('out'));
      stream.exit({ code: 0, signal: null });
    });
    const stream = extension.open('worker');
    await settle();
    const events: string[] = [];
    stream.onExit((exit) => events.push(`exit ${exit.code}`));
    stream.onData((chunk) => events.push(chunk.toString()));
    expect(events).toEqual(['out', 'exit 0']);
  });

  it('lose every stream when the input ends; within a frame, as a failure', async () => {
    const { extension, up, down, closes } = pair(() => {});
    const stream = extension.open('docker');
    const reasons: string[] = [];
    stream.onClose((reason) => reasons.push(reason));
    await settle();
    // The relay goes away.
    down.link.end();
    await settle();
    expect(reasons).toEqual(['the connection ended']);
    expect(closes).toContainEqual({ side: 'extension', reason: 'the connection ended', failed: false });
    expect(up.ended).toBe(true);
    const cut = new Mux({ side: 'extension', link: new Pipe().link, onClose: (reason, failed) => closes.push({ side: 'cut', reason, failed }) });
    muxes.push(cut);
    cut.input(encodeFrame('hello', 0, encodeHello()));
    cut.input(encodeFrame('ping', 0).subarray(0, 4));
    cut.inputEnded();
    expect(closes).toContainEqual({ side: 'cut', reason: 'the connection ended within a frame', failed: true });
    // The relay never started (the loader refused the bundle): no HELLO came.
    const early = new Mux({ side: 'extension', link: new Pipe().link, onClose: (reason, failed) => closes.push({ side: 'early', reason, failed }) });
    muxes.push(early);
    early.inputEnded();
    expect(closes).toContainEqual({ side: 'early', reason: 'the connection ended before the hello of the relay', failed: true });
  });

  it('refuse a stream beyond MAX_STREAMS at once and keep the others', async () => {
    const { extension, relay } = pair(() => {});
    const streams = Array.from({ length: MAX_STREAMS + 1 }, () => extension.open('docker'));
    const reasons: string[] = [];
    streams.at(-1)?.onClose((reason) => reasons.push(reason));
    await settle();
    expect(reasons).toEqual([`the relay has ${MAX_STREAMS} streams open`]);
    expect(relay.streamCount).toBe(MAX_STREAMS);
    expect(extension.streamCount).toBe(MAX_STREAMS);
  });
});

describe('a connection of the relay that breaks the rules', () => {
  const open = (stream: number, target: 'worker' | 'docker' = 'docker') => encodeFrame('open', stream, encodeTarget(target));

  it.each([
    ['a frame of a stream that was never opened', [encodeFrame('data', 5, Buffer.from('x'))], 'the other side sent a frame data on the stream 5, which was never opened'],
    ['an open of a lower number', [open(2), open(1)], 'the other side sent an invalid open of the stream 1'],
    ['an open of the stream 0', [open(0)], 'the other side sent an invalid open of the stream 0'],
    ['an open of an unknown target', [encodeFrame('open', 1, Buffer.from([9]))], 'the other side sent an invalid open of the stream 1'],
    ['a hello of the extension', [encodeFrame('hello', 0, encodeHello())], 'the other side sent a second hello'],
    ['an exit of the extension', [open(1, 'worker'), encodeFrame('exit', 1, Buffer.from('{"code":0,"signal":null}'))], 'the other side sent an invalid exit on the stream 1'],
    ['more credit than the window', [open(1), encodeFrame('credit', 1, encodeCredit(1))], 'the other side sent an invalid credit on the stream 1'],
    ['data after the end', [open(1), encodeFrame('end', 1), encodeFrame('data', 1, Buffer.from('x'))], 'the other side sent data on the stream 1 after its end'],
    ['a ping with a payload', [encodeFrame('ping', 0, Buffer.from('x'))], 'the other side sent an invalid ping'],
    ['a frame of an unknown kind', [Buffer.from([42, 0, 0, 0, 0, 0, 0, 0, 0])], 'the other side sent a frame of the unknown kind 42'],
  ])('ends at %s', (_name, frames, reason) => {
    const { relay, down, closes } = relayOnly((stream) => stream.onData(() => {}));
    for (const frame of frames) relay.input(frame);
    expect(closes).toEqual([{ reason, failed: true }]);
    expect(down.ended).toBe(true);
  });

  it('ends at data beyond the credit of the stream', () => {
    const { relay, closes } = relayOnly((stream) => stream.onData(() => {}));
    relay.input(open(1));
    for (let sent = 0; sent <= STREAM_WINDOW; sent += MAX_FRAME_PAYLOAD) relay.input(encodeFrame('data', 1, Buffer.alloc(MAX_FRAME_PAYLOAD)));
    expect(closes).toEqual([{ reason: 'the other side sent more data on the stream 1 than its credit', failed: true }]);
  });
});

describe('the pings of a connection of the relay', () => {
  it('wait while the link holds frames', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const down = new Pipe();
    down.highWater = 1;
    down.held = true;
    const relay = new Mux({ side: 'relay', link: down.link, pingIntervalMs: 1_000, silenceMs: 100_000 });
    muxes.push(relay);
    vi.advanceTimersByTime(10_000);
    expect(down.frames.map((frame) => frame.kind)).toEqual(['hello']);
    down.release();
    await settle();
    vi.advanceTimersByTime(1_400);
    expect(down.frames.map((frame) => frame.kind)).toEqual(['hello', 'ping']);
  });

  it('do not limit the wait of the extension for the HELLO (its caller does)', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const up = new Pipe();
    const closes: string[] = [];
    const extension = new Mux({ side: 'extension', link: up.link, onClose: (reason) => closes.push(reason), pingIntervalMs: 1_000, silenceMs: 4_000 });
    muxes.push(extension);
    vi.advanceTimersByTime(10_000);
    expect(closes).toEqual([]);
    expect(up.frames).toEqual([]);
    extension.input(encodeFrame('hello', 0, encodeHello()));
    vi.advanceTimersByTime(5_000);
    expect(closes).toEqual(['no frame came within 4 seconds']);
  });

  it('go when a side sent nothing else, and the silence of the other side ends the connection', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const { up, down, closes } = pair(() => {}, { pingIntervalMs: 1_000, silenceMs: 4_000 });
    await settle();
    vi.advanceTimersByTime(1_400);
    await settle();
    expect(up.frames.map((frame) => frame.kind)).toContain('ping');
    expect(down.frames.map((frame) => frame.kind)).toEqual(['hello', 'ping']);
    // The relay → the extension goes silent.
    down.held = true;
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(500);
      await settle(2);
    }
    // The extension ended its output, so the relay read the end of its input.
    expect(closes).toEqual([
      { side: 'extension', reason: 'no frame came within 4 seconds', failed: true },
      { side: 'relay', reason: 'the connection ended', failed: false },
    ]);
  });
});
