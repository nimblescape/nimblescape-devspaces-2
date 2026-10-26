// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { Messages } from '../core/messages';
import type { ProgressReporter } from '../core/ports';
import { currentOperation, onDidChangeBusy, progressMessage, runWithProgress, withNotificationProgress, type BusyChange } from './progress';
import { EventEmitter, fakeVscode, resetFakeVscode } from './testing/fakeVscode';

interface FakeProgressRun {
  options: { location: number; cancellable?: boolean; title?: string };
  messages: string[];
  cancel(): void;
}

/** withProgress that records the reported messages and offers a Cancel button to the test. */
function scriptWithProgress(): FakeProgressRun[] {
  const runs: FakeProgressRun[] = [];
  fakeVscode.window.withProgress.mockImplementation(async (options, task) => {
    const cancellation = new EventEmitter<void>();
    const run: FakeProgressRun = { options, messages: [], cancel: () => cancellation.fire() };
    runs.push(run);
    return task(
      { report: (value: { message?: string }) => run.messages.push(value.message ?? '') },
      { isCancellationRequested: false, onCancellationRequested: cancellation.event },
    );
  });
  return runs;
}

describe('withNotificationProgress', () => {
  beforeEach(() => resetFakeVscode());

  // The Docker setup and the test of a remote Docker host show their progress as the operations do: the title and the
  // newest message in the message, then the link Show details, which opens the log and hides the notification.
  it('shows the title, the newest message and the link Show details, and keeps the message for a report with only an increment', async () => {
    const runs = scriptWithProgress();
    const result = await withNotificationProgress({ title: 'Downloading Docker Desktop…', cancellable: true }, async (progress) => {
      progress.report({ message: '3 of 10 MB.', increment: 30 });
      progress.report({ increment: 10 });
      return 42;
    });
    expect(result).toBe(42);
    expect(runs[0].options).toEqual({ location: fakeVscode.ProgressLocation.Notification, cancellable: true });
    expect(runs[0].messages).toEqual([
      'Downloading Docker Desktop… [Show details](command:devspaces.showLog?%5B%22progressNotification%22%5D)',
      'Downloading Docker Desktop… 3 of 10 MB. [Show details](command:devspaces.showLog?%5B%22progressNotification%22%5D)',
      'Downloading Docker Desktop… 3 of 10 MB. [Show details](command:devspaces.showLog?%5B%22progressNotification%22%5D)',
    ]);
  });

  it('shows no Cancel button unless asked', async () => {
    const runs = scriptWithProgress();
    await withNotificationProgress({ title: 'Testing the connection to build-box…' }, async () => undefined);
    expect(runs[0].options.cancellable).toBe(false);
  });
});

describe('progressMessage', () => {
  it('shows the title, the step, the detail, and the link Show details', () => {
    expect(progressMessage('Opening acme/api…', undefined, undefined)).toBe(
      'Opening acme/api… [Show details](command:devspaces.showLog?%5B%22progressNotification%22%5D)',
    );
    expect(progressMessage('Opening acme/api…', 'downloadingImage', Messages.newerImage)).toBe(
      'Opening acme/api… Downloading the new image. A newer image is available. The devspace is updated. Your files are kept. [Show details](command:devspaces.showLog?%5B%22progressNotification%22%5D)',
    );
  });
});

