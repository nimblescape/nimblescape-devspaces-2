// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The questions of SSH logins in VS Code (docs/architecture.md "Login without setup"; the helper and the protocol are in
// src/core/sshAskpass.ts). SshAskpassServer writes the helper (and on Linux and macOS its launcher) to the storage of
// the extension, listens on a pipe of this extension host that only this user can open (a Unix socket in a private
// folder, or a named pipe with a random name), and gives each login that may ask its own token (`login`). A question
// with a token that it does not know is not asked. The dialogs come one at a time: a password, a passphrase or a code
// in an input box that hides what is typed, an unknown host key in a modal dialog with its fingerprint. After a cancel
// (also the Cancel of the flow), the login asks nothing more. No answer is logged or kept.
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as vscode from 'vscode';
import { errorMessage } from '../core/errors';
import type { Logger } from '../core/ports';
import type { TransportPrompts } from '../core/relay/transport';
import {
  ASKPASS_HELPER_SOURCE,
  MAX_ASKPASS_LINE,
  askpassAnswerLine,
  askpassEnv,
  askpassLauncher,
  hostKeyFingerprint,
  isPasswordPrompt,
  parseAskpassRequest,
  sshPromptKind,
  type AskpassFiles,
  type AskpassRequest,
  type SshLoginPrompts,
} from '../core/sshAskpass';
import { showInformationMessage, showWarningMessage } from './notifications';

/** A login that is not disposed is forgotten after this long without a question (its `ssh` never started, for example). */
const LOGIN_LIFETIME_MS = 60 * 60_000;
/** The longest text of `ssh` that a dialog shows; the host chooses the text of a keyboard-interactive question. */
const MAX_PROMPT_TEXT = 2_000;

export const SshLoginTexts = {
  title: (host: string): string => `Devspaces: SSH login to ${host}`,
  again: (prompt: string): string => `The answer was not accepted. ${prompt}`,
  hostKey: (host: string): string => `Devspaces connects to ${host} for the first time. Do you accept its host key?`,
  hostKeyDetail: (text: string): string =>
    `${text}\n\nAccept the key only when this is the fingerprint of that host: ask the person who runs the host. ssh then keeps the key in known_hosts, and a host that shows another key later is refused.`,
  accept: 'Accept and Connect',
  confirm: 'Confirm',
};

/** The dialogs of the questions (vscodeSshLoginDialogs; fakes in the tests). */
export interface SshLoginDialogs {
  /** A password, a passphrase or a code; undefined when the user cancels or `cancel` ends the question. */
  secret(host: string, prompt: string, again: boolean, cancel: vscode.CancellationToken): Promise<string | undefined>;
  /** Whether the user accepts the unknown host key that `text` names. */
  hostKey(host: string, text: string): Promise<boolean>;
  /** Whether the user confirms (SSH_ASKPASS_PROMPT=confirm). */
  confirm(host: string, text: string): Promise<boolean>;
  /** A text without an answer (SSH_ASKPASS_PROMPT=none). */
  notice(host: string, text: string): void;
}

/** The dialogs of VS Code. */
export function vscodeSshLoginDialogs(): SshLoginDialogs {
  return {
    secret: async (host, prompt, again, cancel) =>
      vscode.window.showInputBox(
        { title: SshLoginTexts.title(host), prompt: again ? SshLoginTexts.again(prompt) : prompt, password: true, ignoreFocusOut: true },
        cancel,
      ),
    hostKey: async (host, text) =>
      (await showWarningMessage(SshLoginTexts.hostKey(host), { modal: true, detail: SshLoginTexts.hostKeyDetail(text) }, SshLoginTexts.accept)) ===
      SshLoginTexts.accept,
    confirm: async (host, text) =>
      (await showInformationMessage(SshLoginTexts.title(host), { modal: true, detail: text }, SshLoginTexts.confirm)) === SshLoginTexts.confirm,
    notice: (host, text) => void showInformationMessage(`${SshLoginTexts.title(host)}: ${text}`),
  };
}

