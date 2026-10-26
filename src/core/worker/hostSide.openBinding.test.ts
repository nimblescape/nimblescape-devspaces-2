// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The open of a repository has no devspace until it finds one: the existing devspace of the repository of the
// account signed in here on its Docker host, or the one that its `record restore` added. `record findForAccount` binds
// it; only then may it change that entry (SCOPED_REQUESTS). The questions of the open name the repository of the
// operation.
import { describe, expect, it } from 'vitest';
import type { HelperOperationError } from '../helperChannel/helperChannel';
import { OP_OPEN, type AskKind } from '../helperChannel/protocol';
import { silentLogger } from '../ports';
import type { Devspace } from '../types';
import { FLOW_REQUESTS, type HostSide } from './hostSide';
import { hostSideHandler } from './hostSideHandler';

const HOST = 'ssh://box';
const E1 = { id: 'e1', repository: 'acme/app', owner: { id: '42', login: 'octo' }, dockerHost: HOST } as unknown as Devspace;
const E2 = { id: 'e2', repository: 'acme/app', owner: { id: '42', login: 'octo' }, dockerHost: HOST } as unknown as Devspace;

function setup(options: { devspaceId?: string; found?: Devspace; account?: string } = {}) {
  const calls: string[] = [];
  let found = options.found;
  const host = {
    questions: {
      confirmUntrustedRepository: async (repository: string) => (calls.push(`trust ${repository}`), true),
    },
    state: {
      account: async () => (calls.push('account'), options.account === undefined ? { id: '42', login: 'octo' } : { id: options.account, login: 'other' }),
    },
    records: {
      findForAccount: async (repository: string, accountId: string, dockerHost: string, source?: unknown) =>
        (calls.push(`find ${repository} ${accountId} ${dockerHost}${source === undefined ? '' : ` ${JSON.stringify(source)}`}`), found),
      restore: async () => (calls.push('restore'), (found = E2), { added: 1, skipped: [] }),
      clearBusy: async (id: string) => void calls.push(`clearBusy ${id}`),
    },
    secrets: {},
  } as unknown as HostSide;
  const handler = hostSideHandler(host, silentLogger, FLOW_REQUESTS[OP_OPEN], {
    repository: 'acme/app',
    dockerHost: HOST,
    ...(options.devspaceId !== undefined ? { devspaceId: options.devspaceId } : {}),
  });
  const ask = async (kind: AskKind, call: string, ...args: unknown[]) => (await handler(kind, { call, args }, new AbortController().signal)).value;
  const refused = (kind: AskKind, call: string, ...args: unknown[]) => ask(kind, call, ...args).then(() => 'answered', (error: HelperOperationError) => error.code);
  return { ask, refused, calls, set: (entry: Devspace | undefined) => (found = entry) };
}

