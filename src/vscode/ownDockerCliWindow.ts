// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The download of the Docker CLI of Devspaces (core/docker/ownDockerCli.ts) when it is not installed yet: in the window
// of a devspace on another computer, and for "Use a Remote Docker Host…" on a computer without a Docker CLI. With a
// progress notification that can be cancelled, and a message when it fails. The window then uses the Docker CLI of
// this computer, if it has one; the command sets no remote host.
import { errorMessage } from '../core/errors';
import { installOwnDockerCli, OWN_DOCKER_CLI_VERSION } from '../core/docker/ownDockerCli';
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
  failedForRemoteHost: (reason: string) =>
    `The Docker CLI ${OWN_DOCKER_CLI_VERSION} of Devspaces could not be downloaded, and this computer has no Docker CLI, so Devspaces cannot use a remote Docker host. ${reason}`,
} as const;

export interface OwnDockerCliWindowOptions {
  /** StoragePaths.dockerCliDir. */
  folder: string;
  platform: NodeJS.Platform;
  arch: string;
  logger: Logger;
  /** The Docker CLI of this computer, which the window uses when the download fails. */
  fallback: string | undefined;
  /**
   * The message of a failed download, in place of the one of the window (failedForRemoteHost, for "Use a Remote Docker
   * Host…"); then a cancel shows no message.
   */
  failed?: (reason: string) => string;
}

/**
 * Installs the Docker CLI of Devspaces (installOwnDockerCli) with a progress notification. Its path, or undefined when
 * the download failed or was cancelled: then a message says which Docker CLI the window uses (shown without waiting).
 */
export async function installOwnDockerCliWithProgress(options: OwnDockerCliWindowOptions): Promise<string | undefined> {
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
    if (options.failed !== undefined) {
      if (!isAbortError(error)) void showErrorMessage(options.failed(reason));
    } else if (options.fallback !== undefined) void showWarningMessage(OwnDockerCliTexts.failedWithFallback(reason));
    else void showErrorMessage(OwnDockerCliTexts.failedWithoutFallback(reason));
    return undefined;
  }
}
