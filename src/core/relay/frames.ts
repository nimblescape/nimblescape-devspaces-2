// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The frames of the relay (docs/architecture.md "The relay"). The relay is the first program of the worker container:
// one connection of bytes (its standard input and output) carries several streams, each a pipe of bytes in both
// directions: the worker (its standard input and output) and connections to the Docker socket of the engine. Each frame
// is a header of FRAME_HEADER_LENGTH bytes (its kind, the number of its stream and the length of its payload, both
// unsigned 32-bit big-endian) and the payload. Stream 0 is the connection itself (HELLO, PING); the extension opens the
// streams 1, 2, 3, … in this order. Pure functions and constants; no I/O. No `vscode`.

/** The entry of the relay in the worker's bundle (src/helperChannel/main.ts), for the pipe loader. */
export const RELAY_ENTRY = 'startRelay';
/** The version of the frames and of the HELLO of the relay. Both sides come from one bundle of the extension. */
export const RELAY_PROTOCOL_VERSION = 1;

/** The kind of a frame (its first byte). */
export const FRAME = {
  /** The relay → the extension, the first frame, stream 0: JSON `{"relay": RELAY_PROTOCOL_VERSION}`. */
  hello: 1,
  /** The extension → the relay: opens a new stream; the payload is one byte, its target (TARGET). */
  open: 2,
  /** Bytes of the stream, at most the credit of the sender. */
  data: 3,
  /** The sender writes no more to the stream (its direction ends after the data before it); no payload. */
  end: 4,
  /** The stream ends in both directions at once, its data not yet delivered is dropped; the payload is the reason. */
  close: 5,
  /** The receiver took bytes of the stream: the sender may send that many more; payload: their number (uint32). */
  credit: 6,
  /**
   * The relay → the extension: the worker of the stream ended, after all its output; the stream ends in both
   * directions. JSON `{"code": <exit code or null>, "signal": <signal name or null>}`.
   */
  exit: 7,
  /** Either side, stream 0, when it sent nothing else for RELAY_PING_INTERVAL_MS; no payload. */
  ping: 8,
} as const;

export type FrameKind = keyof typeof FRAME;

/** What a stream connects to in the worker container (the payload of OPEN). */
export const TARGET = {
  /** The worker: a process of the worker's script (startChannel) with its standard input and output. */
  worker: 0,
  /** A connection to the Docker socket of the engine in the container. */
  docker: 1,
} as const;

export type RelayTarget = keyof typeof TARGET;

/** The header: the kind (1 byte), the stream (4 bytes), the length of the payload (4 bytes). */
export const FRAME_HEADER_LENGTH = 9;
/** The longest payload of a frame. */
export const MAX_FRAME_PAYLOAD = 64 * 1024;
/** The credit of each direction of a stream at its start: the most bytes that the receiver holds without taking them. */
export const STREAM_WINDOW = 256 * 1024;
/** The most streams of one connection at a time (the relay closes each further stream at once). */
export const MAX_STREAMS = 256;
/** The longest reason of CLOSE, in characters. */
export const MAX_CLOSE_REASON_LENGTH = 500;
/** Each side sends PING when it sent nothing else for this long. */
export const RELAY_PING_INTERVAL_MS = 15_000;
/** Each side ends the connection when no frame came for this long (three pings missed). */
export const RELAY_SILENCE_MS = 60_000;

const KINDS = new Map<number, FrameKind>(Object.entries(FRAME).map(([kind, code]) => [code, kind as FrameKind]));
const TARGETS = new Map<number, RelayTarget>(Object.entries(TARGET).map(([target, code]) => [code, target as RelayTarget]));

/** A frame as it was read. */
export interface Frame {
  kind: FrameKind;
  stream: number;
  payload: Buffer;
}

/** A frame: its header and `payload`, which must not be longer than MAX_FRAME_PAYLOAD. */
export function encodeFrame(kind: FrameKind, stream: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  if (payload.length > MAX_FRAME_PAYLOAD) throw new RangeError(`A frame holds at most ${MAX_FRAME_PAYLOAD} bytes, not ${payload.length}.`);
  const frame = Buffer.allocUnsafe(FRAME_HEADER_LENGTH + payload.length);
  frame.writeUInt8(FRAME[kind], 0);
  frame.writeUInt32BE(stream, 1);
  frame.writeUInt32BE(payload.length, 5);
  payload.copy(frame, FRAME_HEADER_LENGTH);
  return frame;
}

/** The payload of OPEN. */
export function encodeTarget(target: RelayTarget): Buffer {
  return Buffer.from([TARGET[target]]);
}

/** The target of the payload of OPEN; undefined for another payload. */
export function decodeTarget(payload: Buffer): RelayTarget | undefined {
  return payload.length === 1 ? TARGETS.get(payload[0]) : undefined;
}

/** The payload of CREDIT. */
export function encodeCredit(bytes: number): Buffer {
  const payload = Buffer.allocUnsafe(4);
  payload.writeUInt32BE(bytes, 0);
  return payload;
}

/** The number of bytes of the payload of CREDIT (1 or more); undefined for another payload. */
export function decodeCredit(payload: Buffer): number | undefined {
  if (payload.length !== 4) return undefined;
  const bytes = payload.readUInt32BE(0);
  return bytes > 0 ? bytes : undefined;
}

