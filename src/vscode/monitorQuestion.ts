// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The question about the Monitor of a Docker engine: keep its container devspaces-monitor running, also while VS Code
// is closed, or let it stop when no devspace runs. It is asked once per engine (one question per engine at a time in
// this window; two windows that start at the same moment can both ask, and the last answer counts), in a flow that the
// user started (a Start, a Rebuild, "Update All Images Now"; the controller asks before the flow runs), and only while
// the setting devspaces.stopMonitorWhenIdle is not on. The flows that run by themselves (the reopen at startup, an
// attached window, a pending operation, the repair of the heartbeats) never ask: until the engine has an answer, its
// Monitor stops when idle (monitorSettings.ts). The answer goes into the user setting devspaces.stopMonitorWhenIdle,
// which applies to every engine from the next ensure of its Monitor (a running Monitor keeps its mode until then), and
// then the engine is recorded as answered (DockerEngineRecords). A closed question stores nothing: the flow goes on
// with a Monitor that stops when idle, and the next flow of the user asks again.
import * as vscode from 'vscode';
import { describeDockerHost } from '../core/docker/dockerHost';
import { errorMessage } from '../core/errors';
import { Actions } from '../core/messages';
import { systemClock, type Clock, type Logger } from '../core/ports';
import type { DockerEngineRecords, EngineRemoval } from '../core/storage/dockerEngineRecords';
import type { ExtensionSettings } from '../core/types';
import { ControllerTexts } from './controllerTexts';
import { showInformationMessage, showWarningMessage } from './notifications';
import { SETTINGS_SECTION } from './settings';

/** The key of the setting that the answer writes (devspaces.stopMonitorWhenIdle). */
export const STOP_MONITOR_WHEN_IDLE_SETTING = 'stopMonitorWhenIdle';

/**
 * What the question gave: `keepRunning` or `stopWhenIdle` (stored), `closed` (closed, or the answer could not be
 * stored: nothing that counts is stored; or it was not recorded for the engine because another window removes
 * Devspaces from it: the engine has no answer), or `notNeeded` (the setting is on, or the engine has its answer).
 */
export type MonitorAnswer = 'keepRunning' | 'stopWhenIdle' | 'closed' | 'notNeeded';

export interface MonitorQuestionDeps {
  /** The records of the engines (docker-engines.json). */
  records: Pick<DockerEngineRecords, 'monitorAnswered' | 'recordMonitorAnswer'>;
  settings: () => Pick<ExtensionSettings, 'stopMonitorWhenIdle'>;
  logger: Logger;
  /** Opens the log (action Show details of the warning that the answer could not be saved). */
  showLog: () => void;
  clock?: Clock;
}

export class MonitorQuestion {
  /** The question that is open for an engine (by its host); a second flow there waits for its answer. */
  private readonly asking = new Map<string, Promise<MonitorAnswer>>();

  constructor(private readonly deps: MonitorQuestionDeps) {}

  /**
   * Asks about the Monitor of the engine `host` ('' for the local Docker) when it is needed: the setting is not on and
   * the engine has no answer, as read now (another window may have answered meanwhile). One question per engine at a
   * time in this window. `removalRuns`: the liveness rule of the busy marks for a removal that the record of the engine
   * names (the controller's), read when the answer is recorded; without it, every such removal counts as running.
   * Never rejects.
   */
  askIfNeeded(host: string, removalRuns?: () => Promise<(removal: EngineRemoval) => boolean>): Promise<MonitorAnswer> {
    const open = this.asking.get(host);
    if (open !== undefined) return open;
    const question = this.ask(host, removalRuns).finally(() => this.asking.delete(host));
    this.asking.set(host, question);
    return question;
  }

  private async ask(host: string, removalRuns?: () => Promise<(removal: EngineRemoval) => boolean>): Promise<MonitorAnswer> {
    const { records, logger } = this.deps;
    const engine = describeDockerHost(host);
    let choice: string | undefined;
    try {
      if (this.deps.settings().stopMonitorWhenIdle === true || (await records.monitorAnswered(host))) return 'notNeeded';
      choice = await showInformationMessage(
        ControllerTexts.monitorQuestion(engine),
        { modal: true, detail: ControllerTexts.monitorQuestionDetail },
        ControllerTexts.keepMonitorRunning,
        ControllerTexts.stopMonitorWhenIdle,
      );
    } catch (error) {
      logger.warn(`The question about the Monitor on ${engine} could not be shown. Until it is answered, the Monitor there stops when no devspace runs: ${errorMessage(error)}`);
      return 'closed';
    }
    if (choice !== ControllerTexts.keepMonitorRunning && choice !== ControllerTexts.stopMonitorWhenIdle) {
      logger.info(`The question about the Monitor on ${engine} was closed. Until it is answered, the Monitor there stops when no devspace runs.`);
      return 'closed';
    }
    const stop = choice === ControllerTexts.stopMonitorWhenIdle;
    let recorded: { recorded: boolean; other?: EngineRemoval };
    try {
      // The setting first (an explicit user value, also for the default), then the record of the engine: until both are
      // written, the Monitor of the engine stops when idle.
      await vscode.workspace.getConfiguration(SETTINGS_SECTION).update(STOP_MONITOR_WHEN_IDLE_SETTING, stop, vscode.ConfigurationTarget.Global);
      recorded = await records.recordMonitorAnswer(host, (this.deps.clock ?? systemClock).now(), await removalRuns?.());
    } catch (error) {
      logger.warn(`The answer about the Monitor on ${engine} could not be stored. Until it is stored, the Monitor there stops when no devspace runs: ${errorMessage(error)}`);
      showWarningMessage(ControllerTexts.monitorAnswerNotSaved, Actions.showDetails).then(
        (action) => {
          if (action === Actions.showDetails) this.deps.showLog();
        },
        (shown: unknown) => logger.error('Could not show the message.', shown),
      );
      return 'closed';
    }
    if (!recorded.recorded) {
      // A removal that another window began while the question was open forgot the answer of the engine (its mark): the
      // next flow of the user there asks again.
      logger.info(
        `The answer about the Monitor on ${engine} is not recorded for that engine: Devspaces is being removed from there in another window${recorded.other !== undefined ? ` (process ${recorded.other.pid})` : ''}.`,
      );
      return 'closed';
    }
    logger.info(
      stop
        ? `The Monitor on ${engine} stops when no devspace runs (the answer to the question; the setting stopMonitorWhenIdle is on, for every engine).`
        : `The Monitor on ${engine} keeps running, also while no devspace runs (the answer to the question; the setting stopMonitorWhenIdle is off).`,
    );
    return stop ? 'stopWhenIdle' : 'keepRunning';
  }
}
