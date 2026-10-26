// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The pure rules of the Monitor's background run (background.ts does the I/O): its stored state in the volume
// (the end of the last run, the last cleanup, the retry of a run that did not reach the network), when the cleanup of the shared VS Code server store is due (at most once
// a day), which qualities of the server it keeps new, and which server versions the cleanup removes. Pure; no I/O.
import type { VscodeQuality } from '../core/helperChannel/protocol';

/** The cleanup of the store runs at most once a day. */
export const STORE_CLEANUP_INTERVAL_MS = 24 * 60 * 60_000;
/** A server version that was not used for this long may be removed. */
export const SERVER_UNUSED_MS = 14 * 24 * 60 * 60_000;
/** The newest server versions of a quality and platform that always stay. */
export const KEPT_SERVER_VERSIONS = 2;

/** The state of the background run in the volume of the monitor (CACHE_RUN_FILE). */
export interface CacheRunState {
  /** When the last run ended (ms since the epoch, the clock of the engine's host). */
  lastEndAt?: number;
  /** When the last cleanup of the store ran. */
  lastCleanupAt?: number;
  /**
   * The server versions (serverVersionName) whose last fetch by the run failed, with the time of that failure; the run
   * tries such a version again only after FETCH_RETRY_MS (fetchRetryDue).
   */
  failedFetches?: Record<string, number>;
  /**
   * When the run is tried again: the last run did not reach the network (a failure of isNetworkError), so it did not
   * count as a run (`lastEndAt` stays). Undefined: no retry waits.
   */
  retryAt?: number;
  /** How many runs in a row did not reach the network (runRetryDelay); with `retryAt`. */
  retries?: number;
  /**
   * When the last run that did not reach the network ended (with `retryAt`): the schedule counts from it while a retry
   * waits, so a schedule shorter than the wait still runs at its times.
   */
  lastAttemptAt?: number;
}

/**
 * What a part of the background run found of the network: a server answered (`reached`), none answered and one
 * failed for the network (`offline`), or it asked none (`none`).
 */
export type NetworkContact = 'reached' | 'offline' | 'none';

/**
 * What the parts of a background run tell it of the network (BackgroundRun): `reached` when a server answered;
 * `failed` with a failure, true when it is one of the network (isNetworkError) while the run has reached none yet. Only
 * such a failure skips the wait of a day of a server version or an extension, and only a run that reached no server and
 * had such a failure did not reach the network (it is tried again, runRetryDelay); a run that reached one counts, so a
 * single registry or server that is down never makes it run again and again.
 */
export interface RunNetwork {
  reached(): void;
  failed(error: unknown): boolean;
}

/**
 * The waits before the retries of a run that did not reach the network, the first after the first such run; the last
 * one repeats until a run reaches it. So a computer that wakes up before its network is back (Wi-Fi, a VPN) gets its run
 * minutes later, and one that stays offline costs one run an hour.
 */
export const RUN_RETRY_DELAYS_MS: readonly number[] = [2, 5, 10, 20, 30, 60].map((minutes) => minutes * 60_000);

/** The wait before the retry after `retries` runs in a row that did not reach the network (1 or more). */
export function runRetryDelay(retries: number): number {
  return RUN_RETRY_DELAYS_MS[Math.min(Math.max(retries, 1), RUN_RETRY_DELAYS_MS.length) - 1];
}

/**
 * Whether the retry at `retryAt` is due at `now`: at or after that time, or when it lies more than the longest wait plus
 * CLOCK_RESET_MS ahead of `now` (a clock that was corrected).
 */
export function runRetryDue(retryAt: number, now: number): boolean {
  return now >= retryAt || retryAt - now > RUN_RETRY_DELAYS_MS[RUN_RETRY_DELAYS_MS.length - 1] + CLOCK_RESET_MS;
}

/** A version whose fetch by the run failed is tried again after this long (a day). */
export const FETCH_RETRY_MS = 24 * 60 * 60_000;
/** The most failed fetches that the state keeps (the newest of each quality and platform). */
export const MAX_FAILED_FETCHES = 16;
/** A server version as serverVersionName writes it. */
const SERVER_VERSION = /^(stable|insider)-(linux-x64|linux-arm64)-[0-9a-f]{40}$/;

/** The stored state; an empty one for anything invalid (a field that is no time is left out). */
export function parseCacheRunState(text: string): CacheRunState {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const time = (field: unknown) => (typeof field === 'number' && Number.isSafeInteger(field) && field >= 0 ? field : undefined);
  const { lastEndAt, lastCleanupAt, failedFetches, retryAt, retries, lastAttemptAt } = value as {
    lastEndAt?: unknown;
    lastCleanupAt?: unknown;
    failedFetches?: unknown;
    retryAt?: unknown;
    retries?: unknown;
    lastAttemptAt?: unknown;
  };
  const state: CacheRunState = {};
  if (time(lastEndAt) !== undefined) state.lastEndAt = time(lastEndAt);
  if (time(lastCleanupAt) !== undefined) state.lastCleanupAt = time(lastCleanupAt);
  // A retry only with its count (at least 1).
  if (time(retryAt) !== undefined && typeof retries === 'number' && Number.isSafeInteger(retries) && retries >= 1) {
    state.retryAt = time(retryAt);
    state.retries = retries;
    if (time(lastAttemptAt) !== undefined) state.lastAttemptAt = time(lastAttemptAt);
  }
  // Only names of server versions with a time, at most MAX_FAILED_FETCHES; else none.
  if (typeof failedFetches === 'object' && failedFetches !== null && !Array.isArray(failedFetches)) {
    const entries = Object.entries(failedFetches as Record<string, unknown>);
    if (entries.length <= MAX_FAILED_FETCHES && entries.every(([version, at]) => SERVER_VERSION.test(version) && time(at) !== undefined)) {
      state.failedFetches = Object.fromEntries(entries) as Record<string, number>;
    }
  }
  return state;
}

