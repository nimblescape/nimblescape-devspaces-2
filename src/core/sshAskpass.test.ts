// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The questions of an SSH login in VS Code: the launcher and the environment of `ssh`, the protocol of the helper (also
// the real helper against a pipe), the kinds of the questions, and the scope of the flows of the user.
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ASKPASS_DISPLAY,
  ASKPASS_HELPER_SOURCE,
  askpassAnswerLine,
  askpassEnv,
  askpassLauncher,
  askpassProgram,
  currentSshPromptFlow,
  hostKeyFingerprint,
  isPasswordPrompt,
  parseAskpassRequest,
  sshPromptKind,
  sshPromptSignal,
  sshPromptsAllowed,
  withSshPrompts,
  type AskpassRequest,
} from './sshAskpass';

const describeUnix = process.platform === 'win32' ? describe.skip : describe;

const FILES = { launcher: '/storage/askpass/askpass.sh', helper: '/storage/askpass/askpass.js', node: '/opt/code/code', address: '/run/user/1000/devspaces-0123456789abcdef/askpass' };

const HOST_KEY_PROMPT = [
  "The authenticity of host 'build-box (192.0.2.10)' can't be established.",
  'ED25519 key fingerprint is SHA256:Xs1mB2CQ0v6fCWd8nJ2oQ6a1pZ0w7H3bKcV4dE5fG6h.',
  'This key is not known by any other names.',
  'Are you sure you want to continue connecting (yes/no/[fingerprint])? ',
].join('\n');

describe('the launcher and the environment of ssh', () => {
  it('names the helper and its program by variables, so its text holds no path', () => {
    const unix = askpassLauncher();
    expect(unix.fileName).toBe('askpass.sh');
    expect(unix.text).toBe('#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "$DEVSPACES_ASKPASS_NODE" "$DEVSPACES_ASKPASS_HELPER" "$@"\n');
  });

  // No batch file on Windows: cmd.exe would read the question of the host as a command line.
  it('runs the helper on Windows without a launcher, as one command that Win32-OpenSSH starts as it is', () => {
    expect(askpassProgram(FILES)).toBe(FILES.launcher);
    const windows = { helper: 'C:\\Users\\Jo Doe\\storage\\askpass.js', node: 'C:\\Program Files\\Microsoft VS Code\\Code.exe', address: '\\\\.\\pipe\\devspaces-askpass-0123' };
    expect(askpassProgram(windows)).toBe('"C:\\Program Files\\Microsoft VS Code\\Code.exe" "C:\\Users\\Jo Doe\\storage\\askpass.js"');
    expect(askpassEnv({ Path: 'C:\\Windows' }, windows, 't', 'win32')).toEqual({
      Path: 'C:\\Windows',
      SSH_ASKPASS: '"C:\\Program Files\\Microsoft VS Code\\Code.exe" "C:\\Users\\Jo Doe\\storage\\askpass.js"',
      SSH_ASKPASS_REQUIRE: 'force',
      ELECTRON_RUN_AS_NODE: '1',
      DISPLAY: ASKPASS_DISPLAY,
      DEVSPACES_ASKPASS_ADDRESS: windows.address,
      DEVSPACES_ASKPASS_TOKEN: 't',
      DEVSPACES_ASKPASS_NODE: windows.node,
      DEVSPACES_ASKPASS_HELPER: windows.helper,
    });
  });

  it('sets SSH_ASKPASS with force, the pipe and the token, and DISPLAY only when it is not set', () => {
    const env = askpassEnv({ PATH: '/usr/bin', SSH_ASKPASS_REQUIRE: 'never', SSH_ASKPASS: '/usr/lib/ssh/x11-ssh-askpass' }, FILES, 'token-1', 'linux');
    expect(env).toEqual({
      PATH: '/usr/bin',
      SSH_ASKPASS: FILES.launcher,
      SSH_ASKPASS_REQUIRE: 'force',
      DISPLAY: ASKPASS_DISPLAY,
      DEVSPACES_ASKPASS_ADDRESS: FILES.address,
      DEVSPACES_ASKPASS_TOKEN: 'token-1',
      DEVSPACES_ASKPASS_NODE: FILES.node,
      DEVSPACES_ASKPASS_HELPER: FILES.helper,
    });
    expect(askpassEnv({ DISPLAY: ':1' }, FILES, 't', 'linux').DISPLAY).toBe(':1');
    // An empty DISPLAY counts as not set.
    expect(askpassEnv({ DISPLAY: '' }, FILES, 't', 'linux').DISPLAY).toBe(ASKPASS_DISPLAY);
  });

  it('replaces the variables of another case on Windows, and keeps a DISPLAY of any case', () => {
    const env = askpassEnv({ Path: 'C:\\Windows', Ssh_Askpass_Require: 'never', display: 'x:0' }, { helper: 'C:\\askpass.js', node: 'C:\\Code.exe', address: 'p' }, 't', 'win32');
    expect(env).toMatchObject({ Path: 'C:\\Windows', SSH_ASKPASS: '"C:\\Code.exe" "C:\\askpass.js"', SSH_ASKPASS_REQUIRE: 'force', display: 'x:0' });
    expect(env.Ssh_Askpass_Require).toBeUndefined();
    expect(env.DISPLAY).toBeUndefined();
  });
});

