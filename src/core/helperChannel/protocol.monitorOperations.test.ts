// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Mutation probes: the strict checks of the monitor operations.
import { describe, expect, it } from 'vitest';
import { parseHeartbeatValue, parseOpenParams, parseRecordGitStateValue } from './protocol';

describe('the checks of the monitor operations', () => {
  it('a failed heartbeat: ok false, the exact keys, a string detail', () => {
    for (const odd of [
      { ok: true, missing: false, detail: 'x' },
      { ok: 'no', missing: false, detail: 'x' },
      { ok: false, missing: false, detail: 'x', extra: 1 },
      { ok: false, missing: false, detail: 5 },
      { ok: false, missing: false, detail: ['x'] },
    ]) {
      expect(parseHeartbeatValue(odd), JSON.stringify(odd)).toBeUndefined();
    }
  });

  // The settings carry no prefixes; prefixes in the open are refused.
  it('the image settings are passed on as the monitor reads them', () => {
    const settings = { schedule: '7 6 * * *', timeZone: 'UTC' };
    // The settings come with the open.
    const open = {
      dockerHost: '',
      owner: { windowId: 'window-1', pid: 7 },
      monitorSource: '0123456789abcdef0123456789abcdef',
      settings: { updateImagesOnConnect: true, hostAccessChecks: 'on', stopOnClose: true, respectShutdownActionNone: false },
      images: settings,
      repository: 'acme/app',
      devspaceId: '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d',
    };
    expect(parseOpenParams(open)?.images).toEqual(settings);
    expect(parseOpenParams({ ...open, images: { ...settings, prefixes: ['ghcr.io/acme/base'] } })).toBeUndefined();
  });

  it('recordGitState: an answer with more keys does not fit', () => {
    expect(parseRecordGitStateValue({ recorded: true, extra: 1 })).toBeUndefined();
  });
});
