// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// One file out of a tar.gz or zip archive, on archives that the tests build in the forms that Docker's archives use.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractTarGzEntry, extractZipEntry } from './archive';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-archive-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

interface TarEntry {
  name: string;
  data?: Buffer;
  type?: string;
  /** `gnu` (`ustar  \0`, Docker's archives) or `posix` (`ustar\0` with the name prefix at 345). */
  format?: 'gnu' | 'posix';
  prefix?: string;
  /** Writes the size in base-256 (GNU), as for a file of 8 GiB or more. */
  binarySize?: boolean;
}

function tarHeader(entry: TarEntry, size: number): Buffer {
  const header = Buffer.alloc(512);
  header.write(entry.name, 0, 100, 'utf8');
  header.write('0000755\0', 100, 'latin1');
  if (entry.binarySize) {
    header[124] = 0x80;
    header.writeUInt32BE(size, 132);
  } else {
    header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  }
  header.write(entry.type ?? '0', 156, 'latin1');
  if (entry.format === 'posix') {
    header.write('ustar\0', 257, 'latin1');
    header.write('00', 263, 'latin1');
    if (entry.prefix) header.write(entry.prefix, 345, 155, 'utf8');
  } else {
    header.write('ustar  \0', 257, 'latin1');
  }
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return header;
}

function tarGz(entries: TarEntry[], end = true): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0);
    parts.push(tarHeader(entry, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  if (end) parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}

/** A pax record `<length> <key>=<value>\n`. */
function paxRecord(key: string, value: string): Buffer {
  const text = ` ${key}=${value}\n`;
  let length = text.length;
  while (`${length}${text}`.length !== length) length = `${length}${text}`.length;
  return Buffer.from(`${length}${text}`, 'utf8');
}

interface ZipEntry {
  name: string;
  data: Buffer;
  method?: 0 | 8;
  flags?: number;
}

function zip(entries: ZipEntry[], comment = ''): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const method = entry.method ?? 8;
    const compressed = method === 8 ? zlib.deflateRawSync(entry.data) : entry.data;
    const name = Buffer.from(entry.name, 'utf8');
    const crc = zlib.crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    // An extra field in the local header only, as some zip writers add: the data starts after it.
    const extra = Buffer.from([0x55, 0x54, 0x01, 0x00, 0x00]);
    local.writeUInt16LE(extra.length, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.flags ?? 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, extra, compressed);
    centrals.push(central, name);
    offset += local.length + name.length + extra.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(Buffer.byteLength(comment), 20);
  return Buffer.concat([...locals, directory, end, Buffer.from(comment)]);
}

function write(name: string, data: Buffer): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, data);
  return file;
}

const CLI = Buffer.from('#!/bin/sh\necho docker\n'.repeat(5_000));

describe('extractTarGzEntry', () => {
  it('writes the entry of Docker’s archive, a new file with mode 0755, after other entries of every size', async () => {
    const archive = write(
      'docker.tgz',
      tarGz([
        { name: 'docker/', type: '5' },
        { name: 'docker/containerd', data: Buffer.alloc(70_001, 1) },
        { name: 'docker/docker', data: CLI },
        { name: 'docker/dockerd', data: Buffer.alloc(512, 2) },
      ]),
    );
    const target = path.join(dir, 'docker');
    await extractTarGzEntry(archive, 'docker/docker', target, CLI.length);
    expect(fs.readFileSync(target)).toEqual(CLI);
    if (process.platform !== 'win32') expect(fs.statSync(target).mode & 0o777).toBe(0o755);
  });

  it('reads a GNU long name, a pax path, the POSIX prefix, a leading ./ and a size in base 256', async () => {
    const long = `${'x'.repeat(120)}/docker`;
    const cases: TarEntry[][] = [
      [{ name: '././@LongLink', type: 'L', data: Buffer.from(`${long}\0`) }, { name: long.slice(0, 99), data: CLI }],
      [{ name: 'PaxHeaders/docker', type: 'x', format: 'posix', data: Buffer.concat([paxRecord('mtime', '1'), paxRecord('path', long)]) }, { name: 'other', format: 'posix', data: CLI }],
      [{ name: 'docker', prefix: 'x'.repeat(120), format: 'posix', data: CLI }],
    ];
    for (const [index, entries] of cases.entries()) {
      const target = path.join(dir, `out-${index}`);
      await extractTarGzEntry(write(`long-${index}.tgz`, tarGz(entries)), long, target, CLI.length);
      expect(fs.readFileSync(target)).toEqual(CLI);
    }
    const dotted = path.join(dir, 'dotted');
    await extractTarGzEntry(write('dotted.tgz', tarGz([{ name: './docker/docker', data: CLI, binarySize: true }])), 'docker/docker', dotted, CLI.length);
    expect(fs.readFileSync(dotted)).toEqual(CLI);
  });

  it('refuses a missing entry, a link or folder of that name, a larger entry, an archive that ends in it, and an existing target', async () => {
    const target = path.join(dir, 'docker');
    await expect(extractTarGzEntry(write('a.tgz', tarGz([{ name: 'docker/dockerd', data: CLI }])), 'docker/docker', target, CLI.length)).rejects.toThrow('docker/docker is not in the archive');
    await expect(extractTarGzEntry(write('b.tgz', tarGz([{ name: 'docker/dockerd', data: CLI }], false)), 'docker/docker', target, CLI.length)).rejects.toThrow('is not in the archive');
    await expect(extractTarGzEntry(write('c.tgz', tarGz([{ name: 'docker/docker', type: '2' }, { name: 'docker/docker', type: '5' }])), 'docker/docker', target, CLI.length)).rejects.toThrow('is not in the archive');
    await expect(extractTarGzEntry(write('d.tgz', tarGz([{ name: 'docker/docker', data: CLI }])), 'docker/docker', target, CLI.length - 1)).rejects.toThrow('more than');
    expect(fs.existsSync(target)).toBe(false);
    const cut = zlib.gzipSync(zlib.gunzipSync(tarGz([{ name: 'docker/docker', data: CLI }])).subarray(0, 512 + 1_000));
    await expect(extractTarGzEntry(write('e.tgz', cut), 'docker/docker', target, CLI.length)).rejects.toThrow('ends in docker/docker');
    fs.rmSync(target, { force: true });
    fs.writeFileSync(target, 'kept');
    await expect(extractTarGzEntry(write('f.tgz', tarGz([{ name: 'docker/docker', data: CLI }])), 'docker/docker', target, CLI.length)).rejects.toThrow();
    expect(fs.readFileSync(target, 'utf8')).toBe('kept');
  });
});

