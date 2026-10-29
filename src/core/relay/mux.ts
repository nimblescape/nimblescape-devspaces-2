// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The streams of one connection of the relay (frames.ts), the same code on both sides: the extension opens streams,
// the relay accepts them. Each direction of a stream has a credit: the sender sends at most STREAM_WINDOW bytes that
// the receiver did not take yet (each DATA frame counts FRAME_CHARGE bytes more), so a stream whose reader is slow
// never stops the others, and neither side holds more than that per stream. The frames of the connection itself
// (CREDIT, OPEN, CLOSE, PING) go first; then a frame of the worker stream, whose answers must not wait behind a large
// transfer of Docker, but never two in a row while another stream has a frame, so that a long answer of the worker
// does not stop the Docker streams; then the other streams in turn, one frame each. Each side sends PING when it sent nothing else for RELAY_PING_INTERVAL_MS, and ends the connection
// when no frame came for RELAY_SILENCE_MS; the extension from the HELLO on (until then its caller limits the wait, which
// may include a login). No `vscode`.
import {
  FRAME_CHARGE,
  FRAME_HEADER_LENGTH,
  FrameParser,
  MAX_STREAMS,
  MAX_FRAME_PAYLOAD,
  RELAY_PING_INTERVAL_MS,
  RELAY_PROTOCOL_VERSION,
  RELAY_SILENCE_MS,
  STREAM_WINDOW,
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
  frameWithHeader,
  type Frame,
  type RelayTarget,
  type WorkerExit,
} from './frames';

/** The receiver gives credit back once it took this many bytes (and at least as much is outstanding). */
const CREDIT_STEP = STREAM_WINDOW / 4;

/** The bytes of the connection: the standard input of the other side. */
export interface FrameLink {
  /** Writes `chunk`. False: it holds more than it wants; the next write waits for onDrain. */
  write(chunk: Buffer): boolean;
  /** `listener` is called once, when the link wants more after a write that returned false. */
  onDrain(listener: () => void): void;
  /** Ends the output (the other side reads the end of its input). */
  end(): void;
}

export interface MuxOptions {
  /** The extension opens streams and waits for the HELLO of the relay; the relay sends HELLO and accepts them. */
  side: 'extension' | 'relay';
  link: FrameLink;
  /**
   * The relay: a stream that the extension opened. The listeners of the stream are set before this returns (the data
   * that comes before waits for them).
   */
  accept?(stream: MuxStream): void;
  /**
   * Called once when the connection ends: its input ended (`failed` false), or a frame broke the rules, the input of
   * the other side could not be written, or no frame came in time (`failed` true); not after `close`.
   */
  onClose?(reason: string, failed: boolean): void;
  pingIntervalMs?: number;
  silenceMs?: number;
}

/** One stream of the connection: a pipe of bytes in both directions. Each listener: one at a time. */
export interface MuxStream {
  /** Its number on the connection (1 or more). */
  readonly id: number;
  readonly target: RelayTarget;
  /** True until it ended in both directions, was closed, or the connection ended. */
  readonly isOpen: boolean;
  /**
   * Sends `chunk` after what waits. False when a window of bytes waits that the other side has no credit for: the
   * writer should wait for onDrain. Dropped after end, exit or close, and the stream ended (true: nothing waits).
   */
  write(chunk: Buffer): boolean;
  /** Ends the direction of this side after what waits (END). */
  end(): void;
  /** The relay, a worker stream: the worker ended, after what waits (EXIT); the stream ends. */
  exit(exit: WorkerExit): void;
  /** Ends both directions at once (CLOSE with `reason`); what waits is dropped. No listener is called. */
  close(reason?: string): void;
  /** The reader took `bytes` of the data (onData): the other side may send that many more. */
  consumed(bytes: number): void;
  /** Data of the other side, in order. Each chunk counts against the credit until `consumed`. */
  onData(listener: (chunk: Buffer) => void): void;
  /** The other side ended its direction (after its last data). */
  onEnd(listener: () => void): void;
  /** The extension, a worker stream: the worker ended (after its last data); the stream ended. */
  onExit(listener: (exit: WorkerExit) => void): void;
  /** The other side closed the stream (its reason), or the connection ended. Not after `close` of this side. */
  onClose(listener: (reason: string) => void): void;
  /**
   * Once, the next time that the bytes that wait drop below the window after a write that returned false, or the
   * stream ends. Set it right after that write.
   */
  onDrain(listener: () => void): void;
}

