// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// `secret registry` on the side of the extension: only the login of the registry of the image or Feature that the
// request names, with a valid host name, one request at a time, at most MAX_LOGIN_REGISTRIES registries and
// MAX_LOGIN_REQUESTS requests of an operation, and a line in the log for each request.
import { describe, expect, it } from 'vitest';
import { SECRET_REGISTRY } from '../helperChannel/protocol';
import { parseFeatureReference, parseImageReference } from '../imageCheck/reference';
import type { Logger } from '../ports';
import type { HostRegistryLogin, HostSide } from './hostSide';
import { MAX_LOGIN_REGISTRIES, MAX_LOGIN_REQUESTS, hostSideHandler } from './hostSideHandler';

/** A handler of an open of acme/api whose computer has the logins of `stored`; `asked`: the requests that reached it. */
function wired(stored: Record<string, HostRegistryLogin | (() => Promise<HostRegistryLogin | undefined>)> = {}) {
  const asked: string[] = [];
  const lines: string[] = [];
  const logger: Logger = {
    info: (text) => void lines.push(`info ${text}`),
    warn: (text) => void lines.push(`warn ${text}`),
    error: (text) => void lines.push(`error ${text}`),
    output: () => undefined,
  };
  const host = {
    secrets: {
      token: async () => undefined,
      registry: async (registry: string, repository: string) => {
        asked.push(`${registry}/${repository}`);
        const login = stored[registry];
        return typeof login === 'function' ? login() : login;
      },
    },
  } as unknown as HostSide;
  const handler = hostSideHandler(host, logger, ['secret registry'], { repository: 'acme/api', dockerHost: '' });
  const signal = new AbortController().signal;
  const ask = (...args: unknown[]) => handler('secret', { call: 'registry', args }, signal);
  const send = (payload: unknown) => handler('secret', payload, signal);
  const refusals = () => lines.filter((line) => line.startsWith('warn The worker asked for a registry login that is refused: '));
  return { ask, send, asked, lines, refusals };
}

const login = (password: string, from: 'docker' | 'github' = 'docker'): HostRegistryLogin => ({ username: 'octo', serveraddress: 'ghcr.io', password, from });

