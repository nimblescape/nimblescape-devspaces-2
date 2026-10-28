// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import type { GitHubAccount } from '../core/types';
import { AccountOffers, OFFERED_ACCOUNTS_KEY } from './accountOffers';
import { ControllerTexts } from './controllerTexts';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';

const SCALARION: GitHubAccount = { id: '1001', login: 'scalarion' };
const STAUSSH: GitHubAccount = { id: '2002', login: 'staussh' };
const COPILOT_ONLY: GitHubAccount = { id: '3003', login: 'bot-user' };

function harness(options: { used?: GitHubAccount[]; other?: GitHubAccount[]; stored?: unknown; focused?: () => boolean } = {}) {
  const values = new Map<string, unknown>(options.stored === undefined ? [] : [[OFFERED_ACCOUNTS_KEY, options.stored]]);
  const state = {
    get: vi.fn((key: string) => values.get(key)),
    update: vi.fn(async (key: string, value: unknown) => {
      values.set(key, value);
    }),
  };
  const auth = {
    accounts: vi.fn(async () => options.used ?? [SCALARION]),
    otherAccounts: vi.fn(async () => options.other ?? [STAUSSH]),
    getAccount: vi.fn(async (_options: { interactive: boolean; account?: GitHubAccount }): Promise<GitHubAccount | undefined> => undefined),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };
  const offers = new AccountOffers({ auth, state, logger, focused: options.focused } as unknown as ConstructorParameters<typeof AccountOffers>[0]);
  return { offers, auth, state, values, logger };
}

const offerCalls = () => fakeVscode.window.showInformationMessage.mock.calls.map((call: unknown[]) => call.slice(0, 3));
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  resetFakeVscode();
});

describe('AccountOffers', () => {
  it('offers each GitHub account of VS Code that Devspaces does not use once, and remembers it before the notification', async () => {
    const h = harness({ other: [STAUSSH, COPILOT_ONLY] });
    await h.offers.check();
    expect(offerCalls()).toEqual([
      [ControllerTexts.accountOffer('staussh'), ControllerTexts.useInDevspaces, ControllerTexts.notNow],
      [ControllerTexts.accountOffer('bot-user'), ControllerTexts.useInDevspaces, ControllerTexts.notNow],
    ]);
    expect(h.values.get(OFFERED_ACCOUNTS_KEY)).toEqual(['2002', '3003']);
    // The next check (another change of the sessions, or another window) offers none of them again.
    await h.offers.check();
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledTimes(2);
  });

  it('asks VS Code for the account only after Use in Devspaces, and names that account', async () => {
    const h = harness();
    fakeVscode.window.showInformationMessage.mockResolvedValueOnce(ControllerTexts.useInDevspaces);
    h.auth.getAccount.mockResolvedValueOnce(STAUSSH);
    await h.offers.check();
    await settled();
    expect(h.auth.getAccount).toHaveBeenCalledWith({ interactive: true, account: STAUSSH });
    expect(h.logger.info).toHaveBeenCalledWith('Devspaces uses the GitHub account staussh now.');
  });

  it('asks VS Code for nothing after Not Now or a closed notification', async () => {
    for (const answer of [ControllerTexts.notNow, undefined]) {
      resetFakeVscode();
      const h = harness();
      fakeVscode.window.showInformationMessage.mockResolvedValueOnce(answer);
      await h.offers.check();
      await settled();
      expect(h.auth.getAccount).not.toHaveBeenCalled();
      expect(h.values.get(OFFERED_ACCOUNTS_KEY)).toEqual(['2002']);
    }
  });

  it('offers nothing while Devspaces uses no account (the welcome view offers the sign-in)', async () => {
    const h = harness({ used: [] });
    await h.offers.check();
    expect(h.auth.otherAccounts).not.toHaveBeenCalled();
    expect(fakeVscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('skips the accounts of the stored value, and ignores a stored value that is not a list of texts', async () => {
    const stored = harness({ other: [STAUSSH, COPILOT_ONLY], stored: ['2002', 7] });
    await stored.offers.check();
    expect(offerCalls()).toEqual([[ControllerTexts.accountOffer('bot-user'), ControllerTexts.useInDevspaces, ControllerTexts.notNow]]);
    expect(stored.values.get(OFFERED_ACCOUNTS_KEY)).toEqual(['2002', '3003']);

    resetFakeVscode();
    const broken = harness({ stored: 'not a list' });
    await broken.offers.check();
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
  });

  it('runs one check at a time: a check during a check offers no account twice', async () => {
    const h = harness();
    await Promise.all([h.offers.check(), h.offers.check()]);
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
  });

  it('offers only in the window with the focus; a window without it offers when it gets the focus', async () => {
    let focused = false;
    const h = harness({ focused: () => focused });
    await h.offers.check();
    expect(h.auth.accounts).not.toHaveBeenCalled();
    expect(fakeVscode.window.showInformationMessage).not.toHaveBeenCalled();
    focused = true;
    await h.offers.onFocused();
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
    // Nothing waits any more: the next focus checks nothing.
    await h.offers.onFocused();
    expect(h.auth.accounts).toHaveBeenCalledTimes(1);
  });

  it('never rejects: a failed read of the accounts is logged', async () => {
    const h = harness();
    h.auth.otherAccounts.mockRejectedValueOnce(new Error('no provider'));
    await expect(h.offers.check()).resolves.toBeUndefined();
    expect(h.logger.warn).toHaveBeenCalledWith('The GitHub accounts of VS Code could not be read: no provider');
    // The next check works again.
    await h.offers.check();
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
  });
});