/**
 * Whether the run may fetch a version whose last fetch by the run failed at `failedAt` (undefined: none failed): at
 * least FETCH_RETRY_MS later, or when that time lies more than CLOCK_RESET_MS ahead of `now` (a clock that was
 * corrected). An open's own fetch never waits for it.
 */
export function fetchRetryDue(failedAt: number | undefined, now: number): boolean {
  return failedAt === undefined || now - failedAt >= FETCH_RETRY_MS || failedAt - now > CLOCK_RESET_MS;
}

/**
 * A stored time more than this ahead of the clock is no time of the past: a clock that was far ahead and then corrected
 * (as for the image schedule). The schedule then goes on from now.
 */
export const CLOCK_RESET_MS = 60 * 60_000;

/**
 * Whether the cleanup of the store is due: never ran, ran at least STORE_CLEANUP_INTERVAL_MS ago, or its stored time
 * lies more than CLOCK_RESET_MS ahead of `now` (a clock that was corrected).
 */
export function cleanupDue(lastCleanupAt: number | undefined, now: number): boolean {
  return lastCleanupAt === undefined || now - lastCleanupAt >= STORE_CLEANUP_INTERVAL_MS || lastCleanupAt - now > CLOCK_RESET_MS;
}

/**
 * The qualities whose newest server the run fetches: `stable` always, `insider` only while an open used an insider
 * version (for the engine's platform) within SERVER_UNUSED_MS of `now` (`opened`: the times of the markers of
 * markServerOpened; a time in the future counts as now). The monitor's own fetches and links never count, so one
 * Insiders open does not make it fetch every Insiders build for ever.
 */
export function qualitiesToFetch(opened: readonly { quality: VscodeQuality; at: number }[], now: number): VscodeQuality[] {
  return opened.some((use) => use.quality === 'insider' && now - use.at < SERVER_UNUSED_MS) ? ['stable', 'insider'] : ['stable'];
}

/** A server version of the store as the cleanup sees it: its commit and its last use by an open. */
export interface StoredServer {
  commit: string;
  /**
   * The time of its marker (markServerOpened); undefined: no open used it. The cleanup gives the time of the folder of
   * a version without a marker (cleanupUsedAt of background.ts).
   */
  usedAt: number | undefined;
}

/**
 * The commits of one quality and platform that the cleanup removes. The versions are ordered newest first by `released`
 * (the commits of the update service, newest first; a version that it does not name counts as older than all that it
 * names, and among those the one used last comes first); the KEPT_SERVER_VERSIONS newest stay, and so does every
 * version used by an open within SERVER_UNUSED_MS of `now` (a time in the future counts as used now). A version that no
 * open used counts as unused; one that a running container runs (`inUse`, its commit) always stays. Every other version
 * is removed.
 */
export function serversToRemove(stored: readonly StoredServer[], released: readonly string[], now: number, inUse: ReadonlySet<string> = new Set()): string[] {
  const rank = new Map(released.map((commit, index) => [commit, index]));
  const used = (server: StoredServer) => server.usedAt ?? Number.NEGATIVE_INFINITY;
  const ordered = [...stored].sort((a, b) => {
    const byRelease = (rank.get(a.commit) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.commit) ?? Number.MAX_SAFE_INTEGER);
    return byRelease !== 0 ? byRelease : used(b) - used(a) || 0;
  });
  return ordered
    .slice(KEPT_SERVER_VERSIONS)
    .filter((server) => serverUnused(server.usedAt, now) && !inUse.has(server.commit))
    .map((server) => server.commit);
}

/** A version that an open last used at `usedAt` counts as unused at `now` (serversToRemove). */
export function serverUnused(usedAt: number | undefined, now: number): boolean {
  return usedAt === undefined || now - usedAt >= SERVER_UNUSED_MS;
}

/**
 * The server commits that the processes of a running container name (each line of `GET /containers/<id>/top`): every
 * 40-hex string that stands alone in a field (not part of a longer hex string), as in
 * `~/.vscode-server/bin/<commit>/node …`, `~/.vscode-server-insiders/bin/<commit>-insider/node …`,
 * `…/server/<quality>/<platform>/<commit>/…` of the store, or `~/.vscode-server/cli/servers/Stable-<commit>/…`.
 * Deliberately wide: a commit kept by mistake only stays a day longer.
 */
export function commitsInProcesses(processes: readonly (readonly string[])[]): Set<string> {
  const found = new Set<string>();
  for (const row of processes) {
    for (const field of row) {
      for (const match of field.matchAll(/(?<![0-9a-fA-F])[0-9a-f]{40}(?![0-9a-fA-F])/g)) found.add(match[0]);
    }
  }
  return found;
}
