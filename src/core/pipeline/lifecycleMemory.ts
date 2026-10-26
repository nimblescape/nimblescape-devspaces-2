// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The containers whose lifecycle commands did not run and whose mark (Devspace.lifecycleIncomplete) could not be
// recorded. The memory is the window's: the pipeline of the window uses it directly, the pipeline of the worker through
// the requests of its operation (`local unrecordedLifecycle`, `record rememberLifecycle`, `record forgetLifecycle`).
// Pure; no `vscode`.
import { sameContainer } from './containerIds';

/**
 * What the window remembers for a devspace whose open in the worker ended without its answer after it began `up`:
 * which container runs without its lifecycle commands is not known, so every running container of the devspace
 * counts as one (when in doubt, its lifecycle commands run again).
 */
export const LIFECYCLE_UNKNOWN = 'unknown';

/** Whether the remembered `mark` names `containerId`: the container itself, or any one when it is LIFECYCLE_UNKNOWN. */
export function rememberedFor(mark: string, containerId: string): boolean {
  return mark === LIFECYCLE_UNKNOWN || sameContainer(mark, containerId);
}

export interface LifecycleMemory {
  /** The container of the devspace that the window remembers (or LIFECYCLE_UNKNOWN), if any. */
  get(devspaceId: string): Promise<string | undefined>;
  /** Remembers `containerId` (or LIFECYCLE_UNKNOWN) for the devspace (it replaces the one remembered before). */
  remember(devspaceId: string, containerId: string): Promise<void>;
  /** Forgets the container of the devspace when it is `containerId` (rememberedFor). */
  forget(devspaceId: string, containerId: string): Promise<void>;
}

/** The memory of one window, for the lifetime of its extension host. */
export function windowLifecycleMemory(): LifecycleMemory {
  const remembered = new Map<string, string>();
  return {
    get: async (devspaceId) => remembered.get(devspaceId),
    remember: async (devspaceId, containerId) => void remembered.set(devspaceId, containerId),
    forget: async (devspaceId, containerId) => {
      const known = remembered.get(devspaceId);
      if (known !== undefined && rememberedFor(known, containerId)) remembered.delete(devspaceId);
    },
  };
}
