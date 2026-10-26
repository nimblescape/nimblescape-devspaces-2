// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { Actions, Messages } from '../core/messages';
import { silentLogger } from '../core/ports';
import type { VsCodeGitHubAuth } from './auth';
import { MESSAGE_DEDUPLICATION_MS, VsCodePipelineUi } from './pipelineUi';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  let now = 1_000_000;
  const clock = { now: () => now };
  const getPackagesCredentials = vi.fn(async () => ({ username: 'me', password: 'token' }));
  const auth = { getPackagesCredentials } as unknown as VsCodeGitHubAuth;
  const showLog = vi.fn();
  const ui = new VsCodePipelineUi(auth, silentLogger, showLog, clock);
  return { ui, showLog, getPackagesCredentials, advance: (ms: number) => (now += ms) };
}

describe('VsCodePipelineUi', () => {
  beforeEach(() => resetFakeVscode());
  const { window } = fakeVscode;

  it('asks before the first open of a repository of another owner (modal)', async () => {
    const { ui } = setup();
    window.showWarningMessage.mockResolvedValueOnce(Actions.open);
    await expect(ui.confirmUntrustedRepository('other/repo')).resolves.toBe(true);
    expect(window.showWarningMessage).toHaveBeenCalledWith(Messages.untrustedRepository('other/repo'), { modal: true }, 'Open');
    window.showWarningMessage.mockResolvedValueOnce(undefined);
    await expect(ui.confirmUntrustedRepository('other/repo')).resolves.toBe(false);
  });

  it('asks about a changed configuration: Rebuild now, or Later (also when dismissed)', async () => {
    const { ui } = setup();
    window.showInformationMessage.mockImplementationOnce(async (_message, _options, rebuildNow) => rebuildNow);
    await expect(ui.configurationChanged('acme/api')).resolves.toBe('rebuildNow');
    const [message, options, ...items] = window.showInformationMessage.mock.calls[0];
    expect(message).toBe('The devspace configuration changed.');
    expect(options).toMatchObject({ modal: true });
    expect(items.map((item: { title: string }) => item.title)).toEqual(['Rebuild now', 'Later']);

    window.showInformationMessage.mockImplementationOnce(async (_message, _options, _rebuildNow, later) => later);
    await expect(ui.configurationChanged('acme/api')).resolves.toBe('later');
    window.showInformationMessage.mockResolvedValueOnce(undefined);
    await expect(ui.configurationChanged('acme/api')).resolves.toBe('later');
  });

  // The update of an existing container, after the setting updateContainer.
  it('pins the texts of the update of a container', () => {
    expect(Messages.containerUpdateNotice('acme/api', true)).toBe('A newer image is available for acme/api. To use it, the running container is stopped and created again from the new image. Your files in the workspace are kept; programs and files that you added outside the workspace are not. Choose Continue to update now, or Cancel to leave the devspace closed.');
    expect(Messages.containerUpdateNotice('acme/api', false)).toBe('A newer image is available for acme/api. Its container is created again from the new image before it opens. Your files in the workspace are kept; programs and files that you added outside the workspace are not. Choose Continue to update now, or Cancel to leave the devspace closed.');
    expect(Messages.containerUpdateQuestion('acme/api', true)).toBe('A newer image is available for acme/api. Update Now stops the running container and creates it again from the new image: your files in the workspace are kept, but programs and files that you added outside the workspace are not. Later opens the current container without the update.');
    expect(Messages.containerUpdateQuestion('acme/api', false)).toBe('A newer image is available for acme/api. Update Now creates its container again from the new image: your files in the workspace are kept, but programs and files that you added outside the workspace are not. Later starts the current container without the update.');
    expect([Actions.continue, Actions.cancel, Actions.updateNow, Actions.later]).toEqual(['Continue', 'Cancel', 'Update Now', 'Later']);
  });

  for (const running of [true, false]) {
    it(`notify (the default) announces the update of a ${running ? 'running' : 'stopped'} container: Continue, or Cancel (also when dismissed)`, async () => {
      const ui = new VsCodePipelineUi({} as VsCodeGitHubAuth, silentLogger, vi.fn());
      window.showInformationMessage.mockImplementationOnce(async (_message, _options, accept) => accept);
      await expect(ui.updateContainer('acme/api', running)).resolves.toBe('update');
      const [message, options, ...items] = window.showInformationMessage.mock.calls[0];
      expect(message).toBe(Messages.containerUpdateNotice('acme/api', running));
      expect(options).toEqual({ modal: true });
      expect(items).toEqual([{ title: 'Continue' }, { title: 'Cancel', isCloseAffordance: true }]);
      window.showInformationMessage.mockImplementationOnce(async (_message, _options, _accept, decline) => decline);
      await expect(ui.updateContainer('acme/api', running)).resolves.toBe('cancel');
      window.showInformationMessage.mockResolvedValueOnce(undefined);
      await expect(ui.updateContainer('acme/api', running)).resolves.toBe('cancel');
    });

    it(`ask asks about the update of a ${running ? 'running' : 'stopped'} container: Update Now, or Later (also when dismissed)`, async () => {
      let setting: 'notify' | 'ask' = 'ask';
      const ui = new VsCodePipelineUi({} as VsCodeGitHubAuth, silentLogger, vi.fn(), undefined, () => setting);
      window.showInformationMessage.mockImplementationOnce(async (_message, _options, accept) => accept);
      await expect(ui.updateContainer('acme/api', running)).resolves.toBe('update');
      const [message, options, ...items] = window.showInformationMessage.mock.calls[0];
      expect(message).toBe(Messages.containerUpdateQuestion('acme/api', running));
      expect(options).toEqual({ modal: true });
      expect(items).toEqual([{ title: 'Update Now' }, { title: 'Later', isCloseAffordance: true }]);
      window.showInformationMessage.mockImplementationOnce(async (_message, _options, _accept, decline) => decline);
      await expect(ui.updateContainer('acme/api', running)).resolves.toBe('later');
      window.showInformationMessage.mockResolvedValueOnce(undefined);
      await expect(ui.updateContainer('acme/api', running)).resolves.toBe('later');
      // The setting is read at each question.
      setting = 'notify';
      window.showInformationMessage.mockResolvedValueOnce(undefined);
      await expect(ui.updateContainer('acme/api', running)).resolves.toBe('cancel');
    });
  }

  it('asks about a switch between Docker Compose and a single container: Rebuild now, or Later (also when dismissed)', async () => {
    const { ui } = setup();
    const text = Messages.configurationKindChanged(true, '.devcontainer/devcontainer.json');
    window.showWarningMessage.mockImplementationOnce(async (_message, _options, rebuildNow) => rebuildNow);
    await expect(ui.configurationKindChanged('acme/api', text)).resolves.toBe('rebuildNow');
    const [message, options, ...items] = window.showWarningMessage.mock.calls[0];
    expect(message).toBe(text);
    expect(options).toEqual({ modal: true, detail: 'acme/api' });
    expect(items).toEqual([{ title: 'Rebuild now' }, { title: 'Later', isCloseAffordance: true }]);
    window.showWarningMessage.mockResolvedValueOnce(undefined);
    await expect(ui.configurationKindChanged('acme/api', text)).resolves.toBe('later');
  });

  it('offers to recreate a damaged container in a modal question with what is kept and lost; Recreate or Cancel (dismissed)', async () => {
    const { ui } = setup();
    const question = { message: Messages.containerRecreateQuestion('acme/api', false), detail: Messages.containerRecreateDetail(false) };
    window.showWarningMessage.mockResolvedValueOnce(Actions.recreateContainer);
    await expect(ui.recreateContainer('acme/api', question)).resolves.toBe(true);
    expect(window.showWarningMessage).toHaveBeenCalledWith(question.message, { modal: true, detail: question.detail }, 'Recreate');
    window.showWarningMessage.mockResolvedValueOnce(undefined);
    await expect(ui.recreateContainer('acme/api', question)).resolves.toBe(false);
  });

  it('asks what to do when the files are missing: Clone again, Delete devspace, or cancel', async () => {
    const { ui } = setup();
    window.showWarningMessage.mockResolvedValueOnce(Actions.cloneAgain);
    await expect(ui.filesMissing('acme/api')).resolves.toBe('cloneAgain');
    const [message, , ...items] = window.showWarningMessage.mock.calls[0];
    expect(message).toBe('The files of this devspace are missing.');
    expect(items).toEqual(['Clone again', 'Delete devspace']);
    window.showWarningMessage.mockResolvedValueOnce(Actions.deleteDevspace);
    await expect(ui.filesMissing('acme/api')).resolves.toBe('deleteDevspace');
    window.showWarningMessage.mockResolvedValueOnce(undefined);
    await expect(ui.filesMissing('acme/api')).resolves.toBeUndefined();
  });

  it('shows an identical information message once per minute', () => {
    const { ui, advance } = setup();
    ui.info(Messages.registryUnreachable);
    ui.info(Messages.registryUnreachable);
    advance(MESSAGE_DEDUPLICATION_MS - 1);
    ui.info(Messages.registryUnreachable);
    expect(window.showInformationMessage).toHaveBeenCalledTimes(1);
    expect(window.showInformationMessage).toHaveBeenCalledWith(
      'No connection to the image registry. The update check was skipped. The devspace uses the local image.',
    );
    ui.info('Another message.');
    expect(window.showInformationMessage).toHaveBeenCalledTimes(2);
    advance(1);
    ui.info(Messages.registryUnreachable);
    expect(window.showInformationMessage).toHaveBeenCalledTimes(3);
  });

  it('shows a warning with Show details, which opens the log', async () => {
    const { ui, showLog } = setup();
    window.showWarningMessage.mockResolvedValueOnce(Actions.showDetails);
    ui.warn(Messages.buildFailed);
    expect(window.showWarningMessage).toHaveBeenCalledWith('The devspace could not be prepared.', 'Show details');
    await flush();
    expect(showLog).toHaveBeenCalledTimes(1);
    ui.warn(Messages.buildFailed);
    expect(window.showWarningMessage).toHaveBeenCalledTimes(1);
  });

  it('offers Sign in for ghcr.io only, and signs in with the scope read:packages', async () => {
    const { ui, getPackagesCredentials } = setup();
    window.showInformationMessage.mockResolvedValueOnce(Actions.signIn);
    ui.registrySignIn('ghcr.io');
    expect(window.showInformationMessage).toHaveBeenCalledWith('The registry ghcr.io requires a sign-in.', 'Sign in');
    await flush();
    expect(getPackagesCredentials).toHaveBeenCalledWith({ interactive: true });

    ui.registrySignIn('docker.io');
    expect(window.showInformationMessage).toHaveBeenLastCalledWith('The registry docker.io requires a sign-in.');
    ui.registrySignIn('docker.io');
    ui.registrySignIn('GHCR.IO');
    expect(window.showInformationMessage).toHaveBeenCalledTimes(2);
  });
});