describe('runWithProgress', () => {
  beforeEach(() => resetFakeVscode());

  it('shows one notification with the steps and returns the result of the task', async () => {
    const runs = scriptWithProgress();
    const result = await runWithProgress({
      title: 'Opening acme/api…',
      task: async (progress: ProgressReporter) => {
        progress.step('checkingImage');
        progress.step('downloadingImage');
        progress.detail(Messages.newerImage);
        progress.step('starting');
        return 42;
      },
    });
    expect(result).toBe(42);
    expect(runs).toHaveLength(1);
    expect(runs[0].options).toEqual({ location: fakeVscode.ProgressLocation.Notification, cancellable: false });
    // The link Show details opens the log and hides the notification (it does not end it, see below).
    expect(runs[0].messages.every((message) => message.endsWith(' [Show details](command:devspaces.showLog?%5B%22progressNotification%22%5D)'))).toBe(true);
    expect(runs[0].messages.map((message) => message.replace(/ \[Show details\]\(command:[^)]*\)$/, ''))).toEqual([
      'Opening acme/api…',
      'Opening acme/api… Checking for a newer image.',
      'Opening acme/api… Downloading the new image.',
      `Opening acme/api… Downloading the new image. ${Messages.newerImage}`,
      'Opening acme/api… Starting devspace.',
    ]);
  });

  it('aborts the signal when the user selects Cancel', async () => {
    const runs = scriptWithProgress();
    const promise = runWithProgress({
      title: 'Opening acme/api…',
      cancellable: true,
      task: (_progress, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    await Promise.resolve();
    expect(runs[0].options.cancellable).toBe(true);
    runs[0].cancel();
    await expect(promise).rejects.toThrow('aborted');
  });

  it('reports busy while operations run, with the newest operation, and not busy after the last one', async () => {
    scriptWithProgress();
    const changes: BusyChange[] = [];
    const subscription = onDidChangeBusy((change) => changes.push(change));
    let finishFirst!: () => void;
    let failSecond!: (error: Error) => void;
    const first = runWithProgress({
      title: 'Opening acme/api…',
      repository: 'acme/api',
      task: () => new Promise<void>((resolve) => (finishFirst = resolve)),
    });
    const second = runWithProgress({
      title: 'Opening acme/web…',
      repository: 'acme/web',
      task: () => new Promise<void>((_resolve, reject) => (failSecond = reject)),
    });
    await Promise.resolve();
    expect(currentOperation()).toEqual({ title: 'Opening acme/web…', repository: 'acme/web' });

    failSecond(new Error('failed'));
    await expect(second).rejects.toThrow('failed');
    expect(currentOperation()).toEqual({ title: 'Opening acme/api…', repository: 'acme/api' });
    finishFirst();
    await first;
    expect(currentOperation()).toBeUndefined();
    subscription.dispose();

    expect(changes).toEqual([
      { busy: true, title: 'Opening acme/api…', repository: 'acme/api' },
      { busy: true, title: 'Opening acme/web…', repository: 'acme/web' },
      { busy: true, title: 'Opening acme/api…', repository: 'acme/api' },
      { busy: false },
    ]);
  });

  it('keeps the repository of a running pipeline while an operation without a repository runs', async () => {
    scriptWithProgress();
    const changes: BusyChange[] = [];
    const subscription = onDidChangeBusy((change) => changes.push(change));
    let finishPipeline!: () => void;
    let finishStop!: () => void;
    const pipeline = runWithProgress({
      title: 'Opening acme/api…',
      repository: 'acme/api',
      task: () => new Promise<void>((resolve) => (finishPipeline = resolve)),
    });
    const stop = runWithProgress({ title: 'Stopping acme/web…', task: () => new Promise<void>((resolve) => (finishStop = resolve)) });
    await Promise.resolve();
    finishPipeline();
    await pipeline;
    finishStop();
    await stop;
    subscription.dispose();

    expect(changes).toEqual([
      { busy: true, title: 'Opening acme/api…', repository: 'acme/api' },
      { busy: true, title: 'Stopping acme/web…', repository: 'acme/api' },
      { busy: true, title: 'Stopping acme/web…' },
      { busy: false },
    ]);
  });

  it('keeps the notification and its Cancel button until the task settles: Show details does not end it', async () => {
    let notificationClosed = false;
    const runs: FakeProgressRun[] = [];
    fakeVscode.window.withProgress.mockImplementation(async (options, task) => {
      const cancellation = new EventEmitter<void>();
      const run: FakeProgressRun = { options, messages: [], cancel: () => cancellation.fire() };
      runs.push(run);
      const value = await task(
        { report: (report: { message?: string }) => run.messages.push(report.message ?? '') },
        { isCancellationRequested: false, onCancellationRequested: cancellation.event },
      );
      notificationClosed = true;
      return value;
    });
    let reporter: ProgressReporter | undefined;
    const promise = runWithProgress({
      title: 'Opening acme/api…',
      repository: 'acme/api',
      cancellable: true,
      task: (progress, signal) => {
        reporter = progress;
        progress.step('downloadingImage');
        return new Promise<number>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A click on the link runs devspaces.showLog with the argument 'progressNotification', which hides the notification
    // (controller.ts, showLog). The notification stays in the notification center with its Cancel button.
    expect(runs[0].messages.at(-1)).toBe('Opening acme/api… Downloading the new image. [Show details](command:devspaces.showLog?%5B%22progressNotification%22%5D)');
    expect(notificationClosed).toBe(false);
    expect(currentOperation()).toEqual({ title: 'Opening acme/api…', repository: 'acme/api' });
    // Cancel still aborts the operation; then the notification closes, and gets no more reports.
    runs[0].cancel();
    await expect(promise).rejects.toThrow('aborted');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notificationClosed).toBe(true);
    expect(currentOperation()).toBeUndefined();
    const reported = runs[0].messages.length;
    reporter!.step('starting');
    expect(runs[0].messages).toHaveLength(reported);
  });

  it('passes on a task that throws before it returns its promise, and ends the busy state', async () => {
    scriptWithProgress();
    const promise = runWithProgress<number>({
      title: 'x',
      task: () => {
        throw new Error('at once');
      },
    });
    await expect(promise).rejects.toThrow('at once');
    expect(currentOperation()).toBeUndefined();
  });

  it('ends the busy state also when the notification cannot be shown', async () => {
    fakeVscode.window.withProgress.mockRejectedValue(new Error('no window'));
    await expect(runWithProgress({ title: 'x', task: async () => 1 })).rejects.toThrow('no window');
    expect(currentOperation()).toBeUndefined();
  });
});
