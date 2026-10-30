// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough, Readable } from 'stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAbortError } from '../ports';
import { downloadFile, type DownloadResponse, type HttpGet } from './dockerDownload';
import { DOCKER_DESKTOP_DOWNLOADS } from './dockerSetup';

const URL_DMG = DOCKER_DESKTOP_DOWNLOADS.macArm64;

let dir: string;
let target: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-download-'));
  target = path.join(dir, 'Docker.dmg');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function respond(statusCode: number, body: string | Readable = '', headers: Record<string, string> = {}): DownloadResponse {
  return { statusCode, headers, body: typeof body === 'string' ? Readable.from([Buffer.from(body)]) : body };
}

function fakeGet(responses: Record<string, () => DownloadResponse>): { get: HttpGet; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    get: async (url) => {
      urls.push(url);
      const next = responses[url];
      if (!next) throw new Error(`unexpected ${url}`);
      return next();
    },
  };
}

describe('downloadFile', () => {
  it('writes the file and reports the progress with the length', async () => {
    const { get, urls } = fakeGet({ [URL_DMG]: () => respond(200, 'installer', { 'content-length': '9' }) });
    const progress: Array<[number, number | undefined]> = [];
    await downloadFile({ url: URL_DMG, target, get, onProgress: (received, total) => progress.push([received, total]) });
    expect(fs.readFileSync(target, 'utf8')).toBe('installer');
    expect(urls).toEqual([URL_DMG]);
    expect(progress).toEqual([[9, 9]]);
    expect(fs.existsSync(`${target}.download`)).toBe(false);
  });

  it('never writes through a file or link that is at the place of the partial file', async () => {
    const victim = path.join(path.dirname(target), 'victim.txt');
    fs.writeFileSync(victim, 'ORIGINAL');
    fs.symlinkSync(victim, `${target}.download`);
    const { get } = fakeGet({ [URL_DMG]: () => respond(200, 'installer') });
    await downloadFile({ url: URL_DMG, target, get });
    expect(fs.readFileSync(victim, 'utf8')).toBe('ORIGINAL');
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('installer');
  });

  it('follows HTTPS redirects', async () => {
    const mirror = 'https://desktop.docker.com/mac/main/arm64/123456/Docker.dmg';
    const { get, urls } = fakeGet({
      [URL_DMG]: () => respond(302, '', { location: '/mac/main/arm64/123456/Docker.dmg' }),
      [mirror]: () => respond(200, 'dmg'),
    });
    await downloadFile({ url: URL_DMG, target, get });
    expect(urls).toEqual([URL_DMG, mirror]);
    expect(fs.readFileSync(target, 'utf8')).toBe('dmg');
  });

  it('refuses a redirect that leaves HTTPS', async () => {
    const { get } = fakeGet({ [URL_DMG]: () => respond(301, '', { location: 'http://desktop.docker.com/Docker.dmg' }) });
    await expect(downloadFile({ url: URL_DMG, target, get })).rejects.toThrow(/not HTTPS on desktop\.docker\.com/);
    expect(fs.existsSync(target)).toBe(false);
  });

  it.each([
    ['another domain', 'https://desktop.docker.com.evil.example/Docker.dmg', false],
    ['a look-alike domain', 'https://evildocker.com/Docker.dmg', false],
    // Only the download host itself: not even another host of Docker.
    ['another host of Docker', 'https://download.docker.com/Docker.dmg', false],
    ['the hub of Docker', 'https://hub.docker.com/Docker.dmg', false],
    ['a versioned file of the download host', 'https://desktop.docker.com/mac/main/arm64/1/Docker.dmg', true],
  ])('follows a redirect to %s only on desktop.docker.com', async (_name, location, allowed) => {
    const { get } = fakeGet({ [URL_DMG]: () => respond(302, '', { location }), [location]: () => respond(200, 'dmg') });
    const result = downloadFile({ url: URL_DMG, target, get });
    if (allowed) await expect(result).resolves.toBeUndefined();
    else await expect(result).rejects.toThrow(/not HTTPS on desktop\.docker\.com/);
  });

  it('refuses a URL that is not HTTPS on desktop.docker.com, without a request', async () => {
    const { get, urls } = fakeGet({});
    for (const url of ['http://desktop.docker.com/mac/main/arm64/Docker.dmg', 'https://example.com/Docker.dmg']) {
      await expect(downloadFile({ url, target, get })).rejects.toThrow(/desktop\.docker\.com/);
    }
    expect(urls).toEqual([]);
  });

  it('stops after too many redirects', async () => {
    const { get } = fakeGet({ [URL_DMG]: () => respond(302, '', { location: URL_DMG }) });
    await expect(downloadFile({ url: URL_DMG, target, get })).rejects.toThrow(/Too many redirects/);
  });

  it('fails on an HTTP error and keeps an existing file', async () => {
    fs.writeFileSync(target, 'old');
    const { get } = fakeGet({ [URL_DMG]: () => respond(404, 'not found') });
    await expect(downloadFile({ url: URL_DMG, target, get })).rejects.toThrow(/HTTP status 404/);
    expect(fs.readFileSync(target, 'utf8')).toBe('old');
  });

  it('fails on a short download and removes the partial file', async () => {
    const { get } = fakeGet({ [URL_DMG]: () => respond(200, 'inst', { 'content-length': '9' }) });
    await expect(downloadFile({ url: URL_DMG, target, get })).rejects.toThrow(/4 of 9 bytes/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('is cancelled with the signal and removes the partial file', async () => {
    const body = new PassThrough();
    const { get } = fakeGet({ [URL_DMG]: () => respond(200, body) });
    const controller = new AbortController();
    const done = downloadFile({
      url: URL_DMG,
      target,
      get,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });
    body.write(Buffer.from('part'));
    const error = await done.catch((e: unknown) => e);
    expect(isAbortError(error)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('does not start when the signal has aborted', async () => {
    const { get, urls } = fakeGet({ [URL_DMG]: () => respond(200, 'x') });
    const controller = new AbortController();
    controller.abort();
    const error = await downloadFile({ url: URL_DMG, target, get, signal: controller.signal }).catch((e: unknown) => e);
    expect(isAbortError(error)).toBe(true);
    expect(urls).toEqual([]);
  });
});

describe('downloadFile with another host and a pinned file', () => {
  const URL_CLI = 'https://download.docker.com/mac/static/stable/aarch64/docker-1.2.3.tgz';
  const body = 'archive';
  const sha256 = '0b80c1d2de1ad1dd0b5b0d1ccd6cbfd1d8e6a6e9a41e1fde21f1ef01ee4b4d5c';
  const realSha256 = crypto.createHash('sha256').update(body).digest('hex');

  it('takes the file of that host when it has the pinned size and SHA-256', async () => {
    const { get } = fakeGet({ [URL_CLI]: () => respond(200, body, { 'content-length': '7' }) });
    await downloadFile({ url: URL_CLI, target, get, host: 'download.docker.com', expected: { size: 7, sha256: realSha256 } });
    expect(fs.readFileSync(target, 'utf8')).toBe(body);
  });

  it('keeps nothing of a file with another SHA-256 or size', async () => {
    const { get } = fakeGet({ [URL_CLI]: () => respond(200, body) });
    await expect(downloadFile({ url: URL_CLI, target, get, host: 'download.docker.com', expected: { size: 7, sha256 } })).rejects.toThrow('is not the file of its pin');
    const sized = fakeGet({ [URL_CLI]: () => respond(200, body, { 'content-length': '7' }) });
    await expect(downloadFile({ url: URL_CLI, target, get: sized.get, host: 'download.docker.com', expected: { size: 8, sha256: realSha256 } })).rejects.toThrow('not the 8 bytes of its pin');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('refuses another host, also as the target of a redirect, and the default host for another host', async () => {
    await expect(downloadFile({ url: URL_DMG, target, host: 'download.docker.com', get: fakeGet({}).get })).rejects.toThrow('Downloads come only from https://download.docker.com');
    await expect(downloadFile({ url: URL_CLI, target, get: fakeGet({}).get })).rejects.toThrow('Downloads come only from https://desktop.docker.com');
    const { get } = fakeGet({ [URL_CLI]: () => respond(302, '', { location: 'https://download.docker.com.example/x.tgz' }) });
    await expect(downloadFile({ url: URL_CLI, target, get, host: 'download.docker.com' })).rejects.toThrow('which is not HTTPS on download.docker.com');
    await expect(downloadFile({ url: 'https://download.docker.com:8443/x.tgz', target, host: 'download.docker.com', get: fakeGet({}).get })).rejects.toThrow('Downloads come only');
  });

  it('refuses every redirect with maxRedirects 0, also one on the same host', async () => {
    const { get, urls } = fakeGet({ [URL_CLI]: () => respond(302, '', { location: '/mac/static/stable/aarch64/docker-9.9.9.tgz' }) });
    await expect(downloadFile({ url: URL_CLI, target, get, host: 'download.docker.com', maxRedirects: 0 })).rejects.toThrow(
      `The download of ${URL_CLI} was redirected to https://download.docker.com/mac/static/stable/aarch64/docker-9.9.9.tgz; it takes no redirect.`,
    );
    expect(urls).toEqual([URL_CLI]);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('downloadFile with a SHA-256 and redirects to any HTTPS host', () => {
  const URL_WSL = 'https://salsa.debian.org/debian/WSL/-/jobs/1/artifacts/raw/Debian_WSL_AMD64_v1.0.0.0.wsl';
  const STORAGE = 'https://storage.example.org/artifacts/1/Debian.wsl';
  const body = 'distribution';
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');

  it('follows a redirect to another HTTPS host and keeps the file of that SHA-256, without a known size', async () => {
    const { get, urls } = fakeGet({
      [URL_WSL]: () => respond(302, '', { location: STORAGE }),
      [STORAGE]: () => respond(200, body),
    });
    await downloadFile({ url: URL_WSL, target, get, host: 'salsa.debian.org', expected: { sha256: sha256.toUpperCase() }, anyHttpsRedirect: true });
    expect(urls).toEqual([URL_WSL, STORAGE]);
    expect(fs.readFileSync(target, 'utf8')).toBe(body);
  });

  it('keeps nothing of a file with another SHA-256 and names no size', async () => {
    const { get } = fakeGet({ [URL_WSL]: () => respond(302, '', { location: STORAGE }), [STORAGE]: () => respond(200, 'other') });
    await expect(downloadFile({ url: URL_WSL, target, get, host: 'salsa.debian.org', expected: { sha256 }, anyHttpsRedirect: true })).rejects.toThrow(
      `is not the file of its pin: 5 bytes with the SHA-256 ${crypto.createHash('sha256').update('other').digest('hex')}, expected ${sha256}.`,
    );
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('refuses a redirect that leaves HTTPS or names a port, and the first URL of another host', async () => {
    for (const location of ['http://storage.example.org/Debian.wsl', 'https://storage.example.org:8443/Debian.wsl']) {
      const { get } = fakeGet({ [URL_WSL]: () => respond(302, '', { location }) });
      await expect(downloadFile({ url: URL_WSL, target, get, host: 'salsa.debian.org', expected: { sha256 }, anyHttpsRedirect: true })).rejects.toThrow(
        `was redirected to ${location}, which is not HTTPS.`,
      );
    }
    await expect(downloadFile({ url: STORAGE, target, get: fakeGet({}).get, host: 'salsa.debian.org', expected: { sha256 }, anyHttpsRedirect: true })).rejects.toThrow(
      'Downloads come only from https://salsa.debian.org',
    );
  });

  it('refuses redirects to any host without a SHA-256, before a request', async () => {
    const { get, urls } = fakeGet({});
    await expect(downloadFile({ url: URL_WSL, target, get, host: 'salsa.debian.org', anyHttpsRedirect: true })).rejects.toThrow('needs a SHA-256');
    expect(urls).toEqual([]);
  });
});
