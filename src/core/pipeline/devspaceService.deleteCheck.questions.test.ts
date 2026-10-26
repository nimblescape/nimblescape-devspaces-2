// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Mutation tests: the open questions in the gate of deleteCheckInWorker.
import type { OperationFlow } from './devspaceOperations';
import { describe, expect, it } from 'vitest';
import { ENV_ID, createHarness, seedDevspace } from './devspaceService.testkit';

type FlowOptions = Parameters<OperationFlow>[2];
const rejection = (p: Promise<unknown>) => p.then((value) => ({ resolved: value }), (error: unknown) => error);

describe('the open questions of the check of Delete', () => {
  it('a settled question does not block the decision; two asked and one settled does', async () => {
    let answer: (options: FlowOptions) => unknown = () => ({ decision: 'cancel' });
    const h = createHarness({ flow: async (_op, _params, options) => answer(options) });
    await seedDevspace(h, { container: 'stopped' });
    const check = () => rejection(h.operations.deleteCheckInWorker(ENV_ID, { progress: h.progress, repository: 'acme/api', otherWindow: false }));
    answer = (options) => {
      options.onQuestion?.('asked');
      options.onAnswer?.('confirmDelete', ['acme/api', {}], 'delete');
      options.onQuestion?.('settled');
      return { decision: 'delete', additionalVolumesToRemove: [] };
    };
    expect(await check()).toEqual({ resolved: { decision: 'delete', additionalVolumesToRemove: [] } });
    answer = (options) => {
      options.onQuestion?.('asked');
      options.onQuestion?.('asked');
      options.onAnswer?.('confirmDelete', ['acme/api', {}], 'delete');
      options.onQuestion?.('settled');
      return { decision: 'delete', additionalVolumesToRemove: [] };
    };
    expect(((await check()) as Error).message).toContain('a decision that the user did not give');
  });
});
