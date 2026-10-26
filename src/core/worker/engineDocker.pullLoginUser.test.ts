// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// EngineDocker.pullImage with the logins of the operation (the user of a login without a user name, the output and the
// signal of a pull that asked for its login after the registry refused the pull without it).
import { describe, expect, it } from 'vitest';
import { SECRET_REGISTRY } from '../helperChannel/protocol';
import { silentLogger } from '../ports';
import { EngineError, type DockerEngine } from './dockerEngine';
import { unusedEngine } from './dockerEngine.testkit';
import { EngineDocker, type PullLogins } from './engineDocker';

type Login = Parameters<Parameters<PullLogins>[1]>[0];

/** Logins that answer `login` and record the signal of each ask; the secret slot holds its password during `use`. */
function loginsOf(login: Login) {
  const state = { slot: undefined as string | undefined, signals: [] as (AbortSignal | undefined)[] };
  const run: PullLogins = async (_registry, use, signal) => {
    state.signals.push(signal);
    state.slot = login?.password;
    try {
      return await use(login);
    } finally {
      state.slot = undefined;
    }
  };
  return { run, state };
}

/** The answer of a registry to a pull without a login of a private image. */
const REFUSED = new EngineError('unauthorized: authentication required', 401);

describe('EngineDocker.pullImage with the logins of the operation: the user, the output and the signal', () => {
  it('a login without a user name and without an identity token pulls with an empty user name (as hostRegistryCredentials)', async () => {
    const { run, state } = loginsOf({ password: 'pw' });
    const logins: unknown[] = [];
    const engine: DockerEngine = {
      ...unusedEngine(),
      pull: async (_reference, options) => {
        logins.push(options?.login);
        if (options?.login === undefined) throw REFUSED;
      },
    };
    const docker = new EngineDocker(engine, silentLogger, (name) => (name === SECRET_REGISTRY ? state.slot : undefined), run);
    await docker.pullImage('r.example/i:1', { onOutput: () => {} });
    expect(logins).toEqual([undefined, { serveraddress: 'r.example', username: '', secretName: SECRET_REGISTRY }]);
  });

  it('a pull that asked for its login keeps its output and its signal; the ask gets the signal too', async () => {
    const { run, state } = loginsOf({ username: 'octo', password: 'pw' });
    const signals: (AbortSignal | undefined)[] = [];
    const engine: DockerEngine = {
      ...unusedEngine(),
      pull: async (_reference, options) => {
        signals.push(options?.signal);
        if (options?.login === undefined) throw REFUSED;
        options.onLine?.('Pulling fs layer');
      },
    };
    const output: string[] = [];
    const docker = new EngineDocker(engine, { ...silentLogger, output: (text: string) => void output.push(`log ${text}`) }, (name) => (name === SECRET_REGISTRY ? state.slot : undefined), run);
    const controller = new AbortController();
    await docker.pullImage('ghcr.io/o/i:1', { onOutput: (text) => void output.push(text), signal: controller.signal });
    expect(output).toEqual(['Pulling fs layer\n']);
    expect(signals).toEqual([controller.signal, controller.signal]);
    expect(state.signals).toEqual([controller.signal]);
  });

  it('without a login on this computer the refused pull fails with its refusal, after one pull; the ask gets the signal', async () => {
    const { run, state } = loginsOf(undefined);
    const pulls: unknown[] = [];
    const engine: DockerEngine = {
      ...unusedEngine(),
      pull: async (_reference, options) => {
        pulls.push([options?.login, options?.signal]);
        throw REFUSED;
      },
    };
    const docker = new EngineDocker(engine, silentLogger, () => undefined, run);
    const controller = new AbortController();
    await expect(docker.pullImage('ghcr.io/o/i:1', { onOutput: () => {}, signal: controller.signal })).rejects.toBe(REFUSED);
    expect(pulls).toEqual([[undefined, controller.signal]]);
    expect(state.signals).toEqual([controller.signal]);
  });
});
