// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Settings of the extension (prefix `devspaces`).
import * as vscode from 'vscode';
import { errorMessage } from '../core/errors';
import { HOST_ACCESS_CHECKS_OFF_SETTING, parseHostAccessChecksOff } from '../core/policy/hostAccessChecks';
import { Actions, Messages } from '../core/messages';
import type { Logger } from '../core/ports';
import type { ExtensionSettings } from '../core/types';
import { DEFAULT_CACHE_UPDATE_SCHEDULE, normalizeCacheSchedule, parseCacheSchedule } from '../core/remoteMonitor/cacheSettings';
import { parseImageReference } from '../core/remoteMonitor/protocol';
import { Commands } from './commands';
import { showWarningMessage } from './notifications';
import { normalizeListOpenMode, type ListOpenMode } from './rowActivation';

export const SETTINGS_SECTION = 'devspaces';

/** Defaults of the settings. */
export const DEFAULT_SETTINGS: Readonly<ExtensionSettings> = Object.freeze({
  reopenLastOnStartup: true,
  stopOnClose: true,
  updateImagesOnConnect: true,
  respectShutdownActionNone: false,
  owners: [],
  includeArchived: false,
  includeForks: true,
  showOnlyDevspaces: false,
  refreshIntervalMinutes: 60,
  hostAccessChecksOff: [],
  repositoryGroups: [],
  openInNewWindow: false,
  stopAfterMinutes: 10,
  cacheUpdateSchedule: DEFAULT_CACHE_UPDATE_SCHEDULE,
  stopMonitorWhenIdle: false,
  updateContainer: 'notify',
  defaultImage: '',
  startWithDefaultImage: true,
});

/**
 * Bounds of the setting stopAfterMinutes: five minutes to one day. At least 5 minutes, so that a tick with long stops
 * (Git, SSH) never keeps the heartbeats away that long. The protocol itself accepts 60 seconds (MIN_LIMIT_SECONDS; the
 * Docker test uses it).
 */
export const MIN_STOP_AFTER_MINUTES = 5;
export const MAX_STOP_AFTER_MINUTES = 1440;

/**
 * Largest refresh interval that a Node.js timer supports (2^31 - 1 ms). A longer delay makes `setInterval` fire every
 * millisecond, which would send a discovery request to GitHub in a loop.
 */
export const MAX_REFRESH_INTERVAL_MINUTES = Math.floor(0x7fffffff / 60_000);

/**
 * Current settings. Values of a wrong type fall back to the default; 1 ≤ refreshIntervalMinutes ≤
 * MAX_REFRESH_INTERVAL_MINUTES, 5 ≤ stopAfterMinutes ≤ 1440. hostAccessChecksOff is read from the user settings only
 * (hostAccessChecksOffValue). `repositoryGroups` has the scope `application` in package.json, so VS Code returns only
 * the user setting: a workspace cannot bring its own regular expressions. The same for `openInNewWindow`: a workspace
 * does not decide which window a Start uses, and for `stopAfterMinutes`: one limit per user and computer, as every
 * window sends it in its heartbeats; the same for `stopOnClose` and `respectShutdownActionNone` (read by each window
 * for its heartbeats and its release): a repository's workspace settings cannot keep every devspace of the computer
 * running.
 */
export function readSettings(): ExtensionSettings {
  const configuration = vscode.workspace.getConfiguration(SETTINGS_SECTION);
  return normalizeSettings((key) =>
    key === HOST_ACCESS_CHECKS_OFF_SETTING ? hostAccessChecksOffValue(configuration) : configuration.get<unknown>(key),
  );
}

/**
 * Where a button of the view writes a setting of the scope `window`, for example `owners`: the workspace settings when
 * they hold a value for it, because that value wins over the user settings; else the user settings. In Restricted Mode,
 * VS Code ignores the workspace values of these settings (restrictedConfigurations), and `inspect` does not return them.
 */
export function settingTarget(configuration: Pick<vscode.WorkspaceConfiguration, 'inspect'>, key: string): vscode.ConfigurationTarget {
  return configuration.inspect<unknown>(key)?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
}

/**
 * The raw value of devspaces.hostAccessChecksOff in the user settings (scope `application`). A value of a workspace or
 * folder, which a repository could bring along, never turns a check off: VS Code ignores such values of an application
 * setting, and this reads the user value only, to be sure.
 */
