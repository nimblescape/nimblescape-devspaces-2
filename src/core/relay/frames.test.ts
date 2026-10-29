// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import {
  FRAME_HEADER_LENGTH,
  FrameParser,
  MAX_CLOSE_REASON_LENGTH,
  MAX_FRAME_PAYLOAD,
  RELAY_PROTOCOL_VERSION,
  decodeCloseReason,
  decodeCredit,
  decodeExit,
  decodeHello,
  decodeTarget,
  encodeCloseReason,
  encodeCredit,
  encodeExit,
  encodeFrame,
  encodeHello,
  encodeTarget,
  type Frame,
} from './frames';

/** Reads `bytes` in pieces of `size` bytes. */
function parse(bytes: Buffer, size = bytes.length): { frames: Frame[]; errors: string[] } {
  const frames: Frame[] = [];
  const errors: string[] = [];
  const parser = new FrameParser(
    (frame) => frames.push({ ...frame, payload: Buffer.from(frame.payload) }),
    (reason) => errors.push(reason),
  );
  for (let at = 0; at < bytes.length; at += size) parser.push(bytes.subarray(at, at + size));
  return { frames, errors };
}

describe('the frames of the relay', () => {
  it('have a header of the kind, the stream and the length, big-endian', () => {
    expect([...encodeFrame('data', 0x01020304, Buffer.from('ab'))]).toEqual([3, 1, 2, 3, 4, 0, 0, 0, 2, 0x61, 0x62]);
    expect(encodeFrame('ping', 0)).toHaveLength(FRAME_HEADER_LENGTH);
    expect(() => encodeFrame('data', 1, Buffer.alloc(MAX_FRAME_PAYLOAD + 1))).toThrow(RangeError);
  });

  it('are read whole from pieces of any size, every byte value unchanged', () => {
    const all = Buffer.from(Array.from({ length: 256 }, (_, value) => value));
    const big = Buffer.alloc(MAX_FRAME_PAYLOAD, 7);
    const bytes = Buffer.concat([encodeFrame('hello', 0, encodeHello()), encodeFrame('data', 1, all), encodeFrame('end', 1), encodeFrame('data', 2, big), encodeFrame('ping', 0)]);
    for (const size of [1, 2, 8, 9, 10, 4096, bytes.length]) {
      const { frames, errors } = parse(bytes, size);
      expect(errors).toEqual([]);
      expect(frames.map(({ kind, stream, payload }) => [kind, stream, payload.length])).toEqual([
        ['hello', 0, encodeHello().length],
        ['data', 1, 256],
        ['end', 1, 0],
        ['data', 2, MAX_FRAME_PAYLOAD],
        ['ping', 0, 0],
      ]);
      expect(frames[1].payload.equals(all)).toBe(true);
      expect(frames[3].payload.equals(big)).toBe(true);
    }
  });

  it('end the reading at an unknown kind or a payload that is too long, once, and ignore the rest', () => {
    const unknown = Buffer.concat([Buffer.from([99, 0, 0, 0, 1, 0, 0, 0, 0]), encodeFrame('ping', 0)]);
    expect(parse(unknown)).toEqual({ frames: [], errors: ['a frame of the unknown kind 99'] });
    const long = Buffer.from([3, 0, 0, 0, 1, 0, 1, 0, 1]);
    const parsed = parse(Buffer.concat([encodeFrame('ping', 0), long, encodeFrame('ping', 0)]), 3);
    expect(parsed.errors).toEqual([`a frame of ${MAX_FRAME_PAYLOAD + 1} bytes`]);
    expect(parsed.frames.map((frame) => frame.kind)).toEqual(['ping']);
  });

  it('count the bytes of a frame that did not come whole yet', () => {
    const parser = new FrameParser(
      () => {},
      () => {},
    );
    parser.push(encodeFrame('data', 1, Buffer.from('abc')).subarray(0, 10));
    expect(parser.buffered).toBe(10);
  });
});

describe('the payloads of the relay', () => {
  it('OPEN names a target', () => {
    expect(decodeTarget(encodeTarget('worker'))).toBe('worker');
    expect(decodeTarget(encodeTarget('docker'))).toBe('docker');
    expect(decodeTarget(Buffer.from([2]))).toBeUndefined();
    expect(decodeTarget(Buffer.from([1, 0]))).toBeUndefined();
  });

  it('CREDIT is a number of 1 or more bytes', () => {
    expect(decodeCredit(encodeCredit(65536))).toBe(65536);
    expect(decodeCredit(encodeCredit(0))).toBeUndefined();
    expect(decodeCredit(Buffer.from([0, 1]))).toBeUndefined();
  });

  it('CLOSE has one line of plain text as its reason', () => {
    expect(decodeCloseReason(encodeCloseReason('connect ENOENT /var/run/docker.sock'))).toBe('connect ENOENT /var/run/docker.sock');
    expect(decodeCloseReason(encodeCloseReason('a\nb\u001b[31m'))).toBe('a b [31m');
    expect(decodeCloseReason(encodeCloseReason('x'.repeat(2000)))).toHaveLength(MAX_CLOSE_REASON_LENGTH);
    expect(decodeCloseReason(Buffer.from('a\nb'))).toBeUndefined();
    expect(decodeCloseReason(Buffer.from([0xff, 0xfe]))).toBeUndefined();
    expect(decodeCloseReason(Buffer.from('x'.repeat(MAX_CLOSE_REASON_LENGTH + 1)))).toBeUndefined();
  });

  it('EXIT has the exit code or the signal of the worker', () => {
    expect(decodeExit(encodeExit({ code: 0, signal: null }))).toEqual({ code: 0, signal: null });
    expect(decodeExit(encodeExit({ code: null, signal: 'SIGKILL' }))).toEqual({ code: null, signal: 'SIGKILL' });
    expect(decodeExit(Buffer.from('{"code":256,"signal":null}'))).toBeUndefined();
    expect(decodeExit(Buffer.from('{"code":0,"signal":"kill"}'))).toBeUndefined();
    expect(decodeExit(Buffer.from('{"code":0}'))).toBeUndefined();
    expect(decodeExit(Buffer.from('{"code":0,"signal":null,"x":1}'))).toBeUndefined();
    expect(decodeExit(Buffer.from('[0]'))).toBeUndefined();
  });

  it('HELLO has the version of the relay', () => {
    expect(decodeHello(encodeHello())).toBe(RELAY_PROTOCOL_VERSION);
    expect(decodeHello(Buffer.from('{"relay":2}'))).toBe(2);
    expect(decodeHello(Buffer.from('{"relay":"1"}'))).toBeUndefined();
    expect(decodeHello(Buffer.from('{"relay":1,"x":1}'))).toBeUndefined();
    expect(decodeHello(Buffer.from('not json'))).toBeUndefined();
  });
});
