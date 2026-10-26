// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// `monitor.js images -` stores the image references in use per computer (its heartbeat source), each with the time it
// was sent; the monitor uses the union of those sent within the last 30 days, and its background run keeps them up to
// date. The volume is a temporary folder; nothing needs root.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IMAGES_IN_USE_MAX_AGE_MS, LAST_USE_FILE, imagesInUseFileName } from '../core/remoteMonitor/protocol';
import type { HttpResponse } from '../core/http';
import type { EngineContainerSummary } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import { EXIT_INVALID, PULLED_OVER_IMAGES_FILE, STATE_TEMPORARY_FILE, main, readImagesInUse, writeImagesInUse } from './main';

const T0 = Date.parse('2026-10-11T10:00:00Z');
const A = '0123456789abcdef0123456789abcdef';
const B = 'fedcba9876543210fedcba9876543210';
let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-remote-monitor-11k1-'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

async function images(input: unknown, now = T0): Promise<{ code: number; err: string }> {
  let err = '';
  const code = await main(['images', '-'], { env: {}, stateDir, now: () => now, readStdin: async () => (typeof input === 'string' ? input : JSON.stringify(input)), err: (text) => (err += text) });
  return { code, err };
}

const stored = (source: string): unknown => JSON.parse(fs.readFileSync(path.join(stateDir, imagesInUseFileName(source)), 'utf8'));

