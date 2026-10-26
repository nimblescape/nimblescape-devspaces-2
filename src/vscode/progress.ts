// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Progress in a notification: the plain steps, the reason of an update, and "Show details" for the output channel,
// which also hides the notification. Every progress notification of Devspaces comes from this module: the operations of
// the sidebar (runWithProgress), and the Docker setup and the test of a remote Docker host (withNotificationProgress).
import * as vscode from 'vscode';
import { Actions, Steps, type ProgressStep } from '../core/messages';
import type { ProgressReporter } from '../core/ports';
import { withoutLinks } from './notifications';

/** Command that opens the output channel (package.json). */
export const SHOW_LOG_COMMAND = 'devspaces.showLog';
/** Argument of SHOW_LOG_COMMAND in the link "Show details" of a progress notification: it also hides the notification. */
export const FROM_PROGRESS_NOTIFICATION = 'progressNotification';
/**
 * The VS Code command of the key Escape on a notification: it hides the notifications on the screen. Each one stays in
 * the notification center (the bell in the status bar), a progress notification with its progress and its Cancel
 * button. It is no command of the API, so the live tests check that VS Code still has it (test/vscode).
 */
export const HIDE_NOTIFICATIONS_COMMAND = 'notifications.hideToasts';

// A progress notification cannot have buttons besides Cancel, but its message renders links, also command links. A
// click on a link runs its command and keeps the notification on the screen, so Show Log hides it then
// (FROM_PROGRESS_NOTIFICATION). The notification must not end before its task: its Cancel button is the only way to
// cancel the operation.
const SHOW_DETAILS_LINK = `[${Actions.showDetails}](command:${SHOW_LOG_COMMAND}?${encodeURIComponent(JSON.stringify([FROM_PROGRESS_NOTIFICATION]))})`;

export interface ProgressRun<T> {
  /** For example `Messages.opening(repository)`. */
  title: string;
  /** Repository of the operation, for the status bar (`Updating owner/name…`). */
  repository?: string;
  /** Shows a Cancel button that aborts the signal. Default: false. */
  cancellable?: boolean;
  task: (progress: ProgressReporter, signal: AbortSignal) => Promise<T>;
}

export interface BusyChange {
  busy: boolean;
  /** Title of the newest running operation. */
  title?: string;
  /**
   * Repository of the newest running operation that has one. An operation without a repository (for example a short
   * Stop) that starts while a pipeline runs does not hide the pipeline's "Updating owner/name…".
   */
  repository?: string;
}

const busyEmitter = new vscode.EventEmitter<BusyChange>();
/** Fires when an operation starts, and when the last running operation ends (for the status bar "Updating …"). */
export const onDidChangeBusy: vscode.Event<BusyChange> = busyEmitter.event;

interface RunningOperation {
  title: string;
  repository?: string;
}
const running: RunningOperation[] = [];

/** The newest running operation (its title and repository), or `undefined`. */
export function currentOperation(): Readonly<{ title: string; repository?: string }> | undefined {
  const newest = running[running.length - 1];
  if (!newest) return undefined;
  return newest.repository === undefined ? { title: newest.title } : { title: newest.title, repository: newest.repository };
}

function busyChange(): BusyChange {
  const newest = currentOperation();
  if (!newest) return { busy: false };
  let repository: string | undefined;
  for (let index = running.length - 1; index >= 0 && repository === undefined; index--) {
    repository = running[index].repository;
  }
  return repository === undefined ? { busy: true, title: newest.title } : { busy: true, title: newest.title, repository };
}

/** Text of the notification: the title, the current step and its detail, then the link "Show details". */
export function progressMessage(title: string, step: ProgressStep | undefined, detail: string | undefined): string {
  // The title and the detail carry names of the repository and texts of the worker: plain text (withoutLinks), so that
  // the link "Show details" is the only link.
  const parts = [withoutLinks(title)];
  if (step) parts.push(`${Steps[step]}.`);
  if (detail) parts.push(withoutLinks(detail));
  parts.push(SHOW_DETAILS_LINK);
  return parts.join(' ');
}

/**
 * vscode.window.withProgress in a notification, for work that is no operation of the sidebar (the Docker setup, the
 * test of a remote Docker host). As in runWithProgress, the message shows the title and the newest message of the task
 * as plain text, then the link "Show details" (progressMessage).
 */
export function withNotificationProgress<R>(
  options: { title: string; cancellable?: boolean },
  task: (progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken) => Thenable<R>,
): Thenable<R> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, cancellable: options.cancellable ?? false },
    (progress, token) => {
      // A report with only an increment keeps the newest message.
      let message: string | undefined;
      progress.report({ message: progressMessage(options.title, undefined, undefined) });
      return task(
        {
          report: (value) => {
            if (value.message !== undefined) message = value.message;
            progress.report({ ...value, message: progressMessage(options.title, undefined, message) });
          },
        },
        token,
      );
    },
  );
}

/**
 * Runs `task` with one progress notification. The message shows the current step (`Steps[step]`) and its detail,
 * followed by the link "Show details" (command `devspaces.showLog`: it opens the output channel and hides the
 * notification, which stays in the notification center with its Cancel button). Cancel aborts the signal. The promise
 * settles with the result of the task.
 */
export function runWithProgress<T>(run: ProgressRun<T>): Promise<T> {
  const operation: RunningOperation = { title: run.title, repository: run.repository };
  running.push(operation);
  busyEmitter.fire(busyChange());

  const controller = new AbortController();
  let started = false;
  const result = new Promise<T>((resolve, reject) => {
    // The title is part of the message (not the `title` option), so that the notification does not show "title: step".
    vscode.window
      .withProgress(
        { location: vscode.ProgressLocation.Notification, cancellable: run.cancellable ?? false },
        async (progress, token) => {
          const cancellation = token.onCancellationRequested(() => controller.abort());
          let finished = false;
          let step: ProgressStep | undefined;
          let detail: string | undefined;
          const show = () => {
            if (!finished) progress.report({ message: progressMessage(run.title, step, detail) });
          };
          const reporter: ProgressReporter = {
            step(next) {
              step = next;
              detail = undefined;
              show();
            },
            detail(message) {
              detail = message;
              show();
            },
          };
          show();
          started = true;
          try {
            // Also a task that throws before it returns its promise (the rejection is passed on). The notification
            // stays until the task settles; then the `finally` stops the reports to the closed notification.
            const task = Promise.resolve().then(() => run.task(reporter, controller.signal));
            task.then(resolve, reject);
            await task.then(() => undefined, () => undefined);
          } finally {
            finished = true;
            cancellation.dispose();
          }
        },
      )
      // Only a notification that could not be shown fails the operation; once the task runs, it settles the result.
      .then(undefined, (error: unknown) => {
        if (!started) reject(error);
      });
  });

  return result.finally(() => {
    const index = running.indexOf(operation);
    if (index >= 0) running.splice(index, 1);
    busyEmitter.fire(busyChange());
  });
}
