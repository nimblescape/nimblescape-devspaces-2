// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

/// <reference types="mocha" />
// Attach tests of a restored window whose open pipeline takes several minutes (.vscode-test.mjs, label attach,
// DEVSPACE_TEST_ATTACH=longopen): VS Code starts again in the window of the devspace, as long after the last open (the
// configuration removes the pending connection files). Before this run the CI job stopped the container and wrote the
// mark of its postStartCommand (prepare.ts), which then waits longStartSeconds. The open pipeline of the restored window
// starts the container and runs postStartCommand before the window connects. Assumption (src/vscode/controller.ts,
// openAttachedWindow): the activation of the extension blocks the connection of the window until the pipeline ends,
// also after several minutes, and VS Code does not connect or fail first.
import * as assert from 'assert';
import { GH_HOSTS_FILE, GITHUB_TOKEN_FILE } from '../../../src/core/names';
import { channelLog, connectedFolder, docker, execIn, printLogs, seed, waitFor } from './support';

describe('the restored window of a devspace whose open pipeline takes several minutes', () => {
  const { containerName, user, longStartSeconds } = seed();
  let failed = false;

  afterEach(function () {
    if (this.currentTest?.state === 'failed') failed = true;
  });

  after(() => {
    if (failed) printLogs();
  });

  /** A time in seconds since 1970 that postStartCommand or postAttachCommand wrote. */
  function writtenTime(file: string): number {
    const result = execIn(user, `cat ${file}`);
    assert.strictEqual(result.code, 0, `${file}: ${result.out}`);
    return Number(result.out);
  }

  it('ran the open pipeline before it connected, and it started the stopped container', async () => {
    await connectedFolder();
    const log = channelLog('Devspaces');
    assert.match(log, /This window was restored or reloaded\. The open pipeline of devspaces-test\/attach runs before it connects\./);
    // The progress of the open in the worker (helperChannel.ts): the step of the container start.
    assert.match(log, /\] open#\d+: starting/);
    assert.match(log, /devspaces-test\/attach is ready in the container /);
    const [status, created, started] = docker(['inspect', '-f', '{{.State.Status}} {{.Created}} {{.State.StartedAt}}', containerName]).trim().split(' ');
    assert.strictEqual(status, 'running');
    // The container of the earlier runs, not a new one (for example after an image update): the mark of the CI job is
    // only in that one.
    assert.ok(Date.parse(started) - Date.parse(created) > 10_000, `The pipeline made the container again (created ${created}, started ${started})`);
  });

  it('waited for the long postStartCommand in the pipeline', () => {
    assert.ok(longStartSeconds, 'seed.json has no longStartSeconds (prepare.ts)');
    const began = writtenTime('/tmp/long-start-began');
    const ended = writtenTime('/tmp/long-start-ended');
    console.log(`    postStartCommand waited ${ended - began} s`);
    assert.ok(ended - began >= longStartSeconds, `postStartCommand ran from ${began} to ${ended}`);
  });

  it('connected once, after the pipeline ended', async () => {
    // The CI job removed the file of postAttachCommand before this run; each attach writes a line with its time.
    await waitFor('the line of postAttachCommand', () => (execIn(user, 'test -s /tmp/attach-count').code === 0 ? true : undefined), 60_000);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const attaches = execIn(user, 'cat /tmp/attach-count').out.split('\n');
    const ended = writtenTime('/tmp/long-start-ended');
    console.log(`    attaches at ${attaches.join(', ')}; postStartCommand ended at ${ended}`);
    assert.strictEqual(attaches.length, 1, 'Dev Containers attached more than once');
    assert.ok(Number(attaches[0]) >= ended, 'Dev Containers attached before the open pipeline ended');
  });

  it('wrote the token of the owner into the container again', () => {
    // The run `account` removed it.
    assert.strictEqual(execIn(user, `test -s ${GITHUB_TOKEN_FILE}`).code, 0, 'The container has no token of the owner');
    assert.strictEqual(execIn(user, `test -s ${GH_HOSTS_FILE}`).code, 0, 'The GitHub CLI of the container is not signed in');
  });
});
