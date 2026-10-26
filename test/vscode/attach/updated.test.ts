// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

/// <reference types="mocha" />
// Attach tests after the update from the last released version (.vscode-test.mjs, label attach,
// DEVSPACE_TEST_ATTACH=updated): the second of the two runs of the update (previous.test.ts is the first). Between the
// runs CI installed the VSIX of this checkout over the released version (scripts/install-attach-extensions.mjs). VS Code
// starts again with the user data folder of the run `previous`, in the window of the devspace whose container kept
// running, as at the first start of VS Code some time after an update (the configuration removes the pending connection
// files of the released version first): the new version reads the registry and the Docker objects of the released
// version, and runs the open pipeline before the window connects. The tests compare with what the run `previous` saved
// (PREVIOUS_STATE_FILE).
// The Monitor of the released version runs when the new version starts: the new version replaces it when its script
// or helper tag is another (src/core/remoteMonitor/remoteSessionMonitor.ts, decide), and keeps it otherwise.
// Not covered: an update while the window stays open, where only the extension hosts restart, and two windows that run
// different versions at the same time.
import * as assert from 'assert';
import * as fs from 'fs';
import { REMOTE_MONITOR_CONTAINER } from '../../../src/core/remoteMonitor/protocol';
import { channelLog, connectedFolder, docker, execIn, printLogs, seed, waitFor } from './support';
import { PACKAGED_FILE, PREVIOUS_STATE_FILE, devspaceObjects, extensionFolders, installedExtension, monitorState, registryOf, type PreviousState } from './update';

/** The line of the new version when it replaces a Monitor of another label (remoteSessionMonitor.ts, decide). */
const MONITOR_REPLACED = `The Monitor on the Docker host is of another version; it is replaced (${REMOTE_MONITOR_CONTAINER}).`;

describe('the window of the devspace after the update to the VSIX of this checkout', () => {
  const { containerName, user, devspaceId, previous } = seed();
  let failed = false;

  afterEach(function () {
    if (this.currentTest?.state === 'failed') failed = true;
  });

  after(() => {
    if (failed) printLogs();
  });

  function previousState(): PreviousState {
    assert.ok(fs.existsSync(PREVIOUS_STATE_FILE), `${PREVIOUS_STATE_FILE} does not exist: the run \`previous\` did not end`);
    return JSON.parse(fs.readFileSync(PREVIOUS_STATE_FILE, 'utf8')) as PreviousState;
  }

  it('runs the VSIX of this checkout, installed over the released version', () => {
    assert.ok(previous && devspaceId, 'The seed has no previous version (prepare.ts, DEVSPACE_TEST_ATTACH_PREPARE=update)');
    const packaged = JSON.parse(fs.readFileSync(PACKAGED_FILE, 'utf8')) as { version: string; extensionSha256: string };
    const installed = installedExtension();
    const code = installed.extensionSha256 === previous.extensionSha256 ? 'the same code' : 'other code';
    console.log(`    update from ${previous.version} to ${installed.version} (${code}): ${JSON.stringify(installed)}; folders: ${extensionFolders(installed).join(', ')}`);
    assert.strictEqual(installed.version, packaged.version);
    assert.strictEqual(installed.extensionSha256, packaged.extensionSha256, 'VS Code runs another build than the VSIX of this checkout');
  });

  it('reads the registry of the released version and runs the open pipeline before the window connects', async () => {
    assert.ok(devspaceId);
    await connectedFolder();
    const log = channelLog('Devspaces');
    assert.match(log, /This window was restored or reloaded\. The open pipeline of devspaces-test\/attach runs before it connects\./);
    assert.ok(log.includes(`devspaces-test/attach is ready in the container ${containerName}.`), `The open pipeline did not make ${containerName} ready`);
    // A registry that this version cannot read would be rebuilt from the volume labels at activation.
    assert.doesNotMatch(log, /devspaces were restored from the labels of their volumes/);
    const before = previousState().registry;
    const after = registryOf(devspaceId);
    assert.ok(after.entry && before.entry, `registry.json has no entry of the devspace ${devspaceId}`);
    const changed = Object.keys({ ...before.entry, ...after.entry }).filter((key) => JSON.stringify(before.entry?.[key]) !== JSON.stringify(after.entry?.[key]));
    console.log(`    registry: version ${String(before.version)} → ${String(after.version)}, ${before.count} → ${after.count} devspaces; changed fields of the entry: ${changed.join(', ') || 'none'}`);
    assert.strictEqual(after.count, before.count);
    // The devspace of its configuration (an entry that was not last started from the default image).
    for (const key of ['containerName', 'volumeName', 'configPath', 'defaultImage', 'repository']) {
      assert.deepStrictEqual(after.entry[key], before.entry[key], `The field ${key} of the registry entry changed`);
    }
  });

  it('attaches the window to the same container and keeps the Docker objects of the devspace with their names', async () => {
    assert.ok(devspaceId);
    const before = previousState();
    assert.strictEqual(docker(['inspect', '--type', 'container', '-f', '{{.Id}} {{.State.Status}}', containerName]).trim(), `${before.containerId} running`);
    // The run `previous` wrote the first line; a new container would start without it.
    await waitFor('the second line of postAttachCommand', () => (execIn(user, 'wc -l < /tmp/attach-count').out === '2' ? true : undefined), 60_000);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    assert.strictEqual(execIn(user, 'wc -l < /tmp/attach-count').out, '2');
    const after = devspaceObjects(devspaceId);
    console.log(`    Docker objects of the devspace: ${JSON.stringify(before.objects)} → ${JSON.stringify(after)}`);
    assert.deepStrictEqual({ containers: after.containers, volumes: after.volumes }, { containers: before.objects.containers, volumes: before.objects.volumes });
  });

  it('replaces the Monitor of the released version when its label is another, and keeps it otherwise', () => {
    const before = previousState().monitor;
    const after = monitorState();
    assert.ok(after?.status === 'running', `The Monitor does not run: ${JSON.stringify(after)}`);
    const replaced = channelLog('Devspaces').includes(MONITOR_REPLACED);
    console.log(`    Monitor: ${JSON.stringify(before)} → ${JSON.stringify(after)}; replaced as of another version: ${replaced}`);
    // A container keeps its labels, so another label is another container.
    if (after.label !== before.label) {
      assert.ok(replaced, `The log has no line "${MONITOR_REPLACED}"`);
    } else {
      assert.strictEqual(after.id, before.id, 'The Monitor of the same label was replaced');
      assert.ok(!replaced, `The log has the line "${MONITOR_REPLACED}" although the label is the same`);
    }
  });

  it('logs no error', () => {
    const lines = channelLog('Devspaces').split('\n');
    const warnings = lines.filter((line) => /^\[\d\d:\d\d:\d\d\] warn /.test(line));
    if (warnings.length > 0) console.log(`    warnings of the new version:\n${warnings.join('\n')}`);
    assert.deepStrictEqual(lines.filter((line) => /^\[\d\d:\d\d:\d\d\] error /.test(line)), []);
  });
});
