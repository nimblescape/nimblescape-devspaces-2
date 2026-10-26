// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The dependencies in the part "extensions" of the Monitor's background run, with a store in a temporary folder, a
// fake Marketplace and fake downloads: the extensions that the server installs with a chosen version (its dependencies
// and the extensions of its pack) are asked for and downloaded as entries without a pin, in rounds, and recorded; the
// cleanup keeps their files while an entry of a list needs them, and removes them after.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { HttpRequest } from '../core/http';
import { formatExtensionRecord, type ExtensionRecord } from '../core/vscodeExtensions';
import { cleanupExtensions, downloadExtensions, MAX_DEPENDENCY_ROUNDS, type ExtensionRunDeps } from './extensionDownloads';

const NOW = 400 * 24 * 60 * 60_000;
const DAY = 24 * 60 * 60_000;
const VSIX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('zip')]);

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A store with a ready stable server of VS Code 1.105.0 for linux-x64; the monitor's volume is the same folder. */
function store(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-ext-deps-'));
  temps.push(root);
  const folder = path.join(root, 'server', 'stable', 'linux-x64', 'a'.repeat(40));
  fs.mkdirSync(path.join(folder, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'bin', 'code-server'), '');
  fs.writeFileSync(path.join(folder, 'node'), '');
  fs.writeFileSync(path.join(folder, 'product.json'), JSON.stringify({ version: '1.105.0' }));
  return root;
}

function record(root: string, value: ExtensionRecord): void {
  const folder = path.join(root, 'extensions', 'wanted');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'aaaaaaaaaa.json'), formatExtensionRecord(value));
}

/** One version for the Marketplace, with its dependencies and the extensions of its pack. */
function version(number: string, links: { dependencies?: string; pack?: string } = {}): Record<string, unknown> {
  return {
    version: number,
    properties: [
      { key: 'Microsoft.VisualStudio.Code.Engine', value: '^1.90.0' },
      ...(links.dependencies !== undefined ? [{ key: 'Microsoft.VisualStudio.Code.ExtensionDependencies', value: links.dependencies }] : []),
      ...(links.pack !== undefined ? [{ key: 'Microsoft.VisualStudio.Code.ExtensionPack', value: links.pack }] : []),
    ],
    files: [{ assetType: 'Microsoft.VisualStudio.Services.VSIXPackage', source: `https://cdn.gallerycdn.vsassets.io/${number}.vsix` }],
  };
}

/** The Marketplace of the tests (`<id>` → its versions; an ID that it does not list it does not have). */
function fake(root: string, marketplace: Record<string, Array<Record<string, unknown>>>, now = NOW) {
  const queries: string[][] = [];
  const downloads: string[] = [];
  const logs: string[] = [];
  const deps: ExtensionRunDeps = {
    root,
    stateDir: root,
    transport: {
      request: async (request: HttpRequest) => {
        const body = JSON.parse(request.body ?? '{}') as { filters: Array<{ criteria: Array<{ filterType: number; value: string }> }> };
        const ids = body.filters[0].criteria.filter((c) => c.filterType === 7).map((c) => c.value);
        queries.push(ids);
        const extensions = ids
          .filter((id) => marketplace[id] !== undefined)
          .map((id) => ({ publisher: { publisherName: id.split('.')[0] }, extensionName: id.split('.')[1], versions: marketplace[id] }));
        return { status: 200, headers: {}, body: JSON.stringify({ results: [{ extensions }] }) };
      },
      stream: async (url: string) => {
        downloads.push(url);
        return { status: 200, headers: {}, body: Readable.from([VSIX]) };
      },
    },
    architecture: async () => 'x86_64',
    lock: async () => () => undefined,
    tryLock: async () => ({ kind: 'locked', release: () => undefined }),
    log: (message) => logs.push(message),
    now: () => now,
  };
  return { deps, queries, downloads, logs };
}

const files = (root: string): string[] => fs.readdirSync(path.join(root, 'extensions', 'universal')).sort();
const state = (root: string, name: string): unknown => JSON.parse(fs.readFileSync(path.join(root, 'extensions', name), 'utf8'));

const MARKETPLACE = {
  'bierner.github-markdown-preview': [version('0.4.0', { pack: 'bierner.markdown-emoji,bierner.markdown-checkbox,vscode.git' })],
  'bierner.markdown-emoji': [version('0.3.1', { dependencies: 'bierner.markdown-footnotes,gone.missing' })],
  'bierner.markdown-checkbox': [version('0.4.0')],
  'bierner.markdown-footnotes': [version('0.1.1')],
};

