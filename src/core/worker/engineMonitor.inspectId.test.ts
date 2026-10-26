// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The ID of an inspect is 64 lower-case hex digits, and an inspect answer that is null is a failure, never evidence
// that the container is missing.
import { describe, expect, it } from 'vitest';
import { unusedEngine } from './dockerEngine.testkit';
import { engineMonitor, monitorInspected } from './engineMonitor';

describe('engineMonitor: the ID of an inspect and a null answer', () => {
  it('reads only an ID of 64 lower-case hex digits', () => {
    expect(monitorInspected({ Id: 'a'.repeat(64) })).toMatchObject({ id: 'a'.repeat(64) });
    expect(monitorInspected({ Id: 'A'.repeat(64) })).toMatchObject({ id: undefined });
    expect(monitorInspected({ Id: 'a'.repeat(12) })).toMatchObject({ id: undefined });
  });

  it('an inspect answer of null fails the inspect', async () => {
    const monitor = engineMonitor({ ...unusedEngine(), inspect: async () => null });
    await expect(monitor.inspect('devspaces-monitor')).rejects.toThrow(/^docker container inspect failed: /);
  });
});
