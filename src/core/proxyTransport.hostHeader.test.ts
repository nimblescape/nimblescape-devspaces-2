// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The header Host of a request and of a streamed GET through the tunnel of the daemon's proxy: the name of the host
// without a port for the default port of HTTPS, and with the port of the URL otherwise. With `<host>:80`, ghcr.io
// answers 404 and the CDN of the Marketplace 403, so no image check, no pull and no extension download would work
// behind a proxy (Docker Desktop names one for its daemon). Every server here is local (127.0.0.1); a name in a URL is
// only ever the target of a CONNECT at a local proxy. A test certificate (made here, for the names of the URLs) is added
// to the trusted ones of each `tls.connect` (vi.mock), as in proxyTransport.loopbackAndIpCertificate.test.ts.
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { proxiedHttpsTransport } from './proxyTransport';

const trusted = vi.hoisted(() => [] as string[]);
vi.mock('tls', async (importOriginal) => {
  const original = await importOriginal<typeof import('tls')>();
  const connect = ((options: import('tls').ConnectionOptions) => original.connect({ ca: [...original.rootCertificates, ...trusted], ...options })) as typeof original.connect;
  return { ...original, default: { ...original, connect }, connect };
});

describe('the header Host through the tunnel of the proxy', () => {
  let dir: string;
  let key: Buffer;
  let cert: Buffer;
  const closers: (() => Promise<void>)[] = [];
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-proxy-host-'));
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=probe', '-addext', 'subjectAltName=DNS:registry.example.test,DNS:cdn.example.test', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')],
      { stdio: 'ignore' },
    );
    key = fs.readFileSync(path.join(dir, 'key.pem'));
    cert = fs.readFileSync(path.join(dir, 'cert.pem'));
    trusted.push(cert.toString());
  });
  afterAll(() => {
    trusted.length = 0;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  async function listen(server: net.Server): Promise<number> {
    const sockets = new Set<net.Socket>();
    server.on('connection', (socket: net.Socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(
      () =>
        new Promise((resolve) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => resolve());
        }),
    );
    return (server.address() as net.AddressInfo).port;
  }

  /**
   * An HTTPS server for the names of the certificate that records the header Host of each request, and a proxy that
   * pipes every tunnel to it (`connects`: the target of each CONNECT).
   */
  async function serverBehindProxy(): Promise<{ hosts: Array<string | undefined>; connects: string[]; transport: ReturnType<typeof proxiedHttpsTransport> }> {
    const hosts: Array<string | undefined> = [];
    const serverPort = await listen(
      https.createServer({ key, cert }, (req, res) => {
        hosts.push(req.headers.host);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end('body');
      }),
    );
    const connects: string[] = [];
    const proxy = http.createServer();
    proxy.on('connect', (req: http.IncomingMessage, client: net.Socket) => {
      connects.push(req.url ?? '');
      const upstream = net.connect(serverPort, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
    });
    const proxyPort = await listen(proxy);
    return { hosts, connects, transport: proxiedHttpsTransport(async () => ({ httpsProxy: `http://127.0.0.1:${proxyPort}` })) };
  }

  it('a request names the host without a port for 443, and with the port of the URL for another one', async () => {
    const { hosts, connects, transport } = await serverBehindProxy();
    expect((await transport.request({ method: 'HEAD', url: 'https://registry.example.test/v2/owner/image/manifests/2' })).status).toBe(200);
    expect((await transport.request({ method: 'GET', url: 'https://registry.example.test:443/token' })).status).toBe(200);
    expect((await transport.request({ method: 'GET', url: 'https://registry.example.test:5000/v2/' })).status).toBe(200);
    expect(connects).toEqual(['registry.example.test:443', 'registry.example.test:443', 'registry.example.test:5000']);
    expect(hosts).toEqual(['registry.example.test', 'registry.example.test', 'registry.example.test:5000']);
  });

  it('a streamed GET (a download of the store) names the host without a port too', async () => {
    const { hosts, connects, transport } = await serverBehindProxy();
    const response = await transport.stream('https://cdn.example.test/extensions/publisher/name/1.0.0/Microsoft.VisualStudio.Services.VSIXPackage');
    expect(response.status).toBe(200);
    const chunks: Buffer[] = [];
    for await (const chunk of response.body) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('body');
    expect(connects).toEqual(['cdn.example.test:443']);
    expect(hosts).toEqual(['cdn.example.test']);
  });
});
