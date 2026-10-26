// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The open of a single container takes the CLI results and the host access analyses from the check result that the
// extension remembers, when nothing that they depend on changed; every change of an input runs the whole check again,
// and a refusal is never remembered.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UserFacingError } from '../errors';
import type { ConfigCheckEntry } from '../storage/configCheckEntry';
import { DEFAULT_CONFIG_PATH } from './recordRules';
import { ENV_ID, REPO, createHarness, seedDevspace, type Harness } from './devspaceService.testkit';

let h: Harness;
let stored: Map<string, ConfigCheckEntry>;
let remembered: number;

function harness(): Harness {
  stored = new Map();
  remembered = 0;
  return createHarness({
    configChecks: {
      get: async (id) => (stored.has(id) ? structuredClone(stored.get(id)) : undefined),
      remember: async (id, entry) => {
        remembered += 1;
        stored.set(id, structuredClone(entry));
      },
    },
  });
}

beforeEach(() => {
  h = harness();
  h.docker.fullContainerIds = true;
});

afterEach(() => {
  h.cleanup();
});

const reads = () => h.helper.calls.filter((call) => call.startsWith('readConfiguration'));
const open = () => h.service.openDevspace(ENV_ID, { progress: h.progress });
function editConfig(line: string): void {
  const files = h.helper.files[DEFAULT_CONFIG_PATH];
  files.configText = files.configText.replace('{', `{\n  ${line},`);
}
const REUSED = `The configuration of ${REPO} is unchanged; its check result is reused.`;

describe('the remembered check result', () => {
  it('a second open of the unchanged configuration skips both read-configuration runs and the analyses', async () => {
    await seedDevspace(h, { container: 'running' });
    await open();
    expect(reads()).toHaveLength(2);
    expect(remembered).toBe(1);
    expect(h.logger.infos).not.toContain(REUSED);

    h.helper.calls.length = 0;
    await open();
    expect(reads()).toEqual([]);
    expect(h.logger.infos).toContain(REUSED);
    // Nothing new to remember.
    expect(remembered).toBe(1);
  });

  it('a changed devcontainer.json runs the whole check again and remembers the new result', async () => {
    await seedDevspace(h, { container: 'running' });
    await open();
    const first = stored.get(ENV_ID)?.key;
    editConfig('"name": "changed"');
    h.helper.calls.length = 0;
    h.ui.configurationChangedAnswer = 'later';
    await open();
    expect(reads()).toHaveLength(2);
    expect(stored.get(ENV_ID)?.key).not.toBe(first);
  });

  it('another container is another key; an open without one remembers nothing', async () => {
    await seedDevspace(h, { container: 'running' });
    await open();
    const first = stored.get(ENV_ID)?.key;
    const [container] = h.docker.containersOf(ENV_ID);
    await h.docker.removeContainer(container.id);
    // No container: the CLI would read the base image and the Features from the registries; nothing is reused or remembered.
    h.helper.calls.length = 0;
    await open();
    expect(reads()).toHaveLength(2);
    expect(remembered).toBe(1);
    expect(h.docker.containersOf(ENV_ID)).toHaveLength(1);
    expect(h.docker.containersOf(ENV_ID)[0].id).not.toBe(container.id);
    // The new container: the remembered result of the old one does not fit.
    h.helper.calls.length = 0;
    await open();
    expect(reads()).toHaveLength(2);
    expect(remembered).toBe(2);
    expect(stored.get(ENV_ID)?.key).not.toBe(first);
  });

  it('a switch of the host access checks is another key', async () => {
    await seedDevspace(h, { container: 'running' });
    await open();
    h.settings = { ...h.settings, hostAccessChecksOff: [REPO] };
    h.helper.calls.length = 0;
    await open().catch(() => undefined);
    expect(reads()).toHaveLength(2);
  });

  it('a remembered result of another key is not used', async () => {
    await seedDevspace(h, { container: 'running' });
    await open();
    const entry = stored.get(ENV_ID)!;
    stored.set(ENV_ID, { ...entry, key: '0'.repeat(64) });
    h.helper.calls.length = 0;
    await open();
    expect(reads()).toHaveLength(2);
    expect(stored.get(ENV_ID)?.key).toBe(entry.key);
  });

  it('a refusal is never remembered, and a remembered result never hides a refusal of changed inputs', async () => {
    await seedDevspace(h, { container: 'running' });
    await open();
    expect(remembered).toBe(1);
    editConfig('"privileged": true');
    h.helper.config = { ...h.helper.config, privileged: true };
    h.ui.configurationChangedAnswer = 'later';
    h.helper.calls.length = 0;
    const error = await open().then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(UserFacingError);
    expect(reads().length).toBeGreaterThan(0);
    expect(remembered).toBe(1);
  });

});
