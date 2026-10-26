// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The stopNow of a manual Stop in a heartbeat entry and in a record, checked
// strictly (the worker and the monitor use the same checks).
import { describe, expect, it } from 'vitest';
import { parseHeartbeatInput, parseHeartbeatRecord } from './protocol';

const SOURCE = '0123456789abcdef0123456789abcdef';
const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';

const heartbeat = (entry: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ source: SOURCE, limitSeconds: 600, devspaces: [{ id: ID, keepRunning: false, seq: 1, ...entry }], ...extra });

describe('parseHeartbeatInput: stopNow', () => {
  it('takes stopNow true with keepRunning false', () => {
    expect(parseHeartbeatInput(heartbeat({ stopNow: true }))?.devspaces).toEqual([{ id: ID, keepRunning: false, seq: 1, stopNow: true }]);
    // Without it, an entry has none.
    expect(parseHeartbeatInput(heartbeat({}))?.devspaces).toEqual([{ id: ID, keepRunning: false, seq: 1 }]);
  });

  // Mutations: each of the checks of the value and of its combinations.
  it.each([
    ['false', { stopNow: false }, {}],
    ['a string', { stopNow: 'true' }, {}],
    ['1', { stopNow: 1 }, {}],
    ['null', { stopNow: null }, {}],
    ['with keepRunning true', { stopNow: true, keepRunning: true }, {}],
    ['with clearOnly true', { stopNow: true, clearOnly: true }, {}],
    ['with clearOnly false', { stopNow: true, clearOnly: false }, {}],
    ['in a release', { stopNow: true }, { release: true }],
    ['with another key', { stopNow: true, stopAt: 1 }, {}],
  ])('refuses the whole heartbeat for stopNow %s', (_name, entry, extra) => {
    expect(parseHeartbeatInput(heartbeat(entry, extra))).toBeUndefined();
  });
});

describe('parseHeartbeatRecord: stopNow', () => {
  const record = (extra: Record<string, unknown>): string => JSON.stringify({ at: 5, keepRunning: false, limitSeconds: 600, seq: 1, ...extra });

  it('reads the record of a manual Stop', () => {
    expect(parseHeartbeatRecord(record({ stopNow: true }))).toEqual({ at: 5, keepRunning: false, limitSeconds: 600, seq: 1, stopNow: true });
    expect(parseHeartbeatRecord(record({}))).toEqual({ at: 5, keepRunning: false, limitSeconds: 600, seq: 1 });
  });

  it.each([
    ['false', { stopNow: false }],
    ['a string', { stopNow: 'yes' }],
    ['with keepRunning true', { stopNow: true, keepRunning: true }],
    ['of a release', { stopNow: true, release: true }],
  ])('is no valid record with stopNow %s', (_name, extra) => {
    expect(parseHeartbeatRecord(record(extra))).toBeUndefined();
  });
});
