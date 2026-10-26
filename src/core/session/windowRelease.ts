// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The release of a devspace that a window leaves, when it closes or switches to another devspace. The window
//   1. records the Git state of the devspace itself (in the running dev container as its user, the refresh that
//      Delete uses), bounded, and goes on when that fails;
//   2. sends the short release to the Monitor container of the engine: one heartbeat with the limit
//      RELEASE_LIMIT_SECONDS (5 minutes), marked as a release (`release: true`), so the monitor
//      stops the devspace after that time unless a window uses it again (a reload sends its long heartbeat at once
//      when it starts, SessionCoordinator.start).
// Nothing is sent for a devspace that is kept (Keep Running When Closed, Close and Keep Running, stopOnClose off, a
// respected "shutdownAction": "none": keptWhenClosed) or that another window of this computer uses: its status file or
// its pending connection file (otherWindowUsesDevspace), or its live busy mark on the devspace (those windows
// share this computer's record, which the release would shorten); their long heartbeats stay. The monitor never lets a
// release shorten the live record of another computer (rules.ts, decide). A release that is lost (the window was
// killed, the bound passed, the engine did not answer) leaves the long limit of the last heartbeat (stopAfterMinutes):
// the safe side. Never throws; everything runs within `totalMs`.
//
// When the window leaves the devspace because it handed off a manual Stop of it (its pending operation `stop`), the
// stopNow heartbeat goes instead of the release, first and whatever keeps the devspace or another window of this
// computer shows it (Stop stops a kept devspace too); then the Git state. So the Stop reaches the Monitor
// once the connection really closes (a Cancel in the dialog about unsaved files keeps the window, and nothing is sent),
// and the monitor stops the devspace even when VS Code quits before the reloaded window's own stop reaches Docker.
// When it cannot be sent (an older monitor refuses it, no answer in time), the release follows. No `vscode`.
import { isBusyMarkLive, otherWindowUsesDevspace, type OtherWindowInput } from '../busy';
import { errorMessage } from '../errors';
import type { Logger } from '../ports';
import type { Devspace, ExtensionSettings, PendingOperation } from '../types';
import { keepFlagsOf, keptWhenClosed } from './sessionRules';
import { HEARTBEAT_ATTEMPT_DEADLINE_MS, WINDOW_HEARTBEAT_INTERVAL_MS } from './windowHeartbeats';

/** The bounds of one release: all of it, and the Git record within it (ms). */
export interface ReleaseBounds {
  totalMs: number;
  gitMs: number;
}

/** In deactivate(): VS Code gives a closing window little time, so all of it within about 2 s. */
export const CLOSE_RELEASE_BOUNDS: ReleaseBounds = { totalMs: 2_000, gitMs: 1_000 };
/** A switch (the window leaves its devspace and stays): more time; deactivate() waits for it within its own bound. */
export const SWITCH_RELEASE_BOUNDS: ReleaseBounds = { totalMs: 10_000, gitMs: 5_000 };

export type ReleaseOutcome = 'released' | 'stopSent' | 'kept' | 'inUse' | 'unknown' | 'failed';

/**
 * The least time a release must last beyond MIN_LIMIT_SECONDS. A window that comes back (a reload of the same window, a
 * switch back) sends its first long heartbeat at once when it starts, but that heartbeat may take one attempt
 * (HEARTBEAT_ATTEMPT_DEADLINE_MS: the lookup of the engine, the check of the container, the worker, the repair), and
 * after a failure the next one follows within WINDOW_HEARTBEAT_INTERVAL_MS. So the release lasts at least that much
 * longer, and the monitor does not stop the devspace while the window attaches again.
 */
export const RELEASE_MARGIN_SECONDS = (WINDOW_HEARTBEAT_INTERVAL_MS + HEARTBEAT_ATTEMPT_DEADLINE_MS) / 1000;

/**
 * The limit of the release in seconds: the container stops this long after its last window closed or left it, unless a
 * window uses it again. A fixed 5 minutes. At least MIN_LIMIT_SECONDS + RELEASE_MARGIN_SECONDS, so a reloaded window
 * reports back in time; a test pins it.
 */
