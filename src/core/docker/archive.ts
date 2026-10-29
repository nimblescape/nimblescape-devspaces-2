// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// One file out of an archive of Docker: the Docker CLI out of the static builds of download.docker.com, which are a
// gzip-compressed tar archive (macOS, Linux) or a zip archive (Windows). Only what these archives use is read: tar
// entries in the ustar and GNU forms (with GNU long names and pax `path` records), zip entries that are stored or
// deflated, without zip64. The archive was checked against its pinned SHA-256 before (ownDockerCli.ts), so these readers
// guard only against a damaged file: an entry larger than `maxSize` is refused. No `vscode`.
import * as fs from 'fs';
import * as zlib from 'zlib';
import { pipeline } from 'stream/promises';

/** Reads exact byte counts from an async stream of chunks. */
class ChunkReader {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private ended = false;

  constructor(private readonly source: AsyncIterator<Buffer>) {}

  private async fill(count: number): Promise<boolean> {
    while (this.buffered < count && !this.ended) {
      const next = await this.source.next();
      if (next.done) this.ended = true;
      else {
        this.chunks.push(next.value);
        this.buffered += next.value.length;
      }
    }
    return this.buffered >= count;
  }

  /** The next `count` bytes, or undefined when the stream ends before. */
  async read(count: number): Promise<Buffer | undefined> {
    if (count === 0) return Buffer.alloc(0);
    if (!(await this.fill(count))) return undefined;
    const head = this.chunks[0];
    if (head.length >= count) {
      // Without a copy of the buffered chunks.
      if (head.length === count) this.chunks.shift();
      else this.chunks[0] = head.subarray(count);
      this.buffered -= count;
      return head.subarray(0, count);
    }
    const all = Buffer.concat(this.chunks);
    this.chunks = all.length > count ? [all.subarray(count)] : [];
    this.buffered -= count;
    return all.subarray(0, count);
  }

  /** Gives the next `count` bytes to `sink` (or skips them); false when the stream ends before. */
  async pass(count: number, sink?: (chunk: Buffer) => Promise<void>): Promise<boolean> {
    let left = count;
    while (left > 0) {
      if (this.buffered === 0 && !(await this.fill(1))) return false;
      const chunk = this.chunks.shift()!;
      const take = Math.min(left, chunk.length);
      if (take < chunk.length) this.chunks.unshift(chunk.subarray(take));
      this.buffered -= take;
      left -= take;
      if (sink) await sink(chunk.subarray(0, take));
    }
    return true;
  }
}

/** A number field of a tar header: octal digits, or base-256 when its first byte has the high bit (GNU). */
function tarNumber(field: Buffer): number {
  if ((field[0] & 0x80) !== 0) {
    let value = field[0] & 0x7f;
    for (const byte of field.subarray(1)) value = value * 256 + byte;
    return value;
  }
  const text = field.toString('latin1').replace(/\0.*$/s, '').trim();
  return text === '' ? 0 : Number.parseInt(text, 8);
}

/** A NUL-terminated text field of a tar header. */
function tarText(field: Buffer): string {
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString('utf8');
}

/** The name of an entry without a leading `./`. */
function entryName(name: string): string {
  return name.replace(/^(\.\/)+/, '');
}

/** The `path` of the records of a pax header (`<length> path=<value>\n`), if it has one. */
function paxPath(data: Buffer): string | undefined {
  let at = 0;
  let found: string | undefined;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0) break;
    const length = Number.parseInt(data.subarray(at, space).toString('latin1'), 10);
    if (!Number.isInteger(length) || length <= space - at) break;
    const record = data.subarray(space + 1, at + length - 1).toString('utf8');
    if (record.startsWith('path=')) found = record.slice('path='.length);
    at += length;
  }
  return found;
}

/** The largest header record (a long name or pax header) that is read. */
const MAX_HEADER_RECORD = 64 * 1024;

/**
 * Writes the regular file `entry` (for example `docker/docker`) of the gzip-compressed tar archive `archive` to
 * `target`, a new file with mode 0755. Throws when the archive ends before that entry, or the entry is larger than
 * `maxSize`; `target` may then hold a part of it (the caller removes it).
 */
