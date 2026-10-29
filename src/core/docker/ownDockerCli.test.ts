// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import * as zlib from 'zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger, type Logger } from '../ports';
import pin from './dockerCliPin.json';
import type { HttpGet } from './dockerDownload';
import {
  DOCKER_CLI_DOWNLOAD_HOST,
  dockerCliPlatformKey,
  installOwnDockerCli,
  ownDockerCliDownload,
  ownDockerCliPath,
  OWN_DOCKER_CLI_VERSION,
  presentOwnDockerCli,
  type DockerCliPin,
} from './ownDockerCli';

let folder: string;

beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-cli-'));
});

afterEach(() => {
  fs.rmSync(folder, { recursive: true, force: true });
});

const PROGRAM = Buffer.from('#!/bin/sh\necho "Docker version 1.2.3"\n');

/** A gzip-compressed tar archive with one file (GNU form, as Docker's archives). */
function tgz(name: string, data: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  header.write('0000755\0', 100, 'latin1');
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  header.write('0', 156, 'latin1');
  header.write('ustar  \0', 257, 'latin1');
  return zlib.gzipSync(Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512), Buffer.alloc(1024)]));
}

/** A zip archive with one stored file. */
function zip(name: string, data: Buffer): Buffer {
  const fileName = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(fileName.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + fileName.length, 12);
  end.writeUInt32LE(local.length + fileName.length + data.length, 16);
  return Buffer.concat([local, fileName, data, central, fileName, end]);
}

function pinOf(version: string, key: string, archive: Buffer, extension: string): DockerCliPin {
  return {
    version,
    files: { [key]: { url: `https://${DOCKER_CLI_DOWNLOAD_HOST}/x/docker-${version}.${extension}`, size: archive.length, sha256: crypto.createHash('sha256').update(archive).digest('hex') } },
  };
}

function serving(files: Record<string, Buffer>): { get: HttpGet; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    get: async (url) => {
      urls.push(url);
      const body = files[url];
      if (body === undefined) return { statusCode: 404, headers: {}, body: Readable.from([]) };
      return { statusCode: 200, headers: { 'content-length': String(body.length) }, body: Readable.from([body]) };
    },
  };
}

function logged(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return { logger: { ...silentLogger, info: (line) => lines.push(line), warn: (line) => lines.push(line) }, lines };
}