export const RELEASE_LIMIT_SECONDS = 300;

/**
 * Whether a window of this computer other than `ownWindowId` uses `devspace`, so this window must not release it
 * (all windows of a computer share one heartbeat record per devspace, and a release would shorten it): its status
 * file or its fresh pending connection file names the devspace (otherWindowUsesDevspace), or it holds a live busy
 * mark on it (isBusyMarkLive, with the status files: an open or a rebuild that runs there). Pure.
 */
export function otherWindowHoldsDevspace(devspace: Devspace, ownWindowId: string, input: OtherWindowInput): boolean {
  if (otherWindowUsesDevspace(devspace.id, ownWindowId, input) !== undefined) return true;
  const mark = devspace.busy;
  if (mark === undefined || mark.windowId === ownWindowId) return false;
  return isBusyMarkLive(mark, { now: input.now, isAlive: input.isAlive, windowStatuses: input.windowStatuses ?? [] });
}

/**
 * Whether `operation` (the pending operation file of a devspace) is a Stop that the window `windowId` handed off:
 * then its release is the stopNow heartbeat. Pure.
 */
export function isHandedOffStop(operation: PendingOperation | undefined, windowId: string): boolean {
  return operation?.operation === 'stop' && operation.requestedBy === windowId;
}

export interface WindowReleaseDeps {
  registry: { list(): Promise<Devspace[]> };
  settings: () => Pick<ExtensionSettings, 'stopOnClose' | 'respectShutdownActionNone'>;
  /**
   * Another window of this computer uses the devspace (SessionCoordinator.otherWindowUses:
   * otherWindowHoldsDevspace with its status files and pending connection files). True also when that is not known
   * (a file could not be read): then nothing is released.
   */
  otherWindowUses: (devspace: Devspace) => Promise<boolean>;
  /**
   * Records the Git state of the devspace in its running dev container as its user
   * (DevspaceService.recordGitState on the engine of the window). `signal` aborts at the bound.
   */
  recordGitState: (devspace: Devspace, signal: AbortSignal) => Promise<unknown>;
  /**
   * Records that this window was seen using the devspace at `at` (an ISO time taken at the start of the release,
   * before the Git step: DevspaceRegistry.markSeenInUse), for Delete's note. It runs alongside the rest of the
   * release and is awaited before it ends (within its bound); a failure is logged.
   */
  markSeenInUse?: (devspace: Devspace, at: string) => Promise<unknown>;
  /** The short release (WindowHeartbeats.release). `signal` aborts at the bound. */
  send: (devspaceId: string, limitSeconds: number, signal: AbortSignal) => Promise<{ ok: true } | { ok: false; detail: string }>;
  /**
   * `handedOff`, whether this window handed off a manual Stop of the devspace (its pending operation `stop`);
   * `send`, the stopNow heartbeat (WindowHeartbeats.sendStop). Without it: the plain release.
   */
  stop?: {
    handedOff: (devspace: Devspace) => Promise<boolean>;
    send: (devspaceId: string, signal: AbortSignal) => Promise<{ ok: true } | { ok: false; detail: string }>;
  };
  logger: Logger;
}

/**
 * `run` within `ms`; then its signal aborts and the result is `undefined` (the work is not awaited further). An abort of
 * `parent` aborts it too.
 */
async function within<T>(ms: number, run: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T | undefined> {
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort(parent?.reason);
  if (parent?.aborted) onParentAbort();
  else parent?.addEventListener('abort', onParentAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error('The time for the release passed.'));
      resolve(undefined);
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', onParentAbort);
  }
}

/** The Git state of `devspace` within `ms`; a failure is logged, never thrown. */
async function recordGitStateWithin(deps: WindowReleaseDeps, devspace: Devspace, ms: number, signal: AbortSignal): Promise<void> {
  try {
    await within(ms, (gitSignal) => deps.recordGitState(devspace, gitSignal), signal);
  } catch (error) {
    deps.logger.info(`The Git state of ${devspace.repository} could not be recorded before its release: ${errorMessage(error)}`);
  }
}

