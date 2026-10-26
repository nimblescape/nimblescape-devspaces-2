// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../ports';
import { DockerEngineRecords } from './dockerEngineRecords';

const NOW = Date.parse('2026-10-16T08:00:00.000Z');

let dir: string;
let records: DockerEngineRecords;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-engines-'));
  records = new DockerEngineRecords(path.join(dir, 'docker-engines.json'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const realReadFile = fs.promises.readFile;

/** The next `times` reads of the file fail with the error `code`, as when another process holds it (Windows). */
function failReads(code: string, times = Number.POSITIVE_INFINITY): void {
  let left = times;
  vi.spyOn(fs.promises, 'readFile').mockImplementation((async (file: fs.PathLike, options?: unknown) => {
    if (file === records.file && left-- > 0) throw Object.assign(new Error(`${code}: the file is in use, read '${records.file}'`), { code });
    return realReadFile.call(fs.promises, file, options as BufferEncoding);
  }) as typeof fs.promises.readFile);
}

/** Two engines with records: the local Docker with its answer, build-box with the removal mark. */
const TWO_ENGINES = { engines: [{ host: '', monitorAnsweredAt: NOW }, { host: 'build-box', removedAt: NOW }] };

describe('DockerEngineRecords: the answer to the question about the Monitor', () => {
  it('knows no answer without a file, and records one per engine (the local Docker is the host "")', async () => {
    expect(await records.monitorAnswered('')).toBe(false);
    await records.recordMonitorAnswer('', NOW);
    expect(await records.monitorAnswered('')).toBe(true);
    expect(await records.monitorAnswered('build-box')).toBe(false);
    await records.recordMonitorAnswer('build-box', NOW + 1);
    // A second answer keeps one entry per host.
    await records.recordMonitorAnswer('', NOW + 2);
    expect(await records.read()).toEqual([
      { host: 'build-box', monitorAnsweredAt: NOW + 1 },
      { host: '', monitorAnsweredAt: NOW + 2 },
    ]);
    expect(JSON.parse(fs.readFileSync(records.file, 'utf8'))).toEqual({ engines: await records.read() });
  });

  it('a file that is not valid, or entries that are not, count as no answer', async () => {
    fs.writeFileSync(records.file, '{ not json');
    expect(await records.monitorAnswered('')).toBe(false);
    fs.writeFileSync(
      records.file,
      JSON.stringify({
        engines: [
          { host: 'a', monitorAnsweredAt: -1 },
          { host: 'b', monitorAnsweredAt: '2026' },
          { host: 3, monitorAnsweredAt: NOW },
          { host: 'c' },
          'd',
          { host: 'e', monitorAnsweredAt: NOW },
          { host: 'e', monitorAnsweredAt: NOW + 5 },
        ],
      }),
    );
    expect(await records.read()).toEqual([{ host: 'e', monitorAnsweredAt: NOW }]);
    for (const host of ['a', 'b', 'c', 'd', '3']) expect(await records.monitorAnswered(host), host).toBe(false);
    // A write keeps the valid entries only.
    await records.recordMonitorAnswer('a', NOW);
    expect(await records.read()).toEqual([
      { host: 'e', monitorAnsweredAt: NOW },
      { host: 'a', monitorAnsweredAt: NOW },
    ]);
  });

  it('a folder in place of the file cannot be read: the reads and the writes fail', async () => {
    fs.mkdirSync(records.file);
    await expect(records.monitorAnswered('')).rejects.toThrow();
    await expect(records.removed('')).rejects.toThrow();
    await expect(records.recordMonitorAnswer('', NOW)).rejects.toThrow();
    await expect(records.setRemoved('', NOW)).rejects.toThrow();
  });
});

describe('DockerEngineRecords: a file that cannot be read, or is not valid', () => {
  it('a read error of a moment (EBUSY, a virus scanner on Windows) is tried again: a change loses no record of another engine', async () => {
    fs.writeFileSync(records.file, JSON.stringify(TWO_ENGINES));
    failReads('EBUSY', 1);
    await records.recordMonitorAnswer('other', NOW + 1);
    expect(await records.read()).toEqual([...TWO_ENGINES.engines, { host: 'other', monitorAnsweredAt: NOW + 1 }]);
    // The plain reads are tried again too: the mark and the answer stay visible.
    failReads('EPERM', 1);
    expect(await records.removed('build-box')).toBe(true);
    failReads('EBUSY', 1);
    expect(await records.monitorAnswered('')).toBe(true);
  });

  // On Windows, a virus scanner can hold the file for a moment when the rename writes over it. Mutation: a write without
  // the retries fails the change, and the mark is not written.
  it('a write error of a moment (EPERM on the rename, Windows) is tried again: the change is written', async () => {
    fs.writeFileSync(records.file, JSON.stringify(TWO_ENGINES));
    const realRename = fs.promises.rename;
    const renames: string[] = [];
    vi.spyOn(fs.promises, 'rename').mockImplementation((async (from: fs.PathLike, to: fs.PathLike) => {
      if (to === records.file) {
        renames.push(String(to));
        if (renames.length === 1) throw Object.assign(new Error(`EPERM: operation not permitted, rename '${String(from)}' -> '${String(to)}'`), { code: 'EPERM' });
      }
      return realRename.call(fs.promises, from, to);
    }) as typeof fs.promises.rename);
    await records.setRemoved('other', NOW + 1);
    expect(renames).toHaveLength(2);
    vi.restoreAllMocks();
    expect(await records.read()).toEqual([...TWO_ENGINES.engines, { host: 'other', removedAt: NOW + 1 }]);
    expect(fs.readdirSync(dir).sort()).toEqual(['docker-engines.json']);
  });

  it('a read error that stays fails the change, and the file stays as it was; the plain reads fail too', async () => {
    const before = JSON.stringify(TWO_ENGINES);
    fs.writeFileSync(records.file, before);
    failReads('EIO');
    await expect(records.recordMonitorAnswer('other', NOW + 1)).rejects.toThrow('EIO');
    await expect(records.setRemoved('', NOW + 1)).rejects.toThrow('EIO');
    // A transient error that does not end in time fails as well.
    vi.restoreAllMocks();
    failReads('EBUSY');
    await expect(records.setRemoved('build-box', undefined)).rejects.toThrow('EBUSY');
    await expect(records.removed('build-box')).rejects.toThrow('EBUSY');
    vi.restoreAllMocks();
    expect(fs.readFileSync(records.file, 'utf8')).toBe(before);
    expect(fs.existsSync(records.lockDir)).toBe(false);
  });

  it('a file that is not valid knows no engine; a change keeps a copy of it first, with a warning', async () => {
    const warn = vi.fn();
    const logged = new DockerEngineRecords(records.file, { logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() } as unknown as Logger });
    fs.writeFileSync(records.file, '{ "engines": [{ "host": "build-box", "removedAt": 17');
    expect(await logged.removed('build-box')).toBe(false);
    await logged.setRemoved('', NOW);
    expect(await logged.read()).toEqual([{ host: '', removedAt: NOW }]);
    const copies = fs.readdirSync(dir).filter((name) => name.startsWith('docker-engines.json.backup-'));
    expect(copies).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, copies[0]), 'utf8')).toBe('{ "engines": [{ "host": "build-box", "removedAt": 17');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`A copy was saved as ${path.join(dir, copies[0])}.`));
    // A valid file needs no copy: also not one with entries that are not valid (they record nothing that counts).
    await logged.recordMonitorAnswer('', NOW + 1);
    expect(fs.readdirSync(dir).filter((name) => name.startsWith('docker-engines.json.backup-'))).toHaveLength(1);
  });
});

