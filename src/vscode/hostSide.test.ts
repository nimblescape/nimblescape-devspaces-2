// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The HostSide of this computer, which answers the requests of a flow in the worker: where the registry logins come
// from, how a record changes, and what is refused.
import { describe, expect, it, vi } from 'vitest';
import { IDENTITY_TOKEN_USER } from '../core/imageCheck/credentials';
import { silentLogger } from '../core/ports';
import type { Devspace } from '../core/types';
import { OP_DELETE, OP_OPEN, OP_TOKEN_REMOVE } from '../core/helperChannel/protocol';
import type { OperationOptions } from '../core/helperChannel/helperChannel';
import { extensionFlow, extensionHostSide, type HostSideDeps } from './hostSide';

function deps(overrides: Partial<HostSideDeps> = {}) {
  const devspace = { id: 'e1', repository: 'acme/app', lastUsedAt: 'old' } as unknown as Devspace;
  const registry = {
    read: vi.fn(),
    get: vi.fn(async () => devspace),
    list: vi.fn(async () => [devspace]),
    findForAccount: vi.fn(),
    add: vi.fn(async () => {}),
    updateDevspace: vi.fn(async (_id: string, change: (devspace: Devspace) => void) => change(devspace)),
    remove: vi.fn(async () => {}),
    forgetKeptVolumes: vi.fn(async () => {}),
  };
  const sessionFiles = {
    readWindowStatuses: vi.fn(async () => []),
    readPendings: vi.fn(async () => []),
    writePending: vi.fn(async () => {}),
    removePending: vi.fn(async () => {}),
    removeOperation: vi.fn(async () => {}),
    removeReopen: vi.fn(async () => {}),
    removeReopenOf: vi.fn(async (_id: string) => {}),
    removeDisconnectRequest: vi.fn(async () => {}),
  };
  const ui = { info: vi.fn(), warn: vi.fn(), registrySignIn: vi.fn() };
  const auth = {
    getToken: vi.fn(async () => 'ghp_token'),
    getPackagesCredentials: vi.fn(async () => ({ username: 'octocat', password: 'gho_packages' })),
    getAccount: vi.fn(async (_options: { interactive: boolean }): Promise<{ id: string; login: string } | undefined> => ({ id: '42', login: 'octo' })),
  };
  const credentials = { getForPull: vi.fn(async (_registry: string): Promise<{ username: string; password: string } | undefined> => undefined) };
  const all = {
    registry,
    sessionFiles,
    ui,
    auth,
    credentials,
    windowId: 'w1',
    // The busy marks of a flow.
    pid: 100,
    clock: { now: () => Date.parse('2026-10-04T12:00:00.000Z') },
    isProcessAlive: () => true,
    logger: silentLogger,
    ...overrides,
  } as unknown as HostSideDeps;
  return { all, devspace, registry, sessionFiles, ui, auth, credentials };
}