describe('the pin of the Docker CLI', () => {
  it('names one version and, for each platform, a file of that version on download.docker.com with its size and SHA-256', () => {
    expect(pin.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(OWN_DOCKER_CLI_VERSION).toBe(pin.version);
    const folders: Record<string, string> = {
      'windows-x86_64': 'win/static/stable/x86_64',
      'mac-x86_64': 'mac/static/stable/x86_64',
      'mac-aarch64': 'mac/static/stable/aarch64',
      'linux-x86_64': 'linux/static/stable/x86_64',
      'linux-aarch64': 'linux/static/stable/aarch64',
    };
    expect(Object.keys(pin.files).sort()).toEqual(Object.keys(folders).sort());
    for (const [key, file] of Object.entries(pin.files as DockerCliPin['files'])) {
      const extension = key.startsWith('windows') ? 'zip' : 'tgz';
      expect(file.url).toBe(`https://download.docker.com/${folders[key]}/docker-${pin.version}.${extension}`);
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(file.size).toBeGreaterThan(10_000_000);
    }
  });
});

describe('dockerCliPlatformKey and ownDockerCliDownload', () => {
  it('maps the platforms of VS Code to the builds of Docker, with the x86_64 build for Windows 11 on Arm', () => {
    expect(dockerCliPlatformKey('win32', 'x64', '10.0.19045')).toBe('windows-x86_64');
    expect(dockerCliPlatformKey('win32', 'arm64', '10.0.22631')).toBe('windows-x86_64');
    // Windows 10 on Arm runs no x64 program.
    expect(dockerCliPlatformKey('win32', 'arm64', '10.0.19045')).toBeUndefined();
    expect(dockerCliPlatformKey('win32', 'arm64', '')).toBeUndefined();
    expect(dockerCliPlatformKey('darwin', 'x64')).toBe('mac-x86_64');
    expect(dockerCliPlatformKey('darwin', 'arm64')).toBe('mac-aarch64');
    expect(dockerCliPlatformKey('linux', 'x64')).toBe('linux-x86_64');
    expect(dockerCliPlatformKey('linux', 'arm64')).toBe('linux-aarch64');
    expect(dockerCliPlatformKey('linux', 'arm')).toBeUndefined();
    expect(dockerCliPlatformKey('win32', 'ia32')).toBeUndefined();
    expect(dockerCliPlatformKey('freebsd', 'x64')).toBeUndefined();
  });

  it('names the archive type and the program in it', () => {
    expect(ownDockerCliDownload('win32', 'arm64', undefined, '10.0.26100')).toMatchObject({ kind: 'zip', entry: 'docker/docker.exe', version: pin.version, url: pin.files['windows-x86_64'].url });
    expect(ownDockerCliDownload('darwin', 'arm64')).toMatchObject({ kind: 'tgz', entry: 'docker/docker', sha256: pin.files['mac-aarch64'].sha256 });
    expect(ownDockerCliDownload('linux', 'arm')).toBeUndefined();
    expect(ownDockerCliPath('/s/docker-cli', 'linux', '1.2.3')).toBe(path.join('/s/docker-cli', '1.2.3', 'docker'));
    expect(ownDockerCliPath('/s/docker-cli', 'win32', '1.2.3')).toBe(path.join('/s/docker-cli', '1.2.3', 'docker.exe'));
  });
});

describe('installOwnDockerCli', () => {
  const archive = tgz('docker/docker', PROGRAM);
  const current = pinOf('1.2.3', 'linux-x86_64', archive, 'tgz');
  const url = current.files['linux-x86_64'].url;

  it('downloads the pinned file once for the calls at the same time, keeps only the program, and removes older versions', async () => {
    fs.mkdirSync(path.join(folder, '1.0.0'));
    fs.writeFileSync(path.join(folder, '1.0.0', 'docker'), 'old');
    // A newer version (of a newer Devspaces in another window) and what is no version stay.
    for (const name of ['1.10.0', 'notes']) fs.mkdirSync(path.join(folder, name));
    const { get, urls } = serving({ [url]: archive });
    const { logger, lines } = logged();
    const options = { folder, platform: 'linux' as const, arch: 'x64', logger, pin: current, get };
    const [first, second] = await Promise.all([installOwnDockerCli(options), installOwnDockerCli(options)]);
    const target = path.join(folder, '1.2.3', 'docker');
    expect([first, second]).toEqual([target, target]);
    expect(urls).toEqual([url]);
    expect(fs.readFileSync(target)).toEqual(PROGRAM);
    if (process.platform !== 'win32') expect(fs.statSync(target).mode & 0o777).toBe(0o755);
    expect(fs.readdirSync(folder).sort()).toEqual(['1.10.0', '1.2.3', 'notes']);
    expect(fs.readdirSync(path.join(folder, '1.2.3'))).toEqual(['docker']);
    expect(lines).toEqual([
      'The Docker CLI 1.0.0 of Devspaces was removed.',
      `The Docker CLI 1.2.3 of Devspaces is downloaded from ${url}.`,
      `The Docker CLI 1.2.3 of Devspaces is installed: ${target}`,
    ]);
    // Installed: no download.
    await expect(installOwnDockerCli(options)).resolves.toBe(target);
    expect(urls).toEqual([url]);
  });

  it('takes the program out of the zip archive on Windows', async () => {
    const windows = zip('docker/docker.exe', PROGRAM);
    const windowsPin = pinOf('1.2.3', 'windows-x86_64', windows, 'zip');
    const { get } = serving({ [windowsPin.files['windows-x86_64'].url]: windows });
    const target = await installOwnDockerCli({ folder, platform: 'win32', arch: 'x64', logger: silentLogger, pin: windowsPin, get });
    expect(target).toBe(path.join(folder, '1.2.3', 'docker.exe'));
    expect(fs.readFileSync(target)).toEqual(PROGRAM);
  });

  it('keeps nothing of a file that is not the pinned one, and refuses a platform without a build', async () => {
    // The same size, another byte.
    const other = Buffer.from(archive);
    other[20] ^= 0xff;
    const { get } = serving({ [url]: other });
    await expect(installOwnDockerCli({ folder, platform: 'linux', arch: 'x64', logger: silentLogger, pin: current, get })).rejects.toThrow('is not the file of its pin');
    expect(fs.readdirSync(path.join(folder, '1.2.3'))).toEqual([]);
    await expect(installOwnDockerCli({ folder, platform: 'linux', arch: 'arm', logger: silentLogger, pin: current, get })).rejects.toThrow('Docker publishes no Docker CLI for linux on arm');
  });

  it('stops a download that receives no bytes for the stall time, and keeps nothing of it', async () => {
    const get: HttpGet = async () => ({
      statusCode: 200,
      headers: { 'content-length': String(archive.length) },
      body: new Readable({ read() {} }),
    });
    await expect(installOwnDockerCli({ folder, platform: 'linux', arch: 'x64', logger: silentLogger, pin: current, get, stalledAfterMs: 50 })).rejects.toThrow(
      `The download of ${url} received no bytes for 0 seconds.`,
    );
    expect(fs.readdirSync(path.join(folder, '1.2.3'))).toEqual([]);
    // A cancel is no stall: the AbortError stays.
    const controller = new AbortController();
    const install = installOwnDockerCli({ folder, platform: 'linux', arch: 'x64', logger: silentLogger, pin: current, get, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(install).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('removes the parts of an earlier download after an hour, and no other file', async () => {
    const versionFolder = path.join(folder, '1.2.3');
    fs.mkdirSync(versionFolder);
    const old = Date.now() / 1000 - 2 * 3600;
    for (const name of ['archive-0123abcd.tgz', 'archive-0123abcd.tgz.download', 'docker-0123abcd.part', 'notes.txt']) {
      fs.writeFileSync(path.join(versionFolder, name), 'x');
      fs.utimesSync(path.join(versionFolder, name), old, old);
    }
    fs.writeFileSync(path.join(versionFolder, 'docker-89abcdef.part'), 'new');
    const { get } = serving({ [url]: archive });
    await installOwnDockerCli({ folder, platform: 'linux', arch: 'x64', logger: silentLogger, pin: current, get });
    expect(fs.readdirSync(versionFolder).sort()).toEqual(['docker', 'docker-89abcdef.part', 'notes.txt']);
  });
});

describe('presentOwnDockerCli', () => {
  it('finds the installed program of the pinned version only, never a link', () => {
    expect(presentOwnDockerCli(folder, 'linux', 'x64')).toBeUndefined();
    const target = ownDockerCliPath(folder, 'linux');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, PROGRAM);
    expect(presentOwnDockerCli(folder, 'linux', 'x64')).toBe(target);
    expect(presentOwnDockerCli(folder, 'linux', 'arm')).toBeUndefined();
    if (process.platform !== 'win32') {
      fs.rmSync(target);
      fs.symlinkSync('/bin/sh', target);
      expect(presentOwnDockerCli(folder, 'linux', 'x64')).toBeUndefined();
    }
  });
});
