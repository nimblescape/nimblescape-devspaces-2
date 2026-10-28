// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The offer of a GitHub account of VS Code that Devspaces does not use yet (docs/security.md "Accounts"), for example an
// account that only another extension uses: one notification per account, the first time Devspaces sees it, and only
// while Devspaces uses another account already (without one, the welcome view offers the sign-in). Not Now, or a
// notification that is closed, is remembered per account ID on this computer; Add GitHub Account… offers the account
// again. Devspaces asks VS Code for the account only after Use in Devspaces.
import type * as vscode from 'vscode';
import { errorMessage } from '../core/errors';
import type { Logger } from '../core/ports';
import type { GitHubAccount } from '../core/types';
import type { VsCodeGitHubAuth } from './auth';
import { ControllerTexts } from './controllerTexts';
import { showInformationMessage } from './notifications';

/** The key in the global state of the extension (its own store): the IDs of the accounts that were offered once. */
export const OFFERED_ACCOUNTS_KEY = 'offeredGitHubAccounts';

export interface AccountOffersDeps {
  auth: Pick<VsCodeGitHubAuth, 'accounts' | 'otherAccounts' | 'getAccount'>;
  /** The global state of the extension (ExtensionContext.globalState): shared by the windows of this computer. */
  state: Pick<vscode.Memento, 'get' | 'update'>;
  logger: Logger;
  /** True while this window has the focus (vscode.window.state.focused). Missing: always. */
  focused?: () => boolean;
}

export class AccountOffers {
  /** The check that runs; a check while one runs waits for it and then runs once more. */
  private running: Promise<void> = Promise.resolve();
  /** A check found this window without the focus: the next focus of the window runs it (onFocused). */
  private waiting = false;

  constructor(private readonly deps: AccountOffersDeps) {}

  /**
   * Offers each GitHub account of VS Code that Devspaces does not use and never offered (at the activation and after
   * each change of the sessions). Returns when the notifications are shown, not when they are answered. Never rejects.
   */
  check(): Promise<void> {
    const next = this.running.then(() => this.checkNow()).catch((error: unknown) => this.deps.logger.warn(`The GitHub accounts of VS Code could not be read: ${errorMessage(error)}`));
    this.running = next;
    return next;
  }

  /** This window got the focus: a check that waited for it runs now. Never rejects. */
  onFocused(): Promise<void> {
    return this.waiting ? this.check() : Promise.resolve();
  }

  private async checkNow(): Promise<void> {
    const { auth, state, logger } = this.deps;
    // Only the window with the focus offers: windows that check at the same time (at the start of VS Code, after a change
    // of the sessions) would each offer the same account, because a change of the global state reaches the other
    // windows only later.
    this.waiting = this.deps.focused?.() === false;
    if (this.waiting) return;
    if ((await auth.accounts()).length === 0) return;
    const offered = new Set(offeredIds(state.get(OFFERED_ACCOUNTS_KEY)));
    for (const account of await auth.otherAccounts()) {
      if (offered.has(account.id)) continue;
      // Remembered before the notification shows: one offer per account, also when the notification is closed, and also
      // in the other windows of this computer.
      offered.add(account.id);
      await state.update(OFFERED_ACCOUNTS_KEY, [...offered]);
      logger.info(`The GitHub account ${account.login} is signed in to VS Code, and Devspaces does not use it. Devspaces offers it once.`);
      void this.offer(account);
    }
  }

  private async offer(account: GitHubAccount): Promise<void> {
    const { auth, logger } = this.deps;
    try {
      const choice = await showInformationMessage(ControllerTexts.accountOffer(account.login), ControllerTexts.useInDevspaces, ControllerTexts.notNow);
      if (choice !== ControllerTexts.useInDevspaces) {
        logger.info(`Devspaces does not use the GitHub account ${account.login}. Add GitHub Account… offers it again.`);
        return;
      }
      // The dialog of VS Code for this account; auth.ts fires the change of the sessions when Devspaces may use it.
      const used = await auth.getAccount({ interactive: true, account });
      logger.info(used ? `Devspaces uses the GitHub account ${account.login} now.` : `The GitHub account ${account.login} was not added to Devspaces.`);
    } catch (error) {
      logger.warn(`The offer of the GitHub account ${account.login} failed: ${errorMessage(error)}`);
    }
  }
}

/** The account IDs of the stored value; nothing that is not a list of texts. */
function offeredIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}
