// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The registry writes of the open in the extension: the HostSide of this window applies them with its owner, clock,
// view of the windows and signed-in account (never the worker's), only on an entry of that account on the Docker host
// of the operation. Only the operation `open` sends them. The entry of a first open, its removal, the configuration and
// the build records too.
import { describe, expect, it, vi } from 'vitest';
import type { OperationOptions } from '../core/helperChannel/helperChannel';
import { OP_DELETE } from '../core/helperChannel/protocol';
import { silentLogger } from '../core/ports';
import type { DevspaceRegistry } from '../core/storage/registry';
import type { BusyMark, Devspace, RegistryFile, WindowStatus } from '../core/types';
import type { HostCall } from '../core/worker/hostSide';
import { hostSideHandler } from '../core/worker/hostSideHandler';
import { extensionFlow, extensionHostSide, type HostSideDeps } from './hostSide';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const HOST = 'ssh://box';
const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const SCOPE = { dockerHost: HOST };
const other: BusyMark = { operation: 'update', since: '2026-10-04T11:59:00.000Z', pid: 200, windowId: 'w2' };

function setup(fields: Partial<Devspace> = {}, overrides: { account?: { id: string; login: string } | null; windowStatuses?: WindowStatus[] } = {}) {
  let entry = { id: ID, repository: 'acme/api', owner: { id: '42', login: 'old' }, dockerHost: HOST, lastUsedAt: '2020-01-01T00:00:00.000Z', ...fields } as Devspace;
  const registry = {
    updateDevspace: vi.fn(async (id: string, mutator: (entry: Devspace) => void | Promise<void>) => {
      if (id !== ID) return undefined;
      const copy = structuredClone(entry);
      await mutator(copy);
      entry = copy;
      return structuredClone(copy);
    }),
  };
  const getAccount = vi.fn(async (_options: { interactive: boolean }) => (overrides.account === null ? undefined : (overrides.account ?? { id: '42', login: 'octo' })));
  const readWindowStatuses = vi.fn(async () => overrides.windowStatuses ?? []);
  const deps = {
    registry,
    sessionFiles: { readWindowStatuses },
    ui: {},
    auth: { getAccount },
    credentials: {},
    settings: () => ({}),
    windowId: 'w1',
    pid: 100,
    clock: { now: () => NOW },
    isProcessAlive: () => true,
    logger: silentLogger,
  } as unknown as HostSideDeps;
  return { host: extensionHostSide(deps), entry: () => entry, getAccount, readWindowStatuses };
}

