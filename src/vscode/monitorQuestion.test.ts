// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The question about the Monitor of a Docker engine (monitorQuestion.ts): once per engine while the setting
// stopMonitorWhenIdle is not on; "Keep Running" first; the answer goes into the user setting, then into the records of
// the engines; a closed question stores nothing and comes again; one question per engine at a time.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { Actions } from '../core/messages';
import { DockerEngineRecords, type EngineRemoval } from '../core/storage/dockerEngineRecords';
import { ControllerTexts } from './controllerTexts';
import { MonitorQuestion, STOP_MONITOR_WHEN_IDLE_SETTING } from './monitorQuestion';
import { SETTINGS_SECTION } from './settings';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';

const NOW = Date.parse('2026-10-16T08:00:00.000Z');

let dir: string;
let records: DockerEngineRecords;
let settings: { stopMonitorWhenIdle?: boolean };
let update: ReturnType<typeof vi.fn>;
/** The order of the writes: the setting and the record. */
let writes: string[];
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };
/** Opens the log: the action Show details of the warning. */
const showLog = vi.fn();

beforeEach(() => {
  resetFakeVscode();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-question-'));
  records = new DockerEngineRecords(path.join(dir, 'docker-engines.json'));
  settings = {};
  writes = [];
  update = vi.fn(async (key: string, value: unknown) => {
    writes.push(`${key}=${String(value)}`);
    settings = { stopMonitorWhenIdle: value as boolean };
  });
  fakeVscode.workspace.getConfiguration.mockImplementation((section: string) => (section === SETTINGS_SECTION ? { update } : undefined));
  for (const mock of Object.values(logger)) mock.mockReset();
  showLog.mockReset();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function question(over: Partial<ConstructorParameters<typeof MonitorQuestion>[0]> = {}): MonitorQuestion {
  const recording = {
    monitorAnswered: (host: string) => records.monitorAnswered(host),
    recordMonitorAnswer: async (host: string, now: number, runs?: (removal: EngineRemoval) => boolean) => {
      writes.push(`record ${host}`);
      return records.recordMonitorAnswer(host, now, runs);
    },
  };
  return new MonitorQuestion({ records: recording, settings: () => settings, logger, showLog, clock: { now: () => NOW }, ...over });
}

function modals(): unknown[][] {
  return fakeVscode.window.showInformationMessage.mock.calls;
}

describe('the question about the Monitor of an engine', () => {
  it('asks with "Keep Running" first; the answer writes the user setting, then records the engine', async () => {
    fakeVscode.window.showInformationMessage.mockResolvedValueOnce(ControllerTexts.keepMonitorRunning);
    await expect(question().askIfNeeded('build-box')).resolves.toBe('keepRunning');
    expect(modals()).toEqual([
      [
        'Keep the Devspaces background container running on build-box?',
        { modal: true, detail: ControllerTexts.monitorQuestionDetail },
        'Keep Running',
        'Stop When Idle',
      ],
    ]);
    // An explicit user value, also for the default.
    expect(update).toHaveBeenCalledWith(STOP_MONITOR_WHEN_IDLE_SETTING, false, fakeVscode.ConfigurationTarget.Global);
    expect(writes).toEqual(['stopMonitorWhenIdle=false', 'record build-box']);
    expect(await records.read()).toEqual([{ host: 'build-box', monitorAnsweredAt: NOW }]);
    // Asked once per engine: the next flow there asks nothing; another engine is asked.
    await expect(question().askIfNeeded('build-box')).resolves.toBe('notNeeded');
    await question().askIfNeeded('');
    expect(modals()).toHaveLength(2);
    expect(modals()[1][0]).toBe('Keep the Devspaces background container running on the local Docker?');
  });

  it('the detail says that only Stop When Idle applies to all engines, and names the build of the next image', () => {
    const detail = ControllerTexts.monitorQuestionDetail;
    // Keep Running records this engine only: the next engine asks again (see the test above).
    expect(detail).toContain('Keep Running applies to this Docker engine only. If you choose Stop When Idle, this applies to all Docker engines');
    // A running Monitor keeps its mode until the next ensure on its engine: a start of a devspace, or Update All Images Now.
    expect(detail).toContain('each from the next start of a devspace or "Update All Images Now" there.');
    expect(detail).not.toContain('Your answer applies to all Docker engines');
    // The prepares of the background run.
    expect(detail).toContain('it also builds the next image of that devspace');
  });

  it('"Stop When Idle" turns the setting on (for every engine); then no engine is asked', async () => {
    fakeVscode.window.showInformationMessage.mockResolvedValueOnce(ControllerTexts.stopMonitorWhenIdle);
    await expect(question().askIfNeeded('')).resolves.toBe('stopWhenIdle');
    expect(writes).toEqual(['stopMonitorWhenIdle=true', 'record ']);
    await expect(question().askIfNeeded('build-box')).resolves.toBe('notNeeded');
    expect(modals()).toHaveLength(1);
  });

  it('a closed question stores nothing, and the next flow asks again', async () => {
    const asked = question();
    await expect(asked.askIfNeeded('')).resolves.toBe('closed');
    expect(update).not.toHaveBeenCalled();
    expect(await records.read()).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('the Monitor there stops when no devspace runs'));
    await expect(asked.askIfNeeded('')).resolves.toBe('closed');
    expect(modals()).toHaveLength(2);
  });

  it('asks nothing while the setting is on, or when another window answered before the question opened', async () => {
    settings = { stopMonitorWhenIdle: true };
    await expect(question().askIfNeeded('')).resolves.toBe('notNeeded');
    settings = { stopMonitorWhenIdle: false };
    await records.recordMonitorAnswer('', NOW - 1);
    await expect(question().askIfNeeded('')).resolves.toBe('notNeeded');
    expect(modals()).toEqual([]);
    expect(update).not.toHaveBeenCalled();
  });

  it('one question per engine at a time: a second flow there gets the same answer', async () => {
    let answer!: (choice: string | undefined) => void;
    fakeVscode.window.showInformationMessage.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const asked = question();
    const first = asked.askIfNeeded('build-box');
    const second = asked.askIfNeeded('build-box');
    await vi.waitFor(() => expect(modals()).toHaveLength(1));
    answer(ControllerTexts.keepMonitorRunning);
    await expect(Promise.all([first, second])).resolves.toEqual(['keepRunning', 'keepRunning']);
    expect(modals()).toHaveLength(1);
    expect(writes).toEqual(['stopMonitorWhenIdle=false', 'record build-box']);
  });

  it('an answer that cannot be stored counts as closed, with a warning whose Show details opens the log', async () => {
    fakeVscode.window.showInformationMessage.mockResolvedValue(ControllerTexts.keepMonitorRunning);
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.showDetails);
    update.mockRejectedValueOnce(new Error('Unable to write into user settings.'));
    await expect(question().askIfNeeded('')).resolves.toBe('closed');
    expect(await records.read()).toEqual([]);
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledWith(ControllerTexts.monitorAnswerNotSaved, Actions.showDetails);
    await vi.waitFor(() => expect(showLog).toHaveBeenCalledTimes(1));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Unable to write into user settings.'));
    // The record of the engine fails: no answer either.
    const failing = question({
      records: { monitorAnswered: async () => false, recordMonitorAnswer: async () => Promise.reject(new Error('EACCES: permission denied')) },
    });
    await expect(failing.askIfNeeded('')).resolves.toBe('closed');
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledTimes(2);
    // Closed without Show details: the log does not open.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(showLog).toHaveBeenCalledTimes(1);
  });

  // Another window began "Remove Devspaces from This Docker Engine…" there while the question was open: its mark forgot
  // the answer of the engine. Mutation: an answer written into the marked record outlives the removal, and the next
  // Start there does not ask.
  it('an answer while another window removes Devspaces from the engine is not recorded for it; the next flow asks again', async () => {
    const other: EngineRemoval = { windowId: 'window-b', pid: 4200, since: '2026-10-16T07:59:00.000Z' };
    fakeVscode.window.showInformationMessage.mockImplementationOnce(async () => {
      await records.startRemoval('build-box', other, NOW, () => true);
      return ControllerTexts.keepMonitorRunning;
    });
    let read = 0;
    // The liveness rule of the busy marks (the controller's): the process 4200 runs.
    const removalRuns = async () => {
      read += 1;
      return (removal: EngineRemoval) => removal.pid === other.pid;
    };
    await expect(question().askIfNeeded('build-box', removalRuns)).resolves.toBe('closed');
    expect(read).toBe(1);
    expect(logger.info).toHaveBeenCalledWith('The answer about the Monitor on build-box is not recorded for that engine: Devspaces is being removed from there in another window (process 4200).');
    // The setting holds the answer; the engine has none, also after the end of that removal.
    expect(writes).toEqual(['stopMonitorWhenIdle=false', 'record build-box']);
    await records.endRemoval('build-box', other);
    expect(await records.monitorAnswered('build-box')).toBe(false);
    fakeVscode.window.showInformationMessage.mockResolvedValueOnce(ControllerTexts.keepMonitorRunning);
    await expect(question().askIfNeeded('build-box', removalRuns)).resolves.toBe('keepRunning');
    expect(modals()).toHaveLength(2);
    expect(await records.monitorAnswered('build-box')).toBe(true);
    // The entry of a removal whose window ended keeps no answer away.
    await records.startRemoval('', other, NOW, () => true);
    fakeVscode.window.showInformationMessage.mockResolvedValueOnce(ControllerTexts.stopMonitorWhenIdle);
    settings = {};
    await expect(question().askIfNeeded('', async () => () => false)).resolves.toBe('stopWhenIdle');
    expect(await records.monitorAnswered('')).toBe(true);
  });

  it('a question that cannot be shown counts as closed and stores nothing', async () => {
    fakeVscode.window.showInformationMessage.mockRejectedValueOnce(new Error('no window'));
    await expect(question().askIfNeeded('')).resolves.toBe('closed');
    expect(update).not.toHaveBeenCalled();
    expect(fakeVscode.window.showWarningMessage).not.toHaveBeenCalled();
  });
});
