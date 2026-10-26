// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { DOUBLE_CLICK_INTERVAL_MS, RowActivationTracker, activatedRow, normalizeListOpenMode } from './rowActivation';
import { rowActions } from './treeModel';

describe('RowActivationTracker (double-click on a repository row)', () => {
  /** A tracker whose activations name their time. */
  function tracker(): { activate: (rowId: string, at: number) => boolean } {
    let time = 0;
    const rows = new RowActivationTracker({ now: () => time });
    return {
      activate: (rowId, at) => {
        time = at;
        return rows.activate(rowId, 'singleClick');
      },
    };
  }

  it('waits 500 ms for the second click', () => {
    expect(DOUBLE_CLICK_INTERVAL_MS).toBe(500);
  });

  it('counts a single click as no double-click', () => {
    expect(tracker().activate('repo:acme/api', 1000)).toBe(false);
  });

  it('counts a second activation of the same row within the interval as a double-click', () => {
    const rows = tracker();
    expect(rows.activate('repo:acme/api', 1000)).toBe(false);
    expect(rows.activate('repo:acme/api', 1000 + DOUBLE_CLICK_INTERVAL_MS)).toBe(true);
  });

  it('counts no double-click across rows, or slower than the interval', () => {
    const rows = tracker();
    expect(rows.activate('repo:acme/api', 1000)).toBe(false);
    expect(rows.activate('repo:acme/web', 1100)).toBe(false);
    expect(rows.activate('repo:acme/api', 1200)).toBe(false);
    expect(rows.activate('repo:acme/api', 1201 + DOUBLE_CLICK_INTERVAL_MS)).toBe(false);
    // A clock that went back.
    expect(rows.activate('repo:acme/api', 1000)).toBe(false);
  });

  it('starts over after a double-click, so a triple click is one double-click', () => {
    const rows = tracker();
    expect([100, 200, 300].map((at) => rows.activate('repo:acme/api', at))).toEqual([false, true, false]);
    // The third click begins a new pair.
    expect(rows.activate('repo:acme/api', 400)).toBe(true);
  });

  it('counts the activation right after Enter at once, and only that one', () => {
    let time = 0;
    const rows = new RowActivationTracker({ now: () => time });
    rows.enter();
    time = 50;
    expect(rows.activate('repo:acme/api', 'singleClick')).toBe(true);
    // The next click is a single click again.
    time = 100;
    expect(rows.activate('repo:acme/api', 'singleClick')).toBe(false);
  });

  it('forgets an Enter when told so: the next activation is a click again', () => {
    let time = 0;
    const rows = new RowActivationTracker({ now: () => time });
    rows.enter();
    rows.forgetEnter();
    time = 50;
    expect(rows.activate('repo:acme/api', 'singleClick')).toBe(false);
  });

  it('forgets an Enter after the interval, or when the clock went back', () => {
    let time = 1000;
    const rows = new RowActivationTracker({ now: () => time });
    rows.enter();
    time = 1001 + DOUBLE_CLICK_INTERVAL_MS;
    expect(rows.activate('repo:acme/api', 'singleClick')).toBe(false);
    time = 5000;
    rows.enter();
    time = 4000;
    expect(rows.activate('repo:acme/web', 'singleClick')).toBe(false);
  });

  it('counts every activation in the mode doubleClick, where VS Code sends only double-clicks and Enter', () => {
    const rows = new RowActivationTracker({ now: () => 0 });
    expect(rows.activate('repo:acme/api', 'doubleClick')).toBe(true);
    expect(rows.activate('repo:acme/api', 'doubleClick')).toBe(true);
    // A single click after a switch to singleClick starts a new pair.
    expect(rows.activate('repo:acme/api', 'singleClick')).toBe(false);
  });
});

describe('normalizeListOpenMode', () => {
  it('reads doubleClick, and everything else as the default singleClick', () => {
    expect(normalizeListOpenMode('doubleClick')).toBe('doubleClick');
    for (const value of ['singleClick', undefined, null, 'DoubleClick', 2]) expect(normalizeListOpenMode(value)).toBe('singleClick');
  });
});

describe('activatedRow', () => {
  it('takes the id and the Start flag of a repository row', () => {
    const row = { kind: 'repository', id: 'repo:acme/api', repository: 'acme/api' };
    const stopped = { ...row, actions: rowActions('stopped', undefined) };
    expect(activatedRow(stopped)).toStrictEqual({ id: 'repo:acme/api', canStart: true, start: stopped });
    const connected = { ...row, actions: rowActions('connected', undefined) };
    expect(activatedRow(connected)).toEqual({ id: 'repo:acme/api', canStart: false, start: connected });
    const updating = { ...row, actions: rowActions('updating', undefined) };
    expect(activatedRow(updating)).toEqual({ id: 'repo:acme/api', canStart: false, start: updating });
    expect(activatedRow(row)).toEqual({ id: 'repo:acme/api', canStart: true, start: row });
  });

  it('takes the id of a repository with several sources, and its first child row to start', () => {
    const first = { kind: 'repository', id: 'repo:acme/api:default', repository: 'acme/api', actions: rowActions('stopped', undefined) };
    const second = { kind: 'repository', id: 'repo:acme/api:config', repository: 'acme/api', actions: rowActions(undefined, undefined) };
    const node = { kind: 'repositoryNode', id: 'repo:acme/api', repository: 'acme/api', children: [first, second] };
    expect(activatedRow(node)).toEqual({ id: 'repo:acme/api', canStart: true, start: first, childId: 'repo:acme/api:default' });
    // The first child row shows no Start: the node starts nothing either.
    const updating = { ...first, actions: rowActions('updating', undefined) };
    expect(activatedRow({ ...node, children: [updating, second] })).toEqual({ id: 'repo:acme/api', canStart: false, start: updating, childId: 'repo:acme/api:default' });
  });

  it('ignores everything else', () => {
    for (const argument of [undefined, null, 'repo:acme/api', { kind: 'owner', id: 'owner:acme' }, { kind: 'repository', id: '' }, { kind: 'repository' }]) {
      expect(activatedRow(argument)).toBeUndefined();
    }
    // A node without a child row, or whose first child is no repository row.
    const node = { kind: 'repositoryNode', id: 'repo:acme/api', repository: 'acme/api' };
    for (const children of [undefined, [], [{ kind: 'group', id: 'group:acme/x' }], [{ ...node, children: [] }]]) {
      expect(activatedRow({ ...node, children }), JSON.stringify(children)).toBeUndefined();
    }
    expect(activatedRow({ kind: 'repositoryNode', id: '', children: [{ kind: 'repository', id: 'repo:acme/api:default' }] })).toBeUndefined();
  });
});
