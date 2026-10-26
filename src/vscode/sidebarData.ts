// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Parts of the sidebar input (TreeInput) that come from Docker and from the coordination files. No `vscode` import.
import { isBusyMarkLive, type BusyMarkLivenessInput } from '../core/busy';
import type { Devspace, WindowStatus } from '../core/types';
import type { DevspaceRuntime } from './treeModel';

/**
 * Runtime when Docker was just asked and does not run: no container runs. The volumes cannot be checked; they count as
 * present, so no devspace shows "Files missing". `undefined` as runtime means "not asked", which would keep a lost
 * connection shown as Connected.
 */
export function dockerStoppedRuntime(devspaces: readonly Devspace[]): Map<string, DevspaceRuntime> {
  return new Map(devspaces.map((devspace) => [devspace.id, { container: 'stopped', volume: true }]));
}

/** Devspaces with a busy mark that still protects them (`isBusyMarkLive`). */
export function liveBusyDevspaceIds(devspaces: readonly Devspace[], liveness: BusyMarkLivenessInput): Set<string> {
  const ids = new Set<string>();
  for (const devspace of devspaces) {
    if (devspace.busy && isBusyMarkLive(devspace.busy, liveness)) ids.add(devspace.id);
  }
  return ids;
}

/** Devspaces that the given windows are connected to. */
export function devspaceIdsOf(windows: readonly WindowStatus[]): Set<string> {
  const ids = new Set<string>();
  for (const window of windows) {
    if (window.devspaceId !== null) ids.add(window.devspaceId);
  }
  return ids;
}