describe('DockerEngineRecords: the removal mark ("Remove Devspaces from This Docker Engine…")', () => {
  it('sets the mark per engine, forgets the answer of that engine with it, and clears it again', async () => {
    await records.recordMonitorAnswer('', NOW);
    await records.recordMonitorAnswer('build-box', NOW);
    expect(await records.removed('build-box')).toBe(false);
    await records.setRemoved('build-box', NOW + 10);
    expect(await records.removed('build-box')).toBe(true);
    // The next user-started flow on that engine asks about its Monitor again.
    expect(await records.monitorAnswered('build-box')).toBe(false);
    // The other engine keeps its answer and has no mark.
    expect(await records.removed('')).toBe(false);
    expect(await records.monitorAnswered('')).toBe(true);
    expect(await records.read()).toEqual([
      { host: '', monitorAnsweredAt: NOW },
      { host: 'build-box', removedAt: NOW + 10 },
    ]);
    // Cleared, the engine has nothing left to record.
    await records.setRemoved('build-box', undefined);
    expect(await records.removed('build-box')).toBe(false);
    expect(await records.read()).toEqual([{ host: '', monitorAnsweredAt: NOW }]);
  });

  it('clearing keeps an answer given after the mark; a mark of an engine without a record is written', async () => {
    await records.setRemoved('', NOW);
    await records.recordMonitorAnswer('', NOW + 1);
    expect(await records.read()).toEqual([{ host: '', removedAt: NOW, monitorAnsweredAt: NOW + 1 }]);
    await records.setRemoved('', undefined);
    expect(await records.read()).toEqual([{ host: '', monitorAnsweredAt: NOW + 1 }]);
    // Clearing an engine without a mark changes nothing.
    await records.setRemoved('other', undefined);
    expect(await records.read()).toEqual([{ host: '', monitorAnsweredAt: NOW + 1 }]);
  });

  it('an invalid mark counts as none, next to a valid answer', async () => {
    fs.writeFileSync(
      records.file,
      JSON.stringify({ engines: [{ host: 'a', removedAt: -5, monitorAnsweredAt: NOW }, { host: 'b', removedAt: 1.5 }, { host: 'c', removedAt: NOW }] }),
    );
    expect(await records.read()).toEqual([
      { host: 'a', monitorAnsweredAt: NOW },
      { host: 'c', removedAt: NOW },
    ]);
    expect(await records.removed('a')).toBe(false);
    expect(await records.removed('b')).toBe(false);
    expect(await records.removed('c')).toBe(true);
  });
});

