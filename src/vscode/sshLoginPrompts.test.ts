// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The questions of SSH logins in VS Code: the launcher and the helper as `ssh` runs them (SSH_ASKPASS with the
// environment of a login), against the pipe of SshAskpassServer, with fake dialogs.
import { vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../core/ports';
import { SshAskpassServer, type SshLoginDialogs } from './sshLoginPrompts';

const describeUnix = process.platform === 'win32' ? describe.skip : describe;

const HOST_KEY_PROMPT = [
  "The authenticity of host 'build-box (192.0.2.10)' can't be established.",
  'ED25519 key fingerprint is SHA256:Xs1mB2CQ0v6fCWd8nJ2oQ6a1pZ0w7H3bKcV4dE5fG6h.',
  'Are you sure you want to continue connecting (yes/no/[fingerprint])? ',
].join('\n');

/** Fake dialogs that answer from the lists of the test, and record what they were asked. */
function dialogs(answers: { secrets?: Array<string | undefined>; hostKey?: boolean[] } = {}) {
  const asked: string[] = [];
  const fake: SshLoginDialogs = {
    secret: async (host, prompt, again) => {
      asked.push(`secret ${host} ${again ? 'again ' : ''}${prompt}`);
      return answers.secrets?.shift();
    },
    hostKey: async (host, text) => {
      asked.push(`hostKey ${host} ${text.split('\n')[1]}`);
      return answers.hostKey?.shift() ?? false;
    },
    confirm: async (host) => {
      asked.push(`confirm ${host}`);
      return true;
    },
    notice: (host, text) => void asked.push(`notice ${host} ${text}`),
  };
  return { fake, asked };
}

describeUnix('SshAskpassServer', () => {
  let folder: string;
  let server: SshAskpassServer | undefined;
  const lines: string[] = [];
  const logger = { ...silentLogger, info: (line: string) => void lines.push(line), warn: (line: string) => void lines.push(line) };

  beforeEach(() => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-askpass-'));
    lines.length = 0;
  });

  afterEach(() => {
    server?.dispose();
    server = undefined;
    fs.rmSync(folder, { recursive: true, force: true });
  });

  async function prepared(fake: SshLoginDialogs): Promise<SshAskpassServer> {
    server = new SshAskpassServer({ folder: path.join(folder, 'storage', 'askpass'), platform: process.platform, nodePath: process.execPath, base: () => folder, dialogs: fake, logger });
    await server.prepare();
    return server;
  }

  /** Runs SSH_ASKPASS of `env` as `ssh` does: the launcher with the question as its argument. */
  function runAskpass(env: NodeJS.ProcessEnv, prompt: string, hint?: string): Promise<{ code: number | null; stdout: string }> {
    return new Promise((resolve) => {
      const child = spawn(env.SSH_ASKPASS as string, [prompt], { env: { ...env, ...(hint ? { SSH_ASKPASS_PROMPT: hint } : {}) }, stdio: ['ignore', 'pipe', 'ignore'] });
      let stdout = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
      child.on('close', (code) => resolve({ code, stdout }));
    });
  }

  it('writes the helper and its launcher only this user may use, and listens on a private socket', async () => {
    const askpass = await prepared(dialogs().fake);
    const env = askpass.login('build-box')!.env({ PATH: process.env.PATH });
    const launcher = fs.statSync(env.SSH_ASKPASS as string);
    expect(launcher.mode & 0o777).toBe(0o700);
    expect(fs.statSync(env.DEVSPACES_ASKPASS_HELPER as string).mode & 0o777).toBe(0o600);
    const socket = env.DEVSPACES_ASKPASS_ADDRESS as string;
    expect(fs.statSync(path.dirname(socket)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(socket).mode & 0o777).toBe(0o600);
    expect(env).toMatchObject({ SSH_ASKPASS_REQUIRE: 'force', DEVSPACES_ASKPASS_NODE: process.execPath });
    // The socket goes with the server; the files stay for the next window.
    askpass.dispose();
    expect(fs.existsSync(path.dirname(socket))).toBe(false);
    expect(fs.existsSync(env.SSH_ASKPASS as string)).toBe(true);
  });

  it('asks for the password in a dialog, and asks again after an answer that was not accepted', async () => {
    const { fake, asked } = dialogs({ secrets: ['wrong', 'right'] });
    const askpass = await prepared(fake);
    const login = askpass.login('build-box')!;
    const open: boolean[] = [];
    login.onPrompt((value) => open.push(value));
    const env = login.env({ PATH: process.env.PATH });
    expect(await runAskpass(env, "me@build-box's password: ")).toEqual({ code: 0, stdout: 'wrong\n' });
    expect(await runAskpass(env, "me@build-box's password: ")).toEqual({ code: 0, stdout: 'right\n' });
    expect(asked).toEqual(["secret build-box me@build-box's password:", "secret build-box again me@build-box's password:"]);
    expect(open).toEqual([true, false, true, false]);
    expect(login.passwordAsked).toBe(true);
    // No answer in the log.
    expect(lines).toEqual(['The SSH login to build-box asks for a password in VS Code.', 'The SSH login to build-box asks for a password in VS Code.']);
  });

  it('asks for an unknown host key with its fingerprint: yes accepts it, and a refusal asks nothing more', async () => {
    const { fake, asked } = dialogs({ hostKey: [true, false], secrets: ['pw'] });
    const askpass = await prepared(fake);
    const env = askpass.login('build-box')!.env({ PATH: process.env.PATH });
    expect(await runAskpass(env, HOST_KEY_PROMPT)).toEqual({ code: 0, stdout: 'yes\n' });
    expect(await runAskpass(env, "me@build-box's password: ")).toEqual({ code: 0, stdout: 'pw\n' });
    const other = askpass.login('other-box')!.env({ PATH: process.env.PATH });
    expect(await runAskpass(other, HOST_KEY_PROMPT)).toEqual({ code: 0, stdout: 'no\n' });
    expect(await runAskpass(other, "me@other-box's password: ")).toMatchObject({ code: 1 });
    expect(asked).toEqual([
      'hostKey build-box ED25519 key fingerprint is SHA256:Xs1mB2CQ0v6fCWd8nJ2oQ6a1pZ0w7H3bKcV4dE5fG6h.',
      "secret build-box me@build-box's password:",
      'hostKey other-box ED25519 key fingerprint is SHA256:Xs1mB2CQ0v6fCWd8nJ2oQ6a1pZ0w7H3bKcV4dE5fG6h.',
    ]);
    expect(lines).toContain('The SSH login to build-box asks to accept its host key SHA256:Xs1mB2CQ0v6fCWd8nJ2oQ6a1pZ0w7H3bKcV4dE5fG6h in VS Code.');
    expect(lines).toContain('The host key of build-box was accepted; ssh keeps it in known_hosts.');
    expect(lines).toContain('The host key of other-box was not accepted.');
  });

  // ssh asks up to three times; after a cancel, the login asks nothing more and fails.
  it('asks nothing more in a login after a cancel', async () => {
    const { fake, asked } = dialogs({ secrets: [undefined, 'late'] });
    const askpass = await prepared(fake);
    const login = askpass.login('build-box')!;
    const env = login.env({ PATH: process.env.PATH });
    expect(await runAskpass(env, "me@build-box's password: ")).toMatchObject({ code: 1 });
    expect(await runAskpass(env, "me@build-box's password: ")).toMatchObject({ code: 1 });
    expect(asked).toHaveLength(1);
    expect(lines).toContain('The question of the SSH login to build-box was cancelled.');
  });

  it('asks no question of a login that it does not know or that ended', async () => {
    const { fake, asked } = dialogs({ secrets: ['pw'] });
    const askpass = await prepared(fake);
    const login = askpass.login('build-box')!;
    const env = login.env({ PATH: process.env.PATH });
    expect(await runAskpass({ ...env, DEVSPACES_ASKPASS_TOKEN: 'f'.repeat(64) }, 'Password: ')).toMatchObject({ code: 1 });
    login.dispose();
    expect(await runAskpass(env, 'Password: ')).toMatchObject({ code: 1 });
    expect(asked).toEqual([]);
  });

  it('confirms with exit code 0 and shows a notice without an answer', async () => {
    const { fake, asked } = dialogs();
    const askpass = await prepared(fake);
    const env = askpass.login('build-box')!.env({ PATH: process.env.PATH });
    expect(await runAskpass(env, 'Allow use of key ED25519?', 'confirm')).toEqual({ code: 0, stdout: '\n' });
    expect(await runAskpass(env, 'Confirm user presence for key ED25519-SK', 'none')).toEqual({ code: 0, stdout: '\n' });
    expect(asked).toEqual(['confirm build-box', 'notice build-box Confirm user presence for key ED25519-SK']);
  });

  it('gives no login before it listens', () => {
    server = new SshAskpassServer({ folder: path.join(folder, 'askpass'), platform: process.platform, nodePath: process.execPath, base: () => folder, dialogs: dialogs().fake, logger });
    expect(server.login('build-box')).toBeUndefined();
    expect(lines).toEqual(['The SSH login to build-box cannot ask in VS Code: the questions of SSH logins are not ready.']);
  });
});
