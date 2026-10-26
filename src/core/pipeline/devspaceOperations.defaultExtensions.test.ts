// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The open of a window carries the user's default extensions (DevspaceOperationsDeps.defaultExtensionsOfWindow) only
// with the VS Code server of the window (the official VS Code); an empty list is not sent.
import { describe, expect, it } from 'vitest';
import { OP_OPEN, type OpenParams, type VscodeServerRef } from '../helperChannel/protocol';
import type { OperationFlow } from './devspaceOperations';
import { ENV_ID, createHarness, seedDevspace } from './devspaceService.testkit';

const OPENED = { devspaceId: ENV_ID, containerName: 'devspaces-acme-api-c', remoteWorkspaceFolder: '/workspaces/api' };
const IMAGES = { schedule: '7 6 * * *', timeZone: 'UTC' };
const SERVER: VscodeServerRef = { commit: '0123456789abcdef0123456789abcdef01234567', quality: 'stable' };

async function sentWith(server: VscodeServerRef | undefined, defaults: string[]): Promise<OpenParams> {
  const sent: OpenParams[] = [];
  const h = createHarness({
    monitorSource: () => '0123456789abcdef0123456789abcdef',
    openMonitor: () => ({ images: IMAGES }),
    vscodeServerOfWindow: async () => server,
    defaultExtensionsOfWindow: () => defaults,
    flow: (async (op, params) => {
      if (op !== OP_OPEN) throw new Error(`no answer for ${op} here`);
      sent.push(params as OpenParams);
      return { opened: OPENED };
    }) satisfies OperationFlow,
  });
  try {
    await seedDevspace(h, { container: 'running' });
    await h.operations.openDevspaceInWorker(ENV_ID, { progress: h.progress });
    return sent[0];
  } finally {
    h.cleanup();
  }
}

describe('the default extensions of an open', () => {
  it('are sent with the VS Code server of the window', async () => {
    expect((await sentWith(SERVER, ['a.b', 'c.d@1.0.0'])).defaultExtensions).toEqual(['a.b', 'c.d@1.0.0']);
  });

  it('are left out without a VS Code server, and when there are none', async () => {
    expect(await sentWith(undefined, ['a.b'])).not.toHaveProperty('defaultExtensions');
    expect(await sentWith(SERVER, [])).not.toHaveProperty('defaultExtensions');
  });
});