describe('extractZipEntry', () => {
  it('writes a deflated or stored entry of Docker’s archive, also behind a comment, as a new file with mode 0755', async () => {
    for (const method of [8, 0] as const) {
      const archive = write(`docker-${method}.zip`, zip([{ name: 'docker/', data: Buffer.alloc(0), method: 0 }, { name: 'docker/docker.exe', data: CLI, method }, { name: 'docker/dockerd.exe', data: Buffer.alloc(9_000, 3) }], 'a comment'));
      const target = path.join(dir, `docker-${method}.exe`);
      await extractZipEntry(archive, 'docker/docker.exe', target, CLI.length);
      expect(fs.readFileSync(target)).toEqual(CLI);
      if (process.platform !== 'win32') expect(fs.statSync(target).mode & 0o777).toBe(0o755);
    }
    const empty = path.join(dir, 'empty');
    await extractZipEntry(write('empty.zip', zip([{ name: 'docker/docker.exe', data: Buffer.alloc(0), method: 0 }])), 'docker/docker.exe', empty, 10);
    expect(fs.readFileSync(empty)).toEqual(Buffer.alloc(0));
  });

  it('refuses no zip, a missing entry, an encrypted or larger entry, another method, a damaged entry, and an existing target', async () => {
    const target = path.join(dir, 'docker.exe');
    await expect(extractZipEntry(write('no.zip', Buffer.from('no zip archive')), 'docker/docker.exe', target, CLI.length)).rejects.toThrow('is no zip archive');
    await expect(extractZipEntry(write('a.zip', zip([{ name: 'docker/dockerd.exe', data: CLI }])), 'docker/docker.exe', target, CLI.length)).rejects.toThrow('is not in the archive');
    await expect(extractZipEntry(write('b.zip', zip([{ name: 'docker/docker.exe', data: CLI, flags: 1 }])), 'docker/docker.exe', target, CLI.length)).rejects.toThrow('is encrypted');
    await expect(extractZipEntry(write('c.zip', zip([{ name: 'docker/docker.exe', data: CLI }])), 'docker/docker.exe', target, CLI.length - 1)).rejects.toThrow('more than');
    const bzip = zip([{ name: 'docker/docker.exe', data: CLI, method: 0 }]);
    bzip.writeUInt16LE(12, bzip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 10);
    await expect(extractZipEntry(write('d.zip', bzip), 'docker/docker.exe', target, CLI.length)).rejects.toThrow('compression method 12');
    const damaged = zip([{ name: 'docker/docker.exe', data: CLI }]);
    damaged.writeUInt32LE(0, 0);
    await expect(extractZipEntry(write('e.zip', damaged), 'docker/docker.exe', target, CLI.length)).rejects.toThrow('is damaged');
    expect(fs.existsSync(target)).toBe(false);
    fs.writeFileSync(target, 'kept');
    await expect(extractZipEntry(write('f.zip', zip([{ name: 'docker/docker.exe', data: CLI }])), 'docker/docker.exe', target, CLI.length)).rejects.toThrow();
    expect(fs.readFileSync(target, 'utf8')).toBe('kept');
  });
});
