// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Decision logic of the Monitor of a Docker engine: the dead-man switch for a computer that is offline, asleep,
// or switched to another Docker host. Pure functions without I/O and without a clock of their own; main.ts reads the
// containers and the heartbeat records and runs the stops.
//
// One tick:
//   1. The containers with the label nimblescape.devspaces.id, stopped ones included (the list of the engine
//      over the Engine API, remoteContainersOf) and the records of the volume.
//   2. `decision = decide({ now, containers, records, state })`. Keep `decision.state` for the next tick.
//   3. The stop of each container of `decision.stop` (the dev container first), then removal of the files of
//      `decision.forget` (old records of removed devspaces) and `decision.superseded` (old records that a newer one of
//      the same devspace replaced).
/** Interval between two ticks. */
export const REMOTE_TICK_MS = 15_000;
/** A time since the previous tick larger than this means that the host or the container was paused, or the clock changed. */
export const REMOTE_GAP_MS = 60_000;
/**
 * After such a gap (and after the start), nothing is stopped for this time: the computers send heartbeats again first.
 * 5 minutes, as long as the release of a closed window (RELEASE_LIMIT_SECONDS).
 */
export const REMOTE_GRACE_MS = 300_000;
/**
 * A record of a devspace that has no container at all any more is removed after this time; so is an old record that
 * a newer one of the same devspace replaced.
 */
export const RECORD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * A record whose `at` is later than now plus this counts as written when the monitor first saw it: a forged or skewed
 * time in the future must not keep a devspace for ever. It is not dropped: without a record the monitor would not
 * act on the devspace at all. A restart of the monitor sees it anew (the gap rule holds the stops after the start
 * anyway).
 */
export const FUTURE_RECORD_TOLERANCE_MS = 5 * 60_000;
/**
 * A stopNow record (a manual Stop) stops the devspace once it is this old, at the first tick after that: the
 * window's own stop, which records the Git state of the devspace under the devspace lock, usually takes that lock
 * first (a held lock puts the monitor's stop off to the next tick).
 */
export const STOP_NOW_HOLD_MS = REMOTE_TICK_MS;

/** A container with the label nimblescape.devspaces.id, as the engine lists it (main.ts, remoteContainersOf). */
export interface RemoteContainer {
  id: string;
  /** Its state as the list of the engine names it (`State`, the `.State` of `docker ps`), for example `running` or `exited`. */
  state: string;
  name: string;
  devspaceId: string;
  /** The label nimblescape.devspaces.compose-service; empty for the dev container. */
  composeService: string;
}

/** A heartbeat record of the volume, with the parts of its file name. */
export interface RemoteRecord {
  source: string;
  devspaceId: string;
  at: number;
  keepRunning: boolean;
  limitSeconds: number;
  /** Written by the short release of a window (HeartbeatInput.release). */
  release?: boolean;
  /** Written by a manual Stop (HeartbeatEntry.stopNow). */
  stopNow?: boolean;
}

/** State that the monitor keeps from one tick to the next. Only `decide` creates new states. */
export interface RemoteMonitorState {
  /** Time of the previous tick. */
  lastTickAt?: number;
  /** Until this time nothing is stopped (the gap rule). */
  graceUntil?: number;
  /**
   * `<source>.<devspace id>.<at>` of a record whose time is in the future (FUTURE_RECORD_TOLERANCE_MS) → the time the
   * monitor first saw it: the record counts as written then, and ages from then on.
   */
  futureSeen?: Record<string, number>;
}

export function initialRemoteState(): RemoteMonitorState {
  return {};
}

/** The times of the rules; tests of the container give shorter ones (main.ts, DEVSPACE_MONITOR_TICK_MS). */
export interface RemoteTiming {
  gapMs: number;
  graceMs: number;
  /** The hold of a stopNow record (absent: STOP_NOW_HOLD_MS). */
  stopNowHoldMs?: number;
}

export const DEFAULT_REMOTE_TIMING: RemoteTiming = { gapMs: REMOTE_GAP_MS, graceMs: REMOTE_GRACE_MS, stopNowHoldMs: STOP_NOW_HOLD_MS };

