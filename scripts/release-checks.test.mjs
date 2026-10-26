// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The parts of scripts/release-checks.mjs that need no Git and no network. The test is the same in every extension
// repository of nimblescape.
import { describe, expect, it } from 'vitest';
import { RELEASE_FILES, RELEASE_WORKFLOW, compareVersions, newestTag, parseVersion } from './release-checks.mjs';

describe('versions and tags', () => {
  it('reads only versions <major>.<minor>.<patch>', () => {
    expect(parseVersion('0.10.2')).toEqual([0, 10, 2]);
    expect(parseVersion('v0.10.2')).toBeUndefined();
    expect(parseVersion('1.02.0')).toBeUndefined();
    expect(parseVersion('1.2')).toBeUndefined();
  });

  it('compares versions by their numbers', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('0.1.8', '0.2.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });

  it('finds the newest release tag', () => {
    expect(newestTag(['v0.1.9', 'v0.10.0', 'v0.2.0', 'latest', 'v1.0.0-beta', 'x0.20.0'])).toBe('v0.10.0');
    expect(newestTag(['latest'])).toBeUndefined();
    expect(newestTag([])).toBeUndefined();
  });
});

describe('rule 4: dry run first', () => {
  it('counts ci.yml among the files of the release process, because the release publishes its VSIX', () => {
    expect(RELEASE_FILES).toEqual([RELEASE_WORKFLOW, '.github/workflows/ci.yml', 'scripts/release-checks.mjs']);
  });
});