/** What a stream needs from its connection. */
interface StreamHost {
  readonly side: 'extension' | 'relay';
  control(frame: Buffer): void;
  pump(): void;
  remove(stream: Stream): void;
}

type Inbox = { kind: 'data'; chunk: Buffer } | { kind: 'end' } | { kind: 'exit'; exit: WorkerExit };

/** The bytes that wait to be sent, in the pieces of their writes; taken from the front in any size. */
class ByteQueue {
  private pieces: Buffer[] = [];
  private head = 0;
  length = 0;

  push(chunk: Buffer): void {
    this.pieces.push(chunk);
    this.length += chunk.length;
  }

  clear(): void {
    this.pieces = [];
    this.head = 0;
    this.length = 0;
  }

  /** Copies the next `size` bytes (1 to `length`) into `target` at `offset`, and takes them. */
  takeInto(target: Buffer, offset: number, size: number): void {
    this.length -= size;
    for (let at = 0; at < size; ) {
      const piece = this.pieces[this.head];
      const used = piece.copy(target, offset + at, 0, Math.min(piece.length, size - at));
      at += used;
      this.advance(piece, used);
    }
    // The array drops the pieces that were taken once they are the larger part (each piece is moved a bounded number
    // of times).
    if (this.head > 64 && this.head * 2 > this.pieces.length) {
      this.pieces = this.pieces.slice(this.head);
      this.head = 0;
    }
  }

  private advance(piece: Buffer, used: number): void {
    if (used === piece.length) this.pieces[this.head++] = EMPTY;
    else this.pieces[this.head] = piece.subarray(used);
  }
}

const EMPTY = Buffer.alloc(0);

class Stream implements MuxStream {
  // Sending.
  private readonly queue = new ByteQueue();
  private credit = STREAM_WINDOW;
  /** END or EXIT, sent after the queue; `sent` once it went. */
  private last: { kind: 'end' | 'exit'; frame: Buffer; sent: boolean } | undefined;
  private drainWanted = false;
  // Receiving.
  private readonly inbox: Inbox[] = [];
  /** Received and not given back as credit (held, or taken and not yet given back), with the charge of each frame. */
  private outstanding = 0;
  /** Taken and not yet given back, with the charge of each chunk that was taken whole. */
  private taken = 0;
  /** The bytes of each received chunk that were not taken yet, oldest first, from `unreadHead` on. */
  private unread: number[] = [];
  private unreadHead = 0;
  private peerEnded = false;
  private state: 'open' | 'finished' | 'closed' = 'open';
  private dataListener: ((chunk: Buffer) => void) | undefined;
  private endListener: (() => void) | undefined;
  private exitListener: ((exit: WorkerExit) => void) | undefined;
  private closeListener: ((reason: string) => void) | undefined;
  private drainListener: (() => void) | undefined;

  constructor(
    private readonly host: StreamHost,
    readonly id: number,
    readonly target: RelayTarget,
  ) {}

  get isOpen(): boolean {
    return this.state === 'open';
  }

  write(chunk: Buffer): boolean {
    if (this.state !== 'open' || this.last !== undefined) return true;
    if (chunk.length > 0) {
      this.queue.push(chunk);
      this.host.pump();
    }
    // After the frames that could go at once.
    const below = this.queue.length < STREAM_WINDOW;
    if (!below) this.drainWanted = true;
    return below;
  }

