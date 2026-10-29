// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The questions of an SSH login in VS Code (docs/architecture.md "Login without setup"). The `ssh` of the system asks
// for a password, the passphrase of a key, a one-time code, or whether to accept an unknown host key through the
// program in SSH_ASKPASS (with SSH_ASKPASS_REQUIRE=force; older versions without it need DISPLAY and no terminal). That
// program runs ASKPASS_HELPER_SOURCE with the Node.js of VS Code (askpassProgram): on Linux and macOS through a small
// launcher of Devspaces (askpassLauncher), on Windows directly. The helper sends the question over a local pipe of the
// extension host, with the token of its login, and prints the answer. Only a login that a flow of the user starts may
// ask (withSshPrompts); every other login runs with BatchMode=yes and asks nothing. Pure parts and the scope of the
// flows; the pipe and the dialogs are in src/vscode/sshLoginPrompts.ts. No `vscode`.
import { AsyncLocalStorage } from 'async_hooks';

/** The address of the pipe of the extension host that answers the helper. */
export const ASKPASS_ADDRESS_ENV = 'DEVSPACES_ASKPASS_ADDRESS';
/** The token of the login: the pipe answers only a question with the token of a login that it knows. */
export const ASKPASS_TOKEN_ENV = 'DEVSPACES_ASKPASS_TOKEN';
/** The program that runs the helper: the executable of VS Code, as Node.js (ELECTRON_RUN_AS_NODE, set by the launcher). */
export const ASKPASS_NODE_ENV = 'DEVSPACES_ASKPASS_NODE';
/** The file of the helper (ASKPASS_HELPER_SOURCE). */
export const ASKPASS_HELPER_ENV = 'DEVSPACES_ASKPASS_HELPER';
/**
 * DISPLAY for an `ssh` older than OpenSSH 8.4 (also the 8.1 of Windows 10), which uses SSH_ASKPASS only when DISPLAY is
 * set; only when it is not set. A login that may ask forwards no X11 (sshCommandArgs), so `ssh` never connects to it.
 */
export const ASKPASS_DISPLAY = 'devspaces:0';
/** The longest line of a question or an answer on the pipe, in characters. */
export const MAX_ASKPASS_LINE = 64 * 1024;

/**
 * The helper that SSH_ASKPASS runs (through the launcher), for Node.js 18 and later: it sends one line
 * `{"token","prompt","hint"}` to the pipe and prints the `value` of the answer line, or ends with exit code 1 (`ssh`
 * then takes the question as cancelled). `hint` is SSH_ASKPASS_PROMPT of `ssh` (`confirm`, `none`, or empty). Plain
 * JavaScript, written to the storage of the extension as it is.
 */
export const ASKPASS_HELPER_SOURCE = `'use strict';
// The SSH_ASKPASS helper of nimblescape Devspaces: asks the question of ssh in VS Code.
const net = require('net');
const address = process.env.${ASKPASS_ADDRESS_ENV};
const token = process.env.${ASKPASS_TOKEN_ENV};
if (!address || !token) process.exit(1);
const request = JSON.stringify({ token, prompt: process.argv[2] || '', hint: process.env.SSH_ASKPASS_PROMPT || '' });
const socket = net.connect(address);
let data = '';
const fail = () => process.exit(1);
socket.setEncoding('utf8');
socket.on('connect', () => socket.write(request + '\\n'));
socket.on('data', (chunk) => {
  data += chunk;
  const end = data.indexOf('\\n');
  if (end < 0) {
    if (data.length > ${MAX_ASKPASS_LINE}) fail();
    return;
  }
  let answer;
  try {
    answer = JSON.parse(data.slice(0, end));
  } catch {
    fail();
  }
  socket.destroy();
  if (!answer || typeof answer.value !== 'string') fail();
  process.stdout.write(answer.value + '\\n', () => process.exit(0));
});
socket.on('error', fail);
socket.on('end', fail);
`;

/**
 * The launcher of the helper on Linux and macOS, which SSH_ASKPASS names: a shell script that reads the paths from the
 * environment, so its text is the same on every computer (no path of a user in it), and that sets ELECTRON_RUN_AS_NODE
 * only for the helper. Windows has none (askpassProgram).
 */
export function askpassLauncher(): { fileName: string; text: string } {
  return {
    fileName: 'askpass.sh',
    text: ['#!/bin/sh', `ELECTRON_RUN_AS_NODE=1 exec "$${ASKPASS_NODE_ENV}" "$${ASKPASS_HELPER_ENV}" "$@"`, ''].join('\n'),
  };
}

/** Where the files of one login point: the launcher (not on Windows), the helper, the program that runs it, and the pipe. */
export interface AskpassFiles {
  launcher?: string;
  helper: string;
  node: string;
  address: string;
}

/**
 * The value of SSH_ASKPASS: the launcher, or on Windows (no launcher) the command `"<node>" "<helper>"`. Win32-OpenSSH
 * starts it with CreateProcess as it is, with the question as the next argument in double quotes, so the question goes
 * to the helper as one argument, also with its line breaks. A batch file is no launcher on Windows: cmd.exe would read
 * the question as a command line, where a line break cuts it and a `"` with a `&` in the text of a host runs a command.
 */
export function askpassProgram(files: AskpassFiles): string {
  return files.launcher ?? `"${files.node}" "${files.helper}"`;
}

