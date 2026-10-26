// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { silentLogger } from '../core/ports';
import {
  GITHUB_ENTERPRISE_CONTEXT_KEY,
  GITHUB_SCOPES,
  PACKAGES_SCOPES,
  SIGNED_IN_CONTEXT_KEY,
  VsCodeGitHubAuth,
  ghcrRejectionReporter,
  updateGitHubEnterpriseContextKey,
  watchGitHubEnterpriseSettings,
} from './auth';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';

const session = (token: string) => ({ id: token, accessToken: token, account: { id: '1', label: 'octocat' }, scopes: [] });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('VsCodeGitHubAuth', () => {
  beforeEach(() => resetFakeVscode());
  const { getSession } = fakeVscode.authentication;

  it('requests the scopes repo and read:org, with a dialog only when interactive', async () => {
    expect(GITHUB_SCOPES).toEqual(['repo', 'read:org']);
    const auth = new VsCodeGitHubAuth(silentLogger);
    getSession.mockResolvedValue(session('gho_silent'));
    await expect(auth.getToken({ interactive: false })).resolves.toBe('gho_silent');
    expect(getSession).toHaveBeenLastCalledWith('github', ['repo', 'read:org'], { silent: true });
    await expect(auth.getToken({ interactive: true })).resolves.toBe('gho_silent');
    expect(getSession).toHaveBeenLastCalledWith('github', ['repo', 'read:org'], { createIfNone: true });
    auth.dispose();
  });

  it('shares one sign-in dialog between parallel interactive requests', async () => {
    const auth = new VsCodeGitHubAuth(silentLogger);
    let answer!: (value: unknown) => void;
    getSession.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const first = auth.getToken({ interactive: true });
    const second = auth.getToken({ interactive: true });
    answer(session('gho_1'));
    await expect(Promise.all([first, second])).resolves.toEqual(['gho_1', 'gho_1']);
    expect(getSession).toHaveBeenCalledTimes(1);
    getSession.mockResolvedValue(session('gho_2'));
    await expect(auth.getToken({ interactive: true })).resolves.toBe('gho_2');
    auth.dispose();
  });

  it('gives the account of the same session: the GitHub user ID and the login', async () => {
    const auth = new VsCodeGitHubAuth(silentLogger);
    getSession.mockResolvedValue({ ...session('gho_1'), account: { id: '1001', label: 'scalarion' } });
    await expect(auth.getAccount({ interactive: false })).resolves.toEqual({ id: '1001', login: 'scalarion' });
    expect(getSession).toHaveBeenLastCalledWith('github', ['repo', 'read:org'], { silent: true });
    getSession.mockResolvedValue(undefined);
    await expect(auth.getAccount({ interactive: false })).resolves.toBeUndefined();
    auth.dispose();
  });

  it('gives the token and the account of one session with one read (a claim needs both together)', async () => {
    const auth = new VsCodeGitHubAuth(silentLogger);
    // A second read would give another session (an account change between two reads).
    getSession.mockResolvedValueOnce({ ...session('gho_1'), account: { id: '1001', label: 'scalarion' } });
    getSession.mockResolvedValueOnce({ ...session('gho_2'), account: { id: '2002', label: 'staussh' } });
    await expect(auth.getSession({ interactive: false })).resolves.toEqual({
      token: 'gho_1',
      account: { id: '1001', login: 'scalarion' },
    });
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(getSession).toHaveBeenLastCalledWith('github', ['repo', 'read:org'], { silent: true });
    getSession.mockReset();
    getSession.mockResolvedValue(undefined);
    await expect(auth.getSession({ interactive: false })).resolves.toBeUndefined();
    auth.dispose();
  });

  it('returns undefined when the user cancels the sign-in', async () => {
    const auth = new VsCodeGitHubAuth(silentLogger);
    getSession.mockRejectedValue(new Error('User did not consent to login.'));
    await expect(auth.getToken({ interactive: true })).resolves.toBeUndefined();
    await expect(auth.getToken({ interactive: false })).resolves.toBeUndefined();
    await expect(auth.renewToken()).resolves.toBeUndefined();
    auth.dispose();
  });

  it('gives ghcr.io credentials from a session with the additional scope read:packages', async () => {
    expect(PACKAGES_SCOPES).toEqual(['repo', 'read:org', 'read:packages']);
    const auth = new VsCodeGitHubAuth(silentLogger);
    getSession.mockResolvedValue(session('gho_packages'));
    await expect(auth.getPackagesCredentials({ interactive: false })).resolves.toEqual({
      username: 'octocat',
      password: 'gho_packages',
    });
    expect(getSession).toHaveBeenLastCalledWith('github', ['repo', 'read:org', 'read:packages'], { silent: true });
    auth.dispose();
  });

  it('asks for a new session when GitHub rejected the token', async () => {
    const auth = new VsCodeGitHubAuth(silentLogger);
    getSession.mockResolvedValue(session('gho_new'));
    await expect(auth.renewToken()).resolves.toBe('gho_new');
    const [, scopes, options] = getSession.mock.calls[0];
    expect(scopes).toEqual(['repo', 'read:org']);
    expect(options.forceNewSession).toBeTruthy();
    auth.dispose();
  });

  it('keeps the context key up to date and reports session changes of GitHub only', async () => {
    const auth = new VsCodeGitHubAuth(silentLogger);
    const changes = vi.fn();
    auth.onDidChangeSession(changes);
    getSession.mockResolvedValue(session('gho_1'));
    await expect(auth.updateContextKey()).resolves.toBe(true);
    expect(fakeVscode.commands.executeCommand).toHaveBeenLastCalledWith('setContext', SIGNED_IN_CONTEXT_KEY, true);

    getSession.mockResolvedValue(undefined);
    fakeVscode.fireSessionChange('microsoft');
    await flush();
    expect(changes).not.toHaveBeenCalled();
    fakeVscode.fireSessionChange('github');
    await flush();
    expect(fakeVscode.commands.executeCommand).toHaveBeenLastCalledWith('setContext', SIGNED_IN_CONTEXT_KEY, false);
    expect(changes).toHaveBeenCalledTimes(1);

    auth.dispose();
    fakeVscode.fireSessionChange('github');
    await flush();
    expect(changes).toHaveBeenCalledTimes(1);
  });
  describe('a token that GitHub rejected (workaround for VS Code keeping such a session)', () => {
    const rejectedSession = { id: 's1', accessToken: 'gho_old', account: { id: '1', label: 'octocat' }, scopes: [] };

    it('does not count as signed in, sets the context key once, and asks for a new session on the next interactive request', async () => {
      const auth = new VsCodeGitHubAuth(silentLogger);
      const states = vi.fn();
      auth.onDidChangeSignInState(states);
      getSession.mockResolvedValue(rejectedSession);
      auth.reportRejectedToken('gho_old');
      await vi.waitFor(() => expect(states).toHaveBeenCalledTimes(1));
      expect(fakeVscode.commands.executeCommand).toHaveBeenLastCalledWith('setContext', SIGNED_IN_CONTEXT_KEY, false);
      await expect(auth.isSignedIn()).resolves.toBe(false);
      // The account and the token of the session stay readable (a window keeps its devspace).
      await expect(auth.getToken({ interactive: false })).resolves.toBe('gho_old');
      // A second report of the same token changes nothing.
      auth.reportRejectedToken('gho_old');
      await flush();
      await flush();
      expect(states).toHaveBeenCalledTimes(1);

      getSession.mockResolvedValue(session('gho_new'));
      getSession.mockResolvedValueOnce(rejectedSession);
      await expect(auth.getToken({ interactive: true })).resolves.toBe('gho_new');
      expect(getSession).toHaveBeenLastCalledWith('github', ['repo', 'read:org'], { forceNewSession: true });
      await expect(auth.isSignedIn()).resolves.toBe(true);
      // The new session is not rejected: the next interactive request uses createIfNone again.
      await auth.getToken({ interactive: true });
      expect(getSession).toHaveBeenLastCalledWith('github', ['repo', 'read:org'], { createIfNone: true });
      auth.dispose();
    });

    it('gives the account of a rejected session without a dialog: commands on its devspaces need no new sign-in', async () => {
      const auth = new VsCodeGitHubAuth(silentLogger);
      getSession.mockResolvedValue(rejectedSession);
      auth.reportRejectedToken('gho_old');
      await vi.waitFor(() => expect(fakeVscode.commands.executeCommand).toHaveBeenCalled());
      getSession.mockClear();
      await expect(auth.getAccount({ interactive: true })).resolves.toEqual({ id: '1', login: 'octocat' });
      expect(getSession.mock.calls.map((call) => call[2])).toEqual([{ silent: true }]);
      // A request that needs a working token asks for a new session.
      await auth.getToken({ interactive: true });
      expect(getSession).toHaveBeenLastCalledWith('github', ['repo', 'read:org'], { forceNewSession: true });
      auth.dispose();
    });

    it('ignores a token that belongs to no current session', async () => {
      const auth = new VsCodeGitHubAuth(silentLogger);
      const states = vi.fn();
      auth.onDidChangeSignInState(states);
      getSession.mockResolvedValue(session('gho_current'));
      auth.reportRejectedToken('gho_older');
      await flush();
      await flush();
      expect(states).not.toHaveBeenCalled();
      await expect(auth.isSignedIn()).resolves.toBe(true);
      auth.dispose();
    });

    it('forgets the rejection when GitHub accepts the token again, or when the session gets another token', async () => {
      const auth = new VsCodeGitHubAuth(silentLogger);
      const states = vi.fn();
      auth.onDidChangeSignInState(states);
      getSession.mockResolvedValue(rejectedSession);
      auth.reportRejectedToken('gho_old');
      await vi.waitFor(() => expect(states).toHaveBeenCalledTimes(1));
      auth.reportAcceptedToken('gho_old');
      await vi.waitFor(() => expect(states).toHaveBeenCalledTimes(2));
      expect(fakeVscode.commands.executeCommand).toHaveBeenLastCalledWith('setContext', SIGNED_IN_CONTEXT_KEY, true);
      await expect(auth.isSignedIn()).resolves.toBe(true);

      auth.reportRejectedToken('gho_old');
      await vi.waitFor(() => expect(states).toHaveBeenCalledTimes(3));
      // The same session ID with another token (VS Code refreshed it).
      getSession.mockResolvedValue({ ...rejectedSession, accessToken: 'gho_refreshed' });
      await expect(auth.isSignedIn()).resolves.toBe(true);
      auth.dispose();
    });

    it('asks for a new session with read:packages when GitHub rejected the token of that session, and keeps the sign-in', async () => {
      const auth = new VsCodeGitHubAuth(silentLogger);
      getSession.mockImplementation(async (_provider: string, scopes: string[]) =>
        scopes.includes('read:packages') ? { ...session('gho_packages'), id: 'p1' } : session('gho_main'),
      );
      auth.reportRejectedToken('gho_packages');
      await vi.waitFor(() => expect(fakeVscode.commands.executeCommand).toHaveBeenCalled());
      await expect(auth.isSignedIn()).resolves.toBe(true);
      await auth.getPackagesCredentials({ interactive: true });
      expect(getSession).toHaveBeenLastCalledWith('github', ['repo', 'read:org', 'read:packages'], { forceNewSession: true });
      auth.dispose();
    });
  });

  it('reports the rejected credentials of ghcr.io (the GitHub session), and of no other registry', () => {
    const reportRejectedToken = vi.fn();
    const report = ghcrRejectionReporter({ reportRejectedToken });
    report('ghcr.io', { username: 'octocat', password: 'gho_1' });
    report('GHCR.IO', { username: 'octocat', password: 'gho_2' });
    report('docker.io', { username: 'user', password: 'dckr_pat' });
    report('ghcr.io.example.com', { username: 'user', password: 'other' });
    expect(reportRejectedToken.mock.calls).toEqual([['gho_1'], ['gho_2']]);
  });
});

