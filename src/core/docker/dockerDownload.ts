// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Downloads from Docker, only over HTTPS and only from one host: the Docker Desktop installer (desktop.docker.com), and
// the Docker CLI of Devspaces (download.docker.com, with its pinned SHA-256; ownDockerCli.ts).
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import { pipeline } from 'stream/promises';
import { userAgent } from '../http';
import { abortError } from '../ports';
import { DOCKER_DOWNLOAD_HOST } from './dockerSetup';

const MAX_REDIRECTS = 5;

/** A response of GET: the status, the headers (names in lower case), and the body as a stream. */
export interface DownloadResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: NodeJS.ReadableStream;
}

/** GET of one URL, without following redirects. Rejects with an AbortError when the signal aborts. */
export type HttpGet = (url: string, signal: AbortSignal) => Promise<DownloadResponse>;

/**
 * GET with the Node.js `https` module (VS Code applies its proxy settings to it in the extension host), with the
 * User-Agent of Devspaces.
 */
export const nodeHttpsGet: HttpGet = (url, signal) =>
  new Promise((resolve, reject) => {
    const request = https.get(url, { signal, headers: { 'User-Agent': userAgent() } }, (response) => {
      resolve({ statusCode: response.statusCode ?? 0, headers: response.headers, body: response });
    });
    request.on('error', reject);
  });

export interface DownloadOptions {
  /** HTTPS URL of `host`. */
  url: string;
  /** The only host of the download and of its redirects. Default: desktop.docker.com (DOCKER_DOWNLOAD_HOST). */
  host?: string;
  /** The SHA-256 (hex) and the size in bytes that the file must have; it is not kept otherwise. */
  expected?: { sha256: string; size: number };
  /** The file to write. A partial download is written next to it (`.download`) and removed on failure. */
  target: string;
  signal?: AbortSignal;
  /** Called while bytes arrive; `total` from Content-Length, when known. */
  onProgress?: (received: number, total: number | undefined) => void;
  /** For tests. Default: `nodeHttpsGet`. */
  get?: HttpGet;
}

/** True for an HTTPS URL of `host` (also the target of a redirect is checked with it). */
export function isHttpsUrlOf(url: string, host: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === host && parsed.port === '';
  } catch {
    return false;
  }
}

function header(headers: DownloadResponse['headers'], name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Ends a response that is not read, so that its connection is released. */
function discard(response: DownloadResponse): void {
  const body = response.body as NodeJS.ReadableStream & { destroy?: () => void };
  body.destroy?.();
}

/**
 * Downloads `url` to `target`. Throws when the URL, or the target of a redirect, is not an HTTPS URL of `host`, on an
 * HTTP error, when the file has not the `expected` size and SHA-256, and with an AbortError when the signal aborts.
 * Existing `target` is replaced only after a complete download.
 */
export async function downloadFile(options: DownloadOptions): Promise<void> {
  const get = options.get ?? nodeHttpsGet;
  const signal = options.signal ?? new AbortController().signal;
  const host = options.host ?? DOCKER_DOWNLOAD_HOST;
  const { expected } = options;
  if (!isHttpsUrlOf(options.url, host)) throw new Error(`Downloads come only from https://${host}: ${options.url}`);
  // The partial file is always a new file ('wx' below), never one that exists or a link that another program put there.
  // Removed before the request: the body must not start to flow before the pipeline reads it.
  await fs.promises.rm(`${options.target}.download`, { force: true });
  let url = options.url;
  let response: DownloadResponse | undefined;
  for (let redirects = 0; ; redirects++) {
    if (signal.aborted) throw abortError();
    response = await get(url, signal);
    const location = header(response.headers, 'location');
    if (response.statusCode < 300 || response.statusCode >= 400 || !location) break;
    discard(response);
    if (redirects >= MAX_REDIRECTS) throw new Error(`Too many redirects for ${options.url}.`);
    const next = new URL(location, url).href;
    // Docker's link of the latest version points to a versioned file of the same host: a redirect never leaves it.
    if (!isHttpsUrlOf(next, host)) {
      throw new Error(`The download of ${options.url} was redirected to ${next}, which is not HTTPS on ${host}.`);
    }
    url = next;
  }
  if (response.statusCode !== 200) {
    discard(response);
    throw new Error(`The download of ${url} failed with HTTP status ${response.statusCode}.`);
  }
  const length = Number.parseInt(header(response.headers, 'content-length') ?? '', 10);
  const total = Number.isFinite(length) && length >= 0 ? length : undefined;
  if (expected !== undefined && total !== undefined && total !== expected.size) {
    discard(response);
    throw new Error(`The download of ${url} has ${total} bytes, not the ${expected.size} bytes of its pin.`);
  }
  const hash = crypto.createHash('sha256');
  let received = 0;
  response.body.on('data', (chunk: Buffer) => {
    received += chunk.length;
    hash.update(chunk);
    options.onProgress?.(received, total);
  });
  const partial = `${options.target}.download`;
  try {
    await pipeline(response.body, fs.createWriteStream(partial, { flags: 'wx' }), { signal });
    if (total !== undefined && received !== total) {
      throw new Error(`The download of ${url} ended after ${received} of ${total} bytes.`);
    }
    if (expected !== undefined) {
      const sha256 = hash.digest('hex');
      if (received !== expected.size || sha256 !== expected.sha256.toLowerCase()) {
        throw new Error(`The download of ${url} is not the file of its pin: ${received} bytes with the SHA-256 ${sha256}, expected ${expected.size} bytes with ${expected.sha256}.`);
      }
    }
    await fs.promises.rename(partial, options.target);
  } catch (error) {
    await fs.promises.rm(partial, { force: true }).catch(() => undefined);
    if (signal.aborted) throw abortError();
    throw error;
  }
}
