// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// A stopNow record (a manual Stop) that is the newest record of its devspace stops it at the first tick
// STOP_NOW_HOLD_MS after it, whatever older keeps, limits or the grace say; a newer record of any source decides
// instead.
import { describe, expect, it } from 'vitest';
import { REMOTE_TICK_MS, STOP_NOW_HOLD_MS, decide, initialRemoteState, type RemoteContainer, type RemoteMonitorState, type RemoteRecord } from './rules';

const A = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const SOURCE = '0123456789abcdef0123456789abcdef';
const OTHER = 'fedcba9876543210fedcba9876543210';
const T0 = Date.parse('2026-10-11T12:00:00.000Z');
const MINUTE = 60_000;

const dev: RemoteContainer = { id: 'dev', state: 'running', name: 'devspaces-api', devspaceId: A, composeService: '' };
const db: RemoteContainer = { id: 'db', state: 'running', name: 'devspaces-api-db-1', devspaceId: A, composeService: 'db' };

function record(at: number, extra: Partial<RemoteRecord> = {}): RemoteRecord {
  return { source: SOURCE, devspaceId: A, at, keepRunning: false, limitSeconds: 600, ...extra };
}

const running = (now: number): RemoteMonitorState => ({ lastTickAt: now - REMOTE_TICK_MS });

function stopsAt(now: number, records: RemoteRecord[], state: RemoteMonitorState = running(now)): string[] {
  return decide({ now, containers: [db, dev], records, state }).stop.flatMap((stop) => stop.containers.map((container) => container.id));
}

describe('decide: a stopNow record', () => {
  it('holds for one tick, so the window takes the lock first', () => {
    expect(STOP_NOW_HOLD_MS).toBe(REMOTE_TICK_MS);
  });

  // Mutation: without the stopNow rule, the record is a plain one within its limit (no stop for 10 minutes).
  it('stops the devspace, dev container first, once it is STOP_NOW_HOLD_MS old, within its limit', () => {
    const stop = record(T0, { stopNow: true });
    expect(stopsAt(T0, [stop])).toEqual([]);
    expect(stopsAt(T0 + STOP_NOW_HOLD_MS - 1, [stop])).toEqual([]);
    expect(stopsAt(T0 + STOP_NOW_HOLD_MS, [stop])).toEqual(['dev', 'db']);
    expect(decide({ now: T0 + STOP_NOW_HOLD_MS, containers: [dev], records: [stop], state: running(T0 + STOP_NOW_HOLD_MS) }).stop[0].reason).toBe(
      'a computer asked to stop it (Stop) 15 seconds ago',
    );
  });

  // Mutation: with the stopNow rule after the keep, the older keep of another computer would keep it.
  it('stops whatever older keepRunning records of any source say (Keep Running When Closed, Close and Keep Running)', () => {
    // The own keep of the source is replaced by the stopNow (one file per source); the older keep of another computer stays.
    const records = [record(T0 - MINUTE, { source: OTHER, keepRunning: true }), record(T0, { stopNow: true })];
    expect(stopsAt(T0 + STOP_NOW_HOLD_MS, records)).toEqual(['dev', 'db']);
  });

  // Mutation: with the stopNow rule after the grace, a monitor that just started (or after a pause) waits 5 minutes.
  it('stops also during the grace of the gap rule (a start of the monitor, a pause)', () => {
    const now = T0 + STOP_NOW_HOLD_MS;
    const atStart = decide({ now, containers: [dev], records: [record(T0, { stopNow: true })], state: initialRemoteState() });
    expect(atStart.grace).toBe(true);
    expect(atStart.stop.map((stop) => stop.devspaceId)).toEqual([A]);
  });

  // Mutations: `>` for `>=` (a tie), or no check of the other records at all.
  it('never stops while another record is as new or newer: an open, or a heartbeat of any source, after the Stop', () => {
    const stop = record(T0, { stopNow: true });
    const later = T0 + 10 * MINUTE;
    expect(stopsAt(later, [stop, record(T0 + 5 * MINUTE, { source: OTHER })])).toEqual([]);
    expect(stopsAt(later, [stop, record(T0, { source: OTHER })])).toEqual([]);
    expect(stopsAt(later, [stop, record(T0 + 5 * MINUTE, { source: OTHER, keepRunning: true })])).toEqual([]);
    // The newer record decides by its own rules: a plain one stops after its limit.
    expect(stopsAt(T0 + 16 * MINUTE, [stop, record(T0 + 5 * MINUTE, { source: OTHER })])).toEqual(['dev', 'db']);
  });

  // The data-loss rule: the record stays after the stop; a later open writes a newer record of the same source (one
  // file per source and devspace), and the old Stop never stops it.
  it('a later open (a newer record of the same source) replaces it: no stop, also after a restart of the monitor', () => {
    const open = record(T0 + 30 * MINUTE, { keepRunning: false });
    expect(stopsAt(T0 + 31 * MINUTE, [open])).toEqual([]);
    expect(decide({ now: T0 + 31 * MINUTE, containers: [dev], records: [open], state: initialRemoteState() }).stop).toEqual([]);
  });

  it('an old stopNow record at the start of the monitor stops a container that nothing used since (no newer record)', () => {
    const now = T0 + 12 * MINUTE;
    expect(decide({ now, containers: [dev], records: [record(T0, { stopNow: true })], state: initialRemoteState() }).stop).toHaveLength(1);
  });

  // A newer release of another computer does not make an older stopNow act at once.
  it('a stopNow that a newer release falls back to counts as a plain record within its limit', () => {
    const records = [record(T0, { stopNow: true }), record(T0 + MINUTE, { source: OTHER, limitSeconds: 300, release: true })];
    expect(stopsAt(T0 + 2 * MINUTE, records)).toEqual([]);
    expect(stopsAt(T0 + 11 * MINUTE, records)).toEqual(['dev', 'db']);
  });

  it('acts on running containers only; a stopped devspace keeps its record', () => {
    const decision = decide({ now: T0 + MINUTE, containers: [{ ...dev, state: 'exited' }], records: [record(T0, { stopNow: true })], state: running(T0 + MINUTE) });
    expect(decision.stop).toEqual([]);
    expect(decision.forget).toEqual([]);
    expect(decision.superseded).toEqual([]);
  });
});
