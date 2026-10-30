// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// "Set Up Docker for Devspaces in WSL…" and "Remove the WSL Distribution of Devspaces…" on Windows (docs/architecture.md "The
// WSL distribution of Devspaces"): the setup asks once with the downloads and the folder, shows its steps in a
// progress notification, and then makes the distribution the Docker host of Devspaces, as "Use a Remote Docker Host…"
// does. The removal asks first, because it deletes every devspace in the distribution. A distribution with the name
// devspaces that Devspaces did not set up is never changed or removed. The work is in src/core/docker/wslSetup.ts.
import * as vscode from 'vscode';
import { WSL_DISTRIBUTION, WSL_HOST } from '../core/docker/dockerHost';
import {
  WSL_DISTRIBUTION_LIST_URL,
  WSL_FROM_FILE_VERSION,
  isWslSetupError,
  type ProvisionPhase,
  type WslImage,
  type WslRegistration,
  type WslSetup,
  type WslSetupProblem,
  type WslSetupStep,
} from '../core/docker/wslSetup';
import { errorMessage } from '../core/errors';
import { Actions } from '../core/messages';
import { isAbortError, type Logger } from '../core/ports';
import { Commands } from './commands';
import { DockerSetupUiTexts } from './dockerSetup';
import { showErrorMessage, showInformationMessage, showWarningMessage } from './notifications';
import { withNotificationProgress } from './progress';

const PHASE_TEXTS: Record<ProvisionPhase, string> = {
  packages: 'Installing the base packages.',
  repository: 'Adding the package repository of Docker.',
  docker: 'Installing Docker Engine.',
};

/** The part of the bar of the setup that the download fills with its bytes, in percent. */
const DOWNLOAD_PART = 40;
/** Where the other steps start on the bar, in percent, so that the bar is full only at the end. */
const PHASE_STARTS: Record<ProvisionPhase, number> = { packages: 50, repository: 60, docker: 65 };

/** The place of `step` on the bar of the setup, in percent. */
function barPosition(step: WslSetupStep): number {
  switch (step.kind) {
    case 'download':
      return step.total ? Math.min(DOWNLOAD_PART, Math.floor((step.received * DOWNLOAD_PART) / step.total)) : 0;
    case 'register':
      return DOWNLOAD_PART;
    case 'docker':
      return PHASE_STARTS[step.phase];
    case 'restart':
      return 90;
    case 'start':
      return 95;
  }
}

