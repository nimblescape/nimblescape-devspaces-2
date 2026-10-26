// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The requests that the monitor operations may send.
import { describe, expect, it } from 'vitest';
import { OP_HEARTBEAT, OP_RECORD_GIT_STATE } from '../helperChannel/protocol';
import { FLOW_REQUESTS } from './hostSide';

describe('FLOW_REQUESTS of the monitor operations', () => {
  // There is no operation `monitorSettings`: the settings of the monitor and its list come with the open.
  it('heartbeat sends nothing; recordGitState only reads and records its devspace', () => {
    expect(FLOW_REQUESTS[OP_HEARTBEAT] ?? []).toEqual([]);
    expect(FLOW_REQUESTS.monitorSettings).toBeUndefined();
    expect([...FLOW_REQUESTS[OP_RECORD_GIT_STATE]].sort()).toEqual(['record get', 'record recordGitSummary']);
  });
});
