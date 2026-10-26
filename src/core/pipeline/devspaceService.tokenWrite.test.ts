// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The log line of a successful token write (its standard output, masked; nothing for a write without output): no
// empty log line, and the error output of a successful write is not logged.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TOKEN_WRITE_SCRIPT } from '../helper/containerToken';
import { REPO, TOKEN, createHarness, type Harness } from './devspaceService.testkit';
import type { RepositoryTarget } from './operationBase';
import { DEFAULT_CONFIG_PATH } from './recordRules';

const TARGET: RepositoryTarget = { repository: REPO, defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

afterEach(() => {
  h.cleanup();
});

describe('the log of a successful token write', () => {
  it('a write without output logs no line, not even an empty one', async () => {
    const before = h.logger.infos.length;
    await h.service.open(TARGET, { progress: h.progress });
    expect(h.docker.tokenWrites()).toHaveLength(1);
    expect(h.logger.infos.slice(before)).not.toContain('');
  });

  it('the error output of a successful write is not logged (nor the token)', async () => {
    h.docker.execHandler = (_container, command) => (command[2] === TOKEN_WRITE_SCRIPT ? { stdout: '', stderr: `note ${TOKEN}\n` } : {});
    await h.service.open(TARGET, { progress: h.progress });
    expect(h.docker.tokenWrites()).toHaveLength(1);
    expect(h.logger.infos.some((line) => line.includes('note'))).toBe(false);
    expect(h.logger.infos).not.toContain('');
    expect(JSON.stringify(h.logger.infos)).not.toContain(TOKEN);
  });
});