export interface RemoteDecideInput {
  /** The clock of the remote host (the records use it too). */
  now: number;
  containers: readonly RemoteContainer[];
  records: readonly RemoteRecord[];
  /** State of the previous tick, `initialRemoteState()` for the first one. It is not changed. */
  state: RemoteMonitorState;
  timing?: RemoteTiming;
}

/** A devspace to stop: its running containers, the dev container first, and the reason for the log. */
export interface RemoteStop {
  devspaceId: string;
  containers: RemoteContainer[];
  reason: string;
}

export interface RemoteDecision {
  state: RemoteMonitorState;
  stop: RemoteStop[];
  /** Env ids with a running container that a record keeps running (Keep Running When Closed, Close and Keep Running). */
  kept: string[];
  /**
   * Records to remove: their devspace has no container at all, and their `at` is more than RECORD_MAX_AGE_MS from
   * now (in either direction). In the order of removal, oldest first by the `at` as the rules see it (clamped), of
   * equal `at` a keepRunning record last; none whose `at`, as the rules see it (clamped), is later than that of a
   * record of its devspace that stays, nor a keepRunning one with the same `at`.
   */
  forget: RemoteRecord[];
  /**
   * Records to remove that are not in `forget`: they do not say keepRunning, their `at` (as the rules see it, a time in
   * the future counts from when it was first seen) is older than RECORD_MAX_AGE_MS, and another record of the same
   * devspace has a strictly later `at`. So the newest record of a devspace, a keepRunning record, and a record
   * with the same `at` as the newest are never removed by it. Nor one while a keepRunning record of another source of
   * the same devspace has an `at` not later than its own.
   */
  superseded: RemoteRecord[];
  /** The gap rule holds every stop in this tick. */
  grace: boolean;
  /**
   * Whether the engine is in use for the idle exit of the monitor (main.ts), besides a running labelled container
   * (which the loop counts itself): a record that is fresh (its `at`, as the rules see it, clamped, at most its
   * `limitSeconds` ago: a window still sends heartbeats, for example during the clone and the build of an open, before
   * any container exists). Only that. A labelled container in the state `created` does not count (a failed start after
   * `up`, or a Compose service whose dependency never becomes healthy, leaves it so for ever; the window of the open
   * sends heartbeats until it started), nor does a keepRunning record of a devspace whose container has not ended
   * (a kept container that runs counts as running). Records age out, so an engine with nothing running still lets the
   * monitor exit.
   */
  active: boolean;
}

/** True for a state of the engine in which the container runs (as mapContainerState of the extension). */
export function isRunningState(state: string): boolean {
  return state === 'running' || state === 'restarting' || state === 'paused';
}