/** One login that may ask: the environment of its `ssh`, and its questions. */
export interface SshLogin extends SshLoginPrompts, TransportPrompts {
  readonly host: string;
  /** True once the login asked for the password of the account. */
  readonly passwordAsked: boolean;
  /** Forgets the login: a question with its token is no longer asked. */
  dispose(): void;
}

export interface SshAskpassServerOptions {
  /** The folder of the helper and its launcher in the storage of the extension. */
  folder: string;
  platform: NodeJS.Platform;
  /** The executable that runs the helper as Node.js: process.execPath of the extension host. */
  nodePath: string;
  /** The folder for the private folder of the Unix socket (dockerPipeBase); not used on Windows. */
  base(): string;
  dialogs: SshLoginDialogs;
  logger: Logger;
  /** Only for the tests. */
  now?: () => number;
}

interface LoginState {
  host: string;
  createdAt: number;
  /** The text of the last question for a password, a passphrase or a code: the same text again follows a wrong answer. */
  lastSecret?: string;
  passwordAsked: boolean;
  cancelled: boolean;
  open: number;
  listeners: Set<(open: boolean) => void>;
  /** The questions of the login that are not answered yet: a cancel of the login closes them. */
  asking: Set<Cancel>;
  /** Cancels the login (the Cancel of its flow): it asks nothing more, and its open questions close. */
  cancel(): void;
}

/** The text of `ssh` for a dialog: plain lines, without control characters, at most MAX_PROMPT_TEXT characters. */
function promptText(prompt: string): string {
  const text = prompt.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim();
  return text.length > MAX_PROMPT_TEXT ? `${text.slice(0, MAX_PROMPT_TEXT)}…` : text;
}

export class SshAskpassServer implements vscode.Disposable {
  private readonly logins = new Map<string, LoginState>();
  private files: AskpassFiles | undefined;
  private server: net.Server | undefined;
  private socketFolder: string | undefined;
  private preparing: Promise<void> | undefined;
  private dialogQueue: Promise<unknown> = Promise.resolve();
  private notReadySaid = false;
  private disposed = false;

  constructor(private readonly options: SshAskpassServerOptions) {}

  /**
   * Writes the helper and its launcher, and listens (once; again after a failure). Never rejects: a failure is logged,
   * and the logins then ask nothing.
   */
  prepare(): Promise<void> {
    this.preparing ??= this.prepareNow().catch((error: unknown) => {
      this.options.logger.warn(`The questions of SSH logins in VS Code are not available: ${errorMessage(error)}`);
      this.preparing = undefined;
    });
    return this.preparing;
  }

  /**
   * A new login to `host` that may ask, or undefined while the pipe does not listen (prepare): the login then asks
   * nothing, as the logins of the background. When `signal` aborts (the Cancel of the flow, sshPromptSignal), the login
   * asks nothing more, and its open questions close.
   */
  login(host: string, signal?: AbortSignal): SshLogin | undefined {
    const files = this.files;
    if (files === undefined || this.disposed) {
      if (!this.notReadySaid && !this.disposed) {
        this.notReadySaid = true;
        this.options.logger.warn(`The SSH login to ${host} cannot ask in VS Code: the questions of SSH logins are not ready.`);
      }
      void this.prepare();
      return undefined;
    }
    this.forgetOldLogins();
    const token = randomBytes(32).toString('hex');
    const state: LoginState = {
      host,
      createdAt: this.now(),
      passwordAsked: false,
      cancelled: false,
      open: 0,
      listeners: new Set(),
      asking: new Set(),
      cancel: () => {
        state.cancelled = true;
        for (const question of [...state.asking]) question.cancel();
      },
    };
    this.logins.set(token, state);
    if (signal?.aborted) state.cancel();
    signal?.addEventListener('abort', state.cancel, { once: true });
    const { platform } = this.options;
    return {
      host,
      get passwordAsked() {
        return state.passwordAsked;
      },
      env: (base) => askpassEnv(base, files, token, platform),
      onPrompt: (listener) => {
        state.listeners.add(listener);
        if (state.open > 0) listener(true);
        return () => state.listeners.delete(listener);
      },
      dispose: () => {
        this.logins.delete(token);
        state.listeners.clear();
        signal?.removeEventListener('abort', state.cancel);
      },
    };
  }