describe('the HostSide of this computer', () => {
  it('takes a registry login from the store of Docker first, an identity token without its user', async () => {
    const { all, credentials, auth } = deps();
    credentials.getForPull.mockResolvedValueOnce({ username: 'stored', password: 'stored-password' });
    const host = extensionHostSide(all);
    expect(await host.secrets.registry('ghcr.io', 'octo/app')).toEqual({ username: 'stored', serveraddress: 'ghcr.io', password: 'stored-password', from: 'docker' });
    expect(auth.getPackagesCredentials).not.toHaveBeenCalled();
    credentials.getForPull.mockResolvedValueOnce({ username: IDENTITY_TOKEN_USER, password: 'refresh-token' });
    expect(await host.secrets.registry('registry.example', 'team/app')).toEqual({ identityToken: true, serveraddress: 'registry.example', password: 'refresh-token', from: 'docker' });
  });

  it('uses the GitHub sign-in only for ghcr.io, never with a dialog, and nothing for other registries', async () => {
    const { all, auth } = deps();
    const host = extensionHostSide(all);
    expect(await host.secrets.registry('GHCR.io', 'octo/app')).toEqual({ username: 'octocat', serveraddress: 'ghcr.io', password: 'gho_packages', from: 'github' });
    expect(auth.getPackagesCredentials).toHaveBeenCalledWith({ interactive: false });
    expect(await host.secrets.registry('registry.example', 'team/app')).toBeUndefined();
    auth.getPackagesCredentials.mockRejectedValueOnce(new Error('signed out'));
    expect(await host.secrets.registry('ghcr.io', 'octo/app')).toBeUndefined();
    expect(await host.secrets.token()).toBe('ghp_token');
    expect(auth.getToken).toHaveBeenCalledWith({ interactive: false });
  });

  // The account of the sign-in, with the dialog only when the flow asks for it.
  it('reads the signed-in account with the interactive flag of the flow', async () => {
    const { all, auth } = deps();
    const host = extensionHostSide(all);
    expect(await host.state.account(true)).toEqual({ id: '42', login: 'octo' });
    expect(auth.getAccount).toHaveBeenLastCalledWith({ interactive: true });
    auth.getAccount.mockResolvedValueOnce(undefined);
    expect(await host.state.account(false)).toBeUndefined();
    expect(auth.getAccount).toHaveBeenLastCalledWith({ interactive: false });
  });

  it('finds the devspace of a repository for an account with the source that the worker names, or without one', async () => {
    const { all, registry, devspace } = deps();
    registry.findForAccount.mockResolvedValue(devspace);
    const host = extensionHostSide(all);
    const source = { kind: 'configuration' as const, configPath: '.devcontainer/python/devcontainer.json' };
    expect(await host.records.findForAccount('acme/app', '42', 'ssh://box', source)).toBe(devspace);
    expect(registry.findForAccount).toHaveBeenLastCalledWith('acme/app', '42', 'ssh://box', source);
    expect(await host.records.findForAccount('acme/app', '42', '')).toBe(devspace);
    expect(registry.findForAccount).toHaveBeenLastCalledWith('acme/app', '42', '', undefined);
  });

  // No generic change of a record (`record update`); the specific writes of the open: hostSide.openRequests.test.ts.
  it('writes the pending file of this window', async () => {
    const { all, sessionFiles } = deps();
    const host = extensionHostSide(all);
    expect(host.records).not.toHaveProperty('update');
    expect(host.records).not.toHaveProperty('add');
    await host.records.sessionFile('writePending', 'e1');
    expect(sessionFiles.writePending).toHaveBeenCalledWith('e1', 'w1');
    // A flow removes the reopen record only by its devspace (removeReopenOf), never the one of any devspace.
  });

  // There is no request `connect` (the open answers with what the window needs), so only the messages are here.
  it('shows each kind of message', async () => {
    const { all, ui } = deps();
    const host = extensionHostSide(all);
    await host.questions.message('info', 'i');
    await host.questions.message('warn', 'w');
    await host.questions.message('registrySignIn', 'ghcr.io');
    expect([ui.info.mock.calls, ui.warn.mock.calls, ui.registrySignIn.mock.calls]).toEqual([[['i']], [['w']], [['ghcr.io']]]);
  });

  it('runs a flow in the worker of the current engine, answering only the requests of its operation', async () => {
    const { all, auth } = deps();
    // A target that no default could be.
    const target = { kind: 'remote', host: 'build-box', endpoint: 'ssh://build-box' } as const;
    const sent: { target: unknown; op: string; params: unknown; options: OperationOptions }[] = [];
    const channels = {
      flow: vi.fn(async (given: unknown, op: string, params: unknown, options: OperationOptions = {}) => (sent.push({ target: given, op, params, options }), { outcome: 'notRunning' })),
    };
    const warnings: string[] = [];
    const flow = extensionFlow(channels as never, async () => target as never, extensionHostSide(all), { ...silentLogger, warn: (text) => warnings.push(text) });
    const signal = new AbortController().signal;
    expect(await flow(OP_TOKEN_REMOVE, { devspaceId: 'e1' }, { signal, timeoutMs: 60_000 })).toEqual({ outcome: 'notRunning' });
    expect(sent[0]).toMatchObject({ target, op: OP_TOKEN_REMOVE, params: { devspaceId: 'e1' }, options: { signal, timeoutMs: 60_000 } });
    expect(sent[0].options).not.toHaveProperty('passive');
    // A read in the background is passive in the worker channels too.
    await flow(OP_TOKEN_REMOVE, { devspaceId: 'e1' }, { timeoutMs: 1_000, passive: true });
    expect(sent[1].options).toMatchObject({ timeoutMs: 1_000, passive: true });
    sent.splice(1, 1);
    const onAsk = sent[0].options.onAsk!;
    const open = new AbortController().signal;
    await expect(onAsk('secret', { call: 'token', args: [] }, open)).rejects.toMatchObject({ code: 'invalid' });
    await expect(onAsk('record', { call: 'remove', args: ['e1'] }, open)).rejects.toMatchObject({ code: 'invalid' });
    expect(auth.getToken).not.toHaveBeenCalled();
    // A refused request is logged in the log of the window.
    expect(warnings).toEqual([
      'The worker sent the request secret token, which its operation may not send.',
      'The worker sent the request record remove, which its operation may not send.',
    ]);
    expect(await onAsk('record', { call: 'get', args: ['e1'] }, open)).toMatchObject({ value: { id: 'e1' } });
    // An operation without requests, also one named like a member of every object.
    for (const op of ['unknownFlow', 'constructor', 'toString']) {
      await flow(op, {}, {});
      await expect(sent.at(-1)!.options.onAsk!('record', { call: 'get', args: ['e1'] }, open)).rejects.toMatchObject({ code: 'invalid' });
    }
  });
});