describe('the protocol of the helper', () => {
  it('reads a question line and refuses everything else', () => {
    expect(parseAskpassRequest('{"token":"t","prompt":"me@box\'s password: ","hint":""}')).toEqual({ token: 't', prompt: "me@box's password: ", hint: '' });
    for (const line of ['', 'not json', 'null', '[]', '{"token":"t","prompt":"p"}', '{"token":1,"prompt":"p","hint":""}']) {
      expect(parseAskpassRequest(line)).toBeUndefined();
    }
  });

  it('answers with a value or with a cancel, as one line', () => {
    expect(askpassAnswerLine('se"cret')).toBe('{"value":"se\\"cret"}\n');
    expect(askpassAnswerLine(undefined)).toBe('{"cancel":true}\n');
  });

  it('knows the kinds of the questions of ssh', () => {
    expect(sshPromptKind({ prompt: HOST_KEY_PROMPT, hint: '' })).toBe('hostKey');
    expect(sshPromptKind({ prompt: "me@box's password: ", hint: '' })).toBe('secret');
    expect(sshPromptKind({ prompt: "Enter passphrase for key '/home/me/.ssh/id_ed25519': ", hint: '' })).toBe('secret');
    expect(sshPromptKind({ prompt: 'Allow use of key ED25519?', hint: 'confirm' })).toBe('confirm');
    expect(sshPromptKind({ prompt: 'Confirm user presence for key ED25519-SK', hint: 'none' })).toBe('notice');
    expect(isPasswordPrompt("me@box's password: ")).toBe(true);
    expect(isPasswordPrompt('(me@box) Password: ')).toBe(true);
    expect(isPasswordPrompt("Enter passphrase for key '/home/me/.ssh/id_ed25519': ")).toBe(false);
    expect(isPasswordPrompt('Verification code: ')).toBe(false);
    expect(hostKeyFingerprint(HOST_KEY_PROMPT)).toBe('SHA256:Xs1mB2CQ0v6fCWd8nJ2oQ6a1pZ0w7H3bKcV4dE5fG6h');
    expect(hostKeyFingerprint("me@box's password: ")).toBeUndefined();
  });
});

describe('the flows of the user', () => {
  it('lets the logins of a flow ask, and no login outside of it or after it', async () => {
    expect(sshPromptsAllowed()).toBe(false);
    expect(sshPromptSignal()).toBeUndefined();
    let later: Promise<boolean> | undefined;
    const inside = await withSshPrompts(async () => {
      await Promise.resolve();
      // A timer that the flow starts runs after its end.
      later = new Promise((resolve) => setTimeout(() => resolve(sshPromptsAllowed()), 20));
      return sshPromptsAllowed();
    });
    expect(inside).toBe(true);
    expect(await later).toBe(false);
    expect(sshPromptsAllowed()).toBe(false);
  });

  it('gives the logins of a flow its signal while it runs', async () => {
    const cancel = new AbortController();
    let later: Promise<AbortSignal | undefined> | undefined;
    const inside = await withSshPrompts(async () => {
      later = new Promise((resolve) => setTimeout(() => resolve(sshPromptSignal()), 20));
      return sshPromptSignal();
    }, cancel.signal);
    expect(inside).toBe(cancel.signal);
    expect(await later).toBeUndefined();
    expect(await withSshPrompts(async () => sshPromptSignal())).toBeUndefined();
  });

  // For example a progress notification within an operation: the Cancel of the operation closes its questions too.
  it('gives a flow within a flow its own name, and closes its questions on the Cancel of either', async () => {
    const outerCancel = new AbortController();
    const innerCancel = new AbortController();
    const [outer, inner, before, after] = await withSshPrompts(async () => {
      const outerFlow = currentSshPromptFlow();
      return withSshPrompts(async () => {
        const signal = sshPromptSignal();
        const aborted = signal?.aborted;
        outerCancel.abort();
        return [outerFlow, currentSshPromptFlow(), aborted, signal?.aborted] as const;
      }, innerCancel.signal);
    }, outerCancel.signal);
    expect(outer).toBeDefined();
    expect(inner).toBeDefined();
    expect(inner).not.toBe(outer);
    expect([before, after]).toEqual([false, true]);
    // Without a signal of its own, the flow within takes the signal of the outer flow.
    const own = new AbortController();
    expect(await withSshPrompts(async () => withSshPrompts(async () => sshPromptSignal()), own.signal)).toBe(own.signal);
    expect(currentSshPromptFlow()).toBeUndefined();
  });
});

