// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The view of the windows (process, status files) of the busy marks that this computer sets for a flow.

// The HostSide of this computer, which answers the requests of a flow in the worker: where the registry logins come
// from, how a record changes, and what is refused.
import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../core/ports';
import type { Devspace } from '../core/types';
import { extensionHostSide, type HostSideDeps } from './hostSide';

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


// The busy marks of a flow are this window's, set by this computer with its clock and its view of the windows; the
// reopen record goes only with its devspace.

describe('the view of the windows of the busy marks of a flow', () => {
  const other = { operation: 'update' as const, since: '2026-10-04T11:59:00.000Z', pid: 200, windowId: 'w2' };
  function withMark(overrides: Record<string, unknown>) {
    const base = deps();
    const devspace = base.devspace;
    devspace.busy = { ...other };
    const registry = { ...base.registry, updateDevspace: vi.fn(async (_id: string, change: (e: Devspace) => void) => (change(devspace), devspace)) };
    return { host: extensionHostSide(deps({ registry, ...overrides } as never).all), devspace };
  }
  it('a mark of a window without a recent status file is taken over', async () => {
    const { host } = withMark({});
    expect(await host.records.markBusy('e1', 'delete')).toEqual({ devspace: expect.objectContaining({ busy: expect.objectContaining({ pid: 100, windowId: 'w1' }) }) });
  });
  it('a mark of an ended process is taken over even with a recent status file', async () => {
    const base = deps();
    const { host } = withMark({
      isProcessAlive: (pid: number) => pid !== 200,
      sessionFiles: { ...base.sessionFiles, readWindowStatuses: vi.fn(async () => [{ windowId: 'w2', pid: 200, updatedAt: '2026-10-04T11:59:50.000Z' }]) },
    });
    expect(await host.records.markBusy('e1', 'delete')).toEqual({ devspace: expect.objectContaining({ busy: expect.objectContaining({ pid: 100 }) }) });
  });
});