/**
 * The environment of an `ssh` that may ask (`base` with the variables of the helper): SSH_ASKPASS (askpassProgram),
 * SSH_ASKPASS_REQUIRE=force, DISPLAY when it is not set, and the token of the login. On Windows also
 * ELECTRON_RUN_AS_NODE, which the launcher sets on the other systems; the programs that `ssh` starts (a ProxyCommand)
 * get it too, which only an Electron app reads. Each variable replaces one of another case (Windows).
 */
export function askpassEnv(base: NodeJS.ProcessEnv, files: AskpassFiles, token: string, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  const set = (name: string, value: string): void => {
    if (platform === 'win32') for (const key of Object.keys(env)) if (key.toUpperCase() === name) delete env[key];
    env[name] = value;
  };
  set('SSH_ASKPASS', askpassProgram(files));
  set('SSH_ASKPASS_REQUIRE', 'force');
  if (platform === 'win32') set('ELECTRON_RUN_AS_NODE', '1');
  const hasDisplay = Object.keys(env).some((key) => (platform === 'win32' ? key.toUpperCase() : key) === 'DISPLAY' && !!env[key]);
  if (!hasDisplay) set('DISPLAY', ASKPASS_DISPLAY);
  set(ASKPASS_ADDRESS_ENV, files.address);
  set(ASKPASS_TOKEN_ENV, token);
  set(ASKPASS_NODE_ENV, files.node);
  set(ASKPASS_HELPER_ENV, files.helper);
  return env;
}

/** A question of the helper: the token of its login, the text of `ssh`, and SSH_ASKPASS_PROMPT. */
export interface AskpassRequest {
  token: string;
  prompt: string;
  hint: string;
}

/** The question in a line of the helper, or undefined for a line that is not one. */
export function parseAskpassRequest(line: string): AskpassRequest | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const { token, prompt, hint } = value as Record<string, unknown>;
  if (typeof token !== 'string' || typeof prompt !== 'string' || typeof hint !== 'string') return undefined;
  return { token, prompt, hint };
}

/** The answer line for the helper: `value`, which the helper prints, or none (the helper ends with exit code 1). */
export function askpassAnswerLine(value: string | undefined): string {
  return `${JSON.stringify(value === undefined ? { cancel: true } : { value })}\n`;
}

/**
 * What `ssh` asks:
 * - `hostKey`: whether to accept an unknown host key ("Are you sure you want to continue connecting (yes/no…)?"); the
 *   answer is `yes` or `no`, and `ssh` then writes the key to known_hosts itself;
 * - `confirm`: a question to confirm (SSH_ASKPASS_PROMPT=confirm, for example a key of the agent loaded with
 *   `ssh-add -c`); an answer of exit code 0 confirms;
 * - `notice`: a text without an answer (SSH_ASKPASS_PROMPT=none, for example "Confirm user presence" of a security key);
 * - `secret`: everything else (a password, the passphrase of a key, a one-time code), typed in a box that hides it.
 */
export type SshPromptKind = 'hostKey' | 'confirm' | 'notice' | 'secret';

const HOST_KEY_QUESTION = /continue connecting \(yes\/no/i;

export function sshPromptKind(request: Pick<AskpassRequest, 'prompt' | 'hint'>): SshPromptKind {
  if (request.hint === 'confirm') return 'confirm';
  if (request.hint === 'none') return 'notice';
  if (HOST_KEY_QUESTION.test(request.prompt)) return 'hostKey';
  return 'secret';
}

/** True when the question is for the password of the account (not the passphrase of a key, not a one-time code). */
export function isPasswordPrompt(prompt: string): boolean {
  return /password/i.test(prompt) && !/passphrase/i.test(prompt);
}

/** The fingerprint that a host key question names (for example `SHA256:…`), or undefined. */
export function hostKeyFingerprint(prompt: string): string | undefined {
  return /key fingerprint is ([A-Za-z0-9]+:[A-Za-z0-9+/=:]+)/.exec(prompt)?.[1];
}

/** The questions of one login that may ask: while one is open, the login does not time out (RemoteShell). */
export interface SshLoginPrompts {
  /** Calls `listener` with true when a question of this login opens, and with false when it closes. Returns its end. */
  onPrompt(listener: (open: boolean) => void): () => void;
}

/**
 * The flow of the user that runs now: its logins may ask, until `signal` aborts (the Cancel of its progress). Timers and
 * listeners that a flow creates keep its store after it ended; `active` is false then, so their logins ask nothing (as
 * the scope of an operation in dockerTargets.ts).
 */
interface PromptScope {
  active: boolean;
  signal?: AbortSignal;
}

const promptScopes = new AsyncLocalStorage<PromptScope>();

/**
 * Runs `fn` as a flow of the user (a command with its progress notification, the test of a remote host): an SSH login
 * that it starts may ask in VS Code. When `signal` aborts, the questions of those logins close (sshPromptSignal).
 */
export async function withSshPrompts<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const scope: PromptScope = { active: true, signal };
  try {
    return await promptScopes.run(scope, fn);
  } finally {
    scope.active = false;
  }
}

/** True within withSshPrompts: an SSH login that starts now may ask. */
export function sshPromptsAllowed(): boolean {
  return promptScopes.getStore()?.active === true;
}

/** The signal of the flow of the user that runs now (withSshPrompts): when it aborts, its logins ask nothing more. */
export function sshPromptSignal(): AbortSignal | undefined {
  const scope = promptScopes.getStore();
  return scope?.active === true ? scope.signal : undefined;
}