/** Whether this window handed off a Stop of `devspace`; false (logged) when not known. */
async function handedOffStop(stop: NonNullable<WindowReleaseDeps['stop']>, devspace: Devspace, logger: Logger): Promise<boolean> {
  try {
    return await stop.handedOff(devspace);
  } catch (error) {
    logger.info(`Whether this window handed off a Stop of ${devspace.repository} is not known; it is released as before. ${errorMessage(error)}`);
    return false;
  }
}

/** The time left of the bound when the release stops waiting for markSeenInUse. */
const SEEN_MARGIN_MS = 100;

/** The release of `devspaceId` (see the module comment). Never throws; resolves within `bounds.totalMs`. */
export async function releaseDevspace(deps: WindowReleaseDeps, devspaceId: string, bounds: ReleaseBounds): Promise<ReleaseOutcome> {
  const started = Date.now();
  const outcome = await within(bounds.totalMs, async (signal): Promise<ReleaseOutcome> => {
    let seen: Promise<void> | undefined;
    try {
      const devspace = (await deps.registry.list()).find((candidate) => candidate.id === devspaceId);
      if (devspace === undefined) return 'unknown';
      // The time this window was last seen using the devspace, before the Git step (so a state recorded by this
      // release is not older than it), for every release (also a kept one).
      const seenAt = new Date().toISOString();
      const markSeenInUse = deps.markSeenInUse;
      seen =
        markSeenInUse === undefined
          ? undefined
          : Promise.resolve()
              .then(() => markSeenInUse(devspace, seenAt))
              .then(
                () => undefined,
                (error: unknown) => deps.logger.info(`The last use of ${devspace.repository} could not be recorded: ${errorMessage(error)}`),
              );
      // A handed-off Stop goes to the Monitor instead of the release, first; the Git state follows. A failed
      // one is followed by the release.
      const stop = deps.stop;
      if (stop !== undefined && (await handedOffStop(stop, devspace, deps.logger))) {
        const sent = await stop.send(devspaceId, signal);
        if (sent.ok) {
          deps.logger.info(`The Stop of ${devspace.repository} was sent to the Monitor: it stops the devspace also if VS Code quits first.`);
          await recordGitStateWithin(deps, devspace, Math.max(0, Math.min(bounds.gitMs, bounds.totalMs - (Date.now() - started))), signal);
          return 'stopSent';
        }
        deps.logger.info(`The Stop of ${devspace.repository} could not be sent to the Monitor (the window that takes over stops it): ${sent.detail}`);
        if (signal.aborted) return 'failed';
      }
      const settings = deps.settings();
      if (keptWhenClosed(keepFlagsOf(devspace), settings)) return 'kept';
      if (await deps.otherWindowUses(devspace)) return 'inUse';
      if (signal.aborted) return 'failed';
      // The Git state first, bounded; a failure is logged and the release goes on.
      await recordGitStateWithin(deps, devspace, Math.max(0, Math.min(bounds.gitMs, bounds.totalMs - (Date.now() - started))), signal);
      if (signal.aborted) return 'failed';
      const limitSeconds = RELEASE_LIMIT_SECONDS;
      const result = await deps.send(devspaceId, limitSeconds, signal);
      if (!result.ok) {
        deps.logger.info(`The release of ${devspace.repository} could not be sent (the long limit applies): ${result.detail}`);
        return 'failed';
      }
      deps.logger.info(`Released ${devspace.repository}: the Monitor stops it after ${limitSeconds} seconds unless a window uses it again.`);
      return 'released';
    } catch (error) {
      deps.logger.info(`The release of the devspace could not be sent (the long limit applies): ${errorMessage(error)}`);
      return 'failed';
    } finally {
      // Never rejects; waited for until shortly before the bound of the release, so a slow registry never turns the
      // outcome into 'failed'.
      const pending = seen;
      if (pending !== undefined) await within(Math.max(0, bounds.totalMs - (Date.now() - started) - SEEN_MARGIN_MS), () => pending);
    }
  });
  return outcome ?? 'failed';
}