  end(): void {
    this.finishWith('end', encodeFrame('end', this.id));
  }

  exit(exit: WorkerExit): void {
    if (this.host.side !== 'relay' || this.target !== 'worker') throw new Error('Only the relay ends a worker stream with the exit of its worker.');
    this.finishWith('exit', encodeFrame('exit', this.id, encodeExit(exit)));
  }

  close(reason = ''): void {
    if (this.state !== 'open') return;
    this.drop();
    this.host.control(encodeFrame('close', this.id, encodeCloseReason(reason)));
    this.host.pump();
  }

  consumed(bytes: number): void {
    if (this.state !== 'open' || !(bytes > 0)) return;
    // The chunks are taken in order; each one gives its charge back once all of its bytes were taken.
    for (let left = bytes; left > 0 && this.unreadHead < this.unread.length; ) {
      const rest = this.unread[this.unreadHead];
      const step = Math.min(left, rest);
      left -= step;
      this.taken += step;
      if (step < rest) {
        this.unread[this.unreadHead] = rest - step;
      } else {
        this.unreadHead++;
        this.taken += FRAME_CHARGE;
      }
    }
    if (this.unreadHead > 64 && this.unreadHead * 2 > this.unread.length) {
      this.unread = this.unread.slice(this.unreadHead);
      this.unreadHead = 0;
    }
    // A sender without credit for a frame has nearly a whole window outstanding (all but at most FRAME_CHARGE bytes);
    // once all of it was taken, this step is reached.
    if (this.taken < CREDIT_STEP) return;
    const credit = this.taken;
    this.taken = 0;
    this.outstanding -= credit;
    this.host.control(encodeFrame('credit', this.id, encodeCredit(credit)));
    this.host.pump();
  }

  onData(listener: (chunk: Buffer) => void): void {
    this.dataListener = listener;
    this.deliver();
  }

  onEnd(listener: () => void): void {
    this.endListener = listener;
    this.deliver();
  }

  onExit(listener: (exit: WorkerExit) => void): void {
    this.exitListener = listener;
    this.deliver();
  }

  onClose(listener: (reason: string) => void): void {
    this.closeListener = listener;
  }

  onDrain(listener: () => void): void {
    this.drainListener = listener;
  }

  /** True when a frame of the stream may go now. */
  hasFrame(): boolean {
    if (this.state !== 'open') return false;
    if (this.queue.length > 0) return this.credit > FRAME_CHARGE;
    return this.last !== undefined && !this.last.sent;
  }

  /** The next frame of the stream (hasFrame was true). */
  takeFrame(): Buffer {
    if (this.queue.length > 0) {
      const size = Math.min(MAX_FRAME_PAYLOAD, this.credit - FRAME_CHARGE, this.queue.length);
      // The bytes go from the queue straight into the frame.
      const frame = frameWithHeader('data', this.id, size);
      this.queue.takeInto(frame, FRAME_HEADER_LENGTH, size);
      this.credit -= size + FRAME_CHARGE;
      if (this.queue.length < STREAM_WINDOW) this.drained();
      return frame;
    }
    const last = this.last as NonNullable<Stream['last']>;
    last.sent = true;
    // EXIT ends both directions; END ends both once the other side ended too.
    if (last.kind === 'exit' || this.peerEnded) this.finish();
    return last.frame;
  }