describe('the registry logins of an operation', () => {
  it('gives the login of the registry of the image in the secrets only, and logs where it came from, never the password', async () => {
    const { ask, asked, lines } = wired({ 'ghcr.io': login('gho_secret', 'github'), 'registry-1.docker.io': login('hub_secret') });
    expect(await ask('ghcr.io', 'acme/app')).toEqual({ value: { given: true, username: 'octo', serveraddress: 'ghcr.io' }, secrets: { [SECRET_REGISTRY]: 'gho_secret' } });
    expect(await ask('registry-1.docker.io', 'library/node')).toMatchObject({ value: { given: true }, secrets: { [SECRET_REGISTRY]: 'hub_secret' } });
    expect(await ask('quay.io', 'team/tool')).toStrictEqual({ value: { given: false } });
    expect(asked).toEqual(['ghcr.io/acme/app', 'registry-1.docker.io/library/node', 'quay.io/team/tool']);
    expect(lines).toEqual([
      'info The registry login for ghcr.io/acme/app (open of acme/api): the worker got the GitHub sign-in as the login for ghcr.io.',
      'info The registry login for docker.io/library/node (open of acme/api): the worker got the login that Docker stored for docker.io.',
      'info The registry login for quay.io/team/tool (open of acme/api): this computer has no login for quay.io.',
    ]);
    expect(lines.join('\n')).not.toMatch(/secret/);
  });

  it('answers the registry and the repository of every image and Feature as the worker normalizes them', async () => {
    const { ask, asked, refusals } = wired();
    const references = [
      parseImageReference('node:20'),
      parseImageReference('localhost:5000/app'),
      parseImageReference('registry.example.com:5000/team/app'),
      parseImageReference('[FD00::1]:5000/team/app'),
      parseImageReference('MyHost/team/app'),
      parseImageReference('a'.repeat(255)),
      parseFeatureReference('ghcr.io/devcontainers-contrib/features/x:1'),
    ];
    for (const reference of references) expect(await ask(reference!.registry, reference!.repository)).toStrictEqual({ value: { given: false } });
    expect(asked).toEqual([
      'registry-1.docker.io/library/node',
      'localhost:5000/app',
      'registry.example.com:5000/team/app',
      '[fd00::1]:5000/team/app',
      'myhost/team/app',
      `registry-1.docker.io/library/${'a'.repeat(255)}`,
      'ghcr.io/devcontainers-extra/features/x',
    ]);
    expect(refusals()).toEqual([]);
  });

  it('refuses a request that names no registry and repository of an image as the worker normalizes them, and logs each refusal', async () => {
    const { ask, asked, refusals } = wired({ 'ghcr.io': login('p') });
    const requests = [
      ['ghcr.io'],
      ['ghcr.io', 'acme/app', 'more'],
      [42, 'acme/app'],
      ['GHCR.io', 'acme/app'],
      ['ghcr.io', 'acme/app:1'],
      ['ghcr.io', `acme/app@sha256:${'a'.repeat(64)}`],
      ['ghcr.io', 'Acme/app'],
      ['ghcr.io', ''],
      ['docker.io', 'library/node'],
      ['registry-1.docker.io', 'node'],
      ['ghcr.io/acme', 'app'],
      ['a b', 'app'],
      ['ghcr.io', 'acme/app\n'],
    ];
    for (const args of requests) {
      await expect(ask(...args), JSON.stringify(args)).rejects.toMatchObject({ code: 'invalid' });
    }
    expect(asked).toEqual([]);
    expect(refusals()).toHaveLength(requests.length);
    expect(refusals()[0]).toBe('warn The worker asked for a registry login that is refused: the request does not name a registry and a repository.');
    expect(refusals()[3]).toBe('warn The worker asked for a registry login that is refused: "GHCR.io" and "acme/app" are not the registry and the repository of an image.');
  });

  it('refuses a request that is not a call with arguments, and logs it', async () => {
    const { send, asked, lines } = wired({ 'ghcr.io': login('p') });
    for (const payload of ['ghcr.io', null, ['registry', 'ghcr.io'], { call: 'registry', args: 'ghcr.io' }, { call: 'registry' }, { args: ['ghcr.io', 'acme/app'] }]) {
      await expect(send(payload), JSON.stringify(payload)).rejects.toMatchObject({ code: 'invalid' });
    }
    expect(asked).toEqual([]);
    expect(lines).toEqual(Array.from({ length: 6 }, () => 'warn The worker sent a request of the kind secret that is invalid.'));
  });

  it('names a refused request in quotes on one line of the log, and at most 100 characters of each text', async () => {
    const { ask, refusals } = wired();
    await expect(ask('ghcr.io', `acme/app\nwarn The worker got every login.${'x'.repeat(200)}`)).rejects.toMatchObject({ code: 'invalid' });
    const [line] = refusals();
    expect(line).not.toContain('\n');
    expect(line).toContain('"acme/app\\nwarn The worker got every login.x');
    expect(line).not.toContain('x'.repeat(100));
  });

  it(`gives the logins of at most ${MAX_LOGIN_REGISTRIES} registries; a registry without a login counts not, a given one again is fine`, async () => {
    const registries = Array.from({ length: MAX_LOGIN_REGISTRIES + 1 }, (_, i) => `r${i}.example`);
    const { ask, asked, lines } = wired(Object.fromEntries(registries.map((registry) => [registry, login(`pw-${registry}`)])));
    expect(await ask('none.example', 'team/app')).toStrictEqual({ value: { given: false } });
    for (const registry of registries.slice(0, MAX_LOGIN_REGISTRIES)) expect(await ask(registry, 'team/app')).toMatchObject({ value: { given: true } });
    // The registry after the limit is not asked for at all.
    const last = registries[MAX_LOGIN_REGISTRIES];
    expect(await ask(last, 'team/app')).toStrictEqual({ value: { given: false } });
    expect(asked).not.toContain(`${last}/team/app`);
    expect(lines.at(-1)).toBe(
      `warn The registry login for ${last}/team/app (open of acme/api) is not given: the operation got the logins of ${MAX_LOGIN_REGISTRIES} registries already (${registries.slice(0, MAX_LOGIN_REGISTRIES).join(', ')}).`,
    );
    // A registry whose login the operation got already: its next pull gets it again.
    expect(await ask('r0.example', 'team/other')).toMatchObject({ value: { given: true }, secrets: { [SECRET_REGISTRY]: 'pw-r0.example' } });
  });

  it('answers one request at a time: a second request while the first is answered is refused and logged', async () => {
    let answer: (value: HostRegistryLogin) => void = () => undefined;
    let calls = 0;
    // The first lookup waits (a credential helper that asks for a password); the next ones answer at once.
    const { ask, asked, refusals } = wired({ 'ghcr.io': () => (calls++ === 0 ? new Promise((resolve) => (answer = resolve)) : Promise.resolve(login('p2'))) });
    const first = ask('ghcr.io', 'acme/app');
    await Promise.resolve();
    await expect(ask('ghcr.io', 'acme/other')).rejects.toMatchObject({ code: 'invalid' });
    expect(refusals()).toEqual([
      'warn The worker asked for a registry login that is refused: the request for ghcr.io/acme/other came while another registry login of the operation was answered.',
    ]);
    answer(login('p1'));
    expect(await first).toMatchObject({ value: { given: true }, secrets: { [SECRET_REGISTRY]: 'p1' } });
    // Afterwards, the next request is answered.
    expect(await ask('ghcr.io', 'acme/other')).toMatchObject({ value: { given: true }, secrets: { [SECRET_REGISTRY]: 'p2' } });
    expect(asked).toEqual(['ghcr.io/acme/app', 'ghcr.io/acme/other']);
  });

  it('logs a lookup that fails with its registry, and ends it, so the next request is answered', async () => {
    let calls = 0;
    const { ask, lines } = wired({ 'ghcr.io': () => (calls++ === 0 ? Promise.reject(new Error('helper crashed')) : Promise.resolve(login('p'))) });
    await expect(ask('ghcr.io', 'acme/app')).rejects.toMatchObject({ code: 'failed', message: 'helper crashed' });
    expect(lines).toEqual(['warn The registry login for ghcr.io/acme/app (open of acme/api): the login could not be read: helper crashed']);
    expect(await ask('ghcr.io', 'acme/app')).toMatchObject({ value: { given: true } });
  });

  it(`refuses the requests after ${MAX_LOGIN_REQUESTS} of an operation`, async () => {
    const { ask, asked, refusals } = wired({ 'ghcr.io': login('p') });
    for (let i = 0; i < MAX_LOGIN_REQUESTS; i++) await ask('ghcr.io', 'acme/app');
    await expect(ask('ghcr.io', 'acme/app')).rejects.toMatchObject({ code: 'invalid' });
    expect(asked).toHaveLength(MAX_LOGIN_REQUESTS);
    expect(refusals()).toEqual([
      `warn The worker asked for a registry login that is refused: the request for ghcr.io/acme/app came after ${MAX_LOGIN_REQUESTS} registry logins of the operation.`,
    ]);
  });
});
