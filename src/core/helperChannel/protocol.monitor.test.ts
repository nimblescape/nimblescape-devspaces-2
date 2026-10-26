// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The strict checks of the operations `heartbeat` and `recordGitState` (the monitor settings and the list come with
// `open`, protocol.open.test.ts).
import { describe, expect, it } from 'vitest';
import {
  MAX_MONITOR_DETAIL_LENGTH,
  parseHeartbeatParams,
  parseHeartbeatValue,
  parseRecordGitStateParams,
  parseRecordGitStateValue,
} from './protocol';

const SOURCE = '0123456789abcdef0123456789abcdef';
const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const HEARTBEAT = { source: SOURCE, limitSeconds: 600, devspaces: [{ id: ID, keepRunning: false, seq: 1 }] };

describe('the operations of the Monitor in the worker', () => {
  it('heartbeat: the heartbeat as the monitor takes it, and nothing else', () => {
    expect(parseHeartbeatParams({ heartbeat: HEARTBEAT })).toEqual({ heartbeat: HEARTBEAT });
    expect(parseHeartbeatParams({ heartbeat: { ...HEARTBEAT, release: true } })).toEqual({ heartbeat: { ...HEARTBEAT, release: true } });
    // The limit is clamped as the monitor clamps it.
    expect(parseHeartbeatParams({ heartbeat: { ...HEARTBEAT, limitSeconds: 10 ** 9 } })?.heartbeat.limitSeconds).toBe(86_400);
    for (const odd of [
      undefined,
      {},
      { heartbeat: HEARTBEAT, extra: 1 },
      { heartbeat: { ...HEARTBEAT, source: '../x' } },
      { heartbeat: { ...HEARTBEAT, release: false } },
      { heartbeat: { ...HEARTBEAT, devspaces: [{ id: ID, keepRunning: true, seq: 1, clearOnly: true }] } },
      { heartbeat: { ...HEARTBEAT, devspaces: Array.from({ length: 201 }, () => HEARTBEAT.devspaces[0]) } },
    ]) {
      expect(parseHeartbeatParams(odd), JSON.stringify(odd)).toBeUndefined();
    }
  });

  it('heartbeat: the answer, ok or a bounded failure', () => {
    expect(parseHeartbeatValue({ ok: true })).toEqual({ ok: true });
    expect(parseHeartbeatValue({ ok: false, missing: true, detail: 'gone' })).toEqual({ ok: false, missing: true, detail: 'gone' });
    expect(parseHeartbeatValue({ ok: false, missing: false, detail: 'x'.repeat(MAX_MONITOR_DETAIL_LENGTH) })).toBeDefined();
    for (const odd of [null, { ok: true, missing: false }, { ok: false, detail: 'x' }, { ok: false, missing: 'no', detail: 'x' }, { ok: false, missing: false, detail: 'x'.repeat(MAX_MONITOR_DETAIL_LENGTH + 1) }, { ok: 'yes' }]) {
      expect(parseHeartbeatValue(odd), JSON.stringify(odd)).toBeUndefined();
    }
  });

  it('recordGitState: the devspace, the Docker host and the window; the answer whether it was recorded', () => {
    const params = { devspaceId: ID, dockerHost: 'ssh://box', owner: { windowId: 'window-1', pid: 7 } };
    expect(parseRecordGitStateParams(params)).toEqual(params);
    for (const odd of [{ ...params, devspaceId: '../x' }, { ...params, extra: 1 }, { ...params, dockerHost: 'a\nb' }, { ...params, owner: { windowId: 'window-1', pid: 0 } }]) {
      expect(parseRecordGitStateParams(odd), JSON.stringify(odd)).toBeUndefined();
    }
    expect(parseRecordGitStateValue({ recorded: false })).toEqual({ recorded: false });
    expect(parseRecordGitStateValue({ recorded: 1 })).toBeUndefined();
  });
});
