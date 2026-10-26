// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Mutation probes: each outcome of monitorEnsure.
import { describe, expect, it } from 'vitest';
import { parseMonitorEnsureValue } from './protocol';

describe('parseMonitorEnsureValue probes', () => {
  it('takes each outcome', () => {
    for (const outcome of ['running', 'started', 'created']) expect(parseMonitorEnsureValue({ outcome })).toEqual({ outcome });
  });
});