describeUnix('the helper', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-askpass-test-'));
  const helper = path.join(folder, 'askpass.js');
  fs.writeFileSync(helper, ASKPASS_HELPER_SOURCE);
  afterAll(() => fs.rmSync(folder, { recursive: true, force: true }));

  /** A pipe that answers each question with `answer`, and the questions it got. */
  async function pipe(answer: (request: AskpassRequest | undefined) => string): Promise<{ address: string; requests: Array<AskpassRequest | undefined>; close(): void }> {
    const address = path.join(folder, `pipe-${Math.random().toString(16).slice(2)}`);
    const requests: Array<AskpassRequest | undefined> = [];
    const server = net.createServer((socket) => {
      let data = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        data += chunk;
        const end = data.indexOf('\n');
        if (end < 0) return;
        const request = parseAskpassRequest(data.slice(0, end));
        requests.push(request);
        socket.end(answer(request));
      });
    });
    await new Promise<void>((resolve) => server.listen(address, resolve));
    return { address, requests, close: () => server.close() };
  }

  function runHelper(env: NodeJS.ProcessEnv, prompt: string): Promise<{ code: number | null; stdout: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [helper, prompt], { env, stdio: ['ignore', 'pipe', 'ignore'] });
      let stdout = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
      child.on('close', (code) => resolve({ code, stdout }));
    });
  }

  it('prints the answer of the pipe to the question of ssh, with the token and the hint', async () => {
    const server = await pipe(() => askpassAnswerLine('s3cret pass'));
    const result = await runHelper({ DEVSPACES_ASKPASS_ADDRESS: server.address, DEVSPACES_ASKPASS_TOKEN: 'token-1', SSH_ASKPASS_PROMPT: 'confirm' }, "me@box's password: ");
    server.close();
    expect(result).toEqual({ code: 0, stdout: 's3cret pass\n' });
    expect(server.requests).toEqual([{ token: 'token-1', prompt: "me@box's password: ", hint: 'confirm' }]);
  });

  it('ends with exit code 1 for a cancel, a broken answer, no pipe, and no token', async () => {
    const cancel = await pipe(() => askpassAnswerLine(undefined));
    expect((await runHelper({ DEVSPACES_ASKPASS_ADDRESS: cancel.address, DEVSPACES_ASKPASS_TOKEN: 't' }, 'Password: ')).code).toBe(1);
    cancel.close();
    const broken = await pipe(() => 'no json\n');
    expect((await runHelper({ DEVSPACES_ASKPASS_ADDRESS: broken.address, DEVSPACES_ASKPASS_TOKEN: 't' }, 'Password: ')).code).toBe(1);
    broken.close();
    const closed = await pipe(() => '');
    expect((await runHelper({ DEVSPACES_ASKPASS_ADDRESS: closed.address, DEVSPACES_ASKPASS_TOKEN: 't' }, 'Password: ')).code).toBe(1);
    closed.close();
    expect((await runHelper({ DEVSPACES_ASKPASS_ADDRESS: path.join(folder, 'none'), DEVSPACES_ASKPASS_TOKEN: 't' }, 'Password: ')).code).toBe(1);
    expect((await runHelper({ DEVSPACES_ASKPASS_ADDRESS: path.join(folder, 'none') }, 'Password: ')).code).toBe(1);
  });
});