// The busy marks of a flow are this window's, set by this computer with its clock and its view of the windows; the
// reopen record goes only with its devspace.
describe('the busy marks and the reopen record of a flow', () => {
  it('marks the devspace busy as this window, keeps the live mark of another window, and clears only its own', async () => {
    const base = deps();
    const devspace = base.devspace;
    const registry = { ...base.registry, updateDevspace: vi.fn(async (_id: string, change: (e: Devspace) => void) => (change(devspace), devspace)) };
    const host = extensionHostSide(deps({ registry } as never).all);
    const mark = { operation: 'delete', since: '2026-10-04T12:00:00.000Z', pid: 100, windowId: 'w1' };
    expect(await host.records.markBusy('e1', 'delete')).toEqual({ devspace: expect.objectContaining({ busy: mark }) });
    await host.records.clearBusy('e1');
    expect(devspace.busy).toBeUndefined();
    // A live mark of another window (its status file is recent).
    const other = { operation: 'update' as const, since: '2026-10-04T11:59:00.000Z', pid: 200, windowId: 'w2' };
    devspace.busy = other;
    const { all: withWindows } = deps({ sessionFiles: { ...base.sessionFiles, readWindowStatuses: vi.fn(async () => [{ windowId: 'w2', pid: 200, updatedAt: '2026-10-04T11:59:50.000Z' }]) } as never, registry } as never);
    expect(await extensionHostSide(withWindows).records.markBusy('e1', 'delete')).toEqual({ conflict: other });
    await extensionHostSide(withWindows).records.clearBusy('e1');
    expect(devspace.busy).toEqual(other);
  });

  it('removes the reopen record of the devspace through removeReopenOf', async () => {
    const { all, sessionFiles } = deps();
    await extensionHostSide(all).records.sessionFile('removeReopenOf', 'e1');
    expect(sessionFiles.removeReopenOf).toHaveBeenCalledWith('e1');
    expect(sessionFiles.removeReopen).not.toHaveBeenCalled();
  });

  it('answers the requests of a Delete only for the devspace of the operation', async () => {
    const { all } = deps();
    const sent: OperationOptions[] = [];
    const channels = { flow: vi.fn(async (_target: unknown, _op: string, _params: unknown, options: OperationOptions = {}) => (sent.push(options), { deleted: true })) };
    const flow = extensionFlow(channels as never, async () => ({ kind: 'local' }) as never, extensionHostSide(all), silentLogger);
    await flow(OP_DELETE, { devspaceId: 'e1' }, {});
    const onAsk = sent[0].onAsk!;
    const signal = new AbortController().signal;
    await expect(onAsk('record', { call: 'clearBusy', args: ['e1'] }, signal)).resolves.toEqual({ value: null });
    await expect(onAsk('record', { call: 'clearBusy', args: ['e2'] }, signal)).rejects.toMatchObject({ code: 'invalid' });
    await expect(onAsk('record', { call: 'remove', args: ['e2', {}] }, signal)).rejects.toMatchObject({ code: 'invalid' });
  });
});

