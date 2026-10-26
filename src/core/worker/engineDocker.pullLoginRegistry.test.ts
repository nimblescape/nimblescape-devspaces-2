// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// EngineDocker.pullImage with the logins of the operation (the registry whose login a pull sends, the refusal of the
// pull without a login and the pull once more with it, the pull without a login).
import { describe, expect, it } from 'vitest';
import { SECRET_REGISTRY } from '../helperChannel/protocol';
import { silentLogger } from '../ports';
import { EngineError, type DockerEngine } from './dockerEngine';
import { unusedEngine } from './dockerEngine.testkit';
import { EngineDocker, type PullLogins } from './engineDocker';

type Login = Parameters<Parameters<PullLogins>[1]>[0];

/**
 * Logins as registryLogins gives them: the secret slot holds the password only during `use`. `asked`: the registry and
 * the repository of each request.
 */
function logins(answers: Record<string, Login>) {
  const state = { slot: undefined as string | undefined, asked: [] as string[] };
  const run: PullLogins = async ({ registry, repository }, use) => {
    state.asked.push(`${registry}/${repository}`);
    const login = answers[registry];
    state.slot = login?.password;
    try {
      return await use(login);
    } finally {
      state.slot = undefined;
    }
  };
  return { run, state };
}

/** Docker's answer to a pull without a login of a private repository (or of one that does not exist). */
function privateRepository(reference: string): EngineError {
  return new EngineError(`pull access denied for ${reference}, repository does not exist or may require 'docker login'`, 404);
}

/**
 * A pull of `reference` (ghcr.io/o/i:1 unless given) whose pull without a login fails with `failure`; the pull with the
 * login (`octo`/`gho_x` of ghcr.io, `hub`/`hub_x` of Docker Hub) works.
 */
async function refusedWith(failure: Error, signal?: AbortSignal, reference = 'ghcr.io/o/i:1'): Promise<{ pulls: string[]; asked: string[]; result: Promise<void> }> {
  const { run, state } = logins({ 'ghcr.io': { username: 'octo', password: 'gho_x' }, 'registry-1.docker.io': { username: 'hub', password: 'hub_x' } });
  const pulls: string[] = [];
  const engine: DockerEngine = {
    ...unusedEngine(),
    pull: async (_reference, options) => {
      pulls.push(options?.login ? 'with login' : 'anonymous');
      if (!options?.login) throw failure;
    },
  };
  const docker = new EngineDocker(engine, silentLogger, (name) => (name === SECRET_REGISTRY ? state.slot : undefined), run);
  const result = docker.pullImage(reference, { onOutput: () => {}, ...(signal !== undefined ? { signal } : {}) });
  await result.catch(() => undefined);
  return { pulls, asked: state.asked, result };
}

