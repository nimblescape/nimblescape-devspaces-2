// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Probes of DevspaceOperations on the extension's side. A cancel during the start of Docker sends no open to the
// worker; the cleanup after a lost worker open (afterLostWorkerOpen) never touches the busy mark of another window or
// of another process of this window, and cleans up the devspace of the Docker host of the open, never the one of the
// same repository on another host.
import { describe, expect, it } from 'vitest';
import { HelperChannelError } from '../helperChannel/helperChannel';
import type { BusyMark } from '../types';
import type { OperationFlow } from './devspaceOperations';
import { ENV_ID, OTHER_ID, PID, REPO, WINDOW_ID, createHarness, seedDevspace } from './devspaceService.testkit';

const OPENED = { devspaceId: ENV_ID, containerName: 'devspaces-acme-api-c', remoteWorkspaceFolder: '/workspaces/api' };
const IMAGES = { schedule: '7 6 * * *', timeZone: 'UTC' };

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (value) => ({ resolved: value }),
    (error: unknown) => error,
  );
}

function lostWorker(sent: string[]): OperationFlow {
  return async (op) => {
    sent.push(op);
    throw new HelperChannelError('closed', 'The worker ended.');
  };
}

const monitor = { monitorSource: () => '0123456789abcdef0123456789abcdef', openMonitor: () => ({ images: IMAGES }) };

/** Waits until `condition` holds (at most about a second). */
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(condition()).toBe(true);
}

describe('the gate of the opens in the worker', () => {
  it('the opens of two devspaces of one repository run next to each other; the opens of one devspace one after the other', async () => {
    const started: string[] = [];
    const releases: Array<() => void> = [];
    const h = createHarness({
      ...monitor,
      flow: async (_op, params) => {
        const { devspaceId } = params as { devspaceId: string };
        started.push(devspaceId);
        await new Promise<void>((resolve) => releases.push(resolve));
        const devspace = await h.registry.get(devspaceId);
        return { opened: { devspaceId, containerName: devspace!.containerName, remoteWorkspaceFolder: '/workspaces/api' } };
      },
    });
    try {
      // The configuration devspace and the default-image devspace of one repository.
      await seedDevspace(h, { id: ENV_ID, container: 'stopped' });
      await seedDevspace(h, { id: OTHER_ID, container: 'stopped', extra: { defaultImage: 'ghcr.io/acme/base:latest' } });
      const first = h.operations.openDevspaceInWorker(ENV_ID, { progress: h.progress });
      const second = h.operations.openDevspaceInWorker(OTHER_ID, { progress: h.progress });
      await until(() => started.length === 2);
      // Both opens reach the worker, in either order (their gates are independent).
      expect([...started].sort()).toEqual([ENV_ID, OTHER_ID].sort());
      // A second open of the first devspace waits for its first open.
      const again = h.operations.openDevspaceInWorker(ENV_ID, { progress: h.progress });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(started).toHaveLength(2);
      releases[0]();
      releases[1]();
      await Promise.all([first, second]);
      await until(() => started.length === 3);
      expect(started[2]).toBe(ENV_ID);
      releases[2]();
      await again;
    } finally {
      h.cleanup();
    }
  });
});

describe('the open in the worker, probes', () => {
  it('a cancel while Docker starts sends nothing to the worker', async () => {
    const controller = new AbortController();
    const sent: string[] = [];
    const h = createHarness({
      ...monitor,
      startDocker: async () => {
        controller.abort();
      },
      flow: async (op) => {
        sent.push(op);
        return { opened: OPENED };
      },
    });
    try {
      await seedDevspace(h, { container: 'stopped' });
      const error = await rejection(h.operations.openDevspaceInWorker(ENV_ID, { progress: h.progress, signal: controller.signal }));
      expect(error).toMatchObject({ code: 'cancelled' });
      expect(sent).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('after a lost worker open, the busy mark of another window or of another process of this window stays', async () => {
    const marks: BusyMark[] = [];
    for (const operation of ['update', 'create'] as const) {
      // The same process, another window; and this window's id in another process (a reloaded window).
      marks.push({ operation, since: new Date().toISOString(), pid: PID, windowId: 'window-2' });
      marks.push({ operation, since: new Date().toISOString(), pid: PID + 1, windowId: WINDOW_ID });
    }
    for (const mark of marks) {
      const sent: string[] = [];
      const h = createHarness({ ...monitor, flow: lostWorker(sent) });
      try {
        await seedDevspace(h, { container: 'stopped', extra: { busy: mark } });
        await rejection(h.operations.openDevspaceInWorker(ENV_ID, { progress: h.progress }));
        expect(sent).toHaveLength(1);
        expect((await h.registry.get(ENV_ID))?.busy, JSON.stringify(mark)).toEqual(mark);
      } finally {
        h.cleanup();
      }
    }
  });

  it('after a lost worker open of a repository, the devspace of the Docker host of the open is cleaned up, never the one of another host', async () => {
    const sent: string[] = [];
    const h = createHarness({ ...monitor, dockerHost: async () => 'ssh://box', flow: lostWorker(sent) });
    try {
      const own = (): BusyMark => ({ operation: 'update', since: new Date().toISOString(), pid: PID, windowId: WINDOW_ID });
      // The same repository of the same account: one devspace on the local Docker, one on the SSH host of the open.
      const localMark = own();
      await seedDevspace(h, { id: ENV_ID, container: 'stopped', extra: { busy: localMark } });
      await seedDevspace(h, { id: OTHER_ID, container: 'stopped', extra: { busy: own(), dockerHost: 'ssh://box' } });
      await h.sessionFiles.writePending(ENV_ID, WINDOW_ID);
      await h.sessionFiles.writePending(OTHER_ID, WINDOW_ID);
      await rejection(h.operations.openInWorker({ repository: REPO, configPaths: [], trusted: true }, { progress: h.progress }));
      expect(sent).toHaveLength(1);
      expect((await h.registry.get(OTHER_ID))?.busy).toBeUndefined();
      expect((await h.registry.get(ENV_ID))?.busy).toEqual(localMark);
      expect((await h.sessionFiles.readPendings()).map((pending) => pending.devspaceId)).toEqual([ENV_ID]);
    } finally {
      h.cleanup();
    }
  });
});
