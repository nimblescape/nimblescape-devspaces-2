// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Probes (mutation testing) for the use marker of an open: the marker file is private to the worker (0600, whatever the
// umask), as its folder used/ is (0700); and ensureServer, the fetch that the Monitor's background run uses,
// marks nothing (only the open's ensureEngineServer does; the tests of the run inject their own fetch, so they would
// not see a mark there). The store is a temporary folder (never the home folder); nothing needs root.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HttpStreamTransport, HttpTransport } from '../http';
import { silentLogger } from '../ports';
import { ensureServer, markServerOpened, serverFolder, serverOpenedAt, serverUseMarker, type VscodeStoreDeps } from './vscodeServerStore';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('the use marker of an open', () => {
  it('is created without any access for the group and others', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-store-ph2r2-'));
    temps.push(root);
    const commit = 'a'.repeat(40);
    await markServerOpened(root, { commit, quality: 'stable' }, 'linux-x64', new Date(Date.parse('2026-10-09T12:00:00Z')));
    const marker = serverUseMarker(root, `stable-linux-x64-${commit}`);
    expect(fs.lstatSync(marker).isFile()).toBe(true);
    expect(fs.lstatSync(marker).mode & 0o077).toBe(0);
    expect(fs.lstatSync(path.dirname(marker)).mode & 0o077).toBe(0);
  });
});

describe('the fetch of the background run is no use', () => {
  it('ensureServer of a present version marks nothing (no used/ folder, no marker)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-store-ph2r2-'));
    temps.push(root);
    const server = { commit: 'b'.repeat(40), quality: 'insider' as const };
    const folder = serverFolder(root, server, 'linux-x64');
    fs.mkdirSync(path.join(folder, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'bin', 'code-server-insiders'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(folder, 'node'), '');
    const unused = () => {
      throw new Error('not used');
    };
    const deps: VscodeStoreDeps = {
      root,
      transport: { request: unused, stream: unused } as unknown as HttpTransport & HttpStreamTransport,
      architecture: unused,
      lock: unused,
      unpack: unused,
      logger: silentLogger,
      background: true,
    };
    expect(await ensureServer(deps, server, 'linux-x64', new AbortController().signal)).toBe(true);
    expect(await serverOpenedAt(root, `insider-linux-x64-${server.commit}`)).toBeUndefined();
    expect(fs.existsSync(path.join(root, 'used'))).toBe(false);
  });
});