describe('EngineDocker.pullImage with the logins of the operation: the registry, a refused pull, no login', () => {
  it('the registry of a login: a host with a port in mixed case is not asked for; a tag in mixed case is', async () => {
    const { run, state } = logins({ 'registry-1.docker.io': { username: 'hub', password: 'hub_x' } });
    const pulls: unknown[] = [];
    const engine: DockerEngine = {
      ...unusedEngine(),
      pull: async (reference, options) => {
        pulls.push([reference, options?.login !== undefined]);
        // Every pull without a login is refused, so each reference whose registry a login fits asks for it.
        if (options?.login === undefined) throw privateRepository(reference);
      },
    };
    const docker = new EngineDocker(engine, silentLogger, (name) => (name === SECRET_REGISTRY ? state.slot : undefined), run);
    // The daemon reads `Registry:5000` as written (no `.`: the port alone names the host).
    await expect(docker.pullImage('Registry:5000/team/app:1', { onOutput: () => {} })).rejects.toThrow('pull access denied for Registry:5000/team/app:1');
    expect(state.asked).toEqual([]);
    // The case of a tag (or of a digest) is no registry: Docker Hub, with its login.
    await docker.pullImage('node:Latest', { onOutput: () => {} });
    await docker.pullImage(`node@sha256:${'A'.repeat(64)}`, { onOutput: () => {} });
    // With the repository of the image, as the extension checks it.
    expect(state.asked).toEqual(['registry-1.docker.io/library/node', 'registry-1.docker.io/library/node']);
    expect(pulls).toEqual([
      ['Registry:5000/team/app:1', false],
      ['node:Latest', false],
      ['node:Latest', true],
      [`node@sha256:${'A'.repeat(64)}`, false],
      [`node@sha256:${'A'.repeat(64)}`, true],
    ]);
  });

  it("each of Docker's words for a refused pull is one, also in another case; other failures that name a denial are none", async () => {
    for (const message of [
      'Head "https://ghcr.io/v2/o/i/manifests/1": authentication required',
      'Get "https://ghcr.io/v2/": incorrect username or password',
      'Head "https://ghcr.io/v2/o/i/manifests/1": denied: denied',
      'Get "https://r.example/v2/": invalid username/password',
      'Head "https://ghcr.io/v2/o/i/manifests/1": Authentication Required',
      "pull access denied for ghcr.io/o/i, repository does not exist or may require 'docker login'",
      "pull access denied for ghcr.io/o/i, repository does not exist or may require 'Docker Login'",
      'failed to resolve reference "ghcr.io/o/i:1": pull access denied, repository does not exist or may require authorization: server message: insufficient_scope: authorization failed',
    ]) {
      const { pulls, asked, result } = await refusedWith(new EngineError(message, 500));
      await expect(result, message).resolves.toBeUndefined();
      expect(pulls, message).toEqual(['anonymous', 'with login']);
      expect(asked, message).toEqual(['ghcr.io/o/i']);
    }
    for (const message of [
      'permission denied while trying to connect to the Docker daemon socket',
      'open /var/lib/docker/tmp: access denied by policy',
      'pull access for o/i is not possible: repository does not exist or may require login (denied later)',
    ]) {
      const { pulls, asked, result } = await refusedWith(new EngineError(message, 404));
      await expect(result, message).rejects.toThrow(message);
      expect(pulls, message).toEqual(['anonymous']);
      expect(asked, message).toEqual([]);
    }
  });

  it("Docker Hub's limit for pulls without a login asks for the login; the same words of another registry do not", async () => {
    const limit = 'toomanyrequests: You have reached your unauthenticated pull rate limit. https://www.docker.com/increase-rate-limit';
    const hub = await refusedWith(new EngineError(limit, 500), undefined, 'node:22');
    await expect(hub.result).resolves.toBeUndefined();
    expect(hub.pulls).toEqual(['anonymous', 'with login']);
    expect(hub.asked).toEqual(['registry-1.docker.io/library/node']);
    const other = await refusedWith(new EngineError(limit, 500));
    await expect(other.result).rejects.toThrow(limit);
    expect(other.pulls).toEqual(['anonymous']);
    expect(other.asked).toEqual([]);
  });

  it('a refused pull whose user cancelled: no login is asked, the failure stays', async () => {
    const controller = new AbortController();
    controller.abort();
    const failure = new EngineError('unauthorized', 401);
    const { pulls, asked, result } = await refusedWith(failure, controller.signal);
    await expect(result).rejects.toBe(failure);
    expect(pulls).toEqual(['anonymous']);
    expect(asked).toEqual([]);
  });

  it('a public image: the pull asks for no login and keeps its output and its signal', async () => {
    const { run, state } = logins({ 'ghcr.io': { username: 'octo', password: 'gho_x' } });
    const seen: unknown[] = [];
    const engine: DockerEngine = {
      ...unusedEngine(),
      pull: async (_reference, options) => {
        seen.push([options?.login, options?.signal]);
        options?.onLine?.('done');
      },
    };
    const output: string[] = [];
    const docker = new EngineDocker(engine, { ...silentLogger, output: (text: string) => void output.push(`log ${text}`) }, () => undefined, run);
    const signal = new AbortController().signal;
    await docker.pullImage('ghcr.io/o/i:1', { onOutput: (text) => void output.push(text), signal });
    expect(state.asked).toEqual([]);
    expect(seen).toEqual([[undefined, signal]]);
    expect(output).toEqual(['done\n']);
  });
});
