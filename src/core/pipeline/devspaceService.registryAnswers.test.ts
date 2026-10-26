// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The open takes the digest of an image reference from the Monitor's registry answer while it is fresh, and
// asks the registry itself only for the other references (Features, private or unanswered images, old answers) and for
// a rebuild. A running container is checked at every open.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { devspaceImageName } from '../names';
import { registryReferenceKey, type RegistryAnswers } from '../remoteMonitor/registryAnswers';
import { BASE_IMAGE, DIGEST_NEW, DIGEST_OLD, ENV_ID, FEATURE, REPO, T0, createHarness, seedDevspace, type Harness } from './devspaceService.testkit';

const MIN = 60_000;
let h: Harness;
let answers: RegistryAnswers | undefined;

function answer(digest: string, at: number, schedule = '17'): RegistryAnswers {
  return { schedule, timeZone: 'Europe/Vienna', digests: { [registryReferenceKey(BASE_IMAGE)!]: { digest, at } } };
}

beforeEach(() => {
  answers = undefined;
  h = createHarness({ registryAnswers: async () => answers });
});

afterEach(() => {
  h.cleanup();
});

const open = (extra: { forceRebuild?: boolean } = {}) => h.service.openDevspace(ENV_ID, { progress: h.progress, ...extra });

describe("the Monitor's registry answers at the open", () => {
  it('a fresh answer: the registry is asked only for the Features', async () => {
    await seedDevspace(h, { container: 'running', record: { images: { [BASE_IMAGE]: DIGEST_NEW } } });
    answers = answer(DIGEST_NEW, T0 - 10 * MIN);
    await open();
    expect(h.checker.calls).toEqual([{ images: [], features: [FEATURE] }]);
    expect(h.logger.infos.some((line) => line.startsWith("The Monitor's registry check of "))).toBe(true);
    expect(h.helper.builds).toEqual([]);
  });

  it('a fresh answer with a newer digest is an update, as the own check finds it', async () => {
    await seedDevspace(h, { container: 'running', record: { images: { [BASE_IMAGE]: DIGEST_OLD } } });
    answers = answer(DIGEST_NEW, T0 - 10 * MIN);
    h.ui.updateContainerAnswer = 'update';
    await open();
    expect(h.checker.calls).toEqual([{ images: [], features: [FEATURE] }]);
    expect(h.helper.calls).toContain(`build ${devspaceImageName(REPO, ENV_ID, 2)}`);
  });

  it('an answer older than the interval plus 5 minutes, or none: the open asks the registry for every reference', async () => {
    await seedDevspace(h, { container: 'running', record: { images: { [BASE_IMAGE]: DIGEST_NEW } } });
    answers = answer(DIGEST_NEW, T0 - 23 * MIN);
    await open();
    answers = undefined;
    await open();
    expect(h.checker.calls).toEqual([
      { images: [BASE_IMAGE], features: [FEATURE] },
      { images: [BASE_IMAGE], features: [FEATURE] },
    ]);
  });

  it('a daily schedule: the overnight answer is fresh the whole day', async () => {
    await seedDevspace(h, { container: 'stopped', record: { images: { [BASE_IMAGE]: DIGEST_NEW } } });
    answers = answer(DIGEST_NEW, T0 - 9 * 60 * MIN, '7 6 * * *');
    await open();
    expect(h.checker.calls).toEqual([{ images: [], features: [FEATURE] }]);
  });

  it('a rebuild asks the registry for every reference', async () => {
    await seedDevspace(h, { container: 'running', record: { images: { [BASE_IMAGE]: DIGEST_NEW } } });
    answers = answer(DIGEST_NEW, T0 - 10 * MIN);
    await open({ forceRebuild: true });
    expect(h.checker.calls).toEqual([{ images: [BASE_IMAGE], features: [FEATURE] }]);
  });

  it('a running container is checked at every open', async () => {
    await seedDevspace(h, { container: 'running', record: { images: { [BASE_IMAGE]: DIGEST_NEW } } });
    await open();
    await open();
    expect(h.checker.calls).toHaveLength(2);
  });
});
