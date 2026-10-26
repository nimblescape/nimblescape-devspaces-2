// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

/// <reference types="mocha" />
// Attach tests in the window of a devspace (.vscode-test.mjs, label attach, DEVSPACE_TEST_ATTACH=devspace): VS Code
// starts in the window of a devspace that prepare.ts made without container, as a restored window on a new computer.
// The extension restores the devspace from its volume labels, runs the open pipeline before the window connects, and
// the real Dev Containers extension attaches. The tests check the result from outside the window, with `docker exec`.
// What a test cannot check from here (the window closes when VS Code quits) the CI job checks after the run.
import * as assert from 'assert';
import * as childProcess from 'child_process';
import * as vscode from 'vscode';
import { devContainersSettings } from '../../../src/core/devContainers';
import { VSCODE_STORE_TARGET } from '../../../src/core/names';
import {
  ENABLING_MACHINE_SETTINGS,
  EXTENSION_ID,
  assertOnlyDevspaceCredentials,
  changeMachineSettings,
  channelLog,
  connectedFolder,
  credentialPaths,
  docker,
  execIn,
  printLogs,
  seed,
  serverBinFolder,
  serverDataFolder,
  waitFor,
} from './support';

/** The port of the HTTP server in the container that VS Code forwards. */
const SERVER_PORT = 8123;

describe('the window of a devspace', () => {
  const { containerName, user } = seed();
  let failed = false;

  afterEach(function () {
    if (this.currentTest?.state === 'failed') failed = true;
  });

  after(() => {
    if (failed) printLogs();
  });

  it('connects after the extension restored the devspace and ran its open pipeline', async () => {
    const folder = await connectedFolder();
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension?.isActive, `${EXTENSION_ID} is not active`);
    const log = channelLog('Devspaces');
    assert.match(log, /1 devspaces were restored from the labels of their volumes\./);
    assert.match(log, /The open pipeline of devspaces-test\/attach runs before it connects\./);
    assert.match(log, /devspaces-test\/attach is ready in the container /);
    assert.strictEqual(docker(['inspect', '-f', '{{.State.Status}}', containerName]).trim(), 'running');
    const entries = (await vscode.workspace.fs.readDirectory(folder)).map(([name]) => name);
    assert.ok(entries.includes('.devcontainer'), entries.join(', '));
  });

  it('gives Dev Containers the security settings of the override in the machine settings', () => {
    // devContainersSettings: Dev Containers writes them into the machine settings at the first attach.
    const file = execIn(user, `cat "$HOME/${serverDataFolder()}/data/Machine/settings.json"`);
    assert.strictEqual(file.code, 0, file.out);
    const settings = JSON.parse(file.out) as Record<string, unknown>;
    for (const [key, value] of Object.entries(devContainersSettings())) assert.strictEqual(settings[key], value, `${key} in ${file.out}`);
  });

  it('leaves the container no way to the credentials of the runner through Dev Containers', async () => {
    // The repository sets "remote.containers.copyGitConfig": true (the old key); the override sets both keys.
    const paths = await credentialPaths(user);
    console.log(`    ways from the devspace to the runner: ${JSON.stringify({ ...paths, sshAgentKeys: paths.sshAgentKeys ?? null })}`);
    assert.deepStrictEqual(
      { gitConfigOfRunner: paths.gitConfigOfRunner, gitCredentialHelper: paths.gitCredentialHelper, dockerCredentialHelper: paths.dockerCredentialHelper, githubCli: paths.githubCli },
      { gitConfigOfRunner: false, gitCredentialHelper: false, dockerCredentialHelper: false, githubCli: false },
    );
    // The forwarded SSH agent stays: Dev Containers forwards it into every container and no setting turns this off
    // (docs/security.md, "SSH agent"). Git does not use it (GIT_SSH_COMMAND of the devspace), other programs can. When
    // this fails, the forwarding changed and docs/security.md must say so.
    assert.strictEqual(paths.sshAgentKeys, 1, 'The SSH agent of the runner (one key) is no longer forwarded');
    const sshCommand = execIn(user, 'printf %s "$GIT_SSH_COMMAND"').out;
    assert.strictEqual(sshCommand, 'ssh -o IdentityAgent=none');
  });

  it('gives Git, Docker and the GitHub CLI only the configuration of the devspace', async () => {
    await assertOnlyDevspaceCredentials(user);
  });

  it('uses the shared VS Code server of the store', () => {
    const link = execIn(user, `readlink "$HOME/${serverDataFolder()}/bin/${serverBinFolder()}"`);
    assert.strictEqual(link.code, 0, link.out);
    assert.ok(link.out.startsWith(`${VSCODE_STORE_TARGET}/server/`), link.out);
    const downloads = channelLog('Dev Containers')
      .split('\n')
      .filter((line) => /download/i.test(line) && /server/i.test(line));
    console.log(`    lines of Dev Containers about a server download: ${downloads.length}\n${downloads.join('\n')}`);
  });

  it('runs postAttachCommand once for the attach', async () => {
    // The repository appends a line to /tmp/attach-count at each attach; `devcontainer up` skips it (SKIP_POST_ATTACH_ARG).
    await waitFor('the line of postAttachCommand', () => (execIn(user, 'test -s /tmp/attach-count').code === 0 ? true : undefined), 60_000);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    assert.strictEqual(execIn(user, 'wc -l < /tmp/attach-count').out, '1');
  });

  it('forwards a port of the container on 127.0.0.1 only', async () => {
    // VS Code forwards on all addresses when remote.localPortHost is not `localhost` (LOCAL_PORT_HOST_SETTING).
    docker(['exec', '-d', '-u', user, containerName, 'node', '-e', `require('http').createServer((q, s) => s.end('devspace')).listen(${SERVER_PORT})`]);
    await waitFor('the server in the container', () => (execIn(user, `node -e "require('http').get('http://127.0.0.1:${SERVER_PORT}', () => process.exit(0)).on('error', () => process.exit(1))"`).code === 0 ? true : undefined), 30_000);
    const external = await vscode.env.asExternalUri(vscode.Uri.parse(`http://localhost:${SERVER_PORT}`));
    const port = Number(external.authority.split(':')[1]);
    assert.ok(port > 0, external.toString());
    const response = await fetch(`http://127.0.0.1:${port}`).then((answer) => answer.text());
    assert.strictEqual(response, 'devspace');
    // The listening sockets of the port on the runner: only the loopback address.
    const listening = childProcess.spawnSync('ss', ['-Hltn', `sport = :${port}`], { encoding: 'utf8' }).stdout.trim().split('\n').filter((line) => line !== '');
    console.log(`    forwarded ${external.toString()}:\n${listening.join('\n')}`);
    assert.ok(listening.length > 0, `Nothing listens on port ${port}`);
    for (const line of listening) assert.match(line, /\s(127\.0\.0\.1|\[::1\]):\d+\s/, line);
  });

  // The last test: the next start of VS Code (reattach.test.ts) attaches again with these machine settings.
  it('lets a process in the container switch the features of Dev Containers on in the machine settings', () => {
    const settings = changeMachineSettings(user, ENABLING_MACHINE_SETTINGS);
    for (const [key, value] of Object.entries(ENABLING_MACHINE_SETTINGS)) assert.strictEqual(settings[key], value, key);
  });
});
