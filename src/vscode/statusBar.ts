// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Status bar item: one item on the left side.
import * as vscode from 'vscode';
import { Actions } from '../core/messages';
import { SHOW_LOG_COMMAND } from './progress';
import { MonitorIcons } from './treeModel';

export const STATUS_BAR_ITEM_ID = 'devspaces.status';
const SWITCH_DEVSPACE_COMMAND = 'devspaces.switchDevspace';
const START_COMMAND = 'devspaces.start';
// Left side, next to the remote indicator of VS Code.
const PRIORITY = 1000;

// User-visible texts that messages.ts lacks; to be moved there.
export const StatusBarTexts = {
  name: 'Devspaces',
  openDevspace: 'Open devspace…',
  updating: (repository: string) => `Updating ${repository}…`,
  reconnect: (repository: string) => `Reconnect ${repository}`,
  connectedTooltip: (repository: string) => `Connected to ${repository}. Select to switch the devspace.`,
  // The window shows that the state of its container could not be read.
  stateUnknownTooltip: (repository: string) =>
    `Connected to ${repository}. The state of its container could not be read; details are in the log. Select to switch the devspace.`,
  notConnectedTooltip: 'Select to open a devspace.',
  connectionLostTooltip: (repository: string) => `The connection to ${repository} was lost. Select to reconnect.`,
  // The texts that a screen reader reads for the item (accessibilityInformation): the name, the state, and what a
  // selection does. The text of the item starts with an icon, which a screen reader would read by its name.
  connectedLabel: (repository: string, branch: string | undefined, stateUnknown: boolean) =>
    `Devspaces: connected to ${repository}${branch === undefined ? '' : `, branch ${branch}`}.${
      stateUnknown ? ' The state of its container could not be read; details are in the log.' : ''
    } Select to switch the devspace.`,
  notConnectedLabel: 'Devspaces: this window has no devspace. Select to open a devspace.',
  updatingLabel: (repository: string) => `Devspaces: updating ${repository}. Select to show the details.`,
  connectionLostLabel: (repository: string) => `Devspaces: the connection to ${repository} was lost. Select to reconnect.`,
} as const;

type BaseState =
  | { kind: 'connected'; repository: string; branch?: string }
  | { kind: 'notConnected' }
  | { kind: 'connectionLost'; repository: string; devspaceId: string };

/**
 * Shows the connected, not connected, or connection lost state. `showBusy` puts "Updating …" over this state until
 * `clearBusy`; the other methods change the state below it, so the order of calls does not matter.
 */
export class DevspaceStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private base: BaseState = { kind: 'notConnected' };
  private busyRepository: string | undefined;
  private stateUnknown = false;

  constructor() {
    this.item = vscode.window.createStatusBarItem(STATUS_BAR_ITEM_ID, vscode.StatusBarAlignment.Left, PRIORITY);
    this.item.name = StatusBarTexts.name;
    this.render();
    this.item.show();
  }

  /** `$(devspaces-monitor-connected) owner/name · branch`; select → switcher. */
  showConnected(repository: string, branch: string | undefined): void {
    this.base = { kind: 'connected', repository, branch: branch?.trim() || undefined };
    this.render();
  }

  /**
   * Whether the state of the container of the connected devspace could not be read ("unknown"); its tooltip says so.
   * The state shown stays as it is.
   */
  showStateUnknown(unknown: boolean): void {
    if (this.stateUnknown === unknown) return;
    this.stateUnknown = unknown;
    this.render();
  }

  /** `$(devspaces-monitor-off) Open devspace…`; select → switcher. */
  showNotConnected(): void {
    this.base = { kind: 'notConnected' };
    this.render();
  }

  /** `$(devspaces-monitor-updating) Updating owner/name…`; select → log with the progress details. */
  showBusy(repository: string): void {
    this.busyRepository = repository;
    this.render();
  }

  /** Removes the busy state and shows the state below it again. */
  clearBusy(): void {
    this.busyRepository = undefined;
    this.render();
  }

  /** `$(warning) Reconnect owner/name`; select → `devspaces.start` with `{ devspaceId }` (open pipeline). */
  showConnectionLost(repository: string, devspaceId: string): void {
    this.base = { kind: 'connectionLost', repository, devspaceId };
    this.render();
  }

  dispose(): void {
    this.item.dispose();
  }

  private render(): void {
    const item = this.item;
    item.backgroundColor = undefined;
    if (this.busyRepository !== undefined) {
      // The monitor with the clock.
      item.text = `$(${MonitorIcons.updating}) ${StatusBarTexts.updating(this.busyRepository)}`;
      item.tooltip = Actions.showDetails;
      item.accessibilityInformation = { label: StatusBarTexts.updatingLabel(this.busyRepository) };
      item.command = SHOW_LOG_COMMAND;
      return;
    }
    const state = this.base;
    switch (state.kind) {
      case 'connected':
        // The monitors of the sidebar, with the connection sign for this window.
        item.text = state.branch
          ? `$(${MonitorIcons.connected}) ${state.repository} · ${state.branch}`
          : `$(${MonitorIcons.connected}) ${state.repository}`;
        item.tooltip = this.stateUnknown ? StatusBarTexts.stateUnknownTooltip(state.repository) : StatusBarTexts.connectedTooltip(state.repository);
        item.accessibilityInformation = { label: StatusBarTexts.connectedLabel(state.repository, state.branch, this.stateUnknown) };
        item.command = SWITCH_DEVSPACE_COMMAND;
        return;
      case 'notConnected':
        item.text = `$(${MonitorIcons.off}) ${StatusBarTexts.openDevspace}`;
        item.tooltip = StatusBarTexts.notConnectedTooltip;
        item.accessibilityInformation = { label: StatusBarTexts.notConnectedLabel };
        item.command = SWITCH_DEVSPACE_COMMAND;
        return;
      case 'connectionLost':
        item.text = `$(warning) ${StatusBarTexts.reconnect(state.repository)}`;
        item.tooltip = StatusBarTexts.connectionLostTooltip(state.repository);
        item.accessibilityInformation = { label: StatusBarTexts.connectionLostLabel(state.repository) };
        item.command = {
          command: START_COMMAND,
          title: StatusBarTexts.reconnect(state.repository),
          arguments: [{ devspaceId: state.devspaceId }],
        };
        item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        return;
    }
  }
}
