// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The header User-Agent of the HTTPS requests of Devspaces: `nimblescape-devspaces/<version>`, with the version that
// each program sets at its start (setUserAgentVersion): the extension the version of its manifest, the programs in
// containers the value of DEVSPACES_VERSION. No bundle holds the version. Without a version x.y.z, the header is
// `nimblescape-devspaces`. It goes out with each request and each streamed download of httpsRequest and httpsStream,
// through the transport of the extension (nodeHttpsTransport) and the transport of the worker and the Monitor
// (proxiedHttpsTransport), and with the download of Docker Desktop. A request that names a User-Agent of its own keeps
// it.
import * as fs from 'fs';
import * as http from 'http';
import type * as https from 'https';
import * as net from 'net';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** Each call of https.request and https.get: the code calls the module of Node.js through this mock. */
const calls = vi.hoisted(() => [] as Array<{ fn: 'request' | 'get'; url: unknown; options: https.RequestOptions }>);
vi.mock('https', async (original) => {
  const actual = await original<typeof import('https')>();
  const spy =
    (fn: 'request' | 'get') =>
    (...args: unknown[]): unknown => {
      calls.push({ fn, url: args[0], options: args[1] as https.RequestOptions });
      return (actual[fn] as (...rest: unknown[]) => unknown)(...args);
    };
  return { ...actual, request: spy('request'), get: spy('get') };
});

import { nodeHttpsGet } from './docker/dockerDownload';
import {
  VERSION_ENV,
  httpsRequest,
  httpsStream,
  isDevspacesVersion,
  nodeHttpsTransport,
  setUserAgentVersion,
  takeUserAgentVersion,
  userAgent,
  userAgentVersion,
} from './http';
import { proxiedHttpsTransport } from './proxyTransport';

const ROOT = path.resolve(__dirname, '..', '..');
/** The version that the requests below name. */
const VERSION = '1.20.3';
const EXPECTED = `nimblescape-devspaces/${VERSION}`;

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  calls.length = 0;
  setUserAgentVersion(undefined);
  for (const close of closers.splice(0)) await close();
});

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  return (server.address() as net.AddressInfo).port;
}

/** A plain HTTP server (httpsRequest and httpsStream get a plain connection to it) that keeps the headers of each request. */
async function recorder(): Promise<{ connect: () => net.Socket; requests: http.IncomingMessage[] }> {
  const requests: http.IncomingMessage[] = [];
  const port = await listen(
    http.createServer((req, res) => {
      requests.push(req);
      res.writeHead(200, { 'content-length': '2' });
      res.end('ok');
    }),
  );
  return { connect: () => net.connect(port, '127.0.0.1'), requests };
}

/** An HTTPS address on this computer whose server closes each connection: a request fails at once. */
async function closingUrl(): Promise<string> {
  const port = await listen(net.createServer((socket) => socket.destroy()));
  return `https://127.0.0.1:${port}/x`;
}

/** The User-Agent values of the requests that the code started, and how often each request named one. */
function sentAgents(): string[] {
  return calls.map(({ options }) => {
    const headers = (options.headers ?? {}) as Record<string, string>;
    const names = Object.keys(headers).filter((name) => name.toLowerCase() === 'user-agent');
    return names.length === 1 ? headers[names[0]] : `${names.length} headers`;
  });
}