describe('the devspace of the open of a repository', () => {
  it('changes nothing before it found its devspace; then only that one', async () => {
    const { ask, refused, calls } = setup({ found: E1 });
    expect(await refused('record', 'clearBusy', 'e1')).toBe('invalid');
    expect(await ask('record', 'findForAccount', 'acme/app', '42', HOST)).toEqual(E1);
    expect(await ask('record', 'clearBusy', 'e1')).toBeNull();
    expect(await refused('record', 'clearBusy', 'e2')).toBe('invalid');
    expect(calls).toEqual(['account', `find acme/app 42 ${HOST}`, 'clearBusy e1']);
  });

  it('the entry that its `record restore` added', async () => {
    const { ask, calls } = setup();
    expect(await ask('record', 'findForAccount', 'acme/app', '42', HOST)).toBeNull();
    await ask('record', 'restore', []);
    expect(await ask('record', 'findForAccount', 'acme/app', '42', HOST)).toEqual(E2);
    expect(await ask('record', 'clearBusy', 'e2')).toBeNull();
    expect(calls.at(-1)).toBe('clearBusy e2');
  });

  it('never the devspace of another account: the account is the one signed in here', async () => {
    const { refused, calls } = setup({ found: E1, account: '7' });
    expect(await refused('record', 'findForAccount', 'acme/app', '42', HOST)).toBe('invalid');
    expect(calls).toEqual(['account']);
    const other = setup({ found: E1 });
    expect(await other.refused('record', 'findForAccount', 'acme/app', '7', HOST)).toBe('invalid');
    expect(other.calls).toEqual(['account']);
  });

  it('a read of another repository or Docker host binds nothing', async () => {
    const { ask, refused } = setup({ found: E1 });
    expect(await ask('record', 'findForAccount', 'acme/other', '42', HOST)).toEqual(E1);
    expect(await ask('record', 'findForAccount', 'acme/app', '42', 'ssh://other')).toEqual(E1);
    expect(await refused('record', 'clearBusy', 'e1')).toBe('invalid');
  });

  it('an open that has its devspace finds no other one, and creates none', async () => {
    const bound = setup({ devspaceId: 'e1', found: E2 });
    expect(await bound.refused('record', 'findForAccount', 'acme/app', '42', HOST)).toBe('invalid');
    const found = setup({ found: E1 });
    await found.ask('record', 'findForAccount', 'acme/app', '42', HOST);
    found.set(E1);
    expect(await found.ask('record', 'findForAccount', 'acme/app', '42', HOST)).toEqual(E1);
    expect(await found.refused('record', 'createDevspace', { id: 'e3', repository: 'acme/app', configPath: '.devcontainer/devcontainer.json' })).toBe('invalid');
  });

  it('its questions name its repository, in any case (the entry may spell it otherwise, as the registry compares it)', async () => {
    const { ask, refused, calls } = setup();
    expect(await refused('question', 'confirmUntrustedRepository', 'acme/other')).toBe('invalid');
    expect(await ask('question', 'confirmUntrustedRepository', 'acme/app')).toBe(true);
    expect(await ask('question', 'confirmUntrustedRepository', 'Acme/App')).toBe(true);
    expect(calls).toEqual(['trust acme/app', 'trust Acme/App']);
  });

  it('passes the source of the request to the registry (the devspace of that source), and refuses one that is no source', async () => {
    const { ask, calls } = setup({ found: E1 });
    const source = { kind: 'configuration', configPath: '.devcontainer/python/devcontainer.json' };
    expect(await ask('record', 'findForAccount', 'acme/app', '42', HOST, source)).toEqual(E1);
    expect(calls).toEqual(['account', `find acme/app 42 ${HOST} ${JSON.stringify(source)}`]);
    expect(await ask('record', 'clearBusy', 'e1')).toBeNull();
    const other = setup({ found: E1 });
    for (const odd of [{ kind: 'configuration', configPath: 'x' }, { kind: 'defaultImage', image: 'not an image' }, 'default', null]) {
      expect(await other.refused('record', 'findForAccount', 'acme/app', '42', HOST, odd), JSON.stringify(odd)).toBe('invalid');
    }
    expect(await other.refused('record', 'findForAccount', 'acme/app', '42', HOST, source, 'more')).toBe('invalid');
    expect(other.calls).toEqual([]);
  });

  it('the devspace of its repository in another case binds it too', async () => {
    const { ask } = setup({ found: E1 });
    expect(await ask('record', 'findForAccount', 'ACME/app', '42', HOST)).toEqual(E1);
    expect(await ask('record', 'clearBusy', 'e1')).toBeNull();
  });
});

// The kept volumes that the open forgets are names of volumes, bounded.
describe('the kept volumes that an open forgets', () => {
  it('volume names only, at most 1000', async () => {
    const forgotten: string[][] = [];
    const host = { questions: {}, state: {}, records: { forgetKeptVolumes: async (names: string[]) => void forgotten.push(names) }, secrets: {} } as unknown as HostSide;
    const handler = hostSideHandler(host, silentLogger, FLOW_REQUESTS[OP_OPEN], { devspaceId: 'e1', repository: 'acme/app', dockerHost: HOST });
    const ask = (names: unknown) => handler('record', { call: 'forgetKeptVolumes', args: [names] }, new AbortController().signal);
    await ask(['acme-cache']);
    for (const odd of [['../x'], ['a b'], [42], Array.from({ length: 1001 }, (_, i) => `v${i}`)]) {
      await expect(ask(odd)).rejects.toMatchObject({ code: 'invalid' });
    }
    expect(forgotten).toEqual([['acme-cache']]);
  });
});
