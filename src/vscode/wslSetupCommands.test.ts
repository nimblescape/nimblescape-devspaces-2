// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { WSL_HOST } from '../core/docker/dockerHost';
import { WslSetupError, type WslImage, type WslRegistration, type WslSetupStep } from '../core/docker/wslSetup';
import { Actions } from '../core/messages';
import { abortError } from '../core/ports';
import { Commands } from './commands';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';
import { WslSetupCommands, WslSetupTexts, type WslSetupCommandsDeps } from './wslSetupCommands';

const { window } = fakeVscode;
const FOLDER = 'C:\\Users\\ana\\AppData\\Local\\nimblescape\\devspaces\\wsl';
const IMAGE: WslImage & { size: number } = {
  name: 'Debian',
  url: 'https://salsa.debian.org/debian/WSL/-/jobs/1/artifacts/raw/Debian_WSL_AMD64_v1.0.0.0.wsl',
  sha256: 'ab'.repeat(32),
  size: 117 * 1_048_576 + 1,
};
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };

/** The messages of the progress notifications, as reported. */
let reports: Array<{ message?: string; increment?: number }>;
type Setup = NonNullable<WslSetupCommandsDeps['setup']>;
let setup: { [K in keyof Setup]: Mock<Setup[K]> };
let useHost: Mock<WslSetupCommandsDeps['useHost']>;
let forgetHost: Mock<WslSetupCommandsDeps['forgetHost']>;
let showLog: Mock<() => void>;
let release: Mock<() => Promise<void>>;

function commands(extra: Partial<WslSetupCommandsDeps> = {}): WslSetupCommands {
  return new WslSetupCommands({
    setup,
    folder: FOLDER,
    isWindows: true,
    logger,
    showLog,
    useHost,
    forgetHost,
    ...extra,
  });
}

function registered(registration: WslRegistration): void {
  setup.registration.mockResolvedValue(registration);
}

/** The modal questions that were shown: their message, detail and button. */
function questions(): Array<{ message: string; detail: string; button: string }> {
  return window.showWarningMessage.mock.calls
    .filter((call: unknown[]) => (call[1] as { modal?: boolean } | undefined)?.modal === true)
    .map((call: unknown[]) => ({ message: call[0] as string, detail: (call[1] as { detail: string }).detail, button: call[2] as string }));
}

beforeEach(() => {
  resetFakeVscode();
  vi.clearAllMocks();
  reports = [];
  setup = {
    checkWsl: vi.fn(async (_signal?: AbortSignal) => '2.6.1'),
    registration: vi.fn(async (): Promise<WslRegistration> => 'none'),
    image: vi.fn(async (_signal?: AbortSignal): Promise<WslImage> => IMAGE),
    setUp: vi.fn(async (_image: unknown, onStep: (step: WslSetupStep) => void, _signal?: AbortSignal) => {
      onStep({ kind: 'download', received: 0, total: IMAGE.size });
      onStep({ kind: 'download', received: IMAGE.size / 2, total: IMAGE.size });
      // Another piece of the same megabyte and percent: no new report.
      onStep({ kind: 'download', received: IMAGE.size / 2 + 1024, total: IMAGE.size });
      onStep({ kind: 'download', received: IMAGE.size, total: IMAGE.size });
      onStep({ kind: 'register' });
      onStep({ kind: 'docker', phase: 'docker' });
      return '29.9.2';
    }),
    remove: vi.fn(async (_signal?: AbortSignal) => undefined),
    removeLeftovers: vi.fn(async () => undefined),
    lock: vi.fn(async () => release),
  };
  release = vi.fn(async () => undefined);
  useHost = vi.fn(async (_host: string) => true);
  forgetHost = vi.fn(async (_host: string) => false);
  showLog = vi.fn();
  window.withProgress.mockImplementation(async (_options: unknown, task: (...args: unknown[]) => Promise<unknown>) =>
    task(
      { report: (value: { message?: string; increment?: number }) => reports.push(value) },
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
    ),
  );
});

