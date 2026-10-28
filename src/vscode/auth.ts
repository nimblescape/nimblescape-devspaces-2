// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// GitHub access through the built-in GitHub sign-in of VS Code (docs/security.md "The GitHub token"). VS Code can hold
// the sessions of several GitHub accounts. Devspaces uses each account that the user allowed for it and that has a
// session with the scopes `repo` and `read:org` (the accounts of Devspaces, `accounts`). Every call that belongs to an
// account names it: a sign-in dialog of VS Code changes the account that a call without an account gets. VS Code stores
// the sessions; the extension never stores a token on the computer and never logs it. It writes the token of a
// devspace's owner account into that devspace only (the open pipeline, docs/security.md "Git inside the container").
import * as vscode from 'vscode';
import { errorMessage } from '../core/errors';
import type { Credentials, GitHubAuth, GitHubAuthOptions, Logger } from '../core/ports';
import type { GitHubAccount } from '../core/types';
import { GITHUB_ENTERPRISE_SECTION, githubEnterpriseConfigured } from './settings';

export const GITHUB_PROVIDER_ID = 'github';
/** `repo` lists and clones private repositories; `read:org` reads the organization memberships. */
export const GITHUB_SCOPES: readonly string[] = ['repo', 'read:org'];
/** Requested only when a private image on ghcr.io needs it. */
export const PACKAGES_SCOPES: readonly string[] = ['repo', 'read:org', 'read:packages'];
/** Context key for the welcome view and the menus (package.json). */
export const SIGNED_IN_CONTEXT_KEY = 'devspaces.signedIn';
/** Context key for the welcome view (package.json): the settings of VS Code name a GitHub Enterprise instance. */
export const GITHUB_ENTERPRISE_CONTEXT_KEY = 'devspaces.githubEnterprise';

// User-visible text that messages.ts lacks; to be moved there.
/** Shown by VS Code when a new session is requested because GitHub rejected the stored one. */
export const SIGN_IN_AGAIN_DETAIL = 'GitHub did not accept the current sign-in. Sign in again to see your repositories.';
/** SIGN_IN_AGAIN_DETAIL for the account `login`, when Devspaces uses more than one account. */
export const signInAgainDetailOf = (login: string): string => `GitHub did not accept the sign-in of ${login}. Sign in again as ${login} to see its repositories.`;

/** A session whose token GitHub rejected (HTTP 401): its ID and its token. */
interface RejectedSession {
  id: string;
  token: string;
}