describe('monitor.js images with the references in use', () => {
  it('stores the references of each computer in a file of its own, with the time of the host', async () => {
    expect(await images({ source: A, references: ['node:20'] })).toEqual({ code: 0, err: '' });
    expect(await images({ source: B, references: ['mcr.microsoft.com/devcontainers/base:ubuntu'] }, T0 + 5)).toEqual({ code: 0, err: '' });
    expect(stored(A)).toEqual({ at: T0, references: ['node:20'] });
    expect(stored(B)).toEqual({ at: T0 + 5, references: ['mcr.microsoft.com/devcontainers/base:ubuntu'] });
    // The next open of A replaces A's references only (a deleted devspace drops out). The list of repositories of an
    // older extension beside them is ignored.
    expect((await images({ source: A, references: [], repositories: ['ghcr.io/acme/app'] }, T0 + 10)).code).toBe(0);
    expect(stored(A)).toEqual({ at: T0 + 10, references: [] });
    expect(stored(B)).toEqual({ at: T0 + 5, references: ['mcr.microsoft.com/devcontainers/base:ubuntu'] });
    // And the use of the windows (LAST_USE_FILE).
    expect(fs.readdirSync(stateDir).sort()).toEqual([imagesInUseFileName(A), imagesInUseFileName(B), LAST_USE_FILE].sort());
    expect(await readImagesInUse(stateDir, T0 + 10)).toEqual({ references: ['mcr.microsoft.com/devcontainers/base:ubuntu'], complete: true });
  });

  // With the digests that the opens of the computer recorded, and their union.
  it('stores the recorded digests of the references and gives their union', async () => {
    const one = `sha256:${'1'.repeat(64)}`;
    const two = `sha256:${'2'.repeat(64)}`;
    expect((await images({ source: A, references: ['node:20'], digests: { 'node:20': [one] } })).code).toBe(0);
    expect(stored(A)).toEqual({ at: T0, references: ['node:20'], digests: { 'node:20': [one] } });
    await writeImagesInUse(stateDir, B, ['node:20', 'redis'], T0, { 'node:20': [two, one] });
    expect(await readImagesInUse(stateDir, T0)).toEqual({ references: ['node:20', 'redis'], digests: { 'node:20': [one, two] }, complete: true });
    // A file without digests is read too.
    await writeImagesInUse(stateDir, A, ['python:3'], T0);
    expect(stored(A)).toEqual({ at: T0, references: ['python:3'] });
  });

  // The list alone is taken and ignored.
  it('takes the list alone (an older extension on another computer sends it) and ignores it, and refuses anything else', async () => {
    expect(await images({ repositories: ['ghcr.io/acme/app'] })).toEqual({ code: 0, err: '' });
    // Only the use of the window (LAST_USE_FILE).
    expect(fs.readdirSync(stateDir)).toEqual([LAST_USE_FILE]);
    fs.rmSync(path.join(stateDir, LAST_USE_FILE));
    for (const input of [{ source: A }, { source: A, references: ['Node:20'] }, { source: '../x', references: [] }, { references: ['node:20'] }, { source: A, references: [], repositories: 'x' }, 'not json']) {
      expect(await images(input)).toEqual({ code: EXIT_INVALID, err: 'Invalid image list.\n' });
    }
    expect(fs.readdirSync(stateDir)).toEqual([]);
  });

  it('uses the union of the computers that sent within 30 days; an older file is removed', async () => {
    await writeImagesInUse(stateDir, A, ['node:20', 'python:3'], T0 - IMAGES_IN_USE_MAX_AGE_MS);
    await writeImagesInUse(stateDir, B, ['node:20', 'redis:7'], T0 - IMAGES_IN_USE_MAX_AGE_MS - 1);
    const read = await readImagesInUse(stateDir, T0);
    expect(read.complete).toBe(true);
    expect(read.references.sort()).toEqual(['node:20', 'python:3']);
    expect(fs.existsSync(path.join(stateDir, imagesInUseFileName(B)))).toBe(false);
    // A file of a later time (a clock of the host that went back) counts.
    await writeImagesInUse(stateDir, B, ['redis:7'], T0 + 60_000);
    expect((await readImagesInUse(stateDir, T0)).references.sort()).toEqual(['node:20', 'python:3', 'redis:7']);
    expect(IMAGES_IN_USE_MAX_AGE_MS).toBe(30 * 24 * 60 * 60_000);
  });

  it('is not complete with a file that cannot be read; such a file goes only when it is older than 30 days', async () => {
    await writeImagesInUse(stateDir, A, ['node:20'], T0);
    const invalid = path.join(stateDir, imagesInUseFileName(B));
    fs.writeFileSync(invalid, '{"at":1,"references":["Not valid"]}');
    expect(await readImagesInUse(stateDir, T0)).toEqual({ references: ['node:20'], complete: false });
    expect(fs.existsSync(invalid)).toBe(true);
    const old = (T0 - IMAGES_IN_USE_MAX_AGE_MS - 60_000) / 1000;
    fs.utimesSync(invalid, old, old);
    expect(await readImagesInUse(stateDir, T0)).toEqual({ references: ['node:20'], complete: false });
    expect(fs.existsSync(invalid)).toBe(false);
    expect(await readImagesInUse(stateDir, T0)).toEqual({ references: ['node:20'], complete: true });
  });

  it('reads only regular files of its names, never a link; a missing folder has none', async () => {
    const target = path.join(stateDir, 'target.json');
    fs.writeFileSync(target, JSON.stringify({ at: T0, references: ['node:20'] }));
    fs.symlinkSync(target, path.join(stateDir, imagesInUseFileName(A)));
    fs.writeFileSync(path.join(stateDir, `images-in-use.${'g'.repeat(32)}.json`), JSON.stringify({ at: T0, references: ['python:3'] }));
    expect(await readImagesInUse(stateDir, T0)).toEqual({ references: [], complete: true });
    expect(await readImagesInUse(path.join(stateDir, 'missing'), T0)).toEqual({ references: [], complete: true });
  });

  it('cleans the leftover temporary files of these files too', () => {
    expect(STATE_TEMPORARY_FILE.test(`images-in-use.${A}.json.12.3.tmp`)).toBe(true);
    expect(STATE_TEMPORARY_FILE.test('images-in-use.x.json.12.3.tmp')).toBe(false);
  });

  it('the background run of `run` pulls the references in use of the volume', async () => {
    await writeImagesInUse(stateDir, A, ['node:20', `ghcr.io/acme/pinned@sha256:${'a'.repeat(64)}`], T0);
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    const pulls: string[] = [];
    let mono = 0;
    let out = '';
    void main(['run'], {
      env: { DEVSPACE_MONITOR_PERMANENT: '1', DEVSPACE_IMAGE_FIRST_MS: '1000' },
      stateDir,
      engine: {
        ...unusedEngine(),
        containerSummaries: async (): Promise<EngineContainerSummary[]> => [],
        images: async () => [],
        inspect: async () => undefined,
        pull: async (reference) => void pulls.push(reference),
        proxy: async () => ({}),
      },
      vscodeBackground: () => undefined,
      lockDevspace: async () => ({ kind: 'locked', release: () => {} }),
      exec: (_file, _args, _options, callback) => callback(null, 'removed\n', ''),
      monotonic: () => mono,
      now: () => T0 + mono,
      sleep: async (ms) => {
        mono += ms;
        await new Promise(() => {});
      },
      out: (text) => (out += text),
    });
    await vi.waitFor(() => expect(out).toContain('first check in 1 s'));
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(out).toContain('The background run ended.'), { timeout: 4_000 });
    // The tag, anonymous; never the reference pinned by a digest.
    expect(pulls).toEqual(['node:20']);
  });

  // The IDs that the monitor's own pull replaced are kept in the volume (pulled-over-images.json), so the evidence
  // survives a restart.
  it('keeps the image that its own pull replaced in the volume', async () => {
    const before = `sha256:${'1'.repeat(64)}`;
    const after = `sha256:${'2'.repeat(64)}`;
    await writeImagesInUse(stateDir, A, ['node:20'], T0);
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    let pulled = false;
    let mono = 0;
    let out = '';
    void main(['run'], {
      env: { DEVSPACE_MONITOR_PERMANENT: '1', DEVSPACE_IMAGE_FIRST_MS: '1000' },
      stateDir,
      engine: {
        ...unusedEngine(),
        containerSummaries: async (): Promise<EngineContainerSummary[]> => [],
        images: async () => [],
        // `node:20` before and after the pull, and the old version, untagged after it.
        inspect: async (_kind, reference) =>
          reference === 'node:20'
            ? { Id: pulled ? after : before, RepoTags: ['node:20'], RepoDigests: [`node@${pulled ? after : before}`] }
            : reference === before && pulled
              ? { Id: before, RepoTags: [], RepoDigests: [], Created: '2026-10-01T00:00:00Z', RootFS: { Type: 'layers', Layers: ['l1'] } }
              : undefined,
        pull: async () => void (pulled = true),
        proxy: async () => ({}),
      },
      // The registry: a newer `node:20`, and the engine's image (by its digest).
      registryTransport: () => ({
        request: async ({ url }): Promise<HttpResponse> => {
          const manifest = /\/manifests\/([^/]+)$/.exec(url)?.[1];
          const digest = manifest === '20' ? after : manifest === before ? before : undefined;
          return digest === undefined ? { status: 404, headers: {}, body: '' } : { status: 200, headers: { 'docker-content-digest': digest }, body: '' };
        },
      }),
      vscodeBackground: () => undefined,
      lockDevspace: async () => ({ kind: 'locked', release: () => {} }),
      exec: (_file, _args, _options, callback) => callback(null, 'removed\n', ''),
      monotonic: () => mono,
      now: () => T0 + mono,
      sleep: async (ms) => {
        mono += ms;
        await new Promise(() => {});
      },
      out: (text) => (out += text),
    });
    await vi.waitFor(() => expect(out).toContain('first check in 1 s'));
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(out).toContain('The background run ended.'), { timeout: 4_000 });
    expect(pulled).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(stateDir, PULLED_OVER_IMAGES_FILE), 'utf8'))).toEqual({ node: [before] });
    expect(STATE_TEMPORARY_FILE.test(`${PULLED_OVER_IMAGES_FILE}.12.3.tmp`)).toBe(true);
  });
});
