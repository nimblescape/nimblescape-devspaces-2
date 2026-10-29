// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RemoteDockerState } from './remoteDockerState';

let dir: string;
let state: RemoteDockerState;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-remote-state-'));
  state = new RemoteDockerState(path.join(dir, 'remote-docker.json'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('RemoteDockerState: the list of hosts and the Docker host of Devspaces', () => {
  it('starts with the local Docker and an empty list', async () => {
    expect(await state.dockerHost()).toBeUndefined();
    expect(await state.remoteHosts()).toEqual([]);
    expect(fs.existsSync(state.file)).toBe(false);
  });

  it('adds a host to the end of the list when it becomes the Docker host, once', async () => {
    await state.setDockerHost('build-box');
    await state.setDockerHost('me@192.0.2.10:2222');
    await state.setDockerHost('build-box');
    expect(await state.dockerHost()).toBe('build-box');
    expect(await state.remoteHosts()).toEqual(['build-box', 'me@192.0.2.10:2222']);
    await state.setDockerHost(undefined);
    expect(await state.dockerHost()).toBeUndefined();
    expect(await state.remoteHosts()).toEqual(['build-box', 'me@192.0.2.10:2222']);
  });

  it('removes a host from the list, and the local Docker takes the place of the Docker host', async () => {
    await state.setDockerHost('a');
    await state.setDockerHost('b');
    await state.setRootlessSocket('b', '/run/user/1000/docker.sock');
    await expect(state.removeHost('a')).resolves.toBe(true);
    expect(await state.dockerHost()).toBe('b');
    await expect(state.removeHost('b')).resolves.toBe(true);
    expect(await state.dockerHost()).toBeUndefined();
    expect(await state.remoteHosts()).toEqual([]);
    expect((await state.read()).remoteHosts).toBeUndefined();
    // The rootless socket of the host stays for its devspaces.
    expect(await state.rootlessSocket('b')).toBe('/run/user/1000/docker.sock');
    await expect(state.removeHost('b')).resolves.toBe(false);
  });

  it('remembers each offered host once', async () => {
    expect(await state.wasOffered('build-box')).toBe(false);
    await state.setOffered('build-box');
    await state.setOffered('build-box');
    expect(await state.wasOffered('build-box')).toBe(true);
    expect((await state.read()).offered).toEqual(['build-box']);
  });

  it('drops the fields of the versions that switched the Docker context, and puts a Docker host that is not listed into the list', async () => {
    fs.writeFileSync(
      state.file,
      JSON.stringify({ previousContext: 'desktop-linux', dontAsk: ['switchBack'], dockerHost: 'c', remoteHosts: ['a', 'a', '', 3], offered: 'x' }),
    );
    expect(await state.read()).toEqual({ dockerHost: 'c', remoteHosts: ['a', 'c'] });
    await state.setOffered('x');
    expect(JSON.parse(fs.readFileSync(state.file, 'utf8'))).toEqual({ dockerHost: 'c', remoteHosts: ['a', 'c'], offered: ['x'] });
  });
});

describe('RemoteDockerState: rootless sockets', () => {
  it('records, changes and forgets the socket of a host', async () => {
    await state.setRootlessSocket('build-box', '/run/user/1000/docker.sock');
    expect(await state.rootlessSocket('build-box')).toBe('/run/user/1000/docker.sock');
    await state.setRootlessSocket('build-box', '/run/user/1001/docker.sock');
    expect(await state.rootlessSocket('build-box')).toBe('/run/user/1001/docker.sock');
    await state.setRootlessSocket('build-box', undefined);
    expect(await state.rootlessSocket('build-box')).toBeUndefined();
    // A rootless socket is no host of the list.
    expect(await state.remoteHosts()).toEqual([]);
  });
});
