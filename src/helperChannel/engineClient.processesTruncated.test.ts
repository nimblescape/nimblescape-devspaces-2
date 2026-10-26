// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// DockerEngine.processes: an answer that the API cut (truncated) is a failure even when what was kept reads as a list,
// so the cleanup of the store never takes a cut list of processes as the whole one (it would miss a server in use).
import { describe, expect, it } from 'vitest';
import type { EngineAnswer, EngineApi } from './engineApi';
import { dockerEngine } from './engineClient';

function fake(answer: EngineAnswer) {
  const api: EngineApi = async () => answer;
  return dockerEngine(api, async () => Promise.reject(new Error('no exec in this test')));
}

describe('the processes of a container: a cut answer', () => {
  it('a cut answer is a failure, also when the kept text is a valid list', async () => {
    const body = JSON.stringify({ Titles: ['PID', 'CMD'], Processes: [['1', 'sleep infinity']] });
    await expect(fake({ status: 200, body, truncated: true }).processes('a')).rejects.toThrow('more than can be read');
    expect(await fake({ status: 200, body, truncated: false }).processes('a')).toEqual([['1', 'sleep infinity']]);
  });
});