/**
 * The rules, per devspace with at least one running container:
 * - no record at all → never acted on: no computer sent a heartbeat for it (for example a devspace of the host's own
 *   local Docker, or of a build without heartbeats), so the monitor cannot know whether it is in use (the open pipeline
 *   writes the first heartbeat of every remote devspace);
 * - the newest record decides: the record with the latest `at` of all sources (the time the host received it; for equal
 *   times, one that says keepRunning). It says keepRunning → it keeps running; otherwise it stops when more than its
 *   `limitSeconds` has passed since its `at`. So a later choice of any computer overrules an older keep of another one
 *   (for example of a computer that no longer sends), and the keep of a computer that still sends holds until someone
 *   makes a newer choice;
 * - when that newest record is a release (the short limit of a window that left the devspace, `release`), it decides
 *   only while no record of another source (not itself a release) is still within its own `limitSeconds`; otherwise the
 *   newest of those live records of other sources decides (never an expired one), so a release never shortens the
 *   heartbeats of another computer that still uses the devspace;
 * - when that newest record is a stopNow record (a manual Stop) and no other record of the devspace has an `at` as
 *   late as its own, the devspace is stopped once the record is `stopNowHoldMs` old (STOP_NOW_HOLD_MS), whatever
 *   older keepRunning records of any source say, whatever its limit, and also during the grace of the gap rule (an
 *   explicit Stop does not wait for the heartbeats of the computers). A later open, or any newer heartbeat of any
 *   source, writes a newer record, which decides instead; so a stopNow never stops a devspace that is used after
 *   it, also not one opened after a restart of the monitor that still finds an old stopNow record. The record stays
 *   after the stop and acts again only while it is still the newest (a container that something without a heartbeat
 *   starts again, such as `docker start` by hand or the restart policy of a Compose service after a restart of the
 *   engine, is stopped again). A stopNow record that is not the newest, or one that a release falls back to, counts as
 *   a plain record without keepRunning.
 * The gap rule: when the time since the previous tick is larger than `gapMs` (the host or the container was paused, the
 * clock was changed), and at the first tick, nothing is stopped for `graceMs`: the computers that still use their
 * devspaces send heartbeats again first (they retry every tick of their Monitor). Records whose devspace
 * has no container at all (running or not) and whose `at` is more than RECORD_MAX_AGE_MS before or after now are
 * removed (`forget`), but none whose `at`, as the rules see it (clamped), is later than that of a record of its
 * devspace that stays, nor a keepRunning one with the same `at`; so are records without keepRunning older than
 * RECORD_MAX_AGE_MS for which a strictly newer record of the same devspace exists (`superseded`), except while a
 * keepRunning record of another source of the same devspace has an `at` not later than its own. The monitor never
 * acts on containers without the label nimblescape.devspaces.id (the caller lists only those).
 */
