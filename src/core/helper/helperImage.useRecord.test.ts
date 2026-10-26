// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The record of the use of a helper tag (recordHelperImageUse):
// - it clears the mark of a foreign tag at once, also within the hour of its lastUsedAt (`&& !isForeign(record)`);
// - HELPER_LAST_USED_INTERVAL_MS is an hour (the other tests use the constant).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HELPER_LAST_USED_INTERVAL_MS, helperImageTag, recordHelperImageUse } from './helperImage';
import type { HelperState } from './helperState';

const TAG = helperImageTag('FROM node:22-bookworm-slim\n');

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-11ier1-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the record of the use of a helper tag', () => {
  it('writes lastUsedAt at most once per hour', () => {
    expect(HELPER_LAST_USED_INTERVAL_MS).toBe(60 * 60 * 1000);
  });

  it('clears the mark of a foreign tag at once, also within the hour of its lastUsedAt', async () => {
    const statePath = path.join(dir, 'helper.json');
    const marked: HelperState = { version: 1, images: { [TAG]: { foreignSince: '2026-10-08T12:00:00.000Z', lastUsedAt: '2026-10-08T12:00:00.000Z' } } };
    fs.writeFileSync(statePath, JSON.stringify(marked));
    await recordHelperImageUse(statePath, TAG, { clock: { now: () => Date.parse('2026-10-08T12:10:00.000Z') } });
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as HelperState;
    expect(state.images[TAG]).toEqual({ lastUsedAt: '2026-10-08T12:10:00.000Z' });
  });
});
