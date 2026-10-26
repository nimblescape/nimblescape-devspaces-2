// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Shared parts of the attach tests (.vscode-test.mjs, label attach): the container of this start of VS Code
// (DEVSPACE_TEST_ATTACH_SEED, written by prepare.ts), `docker` on the engine of the current Docker context (in the run
// `remote` the engine of the other computer), the logs of VS Code, and what the container can reach of the credentials
// of the runner.
import * as assert from 'assert';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DOCKER_CONFIG_FOLDER, GH_CONFIG_FOLDER, GITHUB_TOKEN_FILE } from '../../../src/core/names';

export const EXTENSION_ID = 'nimblescape.nimblescape-devspaces-2';

/** The container of this start of VS Code (prepare.ts). */
export interface Seed {
  containerName: string;
  /** The folder of the window in the container. */
  folder: string;
  folderUri: string;
  /** The user of the window in the container. */
  user: string;
  /** The devspace only: the wait of its postStartCommand when the mark exists (prepare.ts, the run `longopen`). */
  longStartSeconds?: number;
  longStartMark?: string;
  /** The run `remote` only: the Docker context of the other computer (in the folder URI) and its host of the SSH config. */
  dockerContext?: string;
  remoteHost?: string;
  /** A devspace only: its ID (the label nimblescape.devspaces.id of its volume). */
  devspaceId?: string;
  /**
   * The runs `previous` and `updated` only: the last released version of the extension that prepare.ts installed from
   * its GitHub release, and the SHA-256 of its dist/extension.js.
   */
  previous?: { version: string; extensionSha256: string };
}

export function seed(): Seed {
  const value = process.env.DEVSPACE_TEST_ATTACH_SEED;
  assert.ok(value, 'DEVSPACE_TEST_ATTACH_SEED is not set (.vscode-test.mjs)');
  return JSON.parse(value) as Seed;
}

/** The folder of the window once VS Code has connected it (the tests start after the connection). */
export async function connectedFolder(): Promise<vscode.Uri> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert.ok(folder, 'The window has no folder');
  assert.strictEqual(folder.toString(), vscode.Uri.parse(seed().folderUri).toString());
  assert.strictEqual(vscode.env.remoteName, 'attached-container');
  await vscode.workspace.fs.stat(folder);
  return folder;
}