// The volumes of a removal are the additional volumes of the entry.
describe('the volumes of a removal from a flow', () => {
  it('passes the additional volumes of the entry, and refuses any other volume before the registry changes', async () => {
    const { all, registry, devspace } = deps();
    (devspace as { additionalVolumes?: string[] }).additionalVolumes = ['api-cache', 'api-db'];
    const host = extensionHostSide(all);
    await host.records.remove('e1', { kept: ['api-db'], removed: ['api-cache'] });
    expect(registry.remove).toHaveBeenCalledWith('e1', { kept: ['api-db'], removed: ['api-cache'] });
    registry.remove.mockClear();
    await expect(host.records.remove('e1', { removed: ['other-account-data'] })).rejects.toThrow('not additional volumes');
    await expect(host.records.remove('e1', { kept: ['devspaces-other'] })).rejects.toThrow('not additional volumes');
    registry.get.mockResolvedValueOnce(undefined as unknown as Devspace);
    await expect(host.records.remove('e2', { removed: ['api-cache'] })).rejects.toThrow('not additional volumes');
    expect(registry.remove).not.toHaveBeenCalled();
    // A removal without volumes needs none.
    registry.get.mockResolvedValueOnce(undefined as unknown as Devspace);
    await host.records.remove('e2', {});
    expect(registry.remove).toHaveBeenCalledWith('e2', {});
  });
});

// The flow of an open passes its progress on; its requests are those of its devspace and repository.
describe('the flow of an open', () => {
  it('passes the progress of the open on; its questions name its repository, its writes its devspace', async () => {
    const { all } = deps();
    const sent: OperationOptions[] = [];
    const channels = { flow: vi.fn(async (_target: unknown, _op: string, _params: unknown, options: OperationOptions = {}) => (sent.push(options), { opened: {} })) };
    const flow = extensionFlow(channels as never, async () => ({ kind: 'local' }) as never, extensionHostSide(all), silentLogger);
    const onProgress = vi.fn();
    await flow(OP_OPEN, { devspaceId: 'e1', repository: 'acme/app', dockerHost: '' }, { onProgress });
    expect(sent[0].onProgress).toBe(onProgress);
    const onAsk = sent[0].onAsk!;
    const signal = new AbortController().signal;
    await expect(onAsk('question', { call: 'confirmUntrustedRepository', args: ['acme/other'] }, signal)).rejects.toMatchObject({ code: 'invalid' });
    await expect(onAsk('record', { call: 'clearBusy', args: ['e1'] }, signal)).resolves.toEqual({ value: null });
    await expect(onAsk('record', { call: 'clearBusy', args: ['e2'] }, signal)).rejects.toMatchObject({ code: 'invalid' });
    // Without one, none is passed.
    await flow(OP_OPEN, { devspaceId: 'e1', repository: 'acme/app', dockerHost: '' }, {});
    expect(sent[1]).not.toHaveProperty('onProgress');
  });
});