describe('the registry writes of the open in the extension', () => {
  it('the login of the account signed in here, read without a dialog; never an entry of another account or host', async () => {
    const { host, entry, getAccount } = setup();
    expect(await host.records.ownerLogin(ID, SCOPE)).toMatchObject({ owner: { id: '42', login: 'octo' } });
    expect(getAccount).toHaveBeenCalledWith({ interactive: false });
    expect(entry().owner).toEqual({ id: '42', login: 'octo' });
    await expect(setup({ owner: { id: '7', login: 'x' } }).host.records.ownerLogin(ID, SCOPE)).rejects.toThrow('another account');
    await expect(setup().host.records.ownerLogin(ID, { dockerHost: '' })).rejects.toThrow('another Docker host');
    await expect(setup({}, { account: null }).host.records.ownerLogin(ID, SCOPE)).rejects.toThrow('No GitHub account');
    // Without the scope of the handler (as the worker would call it), nothing is written.
    const unscoped = setup();
    await expect(unscoped.host.records.lifecycleMark(ID, 'clear')).rejects.toThrow('names no Docker host');
    expect(unscoped.entry().owner.login).toBe('old');
  });

  it('the step mark of this window with its clock, released only as this mark of this window', async () => {
    const { host, entry } = setup();
    const mark: BusyMark = { operation: 'update', since: new Date(NOW).toISOString(), pid: 100, windowId: 'w1' };
    expect(await host.records.takeStepMark(ID, 'update', SCOPE)).toMatchObject({ mark });
    await expect(host.records.releaseStepMark(ID, { ...mark, windowId: 'w2' }, SCOPE)).rejects.toThrow('not one of this window');
    expect(entry().busy).toEqual(mark);
    expect(await host.records.releaseStepMark(ID, mark, SCOPE)).not.toHaveProperty('busy');
  });

  it('the end of the open with the clock and the window status files of this window', async () => {
    const live = setup({ busy: other }, { windowStatuses: [{ windowId: 'w2', pid: 200, updatedAt: new Date(NOW - 5_000).toISOString() } as WindowStatus] });
    expect(await live.host.records.openFinished(ID, { remoteWorkspaceFolder: '/workspaces/api' }, SCOPE)).toMatchObject({ lastUsedAt: new Date(NOW).toISOString(), busy: other });
    expect(live.readWindowStatuses).toHaveBeenCalled();
    expect(await setup({ busy: other }).host.records.openFinished(ID, { remoteWorkspaceFolder: '/workspaces/api' }, SCOPE)).not.toHaveProperty('busy');
  });

  it('the markBusy of a flow tells what it replaced; the handler gives only that back as the previous create mark', async () => {
    const interrupted: BusyMark = { operation: 'create', since: new Date(0).toISOString(), pid: 200, windowId: 'w2' };
    const { host, entry } = setup({ busy: interrupted });
    const allowed: HostCall[] = ['record markBusy', 'record createMark'];
    const onAsk = hostSideHandler(host, silentLogger, allowed, { devspaceId: ID, dockerHost: HOST });
    const signal = new AbortController().signal;
    await onAsk('record', { call: 'markBusy', args: [ID, 'create'] }, signal);
    expect(entry().busy).toMatchObject({ pid: 100, windowId: 'w1' });
    // Another mark ends the create mark of this window.
    expect(await onAsk('record', { call: 'createMark', args: [ID, 'previous', other] }, signal)).toMatchObject({ value: { busy: { pid: 100, windowId: 'w1', since: new Date(0).toISOString() } } });
    expect(await onAsk('record', { call: 'createMark', args: [ID, 'previous', interrupted] }, signal)).toMatchObject({ value: { busy: interrupted } });
  });

  it('the operation delete of extensionFlow may not send them', async () => {
    const { host } = setup();
    const sent: OperationOptions[] = [];
    const channels = { flow: vi.fn(async (_t: unknown, _op: string, _p: unknown, options: OperationOptions = {}) => (sent.push(options), {})) };
    await extensionFlow(channels as never, async () => ({ kind: 'remote' }) as never, host, silentLogger)(OP_DELETE, { devspaceId: ID, dockerHost: HOST }, {});
    await expect(sent[0].onAsk!('record', { call: 'ownerLogin', args: [ID] }, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid' });
  });

  describe('the entry of a first open, the configuration and the build records', () => {
    const NEW = '6b1f0c2e-1d4a-4f5e-9a8b-7c6d5e4f3a2b';
    const DEFAULT = '.devcontainer/devcontainer.json';

    /** This window's HostSide over a registry file (`update`), as the extension wires it. */
    function filed(entries: Devspace[] = [], account: { id: string; login: string } | null = { id: '42', login: 'octo' }) {
      let file: RegistryFile = { version: 1, devspaces: structuredClone(entries) };
      const update = (async <T>(mutator: (file: RegistryFile) => T | Promise<T>) => {
        const copy = structuredClone(file);
        const result = await mutator(copy);
        file = copy;
        return structuredClone(result);
      }) as DevspaceRegistry['update'];
      const warnings: string[] = [];
      const getAccount = vi.fn(async (_options: { interactive: boolean }) => account ?? undefined);
      const deps = {
        registry: {
          update,
          updateDevspace: (id: string, mutator: (entry: Devspace) => void | Promise<void>) =>
            update(async (f) => {
              const found = f.devspaces.find((candidate) => candidate.id === id);
              if (found) await mutator(found);
              return found;
            }),
        },
        sessionFiles: { readWindowStatuses: async () => [] },
        ui: {},
        auth: { getAccount },
        credentials: {},
        settings: () => ({}),
        windowId: 'w1',
        pid: 100,
        clock: { now: () => NOW },
        isProcessAlive: () => true,
        logger: { ...silentLogger, warn: (text: string) => warnings.push(text) },
      } as unknown as HostSideDeps;
      return { host: extensionHostSide(deps), file: () => file, warnings, getAccount };
    }

    it('the entry of a first open with the account signed in here, the clock and the create mark of this window', async () => {
      const { host, file, getAccount } = filed();
      const created = await host.records.createDevspace(NEW, 'acme/api', DEFAULT, SCOPE);
      expect(created).toMatchObject({
        id: NEW,
        owner: { id: '42', login: 'octo' },
        dockerHost: HOST,
        createdAt: new Date(NOW).toISOString(),
        busy: { operation: 'create', since: new Date(NOW).toISOString(), pid: 100, windowId: 'w1' },
      });
      expect(getAccount).toHaveBeenCalledWith({ interactive: false });
      expect(file().devspaces).toEqual([created]);
      // Removed again only with the create mark of this window.
      await host.records.dropCreated(NEW, SCOPE);
      expect(file().devspaces).toEqual([]);
      await expect(filed([], null).host.records.createDevspace(NEW, 'acme/api', DEFAULT, SCOPE)).rejects.toThrow('No GitHub account');
      // Without the scope of the handler (as the worker would call it), nothing is written.
      const unscoped = filed();
      await expect(unscoped.host.records.createDevspace(NEW, 'acme/api', DEFAULT)).rejects.toThrow('names no Docker host');
      expect(unscoped.file().devspaces).toEqual([]);
    });

    it('the configuration leaves out a volume of another account, logged by this window; the build only an image of the devspace', async () => {
      const own = { id: ID, repository: 'acme/api', volumeName: 'devspaces-api', containerName: 'devspaces-api', owner: { id: '42', login: 'octo' }, dockerHost: HOST } as Devspace;
      const theirs = { id: 'e7', repository: 'acme/api', volumeName: 'devspaces-theirs', containerName: 'devspaces-theirs', owner: { id: '7', login: 'x' }, additionalVolumes: ['their-data'], dockerHost: HOST } as Devspace;
      const { host, warnings, file } = filed([own, theirs]);
      expect(await host.records.configuration(ID, { addVolumes: ['their-data', 'cache'] }, SCOPE)).toMatchObject({ additionalVolumes: ['cache'] });
      expect(warnings).toEqual(['The worker recorded the volume their-data for acme/api, which is left out: a devspace of another account uses it.']);
      await expect(host.records.configuration('e7', { cloned: true }, SCOPE)).rejects.toThrow('another account');
      expect(await host.records.build(ID, { kind: 'number', buildNumber: 4 }, SCOPE)).toMatchObject({ lastBuildNumber: 4 });
      const record = { builtAt: '2026-10-04T12:00:00.000Z', devspaceImage: 'devspaces-other:4', buildNumber: 4, configPath: DEFAULT, configHash: 'h', images: {}, features: {} };
      await expect(host.records.build(ID, { kind: 'record', record, dropRefused: false }, SCOPE)).rejects.toThrow('not one of an image of the devspace');
      expect(file().devspaces[0]).not.toHaveProperty('buildRecord');
    });

    it('the operation delete of extensionFlow may not send them', async () => {
      const { host } = filed();
      const sent: OperationOptions[] = [];
      const channels = { flow: vi.fn(async (_t: unknown, _op: string, _p: unknown, options: OperationOptions = {}) => (sent.push(options), {})) };
      await extensionFlow(channels as never, async () => ({ kind: 'remote' }) as never, host, silentLogger)(OP_DELETE, { repository: 'acme/api', dockerHost: HOST }, {});
      for (const payload of [
        { call: 'createDevspace', args: [{ id: NEW, repository: 'acme/api', configPath: DEFAULT }] },
        { call: 'configuration', args: [NEW, { cloned: true }] },
        { call: 'build', args: [NEW, 'number', 2] },
        { call: 'dropCreated', args: [NEW] },
      ]) {
        await expect(sent[0].onAsk!('record', payload, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid' });
      }
    });
  });
});