describe('the dependencies of the extensions in the background run', () => {
  it('asks for and downloads the dependencies and the extensions of the packs, in rounds, and records them', async () => {
    const root = store();
    record(root, { at: NOW - DAY, configuration: [{ id: 'bierner.github-markdown-preview' }], defaults: [] });
    const f = fake(root, MARKETPLACE);
    await downloadExtensions(f.deps);
    // One query per round, never for a built-in extension of VS Code (vscode.git).
    expect(f.queries).toEqual([['bierner.github-markdown-preview'], ['bierner.markdown-checkbox', 'bierner.markdown-emoji'], ['bierner.markdown-footnotes', 'gone.missing']]);
    expect(files(root)).toEqual(['bierner.github-markdown-preview-0.4.0', 'bierner.markdown-checkbox-0.4.0', 'bierner.markdown-emoji-0.3.1', 'bierner.markdown-footnotes-0.1.1']);
    expect(state(root, 'dependencies.json')).toEqual({
      'bierner.github-markdown-preview': ['bierner.markdown-emoji', 'bierner.markdown-checkbox'],
      'bierner.markdown-emoji': ['bierner.markdown-footnotes', 'gone.missing'],
    });
    expect(Object.keys(state(root, 'chosen.json') as object)).toEqual(['bierner.github-markdown-preview', 'bierner.markdown-checkbox', 'bierner.markdown-emoji', 'bierner.markdown-footnotes']);
    // A dependency that the Marketplace does not have fails as any entry, and waits a day.
    expect(f.logs).toContain('The extension gone.missing is not in the shared extension cache (the Marketplace does not have it); it is tried again after a day.');
    expect(Object.keys(state(root, 'failures.json') as object)).toEqual(['gone.missing']);
    expect(f.logs[f.logs.length - 1]).toBe('The extensions for VS Code 1.105.0 (linux-x64): 1 wanted and 4 dependencies, 4 downloaded, 0 in the cache, 1 failed, 0 waiting for their retry.');

    // The next run: the dependency that failed waits for its retry, the others are in the cache; the recorded
    // dependencies name all of them in the first round.
    const g = fake(root, MARKETPLACE);
    await downloadExtensions(g.deps);
    expect(g.queries).toEqual([['bierner.github-markdown-preview'], ['bierner.markdown-checkbox', 'bierner.markdown-emoji', 'bierner.markdown-footnotes']]);
    expect(g.downloads).toEqual([]);
    expect(g.logs[g.logs.length - 1]).toBe('The extensions for VS Code 1.105.0 (linux-x64): 1 wanted and 4 dependencies, 0 downloaded, 4 in the cache, 0 failed, 1 waiting for their retry.');
  });

  it('the cleanup keeps the files of the dependencies while a list needs them, and removes them after', async () => {
    const root = store();
    record(root, { at: NOW - DAY, configuration: [{ id: 'bierner.github-markdown-preview' }], defaults: [] });
    await downloadExtensions(fake(root, MARKETPLACE).deps);
    await cleanupExtensions(fake(root, MARKETPLACE).deps);
    expect(files(root)).toHaveLength(4);

    // The list names another extension now: the next run forgets the dependencies, and the cleanup removes the files.
    record(root, { at: NOW, configuration: [{ id: 'other.one' }], defaults: [] });
    const f = fake(root, { 'other.one': [version('1.0.0')] });
    await downloadExtensions(f.deps);
    expect(state(root, 'dependencies.json')).toEqual({});
    await cleanupExtensions(f.deps);
    expect(files(root)).toEqual(['other.one-1.0.0']);
  });

  it('asks for no dependency after a query that failed for the network', async () => {
    const root = store();
    record(root, { at: NOW - DAY, configuration: [{ id: 'bierner.github-markdown-preview' }], defaults: [] });
    await downloadExtensions(fake(root, MARKETPLACE).deps);
    const f = fake(root, MARKETPLACE);
    const queries: string[][] = [];
    f.deps.transport.request = async (request: HttpRequest) => {
      queries.push(JSON.parse(request.body ?? '{}').filters[0].criteria.filter((c: { filterType: number }) => c.filterType === 7).map((c: { value: string }) => c.value));
      throw Object.assign(new Error('getaddrinfo ENOTFOUND marketplace.visualstudio.com'), { code: 'ENOTFOUND' });
    };
    await downloadExtensions(f.deps);
    expect(queries).toEqual([['bierner.github-markdown-preview']]);
    // The recorded dependencies stay for the seed and the cleanup.
    expect(Object.keys(state(root, 'dependencies.json') as object)).toEqual(['bierner.github-markdown-preview', 'bierner.markdown-emoji']);
  });

  it(`stops after ${MAX_DEPENDENCY_ROUNDS} rounds; the next run goes on from the recorded dependencies`, async () => {
    const root = store();
    record(root, { at: NOW - DAY, configuration: [{ id: 'chain.c0' }], defaults: [] });
    const chain: Record<string, Array<Record<string, unknown>>> = {};
    for (let index = 0; index <= MAX_DEPENDENCY_ROUNDS + 1; index++) chain[`chain.c${index}`] = [version('1.0.0', index <= MAX_DEPENDENCY_ROUNDS ? { dependencies: `chain.c${index + 1}` } : {})];
    const f = fake(root, chain);
    await downloadExtensions(f.deps);
    expect(f.queries).toHaveLength(1 + MAX_DEPENDENCY_ROUNDS);
    expect(files(root)).toHaveLength(1 + MAX_DEPENDENCY_ROUNDS);
    const g = fake(root, chain);
    await downloadExtensions(g.deps);
    expect(files(root)).toHaveLength(MAX_DEPENDENCY_ROUNDS + 2);
  });
});
