// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The messages of Devspaces, with their text as plain text. VS Code renders `[label](target)` in the text of a
// notification as a link, and a click on it runs the target, also a `command:` with its arguments. The messages of
// Devspaces carry texts that come from a repository, from a Dev Container configuration, from the worker on the Docker
// engine, or from an error, so every message goes through this module, which breaks the syntax of a link in its text
// and in its detail (withoutLinks). Devspaces shows no link of its own in a message; a progress notification
// (progress.ts) cleans its text in the same way and then adds its link "Show details". A test keeps every other call of
// the `show…Message` functions and every other progress notification out of the sources (notifications.test.ts). The
// log keeps every text as it was.
import * as vscode from 'vscode';

/** A `]` that a `(` follows: the middle of a link `[label](target)`. */
const LINK_MIDDLE = /\](?=\()/g;

/**
 * `text` without the syntax of a link: a zero-width space (U+200B) between every `]` and the `(` after it, so VS Code
 * renders no part of it as a link. The text looks the same.
 */
export function withoutLinks(text: string): string {
  return text.replace(LINK_MIDDLE, ']\u200b');
}

type Show = (message: string, ...rest: unknown[]) => Thenable<unknown>;

/**
 * The arguments after the message, with the detail of the options without links. As VS Code reads them: options are a
 * first argument that is an object without a `title` (a MessageItem has one).
 */
function plainArguments(rest: unknown[]): unknown[] {
  const [first, ...items] = rest;
  if (typeof first !== 'object' || first === null || 'title' in first) return rest;
  const options = first as vscode.MessageOptions;
  return [options.detail === undefined ? options : { ...options, detail: withoutLinks(options.detail) }, ...items];
}

/** vscode.window.showInformationMessage, with the message and the detail as plain text (withoutLinks). */
export function showInformationMessage<T extends string>(message: string, ...items: T[]): Thenable<T | undefined>;
export function showInformationMessage<T extends string>(message: string, options: vscode.MessageOptions, ...items: T[]): Thenable<T | undefined>;
export function showInformationMessage<T extends vscode.MessageItem>(message: string, ...items: T[]): Thenable<T | undefined>;
export function showInformationMessage<T extends vscode.MessageItem>(message: string, options: vscode.MessageOptions, ...items: T[]): Thenable<T | undefined>;
export function showInformationMessage(message: string, ...rest: unknown[]): Thenable<unknown> {
  return (vscode.window.showInformationMessage as Show)(withoutLinks(message), ...plainArguments(rest));
}

/** vscode.window.showWarningMessage, with the message and the detail as plain text (withoutLinks). */
export function showWarningMessage<T extends string>(message: string, ...items: T[]): Thenable<T | undefined>;
export function showWarningMessage<T extends string>(message: string, options: vscode.MessageOptions, ...items: T[]): Thenable<T | undefined>;
export function showWarningMessage<T extends vscode.MessageItem>(message: string, ...items: T[]): Thenable<T | undefined>;
export function showWarningMessage<T extends vscode.MessageItem>(message: string, options: vscode.MessageOptions, ...items: T[]): Thenable<T | undefined>;
export function showWarningMessage(message: string, ...rest: unknown[]): Thenable<unknown> {
  return (vscode.window.showWarningMessage as Show)(withoutLinks(message), ...plainArguments(rest));
}

/** vscode.window.showErrorMessage, with the message and the detail as plain text (withoutLinks). */
export function showErrorMessage<T extends string>(message: string, ...items: T[]): Thenable<T | undefined>;
export function showErrorMessage<T extends string>(message: string, options: vscode.MessageOptions, ...items: T[]): Thenable<T | undefined>;
export function showErrorMessage<T extends vscode.MessageItem>(message: string, ...items: T[]): Thenable<T | undefined>;
export function showErrorMessage<T extends vscode.MessageItem>(message: string, options: vscode.MessageOptions, ...items: T[]): Thenable<T | undefined>;
export function showErrorMessage(message: string, ...rest: unknown[]): Thenable<unknown> {
  return (vscode.window.showErrorMessage as Show)(withoutLinks(message), ...plainArguments(rest));
}