  /** A frame of the other side for this stream; the reason when it breaks the rules. */
  receive(frame: Frame): string | undefined {
    switch (frame.kind) {
      case 'data': {
        if (this.peerEnded) return `data on the stream ${this.id} after its end`;
        if (frame.payload.length === 0) return `empty data on the stream ${this.id}`;
        this.outstanding += frame.payload.length + FRAME_CHARGE;
        if (this.outstanding > STREAM_WINDOW) return `more data on the stream ${this.id} than its credit`;
        this.unread.push(frame.payload.length);
        this.inbox.push({ kind: 'data', chunk: frame.payload });
        this.deliver();
        return undefined;
      }
      case 'end':
        if (frame.payload.length !== 0 || this.peerEnded) return `an invalid end of the stream ${this.id}`;
        this.peerEnded = true;
        this.inbox.push({ kind: 'end' });
        if (this.last?.sent) this.finish();
        this.deliver();
        return undefined;
      case 'exit': {
        const exit = decodeExit(frame.payload);
        if (this.host.side !== 'extension' || this.target !== 'worker' || exit === undefined || this.peerEnded) return `an invalid exit on the stream ${this.id}`;
        this.peerEnded = true;
        this.inbox.push({ kind: 'exit', exit });
        this.finish();
        this.deliver();
        return undefined;
      }
      case 'credit': {
        const bytes = decodeCredit(frame.payload);
        if (bytes === undefined || this.credit + bytes > STREAM_WINDOW) return `an invalid credit on the stream ${this.id}`;
        this.credit += bytes;
        this.host.pump();
        return undefined;
      }
      case 'close': {
        const reason = decodeCloseReason(frame.payload);
        if (reason === undefined) return `an invalid close of the stream ${this.id}`;
        this.lose(reason || 'the other side closed it');
        return undefined;
      }
      default:
        return `a frame ${frame.kind} on the stream ${this.id}`;
    }
  }

  /** The other side closed it, or the connection ended: what waits is dropped, onClose. */
  lose(reason: string): void {
    if (this.state !== 'open') return;
    this.drop();
    this.inbox.length = 0;
    const listener = this.closeListener;
    this.closeListener = undefined;
    this.dataListener = undefined;
    this.endListener = undefined;
    this.exitListener = undefined;
    listener?.(reason);
  }

  /**
   * Wakes a writer that waits for onDrain. Later, so that a writer whose write returned false while these frames went
   * at once has set its listener.
   */
  private drained(): void {
    if (!this.drainWanted) return;
    this.drainWanted = false;
    queueMicrotask(() => {
      const listener = this.drainListener;
      this.drainListener = undefined;
      listener?.();
    });
  }

  private finishWith(kind: 'end' | 'exit', frame: Buffer): void {
    if (this.state !== 'open' || this.last !== undefined) return;
    this.last = { kind, frame, sent: false };
    this.host.pump();
  }

  /**
   * Ended in both directions (or EXIT came, which drops what waits to be sent): removed from the connection; the inbox
   * still goes to its listeners.
   */
  private finish(): void {
    this.state = 'finished';
    this.queue.clear();
    this.host.remove(this);
    this.drained();
  }

  /** Closed: what waits is dropped; a writer that waits for onDrain wakes and finds it ended. */
  private drop(): void {
    this.state = 'closed';
    this.queue.clear();
    this.host.remove(this);
    this.drained();
  }

  /** Gives the inbox to its listeners, in order; a part without its listener waits for it. */
  private deliver(): void {
    while (this.inbox.length > 0 && this.state !== 'closed') {
      const next = this.inbox[0];
      const listener = next.kind === 'data' ? this.dataListener : next.kind === 'end' ? this.endListener : this.exitListener;
      if (listener === undefined) return;
      this.inbox.shift();
      if (next.kind === 'data') (listener as (chunk: Buffer) => void)(next.chunk);
      else if (next.kind === 'exit') (listener as (exit: WorkerExit) => void)(next.exit);
      else (listener as () => void)();
    }
  }
}

/** One connection of the relay with its streams (the comment at the top). */
export class Mux implements StreamHost {
  readonly side: 'extension' | 'relay';
  private readonly parser: FrameParser;
  private readonly streams = new Map<number, Stream>();
  /** The streams in the order of their turn. */
  private order: Stream[] = [];
  private turn = 0;
  private readonly controls: Buffer[] = [];
  /** The extension: the last stream that it opened; the relay: the last stream that the extension opened. */
  private lastId = 0;
  /** The extension sends nothing before the HELLO of the relay. */
  private ready: boolean;
  private congested = false;
  /** The last frame of a stream was one of a worker stream: the next one goes to another stream that has one. */
  private workerWent = false;
  private pumping = false;
  private ended: string | undefined;
  // A monotonic clock (performance.now()), which a step of the wall clock does not change.
  private lastSent = performance.now();
  private lastReceived = performance.now();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly pingIntervalMs: number;
  private readonly silenceMs: number;