/** `docker` on the engine of the current Docker context (or of a `--context` in `args`); fails when it fails. */
export function docker(args: string[]): string {
  const result = childProcess.spawnSync('docker', args, { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `docker ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

/** A shell script in the container as `user`, with the environment of the container; `code` and output. */
export function execIn(user: string, script: string): { code: number | null; out: string } {
  const result = childProcess.spawnSync('docker', ['exec', '-u', user, seed().containerName, 'sh', '-c', script], { encoding: 'utf8' });
  return { code: result.status, out: `${result.stdout}${result.stderr}`.trim() };
}

/**
 * A shell script in the container as `user`, with the environment of the container and `args` as $1…; asynchronous,
 * for programs that may reach a channel of Dev Containers, which the extension host of the tests relays.
 */
export function execInAsync(user: string, script: string, args: string[] = []): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = childProcess.spawn('docker', ['exec', '-u', user, seed().containerName, 'sh', '-c', script, 'sh', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (data: Buffer) => (out += data.toString()));
    child.stderr.on('data', (data: Buffer) => (out += data.toString()));
    child.on('error', (error) => resolve({ code: null, out: String(error) }));
    child.on('close', (code) => resolve({ code, out: out.trim() }));
  });
}

/** Waits until `check` returns a value other than undefined; fails with `what` after `timeoutMs`. */
export async function waitFor<T>(what: string, check: () => T | undefined, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) assert.fail(`${what}: not after ${timeoutMs / 1000} s`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/** product.json of the VS Code that runs the tests. */
function product(): { commit: string; quality?: string } {
  return JSON.parse(fs.readFileSync(path.join(vscode.env.appRoot, 'product.json'), 'utf8')) as { commit: string; quality?: string };
}

/**
 * The folder of the VS Code server of the test VS Code in `bin` of the server data folder (serverDataFolder), as Dev
 * Containers names it: the commit of the test VS Code, with `-insider` for VS Code Insiders.
 */
export function serverBinFolder(): string {
  const { commit, quality } = product();
  return quality === 'insider' ? `${commit}-insider` : commit;
}

/**
 * The folder of the VS Code server in the home folder of a container: `.vscode-server`, and `.vscode-server-insiders`
 * for VS Code Insiders (the quality `insider`, as src/core/worker/vscodeServerLink.ts decides).
 */
export function serverDataFolder(): string {
  return product().quality === 'insider' ? '.vscode-server-insiders' : '.vscode-server';
}

/**
 * The ways from the container to the credentials of the runner after the attach, as the user of the window sees them:
 * the Git configuration of the runner (its marker, set by CI), a Git credential helper of Dev Containers, the Docker
 * credential helper of Dev Containers, a GitHub CLI sign-in in the default folder of gh, and the forwarded SSH agent
 * (with the number of keys it offers). The test of the plain container checks that the checks see what Dev Containers
 * sets up.
 */
export interface CredentialPaths {
  gitConfigOfRunner: boolean;
  gitCredentialHelper: boolean;
  dockerCredentialHelper: boolean;
  githubCli: boolean;
  /** The number of keys that the forwarded SSH agent offers, or undefined when no agent answers in the container. */
  sshAgentKeys: number | undefined;
}

/** Marker in the Git configuration of the runner (CI: `git config --global devspacestest.marker …`). */
export const RUNNER_GIT_MARKER = 'devspaces-runner-git-configuration';

/**
 * Asks the SSH agent at the socket $SOCKET for its keys (SSH_AGENTC_REQUEST_IDENTITIES, answer
 * SSH_AGENT_IDENTITIES_ANSWER) and prints their number, or -1.
 */
const SSH_AGENT_KEYS = `const end = (keys) => { console.log(keys); process.exit(0); };
const s = require('net').connect(process.env.SOCKET);
let b = Buffer.alloc(0);
s.on('connect', () => s.write(Buffer.from([0, 0, 0, 1, 11])));
s.on('data', (d) => {
  b = Buffer.concat([b, d]);
  if (b.length >= 9 && b.length >= 4 + b.readUInt32BE(0)) end(b[4] === 12 ? b.readUInt32BE(5) : -1);
});
s.on('error', () => end(-1));
setTimeout(() => end(-1), 5000);
`;

/**
 * Node.js in the container as `user` with `script` on its standard input and the variables `env`. Asynchronous: Dev
 * Containers relays the forwarded SSH agent through this extension host, which a synchronous call would block.
 */
function nodeIn(user: string, script: string, env: Record<string, string>): Promise<string> {
  const variables = Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  return new Promise((resolve) => {
    const child = childProcess.spawn('docker', ['exec', '-i', '-u', user, ...variables, seed().containerName, 'node', '-'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (data: Buffer) => (out += data.toString()));
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(out.trim()));
    child.stdin.end(script);
  });
}

export async function credentialPaths(user: string): Promise<CredentialPaths> {
  const home = execIn(user, 'printf %s "$HOME"').out;
  const files = `/etc/gitconfig "${home}/.gitconfig" "\${GIT_CONFIG_GLOBAL:-/nonexistent}"`;
  const gitConfigOfRunner = execIn(user, `cat ${files} 2>/dev/null | grep -q ${RUNNER_GIT_MARKER}`).code === 0;
  // Dev Containers configures `credential.helper` with a script of its own server folder.
  const gitCredentialHelper = execIn(user, `cat ${files} 2>/dev/null | grep -i 'helper' | grep -qi 'vscode\\|remote-containers'`).code === 0;
  const dockerCredentialHelper =
    execIn(user, `ls /usr/local/bin/docker-credential-dev-containers-* >/dev/null 2>&1 || grep -qs 'dev-containers' "${home}/.docker/config.json" "\${DOCKER_CONFIG:-/nonexistent}/config.json"`).code === 0;
  // The default folder of gh; the folder of a devspace (GH_CONFIG_DIR) holds the sign-in of the devspace itself.
  const githubCli = execIn(user, `test -s "${home}/.config/gh/hosts.yml"`).code === 0;
  // The forwarded SSH agent: the sockets that the processes of Dev Containers in the container name in SSH_AUTH_SOCK.
  const sockets = new Set(
    execIn('root', `cat /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n' | sed -n 's/^SSH_AUTH_SOCK=//p'; ls /tmp/vscode-ssh-auth-*.sock 2>/dev/null`)
      .out.split('\n')
      .filter((line) => line.startsWith('/')),
  );
  let sshAgentKeys: number | undefined;
  for (const socket of sockets) {
    const exists = execIn('root', `test -S '${socket}'`).code === 0;
    const answer = exists ? Number.parseInt(await nodeIn('root', SSH_AGENT_KEYS, { SOCKET: socket }), 10) : -1;
    const keys = Number.isNaN(answer) ? -1 : answer;
    console.log(`    SSH_AUTH_SOCK ${socket}: ${exists ? `a socket, ${keys < 0 ? 'no answer' : `${keys} keys`}` : 'no socket'}`);
    if (keys >= 0) sshAgentKeys = Math.max(sshAgentKeys ?? 0, keys);
  }
  return { gitConfigOfRunner, gitCredentialHelper, dockerCredentialHelper, githubCli, sshAgentKeys };
}

/**
 * The log files of the last start of VS Code with the user data folder `userDataDir` (default: the one of the test VS
 * Code) by their path in the folder of that start, for example `window1/renderer.log`.
 */
export function sessionLogs(userDataDir = process.env.DEVSPACE_TEST_USER_DATA_DIR): Map<string, string> {
  assert.ok(userDataDir, 'DEVSPACE_TEST_USER_DATA_DIR is not set (.vscode-test.mjs)');
  const logs = path.join(userDataDir, 'logs');
  const sessions = fs.existsSync(logs) ? fs.readdirSync(logs).filter((name) => /^\d{8}T\d{6}$/.test(name)).sort() : [];
  const folder = path.join(logs, sessions.at(-1) ?? '');
  const files = new Map<string, string>();
  if (sessions.length === 0 || !fs.existsSync(folder)) return files;
  for (const name of fs.readdirSync(folder, { recursive: true, encoding: 'utf8' })) {
    if (name.endsWith('.log')) files.set(name, fs.readFileSync(path.join(folder, name), 'utf8'));
  }
  return files;
}

/** The files of the output channels of the last start of VS Code (output_logging_* of each window) by name. */
export function outputLogs(userDataDir?: string): Map<string, string> {
  return new Map([...sessionLogs(userDataDir)].filter(([name]) => /output_logging_/.test(name)));
}

/** The log of one output channel (`Devspaces`, `Dev Containers`), empty when it has none. */
export function channelLog(channel: string, userDataDir?: string): string {
  return [...outputLogs(userDataDir)].filter(([name]) => path.basename(name).endsWith(`-${channel}.log`)).map(([, text]) => text).join('\n');
}

/**
 * Prints `text` in parts: the extension host of the tests omits a longer console line ("Output omitted for a large
 * object that exceeds the limits", seen in PR #18).
 */
export function printLong(text: string): void {
  for (let start = 0; start < text.length; start += 20_000) console.log(text.slice(start, start + 20_000));
}

/** Prints every output channel of the last start of VS Code; the evidence of a failed test on CI. */
export function printLogs(userDataDir?: string): void {
  for (const [name, text] of outputLogs(userDataDir)) printLong(`\n===== ${name} =====\n${text}`);
}

/**
 * The settings of Dev Containers that the override switches off (devContainersSettings), switched on again, as a process
 * in the container can write them into the machine settings of the VS Code server (data/Machine/settings.json in
 * serverDataFolder).
 */
export const ENABLING_MACHINE_SETTINGS: Record<string, boolean | string> = {
  'dev.containers.copyGitConfig': true,
  'remote.containers.copyGitConfig': true,
  'dev.containers.gitCredentialHelperConfigLocation': 'global',
  'dev.containers.dockerCredentialHelper': true,
  'dev.containers.githubCLILoginWithToken': true,
};

/**
 * What Git, Docker and the GitHub CLI of the container use, with the environment of the container (containerEnv, as in
 * the terminals of the window): which credential helpers Git runs for https://github.com and for another host, whether
 * Git reads the Git configuration of the runner, the configuration file of Docker and whether it names a helper of Dev
 * Containers, the variables with a GitHub token in the processes of the container, and GH_CONFIG_DIR.
 */
export interface EffectiveCredentials {
  /** The helpers (as Git runs them) that `git credential fill` asks for https://github.com. */
  githubHelpers: string[];
  /** The helpers that `git credential fill` asks for https://git.example.invalid. */
  otherHostHelpers: string[];
  runnerGitConfig: boolean;
  dockerConfigFile: string;
  dockerHelperOfDevContainers: boolean;
  tokenVariables: string[];
  ghConfigDir: string;
}

/** The helpers that `git credential fill` runs for https://$1 (GIT_TRACE), without a prompt. */
const CREDENTIAL_HELPERS_SCRIPT = `printf 'protocol=https\nhost=%s\n\n' "$1" | GIT_TRACE=1 GIT_TERMINAL_PROMPT=0 timeout 20 git credential fill 2>&1 >/dev/null | sed -n 's/.*trace: run_command: //p'`;

export async function effectiveCredentials(user: string): Promise<EffectiveCredentials> {
  const helpers = async (host: string): Promise<string[]> =>
    (await execInAsync(user, CREDENTIAL_HELPERS_SCRIPT, [host])).out.split('\n').filter((line) => line !== '');
  const githubHelpers = await helpers('github.com');
  const otherHostHelpers = await helpers('git.example.invalid');
  const runnerGitConfig = execIn(user, 'git config --get devspacestest.marker').code === 0;
  const dockerConfigFile = execIn(user, 'printf %s "${DOCKER_CONFIG:-$HOME/.docker}/config.json"').out;
  const dockerHelperOfDevContainers = execIn(user, `grep -qs 'dev-containers' '${dockerConfigFile}'`).code === 0;
  const tokenVariables = [
    ...new Set(
      execIn('root', `cat /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n' | sed -n 's/^\\(GH_TOKEN\\|GITHUB_TOKEN\\|GH_ENTERPRISE_TOKEN\\)=.*/\\1/p'`)
        .out.split('\n')
        .filter((line) => line !== ''),
    ),
  ];
  const ghConfigDir = execIn(user, 'printf %s "$GH_CONFIG_DIR"').out;
  return { githubHelpers, otherHostHelpers, runnerGitConfig, dockerConfigFile, dockerHelperOfDevContainers, tokenVariables, ghConfigDir };
}

/** A credential helper of Dev Containers (it forwards the request to the computer of the window). */
export const FORWARDING_HELPER = /vscode|remote-containers|dev-containers/i;

/** Merges `settings` into the machine settings of the VS Code server in the container, as `user`; returns the result. */
export function changeMachineSettings(user: string, settings: Record<string, unknown>): Record<string, unknown> {
  const script = `const fs = require('fs');
const file = require('path').join(require('os').homedir(), process.env.SERVER_DATA_FOLDER, 'data/Machine/settings.json');
const settings = Object.assign(JSON.parse(fs.readFileSync(file, 'utf8')), JSON.parse(process.env.SETTINGS));
fs.writeFileSync(file, JSON.stringify(settings, null, 2));
console.log(JSON.stringify(settings));
`;
  const result = childProcess.spawnSync('docker', ['exec', '-i', '-u', user, '-e', `SETTINGS=${JSON.stringify(settings)}`, '-e', `SERVER_DATA_FOLDER=${serverDataFolder()}`, seed().containerName, 'node', '-'], { encoding: 'utf8', input: script });
  assert.strictEqual(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

/**
 * Git asks only the credential helper of the devspace, and only for https://github.com; Git reads no configuration of the
 * runner; Docker reads the configuration of the volume without a helper of Dev Containers; no process has a GitHub
 * token in its variables; gh reads the folder of the devspace (src/core/helper/containerGit.ts, containerEnvironment).
 */
export async function assertOnlyDevspaceCredentials(user: string): Promise<void> {
  const effective = await effectiveCredentials(user);
  console.log(`    what the devspace uses: ${JSON.stringify(effective)}`);
  assert.ok(effective.githubHelpers.length > 0, 'Git asked no credential helper for https://github.com');
  for (const helper of effective.githubHelpers) assert.ok(helper.includes(GITHUB_TOKEN_FILE), `Git asked another helper for https://github.com: ${helper}`);
  assert.deepStrictEqual(effective.otherHostHelpers, [], 'Git asked a credential helper for another host');
  assert.strictEqual(effective.runnerGitConfig, false, 'Git reads the Git configuration of the runner');
  assert.strictEqual(effective.dockerConfigFile, `${DOCKER_CONFIG_FOLDER}/config.json`);
  assert.strictEqual(effective.dockerHelperOfDevContainers, false, 'Docker uses a credential helper of Dev Containers');
  assert.deepStrictEqual(effective.tokenVariables, []);
  assert.strictEqual(effective.ghConfigDir, GH_CONFIG_FOLDER);
}
