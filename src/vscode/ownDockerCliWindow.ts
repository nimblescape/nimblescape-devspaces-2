// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The download of the Docker CLI of Devspaces (core/docker/ownDockerCli.ts) when it is not installed yet, with a
// progress notification that can be cancelled: in the window of a devspace on another computer, which then uses the
// Docker CLI of this computer when the download fails, and says so; and before such a window opens, where a failure is
// only logged (that window tries again).
import { errorMessage } from '../core/errors';
import { installOwnDockerCli, OWN_DOCKER_CLI_VERSION, ownDockerCliPath } from '../core/docker/ownDockerCli';
import { isAbortError, type Logger } from '../core/ports';
import { showErrorMessage, showWarningMessage } from './notifications';
import { withNotificationProgress } from './progress';

export const OwnDockerCliTexts = {
  downloading: `Downloading the Docker CLI ${OWN_DOCKER_CLI_VERSION} of Devspaces…`,
  progress: (receivedMb: number, totalMb: number | undefined) => (totalMb === undefined ? `${receivedMb} MB` : `${receivedMb} of ${totalMb} MB`),
  failedWithFallback: (reason: string) =>
    `The Docker CLI ${OWN_DOCKER_CLI_VERSION} of Devspaces could not be downloaded, so this window uses the Docker CLI of this computer. ${reason}`,
  failedWithoutFallback: (reason: string) =>
    `The Docker CLI ${OWN_DOCKER_CLI_VERSION} of Devspaces could not be downloaded, and this computer has no Docker CLI, so this window cannot connect to its devspace. ${reason}`,
  cancelled: 'The download of the Docker CLI of Devspaces was cancelled.',
} as const;

export interface OwnDockerCliWindowOptions {
  /** StoragePaths.dockerCliDir. */
  folder: string;
  platform: NodeJS.Platform;
  arch: string;
  logger: Logger;
  /** The Docker CLI of this computer, which the window uses when the download fails. */
  fallback: string | undefined;
  /** False: a failure is only logged, for the download before a window opens. Default: true (a message too). */
  showFailure?: boolean;
}

/**
 * Installs the Docker CLI of Devspaces (installOwnDockerCli) with a progress notification. Its path, or undefined when
 * the download failed or was cancelled: then a message says which Docker CLI the window uses (shown without waiting),
 * unless `showFailure` is false.
 */
export function installOwnDockerCliWithProgress(options: OwnDockerCliWindowOptions): Promise<string | undefined> {
  // Calls at the same time (two opens) share one notification, with its progress and its Cancel.
  const target = ownDockerCliPath(options.folder, options.platform);
  const running = downloads.get(target);
  if (running !== undefined) return running;
  const download = downloadWithProgress(options).finally(() => downloads.delete(target));
  downloads.set(target, download);
  return download;
}

/** The downloads with a notification that run in this extension host, by the path of the program. */
const downloads = new Map<string, Promise<string | undefined>>();

async function downloadWithProgress(options: OwnDockerCliWindowOptions): Promise<string | undefined> {
  const { logger } = options;
  try {
    return await withNotificationProgress({ title: OwnDockerCliTexts.downloading, cancellable: true }, async (progress, token) => {
      const controller = new AbortController();
      const cancellation = token.onCancellationRequested(() => controller.abort());
      let shownMb = -1;
      try {
        return await installOwnDockerCli({
          folder: options.folder,
          platform: options.platform,
          arch: options.arch,
          logger,
          signal: controller.signal,
          onProgress: (received, total) => {
            const mb = Math.floor(received / 1_048_576);
            if (mb === shownMb) return;
            shownMb = mb;
            progress.report({ message: OwnDockerCliTexts.progress(mb, total === undefined ? undefined : Math.ceil(total / 1_048_576)) });
          },
        });
      } finally {
        cancellation.dispose();
      }
    });
  } catch (error) {
    const reason = isAbortError(error) ? OwnDockerCliTexts.cancelled : errorMessage(error);
    logger.warn(`The Docker CLI ${OWN_DOCKER_CLI_VERSION} of Devspaces could not be installed: ${reason}`);
    if (options.showFailure === false) return undefined;
    if (options.fallback !== undefined) void showWarningMessage(OwnDockerCliTexts.failedWithFallback(reason));
    else void showErrorMessage(OwnDockerCliTexts.failedWithoutFallback(reason));
    return undefined;
  }
}