export function decide(input: RemoteDecideInput): RemoteDecision {
  const { now } = input;
  const timing = input.timing ?? DEFAULT_REMOTE_TIMING;
  const previous = input.state;
  const gap = previous.lastTickAt === undefined ? Infinity : now - previous.lastTickAt;
  let graceUntil = previous.graceUntil;
  if (!(Math.abs(gap) <= timing.gapMs)) graceUntil = now + timing.graceMs;
  else if (graceUntil !== undefined) graceUntil = Math.min(graceUntil, now + timing.graceMs);
  const grace = graceUntil !== undefined && now < graceUntil;

  const running = new Map<string, RemoteContainer[]>();
  const present = new Set<string>();
  for (const container of input.containers) {
    present.add(container.devspaceId);
    if (!isRunningState(container.state)) continue;
    running.set(container.devspaceId, [...(running.get(container.devspaceId) ?? []), container]);
  }
  const recordsOf = new Map<string, RemoteRecord[]>();
  const futureSeen: Record<string, number> = {};
  const clamped = input.records.map((record) => {
    if (record.at <= now + FUTURE_RECORD_TOLERANCE_MS) return record;
    const key = `${record.source}.${record.devspaceId}.${record.at}`;
    const seen = Math.min(previous.futureSeen?.[key] ?? now, now);
    futureSeen[key] = seen;
    return { ...record, at: seen };
  });
  for (const record of clamped) {
    recordsOf.set(record.devspaceId, [...(recordsOf.get(record.devspaceId) ?? []), record]);
  }

  const stop: RemoteStop[] = [];
  const kept: string[] = [];
  for (const [devspaceId, containers] of running) {
    const records = recordsOf.get(devspaceId) ?? [];
    // Without any record the monitor never acts on it.
    if (records.length === 0) continue;
    const newestOf = (candidates: readonly RemoteRecord[]): RemoteRecord =>
      candidates.reduce((best, record) => (record.at > best.at || (record.at === best.at && record.keepRunning && !best.keepRunning) ? record : best));
    let newest = newestOf(records);
    // A manual Stop that is the newest record of the devspace, with no other record as late as it, stops it once it
    // is stopNowHoldMs old, also during the grace; never while another record is as new or newer (a later open, a newer
    // heartbeat of any source).
    const stopNow = newest;
    if (stopNow.stopNow === true && !records.some((record) => record !== stopNow && record.at >= stopNow.at)) {
      const heldMs = now - stopNow.at;
      if (heldMs < (timing.stopNowHoldMs ?? STOP_NOW_HOLD_MS)) continue;
      stop.push({ devspaceId, containers: devContainerFirst(containers), reason: `a computer asked to stop it (Stop) ${Math.round(heldMs / 1000)} seconds ago` });
      continue;
    }
    // A release decides only while no record of another source is still within its own limit (a release never shortens
    // the heartbeats of another computer that still uses the devspace); otherwise the newest of those live records
    // of other sources decides, never an expired record (which would stop the devspace at once) nor an older record
    // of the releasing source itself.
    if (newest.release === true) {
      const release = newest;
      const othersLive = records.filter((record) => record.source !== release.source && record.release !== true && now - record.at <= record.limitSeconds * 1000);
      if (othersLive.length > 0) newest = newestOf(othersLive);
    }
    if (newest.keepRunning) {
      kept.push(devspaceId);
      continue;
    }
    if (grace || now - newest.at <= newest.limitSeconds * 1000) continue;
    const minutes = Math.round((now - newest.at) / 60_000);
    const reason = `no computer sent a heartbeat for ${minutes} minutes (limit ${newest.limitSeconds / 60} minutes)`;
    stop.push({ devspaceId, containers: devContainerFirst(containers), reason });
  }

  // The absolute age, so a record far in the future (a skewed clock of a computer) whose devspace is gone is removed
  // too. In the order of removal, by the times as the rules see them (of equal `at`, a keep last), and none whose `at`,
  // as the rules see it (clamped), is later than that of a record of its devspace that stays, nor a keepRunning one
  // with the same `at`, so the newest records of a devspace stay until all are gone.
  const old = (record: RemoteRecord) => !present.has(record.devspaceId) && Math.abs(now - record.at) > RECORD_MAX_AGE_MS;
  const forget = clamped
    .filter(
      (record, index) =>
        old(input.records[index]) &&
        !clamped.some(
          (other, j) =>
            other.devspaceId === record.devspaceId &&
            !old(input.records[j]) &&
            (other.at < record.at || (other.at === record.at && record.keepRunning)),
        ),
    )
    .sort((a, b) => a.at - b.at || +a.keepRunning - +b.keepRunning)
    .map((record) => input.records[clamped.indexOf(record)]);
  // An old record that a strictly newer one of the same devspace replaced, with the times as the rules see them.
  // Never one that says keepRunning, never the newest, never on a tie.
  const forgotten = new Set(forget);
  const superseded = input.records.filter((record, index) => {
    if (forgotten.has(record) || record.keepRunning) return false;
    const at = clamped[index].at;
    if (now - at <= RECORD_MAX_AGE_MS) return false;
    const same = recordsOf.get(record.devspaceId) ?? [];
    // Never while a keepRunning record of another computer is not newer than it (this record is the only one of its
    // computer for the devspace). This exception decides no stop; it only keeps such a record from being removed
    // sooner. With the written times (as the records hold them), not the clamped ones.
    if (input.records.some((other) => other.devspaceId === record.devspaceId && other.keepRunning && other.source !== record.source && other.at <= record.at)) return false;
    return same.some((other) => other.at > at);
  });
  // Activity for the idle exit (RemoteDecision.active): only a fresh record. Neither a `created` labelled container (a
  // failed start after `up` leaves one for ever) nor a keep counts: a running container counts in the loop itself (a
  // kept one that runs among them).
  const active = clamped.some((record) => now - record.at <= record.limitSeconds * 1000);
  const state: RemoteMonitorState = { lastTickAt: now };
  if (Object.keys(futureSeen).length > 0) state.futureSeen = futureSeen;
  if (graceUntil !== undefined && now < graceUntil) state.graceUntil = graceUntil;
  return { state, stop, kept, forget, superseded, grace, active };
}

/**
 * The containers of one devspace in the order of the stop: the dev container (no nimblescape.devspaces.compose-service)
 * first.
 */
export function devContainerFirst(containers: readonly RemoteContainer[]): RemoteContainer[] {
  return [...containers].sort((a, b) => (a.composeService === '' ? 0 : 1) - (b.composeService === '' ? 0 : 1));
}
