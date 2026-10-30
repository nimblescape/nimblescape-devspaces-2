// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The key offer after a login with a password (docs/architecture.md "The key of Devspaces"; the pure parts are in
// src/core/sshKey.ts). When the login of the shell before the relay in a flow of the user asked for the password of the
// account, Devspaces asks once whether to log in with a key next time. On yes, it creates its own key without a
// passphrase with `ssh-keygen` (only when the file is not there yet; it never writes another file of the user), adds
// the public key to `~/.ssh/authorized_keys` on the host with one command on that same shell, checks it with a login
// that uses only this key, and records the host (remote-docker.json). Later logins of Devspaces to the host use the key:
// `-i` on its own command lines (identityFor), and the wrapper `ssh` of the Docker CLI for `ssh://<host>`
// (dockerSshEnv). "Not for This Host" is recorded too, and the host is not asked again.
import * as fs from 'fs';
import * as path from 'path';
import { putFolderFirstInPath } from '../core/docker/dockerCli';
import { sshCommandArgs, sshTargetOf } from '../core/docker/dockerHost';
import { noPromptEnv } from '../core/docker/remoteDocker';
import { errorMessage } from '../core/errors';
import type { Logger, ProcessRunner, RunResult } from '../core/ports';
import type { RemoteDockerState } from '../core/storage/remoteDockerState';
import {
  AUTHORIZED_KEY_ADDED,
  SSH_WRAPPER_IDENTITY_ENV,
  SSH_WRAPPER_SSH_ENV,
  authorizedKeyPresentCommand,
  authorizedKeysCommand,
  devspacesKeyPath,
  keyComment,
  parsePublicKey,
  removeAuthorizedKeyCommand,
  sshWrapper,
  type PublicKey,
} from '../core/sshKey';
import { showInformationMessage, showWarningMessage } from './notifications';
import { writeIfChanged } from './sshLoginPrompts';

/** The longest time of `ssh-keygen`, of the command on the host, and of the check login. */
const KEY_STEP_TIMEOUT_MS = 30_000;
/** After a failed write of the wrapper, a Docker call tries it again only after this time. */
const WRAPPER_RETRY_MS = 60_000;

export const SshKeyTexts = {
  offer: (host: string): string => `Log in to ${host} without a password next time?`,
  offerDetail: (host: string, keyPath: string): string =>
    `Devspaces creates its own SSH key ${keyPath} on this computer, without a passphrase, if it is not there yet. Then it adds the public key to ~/.ssh/authorized_keys of your account on ${host}. Later logins of Devspaces to ${host} use this key.`,
  use: 'Use a Key',
  never: 'Not for This Host',
  installed: (host: string): string => `Devspaces logs in to ${host} with its SSH key from now on.`,
  failed: (host: string, detail: string): string => `The SSH key of Devspaces could not be set up for ${host}: ${detail}`,
};

/** The dialogs of the key offer (vscodeSshKeyDialogs; fakes in the tests). */
export interface SshKeyDialogs {
  /** The answer to the offer: `use`, `never` (Not for This Host), or undefined (closed: ask again next time). */
  offer(host: string, keyPath: string): Promise<'use' | 'never' | undefined>;
  installed(host: string): void;
  /** The warning after a failed setup, with **Not for This Host**: `never` when it was chosen. */
  failed(host: string, detail: string): Promise<'never' | undefined>;
}

export function vscodeSshKeyDialogs(): SshKeyDialogs {
  return {
    offer: async (host, keyPath) => {
      const choice = await showInformationMessage(SshKeyTexts.offer(host), { modal: true, detail: SshKeyTexts.offerDetail(host, keyPath) }, SshKeyTexts.use, SshKeyTexts.never);
      return choice === SshKeyTexts.use ? 'use' : choice === SshKeyTexts.never ? 'never' : undefined;
    },
    installed: (host) => void showInformationMessage(SshKeyTexts.installed(host)),
    failed: async (host, detail) => ((await showWarningMessage(SshKeyTexts.failed(host, detail), SshKeyTexts.never)) === SshKeyTexts.never ? 'never' : undefined),
  };
}