describe('Set Up Docker for Devspaces in WSL…', () => {
  it('asks once with the downloads and the folder, sets up the distribution with its steps, and then uses it', async () => {
    window.showWarningMessage.mockResolvedValue(WslSetupTexts.setUp);
    await commands().setUp();
    expect(questions()).toEqual([{ message: WslSetupTexts.confirmSetUp, detail: WslSetupTexts.confirmSetUpDetail(IMAGE, FOLDER), button: WslSetupTexts.setUp }]);
    const [detail] = questions().map((question) => question.detail);
    expect(detail).toContain(`Debian for WSL (118 MB) from ${IMAGE.url}, checked against its SHA-256`);
    expect(detail).toContain(`Folder of the distribution:\n${FOLDER}`);
    expect(detail).toContain('This needs no administrator permission.');
    expect(setup.setUp).toHaveBeenCalledWith(IMAGE, expect.any(Function), expect.any(AbortSignal));
    expect(useHost).toHaveBeenCalledWith(WSL_HOST);
    // The download fills the bar; the other steps only change the text.
    const messages = reports.map((report) => (report.message ?? '').replace(/ \[Show details\]\(command:[^)]*\)$/, ''));
    expect(messages).toEqual([
      WslSetupTexts.checking,
      WslSetupTexts.settingUp,
      `${WslSetupTexts.settingUp} Downloading Debian: 0 of 118 MB.`,
      `${WslSetupTexts.settingUp} Downloading Debian: 58 of 118 MB.`,
      `${WslSetupTexts.settingUp} Downloading Debian: 118 of 118 MB.`,
      `${WslSetupTexts.settingUp} Creating the WSL distribution.`,
      `${WslSetupTexts.settingUp} Installing Docker Engine.`,
    ]);
    // The download fills 40 percent; the other steps start at their places, so the bar is full only at the end.
    expect(reports.map((report) => report.increment).filter((increment) => increment !== undefined)).toEqual([20, 20, 25]);
    expect(setup.lock).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('waits for a setup or a removal in another window, and runs without the lock when it cannot be written', async () => {
    setup.lock.mockResolvedValueOnce(undefined);
    await commands().setUp();
    expect(window.showInformationMessage).toHaveBeenCalledWith(WslSetupTexts.busyElsewhere);
    expect(setup.registration).not.toHaveBeenCalled();
    setup.lock.mockResolvedValueOnce(undefined);
    await commands().remove();
    expect(setup.registration).not.toHaveBeenCalled();
    setup.lock.mockRejectedValueOnce(new Error('EACCES'));
    await commands().remove();
    expect(setup.registration).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('The setup of the WSL distribution of Devspaces runs without a lock for the other windows: EACCES');
  });

  it('says that the setup is done when Devspaces cannot use the distribution yet', async () => {
    window.showWarningMessage.mockResolvedValue(WslSetupTexts.setUp);
    useHost.mockResolvedValue(false);
    await commands().setUp();
    expect(window.showInformationMessage).toHaveBeenCalledWith(WslSetupTexts.readyNotUsed);
    expect(WslSetupTexts.readyNotUsed).toContain(`To use it, choose "${WSL_HOST}" in "Use a Remote Docker Host…".`);
    expect(window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('does nothing when the question is closed', async () => {
    await commands().setUp();
    expect(questions()).toHaveLength(1);
    expect(setup.setUp).not.toHaveBeenCalled();
    expect(useHost).not.toHaveBeenCalled();
  });

  it('sets up a distribution of Devspaces again without a download', async () => {
    registered('own');
    window.showWarningMessage.mockResolvedValue(WslSetupTexts.setUp);
    await commands().setUp();
    expect(setup.image).not.toHaveBeenCalled();
    expect(questions()).toEqual([{ message: WslSetupTexts.confirmRepair, detail: WslSetupTexts.confirmRepairDetail, button: WslSetupTexts.setUp }]);
    expect(setup.setUp).toHaveBeenCalledWith(undefined, expect.any(Function), expect.any(AbortSignal));
    expect(useHost).toHaveBeenCalledWith(WSL_HOST);
    // Only a new distribution needs WSL 2.4.4.
    expect(setup.checkWsl).not.toHaveBeenCalled();
  });

  it('never changes a distribution devspaces that Devspaces did not set up, and offers to use it', async () => {
    registered('foreign');
    window.showInformationMessage.mockResolvedValue(WslSetupTexts.useIt);
    await commands().setUp();
    expect(window.showInformationMessage).toHaveBeenCalledWith(WslSetupTexts.foreign, WslSetupTexts.useIt);
    expect(questions()).toEqual([]);
    expect(setup.setUp).not.toHaveBeenCalled();
    expect(useHost).toHaveBeenCalledWith(WSL_HOST);
  });

  it('offers Install WSL 2 when WSL is missing', async () => {
    setup.checkWsl.mockRejectedValue(new WslSetupError('wslMissing', 'wsl.exe was not found.'));
    window.showErrorMessage.mockResolvedValue(WslSetupTexts.installWsl);
    await commands().setUp();
    expect(window.showErrorMessage).toHaveBeenCalledWith(WslSetupTexts.problem('wslMissing'), WslSetupTexts.installWsl, Actions.showDetails);
    await vi.waitFor(() => expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith(Commands.dockerSetupInstallWsl));
    expect(setup.image).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(`${WslSetupTexts.problem('wslMissing')} wsl.exe was not found.`);
  });

  it('names the problem of a failed step, with Show details, and uses nothing', async () => {
    window.showWarningMessage.mockResolvedValue(WslSetupTexts.setUp);
    setup.setUp.mockRejectedValue(new WslSetupError('dockerFailed', 'E: Unable to locate package curl'));
    window.showErrorMessage.mockResolvedValue(Actions.showDetails);
    await commands().setUp();
    expect(window.showErrorMessage).toHaveBeenCalledWith(WslSetupTexts.problem('dockerFailed'), Actions.showDetails);
    await vi.waitFor(() => expect(showLog).toHaveBeenCalledTimes(1));
    expect(useHost).not.toHaveBeenCalled();
  });

  it('shows nothing after a cancel, and a general message for an unknown error', async () => {
    setup.image.mockRejectedValue(abortError());
    await commands().setUp();
    expect(window.showErrorMessage).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('The setup of the WSL distribution of Devspaces was cancelled.');
    setup.image.mockRejectedValue(new Error('EACCES'));
    await commands().setUp();
    expect(window.showErrorMessage).toHaveBeenCalledWith(WslSetupTexts.failed, Actions.showDetails);
  });

  it('runs one setup at a time in a window', async () => {
    let release: () => void = () => {};
    setup.registration.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve('none'))));
    const instance = commands();
    const first = instance.setUp();
    await instance.setUp();
    expect(window.showInformationMessage).toHaveBeenCalledWith(WslSetupTexts.busy);
    await instance.remove();
    expect(setup.registration).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(setup.checkWsl).toHaveBeenCalledTimes(1);
  });

  it('says that the distribution exists only on Windows, or that LOCALAPPDATA is missing on Windows', async () => {
    await commands({ setup: undefined, folder: undefined, isWindows: false }).setUp();
    await commands({ setup: undefined, folder: undefined, isWindows: false }).remove();
    await commands({ setup: undefined, folder: undefined }).setUp();
    expect(window.showInformationMessage.mock.calls).toEqual([[WslSetupTexts.notWindows], [WslSetupTexts.notWindows], [WslSetupTexts.noLocalAppData]]);
  });
});

describe('Remove the WSL Distribution of Devspaces…', () => {
  it('removes the distribution of Devspaces after a warning and forgets its host', async () => {
    registered('own');
    forgetHost.mockResolvedValue(true);
    window.showWarningMessage.mockResolvedValue(WslSetupTexts.remove);
    await commands().remove();
    expect(questions()).toEqual([{ message: WslSetupTexts.confirmRemove, detail: WslSetupTexts.confirmRemoveDetail(FOLDER), button: WslSetupTexts.remove }]);
    expect(questions()[0].detail).toContain('This cannot be undone.');
    expect(setup.remove).toHaveBeenCalledTimes(1);
    expect(forgetHost).toHaveBeenCalledWith(WSL_HOST);
    expect(window.showInformationMessage).toHaveBeenCalledWith(WslSetupTexts.removed(true));
    expect(WslSetupTexts.removed(true)).toBe('The WSL distribution of Devspaces was removed. Devspaces now uses the local Docker.');
  });

  it('removes nothing when the warning is closed', async () => {
    registered('own');
    await commands().remove();
    expect(setup.remove).not.toHaveBeenCalled();
    expect(forgetHost).not.toHaveBeenCalled();
  });

  it('never removes a distribution devspaces that Devspaces did not set up', async () => {
    registered('foreign');
    await commands().remove();
    expect(window.showInformationMessage).toHaveBeenCalledWith(WslSetupTexts.foreignRemove);
    expect(questions()).toEqual([]);
    expect(setup.remove).not.toHaveBeenCalled();
    expect(forgetHost).not.toHaveBeenCalled();
  });

  it('forgets the host of a distribution that is gone and removes the files of a setup that did not end, also without WSL', async () => {
    await commands().remove();
    setup.registration.mockRejectedValue(new WslSetupError('wslMissing', 'wsl.exe was not found.'));
    forgetHost.mockRejectedValue(new Error('EBUSY'));
    await commands().remove();
    expect(forgetHost.mock.calls).toEqual([[WSL_HOST], [WSL_HOST]]);
    expect(setup.removeLeftovers).toHaveBeenCalledTimes(2);
    expect(window.showInformationMessage.mock.calls).toEqual([[WslSetupTexts.notInstalled], [WslSetupTexts.notInstalled]]);
    expect(setup.remove).not.toHaveBeenCalled();
  });

  it('says that the distribution is gone when only the list of Devspaces cannot be changed', async () => {
    registered('own');
    window.showWarningMessage.mockResolvedValue(WslSetupTexts.remove);
    forgetHost.mockRejectedValue(new Error('EBUSY: the file is locked'));
    await commands().remove();
    expect(setup.remove).toHaveBeenCalledTimes(1);
    expect(window.showErrorMessage).toHaveBeenCalledWith(WslSetupTexts.removedStillListed, Actions.showDetails);
    expect(window.showErrorMessage).not.toHaveBeenCalledWith(WslSetupTexts.removeFailedUnknown, Actions.showDetails);
    expect(logger.error).toHaveBeenCalledWith(`${WSL_HOST} could not be removed from the list of Devspaces: EBUSY: the file is locked`);
  });

  it('logs a cancelled check as a cancelled removal', async () => {
    setup.registration.mockRejectedValue(abortError());
    await commands().remove();
    expect(logger.info).toHaveBeenCalledWith('The removal of the WSL distribution of Devspaces was cancelled.');
    expect(window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('removes nothing when the registry does not tell whether Devspaces set up the distribution', async () => {
    setup.registration.mockRejectedValue(new WslSetupError('registryFailed', 'WSL lists the distribution devspaces, but the registry cannot be read.'));
    await commands().remove();
    expect(window.showErrorMessage).toHaveBeenCalledWith(WslSetupTexts.problem('registryFailed'), Actions.showDetails);
    expect(setup.remove).not.toHaveBeenCalled();
    expect(forgetHost).not.toHaveBeenCalled();
  });

  it('keeps the host when WSL refuses the removal, and says so', async () => {
    registered('own');
    window.showWarningMessage.mockResolvedValue(WslSetupTexts.remove);
    setup.remove.mockRejectedValue(new WslSetupError('removeFailed', 'Access is denied.'));
    await commands().remove();
    expect(window.showErrorMessage).toHaveBeenCalledWith(WslSetupTexts.problem('removeFailed'), Actions.showDetails);
    expect(forgetHost).not.toHaveBeenCalled();
  });
});

describe('the texts of the steps', () => {
  it('name each step, with the megabytes of the download', () => {
    expect(WslSetupTexts.step({ kind: 'download', received: 3 * 1_048_576, total: undefined })).toBe('Downloading Debian: 3 MB.');
    expect(WslSetupTexts.step({ kind: 'download', received: 0, total: 10 * 1_048_576 })).toBe('Downloading Debian: 0 of 10 MB.');
    expect(WslSetupTexts.step({ kind: 'docker', phase: 'packages' })).toBe('Installing the base packages.');
    expect(WslSetupTexts.step({ kind: 'docker', phase: 'repository' })).toBe('Adding the package repository of Docker.');
    expect(WslSetupTexts.step({ kind: 'restart' })).toBe('Restarting the WSL distribution.');
    expect(WslSetupTexts.step({ kind: 'start' })).toBe('Starting Docker.');
  });

  it('give the question a size only when it is known', () => {
    const { size: _size, ...withoutSize } = IMAGE;
    expect(WslSetupTexts.confirmSetUpDetail(withoutSize, FOLDER)).toContain(`- Debian for WSL from ${IMAGE.url}`);
  });
});
