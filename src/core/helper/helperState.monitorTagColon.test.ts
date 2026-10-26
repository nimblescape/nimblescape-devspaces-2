// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.
// A monitor tag has the colon of a repository:tag after its prefix.
import { describe, expect, it } from 'vitest';
import { isMonitorImageTag } from './helperState';

describe('isMonitorImageTag: the colon after the prefix', () => {
  it('needs the colon after devspaces-monitor', () => {
    expect(isMonitorImageTag('devspaces-monitor:0123456789ab')).toBe(true);
    expect(isMonitorImageTag('devspaces-monitor-0123456789ab')).toBe(false);
    expect(isMonitorImageTag('devspaces-monitor/0123456789ab')).toBe(false);
  });
});
