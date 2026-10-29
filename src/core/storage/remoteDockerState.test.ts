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
    await expect(state.removeHost('a')).resolves.toEqual({ removed: true, wasDockerHost: false });
    expect(await state.dockerHost()).toBe('b');
    await expect(state.removeHost('b')).resolves.toEqual({ removed: true, wasDockerHost: true });
    expect(await state.dockerHost()).toBeUndefined();
    expect(await state.remoteHosts()).toEqual([]);
    expect((await state.read()).remoteHosts).toBeUndefined();
    // The rootless socket of the host stays for its devspaces.
    expect(await state.rootlessSocket('b')).toBe('/run/user/1000/docker.sock');
    await expect(state.removeHost('b')).resolves.toEqual({ removed: false, wasDockerHost: false });
  });

  it('claims the offer of a host once, and never for a host of the list', async () => {
    await expect(state.claimOffer('build-box')).resolves.toBe(true);
    await expect(state.claimOffer('build-box')).resolves.toBe(false);
    expect((await state.read()).offered).toEqual(['build-box']);
    await state.setDockerHost('listed');
    await expect(state.claimOffer('listed')).resolves.toBe(false);
    expect((await state.read()).offered).toEqual(['build-box']);
  });

  // Several windows start at the same time: only one of them asks, and no change of another window is lost.
  it('gives the offer to one of several windows at the same time, and loses no change', async () => {
    const windows = Array.from({ length: 5 }, () => new RemoteDockerState(state.file));
    const claims = await Promise.all([...windows.map((window) => window.claimOffer('me@box')), windows[0].setDockerHost('a'), windows[1].setRootlessSocket('a', '/run/user/1000/docker.sock')]);
    expect(claims.slice(0, 5).filter((claimed) => claimed === true)).toHaveLength(1);
    expect(await state.read()).toEqual({ dockerHost: 'a', remoteHosts: ['a'], offered: ['me@box'], hosts: [{ host: 'a', rootlessSocket: '/run/user/1000/docker.sock' }] });
    expect(fs.existsSync(state.lockDir)).toBe(false);
  });

  // Most calls change nothing (the rootful engine at each Docker start, a host that was offered): they take no lock.
  it('takes the lock only for a change', async () => {
    await state.setDockerHost('a');
    fs.mkdirSync(state.lockDir);
    await state.setDockerHost('a');
    await state.setRootlessSocket('a', undefined);
    await expect(state.claimOffer('a')).resolves.toBe(false);
    await expect(state.removeHost('b')).resolves.toEqual({ removed: false, wasDockerHost: false });
    fs.rmdirSync(state.lockDir);
  });

  // A change never writes over a list that it could not read; a file that is not valid JSON is kept as a copy first.
  it('writes nothing when the file cannot be read, and keeps a copy of a file that is not valid', async () => {
    fs.mkdirSync(state.file);
    await expect(state.setDockerHost('a')).rejects.toThrow();
    expect(fs.statSync(state.file).isDirectory()).toBe(true);
    fs.rmdirSync(state.file);
    fs.writeFileSync(state.file, '{"remoteHosts": ["a"');
    await state.setDockerHost('b');
    expect(await state.read()).toEqual({ dockerHost: 'b', remoteHosts: ['b'] });
    const copies = fs.readdirSync(dir).filter((name) => name.startsWith('remote-docker.json.backup-'));
    expect(copies).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, copies[0]), 'utf8')).toBe('{"remoteHosts": ["a"');
  });

  it.each([
    ['the list of hosts', '{"remoteHosts": "a"}'],
    ['the offered hosts', '{"offered": "a"}'],
    ['the rootless sockets', '{"hosts": {"a": {"rootlessSocket": "/run/user/1000/docker.sock"}}}'],
  ])('keeps a copy of a file whose field of %s is not a list', async (_name, text) => {
    fs.writeFileSync(state.file, text);
    await state.setDockerHost('b');
    expect(await state.read()).toEqual({ dockerHost: 'b', remoteHosts: ['b'] });
    expect(fs.readdirSync(dir).filter((name) => name.startsWith('remote-docker.json.backup-'))).toHaveLength(1);
  });

  // An editor of Windows may save the file with a byte order mark: the read and the read of a change agree on it.
  it('reads a file with a byte order mark', async () => {
    fs.writeFileSync(state.file, `\uFEFF${JSON.stringify({ dockerHost: 'a', remoteHosts: ['a', 'b'] })}`);
    expect(await state.read()).toEqual({ dockerHost: 'a', remoteHosts: ['a', 'b'] });
    await expect(state.removeHost('a')).resolves.toEqual({ removed: true, wasDockerHost: true });
    expect(await state.read()).toEqual({ remoteHosts: ['b'] });
    expect(fs.readdirSync(dir).filter((name) => name.startsWith('remote-docker.json.backup-'))).toHaveLength(0);
  });

  it('drops the fields that it does not know, and puts a Docker host that is not listed into the list', async () => {
    fs.writeFileSync(
      state.file,
      JSON.stringify({ other: 'x', dockerHost: 'c', remoteHosts: ['a', 'a', '', 3], offered: [1], hosts: [{ host: 'a', rootlessSocket: '/s1' }, { host: 'a', rootlessSocket: '/s2' }, 'b'] }),
    );
    expect(await state.read()).toEqual({ dockerHost: 'c', remoteHosts: ['a', 'c'], hosts: [{ host: 'a', rootlessSocket: '/s1' }] });
    await state.claimOffer('x');
    expect(JSON.parse(fs.readFileSync(state.file, 'utf8'))).toEqual({ dockerHost: 'c', remoteHosts: ['a', 'c'], offered: ['x'], hosts: [{ host: 'a', rootlessSocket: '/s1' }] });
    // The fields are lists, so no copy is kept.
    expect(fs.readdirSync(dir).filter((name) => name.startsWith('remote-docker.json.backup-'))).toHaveLength(0);
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

describe('RemoteDockerState: the SSH key of Devspaces', () => {
  it('records the key of a host next to its rootless socket, and removes a record that knows nothing more', async () => {
    await state.setRootlessSocket('a', '/run/user/1000/docker.sock');
    await state.setSshKey('a', 'installed');
    await state.setSshKey('b', 'declined');
    expect(await state.sshKey('a')).toBe('installed');
    expect(await state.sshKey('b')).toBe('declined');
    expect(await state.sshKey('c')).toBeUndefined();
    expect((await state.read()).hosts).toEqual([
      { host: 'a', rootlessSocket: '/run/user/1000/docker.sock', sshKey: 'installed' },
      { host: 'b', sshKey: 'declined' },
    ]);
    // The socket goes; the key keeps the record, at its place.
    await state.setRootlessSocket('a', undefined);
    expect((await state.read()).hosts).toEqual([{ host: 'a', sshKey: 'installed' }, { host: 'b', sshKey: 'declined' }]);
    await state.setSshKey('a', undefined);
    await state.setSshKey('b', undefined);
    expect((await state.read()).hosts).toBeUndefined();
    // A key is no host of the list.
    expect(await state.remoteHosts()).toEqual([]);
  });

  it('writes only a change', async () => {
    await state.setSshKey('a', 'installed');
    const before = fs.statSync(state.file);
    await state.setSshKey('a', 'installed');
    await state.setSshKey('b', undefined);
    const after = fs.statSync(state.file);
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
  });

  it('forgets a declined key when the host leaves the list, and keeps an installed one', async () => {
    await state.setDockerHost('a');
    await state.setDockerHost('b');
    await state.setSshKey('a', 'declined');
    await state.setSshKey('b', 'installed');
    await state.removeHost('a');
    await state.removeHost('b');
    expect(await state.sshKey('a')).toBeUndefined();
    expect(await state.sshKey('b')).toBe('installed');
  });

  it('gives the key without waiting, and reads the file again after a change of another window', async () => {
    expect(state.sshKeyNow('a')).toBeUndefined();
    await state.setSshKey('a', 'installed');
    expect(state.sshKeyNow('a')).toBe('installed');
    // Another window (another object on the same file) changes it.
    await new RemoteDockerState(state.file).setSshKey('a', 'declined');
    expect(state.sshKeyNow('a')).toBe('declined');
    fs.writeFileSync(state.file, 'not json');
    expect(state.sshKeyNow('a')).toBeUndefined();
    fs.rmSync(state.file);
    expect(state.sshKeyNow('a')).toBeUndefined();
  });

  it('drops a key state that it does not know', async () => {
    fs.writeFileSync(state.file, JSON.stringify({ hosts: [{ host: 'a', sshKey: 'maybe' }, { host: 'b', sshKey: 'installed' }] }));
    expect((await state.read()).hosts).toEqual([{ host: 'a' }, { host: 'b', sshKey: 'installed' }]);
    expect(state.sshKeyNow('a')).toBeUndefined();
    expect(state.sshKeyNow('b')).toBe('installed');
  });
});