/** User-visible texts of the WSL distribution of Devspaces (plain language). No `vscode` in them. */
export const WslSetupTexts = {
  checking: 'Checking WSL…',
  settingUp: 'Setting up Docker for Devspaces…',
  removing: 'Removing the WSL distribution of Devspaces…',
  notWindows: 'The WSL distribution of Devspaces exists only on Windows.',
  noLocalAppData: 'Devspaces does not find the folder LOCALAPPDATA of your Windows user, where the WSL distribution of Devspaces has its files.',
  busy: 'The WSL distribution of Devspaces is being set up or removed in this window. Try again after that.',
  busyElsewhere: 'The WSL distribution of Devspaces is being set up or removed in another VS Code window. Try again after that.',
  changedElsewhere: 'The WSL distribution of Devspaces was set up or removed in another VS Code window after the check, so nothing was changed. Try again.',
  confirmSetUp: 'Set up Docker for Devspaces?',
  confirmSetUpDetail: (image: WslImage, folder: string) =>
    [
      `Devspaces creates its own WSL distribution "${WSL_DISTRIBUTION}" with Docker Engine, and then uses Docker there. Your other WSL distributions and Docker Desktop stay as they are. This needs no administrator permission.`,
      `Downloads:\n- ${image.name} for WSL${image.size === undefined ? '' : ` (${Math.ceil(image.size / 1_048_576)} MB)`} from ${image.url}, checked against its SHA-256 in the list of WSL distributions of Microsoft (${WSL_DISTRIBUTION_LIST_URL})\n- Docker Engine from download.docker.com, and the packages that it needs from Debian: about 120 MB`,
      `Folder of the distribution:\n${folder}`,
      'The distribution grows with your devspaces, their images and their volumes. Devspaces runs its commands there as root with wsl.exe.',
    ].join('\n\n'),
  confirmRepair: 'Set up Docker in the WSL distribution of Devspaces again?',
  confirmRepairDetail: `The WSL distribution "${WSL_DISTRIBUTION}" of Devspaces exists. Devspaces installs Docker Engine there again from download.docker.com, or updates it, and then restarts the distribution: devspaces that run there stop, and their windows lose the connection. Your devspaces stay. Then Devspaces uses Docker there.`,
  setUp: 'Set Up',
  confirmRemove: 'Remove the WSL distribution of Devspaces?',
  confirmRemoveDetail: (folder: string) =>
    [
      `"wsl --unregister ${WSL_DISTRIBUTION}" deletes the distribution with everything in it: all your devspaces there with the changes that you did not push, their images and their volumes. This cannot be undone. The windows of these devspaces lose the connection.`,
      `The folder of the distribution is removed too:\n${folder}`,
    ].join('\n\n'),
  remove: 'Remove',
  /**
   * `nowLocal`: Devspaces used it, and now uses the local Docker (when that is not supported, its own warning says so).
   * `keptFolder`: the folder of the distribution, when it stays.
   */
  removed: (nowLocal: boolean, keptFolder?: string) =>
    `The WSL distribution of Devspaces was removed.${nowLocal ? ' Devspaces now uses the local Docker.' : ''}${keptFolder === undefined ? '' : ` Its folder stays (the log of Devspaces says why): ${keptFolder}`}`,
  removedStillListed: `The WSL distribution of Devspaces was removed, but Devspaces could not take "${WSL_HOST}" out of its list of Docker hosts. Take it out with "Remove a Host from the List…".`,
  readyNotUsed: `Docker Engine runs in the WSL distribution of Devspaces, but Devspaces does not use it yet. To use it, choose "${WSL_HOST}" in "Use a Remote Docker Host…".`,
  notInstalled: 'The WSL distribution of Devspaces is not installed.',
  foreign: `A WSL distribution with the name "${WSL_DISTRIBUTION}" exists, but Devspaces did not set it up, so Devspaces does not change it. Use it as it is?`,
  foreignRemove: `The WSL distribution "${WSL_DISTRIBUTION}" was not set up by Devspaces, so Devspaces does not remove it. If you do not need it, remove it in a terminal with "wsl --unregister ${WSL_DISTRIBUTION}".`,
  useIt: 'Use It',
  dockerDesktopIntegrates: `Docker Desktop has its WSL integration turned on for the WSL distribution "${WSL_DISTRIBUTION}" of Devspaces. Docker warns that Docker Desktop and a Docker Engine in the same WSL distribution can conflict. Turn it off in Docker Desktop: Settings > Resources > WSL integration.`,
  installWsl: 'Install WSL 2',
  failed: 'The WSL distribution of Devspaces could not be set up.',
  removeFailedUnknown: 'The WSL distribution of Devspaces could not be removed.',
  step: (step: WslSetupStep): string => {
    switch (step.kind) {
      case 'download': {
        const total = step.total === undefined ? undefined : Math.ceil(step.total / 1_048_576);
        // The end of the download shows the total, also when its last megabyte is not full.
        const received = step.total !== undefined && step.received >= step.total ? total : Math.floor(step.received / 1_048_576);
        return `Downloading Debian: ${DockerSetupUiTexts.downloadProgress(received ?? 0, total)}`;
      }
      case 'register':
        return 'Creating the WSL distribution.';
      case 'docker':
        return PHASE_TEXTS[step.phase];
      case 'restart':
        return 'Restarting the WSL distribution.';
      case 'start':
        return 'Starting Docker.';
    }
  },
  problem: (problem: WslSetupProblem): string => {
    switch (problem) {
      case 'wslMissing':
        return 'WSL is not installed on this computer. Install WSL 2 first: Windows asks for administrator permission, and you restart the computer afterwards.';
      case 'wslTooOld':
        return `The WSL of this computer is too old: Devspaces needs WSL ${WSL_FROM_FILE_VERSION.join('.')} or later. Run "wsl --update" in a terminal, then try again.`;
      case 'wslNotAnswering':
        return 'WSL does not answer. Try again. When it does not help, run "wsl --shutdown" in a terminal.';
      case 'listFailed':
        return 'The list of WSL distributions could not be loaded from GitHub. Check the internet connection and try again.';
      case 'noImage':
        return 'The list of WSL distributions has no Debian file for this computer.';
      case 'downloadFailed':
        return 'The Debian file for WSL could not be downloaded. Check the internet connection and try again.';
      case 'registerFailed':
        return `WSL could not create the distribution "${WSL_DISTRIBUTION}". The details show why.`;
      case 'dockerFailed':
        return `Docker Engine could not be installed in the WSL distribution "${WSL_DISTRIBUTION}". The details show why. Set up Docker for Devspaces again to go on from there.`;
      case 'dockerNotRunning':
        return `Docker does not start in the WSL distribution "${WSL_DISTRIBUTION}". The details show why.`;
      case 'removeFailed':
        return `WSL could not remove the distribution "${WSL_DISTRIBUTION}". The details show why.`;
      case 'registryFailed':
        return `Devspaces cannot tell whether it set up the WSL distribution "${WSL_DISTRIBUTION}", because it cannot read the list of WSL distributions in the registry of Windows. The details show why.`;
    }
  },
} as const;