describe('the User-Agent of Devspaces', () => {
  it('is nimblescape-devspaces until the program sets its version, then nimblescape-devspaces/<version>', () => {
    expect(userAgent()).toBe('nimblescape-devspaces');
    expect(userAgentVersion()).toBeUndefined();
    expect(setUserAgentVersion(VERSION)).toBe(true);
    expect(userAgent()).toBe(EXPECTED);
    expect(userAgentVersion()).toBe(VERSION);
    expect(VERSION_ENV).toBe('DEVSPACES_VERSION');
  });

  it('takes only a version x.y.z; any other value leaves the header without a version', () => {
    for (const version of ['0.6.0', '1.20.3', '10.0.11']) expect(isDevspacesVersion(version), version).toBe(true);
    for (const version of ['0.6', '0.6.0-beta.1', 'v0.6.0', '06.0.0', '0.6.0\r\nX-Other: 1', ' 0.6.0', '', 6, undefined, null, { major: 0 }]) {
      expect(isDevspacesVersion(version), JSON.stringify(version)).toBe(false);
      setUserAgentVersion(VERSION);
      expect(setUserAgentVersion(version), JSON.stringify(version)).toBe(false);
      expect(userAgent()).toBe('nimblescape-devspaces');
      expect(userAgentVersion()).toBeUndefined();
    }
  });

  it('the version of package.json is a version x.y.z, which the extension takes from its manifest', () => {
    const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: unknown };
    expect(isDevspacesVersion(version)).toBe(true);
  });

  it('a program with a log says once that its version is missing or invalid', () => {
    expect(takeUserAgentVersion(VERSION, 'The version')).toBeUndefined();
    expect(userAgent()).toBe(EXPECTED);
    expect(takeUserAgentVersion(undefined, 'The version (DEVSPACES_VERSION)')).toBe(
      'The version (DEVSPACES_VERSION) is missing, so the HTTPS requests send the User-Agent nimblescape-devspaces without a version.',
    );
    expect(userAgent()).toBe('nimblescape-devspaces');
    expect(takeUserAgentVersion('0.6', 'The version of the manifest')).toBe(
      'The version of the manifest is not a version x.y.z ("0.6"), so the HTTPS requests send the User-Agent nimblescape-devspaces without a version.',
    );
  });

  it('goes out with each request and each streamed GET; a request with a User-Agent of its own keeps it', async () => {
    setUserAgentVersion(VERSION);
    const server = await recorder();
    const options = { createConnection: server.connect };
    expect((await httpsRequest({ method: 'GET', url: 'https://update.code.visualstudio.com/api/x', headers: { Accept: 'application/json' } }, undefined, options)).status).toBe(200);
    expect((await httpsRequest({ method: 'POST', url: 'https://marketplace.visualstudio.com/_apis/x', body: '{}' }, undefined, options)).status).toBe(200);
    const streamed = await httpsStream('https://update.code.visualstudio.com/commit:x/server-linux-x64/stable', undefined, options);
    streamed.body.resume();
    await new Promise((resolve) => streamed.body.once('end', resolve));
    expect((await httpsRequest({ method: 'GET', url: 'https://registry.example.com/v2/', headers: { 'user-agent': 'other/1' } }, undefined, options)).status).toBe(200);
    const agents = server.requests.map((req) => req.rawHeaders.filter((_value, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === 'user-agent').length);
    // One header each.
    expect(agents).toEqual([1, 1, 1, 1]);
    expect(server.requests.map((req) => req.headers['user-agent'])).toEqual([EXPECTED, EXPECTED, EXPECTED, 'other/1']);
    expect(server.requests[0].headers.accept).toBe('application/json');
  });

  it('goes out through the transport of the extension (nodeHttpsTransport)', async () => {
    setUserAgentVersion(VERSION);
    const url = await closingUrl();
    await expect(nodeHttpsTransport.request({ method: 'GET', url, headers: { Accept: 'application/json' } })).rejects.toThrow();
    expect(calls.map(({ fn }) => fn)).toEqual(['request']);
    expect(sentAgents()).toEqual([EXPECTED]);
    expect((calls[0].options.headers as Record<string, string>).Accept).toBe('application/json');
  });

  it('goes out through the transport of the worker and the Monitor (proxiedHttpsTransport), with its requests and its downloads', async () => {
    setUserAgentVersion(VERSION);
    const url = await closingUrl();
    // Without a proxy: the connection goes to the host of the URL, the request is the same.
    const transport = proxiedHttpsTransport(async () => ({}));
    await expect(transport.request({ method: 'POST', url, body: '{}', headers: { 'Content-Type': 'application/json' } })).rejects.toThrow();
    await expect(transport.stream(url)).rejects.toThrow();
    expect(calls.map(({ fn }) => fn)).toEqual(['request', 'request']);
    expect(sentAgents()).toEqual([EXPECTED, EXPECTED]);
  });

  it('goes out with the download of Docker Desktop (nodeHttpsGet)', async () => {
    setUserAgentVersion(VERSION);
    const url = await closingUrl();
    await expect(nodeHttpsGet(url, new AbortController().signal)).rejects.toThrow();
    expect(calls.map(({ fn }) => fn)).toEqual(['get']);
    expect(sentAgents()).toEqual([EXPECTED]);
  });

  it('is read at each request: a request before the version is set has no version', async () => {
    const url = await closingUrl();
    await expect(nodeHttpsTransport.request({ method: 'GET', url })).rejects.toThrow();
    setUserAgentVersion(VERSION);
    await expect(nodeHttpsTransport.request({ method: 'GET', url })).rejects.toThrow();
    expect(sentAgents()).toEqual(['nimblescape-devspaces', EXPECTED]);
  });
});
