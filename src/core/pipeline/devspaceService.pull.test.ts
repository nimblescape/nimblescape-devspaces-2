// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Probes of the pull of the pipeline, which has no credentials of its own (the worker's EngineDocker asks for the login
// of the registry itself). FakeDocker records the reference of a pull but not its options, so the probe records them
// itself.
import { afterEach, describe, expect, it } from 'vitest';
import { abortError } from '../ports';
import { BASE_IMAGE, REPO, createHarness, type Harness } from './devspaceService.testkit';
import type { RepositoryTarget } from './operationBase';
import { DEFAULT_CONFIG_PATH } from './recordRules';

const TARGET: RepositoryTarget = { repository: REPO, defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };

let h: Harness;

afterEach(() => {
  h?.cleanup();
});

describe('the pull of the open', () => {
  // The pull has the cancel of the open (without it, a cancel would wait for the whole download). The options are
  // exactly the output and the signal: no credentials of the pipeline.
  it('pulls with the cancel of the open and its output, and without credentials of its own', async () => {
    h = createHarness();
    const pulls: Array<{ reference: string; options: Record<string, unknown> }> = [];
    const pull = h.docker.pullImage.bind(h.docker);
    h.docker.pullImage = async (reference, options = {}) => {
      pulls.push({ reference, options: { ...options } });
      return pull(reference, options);
    };
    const signal = new AbortController().signal;
    await h.service.open(TARGET, { progress: h.progress, signal });
    expect(pulls.map((entry) => entry.reference)).toEqual([BASE_IMAGE]);
    expect(pulls[0].options).toEqual({ onOutput: expect.any(Function), signal });
  });

  // A cancel during a pull that may fail (the image exists locally) is not taken as a failed download: otherwise the
  // open would go on with the local image (and say so) until its next check of the cancel.
  it('a cancel during a pull that may fail ends the open as cancelled, without falling back to the local image', async () => {
    h = createHarness();
    h.docker.images.add(BASE_IMAGE);
    const controller = new AbortController();
    h.docker.pullImage = async () => {
      controller.abort();
      throw abortError();
    };
    const error = await h.service.open(TARGET, { progress: h.progress, signal: controller.signal }).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toMatchObject({ code: 'cancelled' });
    expect(h.logger.warnings.filter((line) => line.includes('could not be downloaded'))).toEqual([]);
    expect(h.helper.builds).toEqual([]);
  });
});