export interface WslSetupCommandsDeps {
  /** The setup of this computer; undefined where there is none (not Windows, or no LOCALAPPDATA). */
  setup: Pick<WslSetup, 'checkWsl' | 'registration' | 'image' | 'setUp' | 'remove' | 'removeLeftovers' | 'locked' | 'separate'> | undefined;
  /** The folder of the distribution (wslSetupFolder), for the questions. */
  folder: string | undefined;
  /** For the message without `setup`. */
  isWindows: boolean;
  logger: Logger;
  showLog: () => void;
  /** Devspaces uses the host after its test (RemoteDockerCommands.useHost); true when it does. */
  useHost: (host: string) => Promise<boolean>;
  /**
   * The host leaves the list of Devspaces (RemoteDockerCommands.forgetHost): whether it was the Docker host, and
   * whether the local Docker that takes its place is supported.
   */
  forgetHost: (host: string) => Promise<'notDockerHost' | 'local' | 'unsupported'>;
  /**
   * The distribution is gone, or a new one takes its place: the answer about its Monitor goes (a new distribution is a
   * new engine, which is asked again, also after a removal with `wsl --unregister` by hand), and its start entry
   * (WslKeeper.removeStartEntry). Never rejects.
   */
  forgetDistribution?: () => Promise<void>;
  /**
   * Whether Docker Desktop has its WSL integration on for the distribution (dockerDesktopIntegrates), also by its
   * integration with the default distribution of WSL when the distribution is that default (`isDefault`). Never rejects.
   */
  dockerDesktopIntegrates?: (isDefault: boolean) => Promise<boolean>;
}

export class WslSetupCommands {
  /** A setup or a removal runs in this window. */
  private running = false;
  /** This window warned that Docker Desktop integrates the distribution. */
  private dockerDesktopWarned = false;

  constructor(private readonly deps: WslSetupCommandsDeps) {}

