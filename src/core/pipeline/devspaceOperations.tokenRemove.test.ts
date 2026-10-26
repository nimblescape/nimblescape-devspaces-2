// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The token removal through the operations of the window (removeTokenInWorker), as every other flow: its operation,
// parameters, time limit and texts.
import { describe, expect, it } from 'vitest';
import { OP_TOKEN_REMOVE } from '../helperChannel/protocol';
import type { OperationFlow } from './devspaceOperations';
import { createHarness } from './devspaceService.testkit';
import { TOKEN_REMOVE_FLOW_TIMEOUT_MS } from './operationBase';

const ENV_ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const CONTAINER = 'devspaces-acme-api-brave-noether';

function harness(answer: () => Promise<unknown>) {
  const calls: Parameters<OperationFlow>[] = [];
  const h = createHarness({ flow: async (...args) => (calls.push(args), answer()) });
  return { h, calls };
}

describe('removeTokenInWorker', () => {
  it('sends `tokenRemove` with the devspace and the container, within TOKEN_REMOVE_FLOW_TIMEOUT_MS, and answers its value', async () => {
    const { h, calls } = harness(async () => ({ outcome: 'removed', container: 'c0ffeec0ffee' }));
    expect(await h.operations.removeTokenInWorker(ENV_ID, CONTAINER)).toEqual({ outcome: 'removed', container: 'c0ffeec0ffee' });
    expect(calls).toEqual([[OP_TOKEN_REMOVE, { devspaceId: ENV_ID, containerName: CONTAINER }, { timeoutMs: TOKEN_REMOVE_FLOW_TIMEOUT_MS }]]);
    expect(TOKEN_REMOVE_FLOW_TIMEOUT_MS).toBe(60_000);
  });

  it('rejects an invalid answer, and a failed flow with its own error (not as a refusal of the lock)', async () => {
    await expect(harness(async () => ({ outcome: 'maybe' })).h.operations.removeTokenInWorker(ENV_ID, CONTAINER)).rejects.toThrow(
      /^The worker answered the token removal with an invalid value\.$/,
    );
    const failure = new Error('/run/devspace/github-token could not be removed.');
    await expect(harness(async () => Promise.reject(failure)).h.operations.removeTokenInWorker(ENV_ID, CONTAINER)).rejects.toBe(failure);
  });
});
