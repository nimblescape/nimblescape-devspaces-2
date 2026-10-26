// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

/// <reference types="mocha" />
// Attach tests after a restart of VS Code (.vscode-test.mjs, label attach, DEVSPACE_TEST_ATTACH=reattach): VS Code
// starts again with the user data folder of the devspace run (devspace.test.ts), so the window of the devspace is
// restored with the registry of the first start, and Dev Containers attaches a second time to the container that kept
// running. The last test of the first start switched the features of Dev Containers on again in the machine settings of
// the container, as any process in the container can. Assumption (src/core/devContainers.ts, devContainersSettings):
// Dev Containers reads these settings at each attach; the variables of the devspace keep Git, Docker and gh on the
// configuration of the devspace also then.
import * as assert from 'assert';
import { GH_HOSTS_FILE, GITHUB_TOKEN_FILE } from '../../../src/core/names';
import { ENABLING_MACHINE_SETTINGS, assertOnlyDevspaceCredentials, channelLog, connectedFolder, credentialPaths, docker, execIn, printLogs, seed, serverDataFolder, waitFor } from './support';

describe('the window of the devspace after a restart of VS Code', () => {
  const { containerName, user } = seed();
  let failed = false;

  afterEach(function () {
    if (this.currentTest?.state === 'failed') failed = true;
  });

  after(() => {
    if (failed) printLogs();
  });

  it('connects again, with or without a new run of the open pipeline', async () => {
    await connectedFolder();
    const log = channelLog('Devspaces');
    // The open of the first start wrote the pending connection file at its end; the first status write of a window
    // after that (every 15 seconds) removes it. When VS Code quit before that write, this start finds the file younger
    // than PENDING_MAX_AGE_MS and does not run the pipeline again (src/vscode/activationRules.ts, pipelineJustRan).
    const decision = log.match(/The open pipeline of devspaces-test\/attach (has just run for this window|runs before it connects)\./);
    assert.ok(decision, 'The extension did not decide about the open pipeline of the restored window');
    console.log(`    open pipeline at this start: ${decision[1]}`);
    if (decision[1] === 'runs before it connects') assert.match(log, /devspaces-test\/attach is ready in the container /);
    const restored = log.match(/\d+ devspaces were restored from the labels of their volumes\./g) ?? [];
    console.log(`    restores from the volume labels at this start: ${restored.join(' ') || 'none'}`);
    assert.strictEqual(docker(['inspect', '-f', '{{.State.Status}}', containerName]).trim(), 'running');
  });

  it('runs postAttachCommand once more in the same container', async () => {
    // The first start wrote one line into /tmp/attach-count of this container; a new container would start without it.
    await waitFor('the second line of postAttachCommand', () => (execIn(user, 'wc -l < /tmp/attach-count').out === '2' ? true : undefined), 60_000);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    assert.strictEqual(execIn(user, 'wc -l < /tmp/attach-count').out, '2');
  });

  it('attaches with the machine settings that the process in the container changed', async () => {
    const file = execIn(user, `cat "$HOME/${serverDataFolder()}/data/Machine/settings.json"`);
    assert.strictEqual(file.code, 0, file.out);
    const settings = JSON.parse(file.out) as Record<string, unknown>;
    const kept = Object.entries(ENABLING_MACHINE_SETTINGS).filter(([key, value]) => settings[key] === value);
    console.log(`    machine settings after the second attach: ${file.out}`);
    // What Dev Containers set up from them: the control that the next test checks a real change.
    const paths = await credentialPaths(user);
    console.log(`    ways from the devspace to the runner after the second attach: ${JSON.stringify({ ...paths, sshAgentKeys: paths.sshAgentKeys ?? null })}`);
    assert.ok(kept.length > 0, 'Dev Containers replaced the changed machine settings at the second attach (update the assumption of devContainersSettings)');
    assert.ok(
      paths.gitConfigOfRunner || paths.gitCredentialHelper || paths.dockerCredentialHelper || paths.githubCli,
      'Dev Containers set up none of its features from the changed machine settings (assumption of devContainersSettings)',
    );
  });

  it('still gives Git, Docker and the GitHub CLI only the configuration of the devspace', async () => {
    await assertOnlyDevspaceCredentials(user);
  });

  it('keeps the token of the owner in the memory of the container', () => {
    // The next run (account.test.ts) checks that the token leaves the container; this shows that it was there.
    assert.strictEqual(execIn(user, `test -s ${GITHUB_TOKEN_FILE}`).code, 0, 'The container has no token of the owner');
    assert.strictEqual(execIn(user, `test -s ${GH_HOSTS_FILE}`).code, 0, 'The GitHub CLI of the container is not signed in');
  });
});