export async function extractTarGzEntry(archive: string, entry: string, target: string, maxSize: number): Promise<void> {
  const source = fs.createReadStream(archive);
  const stream = zlib.createGunzip();
  // A read error of the archive ends the reader too; both streams close at the end, also when the entry came early.
  source.on('error', (error) => stream.destroy(error));
  source.pipe(stream);
  const reader = new ChunkReader(stream[Symbol.asyncIterator]());
  try {
    let longName: string | undefined;
    for (;;) {
      const header = await reader.read(512);
      if (header === undefined || header.every((byte) => byte === 0)) throw new Error(`${entry} is not in the archive ${archive}.`);
      const size = tarNumber(header.subarray(124, 136));
      const padded = Math.ceil(size / 512) * 512;
      const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
      if (type === 'L' || type === 'x') {
        if (size > MAX_HEADER_RECORD) throw new Error(`The archive ${archive} has a header record of ${size} bytes.`);
        const data = await reader.read(padded);
        if (data === undefined) throw new Error(`The archive ${archive} ends in a header record.`);
        // An empty record changes nothing.
        longName = (type === 'L' ? tarText(data.subarray(0, size)) : paxPath(data.subarray(0, size))) || longName;
        continue;
      }
      // ustar: a prefix of the name in the field at 345 (POSIX `ustar\0`; the GNU form `ustar  \0` has none there).
      const posix = header.subarray(257, 263).toString('latin1') === 'ustar\0';
      const prefix = posix ? tarText(header.subarray(345, 500)) : '';
      const name = entryName(longName ?? (prefix === '' ? tarText(header.subarray(0, 100)) : `${prefix}/${tarText(header.subarray(0, 100))}`));
      longName = undefined;
      if (name === entry && (type === '0' || type === '7')) {
        if (size > maxSize) throw new Error(`${entry} in the archive ${archive} has ${size} bytes, more than ${maxSize}.`);
        const file = await fs.promises.open(target, 'wx', 0o755);
        try {
          // writeFile writes the whole chunk at the current position, also after a short write.
          const complete = await reader.pass(size, (chunk) => file.writeFile(chunk));
          if (!complete) throw new Error(`The archive ${archive} ends in ${entry}.`);
        } finally {
          await file.close();
        }
        return;
      }
      if (!(await reader.pass(padded))) throw new Error(`${entry} is not in the archive ${archive}.`);
    }
  } finally {
    source.destroy();
    stream.destroy();
  }
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** The end record of a zip archive (22 bytes) and its longest comment. */
const EOCD_MAX_DISTANCE = 22 + 0xffff;

async function readAt(file: fs.promises.FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, position);
  if (bytesRead !== length) throw new Error('The zip archive ends too early.');
  return buffer;
}

/**
 * Writes the file `entry` (for example `docker/docker.exe`) of the zip archive `archive` to `target`, a new file with
 * mode 0755. Throws when the archive has no such entry, uses zip64, encryption or another compression than deflate, or
 * the entry is larger than `maxSize`; `target` may then hold a part of it (the caller removes it).
 */
export async function extractZipEntry(archive: string, entry: string, target: string, maxSize: number): Promise<void> {
  const file = await fs.promises.open(archive, 'r');
  let start: number;
  let compressedSize: number;
  let size: number;
  let method: number;
  try {
    const { size: archiveSize } = await file.stat();
    const tailLength = Math.min(archiveSize, EOCD_MAX_DISTANCE);
    const tail = await readAt(file, archiveSize - tailLength, tailLength);
    let eocd = -1;
    for (let at = tail.length - 22; at >= 0; at--) {
      if (tail.readUInt32LE(at) === EOCD_SIGNATURE) {
        eocd = at;
        break;
      }
    }
    if (eocd < 0) throw new Error(`${archive} is no zip archive.`);
    const count = tail.readUInt16LE(eocd + 10);
    const directorySize = tail.readUInt32LE(eocd + 12);
    const directoryOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) throw new Error(`${archive} is a zip64 archive.`);
    const directory = await readAt(file, directoryOffset, directorySize);
    let found: { method: number; flags: number; compressedSize: number; size: number; offset: number } | undefined;
    for (let at = 0, index = 0; index < count; index++) {
      if (at + 46 > directory.length || directory.readUInt32LE(at) !== CENTRAL_SIGNATURE) throw new Error(`The directory of ${archive} is damaged.`);
      const nameLength = directory.readUInt16LE(at + 28);
      const name = directory.subarray(at + 46, at + 46 + nameLength).toString('utf8');
      if (entryName(name) === entry) {
        found = {
          flags: directory.readUInt16LE(at + 8),
          method: directory.readUInt16LE(at + 10),
          compressedSize: directory.readUInt32LE(at + 20),
          size: directory.readUInt32LE(at + 24),
          offset: directory.readUInt32LE(at + 42),
        };
        break;
      }
      at += 46 + nameLength + directory.readUInt16LE(at + 30) + directory.readUInt16LE(at + 32);
    }
    if (found === undefined) throw new Error(`${entry} is not in the archive ${archive}.`);
    if ((found.flags & 0x1) !== 0) throw new Error(`${entry} in the archive ${archive} is encrypted.`);
    if (found.method !== 0 && found.method !== 8) throw new Error(`${entry} in the archive ${archive} uses the compression method ${found.method}.`);
    if (found.size > maxSize) throw new Error(`${entry} in the archive ${archive} has ${found.size} bytes, more than ${maxSize}.`);
    const local = await readAt(file, found.offset, 30);
    if (local.readUInt32LE(0) !== LOCAL_SIGNATURE) throw new Error(`The entry ${entry} of ${archive} is damaged.`);
    start = found.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    ({ compressedSize, size, method } = found);
  } finally {
    await file.close();
  }
  let written = 0;
  const counter = async function* (chunks: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
    for await (const chunk of chunks) {
      written += chunk.length;
      if (written > size) throw new Error(`${entry} in the archive ${archive} has more than its ${size} bytes.`);
      yield chunk;
    }
  };
  const output = fs.createWriteStream(target, { flags: 'wx', mode: 0o755 });
  if (compressedSize === 0) {
    await pipeline(async function* () {}, output);
  } else {
    const source = fs.createReadStream(archive, { start, end: start + compressedSize - 1 });
    if (method === 0) await pipeline(source, counter, output);
    else await pipeline(source, zlib.createInflateRaw(), counter, output);
  }
  if (written !== size) throw new Error(`${entry} in the archive ${archive} has ${written} of its ${size} bytes.`);
}
