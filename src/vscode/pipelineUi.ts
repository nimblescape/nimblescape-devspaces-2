// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Decisions and messages of the open pipeline (PipelineUi) in VS Code.
import * as vscode from 'vscode';
import { Actions, MAX_LISTED_NAMES, Messages, formatChanges, listSome, recordedStateNote } from '../core/messages';
import type { DeleteConfirmation } from '../core/pipeline/deleteCheck';
import { ControllerTexts } from './controllerTexts';
import { systemClock, type Clock, type Logger, type PipelineUi, type ConfigurationChangeKind } from '../core/ports';
import type { VsCodeGitHubAuth } from './auth';
import { GITHUB_PACKAGES_REGISTRY } from '../core/imageCheck/credentials';
import type { UpdateContainer } from '../core/types';
import { showInformationMessage, showWarningMessage } from './notifications';

/** Identical non-blocking messages within this time are shown once. */
export const MESSAGE_DEDUPLICATION_MS = 60_000;

export class VsCodePipelineUi implements PipelineUi {
  private readonly lastShown = new Map<string, number>();

  constructor(
    private readonly auth: VsCodeGitHubAuth,
    private readonly logger: Logger,
    private readonly showLog: () => void,
    private readonly clock: Clock = systemClock,
    // The setting updateContainer, read at each question.
    private readonly updateContainerSetting: () => UpdateContainer = () => 'notify',
  ) {}

  // The questions are modal: the pipeline waits for the answer, and a notification that moves to the notification
  // center unanswered would leave the pipeline waiting without a visible question.

  async confirmUntrustedRepository(repository: string): Promise<boolean> {
    const choice = await showWarningMessage(
      Messages.untrustedRepository(repository),
      { modal: true },
      Actions.open,
    );
    return choice === Actions.open;
  }

  async configurationChanged(repository: string, what?: ConfigurationChangeKind): Promise<'rebuildNow' | 'later'> {
    const rebuildNow: vscode.MessageItem = { title: Actions.rebuildNow };
    const later: vscode.MessageItem = { title: Actions.later, isCloseAffordance: true };
    const choice = await showInformationMessage(
      what === 'defaultImage' ? Messages.defaultImageChanged : Messages.configurationChanged,
      { modal: true, detail: repository },
      rebuildNow,
      later,
    );
    return choice === rebuildNow ? 'rebuildNow' : 'later';
  }

  /**
   * The confirmation of Delete with the changes ("Delete anyway", "Open devspace"), else the plain one; the note of
   * an out-of-date recorded state in the locale of this computer, the data of services in the repository, and the other
   * window that closes its connection.
   */
  async confirmDelete(repository: string, confirmation: DeleteConfirmation): Promise<'delete' | 'open' | undefined> {
    const stateNote = recordedStateNote(confirmation.recordedAt !== undefined ? { recordedAt: confirmation.recordedAt } : undefined, confirmation.lastSeenInUse);
    const repositoryDataText = confirmation.repositoryData.length > 0 ? ` ${Messages.deleteRepositoryServiceData(listSome(confirmation.repositoryData))}` : '';
    const otherWindow = confirmation.otherWindow ? ` ${ControllerTexts.otherWindowClosesConnection(repository)}` : '';
    // The counts, worded here.
    const changes = confirmation.changes ? formatChanges(confirmation.changes) : '';
    if (changes !== '') {
      const choice = await showWarningMessage(
        `${Messages.deleteUnsaved(repository, changes)}${stateNote}${repositoryDataText}${otherWindow}`,
        { modal: true },
        Actions.openDevspace,
        Actions.deleteAnyway,
      );
      return choice === Actions.deleteAnyway ? 'delete' : choice === Actions.openDevspace ? 'open' : undefined;
    }
    const choice = await showWarningMessage(`${Messages.deleteConfirm(repository)}${stateNote}${repositoryDataText}${otherWindow}`, { modal: true }, Actions.delete);
    return choice === Actions.delete ? 'delete' : undefined;
  }

  /** The additional volumes that Delete may remove. */
  async deleteAdditionalVolumes(volumes: readonly string[]): Promise<'remove' | 'keep' | undefined> {
    // A message of normal length (the names come from the worker); every name that Remove removes is in its detail.
    const choice = await showWarningMessage(
      Messages.deleteAdditionalVolumes(listSome(volumes)),
      { modal: true, ...(volumes.length > MAX_LISTED_NAMES ? { detail: volumes.join('\n') } : {}) },
      Actions.remove,
      Actions.keep,
    );
    return choice === Actions.remove ? 'remove' : choice === Actions.keep ? 'keep' : undefined;
  }