export interface SshKeyOfferOptions {
  /** The home folder of the user (os.homedir()): the key is `<home>/.ssh/devspaces_ed25519`. */
  home: string;
  platform: NodeJS.Platform;
  /** The name of this computer (os.hostname()), for the comment of the key on the host. */
  computerName: string;
  /** The folder of the wrapper `ssh` of the Docker CLI in the storage of the extension. */
  wrapperFolder: string;
  runner: ProcessRunner;
  /** The `ssh` and the `ssh-keygen` of this computer (findExecutable), or undefined. */
  sshPath(): string | undefined;
  sshKeygenPath(): string | undefined;
  env: NodeJS.ProcessEnv;
  state: Pick<RemoteDockerState, 'sshKeyNow' | 'setSshKey'>;
  dialogs: SshKeyDialogs;
  logger: Logger;
  /** Only for the tests. */
  exists?: (file: string) => boolean;
  /** Only for the tests. Default: WRAPPER_RETRY_MS. */
  wrapperRetryMs?: number;
}

/** The shell before the relay, for the commands of the key offer. */
type KeyShell = { run(command: string, options?: { timeoutMs?: number }): Promise<RunResult> };

/** What `afterLogin` needs of the login: whether it asked for the password of the account (SshLogin.passwordAsked). */
export interface PasswordLogin {
  readonly passwordAsked: boolean;
}

