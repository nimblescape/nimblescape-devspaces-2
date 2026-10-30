// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The settings of the Monitor of an engine that extension.ts gives to an open (by the Docker host of the open)
// and to the repair of the heartbeats and "Update All Images Now" (by the Docker target): the schedule of its background
// run (cacheUpdateSchedule), the time zone of this computer, and its mode: permanent on every engine, local or remote,
// once the user answered the question about the Monitor of that engine (monitorQuestion.ts), unless stopMonitorWhenIdle
// is on; before that answer it ends when idle, whatever flow creates it. A permanent one names this computer as its
// owner (its computer ID). No image patterns. Pure apart from the getters it is given; no `vscode`.
import { describeDockerHost, type DockerTarget } from '../core/docker/dockerHost';
import { errorMessage } from '../core/errors';
import type { Logger } from '../core/ports';
import { DEFAULT_CACHE_UPDATE_SCHEDULE, monitorRunsPermanently } from '../core/remoteMonitor/cacheSettings';
import type { MonitorSettings } from '../core/remoteMonitor/protocol';
import type { ExtensionSettings } from '../core/types';

export interface MonitorSettingsDeps {
  settings: () => Pick<ExtensionSettings, 'cacheUpdateSchedule' | 'stopMonitorWhenIdle'>;
  /**
   * Whether the user answered the question about the Monitor of the engine `host` ('' for the local Docker;
   * DockerEngineRecords.monitorAnswered). A failed read counts as no answer, with a warning in `logger`.
   */
  answered: (host: string) => Promise<boolean>;
  /** The time zone of this computer (usableTimeZone). */
  timeZone: () => string;
  /**
   * The ID of this computer (computer.id, 32 hex digits): the owner of a permanent monitor that it asks for. A failure to
   * read it leaves it out (an ensure without it keeps any running permanent monitor), so it never fails an open.
   */
  computerId: () => string;
  /** For the warning about an answer that cannot be read. Default: no log. */
  logger?: Pick<Logger, 'warn'>;
}

/** The settings of the monitor of the engine `host` of this computer (local and remote alike). Never rejects. */
export async function monitorSettingsFor(deps: MonitorSettingsDeps, host: string): Promise<MonitorSettings> {
  const permanent = await monitorPermanentFor(deps, host);
  return {
    schedule: deps.settings().cacheUpdateSchedule ?? DEFAULT_CACHE_UPDATE_SCHEDULE,
    timeZone: deps.timeZone(),
    permanent,
    // This computer: the owner of a permanent monitor that it creates (LABEL_MONITOR_OWNER), and how an ensure tells
    // its own permanent monitor from one that another computer keeps.
    ...computerOf(deps),
  };
}

/**
 * Whether the Monitor of the engine `host` runs permanently: the mode of monitorSettingsFor, without the other settings
 * (the WSL distribution of Devspaces, WslLifetime). The setting is read after the answer, so that both are as new as
 * possible. Never rejects.
 */
export async function monitorPermanentFor(deps: MonitorSettingsDeps, host: string): Promise<boolean> {
  const answered = await answeredOf(deps, host);
  return monitorRunsPermanently(deps.settings().stopMonitorWhenIdle, answered);
}

/**
 * As monitorPermanentFor, but undefined when the answer cannot be read (logged): for the start entry of the WSL
 * distribution of Devspaces, which a failed read must not remove. With stopMonitorWhenIdle on, false without a read of
 * the answer. Never rejects.
 */
export async function monitorPermanentIfKnown(deps: MonitorSettingsDeps, host: string): Promise<boolean | undefined> {
  if (deps.settings().stopMonitorWhenIdle === true) return false;
  let answered: boolean;
  try {
    answered = await deps.answered(host);
  } catch (error) {
    deps.logger?.warn(`The answer about the Monitor on ${describeDockerHost(host)} could not be read, so its start entry stays as it is: ${errorMessage(error)}`);
    return undefined;
  }
  return monitorRunsPermanently(deps.settings().stopMonitorWhenIdle, answered);
}

/**
 * Whether the engine `host` has an answer; false when it cannot be read (logged: the ensure then makes its Monitor one
 * that stops when idle, also in place of a permanent one of this computer).
 */
async function answeredOf(deps: MonitorSettingsDeps, host: string): Promise<boolean> {
  try {
    return await deps.answered(host);
  } catch (error) {
    deps.logger?.warn(`The answer about the Monitor on ${describeDockerHost(host)} could not be read, so the Monitor there stops when no devspace runs: ${errorMessage(error)}`);
    return false;
  }
}

/** `{ computer }` with the ID of this computer, or nothing when it cannot be read. */
function computerOf(deps: MonitorSettingsDeps): { computer?: string } {
  try {
    return { computer: deps.computerId() };
  } catch {
    return {};
  }
}

/**
 * The monitor settings of an open (its Docker host: empty for the local Docker, the SSH host otherwise) and of the
 * repair or "Update All Images Now" on a Docker target: the same rules for every engine, with the answer of that engine.
 */
export function monitorSettingsOf(deps: MonitorSettingsDeps): {
  forOpen(dockerHost: string): Promise<MonitorSettings>;
  forTarget(target: Pick<DockerTarget, 'kind' | 'host'>): Promise<MonitorSettings>;
  /**
   * Whether the Monitor of the engine `host` runs permanently (monitorPermanentFor), for the checks in the background of
   * WslLifetime: an answer that cannot be read is not logged here, because these checks run often; the open and the
   * ensure of the Monitor log it.
   */
  permanent(host: string): Promise<boolean>;
  /** monitorPermanentIfKnown: undefined when the answer cannot be read (logged). */
  permanentIfKnown(host: string): Promise<boolean | undefined>;
} {
  const quiet: MonitorSettingsDeps = { ...deps, logger: undefined };
  return {
    forOpen: (dockerHost) => monitorSettingsFor(deps, dockerHost),
    forTarget: (target) => monitorSettingsFor(deps, target.host),
    permanent: (host) => monitorPermanentFor(quiet, host),
    permanentIfKnown: (host) => monitorPermanentIfKnown(deps, host),
  };
}