  /**
   * At the start of a window and after a setup: the WSL distribution of Devspaces is not the default distribution of
   * WSL (WslSetup.separate; also after the user removed the default distribution, when WSL made this one the default),
   * and a warning, once in the window, while Docker Desktop has its WSL integration on for it. Only for a distribution
   * that Devspaces set up, and only while the registry has the distribution of Docker Desktop (or cannot be read; then
   * only the list of Docker Desktop counts). Never throws (logged).
   */
  async checkSeparation(): Promise<void> {
    try {
      const separation = await this.deps.setup?.separate();
      if (separation === undefined || separation.state === 'none' || separation.dockerDesktop === false) return;
      await this.warnDockerDesktop(separation.state === 'default');
    } catch (error) {
      this.deps.logger.error('The WSL distribution of Devspaces could not be checked.', error);
    }
  }

  /**
   * "Set Up Docker for Devspaces in WSL…": checks WSL, asks once with the downloads and the folder, sets up the distribution
   * with a progress notification, and makes it the Docker host of Devspaces. A distribution that Devspaces set up
   * before is set up again (Docker Engine installed or updated); one that the user made is only offered for use. Only
   * a new distribution needs the version of WSL that registers a file. Never throws.
   */
  async setUp(): Promise<void> {
    const { setup, folder } = this.deps;
    if (setup === undefined || folder === undefined) {
      this.inform(this.deps.isWindows ? WslSetupTexts.noLocalAppData : WslSetupTexts.notWindows);
      return;
    }
    if (!this.start()) return;
    try {
      const plan = await this.withProgress(WslSetupTexts.checking, async (signal) => {
        const registration = await setup.registration(signal);
        if (registration !== 'none') return { registration };
        const version = await setup.checkWsl(signal);
        this.deps.logger.info(`WSL ${version} is installed.`);
        return { registration, image: await setup.image(signal) };
      });
      if (plan.registration === 'foreign') {
        this.deps.logger.info(`A WSL distribution ${WSL_DISTRIBUTION} exists that Devspaces did not set up; Devspaces does not change it.`);
        // Not awaited: a message that nobody answers must not block the next setup or removal here.
        showInformationMessage(WslSetupTexts.foreign, WslSetupTexts.useIt)
          .then((choice) => (choice === WslSetupTexts.useIt ? this.deps.useHost(WSL_HOST) : undefined))
          .then(undefined, (error: unknown) => this.deps.logger.error(`${WSL_HOST} could not be used: ${errorMessage(error)}`));
        return;
      }
      const confirmed =
        plan.image === undefined
          ? await this.confirm(WslSetupTexts.confirmRepair, WslSetupTexts.confirmRepairDetail, WslSetupTexts.setUp)
          : await this.confirm(WslSetupTexts.confirmSetUp, WslSetupTexts.confirmSetUpDetail(plan.image, folder), WslSetupTexts.setUp);
      if (!confirmed) return;
      this.deps.logger.info(plan.image === undefined ? `The WSL distribution ${WSL_DISTRIBUTION} is set up again.` : `The WSL distribution ${WSL_DISTRIBUTION} is set up in ${folder}.`);
      // The lock of all windows only from here: an open question holds nothing. Under the lock, the distribution must
      // still be as checked: another window may have set it up or removed it meanwhile. Devspaces chooses the host under
      // the lock too, so that a removal in another window does not come between.
      const done = await setup.locked(async () => {
        const ready = await this.withProgress(WslSetupTexts.settingUp, async (signal, report) => {
          if ((await setup.registration(signal)) !== plan.registration) return false;
          if (plan.registration === 'none') await this.deps.forgetDistribution?.();
          await setup.setUp(plan.image, (step) => report(step), signal);
          return true;
        });
        if (ready) await this.checkSeparation();
        // useHost shows its own problem.
        return ready && { used: await this.deps.useHost(WSL_HOST) };
      });
      const result = this.finished(done);
      // This message says that the setup itself is done.
      if (result !== undefined && !result.used) this.inform(WslSetupTexts.readyNotUsed);
    } catch (error) {
      this.showFailure(error, WslSetupTexts.failed, 'The setup of the WSL distribution of Devspaces was cancelled.');
    } finally {
      this.running = false;
    }
  }

