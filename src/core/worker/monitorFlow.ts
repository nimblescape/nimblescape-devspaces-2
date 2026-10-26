// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The commands of the Monitor container of the worker's engine (`monitor.js` in `devspaces-monitor`),
// over the Engine API (`exec`); every remote action is a worker operation: the heartbeat, its image settings and image
// list (on the input of the command), and Delete's `forget`. Pure over the port; no `vscode`. Each command is an entry
// of the registry of the container scripts (monitorHeartbeat, monitorForget, monitorSettings, monitorImages in
// containerScripts.ts), run by runScript; this module builds no command of its own.
import { errorMessage } from '../errors';
import { MAX_MONITOR_DETAIL_LENGTH, type HeartbeatValue } from '../helperChannel/protocol';
import { REMOTE_MONITOR_CONTAINER, isUnderRecordsLock, monitorExecFailure, type HeartbeatInput, type ImageSettings, type ImagesInput } from '../remoteMonitor/protocol';
import { runScript, scriptCommand, type ContainerScript } from './containerScripts';
import { isMissing, isNotRunning, type DockerEngine } from './dockerEngine';

/** The time limit of a command in the Monitor container. */
export const MONITOR_EXEC_TIMEOUT_MS = 20_000;

/** The entries of the registry that run in the Monitor container. */
export type MonitorScript = Extract<ContainerScript, 'monitorHeartbeat' | 'monitorForget' | 'monitorSettings' | 'monitorImages' | 'monitorRunNow'>;

/**
 * One command in the monitor container: ok, or the reason it failed; `missing` when the container does not exist or
 * does not run (isNotRunning, or the caller's own rule `missing`). Never throws, except an AbortError of `signal`.
 * `container`: the monitor container (REMOTE_MONITOR_CONTAINER; a test names its own, the operations never do). The
 * command is the entry `name` of the registry with its arguments, run by runScript; `input` only for an entry that
 * reads one (runScript refuses it for any other). A command under the lock of the records names the busy lock or the
 * kill when it fails without a word of its own.
 */
export async function monitorCommand(
  engine: DockerEngine,
  name: MonitorScript,
  args: readonly string[],
  options: { input?: string; signal?: AbortSignal; container?: string; missing?: (error: unknown) => boolean } = {},
): Promise<HeartbeatValue> {
  try {
    const result = await runScript(engine, options.container ?? REMOTE_MONITOR_CONTAINER, name, args, {
      timeoutMs: MONITOR_EXEC_TIMEOUT_MS,
      ...(options.input !== undefined ? { input: options.input } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (result.exitCode === 0 && !result.timedOut) return { ok: true };
    const detail = result.timedOut
      ? `docker exec did not end within ${MONITOR_EXEC_TIMEOUT_MS / 1000} seconds.`
      : (result.stderr || result.stdout).trim() || monitorExecFailure(result.exitCode, '', isUnderRecordsLock(scriptCommand(name, args)));
    return { ok: false, missing: false, detail: clip(detail) };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    // The one rule (isNotRunning) unless the caller gives its own (Delete's forget).
    const missing = (options.missing ?? isNotRunning)(error);
    return { ok: false, missing, detail: clip(errorMessage(error)) };
  }
}

/** One heartbeat of a window (the entry monitorHeartbeat, under the lock of the records). */
export function sendHeartbeat(engine: DockerEngine, input: HeartbeatInput, signal?: AbortSignal, container?: string): Promise<HeartbeatValue> {
  return monitorCommand(engine, 'monitorHeartbeat', [JSON.stringify(input)], { signal, ...(container !== undefined ? { container } : {}) });
}

/**
 * The image settings or the image list for the monitor (the entries monitorSettings and monitorImages: `monitor.js
 * settings -` or `images -`, JSON on the input). The open gives them after its ensure (giveMonitorImages). The input of
 * `images -` is ImagesInput: the image references in use of the computer `source`: `{ "source", "references",
 * "digests"? }`.
 */
export function sendMonitorSettings(engine: DockerEngine, params: { settings: ImageSettings } | ImagesInput, signal?: AbortSignal, container?: string): Promise<HeartbeatValue> {
  const named = container !== undefined ? { container } : {};
  if ('settings' in params) return monitorCommand(engine, 'monitorSettings', [], { input: JSON.stringify(params.settings), signal, ...named });
  const input = {
    ...(params.inUse !== undefined ? { source: params.inUse.source, references: params.inUse.references, ...(params.inUse.digests !== undefined ? { digests: params.inUse.digests } : {}) } : {}),
  };
  return monitorCommand(engine, 'monitorImages', [], { input: JSON.stringify(input), signal, ...named });
}

/**
 * "Update All Images Now": asks the monitor for its background run at once (the entry monitorRunNow, `monitor.js
 * run-now`); the monitor runs it at its next check. It does not wait for the run.
 */
export function requestBackgroundRun(engine: DockerEngine, signal?: AbortSignal, container?: string): Promise<HeartbeatValue> {
  return monitorCommand(engine, 'monitorRunNow', [], { signal, ...(container !== undefined ? { container } : {}) });
}

/**
 * Delete's `forget`: the heartbeat record of `source` for the devspace (the entry monitorForget, under the lock of
 * the records). `missing` has its own rule here, any 404 (also "No such exec instance": the monitor container went away
 * between the create and the start of the exec) or a 409 "is not running", because Delete logs no record of a monitor
 * that does not run (workerSessionMonitor); the one rule would make that race a warning.
 */
export function forgetRecord(engine: DockerEngine, source: string, devspaceId: string, container?: string): Promise<HeartbeatValue> {
  return monitorCommand(engine, 'monitorForget', [source, devspaceId], { missing: forgetMissing, ...(container !== undefined ? { container } : {}) });
}

/** The rule of `missing` for Delete's forget (forgetRecord): any 404 of the engine, or the container does not run. */
function forgetMissing(error: unknown): boolean {
  return isMissing(error) || isNotRunning(error);
}

function clip(text: string): string {
  return text.length > MAX_MONITOR_DETAIL_LENGTH ? `${text.slice(0, MAX_MONITOR_DETAIL_LENGTH - 1)}…` : text;
}
