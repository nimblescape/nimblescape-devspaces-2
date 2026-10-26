// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

/// <reference types="mocha" />
// Attach tests in the window of a devspace on the Docker engine of another computer (.vscode-test.mjs, label attach,
// DEVSPACE_TEST_ATTACH=remote): Docker uses that engine over SSH (its Docker context is the current context, as after
// "Use a Remote Docker Host…"), and VS Code starts in the window of the devspace there, whose folder URI names that
// context. prepare.ts made the devspace without container, so the extension restores it from its volume labels on that
// engine and runs the open pipeline there before the window connects; the Dev Containers extension attaches through
// the context of the URI. The engine of the runner has a container with the name of the devspace container, which the
// window must not use. The current context is the one of the URI, so these tests do not tell whether Dev Containers
// reads the context from the URI or follows the current context; the window of another Docker host than the current
// one closes before it attaches (controller.ts, onWindowHost).
import * as assert from 'assert';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { DEFAULT_CONTEXT_NAME } from '../../../src/core/docker/dockerHost';
import { LABEL_DEVSPACE_ID, LABEL_HELPER } from '../../../src/core/names';
import { LABEL_MONITOR } from '../../../src/core/remoteMonitor/protocol';
import { decodeAuthorityParts } from '../../../src/vscode/connection/authority';
import { EXTENSION_ID, channelLog, connectedFolder, docker, printLogs, seed, serverDataFolder } from './support';

/** A file that the window writes into its container. */
const WINDOW_MARK = '/tmp/devspaces-test-window-mark';

describe('the window of a devspace on a Docker engine over SSH', () => {
  const { containerName, dockerContext = '', remoteHost = '' } = seed();
  let failed = false;

  afterEach(function () {
    if (this.currentTest?.state === 'failed') failed = true;
  });

  after(() => {
    if (failed) printLogs();
  });

  it('connects after the extension restored the devspace on that engine and ran its open pipeline there', async () => {
    assert.ok(dockerContext && remoteHost, 'The seed names no Docker context and no host (prepare.ts, DEVSPACE_TEST_ATTACH_PREPARE=remote)');
    const folder = await connectedFolder();
    assert.deepStrictEqual(decodeAuthorityParts(folder.authority), { containerName, dockerContext });
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension?.isActive, `${EXTENSION_ID} is not active`);
    const log = channelLog('Devspaces');
    assert.match(log, /1 devspaces were restored from the labels of their volumes\./);
    assert.match(log, /The open pipeline of devspaces-test\/attach runs before it connects\./);
    assert.match(log, /devspaces-test\/attach is ready in the container /);
    // Each line of a worker names its engine: the operations ran on the other computer, none on the local Docker.
    assert.ok(log.includes(`[${remoteHost}] open#`), `No operation open on ${remoteHost} in the log`);
    assert.doesNotMatch(log, /\[the local Docker\]/);
    assert.strictEqual(docker(['--context', dockerContext, 'inspect', '-f', '{{.State.Status}}', containerName]).trim(), 'running');
    const entries = (await vscode.workspace.fs.readDirectory(folder)).map(([name]) => name);
    assert.ok(entries.includes('.devcontainer'), entries.join(', '));
  });

  it('works in the container on that engine, not in the container of the same name on the local Docker', async () => {
    const folder = await connectedFolder();
    const text = crypto.randomUUID();
    await vscode.workspace.fs.writeFile(folder.with({ path: WINDOW_MARK }), Buffer.from(text, 'utf8'));
    assert.strictEqual(docker(['--context', dockerContext, 'exec', containerName, 'cat', WINDOW_MARK]), text);
    // The container of the local Docker still runs, and the window left nothing there: no file and no VS Code server.
    assert.strictEqual(docker(['--context', DEFAULT_CONTEXT_NAME, 'inspect', '-f', '{{.State.Status}}', containerName]).trim(), 'running');
    const found = docker(['--context', DEFAULT_CONTEXT_NAME, 'exec', containerName, 'sh', '-c', 'for f in "$@"; do if [ -e "$f" ]; then echo "$f"; fi; done', 'sh', WINDOW_MARK, `/root/${serverDataFolder()}`]);
    assert.strictEqual(found.trim(), '', 'The window changed the container of the same name on the local Docker');
  });

  it('runs the Monitor on that engine and creates nothing on the local Docker', () => {
    assert.notStrictEqual(docker(['--context', dockerContext, 'ps', '-q', '--filter', `label=${LABEL_MONITOR}`, '--filter', 'status=running']).trim(), '', `No Monitor runs on ${remoteHost}`);
    // Workers and the Monitor are containers of the helper image, which carries LABEL_HELPER.
    const local = (args: string[]): string => docker(['--context', DEFAULT_CONTEXT_NAME, ...args]).trim();
    assert.strictEqual(local(['images', '-q', '--filter', `label=${LABEL_HELPER}`]), '', 'A helper image on the local Docker');
    assert.strictEqual(local(['ps', '-aq', '--filter', `label=${LABEL_HELPER}`]), '', 'A container of the helper image on the local Docker');
    assert.strictEqual(local(['volume', 'ls', '-q', '--filter', `label=${LABEL_DEVSPACE_ID}`]), '', 'A devspace volume on the local Docker');
  });
});