export function hostAccessChecksOffValue(configuration: Pick<vscode.WorkspaceConfiguration, 'inspect'>): unknown {
  return configuration.inspect<unknown>(HOST_ACCESS_CHECKS_OFF_SETTING)?.globalValue;
}

/**
 * The raw value of `dev.containers.defaultExtensions` (a setting of the Dev Containers extension) in the user settings.
 * An open carries these extensions for the shared extension cache of its Docker engine, which all devspaces there use.
 * A value of a workspace or folder, which a repository could bring along, is not used: the scope that the Dev Containers
 * extension declares may already make VS Code ignore it, and this reads the user value only, to be sure. In Restricted
 * Mode too: capabilities.untrustedWorkspaces.restrictedConfigurations in package.json can name only the settings of
 * Devspaces itself.
 */
export function devContainersDefaultExtensionsValue(): unknown {
  return vscode.workspace.getConfiguration('dev.containers').inspect<unknown>('defaultExtensions')?.globalValue;
}

/**
 * The value of devspaces.defaultImage that is no image reference (parseImageReference, after trimming), for one
 * warning; `''` when the setting is empty or valid. The setting has the scope `application`: only the user value.
 */
export function invalidDefaultImageValue(): string {
  const value = vscode.workspace.getConfiguration(SETTINGS_SECTION).get<unknown>('defaultImage');
  return normalizeDefaultImage(value) === undefined && typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
}

/** Opens the Settings editor at the setting `devspaces.<key>`. */
export function openSetting(key: string): Thenable<unknown> {
  return vscode.commands.executeCommand('workbench.action.openSettings', `@id:${SETTINGS_SECTION}.${key}`);
}

/** The button of a warning about a setting: its label, and what a click on it opens. */
interface SettingWarningButton {
  label: string;
  open: () => Thenable<unknown>;
}

/**
 * A warning about the value of the setting `devspaces.<key>`, with a button that opens the place to change it: by
 * default Open Settings, which opens that setting in the Settings editor. A failure is logged. The caller decides when
 * a warning shows again.
 */
export function showSettingWarning(
  logger: Logger,
  key: string,
  message: string,
  button: SettingWarningButton = { label: Actions.openSettings, open: () => openSetting(key) },
): void {
  Promise.resolve(showWarningMessage(message, button.label))
    .then(
      (choice) => (choice === button.label ? button.open() : undefined),
      (error: unknown) => logger.warn(`The warning about the setting ${key} could not be shown: ${errorMessage(error)}`),
    )
    .then(undefined, (error: unknown) => logger.warn(`The setting ${key} could not be opened: ${errorMessage(error)}`));
}

/**
 * A warning about the setting repositoryGroups, with the button Edit Repository Groups…, which runs that command: the
 * editor of the setting, with a preview. For this list, the Settings editor offers only "Edit in settings.json".
 */
export function showRepositoryGroupsWarning(logger: Logger, message: string): void {
  showSettingWarning(logger, 'repositoryGroups', message, {
    label: Actions.editRepositoryGroups,
    open: () => vscode.commands.executeCommand(Commands.editRepositoryGroups),
  });
}

/**
 * `message`: the warning about the invalid value of the setting `devspaces.<key>`, or undefined for a valid or empty
 * value. The check of a setting runs only at the start and when the setting changes, so each invalid value that it
 * finds is a line in the log. The warning shows once per window session for each invalid value: `warned` holds the
 * warnings about this setting that this window showed since the setting last had a valid value (one set per setting).
 * A valid value clears it, so the same invalid value entered again is shown again.
 */
function warnOnce(logger: Logger, warned: Set<string>, key: string, message: string | undefined): void {
  if (message === undefined) {
    warned.clear();
    return;
  }
  logger.warn(message);
  if (warned.has(message)) return;
  warned.add(message);
  showSettingWarning(logger, key, message);
}

/** True at the start (`change` undefined), and for a change of the setting `devspaces.<key>`. */
function checksSetting(key: string, change: vscode.ConfigurationChangeEvent | undefined): boolean {
  return change === undefined || change.affectsConfiguration(`${SETTINGS_SECTION}.${key}`);
}

