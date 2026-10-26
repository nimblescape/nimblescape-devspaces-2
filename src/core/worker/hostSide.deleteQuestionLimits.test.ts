// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// hostSideHandler: the limits of the questions of Delete.
import { describe, expect, it } from 'vitest';
import { OP_DELETE_CHECK } from '../helperChannel/protocol';
import { silentLogger } from '../ports';
import { FLOW_REQUESTS, type HostSide } from './hostSide';
import { hostSideHandler } from './hostSideHandler';

// The changes are counts and the folders have at most 255 characters.
const CONFIRMATION = { changes: { uncommittedFiles: 2, unpushedCommits: 0 }, recordedAt: '2026-10-04T10:00:00.000Z', lastSeenInUse: '2026-10-04T09:00:00.000Z', repositoryData: ['data/db'], otherWindow: false };

function handlerOf() {
  const calls: string[] = [];
  const questions = {
    confirmDelete: async () => (calls.push('confirmDelete'), undefined),
    deleteAdditionalVolumes: async () => (calls.push('deleteAdditionalVolumes'), undefined),
    deleteServiceData: async () => (calls.push('deleteServiceData'), undefined),
  };
  const host = { questions, records: {}, state: {}, secrets: {}, connect: {} } as unknown as HostSide;
  const handler = hostSideHandler(host, silentLogger, FLOW_REQUESTS[OP_DELETE_CHECK], { devspaceId: 'e1' });
  const signal = new AbortController().signal;
  return { ask: (call: string, args: unknown[]) => handler('question', { call, args }, signal), calls };
}

describe('the limits of the questions of Delete', () => {
  it('refuses what is too long, too many or not plain', async () => {
    const { ask, calls } = handlerOf();
    const names = (n: number) => Array.from({ length: n }, (_, i) => `v${i}`);
    for (const [call, args] of [
      ['deleteAdditionalVolumes', [names(1001)]],
      ['deleteServiceData', [['v'], names(1001)]],
      ['deleteAdditionalVolumes', [['a'.repeat(256)]]],
      ['confirmDelete', ['r', { ...CONFIRMATION, repositoryData: ['d'.repeat(256)] }]],
      ['confirmDelete', ['r', { ...CONFIRMATION, repositoryData: names(1001) }]],
      ['confirmDelete', ['r', { ...CONFIRMATION, repositoryData: ['a\nb'] }]],
      ['confirmDelete', ['r', { ...CONFIRMATION, lastSeenInUse: 'a\nb' }]],
      ['confirmDelete', ['r', { ...CONFIRMATION, recordedAt: 't'.repeat(65) }]],
    ] as const) {
      await expect(ask(call, [...args]), `${call} ${JSON.stringify(args).slice(0, 80)}`).rejects.toMatchObject({ code: 'invalid' });
    }
    expect(calls).toEqual([]);
    // The limits themselves are allowed.
    await ask('deleteAdditionalVolumes', [names(1000)]);
    await ask('deleteAdditionalVolumes', [['a'.repeat(255)]]);
    await ask('confirmDelete', ['r', { ...CONFIRMATION, recordedAt: 't'.repeat(64), repositoryData: ['d'.repeat(255)] }]);
    expect(calls).toEqual(['deleteAdditionalVolumes', 'deleteAdditionalVolumes', 'confirmDelete']);
  });

  it('a dismissed question of Delete is answered null', async () => {
    const { ask } = handlerOf();
    expect(await ask('confirmDelete', ['r', CONFIRMATION])).toEqual({ value: null });
    expect(await ask('deleteAdditionalVolumes', [['v']])).toEqual({ value: null });
    expect(await ask('deleteServiceData', [['v'], []])).toEqual({ value: null });
  });
});
