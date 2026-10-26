// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

/// <reference types="mocha" />
// Attach tests with the last released version of the extension (.vscode-test.mjs, label attach,
// DEVSPACE_TEST_ATTACH=previous): the first of the two runs of the update from that version (updated.test.ts is the
// second). VS Code starts with a fresh user data folder in the window of the devspace that prepare.ts
// (DEVSPACE_TEST_ATTACH_PREPARE=update) made without container, and runs the released version that prepare.ts installed
// from the VSIX of its GitHub release. That version restores the devspace from its volume labels, creates its container
// and the Monitor, and writes its registry entry; the window attaches. The tests check this with Docker and the files of
// the user data folder only, not with log lines, because the texts of a released version are fixed. They save what the
// run `updated` compares (PREVIOUS_STATE_FILE). VS Code quits after the tests, and the container keeps running (the
// Monitor stops it only after its waiting time).
import * as assert from 'assert';
import * as fs from 'fs';
import { connectedFolder, docker, execIn, printLogs, seed, waitFor } from './support';
import { PREVIOUS_STATE_FILE, devspaceObjects, extensionFolders, installedExtension, monitorState, registryOf, type PreviousState } from './update';

describe('the window of a devspace with the last released version of the extension', () => {
  const { containerName, user, devspaceId, previous } = seed();
  let failed = false;

  afterEach(function () {
    if (this.currentTest?.state === 'failed') failed = true;
  });

  after(() => {
    if (failed) printLogs();
  });

  it('runs the released version from the extensions folder', () => {
    assert.ok(previous && devspaceId, 'The seed has no previous version (prepare.ts, DEVSPACE_TEST_ATTACH_PREPARE=update)');
    const installed = installedExtension();
    console.log(`    previous version: ${JSON.stringify(installed)}; folders: ${extensionFolders(installed).join(', ')}`);
    assert.strictEqual(installed.version, previous.version);
    assert.strictEqual(installed.extensionSha256, previous.extensionSha256, 'VS Code runs another build than the released version');
  });

  it('attaches the window to the container that this version created for the devspace', async () => {
    await connectedFolder();
    assert.strictEqual(docker(['inspect', '--type', 'container', '-f', '{{.State.Status}}', containerName]).trim(), 'running');
    // The repository appends a line to /tmp/attach-count at each attach (prepare.ts).
    await waitFor('the line of postAttachCommand', () => (execIn(user, 'test -s /tmp/attach-count').code === 0 ? true : undefined), 60_000);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    assert.strictEqual(execIn(user, 'wc -l < /tmp/attach-count').out, '1');
  });

  it('leaves its registry entry, the Monitor and the Docker objects of the devspace for the update', () => {
    assert.ok(devspaceId);
    const registry = registryOf(devspaceId);
    assert.ok(registry.entry, `registry.json has no entry of the devspace ${devspaceId}`);
    assert.strictEqual(registry.entry.containerName, containerName);
    const monitor = monitorState();
    assert.ok(monitor?.status === 'running', `The Monitor does not run: ${JSON.stringify(monitor)}`);
    const objects = devspaceObjects(devspaceId);
    assert.deepStrictEqual({ containers: objects.containers, volumes: objects.volumes }, { containers: [containerName], volumes: [containerName] });
    const state: PreviousState = { containerId: docker(['inspect', '--type', 'container', '-f', '{{.Id}}', containerName]).trim(), monitor, registry, objects };
    fs.writeFileSync(PREVIOUS_STATE_FILE, JSON.stringify(state, null, 2));
    console.log(`    state of the previous version: ${JSON.stringify(state)}`);
  });
});
