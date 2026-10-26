// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { PIPE_LOADER } from '../loader/pipeLoader';
import {
  DEFAULT_REMOTE_STOP_AFTER_SECONDS,
  MAX_HEARTBEAT_DEVSPACES,
  REMOTE_MONITOR_ENTRY,
  REMOTE_MONITOR_READY_TEXT,
  REMOTE_MONITOR_SCRIPT_PATH,
  LAST_USE_FILE,
  UNUSED_END_MS,
  clampLimitSeconds,
  forgetIfUnchangedCommand,
  isMonitorCreateId,
  parseLastUse,
  isUnderRecordsLock,
  monitorExecFailure,
  heartbeatFileName,
  isRemoteDevspaceId,
  isSourceId,
  parseHeartbeatFileName,
  parseHeartbeatInput,
  parseHeartbeatRecord,
  remoteMonitorLabelValue,
  underRecordsLock,
} from './protocol';

const SOURCE = '0123456789abcdef0123456789abcdef';
const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';

const input = (value: unknown): string => JSON.stringify(value);

describe('ids of the heartbeat protocol', () => {
  it.each<[unknown, boolean]>([
    [SOURCE, true],
    [SOURCE.toUpperCase(), false],
    [SOURCE.slice(1), false],
    [`${SOURCE}0`, false],
    ['../../etc/passwd000000000000000000', false],
    [42, false],
  ])('source %j → %s', (value, expected) => {
    expect(isSourceId(value)).toBe(expected);
  });

  it.each<[unknown, boolean]>([
    [ID, true],
    [ID.toUpperCase(), false],
    [ID.slice(1), false],
    ['3f2a9c1e/5b7d-4e8a-9c0f-2d1e6a7b8c9d', false],
    ['3f2a9c1e.5b7d-4e8a-9c0f-2d1e6a7b8c9d', false],
    [undefined, false],
  ])('devspace id %j → %s', (value, expected) => {
    expect(isRemoteDevspaceId(value)).toBe(expected);
  });
});

