// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Monitor's registry answers, fresh for the time between two runs of its schedule plus 5 minutes, without a
// cap; read strictly.
import { describe, expect, it } from 'vitest';
import {
  MAX_REGISTRY_ANSWERS,
  MAX_REGISTRY_ANSWERS_CHARACTERS,
  REGISTRY_ANSWER_SLACK_MS,
  REGISTRY_ANSWER_UNKNOWN_SCHEDULE_MS,
  answerTimeText,
  freshRegistryDigests,
  parseRegistryAnswers,
  registryAnswerMaxAgeMs,
  registryAnswersText,
  registryReferenceKey,
  type RegistryAnswers,
} from './registryAnswers';

const D1 = `sha256:${'1'.repeat(64)}`;
const D2 = `sha256:${'2'.repeat(64)}`;
const MIN = 60_000;
// 2026-10-11 06:07 in Europe/Vienna (UTC+2).
const RUN = Date.parse('2026-10-11T04:07:00.000Z');

describe('the registry answers of the Monitor', () => {
  it('a reference is looked up under the key that the monitor writes (`latest` without a tag, docker.io short names)', () => {
    expect(registryReferenceKey('node:20')).toBe(registryReferenceKey('docker.io/library/node:20'));
    expect(registryReferenceKey('redis')).toBe(registryReferenceKey('redis:latest'));
    expect(registryReferenceKey(`node@${D1}`)).toBeUndefined();
    expect(registryReferenceKey('Not a reference')).toBeUndefined();
  });

  it('the fresh time: the interval plus 5 minutes; a daily cron schedule up to its next run plus 5 minutes, no cap', () => {
    expect(REGISTRY_ANSWER_SLACK_MS).toBe(5 * MIN);
    expect(registryAnswerMaxAgeMs({ schedule: '17' }, RUN)).toBe(22 * MIN);
    expect(registryAnswerMaxAgeMs({ schedule: '30' }, RUN)).toBe(35 * MIN);
    expect(registryAnswerMaxAgeMs({ schedule: '7 6 * * *', timeZone: 'Europe/Vienna' }, RUN)).toBe(24 * 60 * MIN + 5 * MIN);
    // Unknown: no schedule, an invalid one, a cron schedule without its time zone.
    expect(REGISTRY_ANSWER_UNKNOWN_SCHEDULE_MS).toBe(22 * MIN);
    expect(registryAnswerMaxAgeMs({}, RUN)).toBe(22 * MIN);
    expect(registryAnswerMaxAgeMs({ schedule: 'nonsense' }, RUN)).toBe(22 * MIN);
    expect(registryAnswerMaxAgeMs({ schedule: '7 6 * * *' }, RUN)).toBe(22 * MIN);
  });

  it('uses fresh answers and leaves every other reference (old, missing, from the future, pinned) to the open', () => {
    // 20 hours after the run (the next run at 06:07 tomorrow): the overnight answer is still fresh.
    const now = RUN + 20 * 60 * MIN;
    const answers: RegistryAnswers = {
      schedule: '7 6 * * *',
      timeZone: 'Europe/Vienna',
      digests: {
        [registryReferenceKey('ghcr.io/acme/web:latest')!]: { digest: D1, at: RUN },
        [registryReferenceKey('node:20')!]: { digest: D2, at: RUN - 2 * 24 * 60 * MIN },
        // From another clock, 10 minutes ahead of this one (more than the skew of a minute).
        [registryReferenceKey('redis')!]: { digest: D2, at: now + 10 * MIN },
      },
    };
    const fresh = freshRegistryDigests(answers, ['ghcr.io/acme/web:latest', 'node:20', 'redis', 'postgres:16', `node@${D1}`], now);
    expect(fresh.digests).toEqual({ 'ghcr.io/acme/web:latest': D1 });
    expect(fresh.others).toEqual(['node:20', 'redis', 'postgres:16', `node@${D1}`]);
    expect(fresh.oldest).toBe(RUN);
    // After the next run plus 5 minutes the answer is old.
    expect(freshRegistryDigests(answers, ['ghcr.io/acme/web:latest'], RUN + 24 * 60 * MIN + 6 * MIN).others).toEqual(['ghcr.io/acme/web:latest']);
    // No file: every reference is the open's.
    expect(freshRegistryDigests(undefined, ['node:20'], now)).toEqual({ digests: {}, others: ['node:20'] });
  });

  it('reads the file strictly: a bad entry is no answer, a bad file none at all', () => {
    const key = registryReferenceKey('node:20')!;
    const text = registryAnswersText({ schedule: '17', timeZone: 'Europe/Vienna', digests: { [key]: { digest: D1, at: RUN } } });
    expect(parseRegistryAnswers(text)).toEqual({ schedule: '17', timeZone: 'Europe/Vienna', digests: { [key]: { digest: D1, at: RUN } } });
    const bad = parseRegistryAnswers(
      JSON.stringify({
        schedule: 'every day',
        timeZone: 'Mars/Base',
        digests: {
          [key]: { digest: 'sha256:short', at: RUN },
          'node:21': { digest: D1, at: RUN, extra: 1 },
          'NOT A KEY': { digest: D1, at: RUN },
          'redis:latest': { digest: D2, at: -1 },
          '__proto__': { digest: D1, at: RUN },
        },
      }),
    );
    expect(bad).toEqual({ digests: {} });
    expect(parseRegistryAnswers('not json')).toBeUndefined();
    expect(parseRegistryAnswers('[]')).toBeUndefined();
    expect(parseRegistryAnswers(JSON.stringify({ digests: [] }))).toBeUndefined();
    expect(parseRegistryAnswers(' '.repeat(MAX_REGISTRY_ANSWERS_CHARACTERS + 1))).toBeUndefined();
    const many = Object.fromEntries(Array.from({ length: MAX_REGISTRY_ANSWERS + 1 }, (_, i) => [`docker.io/library/n${i}:1`, { digest: D1, at: RUN }]));
    expect(parseRegistryAnswers(JSON.stringify({ digests: many }))).toBeUndefined();
  });

  it('names the time of the answer in the time zone of the monitor', () => {
    expect(answerTimeText(RUN, 'Europe/Vienna')).toBe('06:07');
    expect(answerTimeText(RUN, undefined)).toBe('04:07 UTC');
  });
});
