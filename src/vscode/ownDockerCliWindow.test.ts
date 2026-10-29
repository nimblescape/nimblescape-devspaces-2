// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);
vi.mock('../core/docker/ownDockerCli', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/docker/ownDockerCli')>()),
  installOwnDockerCli: vi.fn(),
}));

import { installOwnDockerCli, OWN_DOCKER_CLI_VERSION, type InstallOwnDockerCliOptions } from '../core/docker/ownDockerCli';
import { abortError, silentLogger, type Logger } from '../core/ports';
import { installOwnDockerCliWithProgress, OwnDockerCliTexts } from './ownDockerCliWindow';
import { EventEmitter, fakeVscode, resetFakeVscode } from './testing/fakeVscode';

const install = vi.mocked(installOwnDockerCli);

/** withProgress that records the reported messages and offers a Cancel button to the test. */
function scriptWithProgress(): { options: { cancellable?: boolean }; messages: string[]; cancel(): void }[] {
  const runs: { options: { cancellable?: boolean }; messages: string[]; cancel(): void }[] = [];
  fakeVscode.window.withProgress.mockImplementation(async (options, task) => {
    const cancellation = new EventEmitter<void>();
    const run = { options, messages: [] as string[], cancel: () => cancellation.fire() };
    runs.push(run);
    return task({ report: (value: { message?: string }) => run.messages.push(value.message ?? '') }, { isCancellationRequested: false, onCancellationRequested: cancellation.event });
  });
  return runs;
}

function logged(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  return { logger: { ...silentLogger, warn: (line) => warnings.push(line) }, warnings };
}

const options = { folder: '/s/docker-cli', platform: 'linux' as const, arch: 'x64' };

describe('installOwnDockerCliWithProgress', () => {
  beforeEach(() => {
    resetFakeVscode();
    install.mockReset();
  });

  it('shows the download with its megabytes in a notification that can be cancelled, and returns the program', async () => {
    const runs = scriptWithProgress();
    install.mockImplementation(async (given: InstallOwnDockerCliOptions) => {
      given.onProgress?.(1_000, 3 * 1_048_576);
      given.onProgress?.(1_048_576, 3 * 1_048_576);
      given.onProgress?.(1_048_577, 3 * 1_048_576);
      return '/s/docker-cli/1.2.3/docker';
    });
    await expect(installOwnDockerCliWithProgress({ ...options, logger: silentLogger, fallback: undefined })).resolves.toBe('/s/docker-cli/1.2.3/docker');
    expect(runs).toHaveLength(1);
    expect(runs[0].options.cancellable).toBe(true);
    expect(runs[0].messages[0]).toContain(OwnDockerCliTexts.downloading);
    // One report for each new megabyte.
    expect(runs[0].messages).toHaveLength(3);
    expect(runs[0].messages[1]).toContain(OwnDockerCliTexts.progress(0, 3));
    expect(runs[0].messages[2]).toContain(OwnDockerCliTexts.progress(1, 3));
    expect(install.mock.calls[0][0]).toMatchObject({ folder: '/s/docker-cli', platform: 'linux', arch: 'x64' });
    expect(fakeVscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(fakeVscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('shows one notification for the calls at the same time', async () => {
    const runs = scriptWithProgress();
    let finish: (cli: string) => void = () => undefined;
    install.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const first = installOwnDockerCliWithProgress({ ...options, logger: silentLogger, fallback: undefined });
    const second = installOwnDockerCliWithProgress({ ...options, logger: silentLogger, fallback: undefined, showFailure: false });
    await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(1));
    finish('/s/docker-cli/1.2.3/docker');
    await expect(Promise.all([first, second])).resolves.toEqual(['/s/docker-cli/1.2.3/docker', '/s/docker-cli/1.2.3/docker']);
    expect(runs).toHaveLength(1);
    // Afterwards, a new call starts a new one.
    install.mockResolvedValue('/s/docker-cli/1.2.3/docker');
    await installOwnDockerCliWithProgress({ ...options, logger: silentLogger, fallback: undefined });
    expect(runs).toHaveLength(2);
  });

  it('says which Docker CLI the window uses when the download fails', async () => {
    scriptWithProgress();
    install.mockRejectedValue(new Error('offline'));
    const { logger, warnings } = logged();
    await expect(installOwnDockerCliWithProgress({ ...options, logger, fallback: '/usr/bin/docker' })).resolves.toBeUndefined();
    expect(warnings).toEqual([`The Docker CLI ${OWN_DOCKER_CLI_VERSION} of Devspaces could not be installed: offline`]);
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledWith(OwnDockerCliTexts.failedWithFallback('offline'));
    await installOwnDockerCliWithProgress({ ...options, logger, fallback: undefined });
    expect(fakeVscode.window.showErrorMessage).toHaveBeenCalledWith(OwnDockerCliTexts.failedWithoutFallback('offline'));
  });

  it('stops the download with Cancel, and only logs a failure with showFailure false', async () => {
    const runs = scriptWithProgress();
    install.mockImplementation(
      (given: InstallOwnDockerCliOptions) =>
        new Promise((_resolve, reject) => {
          given.signal?.addEventListener('abort', () => reject(abortError()));
          runs[0].cancel();
        }),
    );
    const { logger, warnings } = logged();
    await expect(installOwnDockerCliWithProgress({ ...options, logger, fallback: undefined, showFailure: false })).resolves.toBeUndefined();
    expect(warnings).toEqual([`The Docker CLI ${OWN_DOCKER_CLI_VERSION} of Devspaces could not be installed: ${OwnDockerCliTexts.cancelled}`]);
    expect(fakeVscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(fakeVscode.window.showErrorMessage).not.toHaveBeenCalled();
  });
});
