// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The registry answers of the Monitor. Each background pass of the monitor asks the registry, anonymously, for
// the digest of each image tag in use and stores the answers in its volume (REGISTRY_ANSWERS_FILE, with the schedule
// that it runs with). The open (DevspaceService.checkImages) takes the digest of a reference from there while that
// answer is fresh: younger than the time between two runs of the monitor's schedule plus REGISTRY_ANSWER_SLACK_MS,
// whatever that time is (no cap: the open must agree with what the monitor prepared, also overnight); every other
// reference (a private image that the anonymous monitor cannot read, a Feature, a reference without an answer, an old
// answer of a monitor that is down) the open checks itself. The answers are freshness data, not a security input: the
// engine is untrusted, but the host access policy on the configuration and the image metadata check before `up` do not
// use them. The file is still read strictly (its size, its shape, each entry); a malformed entry is no answer. Pure
// functions; no I/O, no `vscode`.
import { parseCacheSchedule } from './cacheSettings';
import { isTimeZone, nextCronTime } from './cron';
import { parseImageReference, type ImageReferenceParts } from './protocol';

/** The file of the registry answers in the volume of the Monitor (LOCK_STATE_DIR in the worker). */
export const REGISTRY_ANSWERS_FILE = 'registry-digests.json';
/**
 * An answer is fresh for the time between two runs of the monitor's schedule plus this slack (a run that starts a
 * little late, a pass that takes a few minutes); no cap.
 */
export const REGISTRY_ANSWER_SLACK_MS = 5 * 60_000;
/**
 * The fresh time of an answer when the schedule of the monitor is not known (a file without it, or one that is not
 * valid): 17 minutes plus the slack, short on purpose: the open then checks the registry itself sooner.
 */
export const REGISTRY_ANSWER_UNKNOWN_SCHEDULE_MS = 17 * 60_000 + REGISTRY_ANSWER_SLACK_MS;
/** An answer whose time is later than this after the clock of the reader is no answer (another clock). */
export const REGISTRY_ANSWER_CLOCK_SKEW_MS = 60_000;
/** The most answers of the file (more are left out by the monitor, and refuse the file when read). */
export const MAX_REGISTRY_ANSWERS = 1000;
/** The largest file of the answers, in characters (a larger file is no answer at all). */
export const MAX_REGISTRY_ANSWERS_CHARACTERS = 512 * 1024;
/** The longest reference of an answer (the Docker reference grammar allows 255 for the name, plus the tag). */
const MAX_REFERENCE_LENGTH = 512;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

/** One answer of the registry to the monitor: the digest of the tag, at the time (ms, the clock of the engine's host). */
export interface RegistryAnswer {
  digest: string;
  at: number;
}

/** The file of the answers. `schedule` and `timeZone`: what the monitor ran with when it wrote it (CurrentCacheSettings). */
export interface RegistryAnswers {
  schedule?: string;
  timeZone?: string;
  /** By the reference key (registryReferenceKey). */
  digests: Record<string, RegistryAnswer>;
}

/**
 * The reference of an image reference in use that the engine pulls and inspects (`latest` without a tag): `node:20` and
 * `docker.io/library/node:20` are one. The monitor and the open share it, so that the open looks its references up
 * under the key that the monitor writes.
 */
export function referenceText(parts: ImageReferenceParts): string {
  return parts.digest !== undefined ? `${parts.repository}@${parts.digest}` : `${parts.repository}:${parts.tag ?? 'latest'}`;
}

/** The key of an image reference as a configuration writes it; undefined for one the grammar refuses. */
export function registryReferenceKey(reference: string): string | undefined {
  const parts = parseImageReference(reference);
  return parts === undefined || parts.digest !== undefined ? undefined : referenceText(parts);
}

function isAnswer(value: unknown): value is RegistryAnswer {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const { digest, at } = value as Record<string, unknown>;
  return Object.keys(value).length === 2 && typeof digest === 'string' && SHA256.test(digest) && typeof at === 'number' && Number.isSafeInteger(at) && at > 0;
}

/**
 * The file of the answers, read strictly: a text of at most MAX_REGISTRY_ANSWERS_CHARACTERS, an object with `digests`
 * (at most MAX_REGISTRY_ANSWERS) and optionally `schedule` and `timeZone`; undefined for anything else. An entry whose
 * key is not the key of its reference (registryReferenceKey of itself), or whose answer is not a sha256 digest with a
 * time, is left out (no answer for that reference); so is a schedule or time zone that is not valid.
 */