  /**
   * "Remove the WSL Distribution of Devspaces…": after a warning, `wsl --unregister devspaces` and the folder of the
   * distribution; the host leaves the list of Devspaces, and when Devspaces used it, the local Docker takes its place.
   * Only a distribution that Devspaces set up. Never throws.
   */
  async remove(): Promise<void> {
    const { setup, folder } = this.deps;
    if (setup === undefined || folder === undefined) {
      this.inform(this.deps.isWindows ? WslSetupTexts.noLocalAppData : WslSetupTexts.notWindows);
      return;
    }
    if (!this.start()) return;
    try {
      const registration = await this.withProgress(WslSetupTexts.checking, (signal) => this.removalCheck(setup, signal));
      if (registration === 'foreign') {
        this.deps.logger.info(`The WSL distribution ${WSL_DISTRIBUTION} was not set up by Devspaces; it is not removed.`);
        this.inform(WslSetupTexts.foreignRemove);
        return;
      }
      if (registration === 'none') {
        // Removed by hand, or a setup that did not end: the host leaves the list, and the files of that setup go. Under
        // the lock of all windows, as below, and only while no other window has set up the distribution meanwhile.
        const cleaned = await setup.locked(async () => {
          if ((await this.removalCheck(setup)) !== 'none') return false;
          await this.deps.forgetHost(WSL_HOST).catch((error: unknown) => {
            this.deps.logger.warn(`${WSL_HOST} could not be removed from the list of Devspaces: ${errorMessage(error)}`);
          });
          await setup.removeLeftovers();
          await this.deps.forgetDistribution?.();
          return true;
        });
        if (this.finished(cleaned)) this.inform(WslSetupTexts.notInstalled);
        return;
      }
      if (!(await this.confirm(WslSetupTexts.confirmRemove, WslSetupTexts.confirmRemoveDetail(folder), WslSetupTexts.remove))) return;
      // `wsl --unregister` is not cancelled: a half removed distribution would help nobody. The host leaves the list
      // under the lock too, so that a setup in another window afterwards keeps its host.
      const done = await setup.locked(async () =>
        withNotificationProgress({ title: WslSetupTexts.removing }, async () => {
          if ((await this.removalCheck(setup)) !== 'own') return false;
          const folderGone = await setup.remove();
          await this.deps.forgetDistribution?.();
          const forgotten = await this.deps.forgetHost(WSL_HOST).catch((error: unknown) => ({ error }));
          return { folderGone, forgotten };
        }),
      );
      const result = this.finished(done);
      if (result === undefined) return;
      if (typeof result.forgotten === 'object') {
        // The distribution is gone; only the list of Devspaces still names it.
        this.deps.logger.error(`${WSL_HOST} could not be removed from the list of Devspaces: ${errorMessage(result.forgotten.error)}`);
        this.showError(WslSetupTexts.removedStillListed);
        return;
      }
      this.inform(WslSetupTexts.removed(result.forgotten === 'local', result.folderGone ? undefined : folder));
    } catch (error) {
      this.showFailure(error, WslSetupTexts.removeFailedUnknown, 'The removal of the WSL distribution of Devspaces was cancelled.');
    } finally {
      this.running = false;
    }
  }

  /** The registration for the removal (WslSetup.registration, `sure`): `none` without WSL. */
  private async removalCheck(setup: NonNullable<WslSetupCommandsDeps['setup']>, signal?: AbortSignal): Promise<WslRegistration> {
    try {
      return await setup.registration(signal, true);
    } catch (error) {
      if (!isWslSetupError(error) || error.problem !== 'wslMissing') throw error;
      this.deps.logger.info(`WSL is not installed: ${error.message}`);
      return 'none';
    }
  }

  /**
   * The result of the work under the lock of all windows; else undefined, after its message: another window holds the
   * lock (undefined), or it changed the distribution after the check (false).
   */
  private finished<T>(done: { value: T | false } | undefined): T | undefined {
    if (done === undefined) this.inform(WslSetupTexts.busyElsewhere);
    else if (done.value === false) this.inform(WslSetupTexts.changedElsewhere);
    else return done.value;
    return undefined;
  }