  /** The data of the services that Delete may remove, none ticked. */
  async deleteServiceData(volumes: readonly string[], possibly: readonly string[]): Promise<string[] | undefined> {
    const placeHolder = possibly.length > 0 ? Messages.deleteServiceDataPossiblePlaceholder : Messages.deleteServiceDataPlaceholder;
    const picked = await vscode.window.showQuickPick(
      volumes.map((name) => ({
        label: name,
        description: possibly.includes(name) ? Messages.deleteServiceDataPossibleItem : Messages.deleteServiceDataItem,
        picked: false,
      })),
      { title: Messages.deleteServiceDataTitle, placeHolder, canPickMany: true, ignoreFocusOut: true },
    );
    return picked === undefined ? undefined : picked.map((item) => item.label);
  }

  async configurationKindChanged(repository: string, message: string): Promise<'rebuildNow' | 'later'> {
    const rebuildNow: vscode.MessageItem = { title: Actions.rebuildNow };
    // Keeping the kind is the answer of a dismissed dialog (it removes nothing).
    const later: vscode.MessageItem = { title: Actions.later, isCloseAffordance: true };
    const choice = await showWarningMessage(message, { modal: true, detail: repository }, rebuildNow, later);
    return choice === rebuildNow ? 'rebuildNow' : 'later';
  }

  async filesMissing(repository: string): Promise<'cloneAgain' | 'deleteDevspace' | undefined> {
    const choice = await showWarningMessage(
      Messages.filesMissing,
      { modal: true, detail: repository },
      Actions.cloneAgain,
      Actions.deleteDevspace,
    );
    if (choice === Actions.cloneAgain) return 'cloneAgain';
    if (choice === Actions.deleteDevspace) return 'deleteDevspace';
    return undefined;
  }

  async recreateContainer(repository: string, question: { message: string; detail: string }): Promise<boolean> {
    // The modal adds Cancel, the answer of a dismissed dialog (it removes nothing).
    const choice = await showWarningMessage(question.message, { modal: true, detail: question.detail }, Actions.recreateContainer);
    this.logger.info(`${repository}: ${choice === Actions.recreateContainer ? 'Recreate' : 'Cancel'} was chosen.`);
    return choice === Actions.recreateContainer;
  }

  /**
   * A newer image for the existing container of `repository` (`running`: it runs), after the setting updateContainer. A
   * dismissed dialog is the answer of its close affordance: Cancel (`notify`) or Later (`ask`).
   */
  async updateContainer(repository: string, running: boolean): Promise<'update' | 'later' | 'cancel'> {
    const ask = this.updateContainerSetting() === 'ask';
    const accept: vscode.MessageItem = { title: ask ? Actions.updateNow : Actions.continue };
    const decline: vscode.MessageItem = { title: ask ? Actions.later : Actions.cancel, isCloseAffordance: true };
    const message = ask ? Messages.containerUpdateQuestion(repository, running) : Messages.containerUpdateNotice(repository, running);
    const choice = await showInformationMessage(message, { modal: true }, accept, decline);
    this.logger.info(`${repository}: ${choice === accept ? accept.title : decline.title} was chosen for the update of its container.`);
    return choice === accept ? 'update' : ask ? 'later' : 'cancel';
  }

  info(message: string): void {
    if (!this.shouldShow(`info:${message}`)) return;
    this.logger.info(message);
    showInformationMessage(message)
      .then(undefined, (error: unknown) => this.logger.error('Could not show the message.', error));
  }

  warn(message: string): void {
    if (!this.shouldShow(`warn:${message}`)) return;
    this.logger.warn(message);
    showWarningMessage(message, Actions.showDetails).then(
      (choice) => {
        if (choice === Actions.showDetails) this.showLog();
      },
      (error: unknown) => this.logger.error('Could not show the message.', error),
    );
  }

  registrySignIn(registry: string): void {
    const message = Messages.registrySignIn(registry);
    if (!this.shouldShow(`registry:${registry.toLowerCase()}`)) return;
    this.logger.info(message);
    if (registry.toLowerCase() !== GITHUB_PACKAGES_REGISTRY) {
      showInformationMessage(message)
        .then(undefined, (error: unknown) => this.logger.error('Could not show the message.', error));
      return;
    }
    showInformationMessage(message, Actions.signIn)
      .then(async (choice) => {
        if (choice !== Actions.signIn) return;
        // The next connection uses the session through the credentials provider of the image check.
        const credentials = await this.auth.getPackagesCredentials({ interactive: true });
        this.logger.info(
          credentials
            ? `Signed in for ${registry}. The next connection uses the sign-in.`
            : `The sign-in for ${registry} was not completed.`,
        );
      })
      .then(undefined, (error: unknown) => this.logger.error(`The sign-in for ${registry} failed.`, error));
  }

  private shouldShow(key: string): boolean {
    const now = this.clock.now();
    for (const [entry, shownAt] of this.lastShown) {
      if (now - shownAt >= MESSAGE_DEDUPLICATION_MS) this.lastShown.delete(entry);
    }
    if (this.lastShown.has(key)) return false;
    this.lastShown.set(key, now);
    return true;
  }
}