describe('DockerEngineRecords: the removal that runs (the entry removing)', () => {
  const REMOVAL = { windowId: 'window-a', pid: 4100, since: '2026-10-16T08:00:00.000Z' };
  const OTHER = { windowId: 'window-b', pid: 4200, since: '2026-10-16T07:59:00.000Z' };
  const runs = () => true;
  const ended = () => false;
  /** The file of the records: each write replaces it (writeJsonAtomic renames a new file over it). */
  const inode = (): number => fs.statSync(records.file).ino;

  it('starts with the mark and the entry in one change, and ends with the mark kept', async () => {
    await records.recordMonitorAnswer('build-box', NOW - 5);
    await records.recordMonitorAnswer('', NOW - 5);
    const start = await records.startRemoval('build-box', REMOVAL, NOW, runs);
    expect(start).toEqual({ started: true, before: { host: 'build-box', monitorAnsweredAt: NOW - 5 } });
    // The mark forgets the answer, as setRemoved does; the other engine keeps its record.
    expect(await records.record('build-box')).toEqual({ host: 'build-box', removedAt: NOW, removing: REMOVAL });
    expect(await records.removing('build-box')).toEqual(REMOVAL);
    expect(await records.record('')).toEqual({ host: '', monitorAnsweredAt: NOW - 5 });
    await records.endRemoval('build-box', REMOVAL);
    expect(await records.record('build-box')).toEqual({ host: 'build-box', removedAt: NOW });
    expect(await records.removing('build-box')).toBeUndefined();
    expect(fs.existsSync(records.lockDir)).toBe(false);
  });

  it('a removal that stopped before it removed anything brings back the record from before', async () => {
    await records.recordMonitorAnswer('build-box', NOW - 5);
    const start = await records.startRemoval('build-box', REMOVAL, NOW, runs);
    if (!start.started) throw new Error('not started');
    await records.endRemoval('build-box', REMOVAL, start.before);
    expect(await records.read()).toEqual([{ host: 'build-box', monitorAnsweredAt: NOW - 5 }]);
    // An engine that had the mark keeps the mark from before; an answer given meanwhile (by a window for which the
    // removal does not run, such as its own) stays over the one from before. Mutation: the answer from before wins.
    await records.setRemoved('', NOW - 9);
    await records.recordMonitorAnswer('', NOW - 8);
    const again = await records.startRemoval('', REMOVAL, NOW, runs);
    if (!again.started) throw new Error('not started');
    expect(again.before).toEqual({ host: '', removedAt: NOW - 9, monitorAnsweredAt: NOW - 8 });
    expect(await records.recordMonitorAnswer('', NOW + 1, ended)).toEqual({ recorded: true });
    await records.endRemoval('', REMOVAL, again.before);
    expect(await records.record('')).toEqual({ host: '', removedAt: NOW - 9, monitorAnsweredAt: NOW + 1 });
    // Without an earlier record nothing is left.
    const fresh = await records.startRemoval('fresh', REMOVAL, NOW, runs);
    if (!fresh.started) throw new Error('not started');
    await records.endRemoval('fresh', REMOVAL, fresh.before);
    expect(await records.record('fresh')).toBeUndefined();
  });

  it('a second removal is refused while the first one runs, and takes over the entry of one that does not run anymore', async () => {
    await records.startRemoval('build-box', OTHER, NOW - 60_000, runs);
    const before = inode();
    expect(await records.startRemoval('build-box', REMOVAL, NOW, runs)).toEqual({ started: false, other: OTHER });
    expect(inode()).toBe(before);
    // The end of another removal writes nothing.
    await records.endRemoval('build-box', REMOVAL);
    expect(inode()).toBe(before);
    expect(await records.removing('build-box')).toEqual(OTHER);
    // Its window ended (the liveness rule of the busy marks says so): the new removal starts.
    expect(await records.startRemoval('build-box', REMOVAL, NOW, ended)).toEqual({ started: true, before: { host: 'build-box', removedAt: NOW - 60_000, removing: OTHER } });
    expect(await records.removing('build-box')).toEqual(REMOVAL);
    // A mark set meanwhile keeps the entry of the removal that runs.
    await records.setRemoved('build-box', NOW + 1);
    expect(await records.record('build-box')).toEqual({ host: 'build-box', removedAt: NOW + 1, removing: REMOVAL });
  });

  it('a flow of the user clears the mark only while no removal runs, and clears the entry of one that ended', async () => {
    await records.startRemoval('build-box', OTHER, NOW, runs);
    const before = inode();
    expect(await records.clearRemoved('build-box', runs)).toEqual({ cleared: false, other: OTHER });
    expect(inode()).toBe(before);
    expect(await records.removed('build-box')).toBe(true);
    // The window of that removal crashed: the mark and its entry go.
    expect(await records.clearRemoved('build-box', ended)).toEqual({ cleared: true });
    expect(await records.record('build-box')).toBeUndefined();
    // Without a mark nothing is written; an answer stays.
    await records.recordMonitorAnswer('', NOW);
    const written = inode();
    expect(await records.clearRemoved('', runs)).toEqual({ cleared: false });
    expect(inode()).toBe(written);
    expect(await records.record('')).toEqual({ host: '', monitorAnsweredAt: NOW });
  });

  // The mark of a removal forgets the answer of the engine, so the next flow of the user there asks again. Mutation: an
  // answer written while the removal runs outlives it.
  it('writes no answer while a removal runs; the answer of a window whose removal ended is written', async () => {
    await records.startRemoval('build-box', OTHER, NOW, runs);
    const before = inode();
    expect(await records.recordMonitorAnswer('build-box', NOW + 1, runs)).toEqual({ recorded: false, other: OTHER });
    // Without the rule, every removal that the record names counts as running.
    expect(await records.recordMonitorAnswer('build-box', NOW + 1)).toEqual({ recorded: false, other: OTHER });
    expect(inode()).toBe(before);
    // The end of that removal keeps the mark, and no answer.
    await records.endRemoval('build-box', OTHER);
    expect(await records.monitorAnswered('build-box')).toBe(false);
    expect(await records.recordMonitorAnswer('build-box', NOW + 2, runs)).toEqual({ recorded: true });
    expect(await records.record('build-box')).toEqual({ host: 'build-box', removedAt: NOW, monitorAnsweredAt: NOW + 2 });
    // The entry of a removal whose window ended keeps no answer away.
    await records.startRemoval('', OTHER, NOW, runs);
    expect(await records.recordMonitorAnswer('', NOW + 3, ended)).toEqual({ recorded: true });
    expect(await records.record('')).toEqual({ host: '', removedAt: NOW, removing: OTHER, monitorAnsweredAt: NOW + 3 });
  });

  it('an entry that is not valid counts as none; a valid one alone is kept', async () => {
    fs.writeFileSync(
      records.file,
      JSON.stringify({
        engines: [
          { host: 'a', removedAt: NOW, removing: { windowId: '', pid: 1, since: 'x' } },
          { host: 'b', removedAt: NOW, removing: { windowId: 'w', pid: 0, since: 'x' } },
          { host: 'c', removedAt: NOW, removing: { windowId: 'w', pid: 1.5, since: 'x' } },
          { host: 'd', removedAt: NOW, removing: { windowId: 'w', pid: 7 } },
          { host: 'e', removing: 'window-a' },
          { host: 'f', removing: REMOVAL },
        ],
      }),
    );
    expect(await records.read()).toEqual([
      { host: 'a', removedAt: NOW },
      { host: 'b', removedAt: NOW },
      { host: 'c', removedAt: NOW },
      { host: 'd', removedAt: NOW },
      { host: 'f', removing: REMOVAL },
    ]);
  });
});