/**
 * The check of devspaces.defaultImage at the start, and when `change` changes it: an invalid value is ignored (no
 * default image), and named in the log and in a warning (warnOnce).
 */
export function warnInvalidDefaultImage(logger: Logger, warned: Set<string>, change?: vscode.ConfigurationChangeEvent): void {
  if (!checksSetting('defaultImage', change)) return;
  const invalid = invalidDefaultImageValue();
  warnOnce(logger, warned, 'defaultImage', invalid === '' ? undefined : Messages.defaultImageInvalid(invalid));
}

/**
 * The value of devspaces.cacheUpdateSchedule that the Monitor does not take (parseCacheSchedule), for one warning; `''`
 * when the setting is empty or valid. The settings editor takes any five fields (the pattern in package.json), also
 * `0 25 * * *`. The setting has the scope `application`: only the user value.
 */
export function invalidCacheUpdateScheduleValue(): string {
  const value = vscode.workspace.getConfiguration(SETTINGS_SECTION).get<unknown>('cacheUpdateSchedule');
  const text = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
  return text !== '' && parseCacheSchedule(value) === undefined ? text : '';
}

/**
 * The check of devspaces.cacheUpdateSchedule at the start, and when `change` changes it: a value that the Monitor does
 * not take is replaced by the default (normalizeSettings), and named in the log and in a warning (warnOnce).
 */
export function warnInvalidCacheUpdateSchedule(logger: Logger, warned: Set<string>, change?: vscode.ConfigurationChangeEvent): void {
  if (!checksSetting('cacheUpdateSchedule', change)) return;
  const invalid = invalidCacheUpdateScheduleValue();
  warnOnce(logger, warned, 'cacheUpdateSchedule', invalid === '' ? undefined : Messages.cacheUpdateScheduleInvalid(invalid));
}

/**
 * The setting `defaultImage` as the extension uses it: the trimmed image reference when it is one (parseImageReference,
 * as the Monitor and the worker check references), else `undefined` (an empty or invalid value: no default image).
 */
export function normalizeDefaultImage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed !== '' && parseImageReference(trimmed) !== undefined ? trimmed : undefined;
}

/** The entries of devspaces.hostAccessChecksOff (user settings) that are no repository name, for one warning. */
export function invalidHostAccessChecksOffEntries(): string[] {
  const configuration = vscode.workspace.getConfiguration(SETTINGS_SECTION);
  return parseHostAccessChecksOff(hostAccessChecksOffValue(configuration)).invalid;
}

/**
 * The check of devspaces.hostAccessChecksOff at the start, and when `change` changes it: its invalid entries are
 * ignored, and named in the log and in a warning (warnOnce).
 */
export function warnInvalidHostAccessChecksOff(logger: Logger, warned: Set<string>, change?: vscode.ConfigurationChangeEvent): void {
  if (!checksSetting(HOST_ACCESS_CHECKS_OFF_SETTING, change)) return;
  const invalid = invalidHostAccessChecksOffEntries().join(', ');
  warnOnce(logger, warned, HOST_ACCESS_CHECKS_OFF_SETTING, invalid === '' ? undefined : Messages.hostAccessChecksOffInvalid(invalid));
}

/**
 * The VS Code setting `workbench.list.openMode`, read at each activation of a row (a double-click on a repository row
 * runs Start, see rowActivation.ts), so a change applies at once.
 */
export function readListOpenMode(): ListOpenMode {
  return normalizeListOpenMode(vscode.workspace.getConfiguration('workbench.list').get<unknown>('openMode'));
}

/** The section of the settings of the built-in extension GitHub Authentication of VS Code for GitHub Enterprise. */
export const GITHUB_ENTERPRISE_SECTION = 'github-enterprise';

/**
 * True when the settings of VS Code name a GitHub Enterprise Server or GHE.com instance. Devspaces cannot use an account
 * there: it signs in with the provider `github`, for github.com only. The settings are read as the built-in extension
 * GitHub Authentication reads them (VS Code 1.142): the list `github-enterprise.uris` when it has a value, and a value
 * of the workspace or folder only in a trusted workspace; else the old setting `github-enterprise.uri`.
 */