  /**
   * False (with a message) while a setup or a removal runs in this window; else marks one as running. The work itself
   * runs with WslSetup.locked, for all windows.
   */
  private start(): boolean {
    if (this.running) {
      this.inform(WslSetupTexts.busy);
      return false;
    }
    this.running = true;
    return true;
  }

  /** `task` with a cancellable progress notification; `report` shows a step of the setup. */
  private withProgress<T>(title: string, task: (signal: AbortSignal, report: (step: WslSetupStep) => void) => Promise<T>): Promise<T> {
    return Promise.resolve(
      withNotificationProgress({ title, cancellable: true }, async (progress, token) => {
        const abort = new AbortController();
        const subscription = token.onCancellationRequested(() => abort.abort());
        let percent = 0;
        let shown: string | undefined;
        try {
          return await task(abort.signal, (step) => {
            // The download fills its part of the bar with its bytes; each other step starts at its place.
            const next = Math.max(percent, barPosition(step));
            const message = WslSetupTexts.step(step);
            // The download reports each piece that arrives; the notification changes only with its text or its bar.
            if (message === shown && next === percent) return;
            progress.report({ message, increment: next > percent ? next - percent : undefined });
            shown = message;
            percent = next;
          });
        } finally {
          subscription.dispose();
        }
      }),
    );
  }

  /** Modal question; true only for the confirming button. */
  private async confirm(message: string, detail: string, button: string): Promise<boolean> {
    return (await showWarningMessage(message, { modal: true, detail }, button)) === button;
  }

  /** The message of a failure: `unknown` for an error that is not a WslSetupError; a cancel is only logged (`cancelled`). */
  private showFailure(error: unknown, unknown: string, cancelled: string): void {
    if (isAbortError(error)) {
      this.deps.logger.info(cancelled);
      return;
    }
    if (!isWslSetupError(error)) {
      this.deps.logger.error(unknown, error);
      this.showError(unknown);
      return;
    }
    this.deps.logger.error(`${WslSetupTexts.problem(error.problem)} ${error.message}`);
    this.showError(WslSetupTexts.problem(error.problem), error.problem === 'wslMissing' ? WslSetupTexts.installWsl : undefined);
  }

  /** An error with Show details, and `action` before it (Install WSL 2 runs the button of the Docker setup). */
  private showError(message: string, action?: string): void {
    const items = action === undefined ? [Actions.showDetails] : [action, Actions.showDetails];
    showErrorMessage(message, ...items).then(
      (choice) => {
        if (choice === Actions.showDetails) this.deps.showLog();
        else if (choice !== undefined && choice === action) {
          vscode.commands
            .executeCommand(Commands.dockerSetupInstallWsl)
            .then(undefined, (error: unknown) => this.deps.logger.error(`WSL 2 could not be installed: ${errorMessage(error)}`));
        }
      },
      (error: unknown) => this.deps.logger.error('Could not show the message.', error),
    );
  }

  /**
   * The warning while Docker Desktop has its WSL integration on for the distribution, once in the window (logged).
   * `isDefault`: the distribution stays the default distribution of WSL.
   */
  private async warnDockerDesktop(isDefault: boolean): Promise<void> {
    if (this.dockerDesktopWarned || !(await this.deps.dockerDesktopIntegrates?.(isDefault))) return;
    // Another check of the window may have warned meanwhile.
    if (this.dockerDesktopWarned) return;
    this.dockerDesktopWarned = true;
    this.deps.logger.warn(WslSetupTexts.dockerDesktopIntegrates);
    showWarningMessage(WslSetupTexts.dockerDesktopIntegrates).then(undefined, (error: unknown) => this.deps.logger.error('Could not show the message.', error));
  }

  private inform(message: string): void {
    showInformationMessage(message).then(undefined, (error: unknown) => this.deps.logger.error('Could not show the message.', error));
  }
}
