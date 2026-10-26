// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Mutation probes: the time limit of the flow of monitorEnsure.
import { describe, expect, it } from 'vitest';
import { MONITOR_ENSURE_FLOW_TIMEOUT_MS } from '../core/pipeline/operationBase';

describe('MONITOR_ENSURE_FLOW_TIMEOUT_MS', () => {
  it('is five minutes', () => {
    expect(MONITOR_ENSURE_FLOW_TIMEOUT_MS).toBe(5 * 60_000);
  });
});
