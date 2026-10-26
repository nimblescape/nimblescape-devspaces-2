// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The rules of the Monitor's background run that the extension, the worker and the monitor share: the setting
// devspaces.cacheUpdateSchedule (a cron schedule of five fields or an interval in minutes), when a run is due, and
// whether the monitor of an engine runs permanently (its restart policy). The default is daily at 06:07 in the
// computer's time zone. Pure functions; no I/O, no `vscode`.
import { nextCronTime, parseCronSchedule, shortestCronGapMinutes, type CronSchedule } from './cron';

/**
 * The default of devspaces.cacheUpdateSchedule: daily at 06:07 in the time zone of the computer (DEVSPACE_IMAGE_TZ of
 * the monitor); a time that the monitor missed (the engine off, a computer asleep) runs once when it runs again
 * (cacheRunDue).
 */
export const DEFAULT_CACHE_UPDATE_SCHEDULE = '7 6 * * *';
/**
 * The shortest interval in minutes (a whole number, at least 5), and the shortest time between two times of a cron
 * schedule.
 */
export const MIN_CACHE_INTERVAL_MINUTES = 5;
/**
 * The longest interval in minutes: a day (1440), as the pattern of the setting in package.json, so that every number
 * that the settings editor takes is one that the monitor takes (a number that the monitor refuses would become the
 * default silently).
 */
export const MAX_CACHE_INTERVAL_MINUTES = 1440;

/** The schedule of the background run: an interval in minutes, or a cron schedule. */
export type CacheSchedule = { kind: 'interval'; minutes: number; text: string } | { kind: 'cron'; cron: CronSchedule; text: string };

/**
 * The setting devspaces.cacheUpdateSchedule: a whole number of minutes from MIN_CACHE_INTERVAL_MINUTES to
 * MAX_CACHE_INTERVAL_MINUTES (a JSON number or its digits, leading zeros and spaces around it allowed, as the pattern
 * of package.json) is an interval, five fields that parseCronSchedule takes are a cron schedule (its text with single
 * spaces); `undefined` for anything else (fewer minutes, a fraction, other text, another type). Also a cron schedule
 * that has no time (`0 0 30 2 *`, no 30 February): it would never run once a run is known, so it means the default.
 * And a cron schedule with two times less than MIN_CACHE_INTERVAL_MINUTES apart (`* * * * *`, shortestCronGapMinutes):
 * the shortest interval holds for both forms.
 */
export function parseCacheSchedule(value: unknown): CacheSchedule | undefined {
  const text = typeof value === 'number' ? (Number.isInteger(value) ? String(value) : '') : typeof value === 'string' ? value.trim() : '';
  const digits = /^0*(\d{1,4})$/.exec(text);
  if (digits !== null) {
    const minutes = Number(digits[1]);
    if (minutes < MIN_CACHE_INTERVAL_MINUTES || minutes > MAX_CACHE_INTERVAL_MINUTES) return undefined;
    return { kind: 'interval', minutes, text: String(minutes) };
  }
  if (/^\d+$/.test(text)) return undefined;
  const cron = parseCronSchedule(text);
  if (cron === undefined || nextCronTime(CRON_CHECK_FROM, cron, 'UTC') === undefined) return undefined;
  if (shortestCronGapMinutes(cron) < MIN_CACHE_INTERVAL_MINUTES) return undefined;
  return { kind: 'cron', cron, text: text.split(/\s+/).join(' ') };
}

/**
 * The time from which parseCacheSchedule looks for a time of a cron schedule (nextCronTime looks five years ahead, so
 * 29 February is found): fixed, so that the parse stays pure.
 */
const CRON_CHECK_FROM = Date.UTC(2027, 0, 1);

/** The setting as the monitor gets it: the text of parseCacheSchedule, or the default. */
export function normalizeCacheSchedule(value: unknown): string {
  return parseCacheSchedule(value)?.text ?? DEFAULT_CACHE_UPDATE_SCHEDULE;
}

/**
 * Whether the Monitor of an engine runs permanently: on every engine, local or remote, once the user answered the
 * question about it on that engine (`answered`, src/vscode/monitorQuestion.ts), unless the setting
 * devspaces.stopMonitorWhenIdle is true (its default is false; true: the monitor ends after 5 minutes without a running
 * devspace). Before the answer, it ends when idle too.
 */
export function monitorRunsPermanently(stopMonitorWhenIdle: boolean | undefined, answered: boolean): boolean {
  return answered && stopMonitorWhenIdle !== true;
}

/**
 * The restart policy of a monitor that ends when idle: Docker restarts it after a failure only,
 * so an exit with 0 when idle leaves it exited.
 */
export const IDLE_MONITOR_RESTART_POLICY = 'on-failure';
/**
 * The restart policy of a permanent monitor: Docker starts it again after a crash and after a restart of the engine.
 */
export const PERMANENT_MONITOR_RESTART_POLICY = 'unless-stopped';

/** The restart policy of a monitor by its mode (monitorRunsPermanently). */
export function monitorRestartPolicy(permanent: boolean): typeof IDLE_MONITOR_RESTART_POLICY | typeof PERMANENT_MONITOR_RESTART_POLICY {
  return permanent ? PERMANENT_MONITOR_RESTART_POLICY : IDLE_MONITOR_RESTART_POLICY;
}

/**
 * Whether the background run is due at `now`, after the last run that ended at `lastEndAt` (undefined: no run is known,
 * so it is due). With an interval: when `now` is at least the interval after that end (so the runs follow each other at
 * that distance from the end of the previous one, and a monitor that starts runs at once when its last run is older
 * than the interval). With a cron schedule: when a time of the schedule (in `timeZone`) came after that end and not
 * after `now` (a monitor that starts runs once when a time passed since its last run; the times during a run are left
 * out). So a time that the schedule missed (the engine off, a computer asleep at 06:07, a monitor that was down) runs
 * once at the next check, however many times it missed; after that run the next time comes after its end, so no second
 * run follows.
 */
export function cacheRunDue(schedule: CacheSchedule, lastEndAt: number | undefined, now: number, timeZone: string): boolean {
  if (lastEndAt === undefined) return true;
  if (schedule.kind === 'interval') return now - lastEndAt >= schedule.minutes * 60_000;
  const next = nextCronTime(lastEndAt, schedule.cron, timeZone);
  return next !== undefined && next <= now;
}
