// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The sweep of the storage folder by the windows (R6 to R9).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { atomicTemporaryPath, writeJsonAtomic } from './atomicJson';
import { StoragePaths } from './paths';
import {
  ATOMIC_TEMPORARY_FILE,
  STALE_DISCONNECT_MAX_AGE_MS,
  STALE_PENDING_MAX_AGE_MS,
  STALE_TEMPORARY_MAX_AGE_MS,
  sweepStorage,
  unlinkSame,
} from './storageSweep';

const ENV_A = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const ENV_B = '7c1d2e3f-0000-4000-8000-000000000002';
const ENV_C = '7c1d2e3f-0000-4000-8000-000000000003';
const WINDOW = 'b7c1d2e3-0000-4000-8000-000000000001';
const T0 = Date.parse('2026-09-29T12:00:00.000Z');
const MINUTE = 60_000;

let root: string;
let paths: StoragePaths;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-sweep-'));
  paths = new StoragePaths(root);
  paths.ensureDirectoriesSync();
  fs.mkdirSync(paths.disconnectDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Writes a file with the modification time `mtime`. */
function write(file: string, text: string, mtime = T0): void {
  fs.writeFileSync(file, text);
  fs.utimesSync(file, mtime / 1000, mtime / 1000);
}

function pending(devspaceId: string, createdAt: number): string {
  return JSON.stringify({ devspaceId, windowId: WINDOW, createdAt: new Date(createdAt).toISOString() });
}

function request(devspaceId: string, requestedAt: number): string {
  return JSON.stringify({ devspaceId, operation: 'stop', requestedAt: new Date(requestedAt).toISOString(), requestedBy: WINDOW, reason: 'manual' });
}

function names(dir: string): string[] {
  return fs.readdirSync(dir).sort();
}

describe('sweepStorage', () => {
  it('R6: removes pending connection files more than an hour from now, both ways, and keeps younger ones', async () => {
    write(paths.pendingFile(ENV_A), pending(ENV_A, T0 - STALE_PENDING_MAX_AGE_MS - 1));
    write(paths.pendingFile(ENV_B), pending(ENV_B, T0 + STALE_PENDING_MAX_AGE_MS + 1));
    write(paths.pendingFile(ENV_C), pending(ENV_C, T0 - STALE_PENDING_MAX_AGE_MS));
    const removed = await sweepStorage(paths, T0);
    expect(removed.pending.sort()).toEqual([path.join('pending', `${ENV_A}.json`), path.join('pending', `${ENV_B}.json`)].sort());
    expect(names(paths.pendingDir)).toEqual([`${ENV_C}.json`]);
  });

  it('R6: a pending file without a valid time counts by its modification time; other names are left alone', async () => {
    write(paths.pendingFile(ENV_A), '{ broken', T0 - 2 * STALE_PENDING_MAX_AGE_MS);
    write(paths.pendingFile(ENV_B), '{ broken', T0 - MINUTE);
    write(path.join(paths.pendingDir, 'notes.txt'), 'x', T0 - 48 * 60 * MINUTE);
    write(path.join(paths.pendingDir, 'a.b.json'), pending(ENV_C, 0), T0 - 48 * 60 * MINUTE);
    await sweepStorage(paths, T0);
    expect(names(paths.pendingDir)).toEqual([`${ENV_B}.json`, 'a.b.json', 'notes.txt']);
  });

  // A file larger than 64 KB (MAX_READ_BYTES) is not read, so its modification time decides, not the time in it: both
  // ways.
  it('R6: a pending file larger than 64 KB counts by its modification time, whatever its createdAt', async () => {
    const large = (devspaceId: string, createdAt: number) => `${pending(devspaceId, createdAt).slice(0, -1)},"padding":"${'x'.repeat(64 * 1024)}"}`;
    write(paths.pendingFile(ENV_A), large(ENV_A, T0 - MINUTE), T0 - 2 * STALE_PENDING_MAX_AGE_MS);
    write(paths.pendingFile(ENV_B), large(ENV_B, T0 - 2 * STALE_PENDING_MAX_AGE_MS), T0 - MINUTE);
    expect(fs.statSync(paths.pendingFile(ENV_A)).size).toBeGreaterThan(64 * 1024);
    const removed = await sweepStorage(paths, T0);
    expect(removed.pending).toEqual([path.join('pending', `${ENV_A}.json`)]);
    expect(names(paths.pendingDir)).toEqual([`${ENV_B}.json`]);
  });

  it('R7: removes disconnect requests older than 10 minutes and keeps younger ones', async () => {
    write(paths.disconnectFile(ENV_A), request(ENV_A, T0 - STALE_DISCONNECT_MAX_AGE_MS - 1));
    write(paths.disconnectFile(ENV_B), request(ENV_B, T0 - STALE_DISCONNECT_MAX_AGE_MS));
    write(paths.disconnectFile(ENV_C), request(ENV_C, T0 + STALE_DISCONNECT_MAX_AGE_MS + 1));
    const removed = await sweepStorage(paths, T0);
    expect(removed.disconnect.sort()).toEqual([path.join('disconnect', `${ENV_A}.json`), path.join('disconnect', `${ENV_C}.json`)].sort());
    expect(names(paths.disconnectDir)).toEqual([`${ENV_B}.json`]);
  });

  it('R8: removes the temporary files of writeJsonAtomic older than an hour in the storage folders, and nothing else', async () => {
    const old = T0 - STALE_TEMPORARY_MAX_AGE_MS - MINUTE;
    const young = T0 - STALE_TEMPORARY_MAX_AGE_MS + MINUTE;
    const temp = (dir: string, name: string, hex: string) => path.join(dir, `.${name}.1234.${hex}.tmp`);
    for (const dir of [paths.root, paths.sessionsDir, paths.pendingDir, paths.operationsDir, paths.disconnectDir]) {
      write(temp(dir, 'x.json', '0123abcd'), '{}', old);
      write(temp(dir, 'y.json', '89abcdef'), '{}', young);
    }
    // Not of writeJsonAtomic: kept whatever their age.
    write(path.join(paths.root, '.x.json.1234.ABCDEF01.tmp'), '{}', old);
    write(path.join(paths.root, 'x.json.1234.0123abcd.tmp'), '{}', old);
    write(path.join(paths.root, 'registry.json'), '{}', old);
    // The marker of the first use (firstUse.ts) is kept, whatever its age.
    write(paths.usedMarker, '', old);
    // Names that only resemble a temporary file (a suffix, a pid that is not a number, nine or seven hex digits) are
    // kept, so the pattern stays anchored and exact.
    const nearMisses = ['.x.json.1234.0123abcd.tmp.keep', '.x.json.12a.0123abcd.tmp', '.x.json.1234.0123abcd0.tmp', '.x.json.1234.0123abc.tmp'];
    for (const name of nearMisses) write(path.join(paths.root, name), '{}', old);
    // In another folder: not swept.
    fs.mkdirSync(path.join(root, 'other'));
    write(temp(path.join(root, 'other'), 'x.json', '0123abcd'), '{}', old);
    const removed = await sweepStorage(paths, T0);
    expect(removed.temporary).toHaveLength(5);
    for (const dir of [paths.sessionsDir, paths.pendingDir, paths.operationsDir, paths.disconnectDir]) {
      expect(names(dir)).toEqual(['.y.json.1234.89abcdef.tmp']);
    }
    expect(names(paths.root)).toContain('.x.json.1234.ABCDEF01.tmp');
    expect(names(paths.root)).toContain('x.json.1234.0123abcd.tmp');
    expect(names(paths.root)).toContain('registry.json');
    expect(names(paths.root)).toContain('used');
    for (const name of nearMisses) expect(names(paths.root)).toContain(name);
    expect(names(paths.root)).not.toContain('.x.json.1234.0123abcd.tmp');
    expect(names(path.join(root, 'other'))).toEqual(['.x.json.1234.0123abcd.tmp']);
  });

  // The absolute age, so a temporary file with a time in the future (a clock that was ahead) is removed too.
  it('R8: removes a temporary file whose modification time is more than an hour in the future', async () => {
    const file = path.join(paths.sessionsDir, '.x.json.1234.0123abcd.tmp');
    write(file, '{}', T0 + 2 * STALE_TEMPORARY_MAX_AGE_MS);
    expect((await sweepStorage(paths, T0)).temporary).toEqual([path.join('sessions', '.x.json.1234.0123abcd.tmp')]);
    expect(fs.existsSync(file)).toBe(false);
  });

  // The cut of an old monitor.log named its temporary file as writeJsonAtomic does, in the storage folder, so one that
  // a killed cut left behind is removed too. monitor.log itself stays.
  it('R8: removes an old temporary file of the cut of monitor.log in the storage folder', async () => {
    const file = path.join(paths.root, '.monitor.log.1.0123abcd.tmp');
    write(file, 'x', T0 - STALE_TEMPORARY_MAX_AGE_MS - MINUTE);
    write(path.join(paths.root, 'monitor.log'), 'x', T0 - STALE_TEMPORARY_MAX_AGE_MS - MINUTE);
    expect((await sweepStorage(paths, T0)).temporary).toEqual(['.monitor.log.1.0123abcd.tmp']);
    expect(names(paths.root)).not.toContain('.monitor.log.1.0123abcd.tmp');
    expect(names(paths.root)).toContain('monitor.log');
  });

  // A file that a window replaced after the sweep looked at it stays.
  describe('unlinkSame', () => {
    it('removes the file of the stat', async () => {
      const file = paths.pendingFile(ENV_A);
      write(file, '{}');
      expect(await unlinkSame(file, fs.lstatSync(file))).toBe(true);
      expect(fs.existsSync(file)).toBe(false);
    });

    it('keeps a file that a rename replaced meanwhile, with the same modification time', async () => {
      const file = paths.pendingFile(ENV_A);
      write(file, '{}');
      const seen = fs.lstatSync(file);
      const replacement = path.join(paths.pendingDir, 'replacement');
      write(replacement, '{"new":1}');
      fs.renameSync(replacement, file);
      expect(fs.lstatSync(file).ino).not.toBe(seen.ino);
      expect(fs.lstatSync(file).mtimeMs).toBe(seen.mtimeMs);
      expect(await unlinkSame(file, seen)).toBe(false);
      expect(fs.readFileSync(file, 'utf8')).toBe('{"new":1}');
    });

    it('keeps a file that was written again in place meanwhile', async () => {
      const file = paths.pendingFile(ENV_A);
      write(file, '{}');
      const seen = fs.lstatSync(file);
      write(file, '{"new":1}', T0 + MINUTE);
      expect(fs.lstatSync(file).ino).toBe(seen.ino);
      expect(await unlinkSame(file, seen)).toBe(false);
      expect(fs.existsSync(file)).toBe(true);
    });

    it('removes nothing that is gone now', async () => {
      const file = paths.pendingFile(ENV_A);
      write(file, '{}');
      const seen = fs.lstatSync(file);
      fs.rmSync(file);
      expect(await unlinkSame(file, seen)).toBe(false);
    });
  });

  it('R8: the pattern matches the names that writeJsonAtomic makes', async () => {
    const spy = vi.spyOn(fs.promises, 'writeFile');
    try {
      await writeJsonAtomic(path.join(paths.pendingDir, `${ENV_A}.json`), { a: 1 });
      const written = spy.mock.calls.map((call) => path.basename(String(call[0])));
      expect(written).toHaveLength(1);
      expect(written[0]).toMatch(ATOMIC_TEMPORARY_FILE);
    } finally {
      spy.mockRestore();
    }
  });

  // All atomic writers name their temporary file with atomicTemporaryPath.
  it('R8: the pattern matches the names of atomicTemporaryPath', () => {
    for (const file of [paths.pendingFile(ENV_A), path.join(paths.root, 'monitor.log'), path.join(paths.root, 'computer.id'), path.join(paths.sessionsDir, 'w.json')]) {
      const temp = atomicTemporaryPath(file);
      expect(path.dirname(temp)).toBe(path.dirname(file));
      expect(path.basename(temp).startsWith(`.${path.basename(file)}.${process.pid}.`)).toBe(true);
      expect(path.basename(temp)).toMatch(ATOMIC_TEMPORARY_FILE);
    }
  });

  it('never removes a link or what it points to, nor a folder, and does not enter a folder that is a link', async () => {
    const old = T0 - 48 * 60 * MINUTE;
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-sweep-outside-'));
    try {
      const target = path.join(outside, 'target.json');
      write(target, pending(ENV_A, 0), old);
      fs.symlinkSync(target, paths.pendingFile(ENV_A));
      fs.symlinkSync(target, path.join(paths.root, '.x.json.1.0123abcd.tmp'));
      fs.mkdirSync(path.join(paths.sessionsDir, '.x.json.1.0123abcd.tmp'));
      write(path.join(outside, '.x.json.1.0123abcd.tmp'), '{}', old);
      fs.rmSync(paths.disconnectDir, { recursive: true });
      fs.symlinkSync(outside, paths.disconnectDir);
      // The links and the folder are as old as the files, so only the checks of a regular file and of a folder that is
      // a link keep them (with the time of the test run, the age rule alone would keep them in a run within an hour of
      // T0).
      for (const link of [paths.pendingFile(ENV_A), path.join(paths.root, '.x.json.1.0123abcd.tmp'), paths.disconnectDir]) fs.lutimesSync(link, old / 1000, old / 1000);
      fs.utimesSync(path.join(paths.sessionsDir, '.x.json.1.0123abcd.tmp'), old / 1000, old / 1000);
      const removed = await sweepStorage(paths, T0);
      expect(removed).toEqual({ pending: [], disconnect: [], temporary: [], checks: [] });
      expect(fs.existsSync(target)).toBe(true);
      expect(fs.existsSync(path.join(outside, '.x.json.1.0123abcd.tmp'))).toBe(true);
      expect(fs.lstatSync(paths.pendingFile(ENV_A)).isSymbolicLink()).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('ignores missing folders', async () => {
    const empty = new StoragePaths(path.join(root, 'missing'));
    expect(await sweepStorage(empty, T0)).toEqual({ pending: [], disconnect: [], temporary: [], checks: [] });
  });
});
