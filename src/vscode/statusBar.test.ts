// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { DevspaceStatusBar } from './statusBar';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';

describe('DevspaceStatusBar', () => {
  beforeEach(() => resetFakeVscode());

  function create() {
    const bar = new DevspaceStatusBar();
    const item = fakeVscode.statusBarItems[0];
    return { bar, item };
  }

  it('is one visible item on the left side, not connected at first', () => {
    const { item } = create();
    expect(fakeVscode.statusBarItems).toHaveLength(1);
    expect(item.alignment).toBe(fakeVscode.StatusBarAlignment.Left);
    expect(item.visible).toBe(true);
    // The switched-off monitor of the sidebar.
    expect(item.text).toBe('$(devspaces-monitor-off) Open devspace…');
    expect(item.command).toBe('devspaces.switchDevspace');
  });

  it('shows the connected devspace and its branch; a click opens the switcher', () => {
    const { bar, item } = create();
    bar.showConnected('acme-university/api', 'main');
    // The monitor of the sidebar with the connection sign.
    expect(item.text).toBe('$(devspaces-monitor-connected) acme-university/api · main');
    expect(item.command).toBe('devspaces.switchDevspace');
    bar.showConnected('acme-university/api', undefined);
    // The monitor of the sidebar with the connection sign.
    expect(item.text).toBe('$(devspaces-monitor-connected) acme-university/api');
  });

  // State unknown: the tooltip says it, the state shown stays.
  it('says in the tooltip of the connected devspace that the state of its container could not be read', () => {
    const { bar, item } = create();
    bar.showConnected('acme-university/api', 'main');
    bar.showStateUnknown(true);
    expect(item.text).toBe('$(devspaces-monitor-connected) acme-university/api · main');
    expect(item.tooltip).toContain('could not be read');
    expect(item.command).toBe('devspaces.switchDevspace');
    bar.showStateUnknown(false);
    expect(item.tooltip).toBe('Connected to acme-university/api. Select to switch the devspace.');
  });

  it('shows Updating over the current state until the operation ends; a click shows the details', () => {
    const { bar, item } = create();
    bar.showConnected('acme-university/api', 'main');
    bar.showBusy('acme-university/web');
    // The monitor with the clock.
    expect(item.text).toBe('$(devspaces-monitor-updating) Updating acme-university/web…');
    expect(item.command).toBe('devspaces.showLog');
    bar.showConnected('acme-university/api', 'dev');
    // The monitor with the clock.
    expect(item.text).toBe('$(devspaces-monitor-updating) Updating acme-university/web…');
    bar.clearBusy();
    // The monitor of the sidebar with the connection sign.
    expect(item.text).toBe('$(devspaces-monitor-connected) acme-university/api · dev');
  });

  it('gives a screen reader the state and the action, not the name of the icon', () => {
    const { bar, item } = create();
    expect(item.accessibilityInformation).toEqual({ label: 'Devspaces: this window has no devspace. Select to open a devspace.' });
    bar.showConnected('acme-university/api', 'main');
    expect(item.accessibilityInformation).toEqual({ label: 'Devspaces: connected to acme-university/api, branch main. Select to switch the devspace.' });
    bar.showStateUnknown(true);
    expect(item.accessibilityInformation?.label).toBe(
      'Devspaces: connected to acme-university/api, branch main. The state of its container could not be read; details are in the log. Select to switch the devspace.',
    );
    bar.showStateUnknown(false);
    bar.showConnected('acme-university/api', undefined);
    expect(item.accessibilityInformation?.label).toBe('Devspaces: connected to acme-university/api. Select to switch the devspace.');
    bar.showBusy('acme-university/web');
    expect(item.accessibilityInformation?.label).toBe('Devspaces: updating acme-university/web. Select to show the details.');
    bar.clearBusy();
    bar.showConnectionLost('acme-university/api', 'env-1');
    expect(item.accessibilityInformation?.label).toBe('Devspaces: the connection to acme-university/api was lost. Select to reconnect.');
  });

  it('offers Reconnect when the connection is lost; a click runs Start for the devspace', () => {
    const { bar, item } = create();
    bar.showConnectionLost('acme-university/api', 'env-1');
    expect(item.text).toBe('$(warning) Reconnect acme-university/api');
    expect(item.command).toMatchObject({ command: 'devspaces.start', arguments: [{ devspaceId: 'env-1' }] });
    expect(item.backgroundColor?.id).toBe('statusBarItem.warningBackground');
    bar.showNotConnected();
    // The switched-off monitor of the sidebar.
    expect(item.text).toBe('$(devspaces-monitor-off) Open devspace…');
    expect(item.backgroundColor).toBeUndefined();
  });

  it('removes the item on dispose', () => {
    const { bar, item } = create();
    bar.dispose();
    expect(item.disposed).toBe(true);
  });
});
