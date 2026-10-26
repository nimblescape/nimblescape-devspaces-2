// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { configDefaults, defineConfig } from 'vitest/config';
import { buildDefines } from './scripts/buildDefines.mjs';

const TEST_FILES = 'test/docker/**/*.test.ts';

/**
 * The groups of test files that CI runs side by side, each on a runner and engine of its own (DEVSPACE_TEST_GROUP, the
 * matrix of the job "docker" in .github/workflows/ci.yml); each takes about the same time by the times of the files in
 * CI. The group `other` runs every file that no group here names, so a new test file always runs in CI. Without
 * DEVSPACE_TEST_GROUP, every file runs. The matrix names each group once: a name that is no group fails, and so does a
 * matrix with another number of jobs (DEVSPACE_TEST_GROUP_COUNT), so a group cannot be left out of CI by mistake. A
 * named file that does not exist fails too, so a renamed file does not move to `other` unseen.
 */
const TEST_GROUPS = new Map<string, string[]>([
  ['monitor', ['test/docker/remoteMonitor.test.ts', 'test/docker/workerBatch.test.ts']],
  ['pipeline', ['test/docker/pipeline.test.ts', 'test/docker/compose.test.ts', 'test/docker/helperImage.test.ts']],
]);
const GROUP_NAMES = [...TEST_GROUPS.keys(), 'other'];

/** The test files of DEVSPACE_TEST_GROUP: `include`, and what to leave out of it. */
function testGroup(group: string | undefined, count: string | undefined): { include: string[]; exclude: string[] } {
  if (group === undefined || group === '') return { include: [TEST_FILES], exclude: [] };
  if (count !== undefined && count !== String(GROUP_NAMES.length)) {
    throw new Error(`CI runs ${count} groups of Docker tests, but vitest.docker.config.mts has ${GROUP_NAMES.length} (${GROUP_NAMES.join(', ')}).`);
  }
  const missing = [...TEST_GROUPS.values()].flat().filter((file) => !fs.existsSync(fileURLToPath(new URL(file, import.meta.url))));
  if (missing.length > 0) throw new Error(`The groups of vitest.docker.config.mts name files that do not exist: ${missing.join(', ')}.`);
  if (group === 'other') return { include: [TEST_FILES], exclude: [...TEST_GROUPS.values()].flat() };
  const files = TEST_GROUPS.get(group);
  if (files === undefined) throw new Error(`DEVSPACE_TEST_GROUP=${group} names no group (${GROUP_NAMES.join(', ')}).`);
  return { include: files, exclude: [] };
}

const group = testGroup(process.env.DEVSPACE_TEST_GROUP, process.env.DEVSPACE_TEST_GROUP_COUNT);

// Integration tests against the real Docker engine (npm run test:docker). `npm test` does not run them.
export default defineConfig({
  // The same compile-time constants as in esbuild.mjs (src/types/globals.d.ts).
  define: buildDefines(),
  test: {
    include: group.include,
    exclude: [...configDefaults.exclude, ...group.exclude],
    environment: 'node',
    globalSetup: ['test/docker/globalSetup.ts'],
    // One file at a time: the files share the Docker engine, and the check for leftovers needs a quiet engine.
    fileParallelism: false,
    // A first run builds the workspace helper image, which can take some minutes.
    testTimeout: 10 * 60_000,
    hookTimeout: 10 * 60_000,
    teardownTimeout: 60_000,
    reporters: ['verbose'],
  },
});