describe('parseHeartbeatInput (strict)', () => {
  const valid = { source: SOURCE, limitSeconds: 600, devspaces: [{ id: ID, keepRunning: false, seq: 1_790_000_000_000 }] };

  it('accepts a valid heartbeat, also without devspaces', () => {
    expect(parseHeartbeatInput(input(valid))).toEqual(valid);
    expect(parseHeartbeatInput(input({ ...valid, devspaces: [] }))).toEqual({ ...valid, devspaces: [] });
  });

  it('clamps the limit to one minute..one day', () => {
    expect(parseHeartbeatInput(input({ ...valid, limitSeconds: 5 }))?.limitSeconds).toBe(60);
    expect(parseHeartbeatInput(input({ ...valid, limitSeconds: 10_000_000 }))?.limitSeconds).toBe(86_400);
  });

  it.each<[string, unknown]>([
    ['not JSON', '{'],
    ['an array', [valid]],
    ['null', null],
    ['an unknown key', { ...valid, extra: 1 }],
    ['a missing key', { source: SOURCE, limitSeconds: 600 }],
    ['an invalid source', { ...valid, source: 'x' }],
    ['a limit that is no integer', { ...valid, limitSeconds: 60.5 }],
    ['a limit as text', { ...valid, limitSeconds: '600' }],
    ['devspaces that are no list', { ...valid, devspaces: {} }],
    ['a devspace with an invalid id', { ...valid, devspaces: [{ id: '../x', keepRunning: true, seq: 1 }] }],
    ['a devspace with keepRunning as text', { ...valid, devspaces: [{ id: ID, keepRunning: 'true', seq: 1 }] }],
    ['a devspace with an unknown key', { ...valid, devspaces: [{ id: ID, keepRunning: true, seq: 1, x: 1 }] }],
    // Every entry carries its seq, a safe non-negative integer.
    ['a devspace without seq', { ...valid, devspaces: [{ id: ID, keepRunning: true }] }],
    ['a negative seq', { ...valid, devspaces: [{ id: ID, keepRunning: true, seq: -1 }] }],
    ['a seq that is no integer', { ...valid, devspaces: [{ id: ID, keepRunning: true, seq: 1.5 }] }],
    ['a seq beyond the safe integers', { ...valid, devspaces: [{ id: ID, keepRunning: true, seq: 2 ** 60 }] }],
    ['a seq as text', { ...valid, devspaces: [{ id: ID, keepRunning: true, seq: '1' }] }],
    ['a devspace that is no object', { ...valid, devspaces: [ID] }],
    [
      'too many devspaces',
      { ...valid, devspaces: Array.from({ length: MAX_HEARTBEAT_DEVSPACES + 1 }, () => ({ id: ID, keepRunning: false, seq: 1 })) },
    ],
  ])('refuses %s', (_name, value) => {
    expect(parseHeartbeatInput(typeof value === 'string' ? value : input(value))).toBeUndefined();
  });

  it('accepts clearOnly as a boolean, and true only without keepRunning', () => {
    const entry = (extra: Record<string, unknown>) => input({ ...valid, devspaces: [{ id: ID, keepRunning: false, seq: 1, ...extra }] });
    expect(parseHeartbeatInput(entry({ clearOnly: true }))?.devspaces).toEqual([{ id: ID, keepRunning: false, seq: 1, clearOnly: true }]);
    expect(parseHeartbeatInput(entry({ clearOnly: false }))?.devspaces).toEqual([{ id: ID, keepRunning: false, seq: 1 }]);
    expect(parseHeartbeatInput(entry({ clearOnly: true, keepRunning: true }))).toBeUndefined();
    expect(parseHeartbeatInput(entry({ clearOnly: 'yes' }))).toBeUndefined();
    expect(parseHeartbeatInput(entry({ clearOnly: 1 }))).toBeUndefined();
  });

  it('accepts the largest number of devspaces', () => {
    const devspaces = Array.from({ length: MAX_HEARTBEAT_DEVSPACES }, () => ({ id: ID, keepRunning: true, seq: 0 }));
    expect(parseHeartbeatInput(input({ ...valid, devspaces }))?.devspaces).toHaveLength(MAX_HEARTBEAT_DEVSPACES);
  });

  it('refuses a text that is too long', () => {
    expect(parseHeartbeatInput(' '.repeat(40_000) + input(valid))).toBeUndefined();
  });
});

describe('records and their file names', () => {
  it('parses a valid record and refuses invalid ones', () => {
    expect(parseHeartbeatRecord(input({ at: 1000, keepRunning: true, limitSeconds: 600, seq: 7 }))).toEqual({ at: 1000, keepRunning: true, limitSeconds: 600, seq: 7 });
    for (const value of [
      { at: -1, keepRunning: true, limitSeconds: 600, seq: 7 },
      { at: 1.5, keepRunning: true, limitSeconds: 600, seq: 7 },
      { at: 1000, keepRunning: 'yes', limitSeconds: 600, seq: 7 },
      { at: 1000, keepRunning: true, limitSeconds: 59, seq: 7 },
      { at: 1000, keepRunning: true, limitSeconds: 86_401, seq: 7 },
      { at: 1000, keepRunning: true, seq: 7 },
      // A record without seq is invalid.
      { at: 1000, keepRunning: true, limitSeconds: 600 },
      { at: 1000, keepRunning: true, limitSeconds: 600, seq: -3 },
      [1000],
    ]) {
      expect(parseHeartbeatRecord(input(value)), JSON.stringify(value)).toBeUndefined();
    }
    expect(parseHeartbeatRecord('not json')).toBeUndefined();
  });

  it('names a record <source>.<devspace id>.json, and parses only such names', () => {
    const name = heartbeatFileName(SOURCE, ID);
    expect(name).toBe(`${SOURCE}.${ID}.json`);
    expect(parseHeartbeatFileName(name)).toEqual({ source: SOURCE, devspaceId: ID });
    for (const other of [`.${name}.12.tmp`, `${SOURCE}.${ID}.json.bak`, `${SOURCE}.${ID}`, 'x.json', `../${name}`]) {
      expect(parseHeartbeatFileName(other), other).toBeUndefined();
    }
    expect(() => heartbeatFileName('../x', ID)).toThrow();
    expect(() => heartbeatFileName(SOURCE, '../x')).toThrow();
  });
});

