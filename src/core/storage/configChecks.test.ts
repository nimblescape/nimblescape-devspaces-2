// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The remembered check results in the extension's storage: checked strictly when stored and when read, stamped with the
// worker's code, removed with the devspace and by the sweep.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readRegistryAnswers } from '../worker/workerServices';
import { REGISTRY_ANSWERS_FILE } from '../remoteMonitor/registryAnswers';
import { ConfigCheckStore } from './configChecks';
import { MAX_CONFIG_CHECK_CHARACTERS, canonicalJson, parseConfigCheckEntry, type ConfigCheckEntry } from './configCheckEntry';
import { StoragePaths } from './paths';
import { STALE_CONFIG_CHECK_MIN_AGE_MS, sweepStorage } from './storageSweep';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const GONE = '7c1d2e3f-0000-4000-8000-000000000002';
const CODE = 'c'.repeat(64);
const ENTRY: ConfigCheckEntry = {
  key: 'a'.repeat(64),
  config: { image: 'node:20' },
  merged: { image: 'node:20', remoteUser: 'node' },
  analyses: [{ job: 'b'.repeat(64), result: { report: { hostAccess: [], unsupported: [] }, imageReferences: [], references: { images: ['node:20'], features: [] } } }],
};

let root: string;
let paths: StoragePaths;
let code: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-checks-'));
  paths = new StoragePaths(root);
  paths.ensureDirectoriesSync();
  code = CODE;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const store = () => new ConfigCheckStore(paths.configChecksDir, async () => code);

describe('the entry of a remembered check result', () => {
  it('canonicalJson takes plain JSON only and tells a missing key from an undefined one', () => {
    expect(canonicalJson({ a: 1, b: [true, null, 'x'] })).toBe('{"a":1,"b":[true,null,"x"]}');
    expect(canonicalJson({ a: undefined })).not.toBe(canonicalJson({}));
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const value of [cycle, { a: new Map() }, { a: () => 1 }, { a: Number.NaN }, { a: Symbol('x') }, { a: 1n }]) expect(() => canonicalJson(value)).toThrow();
  });

  it('parseConfigCheckEntry: only an entry of the exact shape whose analyses passed, rebuilt', () => {
    const parsed = parseConfigCheckEntry(JSON.parse(JSON.stringify(ENTRY)));
    expect(parsed).toEqual(ENTRY);
    const refused = { ...ENTRY.analyses[0], result: { ...ENTRY.analyses[0].result, report: { hostAccess: ['privileged'], unsupported: [] } } };
    for (const odd of [
      { ...ENTRY, extra: 1 },
      { ...ENTRY, key: 'A'.repeat(64) },
      { ...ENTRY, merged: 'x' },
      { ...ENTRY, analyses: [refused] },
      { ...ENTRY, analyses: [{ ...ENTRY.analyses[0], job: 'nope' }] },
      { ...ENTRY, analyses: [ENTRY.analyses[0], ENTRY.analyses[0], ENTRY.analyses[0]] },
      { ...ENTRY, config: { big: 'x'.repeat(MAX_CONFIG_CHECK_CHARACTERS) } },
      null,
    ]) {
      expect(parseConfigCheckEntry(odd)).toBeUndefined();
    }
  });
});

describe('ConfigCheckStore', () => {
  it('stores one entry per devspace and gives it back only for the same code of the worker', async () => {
    expect(await store().get(ID)).toBeUndefined();
    await store().set(ID, ENTRY);
    expect(await store().get(ID)).toEqual(ENTRY);
    await store().set(ID, { ...ENTRY, key: 'd'.repeat(64) });
    expect((await store().get(ID))?.key).toBe('d'.repeat(64));
    code = 'e'.repeat(64);
    expect(await store().get(ID)).toBeUndefined();
  });

  it('refuses an invalid entry and an invalid devspace ID; reads a damaged or linked file as none', async () => {
    await expect(store().set(ID, { ...ENTRY, key: 'x' })).rejects.toThrow();
    await expect(store().set('../x', ENTRY)).rejects.toThrow();
    const file = path.join(paths.configChecksDir, `${ID}.json`);
    fs.mkdirSync(paths.configChecksDir, { recursive: true });
    fs.writeFileSync(file, '{ not json');
    expect(await store().get(ID)).toBeUndefined();
    fs.writeFileSync(file, JSON.stringify({ code: CODE, entry: { ...ENTRY, extra: 1 } }));
    expect(await store().get(ID)).toBeUndefined();
    fs.rmSync(file);
    const target = path.join(root, 'elsewhere.json');
    fs.writeFileSync(target, JSON.stringify({ code: CODE, entry: ENTRY }));
    fs.symlinkSync(target, file);
    expect(await store().get(ID)).toBeUndefined();
  });

  it('removes the entry of a devspace; a missing one is no error', async () => {
    await store().set(ID, ENTRY);
    await store().remove(ID);
    expect(await store().get(ID)).toBeUndefined();
    await store().remove(ID);
  });

  it('the sweep removes old entries of devspaces that the registry does not have (R9), never with an unreadable registry', async () => {
    await store().set(ID, ENTRY);
    await store().set(GONE, ENTRY);
    const old = (Date.now() - STALE_CONFIG_CHECK_MIN_AGE_MS - 60_000) / 1000;
    for (const id of [ID, GONE]) fs.utimesSync(path.join(paths.configChecksDir, `${id}.json`), old, old);
    fs.writeFileSync(paths.registry, '{ broken');
    expect((await sweepStorage(paths, Date.now())).checks).toEqual([]);
    fs.writeFileSync(paths.registry, JSON.stringify({ version: 1, devspaces: [{ id: ID }] }));
    expect((await sweepStorage(paths, Date.now())).checks).toEqual([path.join('checks', `${GONE}.json`)]);
    expect(await store().get(ID)).toEqual(ENTRY);
    // A young entry of a devspace that the registry does not have (yet) stays.
    await store().set(GONE, ENTRY);
    expect((await sweepStorage(paths, Date.now())).checks).toEqual([]);
  });
});

describe("the worker's read of the Monitor's registry answers", () => {
  it('reads a regular file only; a link, a folder or a missing file is none', async () => {
    const file = path.join(root, REGISTRY_ANSWERS_FILE);
    expect(await readRegistryAnswers(root)).toBeUndefined();
    fs.writeFileSync(file, JSON.stringify({ schedule: '17', digests: {} }));
    expect(await readRegistryAnswers(root)).toEqual({ schedule: '17', digests: {} });
    fs.rmSync(file);
    const target = path.join(root, 'target.json');
    fs.writeFileSync(target, JSON.stringify({ digests: {} }));
    fs.symlinkSync(target, file);
    expect(await readRegistryAnswers(root)).toBeUndefined();
    fs.rmSync(file);
    fs.mkdirSync(file);
    expect(await readRegistryAnswers(root)).toBeUndefined();
  });
});