  constructor(private readonly options: MuxOptions) {
    this.side = options.side;
    this.ready = options.side === 'relay';
    this.pingIntervalMs = options.pingIntervalMs ?? RELAY_PING_INTERVAL_MS;
    this.silenceMs = options.silenceMs ?? RELAY_SILENCE_MS;
    this.parser = new FrameParser(
      (frame) => this.onFrame(frame),
      (reason) => this.fail(`the other side sent ${reason}`),
    );
    this.timer = setInterval(() => this.tick(), Math.max(10, Math.min(this.pingIntervalMs, this.silenceMs) / 3));
    this.timer.unref?.();
    if (options.side === 'relay') {
      this.control(encodeFrame('hello', 0, encodeHello()));
      this.pump();
    }
  }

  /** True until the connection ended or was closed. */
  get isOpen(): boolean {
    return this.ended === undefined;
  }

  /** The streams that are open now. */
  get streamCount(): number {
    return this.streams.size;
  }

  /**
   * The extension: opens a stream to `target` in the container. Its frames go once the relay said HELLO. Throws when
   * the connection ended or MAX_STREAMS streams are open.
   */
  open(target: RelayTarget): MuxStream {
    if (this.side !== 'extension') throw new Error('Only the extension opens streams of the relay.');
    if (this.ended !== undefined) throw new Error(`The connection of the relay ended: ${this.ended}`);
    if (this.streams.size >= MAX_STREAMS) throw new Error(`The connection of the relay has ${MAX_STREAMS} streams open.`);
    const stream = new Stream(this, ++this.lastId, target);
    this.add(stream);
    this.control(encodeFrame('open', stream.id, encodeTarget(target)));
    this.pump();
    return stream;
  }

