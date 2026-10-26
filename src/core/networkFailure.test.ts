// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The failures of the network: an error of the Monitor's background run (isNetworkError) by its name, code, message
// (with the texts of isNetworkFailure) and causes, where a refusal of a reachable server is none; and the texts of the
// flows (isNetworkFailure).
import { describe, expect, it } from 'vitest';
import { isNetworkError, isNetworkFailure, isServerAnswer } from './networkFailure';

describe('the failures of the network of an error', () => {
  const coded = (code: string) => Object.assign(new Error(`connect ${code} 1.2.3.4:443`), { code });

  it.each([
    ['no name resolution', coded('ENOTFOUND')],
    ['a name resolution that failed for now', coded('EAI_AGAIN')],
    ['a refused connection', coded('ECONNREFUSED')],
    ['a connection that broke off', coded('ECONNRESET')],
    ['an aborted connection', coded('ECONNABORTED')],
    ['a connection without an answer', coded('ETIMEDOUT')],
    ['an unreachable network', coded('ENETUNREACH')],
    ['a network that is down', coded('ENETDOWN')],
    ['an unreachable host', coded('EHOSTUNREACH')],
    ['a host that is down', coded('EHOSTDOWN')],
    ['a closed connection', coded('EPIPE')],
    ['an abort', Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })],
    ['a time limit', Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })],
    ['a pull without name resolution', new Error('Get "https://registry-1.docker.io/v2/": dial tcp: lookup registry-1.docker.io: no such host')],
    ['a pull without an answer', new Error('Get "https://ghcr.io/v2/": dial tcp 140.82.1.1:443: i/o timeout')],
    ['a pull with a refused connection', new Error('dial tcp 127.0.0.1:5000: connect: connection refused')],
    ['a pull with a connection that broke off', new Error('read tcp 10.0.0.2:5000: read: connection reset by peer')],
    ['a pull without network', new Error('dial tcp: connect: network is unreachable')],
    ['a pull without a route', new Error('dial tcp 10.1.1.1:443: connect: no route to host')],
    ['a pull with a slow TLS handshake', new Error('net/http: TLS handshake timeout')],
    ['a pull with a slow registry', new Error('net/http: request canceled (Client.Timeout exceeded while awaiting headers)')],
    ['a pull past its deadline', new Error('context deadline exceeded')],
    ['a name resolution that failed for now (resolver)', new Error('lookup ghcr.io: Temporary failure in name resolution')],
    ['a proxy without an answer', new Error('The proxy proxy.example of the Docker engine did not answer within 10 seconds.')],
    ['a time limit of the monitor', new Error('no answer in time')],
    ['a server error', new Error('the update service answered HTTP 503')],
    ['a rate limit', new Error('the download answered HTTP 429')],
    ['a message alone', 'dial tcp: lookup example: no such host'],
    ['a cause', new Error('fetch failed', { cause: coded('ENOTFOUND') })],
  ])('counts %s', (_label, error) => {
    expect(isNetworkError(error)).toBe(true);
  });

  it.each([
    ['an image that the registry does not have', new Error('manifest for example/app:1 not found: manifest unknown')],
    ['a private image', new Error('pull access denied for example/private, repository does not exist or may require docker login')],
    ['a version that is gone', new Error('the update service answered HTTP 404')],
    ['a refused download', new Error('the download answered HTTP 403')],
    ['a wrong checksum', new Error('the SHA-256 of the archive differs')],
    ['a full disk', Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })],
    ['a missing file', Object.assign(new Error('no such file'), { code: 'ENOENT' })],
    ['no error', undefined],
    ['null', null],
    ['a number', 503],
    ['a word in another word', new Error('the field host_name_resolution_disabled')],
  ])('does not count %s', (_label, error) => {
    expect(isNetworkError(error)).toBe(false);
  });

  it('follows the causes at most 4 deep', () => {
    let error: unknown = Object.assign(new Error('x'), { code: 'ENOTFOUND' });
    for (let depth = 0; depth < 4; depth++) error = new Error('wrapped', { cause: error });
    expect(isNetworkError(error)).toBe(true);
    expect(isNetworkError(new Error('wrapped', { cause: error }))).toBe(false);
  });
});

describe('the texts of a failure of the network', () => {
  it('counts the messages of curl, Docker and Node.js, and the "unable to access" of Git without an HTTP status', () => {
    expect(isNetworkFailure("fatal: unable to access 'https://github.com/a/b/': Could not resolve host: github.com")).toBe(true);
    expect(isNetworkFailure('dial tcp: lookup ghcr.io: no such host')).toBe(true);
    expect(isNetworkFailure("fatal: unable to access 'https://github.com/a/b/': The requested URL returned error: 403")).toBe(false);
    expect(isNetworkFailure('the update service answered HTTP 503')).toBe(false);
  });
});

describe('a failure that an answer of a server caused', () => {
  it('counts a refusal and an answer that cannot be read; not a failure of the network, nor one without an answer', () => {
    expect(isServerAnswer(new Error('the update service answered HTTP 404'))).toBe(true);
    expect(isServerAnswer(new Error('the Marketplace answered no list of extensions'))).toBe(true);
    expect(isServerAnswer(new Error('the update service answered HTTP 503'))).toBe(false);
    expect(isServerAnswer(Object.assign(new Error('Hostname/IP does not match certificate'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }))).toBe(false);
    expect(isServerAnswer(new Error('The request ended before the proxy settings of the Docker engine were read.'))).toBe(false);
    expect(isServerAnswer('the update service answered HTTP 404')).toBe(false);
  });
});