export class VsCodeGitHubAuth implements GitHubAuth, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly signInStateEmitter = new vscode.EventEmitter<void>();
  private readonly subscriptions: vscode.Disposable[] = [];
  /** Interactive requests per account and scope set, so that parallel callers share one sign-in dialog. */
  private readonly interactive = new Map<string, Promise<vscode.AuthenticationSession | undefined>>();
  /**
   * Per account and scope set, the session whose token GitHub rejected (HTTP 401).
   * Workaround for VS Code keeping a GitHub session whose token GitHub rejects: `getSession` with `createIfNone` returns
   * that session again without a dialog, so a sign-in could never replace the token. While the session is rejected, an
   * interactive request asks for a new session (`forceNewSession`), and the session does not count as signed in. Remove
   * when VS Code handles it.
   */
  private readonly rejected = new Map<string, RejectedSession>();
  /** The accounts of Devspaces, read once after each change of the sessions (`accounts`). */
  private accountSet: Promise<GitHubAccount[]> | undefined;
  /**
   * The IDs of the accounts that onDidChangeSession reported last (before any change: of the first read of the set). A
   * dialog fires onDidChangeSession only for another set, so that a change that VS Code reported itself (a new session)
   * is not reported twice.
   */
  private reportedAccounts: string | undefined;

  /**
   * Fires when the GitHub sessions of VS Code change (sign-in, sign-out, account change), and when a sign-in dialog of
   * Devspaces changed its accounts (VS Code fires no change when it only allows an existing session for Devspaces).
   */
  readonly onDidChangeSession: vscode.Event<void> = this.changeEmitter.event;
  /**
   * Fires when GitHub rejected the token of a session, or accepted it again. The session itself did not change, so
   * this is not onDidChangeSession: the accounts and their devspaces stay the same.
   */
  readonly onDidChangeSignInState: vscode.Event<void> = this.signInStateEmitter.event;

  constructor(private readonly logger: Logger) {
    this.subscriptions.push(
      this.changeEmitter,
      this.signInStateEmitter,
      vscode.authentication.onDidChangeSessions((event) => {
        if (event.provider.id !== GITHUB_PROVIDER_ID) return;
        this.accountSet = undefined;
        this.accounts()
          .then((accounts) => {
            this.reportedAccounts = accountIds(accounts);
            return this.updateContextKey();
          })
          .then(undefined, (error: unknown) => this.logger.warn(`Could not update the sign-in state: ${errorMessage(error)}`))
          .finally(() => this.changeEmitter.fire());
      }),
    );
  }

  /**
   * The accounts of Devspaces: each GitHub account of VS Code that has a session with the scopes `repo` and
   * `read:org` that Devspaces may use (the user allowed it), in the order of their logins. Never shows a dialog; read
   * once after each change of the sessions.
   */
  accounts(): Promise<GitHubAccount[]> {
    if (this.accountSet === undefined) {
      const read = this.readAccounts();
      this.accountSet = read;
      void read.then((accounts) => {
        if (this.accountSet === read) this.reportedAccounts ??= accountIds(accounts);
      });
    }
    return this.accountSet;
  }

  /**
   * The GitHub accounts of VS Code that Devspaces does not use: no session with the scopes `repo` and `read:org`, or
   * the user did not allow Devspaces to use it (an account that only another extension uses). Never shows a dialog.
   */
  async otherAccounts(): Promise<GitHubAccount[]> {
    const used = new Set((await this.accounts()).map((account) => account.id));
    return (await this.vscodeAccounts()).filter((account) => !used.has(account.id)).map((account) => ({ id: account.id, login: account.label }));
  }

  /** Token with the scopes `repo` and `read:org`. `interactive` shows the sign-in dialog if needed; otherwise never a dialog. */
  async getToken(options: GitHubAuthOptions): Promise<string | undefined> {
    const session = await this.session(GITHUB_SCOPES, options.interactive, options.account);
    return session?.accessToken;
  }

  /**
   * The account of the session of getToken: `session.account.id` (the numeric GitHub user ID) and
   * `session.account.label` (the login). `undefined` without a session.
   */
  async getAccount(options: GitHubAuthOptions): Promise<GitHubAccount | undefined> {
    // The account needs no working token: a session whose token GitHub rejected still names it, so commands on the
    // devspaces of the account (Stop, Delete) ask for no new sign-in. Only without any session a dialog shows.
    const existing = options.interactive ? await this.session(GITHUB_SCOPES, false, options.account) : undefined;
    const session = existing ?? (await this.session(GITHUB_SCOPES, options.interactive, options.account));
    return session ? accountOf(session) : undefined;
  }

  /**
   * The token and the account of one session. Use it where both must belong together: the session can change between a
   * call of getAccount and a call of getToken. `undefined` without a session.
   */
  async getSession(options: GitHubAuthOptions): Promise<{ token: string; account: GitHubAccount } | undefined> {
    const session = await this.session(GITHUB_SCOPES, options.interactive, options.account);
    return session ? { token: session.accessToken, account: accountOf(session) } : undefined;
  }

  /** Credentials for ghcr.io: the session with the additional scope `read:packages`. */
  async getPackagesCredentials(options: GitHubAuthOptions): Promise<Credentials | undefined> {
    const session = await this.session(PACKAGES_SCOPES, options.interactive, options.account);
    return session ? { username: session.account.label, password: session.accessToken } : undefined;
  }

  /**
   * Asks for a new session of `account` (without one: of the account that VS Code gives Devspaces) when GitHub rejected
   * the token of its current one (HTTP 401). Shows the sign-in dialog. Returns the new token, or `undefined` when the
   * user cancels or signs in with another account.
   */
  async renewToken(account?: GitHubAccount): Promise<string | undefined> {
    try {
      const named = account === undefined ? undefined : await this.named(account);
      if (account !== undefined && named === undefined) return undefined;
      const detail = account !== undefined && (await this.accounts()).length > 1 ? signInAgainDetailOf(account.login) : SIGN_IN_AGAIN_DETAIL;
      const session = await vscode.authentication.getSession(GITHUB_PROVIDER_ID, [...GITHUB_SCOPES], {
        forceNewSession: { detail },
        ...(named !== undefined ? { account: named } : {}),
      });
      this.afterDialog();
      if (named !== undefined && session.account.id !== named.id) {
        this.logger.warn(`The new GitHub sign-in is of ${session.account.label}, not of ${named.label}.`);
        return undefined;
      }
      return session.accessToken;
    } catch (error) {
      this.logger.warn(`GitHub sign-in was not completed: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /**
   * Adds a GitHub account to Devspaces: the account picker of VS Code, which ends with "Sign in to another account".
   * Returns the account that the user chose (also one that Devspaces used already), or `undefined` when the user
   * cancels.
   */
  async addAccount(): Promise<GitHubAccount | undefined> {
    try {
      const session = await vscode.authentication.getSession(GITHUB_PROVIDER_ID, [...GITHUB_SCOPES], { createIfNone: true, clearSessionPreference: true });
      this.afterDialog();
      return accountOf(session);
    } catch (error) {
      this.logger.warn(`GitHub sign-in was not completed: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /**
   * With `account`: true if that account has a session with the scopes `repo` and `read:org` and GitHub did not reject
   * its token. Without: true if one account of Devspaces is signed in so. Never shows a dialog.
   */
  async isSignedIn(account?: GitHubAccount): Promise<boolean> {
    if (account !== undefined) {
      const session = await this.session(GITHUB_SCOPES, false, account);
      return session !== undefined && !this.isRejected(GITHUB_SCOPES, session);
    }
    for (const each of await this.accounts()) if (await this.isSignedIn(each)) return true;
    return false;
  }

  /**
   * GitHub answered HTTP 401 for `token`: the session with this token does not count as signed in, and the next
   * interactive request of its account asks for a new session. Every GitHub caller reports a 401 here. A token that
   * belongs to no current session (an older one) changes nothing. Never throws.
   */
  reportRejectedToken(token: string): void {
    void this.updateRejected(token, true).catch((error: unknown) =>
      this.logger.warn(`Could not update the sign-in state: ${errorMessage(error)}`),
    );
  }

  /** GitHub accepted `token` (a request succeeded): a rejection of its session is forgotten. Never throws. */
  reportAcceptedToken(token: string): void {
    if (![...this.rejected.values()].some((entry) => entry.token === token)) return;
    void this.updateRejected(token, false).catch((error: unknown) =>
      this.logger.warn(`Could not update the sign-in state: ${errorMessage(error)}`),
    );
  }

  /**
   * Sets the context key `devspaces.signedIn` (package.json: the welcome view with **Sign in with GitHub**). The
   * only place that sets it: signed in means one account of Devspaces has a session whose token GitHub did not reject.
   * Returns the state.
   */
  async updateContextKey(): Promise<boolean> {
    const signedIn = await this.isSignedIn();
    await vscode.commands.executeCommand('setContext', SIGNED_IN_CONTEXT_KEY, signedIn);
    return signedIn;
  }

  dispose(): void {
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
  }

  private async updateRejected(token: string, rejected: boolean): Promise<void> {
    let changed = false;
    for (const account of await this.accounts()) {
      for (const scopes of [GITHUB_SCOPES, PACKAGES_SCOPES]) {
        const session = await this.session(scopes, false, account);
        if (session === undefined || session.accessToken !== token) continue;
        const key = sessionKey(scopes, session.account.id);
        if (rejected && !this.isRejected(scopes, session)) {
          this.rejected.set(key, { id: session.id, token });
          this.logger.warn(`GitHub rejected the token of the sign-in of ${account.login} (HTTP 401). Sign in with GitHub replaces it.`);
          changed = true;
        } else if (!rejected && this.rejected.delete(key)) {
          this.logger.info(`GitHub accepted the token of the sign-in of ${account.login} again.`);
          changed = true;
        }
      }
    }
    if (!changed) return;
    await this.updateContextKey();
    this.signInStateEmitter.fire();
  }

  /** True if GitHub rejected the token of `session`. A session with another ID or token clears the rejection. */
  private isRejected(scopes: readonly string[], session: vscode.AuthenticationSession): boolean {
    const key = sessionKey(scopes, session.account.id);
    const entry = this.rejected.get(key);
    if (!entry) return false;
    if (entry.id === session.id && entry.token === session.accessToken) return true;
    this.rejected.delete(key);
    return false;
  }

  /** The accounts of Devspaces (accounts), read from VS Code. */
  private async readAccounts(): Promise<GitHubAccount[]> {
    const found = new Map<string, GitHubAccount>();
    for (const account of await this.vscodeAccounts()) {
      const session = await this.silentSession(GITHUB_SCOPES, account);
      if (session !== undefined) found.set(session.account.id, accountOf(session));
    }
    // VS Code names no account (or could not list them): the session that it gives Devspaces, if any.
    if (found.size === 0) {
      const session = await this.silentSession(GITHUB_SCOPES, undefined);
      if (session !== undefined) found.set(session.account.id, accountOf(session));
    }
    return [...found.values()].sort((a, b) => a.login.localeCompare(b.login, 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id));
  }

  /** The GitHub accounts of VS Code, also those that Devspaces may not use (getAccounts). Empty when VS Code fails. */
  private async vscodeAccounts(): Promise<readonly vscode.AuthenticationSessionAccountInformation[]> {
    try {
      return await vscode.authentication.getAccounts(GITHUB_PROVIDER_ID);
    } catch (error) {
      this.logger.warn(`Could not read the GitHub accounts of VS Code: ${errorMessage(error)}`);
      return [];
    }
  }

  /**
   * `account` as VS Code names it: its ID and its current login, found by the ID among the accounts of Devspaces, else
   * among the accounts of VS Code (the GitHub sign-in finds the sessions of an account by its login, and a recorded
   * login is old after a rename on GitHub). An account that neither knows keeps its recorded login; `undefined` when
   * it has none (an owner read from a volume label).
   */
  private async named(account: GitHubAccount): Promise<vscode.AuthenticationSessionAccountInformation | undefined> {
    const used = (await this.accounts()).find((each) => each.id === account.id);
    if (used !== undefined) return { id: used.id, label: used.login };
    const known = (await this.vscodeAccounts()).find((each) => each.id === account.id);
    if (known !== undefined) return known;
    return account.login !== '' ? { id: account.id, label: account.login } : undefined;
  }

  private async silentSession(
    scopes: readonly string[],
    account: vscode.AuthenticationSessionAccountInformation | undefined,
  ): Promise<vscode.AuthenticationSession | undefined> {
    try {
      const session = await vscode.authentication.getSession(GITHUB_PROVIDER_ID, [...scopes], { silent: true, ...(account !== undefined ? { account } : {}) });
      // The session of the account that was asked for, never one of another account with the same login.
      return account !== undefined && session !== undefined && session.account.id !== account.id ? undefined : session;
    } catch (error) {
      this.logger.warn(`Could not read the GitHub session: ${errorMessage(error)}`);
      return undefined;
    }
  }

  private async session(scopes: readonly string[], interactive: boolean, account?: GitHubAccount): Promise<vscode.AuthenticationSession | undefined> {
    const named = account === undefined ? undefined : await this.named(account);
    // An account that VS Code does not know cannot be asked for: no session.
    if (account !== undefined && named === undefined) return undefined;
    if (!interactive) return this.silentSession(scopes, named);
    const key = sessionKey(scopes, named?.id ?? '');
    let request = this.interactive.get(key);
    if (!request) {
      request = this.requestInteractive(scopes, named).finally(() => this.interactive.delete(key));
      this.interactive.set(key, request);
    }
    return request;
  }

  private async requestInteractive(
    scopes: readonly string[],
    account: vscode.AuthenticationSessionAccountInformation | undefined,
  ): Promise<vscode.AuthenticationSession | undefined> {
    // Workaround (see `rejected`): `createIfNone` would return the rejected session again without a dialog.
    const current = this.rejected.size > 0 ? await this.silentSession(scopes, account) : undefined;
    const force = current !== undefined && this.isRejected(scopes, current);
    try {
      const session = await vscode.authentication.getSession(GITHUB_PROVIDER_ID, [...scopes], {
        ...(force ? { forceNewSession: true } : { createIfNone: true }),
        ...(account !== undefined ? { account } : {}),
      });
      if (session === undefined) return undefined;
      this.afterDialog();
      if (account !== undefined && session.account.id !== account.id) {
        // The user signed in with another account in the browser: it is not the session that was asked for.
        this.logger.warn(`The GitHub sign-in is of ${session.account.label}, not of ${account.label}.`);
        return undefined;
      }
      return session;
    } catch (error) {
      // The user cancelled the dialog or did not allow the access.
      this.logger.warn(`GitHub sign-in was not completed: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /**
   * A sign-in dialog ended with a session: the accounts are read again. VS Code fires no change of the sessions when the
   * user only allowed an existing session for Devspaces, so a changed set of accounts fires onDidChangeSession here,
   * unless the change of the sessions that VS Code fired for a new session reported that set already.
   */
  private afterDialog(): void {
    const first = this.reportedAccounts === undefined;
    this.accountSet = undefined;
    void this.accounts()
      .then(async (accounts) => {
        const ids = accountIds(accounts);
        if (!first && ids === this.reportedAccounts) return;
        this.reportedAccounts = ids;
        await this.updateContextKey();
        this.changeEmitter.fire();
      })
      .catch((error: unknown) => this.logger.warn(`Could not update the sign-in state: ${errorMessage(error)}`));
  }
}

function accountOf(session: vscode.AuthenticationSession): GitHubAccount {
  return { id: session.account.id, login: session.account.label };
}

/** The IDs of `accounts` as one text, to compare two reads of the set. */
function accountIds(accounts: readonly GitHubAccount[]): string {
  return accounts.map((account) => account.id).join(' ');
}

/** The key of the session of the account `accountId` ('' = the session that VS Code gives Devspaces) and `scopes`. */
function sessionKey(scopes: readonly string[], accountId: string): string {
  return `${accountId} ${[...scopes].sort().join(' ')}`;
}

/**
 * Sets the context key `devspaces.githubEnterprise` from the settings of VS Code (githubEnterpriseConfigured). While
 * you are not signed in, the welcome view then says that Devspaces cannot use an account of GitHub Enterprise.
 */
export function updateGitHubEnterpriseContextKey(logger: Logger): void {
  vscode.commands.executeCommand('setContext', GITHUB_ENTERPRISE_CONTEXT_KEY, githubEnterpriseConfigured()).then(undefined, (error: unknown) => {
    logger.warn(`Could not set the context key ${GITHUB_ENTERPRISE_CONTEXT_KEY}: ${errorMessage(error)}`);
  });
}

/**
 * Keeps the context key `devspaces.githubEnterprise` up to date: sets it now, and again when a setting of the section
 * `github-enterprise` changes, or when VS Code trusts the workspace (a value of the workspace counts only then).
 */
export function watchGitHubEnterpriseSettings(logger: Logger): vscode.Disposable {
  updateGitHubEnterpriseContextKey(logger);
  const subscriptions = [
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(GITHUB_ENTERPRISE_SECTION)) updateGitHubEnterpriseContextKey(logger);
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => updateGitHubEnterpriseContextKey(logger)),
  ];
  return {
    dispose: () => {
      for (const subscription of subscriptions.splice(0)) subscription.dispose();
    },
  };
}
