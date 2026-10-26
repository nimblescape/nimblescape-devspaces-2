// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Stop in the worker, the deputy of the window. Under the lock of the devspace (the operation takes it), the Git
// state of the running dev container, then the stop of the dev container and of the running containers of the other
// services of Docker Compose (after the dev container). It is one operation, not one round trip per Docker call on a
// remote host. The extension records the Git state. Stop stops every running container of the devspace: its running
// dev containers in the order of the rule of the dev container (runningDevContainers; the Git state is read from the
// first), then the running services. Pure over the port; no I/O of its own, no `vscode`.
import { errorMessage } from '../errors';
import { LABEL_COMPOSE_SERVICE } from '../names';
import { MAX_STOPPED_SERVICES, MAX_STOP_FAILURE_LENGTH } from '../helperChannel/protocol';
import { readGitSummary } from '../pipeline/refreshStates';
import { withTimeLimit } from '../ports';
import type { GitSummary } from '../types';
import { isMissing, type DockerEngine, type EngineContainer } from './dockerEngine';
import { devspaceContainers, runningDevContainers, runningServices } from './devspaceContainers';

/**
 * The time limit of the stop of one container: its own stop time (which the policy caps at 20 s, else 10 s) and the end
 * of its processes (as DOCKER_QUERY_TIMEOUT_MS of `docker stop` before the move).
 */
export const STOP_CONTAINER_TIMEOUT_MS = 60_000;

export interface StopFlow {
  devspaceId: string;
  containerName: string;
  /** The repository folder in the container (repositoryFolder), for the Git state. */
  folder: string;
  /** The remote user, for the Git state. */
  user?: string;
  engine: DockerEngine;
  log: (line: string) => void;
  /** The time of the Git state (ISO 8601). */
  now: () => string;
  /** Only for the tests: STOP_CONTAINER_TIMEOUT_MS. */
  stopContainerTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface StopResult {
  /** `stopped`: a dev container of the devspace ran (one or more), and is stopped now. */
  outcome: 'stopped' | 'notRunning';
  gitSummary?: GitSummary;
  services: string[];
  failures: string[];
}

/**
 * The Stop of the devspace, under its lock. The Git state is best effort (a failure is logged, the stop goes on). A
 * container that cannot be stopped does not end the flow: the others are stopped anyway, and its reason is answered in
 * `failures` with the Git state (which the extension records before it reports them). A cancel throws its AbortError.
 * Every running dev container is stopped, the one of the Git state first (the dev containers before the services);
 * `services` names the services only, and another dev container that is stopped is named in the log.
 */
export async function stopFlow(p: StopFlow): Promise<StopResult> {
  const containers = await devspaceContainers(p.engine, p.devspaceId, p.signal);
  const devs = runningDevContainers(containers, p.containerName, p.log);
  const failures: string[] = [];
  let gitSummary: GitSummary | undefined;
  if (devs.length === 0) {
    p.log(`The container ${p.containerName} does not run.`);
  } else {
    // The one read of the Git state (readGitSummary); a cancel throws.
    gitSummary = await readGitSummary(p.engine, devs[0], p.user, p.folder, { now: p.now, log: p.log, cancel: 'throw', signal: p.signal });
    await stopContainer(p, devs[0], `Stopping the container ${devs[0].name}.`, failures);
    for (const other of devs.slice(1)) await stopContainer(p, other, `Stopping the container ${other.name}, another dev container of the devspace.`, failures);
  }
  const services: string[] = [];
  for (const service of runningServices(containers, p.containerName)) {
    if (await stopContainer(p, service, `Stopping the container ${service.name} of the service ${service.labels[LABEL_COMPOSE_SERVICE]}.`, failures)) {
      // The answer names at most MAX_STOPPED_SERVICES of them; all are stopped.
      if (services.length < MAX_STOPPED_SERVICES) services.push(service.name);
    }
  }
  return { outcome: devs.length === 0 ? 'notRunning' : 'stopped', ...(gitSummary !== undefined ? { gitSummary } : {}), services, failures };
}

/**
 * `docker stop` of one container, with its own stop time, within STOP_CONTAINER_TIMEOUT_MS. True when it is stopped (or
 * gone); a failure is added to `failures` (its reason, clipped). A cancel throws.
 */
async function stopContainer(p: StopFlow, container: EngineContainer, line: string, failures: string[]): Promise<boolean> {
  p.log(line);
  const limitMs = p.stopContainerTimeoutMs ?? STOP_CONTAINER_TIMEOUT_MS;
  // The one time-limited call (withTimeLimit); past the limit, its own reason.
  let timedOut = false;
  try {
    await withTimeLimit(limitMs, p.signal, (limited) => p.engine.stop(container.id, undefined, limited), () => {
      timedOut = true;
      return new Error(`The container ${container.name} did not stop within ${limitMs / 1000} s.`);
    });
    return true;
  } catch (error) {
    if (p.signal?.aborted) throw error;
    // Removed since the list (as `docker stop` of a missing container): nothing to stop.
    if (isMissing(error)) {
      p.log(`The container ${container.name} does not exist any more.`);
      return true;
    }
    const reason = timedOut ? errorMessage(error) : `The container ${container.name} could not be stopped: ${errorMessage(error)}`;
    p.log(reason);
    // At most as many as the answer takes (StopValue: MAX_STOPPED_SERVICES + 1); the log has them all.
    if (failures.length <= MAX_STOPPED_SERVICES) failures.push(reason.length > MAX_STOP_FAILURE_LENGTH ? `${reason.slice(0, MAX_STOP_FAILURE_LENGTH - 1)}…` : reason);
    return false;
  }
}
