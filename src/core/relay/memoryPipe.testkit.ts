// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// An in-memory connection of the relay for the tests of mux.ts and relay.ts. Never bundled.
import { FrameParser, type Frame } from './frames';
import type { FrameLink } from './mux';

/** What a pipe delivers to: a mux, or the relay. */
export interface PipeTarget {
  input(chunk: Buffer): void;
  inputEnded(): void;
}

/**
 * One direction of an in-memory connection: what is written reaches the other side later (as with a pipe), all of it
 * at once. A write returns false once `highWater` bytes wait; `frames` holds every frame that was written.
 */
export class MemoryPipe {
  target: PipeTarget | undefined;
  readonly frames: Frame[] = [];
  highWater = Number.POSITIVE_INFINITY;
  /** While true, nothing reaches the other side. */
  held = false;
  ended = false;
  private waiting: Buffer[] = [];
  private pending = 0;
  private drain: (() => void) | undefined;
  private scheduled = false;
  private readonly parser = new FrameParser(
    (frame) => this.frames.push({ ...frame, payload: Buffer.from(frame.payload) }),
    (reason) => {
      throw new Error(reason);
    },
  );

  readonly link: FrameLink = {
    write: (chunk) => {
      if (this.ended) throw new Error('written after the end');
      this.parser.push(chunk);
      this.waiting.push(chunk);
      this.pending += chunk.length;
      this.schedule();
      return this.pending < this.highWater;
    },
    onDrain: (listener) => {
      this.drain = listener;
    },
    end: () => {
      this.ended = true;
      this.schedule();
    },
  };

  release(): void {
    this.held = false;
    this.schedule();
  }

  private schedule(): void {
    if (this.scheduled || this.held) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      if (this.held) return;
      const chunks = this.waiting;
      this.waiting = [];
      this.pending = 0;
      for (const chunk of chunks) this.target?.input(chunk);
      const drain = this.drain;
      this.drain = undefined;
      drain?.();
      if (this.ended && this.waiting.length === 0) this.target?.inputEnded();
    });
  }
}

/** Lets the pipes deliver what waits, several turns. */
export async function settle(turns = 20): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
}