export class SshKeyOffer {
  /** The private key of Devspaces. */
  readonly keyPath: string;
  private wrapper: string | undefined;
  private preparing: Promise<void> | undefined;
  /** When the last write of the wrapper failed (Date.now()). */
  private wrapperFailedAt: number | undefined;
  /** The last ensureKey of this window. */
  private keySteps: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: SshKeyOfferOptions) {
    this.keyPath = devspacesKeyPath(options.home, options.platform);
  }

  /** Writes the wrapper `ssh` of the Docker CLI (once; again after a failure). Never rejects: a failure is logged. */
  prepare(): Promise<void> {
    this.preparing ??= this.writeWrapper().catch((error: unknown) => {
      this.options.logger.warn(`The ssh wrapper of the Docker CLI for the key of Devspaces could not be written: ${errorMessage(error)}`);
      this.wrapperFailedAt = Date.now();
      this.preparing = undefined;
    });
    return this.preparing;
  }

  /** The key of Devspaces for `host`, for `-i`: when it was set up for that host and the file is there; else undefined. */
  identityFor(host: string): string | undefined {
    return this.options.state.sshKeyNow(host) === 'installed' && this.exists(this.keyPath) ? this.keyPath : undefined;
  }

  /**
   * Changes the environment of a Docker call with `ssh://<host>` (BootstrapDocker sshEnv): for a host with the key, the
   * folder of the wrapper `ssh` comes first in PATH, with the `ssh` of this computer and the key in its variables.
   * Nothing for another host, without `ssh`, or before the wrapper was written (which this tries again, at most once a
   * minute, after a failure).
   */
  dockerSshEnv(host: string, env: NodeJS.ProcessEnv): void {
    const identity = this.identityFor(host);
    if (identity !== undefined && this.wrapper === undefined) {
      const waiting = this.wrapperFailedAt !== undefined && Date.now() - this.wrapperFailedAt < (this.options.wrapperRetryMs ?? WRAPPER_RETRY_MS);
      if (!waiting && !this.wrapperWritten() && this.preparing === undefined) void this.prepare();
    }
    const ssh = identity === undefined || this.wrapper === undefined ? undefined : this.options.sshPath();
    if (identity === undefined || ssh === undefined) return;
    putFolderFirstInPath(env, this.options.platform, this.options.wrapperFolder);
    env[SSH_WRAPPER_SSH_ENV] = ssh;
    env[SSH_WRAPPER_IDENTITY_ENV] = identity;
  }

  /**
   * After the login of the shell before the relay to `host` (RemoteShellStart.afterLogin): when it asked for the
   * password, the offer, and on yes the key on the host. Not for a host that declined it, and not for a host whose
   * login had the key while the key is still in its `authorized_keys`: there the password was asked for something that a
   * key does not replace (for example a jump host, or a server that wants a key and a password). A failure is logged
   * and shown; it never fails the login.
   */
  async afterLogin(host: string, login: PasswordLogin, shell: KeyShell): Promise<void> {
    if (!login.passwordAsked) return;
    const { state, dialogs, logger } = this.options;
    // As identityFor: a read error for a moment (another window renames its write into place) keeps the last read.
    const recorded = state.sshKeyNow(host);
    if (recorded === 'declined') return;
    if (recorded === 'installed' && this.identityFor(host) !== undefined && (await this.keyOnHost(shell))) {
      logger.info(`The login to ${host} asked for a password although it had the key of Devspaces, which is on the host; the key is not offered again.`);
      return;
    }
    const answer = await dialogs.offer(host, this.keyPath);
    if (answer === undefined) {
      logger.info(`The key of Devspaces for ${host} was not set up now; Devspaces asks again after the next login with a password.`);
      return;
    }
    if (answer === 'never') {
      logger.info(`Devspaces does not offer its key for ${host} again.`);
      await state.setSshKey(host, 'declined').catch((error: unknown) => logger.warn(`The answer for ${host} could not be recorded: ${errorMessage(error)}`));
      return;
    }
    const comment = keyComment(this.options.computerName);
    let added: PublicKey | undefined;
    try {
      const key = await this.ensureKey();
      const result = await shell.run(authorizedKeysCommand(key, comment), { timeoutMs: KEY_STEP_TIMEOUT_MS });
      if (result.exitCode !== 0) throw new Error(`~/.ssh/authorized_keys on ${host} could not be changed: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
      if (result.stdout.trim() === AUTHORIZED_KEY_ADDED) added = key;
      logger.info(`The public key of Devspaces is in ~/.ssh/authorized_keys of the account on ${host}${added ? ' now' : ' already'}.`);
      const detail = await this.checkLogin(host);
      if (detail !== undefined) throw new Error(`a login with the key failed: ${detail}`);
      await state.setSshKey(host, 'installed');
      logger.info(`Devspaces logs in to ${host} with its key ${this.keyPath} from now on.`);
      dialogs.installed(host);
    } catch (error) {
      logger.warn(`The key of Devspaces could not be set up for ${host}: ${errorMessage(error)}`);
      // A key that Devspaces does not use stays on no host: its line goes again when this setup added it.
      if (added !== undefined) await this.removeKey(host, shell, added, comment);
      // Not awaited: the relay takes the shell over after this step. "Not for This Host" there ends the offer for a host
      // where a key does not help (for example a jump host that asks for the password).
      void dialogs.failed(host, errorMessage(error)).then(async (choice) => {
        if (choice !== 'never') return;
        logger.info(`Devspaces does not offer its key for ${host} again.`);
        await state.setSshKey(host, 'declined').catch((failure: unknown) => logger.warn(`The answer for ${host} could not be recorded: ${errorMessage(failure)}`));
      });
    }
  }

  /** Removes the line of the key that this setup added from `~/.ssh/authorized_keys` on the host of `shell` (logged). */
  private async removeKey(host: string, shell: KeyShell, key: PublicKey, comment: string): Promise<void> {
    const { logger } = this.options;
    try {
      const removed = await shell.run(removeAuthorizedKeyCommand(key, comment), { timeoutMs: KEY_STEP_TIMEOUT_MS });
      if (removed.exitCode !== 0) throw new Error(removed.stderr.trim() || `exit code ${removed.exitCode}`);
      logger.info(`The public key of Devspaces was removed from ~/.ssh/authorized_keys on ${host} again.`);
    } catch (error) {
      logger.warn(`The public key of Devspaces could not be removed from ~/.ssh/authorized_keys on ${host} again (${errorMessage(error)}); remove its line ${comment} there.`);
    }
  }

  /**
   * True when the key of Devspaces is in `~/.ssh/authorized_keys` on the host of `shell`. False when it is not, and when
   * that cannot be known (for example the key file cannot be read): then the offer comes, and its setup says why it
   * fails.
   */
  private async keyOnHost(shell: KeyShell): Promise<boolean> {
    try {
      const present = await shell.run(authorizedKeyPresentCommand(await this.publicKey()), { timeoutMs: KEY_STEP_TIMEOUT_MS });
      return present.exitCode === 0;
    } catch (error) {
      this.options.logger.warn(`The key of Devspaces on the host could not be looked up: ${errorMessage(error)}`);
      return false;
    }
  }

  private exists(file: string): boolean {
    return (this.options.exists ?? fs.existsSync)(file);
  }

  /**
   * The public key of Devspaces: the key file is created with `ssh-keygen` when it is not there yet. One at a time in
   * this window (two hosts whose offers were answered one after the other).
   */
  private ensureKey(): Promise<PublicKey> {
    const step = this.keySteps.then(() => this.ensureKeyNow());
    this.keySteps = step.catch(() => undefined);
    return step;
  }

  private async ensureKeyNow(): Promise<PublicKey> {
    const { runner, env, logger, computerName } = this.options;
    const keygen = this.options.sshKeygenPath();
    if (keygen === undefined) throw new Error('ssh-keygen was not found on this computer.');
    const quiet = noPromptEnv(env);
    if (!this.exists(this.keyPath)) {
      // ssh-keygen would write over it.
      if (this.exists(`${this.keyPath}.pub`)) throw new Error(`${this.keyPath}.pub is there without its private key; remove it, then try again.`);
      await fs.promises.mkdir(path.dirname(this.keyPath), { recursive: true, mode: 0o700 });
      // ssh-keygen does not write over a private key (its question gets no answer: the input is empty), so another
      // window that made the key meanwhile wins.
      const made = await runner.run(keygen, ['-q', '-t', 'ed25519', '-N', '', '-C', keyComment(computerName), '-f', this.keyPath], {
        env: quiet,
        timeoutMs: KEY_STEP_TIMEOUT_MS,
      });
      if (made.exitCode === 0) logger.info(`Devspaces created its SSH key ${this.keyPath}.`);
      else if (!this.exists(this.keyPath)) throw new Error(`ssh-keygen failed: ${made.stderr.trim() || `exit code ${made.exitCode}`}`);
    }
    return this.publicKey();
  }

  /** The public key of the key file of Devspaces. */
  private async publicKey(): Promise<PublicKey> {
    const keygen = this.options.sshKeygenPath();
    if (keygen === undefined) throw new Error('ssh-keygen was not found on this computer.');
    // The public key from the private key itself, so a missing or other .pub file does not count.
    const read = await this.options.runner.run(keygen, ['-y', '-f', this.keyPath], { env: noPromptEnv(this.options.env), timeoutMs: KEY_STEP_TIMEOUT_MS });
    const key = read.exitCode === 0 ? parsePublicKey(read.stdout) : undefined;
    if (key === undefined) throw new Error(`the key ${this.keyPath} could not be read: ${read.stderr.trim() || 'it is no Ed25519 key without a passphrase'}`);
    return key;
  }

  /** A login to `host` without questions that may use only the key of Devspaces: undefined when it works, else why not. */
  private async checkLogin(host: string): Promise<string | undefined> {
    const ssh = this.options.sshPath();
    const target = sshTargetOf(host);
    if (ssh === undefined || target === undefined) return 'ssh was not found, or the host is no SSH alias or address.';
    const result = await this.options.runner.run(ssh, sshCommandArgs(target, 'true', undefined, { identity: this.keyPath, identityOnly: true }), {
      env: noPromptEnv(this.options.env),
      timeoutMs: KEY_STEP_TIMEOUT_MS,
    });
    if (result.timedOut) return `ssh did not answer within ${KEY_STEP_TIMEOUT_MS / 1000} seconds.`;
    return result.exitCode === 0 ? undefined : result.stderr.trim() || `ssh failed with exit code ${result.exitCode}.`;
  }

  /**
   * True when the wrapper of an earlier activation is there with the text of now (so a Docker call right after the
   * activation, before prepare wrote it, has it too); it is then used.
   */
  private wrapperWritten(): boolean {
    const wrapper = sshWrapper(this.options.platform);
    const file = path.join(this.options.wrapperFolder, wrapper.fileName);
    try {
      if (fs.readFileSync(file, 'utf8') !== wrapper.text) return false;
    } catch {
      return false;
    }
    this.wrapper = file;
    return true;
  }

  private async writeWrapper(): Promise<void> {
    const { wrapperFolder, platform } = this.options;
    await fs.promises.mkdir(wrapperFolder, { recursive: true, mode: 0o700 });
    const wrapper = sshWrapper(platform);
    const file = path.join(wrapperFolder, wrapper.fileName);
    await writeIfChanged(file, wrapper.text, 0o700);
    this.wrapper = file;
  }
}