export function parseRegistryAnswers(text: string): RegistryAnswers | undefined {
  if (text.length > MAX_REGISTRY_ANSWERS_CHARACTERS) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { schedule, timeZone, digests } = value as Record<string, unknown>;
  if (typeof digests !== 'object' || digests === null || Array.isArray(digests)) return undefined;
  const entries = Object.entries(digests);
  if (entries.length > MAX_REGISTRY_ANSWERS) return undefined;
  const answers: Record<string, RegistryAnswer> = Object.create(null) as Record<string, RegistryAnswer>;
  for (const [key, answer] of entries) {
    if (key.length > MAX_REFERENCE_LENGTH || registryReferenceKey(key) !== key || !isAnswer(answer)) continue;
    answers[key] = { digest: answer.digest, at: answer.at };
  }
  return {
    ...(typeof schedule === 'string' && parseCacheSchedule(schedule) !== undefined ? { schedule } : {}),
    ...(typeof timeZone === 'string' && isTimeZone(timeZone) ? { timeZone } : {}),
    digests: { ...answers },
  };
}

/** The text of the file as the monitor writes it (at most MAX_REGISTRY_ANSWERS answers). */
export function registryAnswersText(answers: RegistryAnswers): string {
  const digests = Object.fromEntries(Object.entries(answers.digests).slice(0, MAX_REGISTRY_ANSWERS));
  return JSON.stringify({
    ...(answers.schedule !== undefined ? { schedule: answers.schedule } : {}),
    ...(answers.timeZone !== undefined ? { timeZone: answers.timeZone } : {}),
    digests,
  });
}

/**
 * How long an answer of `at` is fresh: the time between two runs of the schedule plus REGISTRY_ANSWER_SLACK_MS, without
 * a cap: for an interval, the interval; for a cron schedule, the time from `at` (the run that read it) to the next time
 * of the schedule in its time zone. Unknown (no schedule, no time zone for a cron schedule, a cron schedule without a
 * next time): REGISTRY_ANSWER_UNKNOWN_SCHEDULE_MS.
 */
export function registryAnswerMaxAgeMs(answers: Pick<RegistryAnswers, 'schedule' | 'timeZone'>, at: number): number {
  const schedule = answers.schedule === undefined ? undefined : parseCacheSchedule(answers.schedule);
  if (schedule === undefined) return REGISTRY_ANSWER_UNKNOWN_SCHEDULE_MS;
  if (schedule.kind === 'interval') return schedule.minutes * 60_000 + REGISTRY_ANSWER_SLACK_MS;
  if (answers.timeZone === undefined || !isTimeZone(answers.timeZone)) return REGISTRY_ANSWER_UNKNOWN_SCHEDULE_MS;
  const next = nextCronTime(at, schedule.cron, answers.timeZone);
  return next === undefined ? REGISTRY_ANSWER_UNKNOWN_SCHEDULE_MS : next - at + REGISTRY_ANSWER_SLACK_MS;
}

/**
 * The fresh answers for `references` (image references as the configuration writes them) at `now`: the digest of each
 * reference whose answer is fresh (registryAnswerMaxAgeMs; not later than REGISTRY_ANSWER_CLOCK_SKEW_MS after `now`),
 * by the reference as given; `oldest`: the time of the oldest answer used. The other references are left to the open's
 * own check.
 */
export function freshRegistryDigests(
  answers: RegistryAnswers | undefined,
  references: readonly string[],
  now: number,
): { digests: Record<string, string>; others: string[]; oldest?: number } {
  const digests: Record<string, string> = {};
  const others: string[] = [];
  let oldest: number | undefined;
  for (const reference of references) {
    const key = registryReferenceKey(reference);
    const answer = answers !== undefined && key !== undefined && Object.hasOwn(answers.digests, key) ? answers.digests[key] : undefined;
    const fresh = answer !== undefined && answer.at <= now + REGISTRY_ANSWER_CLOCK_SKEW_MS && now - answer.at <= registryAnswerMaxAgeMs(answers!, answer.at);
    if (!fresh || Object.hasOwn(digests, reference)) {
      if (!fresh) others.push(reference);
      continue;
    }
    digests[reference] = answer.digest;
    oldest = oldest === undefined ? answer.at : Math.min(oldest, answer.at);
  }
  return { digests, others, ...(oldest !== undefined ? { oldest } : {}) };
}

/** `at` as HH:MM in `timeZone` (the computer's zone that the monitor runs with), else in UTC. */
export function answerTimeText(at: number, timeZone: string | undefined): string {
  const zone = timeZone !== undefined && isTimeZone(timeZone) ? timeZone : 'UTC';
  const text = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: zone }).format(new Date(at));
  return zone === 'UTC' ? `${text} UTC` : text;
}