/**
 * The payload of CLOSE: `reason` as one line of plain text (each control character a space), cut to
 * MAX_CLOSE_REASON_LENGTH characters.
 */
export function encodeCloseReason(reason: string): Buffer {
  return Buffer.from(reason.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, MAX_CLOSE_REASON_LENGTH), 'utf8');
}

/**
 * The reason of the payload of CLOSE; undefined when it is no plain text of at most MAX_CLOSE_REASON_LENGTH characters
 * in UTF-8 (the other side sends it as encodeCloseReason makes it).
 */
export function decodeCloseReason(payload: Buffer): string | undefined {
  const text = payload.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(payload)) return undefined;
  return text.length <= MAX_CLOSE_REASON_LENGTH && !/[\u0000-\u001f\u007f]/.test(text) ? text : undefined;
}

/** How the worker of a stream ended (EXIT). */
export interface WorkerExit {
  code: number | null;
  signal: string | null;
}

export function encodeExit(exit: WorkerExit): Buffer {
  return Buffer.from(JSON.stringify({ code: exit.code, signal: exit.signal }), 'utf8');
}

/** The end of the worker of the payload of EXIT; undefined for another payload. */
export function decodeExit(payload: Buffer): WorkerExit | undefined {
  const value = parseJsonObject(payload);
  if (value === undefined || Object.keys(value).length !== 2) return undefined;
  const { code, signal } = value;
  if (code !== null && (typeof code !== 'number' || !Number.isSafeInteger(code) || code < 0 || code > 255)) return undefined;
  if (signal !== null && (typeof signal !== 'string' || !/^SIG[A-Z0-9]{1,12}$/.test(signal))) return undefined;
  return { code, signal };
}

export function encodeHello(): Buffer {
  return Buffer.from(JSON.stringify({ relay: RELAY_PROTOCOL_VERSION }), 'utf8');
}

/** The version of the relay in the payload of HELLO; undefined for another payload. */
export function decodeHello(payload: Buffer): number | undefined {
  const value = parseJsonObject(payload);
  if (value === undefined || Object.keys(value).length !== 1) return undefined;
  const { relay } = value;
  return typeof relay === 'number' && Number.isSafeInteger(relay) && relay > 0 ? relay : undefined;
}

function parseJsonObject(payload: Buffer): Record<string, unknown> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(payload.toString('utf8'));
  } catch {
    return undefined;
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * Reads frames from the bytes of a connection as they come, in pieces of any size. A header of an unknown kind or with
 * a payload longer than MAX_FRAME_PAYLOAD ends the reading: `onError` once, and every later piece is ignored. A payload
 * that is at least half of its piece is a part of that piece (no copy); a smaller one is copied, so that a payload that
 * a reader holds keeps at most twice its size in memory (the credit of a stream counts payloads); one that spans pieces
 * is copied together.
 */
export class FrameParser {
  private readonly header = Buffer.alloc(FRAME_HEADER_LENGTH);
  private headerFilled = 0;
  /** The frame whose payload came in part. */
  private partial: { kind: FrameKind; stream: number; payload: Buffer; filled: number } | undefined;
  private failed = false;

  constructor(
    private readonly onFrame: (frame: Frame) => void,
    private readonly onError: (reason: string) => void,
  ) {}

  /** The bytes of the connection that the reader read and that are no whole frame yet. */
  get buffered(): number {
    return this.partial === undefined ? this.headerFilled : FRAME_HEADER_LENGTH + this.partial.filled;
  }

  push(chunk: Buffer): void {
    let at = 0;
    while (at < chunk.length && !this.failed) {
      if (this.partial !== undefined) {
        const { payload } = this.partial;
        const used = chunk.copy(payload, this.partial.filled, at, Math.min(chunk.length, at + payload.length - this.partial.filled));
        this.partial.filled += used;
        at += used;
        if (this.partial.filled === payload.length) {
          const { kind, stream } = this.partial;
          this.partial = undefined;
          this.onFrame({ kind, stream, payload });
        }
        continue;
      }
      const used = chunk.copy(this.header, this.headerFilled, at, Math.min(chunk.length, at + FRAME_HEADER_LENGTH - this.headerFilled));
      this.headerFilled += used;
      at += used;
      if (this.headerFilled < FRAME_HEADER_LENGTH) return;
      this.headerFilled = 0;
      const code = this.header.readUInt8(0);
      const kind = KINDS.get(code);
      const stream = this.header.readUInt32BE(1);
      const length = this.header.readUInt32BE(5);
      if (kind === undefined) return this.fail(`a frame of the unknown kind ${code}`);
      if (length > MAX_FRAME_PAYLOAD) return this.fail(`a frame of ${length} bytes`);
      if (chunk.length - at >= length) {
        // The whole payload is in this piece.
        const part = chunk.subarray(at, at + length);
        this.onFrame({ kind, stream, payload: 2 * length >= chunk.length ? part : Buffer.from(part) });
        at += length;
      } else this.partial = { kind, stream, payload: Buffer.allocUnsafe(length), filled: 0 };
    }
  }

  private fail(reason: string): void {
    this.failed = true;
    this.partial = undefined;
    this.headerFilled = 0;
    this.onError(reason);
  }
}
