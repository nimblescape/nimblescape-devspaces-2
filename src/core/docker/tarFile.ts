// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// A minimal reader of the first entry of a tar archive, for the answer of `GET /containers/<id>/archive?path=<file>` of
// the Engine API (the engine archives the one file at that path, under its base name). Only a regular file counts; a
// link, a folder, a GNU extended header, a PAX header that makes it another name, size or kind of entry, or anything
// malformed is refused, so that the caller treats the file as unknown. Pure; no I/O, no `vscode`.

/** The size of a tar header block (and of the blocks that the data is padded to). */
export const TAR_BLOCK_BYTES = 512;

/** The checks of firstTarFile. */
export interface TarFileOptions {
  /** The name that the entry must have (the base name of the archived path; the engine names the entry so). */
  name: string;
  /** The most bytes of the file; a larger one is refused. */
  maxBytes: number;
}

/** The text of a header field: up to its first NUL, as bytes read as Latin-1 (one character per byte). */
function field(header: Buffer, start: number, length: number): string {
  const bytes = header.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString('latin1');
}

/**
 * A numeric header field: octal digits, optionally led by spaces and ended by NUL or spaces. Undefined for anything
 * else, also for the base-256 form of GNU tar (a first byte with its high bit set), which no file of the bounded size
 * needs.
 */
function octal(header: Buffer, start: number, length: number): number | undefined {
  const text = header.subarray(start, start + length).toString('latin1');
  const match = /^ *([0-7]{1,12})[ \0]*$/.exec(text);
  if (match === null) return undefined;
  const value = parseInt(match[1], 8);
  return Number.isSafeInteger(value) ? value : undefined;
}

/** The largest PAX extended header (its records) that firstTarFile reads before the entry of the file. */
export const MAX_PAX_HEADER_BYTES = 64 * 1024;

/**
 * The keys of PAX records that make the entry something other than a plain file (`linkpath`; `GNU.sparse.*`: the data
 * is a sparse map and fragments, not the file); a header with one is refused.
 */
const PAX_REFUSED_KEYS = /^(?:linkpath|GNU\.sparse\..*)$/;

/** The bytes of the header blocks and the data blocks of an entry with `size` bytes of data. */
function entryBytes(size: number): number {
  return TAR_BLOCK_BYTES + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
}

/** The header block at `offset` when its checksum matches; undefined when the archive ends before it or it does not. */
function headerAt(archive: Buffer, offset: number): Buffer | undefined {
  if (archive.length < offset + TAR_BLOCK_BYTES) return undefined;
  const header = archive.subarray(offset, offset + TAR_BLOCK_BYTES);
  // The checksum: the sum of the bytes of the header with the checksum field itself counted as spaces.
  const recorded = octal(header, 148, 8);
  if (recorded === undefined) return undefined;
  let sum = 0;
  for (let i = 0; i < TAR_BLOCK_BYTES; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
  return sum === recorded ? header : undefined;
}

/**
 * The records of a PAX extended header (`<length> <key>=<value>\n` each, the length counting the whole record, the
 * value UTF-8), the last one of a key counting; undefined when they are malformed. The engine writes such a header for
 * the extended attributes of a file (`SCHILY.xattr.*`), exact times, or a name or size that the ustar header cannot hold.
 */
function paxRecords(records: Buffer): Map<string, string> | undefined {
  const found = new Map<string, string>();
  let at = 0;
  while (at < records.length) {
    const space = records.indexOf(0x20, at);
    if (space === -1) return undefined;
    const lengthText = records.subarray(at, space).toString('latin1');
    if (!/^[1-9]\d{0,5}$/.test(lengthText)) return undefined;
    const end = at + Number(lengthText);
    if (end > records.length || records[end - 1] !== 0x0a) return undefined;
    const record = records.subarray(space + 1, end - 1);
    const equals = record.indexOf(0x3d);
    if (equals <= 0) return undefined;
    found.set(record.subarray(0, equals).toString('latin1'), record.subarray(equals + 1).toString('utf8'));
    at = end;
  }
  return found;
}

/**
 * The content of the first file entry of the tar archive `archive` (its bytes), when that entry is a regular
 * file (typeflag `0` or NUL) with the name `options.name` and at most `options.maxBytes` bytes, and the archive holds all
 * of its data. One PAX extended header (typeflag `x`, at most MAX_PAX_HEADER_BYTES) before it is read: its `path`
 * stands for the name, its `size` must repeat that of the header, and its other records (extended attributes, times)
 * change nothing. Undefined for anything else: a link (typeflag `1` or `2`), a folder, a GNU or global extended header,
 * a PAX header with a `linkpath` or `GNU.sparse.*` record, malformed records, or another `path` or `size`, a header
 * whose checksum does not match, an invalid size, a name with a prefix, or an archive that ends early.
 */
export function firstTarFile(archive: Buffer, options: TarFileOptions): Buffer | undefined {
  let offset = 0;
  let pax: Map<string, string> | undefined;
  let header = headerAt(archive, offset);
  if (header === undefined) return undefined;
  if (header[156] === 0x78) {
    const recordsSize = octal(header, 124, 12);
    if (recordsSize === undefined || recordsSize > MAX_PAX_HEADER_BYTES) return undefined;
    if (archive.length < TAR_BLOCK_BYTES + recordsSize) return undefined;
    pax = paxRecords(archive.subarray(TAR_BLOCK_BYTES, TAR_BLOCK_BYTES + recordsSize));
    if (pax === undefined || [...pax.keys()].some((key) => PAX_REFUSED_KEYS.test(key))) return undefined;
    offset = entryBytes(recordsSize);
    header = headerAt(archive, offset);
    if (header === undefined) return undefined;
  }
  const typeflag = header[156];
  if (typeflag !== 0x30 && typeflag !== 0) return undefined;
  // The name, without a ustar prefix (the engine names the entry with the base name of the path); a PAX `path` takes
  // the place of both.
  const paxPath = pax?.get('path');
  if (paxPath === undefined) {
    const magic = header.subarray(257, 262).toString('latin1');
    if (magic === 'ustar' && field(header, 345, 155) !== '') return undefined;
    if (field(header, 0, 100) !== options.name) return undefined;
  } else if (paxPath !== options.name) return undefined;
  // A PAX `size` must repeat the size of the header, so the data ends where the header says.
  const size = octal(header, 124, 12);
  if (size === undefined || size > options.maxBytes) return undefined;
  const paxSize = pax?.get('size');
  if (paxSize !== undefined && paxSize !== String(size)) return undefined;
  const data = offset + TAR_BLOCK_BYTES;
  if (archive.length < data + size) return undefined;
  return archive.subarray(data, data + size);
}

/**
 * The longest answer of the archive endpoint for one file of at most `maxBytes` bytes: an optional PAX header with its
 * records, the header of the file, its data padded to whole blocks, and the two empty blocks of the end.
 */
export function maxTarFileArchiveBytes(maxBytes: number): number {
  return entryBytes(MAX_PAX_HEADER_BYTES) + entryBytes(maxBytes) + 2 * TAR_BLOCK_BYTES;
}
