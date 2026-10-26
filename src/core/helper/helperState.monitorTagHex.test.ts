// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.
// A monitor tag has exactly 12 lowercase hex characters.
import { describe, expect, it } from 'vitest';
import { isMonitorImageTag, monitorImageTag } from './helperState';

describe('isMonitorImageTag: lowercase hex characters', () => {
  it('accepts only lowercase hex characters after the prefix', () => {
    expect(isMonitorImageTag('devspaces-monitor:0123456789ab')).toBe(true);
    expect(isMonitorImageTag('devspaces-monitor:0123456789ag')).toBe(false);
    expect(isMonitorImageTag('devspaces-monitor:zzzzzzzzzzzz')).toBe(false);
    expect(isMonitorImageTag('devspaces-monitor:0123456789AB')).toBe(false);
    expect(monitorImageTag('devspaces-worker:zzzzzzzzzzzz')).toBeUndefined();
  });
});
