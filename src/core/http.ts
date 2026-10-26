// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as https from 'https';
import type { Readable } from 'stream';

export interface HttpRequest {
  method: 'GET' | 'HEAD' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: string;
  /**
   * The largest body that httpsRequest reads for this request (lower than MAX_BODY_BYTES; never higher); a larger one
   * fails as "too large".
   */
  maxBodyBytes?: number;
}

export interface HttpResponse {
  status: number;
  /** Header names in lower case. */
  headers: Record<string, string>;
  /** Body as text. Empty for HEAD. */
  body: string;
}

/**
 * HTTP client interface, so that tests can replace the network.
 * `request` rejects when the connection fails (for example a failed name resolution),
 * and with an `AbortError` when the signal aborts.
 */
export interface HttpTransport {
  request(request: HttpRequest, signal?: AbortSignal): Promise<HttpResponse>;
}

const MAX_BODY_BYTES = 16 * 1024 * 1024;

/** The name of the product in the header User-Agent of the HTTPS requests of Devspaces. */
export const USER_AGENT_PRODUCT = 'nimblescape-devspaces';

/**
 * The environment variable that carries the version of Devspaces to its programs in containers: the extension starts
 * the worker with it (channelRunArgs), the worker creates the Monitor with it (RemoteSessionMonitor.runSpec), and the
 * Monitor starts the workers of its prepares with it (prepares.ts). No bundle holds the version, so a new version
 * without a change of the code builds the same files.
 */
export const VERSION_ENV = 'DEVSPACES_VERSION';

/** A version x.y.z of numbers without leading zeros, the form of `version` in package.json. */
const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** True for a version x.y.z of numbers without leading zeros (for example 0.6.0). */
export function isDevspacesVersion(value: unknown): value is string {
  return typeof value === 'string' && EXACT_VERSION.test(value);
}

/** The version of this program for the header User-Agent (setUserAgentVersion); none until it is set. */
let version: string | undefined;

/**
 * Sets the version that the header User-Agent names. Each program sets it once at its start: the extension takes the
 * version of its manifest (activate); the worker, the Monitor and the workers of its prepares take the value of
 * VERSION_ENV. A value that is not a version x.y.z leaves the header without a version. Returns whether the value was a
 * version.
 */
export function setUserAgentVersion(value: unknown): boolean {
  version = isDevspacesVersion(value) ? value : undefined;
  return version !== undefined;
}

/**
 * The version that setUserAgentVersion took, if any: the value of VERSION_ENV for the programs that this one starts.
 */
export function userAgentVersion(): string | undefined {
  return version;
}

/**
 * setUserAgentVersion at the start of a program that has a log; returns the line for that log when `value` is not a
 * version x.y.z, and undefined when it is one. `source` names where the value comes from.
 */
export function takeUserAgentVersion(value: unknown, source: string): string | undefined {
  if (setUserAgentVersion(value)) return undefined;
  const found = value === undefined ? 'is missing' : `is not a version x.y.z (${JSON.stringify(value)})`;
  return `${source} ${found}, so the HTTPS requests send the User-Agent ${USER_AGENT_PRODUCT} without a version.`;
}

/**
 * The header User-Agent of the HTTPS requests of Devspaces: `nimblescape-devspaces/<version>`, or
 * `nimblescape-devspaces` when this program has no version (setUserAgentVersion). httpsRequest and httpsStream send
 * it; the clients of GitHub (githubApi.ts) and of the registries (registryClient.ts), the download of Docker Desktop
 * (dockerDownload.ts) and the tunnel through the proxy of a Docker daemon (proxyTransport.ts) send it too.
 */
export function userAgent(): string {
  return version === undefined ? USER_AGENT_PRODUCT : `${USER_AGENT_PRODUCT}/${version}`;
}

/**
 * One request with the Node.js `https` module; `options` adds to the request (the connection through a proxy). It sends
 * the userAgent() unless the request has a User-Agent of its own. The body is read up to MAX_BODY_BYTES (or the lower
 * `request.maxBodyBytes`).
 */
export function httpsRequest(request: HttpRequest, signal: AbortSignal | undefined, options: https.RequestOptions = {}): Promise<HttpResponse> {
  const maxBytes = Math.min(MAX_BODY_BYTES, request.maxBodyBytes ?? MAX_BODY_BYTES);
  return new Promise((resolve, reject) => {
    const req = https.request(
      request.url,
      { ...options, method: request.method, headers: { 'User-Agent': userAgent(), ...request.headers }, signal },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            // Rejected here, not by the destroy alone (a body that came in one chunk would end first and resolve
            // without its content).
            const error = new Error(`Response of ${request.url} is too large.`);
            reject(error);
            req.destroy(error);
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, headers: responseHeaders(res), body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (request.body !== undefined) req.end(request.body);
    else req.end();
  });
}

/**
 * A response whose body is read as it comes (a download to a file), never buffered or decoded. The caller reads `body`
 * to its end or destroys it.
 */
export interface HttpStreamResponse {
  status: number;
  /** Header names in lower case. */
  headers: Record<string, string>;
  body: Readable;
}

/**
 * A transport that streams the body of a GET (no redirect is followed; the caller decides). Rejects as
 * HttpTransport.request does; an abort of `signal` also ends the reading of the body.
 */
export interface HttpStreamTransport {
  stream(url: string, signal?: AbortSignal): Promise<HttpStreamResponse>;
}

/** The headers of a response, names in lower case. */
function responseHeaders(res: { headers: Record<string, string | string[] | undefined> }): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(res.headers)) {
    if (value === undefined) continue;
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return headers;
}

/**
 * One GET with the Node.js `https` module whose body is streamed (HttpStreamTransport), with the userAgent(); `options`
 * as in httpsRequest (the connection through a proxy).
 */
export function httpsStream(url: string, signal: AbortSignal | undefined, options: https.RequestOptions = {}): Promise<HttpStreamResponse> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { ...options, method: 'GET', headers: { 'User-Agent': userAgent() }, signal }, (res) => {
      resolve({ status: res.statusCode ?? 0, headers: responseHeaders(res), body: res });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Transport with the Node.js `https` module. In the extension host, VS Code applies its proxy settings to this module.
 */
export const nodeHttpsTransport: HttpTransport = {
  request: (request, signal) => httpsRequest(request, signal),
};
