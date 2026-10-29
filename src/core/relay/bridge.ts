// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// A stream of the relay (mux.ts) connected with a pipe of bytes of this side: a socket (one object for both
// directions), or the standard output and input of a process. No `vscode`.
import type { Readable, Writable } from 'stream';
import type { MuxStream } from './mux';

export interface BridgeOptions {
  /**
   * False: the end and the errors of the pipe do not end the stream; its owner ends it (the worker: EXIT when its
   * process ended). Default true.
   */
  pipeEndsStream?: boolean;
  /** The stream was closed by the other side or lost with the connection; the pipe is destroyed already. */
  onClosed?(reason: string): void;
}

/**
 * Connects `stream` with `readable` (what goes to the other side) and `writable` (what comes from it). Each direction
 * keeps its flow: `readable` pauses while the stream holds a window of bytes that the other side has no credit for, and
 * the other side gets credit for bytes only after `writable` took them. The end of `readable` ends the direction of
 * this side (END), and the end of the other side's direction ends `writable`. An error of the pipe, or its close before
 * the end of `readable`, closes the stream with the error as its reason; the close of the stream by the other side, or
 * the loss of the connection, destroys the pipe.
 */
export function bridgeStream(stream: MuxStream, readable: Readable, writable: Writable, options: BridgeOptions = {}): void {
  const pipeEndsStream = options.pipeEndsStream ?? true;
  // A socket is both.
  const oneObject = (writable as unknown) === readable;
  let readableEnded = false;
  const destroy = () => {
    readable.destroy();
    if (!oneObject) writable.destroy();
  };
  const fail = (reason: string) => {
    if (!pipeEndsStream || !stream.isOpen) return;
    stream.close(reason);
    destroy();
  };
  readable.on('data', (chunk: Buffer) => {
    if (!stream.write(chunk)) {
      readable.pause();
      stream.onDrain(() => readable.resume());
    }
  });
  readable.on('end', () => {
    readableEnded = true;
    if (pipeEndsStream) stream.end();
  });
  readable.on('close', () => {
    if (!readableEnded) fail('the connection closed');
  });
  readable.on('error', (error: Error) => fail(error.message));
  if (!oneObject) writable.on('error', (error: Error) => fail(error.message));
  stream.onData((chunk) => {
    if (writable.destroyed || writable.writableEnded) return;
    writable.write(chunk, (error) => {
      if (!error) stream.consumed(chunk.length);
    });
  });
  stream.onEnd(() => {
    if (!writable.destroyed && !writable.writableEnded) writable.end();
  });
  stream.onClose((reason) => {
    destroy();
    options.onClosed?.(reason);
  });
}