  dispose(): void {
    this.disposed = true;
    this.logins.clear();
    this.server?.close();
    this.server = undefined;
    if (this.socketFolder !== undefined) {
      try {
        fs.rmSync(this.socketFolder, { recursive: true, force: true });
      } catch {
        // Gone already.
      }
    }
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private forgetOldLogins(): void {
    const oldest = this.now() - LOGIN_LIFETIME_MS;
    for (const [token, state] of this.logins) if (state.open === 0 && state.createdAt < oldest) this.logins.delete(token);
  }

  private async prepareNow(): Promise<void> {
    const { folder, platform, nodePath } = this.options;
    await fs.promises.mkdir(folder, { recursive: true, mode: 0o700 });
    const helper = path.join(folder, 'askpass.js');
    await writeIfChanged(helper, ASKPASS_HELPER_SOURCE, 0o600);
    // Windows runs the helper without a launcher (askpassProgram).
    let launcherPath: string | undefined;
    if (platform !== 'win32') {
      const launcher = askpassLauncher();
      launcherPath = path.join(folder, launcher.fileName);
      await writeIfChanged(launcherPath, launcher.text, 0o700);
    }
    const address = await this.listen();
    if (this.disposed) {
      this.dispose();
      return;
    }
    this.files = { launcher: launcherPath, helper, node: nodePath, address };
  }

  /** Listens on a new pipe: a named pipe with a random name, or a Unix socket in a new private folder. */
  private async listen(): Promise<string> {
    const id = randomBytes(16).toString('hex');
    let address: string;
    if (this.options.platform === 'win32') {
      address = `\\\\.\\pipe\\devspaces-askpass-${id}`;
    } else {
      // The same length as the folder of a Docker pipe (pipeAddress.ts), so the path fits the limit of a Unix socket.
      this.socketFolder = path.posix.join(this.options.base(), `devspaces-${id.slice(0, 16)}`);
      await fs.promises.mkdir(this.socketFolder, { mode: 0o700 });
      address = path.posix.join(this.socketFolder, 'askpass');
    }
    const server = net.createServer((socket) => this.accept(socket));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(address, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (error) {
      // The next prepare makes a new folder.
      if (this.socketFolder !== undefined) await fs.promises.rm(this.socketFolder, { recursive: true, force: true });
      this.socketFolder = undefined;
      throw error;
    }
    server.on('error', (error: Error) => this.options.logger.warn(`The pipe of the questions of SSH logins failed: ${error.message}`));
    if (this.options.platform !== 'win32') await fs.promises.chmod(address, 0o600);
    this.server = server;
    return address;
  }

  /** One question of the helper: one line in, one answer line out. */
  private accept(socket: net.Socket): void {
    let data = '';
    let received = false;
    let answered = false;
    const cancel = new Cancel();
    socket.setEncoding('utf8');
    const answer = (value: string | undefined): void => {
      if (answered) return;
      answered = true;
      if (!socket.destroyed) socket.end(askpassAnswerLine(value));
    };
    // The helper ended (`ssh` stops it when the login ends): its question closes.
    socket.on('error', () => cancel.cancel());
    socket.on('close', () => cancel.cancel());
    socket.on('data', (chunk: string) => {
      if (received) return;
      data += chunk;
      const end = data.indexOf('\n');
      if (end < 0) {
        if (data.length > MAX_ASKPASS_LINE) {
          received = true;
          answer(undefined);
        }
        return;
      }
      received = true;
      const request = parseAskpassRequest(data.slice(0, end));
      if (request === undefined) {
        answer(undefined);
        return;
      }
      void this.ask(request, cancel).then(answer, (error: unknown) => {
        this.options.logger.warn(`A question of an SSH login could not be asked: ${errorMessage(error)}`);
        answer(undefined);
      });
    });
  }

  /** The answer to `request`, or undefined (the helper ends with exit code 1, and `ssh` takes it as cancelled). */
  private async ask(request: AskpassRequest, cancel: Cancel): Promise<string | undefined> {
    const state = this.logins.get(request.token);
    // A question of a login that this window does not know, or that ended or was cancelled: not asked.
    if (state === undefined || state.cancelled) return undefined;
    const kind = sshPromptKind(request);
    const text = promptText(request.prompt);
    const { host } = state;
    const { dialogs, logger } = this.options;
    if (kind === 'notice') {
      dialogs.notice(host, text);
      return '';
    }
    // `ssh` asks the same question again after a wrong answer; another text (a password after the passphrase of a key,
    // a one-time code after the password) is a new question.
    const again = kind === 'secret' && state.lastSecret === text;
    if (kind === 'secret') state.lastSecret = text;
    if (kind === 'secret' && isPasswordPrompt(text)) state.passwordAsked = true;
    const what =
      kind === 'hostKey'
        ? `to accept its host key ${hostKeyFingerprint(text) ?? '(no fingerprint)'}`
        : kind === 'confirm'
          ? 'for a confirmation'
          : isPasswordPrompt(text)
            ? 'for a password'
            : 'for a passphrase or a code';
    logger.info(`The SSH login to ${host} asks ${what} in VS Code.`);
    this.setOpen(state, true);
    state.asking.add(cancel);
    try {
      // One dialog at a time; a question whose helper ended or whose login was cancelled meanwhile is not shown.
      const run = this.dialogQueue.then(async (): Promise<string | undefined> => {
        if (cancel.isCancellationRequested || state.cancelled || !this.logins.has(request.token)) return undefined;
        let value: string | undefined;
        switch (kind) {
          case 'hostKey':
            value = (await dialogs.hostKey(host, text)) ? 'yes' : 'no';
            break;
          case 'confirm':
            value = (await dialogs.confirm(host, text)) ? '' : undefined;
            break;
          default:
            value = await dialogs.secret(host, text, again, cancel);
        }
        // A modal dialog cannot be closed: its answer after the end of the question is no answer.
        return cancel.isCancellationRequested ? undefined : value;
      });
      this.dialogQueue = run.catch(() => undefined);
      const value = await run;
      if (value === undefined && cancel.isCancellationRequested) {
        state.cancelled = true;
        logger.info(`The question of the SSH login to ${host} closed without an answer: the login ended, or its flow was cancelled.`);
      } else if (value === undefined || (kind === 'hostKey' && value === 'no')) {
        state.cancelled = true;
        logger.info(kind === 'hostKey' ? `The host key of ${host} was not accepted.` : `The question of the SSH login to ${host} was cancelled.`);
      } else if (kind === 'hostKey') {
        logger.info(`The host key of ${host} was accepted; ssh keeps it in known_hosts.`);
      }
      return value;
    } finally {
      state.asking.delete(cancel);
      this.setOpen(state, false);
    }
  }

  /** Counts the open questions of a login, and tells its listeners when the first opens and when the last closes. */
  private setOpen(state: LoginState, open: boolean): void {
    state.open += open ? 1 : -1;
    if (state.open !== (open ? 1 : 0)) return;
    for (const listener of [...state.listeners]) listener(open);
  }
}

/** A vscode.CancellationToken that the end of the connection of a helper cancels. */
class Cancel implements vscode.CancellationToken {
  private readonly listeners = new Set<(event: unknown) => unknown>();
  isCancellationRequested = false;

  readonly onCancellationRequested = (listener: (event: unknown) => unknown): vscode.Disposable => {
    if (this.isCancellationRequested) listener(undefined);
    else this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  cancel(): void {
    if (this.isCancellationRequested) return;
    this.isCancellationRequested = true;
    for (const listener of [...this.listeners]) listener(undefined);
    this.listeners.clear();
  }
}

/** Writes `text` to `file` with `mode`, unless the file has that text already: written as a part, then renamed. */
async function writeIfChanged(file: string, text: string, mode: number): Promise<void> {
  try {
    if ((await fs.promises.readFile(file, 'utf8')) === text) {
      await fs.promises.chmod(file, mode);
      return;
    }
  } catch {
    // Not there yet.
  }
  const part = `${file}.${randomBytes(8).toString('hex')}.part`;
  await fs.promises.writeFile(part, text, { mode });
  try {
    await fs.promises.rename(part, file);
  } catch (error) {
    await fs.promises.rm(part, { force: true });
    throw error;
  }
}