describe('the subcommands of the remote monitor', () => {
  it('passes the heartbeat as one JSON argument, and the ids as arguments', () => {
    // The heartbeat runs under the kernel lock of the records and a time limit; a lock that stays busy has its own exit
    // code, and `forget` runs under the same lock.
    const locked = ['flock', '-w', '5', '-E', '75', '/state/.heartbeats.lock', 'timeout', '-s', 'KILL', '10'];
    // The command lines of the entries monitorHeartbeat and monitorForget of the registry are checked in
    // src/core/worker/containerScripts.test.ts; the prefix that both take is the lock of the records.
    expect(underRecordsLock(['node', REMOTE_MONITOR_SCRIPT_PATH, 'heartbeat'])).toEqual([...locked, 'node', REMOTE_MONITOR_SCRIPT_PATH, 'heartbeat']);
    // The removal of an old record by the monitor itself, under the same lock.
    expect(forgetIfUnchangedCommand(SOURCE, ID, 1234)).toEqual([...locked, 'node', REMOTE_MONITOR_SCRIPT_PATH, 'forget', SOURCE, ID, '1234']);
  });

  // A busy lock and the time limit are named in the log, not only their exit codes. 137 is any SIGKILL, and only
  // commands under the lock get these texts.
  it('names the reason of a failed command under the lock of the records', () => {
    expect(monitorExecFailure(75, '', true)).toBe('the heartbeat records stayed locked by another command for 5 s');
    expect(monitorExecFailure(137, '', true)).toBe('the command was killed (its limit of 10 s, or a kill from outside)');
    expect(monitorExecFailure(2, 'Invalid heartbeat.\n', true)).toBe('Invalid heartbeat.');
    expect(monitorExecFailure(1, ' ', true)).toBe('exit code 1');
    expect(monitorExecFailure(137, '', false)).toBe('exit code 137');
    expect(monitorExecFailure(75, '', false)).toBe('exit code 75');
    // The heartbeat and the forget of the registry are checked in containerScripts.test.ts; here a command under the
    // lock (underRecordsLock) and one without.
    expect(isUnderRecordsLock(underRecordsLock(['node', REMOTE_MONITOR_SCRIPT_PATH, 'forget', SOURCE, ID]))).toBe(true);
    expect(isUnderRecordsLock(forgetIfUnchangedCommand(SOURCE, ID, 1234))).toBe(true);
    expect(isUnderRecordsLock(['node', REMOTE_MONITOR_SCRIPT_PATH, 'settings', '-'])).toBe(false);
  });
});