  /** Bytes of the other side, as they come. */
  input(chunk: Buffer): void {
    if (this.ended !== undefined) return;
    this.lastReceived = performance.now();
    try {
      this.parser.push(chunk);
    } catch (error) {
      // A listener failed within the chunk: the rest of the chunk is lost, so the frames that follow cannot be read.
      this.fail(`an error while a frame was handled: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The input ended: every stream is lost. Within a frame, or before the HELLO of the relay, as a failure. */
  inputEnded(): void {
    if (this.ended !== undefined) return;
    const reason = !this.ready ? 'the connection ended before the hello of the relay' : this.parser.buffered > 0 ? 'the connection ended within a frame' : 'the connection ended';
    const failed = !this.ready || this.parser.buffered > 0;
    this.shutDown(reason);
    this.options.onClose?.(reason, failed);
  }

  /** Ends the connection from this side: every stream is lost with `reason`, the output ends. */
  close(reason: string): void {
    if (this.ended !== undefined) return;
    this.shutDown(reason);
  }

  control(frame: Buffer): void {
    if (this.ended === undefined) this.controls.push(frame);
  }

  remove(stream: Stream): void {
    if (this.streams.get(stream.id) !== stream) return;
    this.streams.delete(stream.id);
    const at = this.order.indexOf(stream);
    this.order.splice(at, 1);
    if (at < this.turn) this.turn--;
  }

  pump(): void {
    if (this.pumping || this.congested || !this.ready || this.ended !== undefined) return;
    this.pumping = true;
    try {
      for (let frame = this.nextFrame(); frame !== undefined; frame = this.nextFrame()) {
        this.lastSent = performance.now();
        let written: boolean;
        try {
          written = this.options.link.write(frame);
        } catch (error) {
          this.fail(`the connection cannot be written (${(error as Error).message})`);
          return;
        }
        if (!written) {
          this.congested = true;
          this.options.link.onDrain(() => {
            this.congested = false;
            this.pump();
          });
          return;
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private add(stream: Stream): void {
    this.streams.set(stream.id, stream);
    this.order.push(stream);
  }

  private nextFrame(): Buffer | undefined {
    const control = this.controls.shift();
    if (control !== undefined) return control;
    const worker = this.order.find((stream) => stream.target === 'worker' && stream.hasFrame());
    if (worker !== undefined && !this.workerWent) {
      this.workerWent = true;
      return worker.takeFrame();
    }
    for (let i = 0; i < this.order.length; i++) {
      const at = (this.turn + i) % this.order.length;
      const stream = this.order[at];
      if (stream.target !== 'worker' && stream.hasFrame()) {
        this.turn = at + 1;
        this.workerWent = false;
        return stream.takeFrame();
      }
    }
    return worker?.takeFrame();
  }

  private onFrame(frame: Frame): void {
    if (this.ended !== undefined) return;
    if (!this.ready) {
      // The extension: the first frame of the relay is its HELLO.
      const version = frame.kind === 'hello' && frame.stream === 0 ? decodeHello(frame.payload) : undefined;
      if (version === undefined) return this.fail('the relay did not start with its hello');
      if (version !== RELAY_PROTOCOL_VERSION) return this.fail(`the relay speaks version ${version}, not ${RELAY_PROTOCOL_VERSION}`);
      this.ready = true;
      this.pump();
      return;
    }
    if (frame.kind === 'ping') {
      if (frame.stream !== 0 || frame.payload.length !== 0) this.fail('the other side sent an invalid ping');
      return;
    }
    if (frame.kind === 'hello') return this.fail('the other side sent a second hello');
    if (frame.kind === 'open') return this.onOpen(frame);
    const stream = this.streams.get(frame.stream);
    if (stream === undefined) {
      // A frame of a stream that ended on this side may still come; a stream that was never opened is an error.
      if (frame.stream === 0 || frame.stream > this.lastId) this.fail(`the other side sent a frame ${frame.kind} on the stream ${frame.stream}, which was never opened`);
      return;
    }
    const broken = stream.receive(frame);
    if (broken !== undefined) this.fail(`the other side sent ${broken}`);
  }

  private onOpen(frame: Frame): void {
    const target = decodeTarget(frame.payload);
    if (this.side !== 'relay' || target === undefined || frame.stream !== this.lastId + 1) return this.fail(`the other side sent an invalid open of the stream ${frame.stream}`);
    this.lastId = frame.stream;
    // The extension opens no more (open); its count of open streams is never below this one.
    if (this.streams.size >= MAX_STREAMS) return this.fail(`the other side opened more than ${MAX_STREAMS} streams`);
    const stream = new Stream(this, frame.stream, target);
    this.add(stream);
    if (this.options.accept) this.options.accept(stream);
    else stream.close('the relay accepts no stream');
  }

  private tick(): void {
    if (this.ended !== undefined || !this.ready) return;
    const now = performance.now();
    if (now - this.lastReceived >= this.silenceMs) return this.fail(`no frame came within ${Math.round(this.silenceMs / 1000)} seconds`);
    // While the link holds frames that wait, it is not idle; a ping would only wait behind them.
    if (!this.congested && now - this.lastSent >= this.pingIntervalMs) {
      this.control(encodeFrame('ping', 0));
      this.pump();
    }
  }

  private fail(reason: string): void {
    if (this.ended !== undefined) return;
    this.shutDown(reason);
    this.options.onClose?.(reason, true);
  }

  private shutDown(reason: string): void {
    this.ended = reason;
    clearInterval(this.timer);
    this.controls.length = 0;
    for (const stream of [...this.streams.values()]) stream.lose(reason);
    try {
      this.options.link.end();
    } catch {
      // The output is gone already.
    }
  }
}