describe('DockerEngineRecords: the lock folder docker-engines.lock (several windows)', () => {
  it('keeps the change of every window when two windows change the file at once, and removes the lock folder after', async () => {
    const otherWindow = new DockerEngineRecords(records.file);
    const hosts = Array.from({ length: 12 }, (_, index) => `host-${index}`);
    await Promise.all(
      hosts.map((host, index) =>
        index % 2 === 0 ? records.setRemoved(host, NOW + index) : otherWindow.recordMonitorAnswer(host, NOW + index),
      ),
    );
    const read = await records.read();
    expect(read.map((record) => record.host).sort()).toEqual([...hosts].sort());
    // The removal marks are all there.
    for (const [index, host] of hosts.entries()) expect(await otherWindow.removed(host), host).toBe(index % 2 === 0);
    expect(records.lockDir).toBe(path.join(dir, 'docker-engines.lock'));
    expect(fs.existsSync(records.lockDir)).toBe(false);
  });

  it('waits while another window holds the lock, and takes over the lock of a window that crashed', async () => {
    fs.mkdirSync(records.lockDir);
    let written = false;
    const change = records.setRemoved('', NOW).then(() => {
      written = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(written).toBe(false);
    expect(await records.removed('')).toBe(false);
    // The other window ends its change.
    fs.rmdirSync(records.lockDir);
    await change;
    expect(await records.removed('')).toBe(true);
    expect(fs.existsSync(records.lockDir)).toBe(false);
    // A lock folder older than the stale time is the lock of a window that crashed: the change takes it over.
    fs.mkdirSync(records.lockDir);
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(records.lockDir, past, past);
    await records.setRemoved('', undefined);
    expect(await records.removed('')).toBe(false);
    expect(fs.existsSync(records.lockDir)).toBe(false);
  });

  it('a change fails, and writes nothing, when the lock stays held longer than the wait', async () => {
    const quick = new DockerEngineRecords(records.file, { lockTimeoutMs: 100 });
    fs.mkdirSync(quick.lockDir);
    await expect(quick.setRemoved('', NOW)).rejects.toThrow(/Timeout while waiting for the lock/);
    expect(fs.existsSync(records.file)).toBe(false);
    // The lock of the other window stays.
    expect(fs.existsSync(quick.lockDir)).toBe(true);
  });

  // The token of the lock folder (withLockFolder), as for registry.json. The heartbeat of the first window runs every 15
  // seconds only, so its lock folder gets old as that of a window that stalls (for example while the computer sleeps);
  // the second window takes a folder older than 100 ms for stale.
  describe('a window that stalls while it holds the lock', () => {
    const OLD_BOX = { host: 'old-box', monitorAnsweredAt: NOW - 1 };
    const until = async (condition: () => boolean): Promise<void> => {
      while (!condition()) await new Promise((resolve) => setTimeout(resolve, 10));
    };
    const temporaryFiles = () => fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
    let warnings: string[];
    let first: DockerEngineRecords;
    let second: DockerEngineRecords;

    beforeEach(() => {
      fs.writeFileSync(records.file, JSON.stringify({ engines: [OLD_BOX] }));
      warnings = [];
      const logger = { info: () => {}, warn: (text: string) => void warnings.push(text), error: () => {}, output: () => {} } as unknown as Logger;
      first = new DockerEngineRecords(records.file, { lockStaleMs: 60_000, lockTimeoutMs: 5_000, logger });
      second = new DockerEngineRecords(records.file, { lockStaleMs: 100, lockTimeoutMs: 5_000 });
    });

    // Mutation: a change without the checks of the token writes its old copy, and the answer of the second window is
    // lost.
    it('writes nothing over the change of the window that took the lock over, and runs its change again', async () => {
      // The first window read the file under its lock, and stalls before it uses what it read.
      let stalled = false;
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => (release = resolve));
      vi.spyOn(fs.promises, 'readFile').mockImplementation((async (file: fs.PathLike, options?: unknown) => {
        const text = await realReadFile.call(fs.promises, file, options as BufferEncoding);
        if (file === records.file && !stalled) {
          stalled = true;
          await released;
        }
        return text;
      }) as typeof fs.promises.readFile);
      const removal = first.setRemoved('build-box', NOW);
      await until(() => stalled);
      await second.recordMonitorAnswer('', NOW);
      release();
      await removal;
      expect(await records.read()).toEqual([OLD_BOX, { host: '', monitorAnsweredAt: NOW }, { host: 'build-box', removedAt: NOW }]);
      expect(warnings).toEqual([expect.stringContaining('Another process took over the lock')]);
      expect(fs.existsSync(records.lockDir)).toBe(false);
    });

    // Mutation: a write without the check right before the rename writes its old copy.
    it('checks the lock again right before the rename: a takeover while the temporary file is written writes nothing', async () => {
      // The first window stalls right after it wrote its temporary file, after its first check of the token.
      const realWriteFile = fs.promises.writeFile;
      let stalled = false;
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => (release = resolve));
      vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (file, data, options) => {
        await realWriteFile(file, data, options);
        if (!stalled && typeof file === 'string' && path.basename(file).startsWith('.docker-engines.json.')) {
          stalled = true;
          await released;
        }
      });
      const removal = first.setRemoved('build-box', NOW);
      await until(() => stalled);
      expect(temporaryFiles()).toHaveLength(1);
      await second.recordMonitorAnswer('', NOW);
      release();
      await removal;
      expect(await records.read()).toEqual([OLD_BOX, { host: '', monitorAnsweredAt: NOW }, { host: 'build-box', removedAt: NOW }]);
      expect(warnings).toEqual([expect.stringContaining('Another process took over the lock')]);
      expect(temporaryFiles()).toEqual([]);
      expect(fs.existsSync(records.lockDir)).toBe(false);
    });

    // The window that took the lock over kept the copy of the file that is not valid, and wrote a valid one. Mutation:
    // without the check of the token before the copy, the stalled window keeps a copy of that valid file, and warns that
    // the records were not valid.
    it('a window that lost the lock keeps no copy of a file that was not valid: the window that took the lock over keeps it', async () => {
      const invalid = '{ "engines": [{ "host": "build-box", "removedAt": 17';
      fs.writeFileSync(records.file, invalid);
      let stalled = false;
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => (release = resolve));
      vi.spyOn(fs.promises, 'readFile').mockImplementation((async (file: fs.PathLike, options?: unknown) => {
        const text = await realReadFile.call(fs.promises, file, options as BufferEncoding);
        if (file === records.file && !stalled) {
          stalled = true;
          await released;
        }
        return text;
      }) as typeof fs.promises.readFile);
      const copies = () => fs.readdirSync(dir).filter((name) => name.startsWith('docker-engines.json.backup-'));
      const removal = first.setRemoved('build-box', NOW);
      await until(() => stalled);
      await second.recordMonitorAnswer('', NOW);
      expect(copies()).toHaveLength(1);
      release();
      await removal;
      expect(await records.read()).toEqual([{ host: '', monitorAnsweredAt: NOW }, { host: 'build-box', removedAt: NOW }]);
      expect(copies()).toHaveLength(1);
      expect(fs.readFileSync(path.join(dir, copies()[0]), 'utf8')).toBe(invalid);
      expect(warnings).toEqual([expect.stringContaining('Another process took over the lock')]);
    });

    // The outcome of the second run counts: here the other window cleared the mark meanwhile.
    it('says from the run after a lost lock whether it cleared the mark', async () => {
      fs.writeFileSync(records.file, JSON.stringify({ engines: [OLD_BOX, { host: 'build-box', removedAt: NOW - 1 }] }));
      let stalled = false;
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => (release = resolve));
      vi.spyOn(fs.promises, 'readFile').mockImplementation((async (file: fs.PathLike, options?: unknown) => {
        const text = await realReadFile.call(fs.promises, file, options as BufferEncoding);
        if (file === records.file && !stalled) {
          stalled = true;
          await released;
        }
        return text;
      }) as typeof fs.promises.readFile);
      const clearing = first.clearRemoved('build-box', () => true);
      await until(() => stalled);
      await expect(second.clearRemoved('build-box', () => true)).resolves.toEqual({ cleared: true });
      release();
      await expect(clearing).resolves.toEqual({ cleared: false });
      expect(await records.read()).toEqual([OLD_BOX]);
      expect(warnings).toEqual([expect.stringContaining('Another process took over the lock')]);
    });
  });
});