describe('limits and the label', () => {
  it('clamps a limit, and gives the default for a value that is no number', () => {
    expect(clampLimitSeconds(600)).toBe(600);
    expect(clampLimitSeconds(1)).toBe(60);
    expect(clampLimitSeconds(1e9)).toBe(86_400);
    expect(clampLimitSeconds(Number.NaN)).toBe(DEFAULT_REMOTE_STOP_AFTER_SECONDS);
  });

  it('labels the container with 12 hex digits of the script and the helper tag', () => {
    const label = remoteMonitorLabelValue('script', 'devspaces-worker:1');
    expect(label).toMatch(/^[0-9a-f]{12}$/);
    expect(remoteMonitorLabelValue('script', 'devspaces-worker:1')).toBe(label);
    expect(remoteMonitorLabelValue('script2', 'devspaces-worker:1')).not.toBe(label);
    expect(remoteMonitorLabelValue('script', 'devspaces-worker:2')).not.toBe(label);
    // The loader is part of the label, so every monitor of an older way of loading is replaced once.
    const withLoader = createHash('sha256').update('script\ndevspaces-worker:1\n', 'utf8').update(PIPE_LOADER, 'utf8').digest('hex');
    expect(label).toBe(withLoader.slice(0, 12));
    expect(label).not.toBe(createHash('sha256').update('script\ndevspaces-worker:1', 'utf8').digest('hex').slice(0, 12));
  });

  it('names where the loader stores the script, its entry, and the line of its start', () => {
    expect(REMOTE_MONITOR_SCRIPT_PATH).toBe('/opt/devspace/monitor.js');
    expect(REMOTE_MONITOR_ENTRY).toBe('startMonitor');
    expect(REMOTE_MONITOR_READY_TEXT).toBe('Monitor started');
  });
});

// A release is marked in the heartbeat and in its records.
describe('release heartbeats and records', () => {
  const valid = { source: SOURCE, limitSeconds: 210, devspaces: [{ id: ID, keepRunning: false, seq: 1 }] };

  it('accepts `release: true` and keeps it; refuses any other value', () => {
    expect(parseHeartbeatInput(input({ ...valid, release: true }))).toEqual({ ...valid, release: true });
    expect(parseHeartbeatInput(input(valid))).toEqual(valid);
    expect(parseHeartbeatInput(input(valid))).not.toHaveProperty('release');
    for (const release of [false, 'true', 1, null]) expect(parseHeartbeatInput(input({ ...valid, release })), String(release)).toBeUndefined();
    expect(parseHeartbeatInput(input({ ...valid, release: true, extra: 1 }))).toBeUndefined();
  });

  it('parses a release record, and refuses a record with another value of `release`', () => {
    const plain = { at: 1000, keepRunning: false, limitSeconds: 210, seq: 7 };
    expect(parseHeartbeatRecord(input({ ...plain, release: true }))).toEqual({ ...plain, release: true });
    expect(parseHeartbeatRecord(input(plain))).toEqual(plain);
    expect(parseHeartbeatRecord(input({ ...plain, release: false }))).toBeUndefined();
    expect(parseHeartbeatRecord(input({ ...plain, release: 'yes' }))).toBeUndefined();
  });
});

// The last use of the engine by a window, which ends a permanent monitor after 30 days without one.
describe('the last use of the engine', () => {
  const CREATE = '0f0f0f0f-0000-4000-8000-000000000001';

  it('names its file and the time without use', () => {
    expect(LAST_USE_FILE).toBe('last-use.json');
    expect(UNUSED_END_MS).toBe(30 * 24 * 60 * 60_000);
  });

  it('parses the time and the nonce of the create, and refuses anything else', () => {
    expect(parseLastUse(input({ at: 1000, createId: CREATE }))).toEqual({ at: 1000, createId: CREATE });
    expect(parseLastUse(input({ at: 0 }))).toEqual({ at: 0 });
    for (const value of [{}, { at: -1 }, { at: 1.5 }, { at: '1000' }, { at: 1000, createId: 'x' }, { at: 1000, createId: CREATE.toUpperCase() }, { at: 1000, extra: 1 }, [], null]) {
      expect(parseLastUse(input(value)), JSON.stringify(value)).toBeUndefined();
    }
    expect(parseLastUse('not json')).toBeUndefined();
    expect(parseLastUse(input({ at: 1000, createId: CREATE }).padEnd(2000, ' '))).toBeUndefined();
    expect(isMonitorCreateId(CREATE)).toBe(true);
    expect(isMonitorCreateId(undefined)).toBe(false);
  });
});