export function githubEnterpriseConfigured(): boolean {
  const configuration = vscode.workspace.getConfiguration(GITHUB_ENTERPRISE_SECTION);
  const uris = configuration.inspect<unknown>('uris');
  const listSet =
    uris !== undefined &&
    (uris.globalValue !== undefined ||
      (vscode.workspace.isTrusted && (uris.workspaceValue !== undefined || uris.workspaceFolderValue !== undefined)));
  const values = listSet ? configuration.get<unknown>('uris') : [configuration.get<unknown>('uri')];
  return Array.isArray(values) && values.some((value) => typeof value === 'string' && value.trim() !== '');
}

/** True if a configuration change affects these settings. */
export function affectsSettings(event: vscode.ConfigurationChangeEvent): boolean {
  return event.affectsConfiguration(SETTINGS_SECTION);
}

/** Builds valid settings from raw values (`get` returns `undefined` for a missing value). */
export function normalizeSettings(get: (key: keyof ExtensionSettings) => unknown): ExtensionSettings {
  const bool = (key: keyof ExtensionSettings, fallback: boolean): boolean => {
    const value = get(key);
    return typeof value === 'boolean' ? value : fallback;
  };
  const number = (key: keyof ExtensionSettings, fallback: number, minimum: number, maximum = Infinity): number => {
    const value = get(key);
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
  };
  const owners = get('owners');
  const repositoryGroups = get('repositoryGroups');
  return {
    reopenLastOnStartup: bool('reopenLastOnStartup', DEFAULT_SETTINGS.reopenLastOnStartup),
    stopOnClose: bool('stopOnClose', DEFAULT_SETTINGS.stopOnClose),
    updateImagesOnConnect: bool('updateImagesOnConnect', DEFAULT_SETTINGS.updateImagesOnConnect),
    respectShutdownActionNone: bool('respectShutdownActionNone', DEFAULT_SETTINGS.respectShutdownActionNone),
    owners: Array.isArray(owners)
      ? owners
          .filter((owner): owner is string => typeof owner === 'string')
          .map((owner) => owner.trim())
          .filter((owner) => owner !== '')
      : [],
    includeArchived: bool('includeArchived', DEFAULT_SETTINGS.includeArchived),
    includeForks: bool('includeForks', DEFAULT_SETTINGS.includeForks),
    showOnlyDevspaces: bool('showOnlyDevspaces', DEFAULT_SETTINGS.showOnlyDevspaces ?? false),
    refreshIntervalMinutes: number(
      'refreshIntervalMinutes',
      DEFAULT_SETTINGS.refreshIntervalMinutes,
      1,
      MAX_REFRESH_INTERVAL_MINUTES,
    ),
    hostAccessChecksOff: parseHostAccessChecksOff(get('hostAccessChecksOff')).repositories,
    // The entries are checked where they are used (repositoryGroups.ts), so that each problem can be named.
    repositoryGroups: Array.isArray(repositoryGroups) ? [...(repositoryGroups as unknown[])] : [],
    openInNewWindow: bool('openInNewWindow', DEFAULT_SETTINGS.openInNewWindow ?? false),
    stopAfterMinutes: number(
      'stopAfterMinutes',
      DEFAULT_SETTINGS.stopAfterMinutes ?? 10,
      MIN_STOP_AFTER_MINUTES,
      MAX_STOP_AFTER_MINUTES,
    ),
    // A cron expression of five fields, or an interval of at least 5 whole minutes; anything else: the default, daily
    // at 06:07 (normalizeCacheSchedule; warnInvalidCacheUpdateSchedule names it).
    cacheUpdateSchedule: normalizeCacheSchedule(get('cacheUpdateSchedule')),
    // The Monitor of an engine runs permanently once the user answered the question about it there, unless this is
    // true (monitorQuestion.ts writes it).
    stopMonitorWhenIdle: bool('stopMonitorWhenIdle', DEFAULT_SETTINGS.stopMonitorWhenIdle ?? false),
    // `ask`, or else the default `notify`.
    updateContainer: get('updateContainer') === 'ask' ? 'ask' : 'notify',
    // The image reference, or '' (none; an invalid value is ignored, warnInvalidDefaultImage names it).
    defaultImage: normalizeDefaultImage(get('defaultImage')) ?? '',
    startWithDefaultImage: bool('startWithDefaultImage', DEFAULT_SETTINGS.startWithDefaultImage ?? true),
  };
}
