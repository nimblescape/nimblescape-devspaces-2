// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { MAX_SOCKET_PATH_BYTES, dockerPipeAddress, dockerPipeBase, dockerPipeId, parseDockerPipeHost } from './pipeAddress';

const ID = '0123456789abcdef';

describe('the address of the Docker pipe', () => {
  it('has an id of 16 hexadecimal digits that is the same for the same computer, host, and container only', () => {
    const id = dockerPipeId('computer-a', 'build-box', 'devspaces-api');
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(dockerPipeId('computer-a', 'build-box', 'devspaces-api')).toBe(id);
    expect(new Set([id, dockerPipeId('computer-b', 'build-box', 'devspaces-api'), dockerPipeId('computer-a', 'other', 'devspaces-api'), dockerPipeId('computer-a', 'build-box', 'devspaces-web')]).size).toBe(4);
    // The parts are separated: moving a character from one part to the next gives another id.
    expect(dockerPipeId('a', 'bc', 'd')).not.toBe(dockerPipeId('ab', 'c', 'd'));
  });

  it('is a named pipe on Windows and a socket in a private folder elsewhere', () => {
    expect(dockerPipeAddress(ID, 'win32', 'ignored')).toEqual({
      id: ID,
      path: `\\\\.\\pipe\\devspaces-${ID}`,
      dockerHost: `npipe:////./pipe/devspaces-${ID}`,
    });
    expect(dockerPipeAddress(ID, 'linux', '/run/user/1000')).toEqual({
      id: ID,
      path: `/run/user/1000/devspaces-${ID}/docker.sock`,
      dockerHost: `unix:///run/user/1000/devspaces-${ID}/docker.sock`,
      folder: `/run/user/1000/devspaces-${ID}`,
    });
    expect(() => dockerPipeAddress('../x', 'linux', '/tmp')).toThrow('is not valid');
  });

  it('lies in XDG_RUNTIME_DIR, else in the temporary folder, else in /tmp, wherever the path of the socket fits', () => {
    const macTemp = '/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T/';
    expect(dockerPipeBase({ XDG_RUNTIME_DIR: '/run/user/1000/' }, macTemp)).toBe('/run/user/1000');
    expect(dockerPipeBase({}, macTemp)).toBe('/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T');
    expect(dockerPipeBase({ XDG_RUNTIME_DIR: 'relative/dir' }, '/tmp')).toBe('/tmp');
    const long = `/home/${'x'.repeat(80)}`;
    expect(dockerPipeBase({ XDG_RUNTIME_DIR: long }, long)).toBe('/tmp');
    const base = `/${'y'.repeat(MAX_SOCKET_PATH_BYTES - '/devspaces-0123456789abcdef/docker.sock'.length - 1)}`;
    expect(Buffer.byteLength(dockerPipeAddress(ID, 'darwin', base).path)).toBe(MAX_SOCKET_PATH_BYTES);
    expect(dockerPipeBase({}, base)).toBe(base);
    expect(dockerPipeBase({}, `${base}y`)).toBe('/tmp');
  });

  it('is read back from the host in the authority of a window, and nothing else is', () => {
    for (const [platform, base] of [
      ['linux', '/run/user/1000'],
      ['darwin', '/var/folders/zz/T'],
      ['win32', ''],
    ] as const) {
      const address = dockerPipeAddress(ID, platform, base);
      expect(parseDockerPipeHost(address.dockerHost, platform)).toEqual(address);
    }
    for (const [host, platform] of [
      [`npipe:////./pipe/devspaces-${ID}`, 'linux'],
      [`unix:///tmp/devspaces-${ID}/docker.sock`, 'win32'],
      [`npipe:////./pipe/docker_engine`, 'win32'],
      [`npipe:////./pipe/devspaces-${ID.toUpperCase()}`, 'win32'],
      ['unix:///var/run/docker.sock', 'linux'],
      ['ssh://build-box', 'linux'],
      [`unix://tmp/devspaces-${ID}/docker.sock`, 'linux'],
      [`unix:///tmp/../etc/devspaces-${ID}/docker.sock`, 'linux'],
      [`unix:///tmp//devspaces-${ID}/docker.sock`, 'linux'],
      [`unix:///tmp/devspaces-${ID}/other.sock`, 'linux'],
      [`unix:///tmp/devspaces-${ID.slice(1)}/docker.sock`, 'linux'],
      [`unix:///${'z'.repeat(MAX_SOCKET_PATH_BYTES)}/devspaces-${ID}/docker.sock`, 'linux'],
    ] as const) {
      expect(parseDockerPipeHost(host, platform)).toBeUndefined();
    }
  });
});