// The note of the welcome view on GitHub Enterprise (package.json viewsWelcome, controller.test.ts).
describe('the context key devspaces.githubEnterprise', () => {
  beforeEach(() => resetFakeVscode());
  const values = () =>
    fakeVscode.commands.executeCommand.mock.calls.filter((call) => call[0] === 'setContext' && call[1] === GITHUB_ENTERPRISE_CONTEXT_KEY).map((call) => call[2]);

  it('follows the settings github-enterprise: at once, at each change of them, and when VS Code trusts the workspace', () => {
    expect(GITHUB_ENTERPRISE_CONTEXT_KEY).toBe('devspaces.githubEnterprise');
    let places: { globalValue?: string[]; workspaceValue?: string[] } = {};
    fakeVscode.workspace.getConfiguration.mockImplementation((section: string) => ({
      get: (key: string) => (section !== 'github-enterprise' ? undefined : key === 'uris' ? (places.workspaceValue ?? places.globalValue ?? []) : ''),
      inspect: (key: string) => (section === 'github-enterprise' && key === 'uris' ? { key, defaultValue: [], ...places } : undefined),
    }));
    const watcher = watchGitHubEnterpriseSettings(silentLogger);
    expect(values()).toEqual([false]);
    places = { globalValue: ['https://octo.ghe.com'] };
    // Another setting changes nothing.
    fakeVscode.fireConfigurationChange('devspaces.owners');
    expect(values()).toEqual([false]);
    fakeVscode.fireConfigurationChange('github-enterprise.uris');
    expect(values()).toEqual([false, true]);
    // A list of the workspace counts only once VS Code trusts the workspace.
    places = { workspaceValue: ['https://octo.ghe.com'] };
    fakeVscode.workspace.isTrusted = false;
    fakeVscode.fireConfigurationChange('github-enterprise.uris');
    expect(values()).toEqual([false, true, false]);
    fakeVscode.grantWorkspaceTrust();
    expect(values()).toEqual([false, true, false, true]);
    watcher.dispose();
    places = {};
    fakeVscode.fireConfigurationChange('github-enterprise.uri');
    expect(values()).toEqual([false, true, false, true]);
  });

  it('logs a context key that VS Code could not set', async () => {
    fakeVscode.workspace.getConfiguration.mockReturnValue({ get: () => undefined, inspect: () => undefined });
    fakeVscode.commands.executeCommand.mockRejectedValue(new Error('refused'));
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };
    updateGitHubEnterpriseContextKey(logger);
    await flush();
    expect(logger.warn).toHaveBeenCalledWith('Could not set the context key devspaces.githubEnterprise: refused');
  });
});
