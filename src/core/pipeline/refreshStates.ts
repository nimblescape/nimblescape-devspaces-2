// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The states of the devspaces and the branches of their running dev containers, read in one go. It runs in the
// worker only (the operation `refresh`, src/helperChannel/operations.ts), never directly in the extension. It only
// reads. Pure: no `vscode`, and nothing of the service, so that the script of the worker stays small.
import { Semaphore } from '../concurrency';
import type { ListedContainer } from '../docker/dockerObjects';
import { errorMessage } from '../errors';
import { parseGitSummaryOutput } from '../git/gitSummary';
import { LABEL_DEVSPACE_ID } from '../names';
import type { ContainerState, GitSummary } from '../types';
import { runScript, type ScriptExec } from '../worker/containerScripts';
import { devContainerOf } from '../worker/devspaceContainers';
// A type only (no code of the service in the worker's script).
import type { DevspaceDocker } from './devspacePorts';

/** State of the container and the volume of a devspace. */
export interface DevspaceRuntimeState {
  /**
   * The state of the dev container only (isDevContainer), not of the other services: of the dev container by the rule
   * (devContainerOf), as the open connects to it.
   */
  container: ContainerState;
  volume: boolean;
  /**
   * `true` when any other container of the devspace than the dev container of the rule runs: a container of another
   * service of Docker Compose (label nimblescape.devspaces.compose-service) or another dev container; not set otherwise.
   * Stop stays offered while it runs, also when the dev container is stopped (Stop stops them all). The name of the
   * field is part of the protocol.
   */
  servicesRunning?: boolean;
}

/** What readDevspaceStates needs of a devspace (of the current Docker host). */
export interface StateDevspace {
  id: string;
  containerName: string;
  volumeName: string;
  /** The user of `docker exec` for the branch (remoteUser); none: the user of the container. */
  user?: string;
  /** The folder of the repository in the container (repositoryFolder). */
  folder: string;
  /** Read the branch when its dev container runs (the sidebar reads it for the devspaces of the account only). */
  branch: boolean;
}

export interface DevspaceStates {
  runtime: Map<string, DevspaceRuntimeState>;
  /** The branch of each running dev container that has one (none for a detached HEAD or a failed read). */
  branches: Map<string, string>;
}

/** The part of the pipeline's Docker (DevspaceDocker) that readDevspaceStates uses. */
export type StateDocker = Pick<DevspaceDocker, 'listDevspaceContainers' | 'listDevspaceVolumes' | 'volumeExists' | 'exec'>;

/** At most this many branches are read at the same time. */
export const BRANCH_READ_CONCURRENCY = 4;
export const BRANCH_EXEC_TIMEOUT_MS = 15_000;

/**
 * The branch of the repository at `folder` in a running container (through `docker exec`, without `-i` and without
 * variables): `null` for a detached HEAD, `undefined` when Git is missing, fails, or `signal` aborts. One function per
 * fact: the script `branch` of the registry (GIT_BRANCH_SCRIPT of gitSummary.ts), which reads the branch as the Git
 * state does (GIT_BRANCH_FUNCTION: no hooks, the C locale, `safe.directory`, and `git symbolic-ref -q HEAD`, a branch
 * only below refs/heads/), so it also works with Git before 2.22, which has no `branch --show-current`.
 */
export async function readBranch(
  docker: Pick<DevspaceDocker, 'exec'>,
  container: string,
  user: string | undefined,
  folder: string,
  signal?: AbortSignal,
): Promise<string | null | undefined> {
  try {
    const result = await runScript(docker, container, 'branch', [folder], {
      user,
      timeoutMs: BRANCH_EXEC_TIMEOUT_MS,
      signal,
    });
    if (result.exitCode !== 0) return undefined;
    const branch = result.stdout.trim();
    return branch === '' ? null : branch;
  } catch {
    return undefined;
  }
}

/**
 * The time limit of the script `gitSummary` (readGitSummary), one constant for Stop and the service.
 */
export const GIT_SUMMARY_TIMEOUT_MS = 30_000;

/**
 * The Git state of the repository at `folder` in a running container (one function per fact), for Stop (stopFlow) and
 * the service (the open after a clone, Delete's check, recordGitState). The script `gitSummary` of the registry runs as
 * `user` within GIT_SUMMARY_TIMEOUT_MS; its output is parsed with the time `now()` after it.
 * Undefined when it cannot be read; the reason goes to `log` as "The Git state in <container.name> could not be read:
 * <reason>" (the end of a script that failed: "the script did not end in time.", its output, or its exit code). A
 * cancel of `signal`: with `cancel: 'throw'` (Stop) its error is thrown; with `cancel: 'fail'` (the service) it is a
 * failed read like any other.
 */
export async function readGitSummary(
  docker: ScriptExec,
  container: { id: string; name: string },
  user: string | undefined,
  folder: string,
  options: { now: () => string; log: (line: string) => void; cancel: 'throw' | 'fail'; signal?: AbortSignal },
): Promise<GitSummary | undefined> {
  const failed = (reason: string): undefined => {
    options.log(`The Git state in ${container.name} could not be read: ${reason}`);
    return undefined;
  };
  try {
    const result = await runScript(docker, container.id, 'gitSummary', [folder], { user, timeoutMs: GIT_SUMMARY_TIMEOUT_MS, signal: options.signal });
    if (result.exitCode !== 0) {
      return failed(result.timedOut ? 'the script did not end in time.' : (result.stderr || result.stdout).trim() || `exit code ${result.exitCode ?? 'none'}.`);
    }
    return parseGitSummaryOutput(result.stdout, options.now());
  } catch (error) {
    if (options.cancel === 'throw' && options.signal?.aborted) throw error;
    return failed(errorMessage(error));
  }
}

/**
 * The container and volume state of each devspace, and the branches of the running dev containers (at most
 * BRANCH_READ_CONCURRENCY at a time). Throws when the containers or the volumes cannot be listed.
 */
export async function readDevspaceStates(docker: StateDocker, devspaces: readonly StateDevspace[]): Promise<DevspaceStates> {
  const [containers, volumes] = await Promise.all([docker.listDevspaceContainers(), docker.listDevspaceVolumes()]);
  // The state of the devspace is the one of its dev container by the rule (devContainerOf), the one that the open
  // connects to; any other running container of the devspace, a service of Docker Compose or another dev container,
  // only sets servicesRunning, so that the sidebar offers Stop, which stops them all.
  const byDevspace = new Map<string, ListedContainer[]>();
  for (const container of containers) {
    const id = container.labels[LABEL_DEVSPACE_ID];
    if (!id) continue;
    const own = byDevspace.get(id);
    if (own === undefined) byDevspace.set(id, [container]);
    else own.push(container);
  }
  const volumeNames = new Set(volumes.map((volume) => volume.name));
  const runtime = new Map<string, DevspaceRuntimeState>();
  const devContainers = new Map<string, ListedContainer>();
  for (const env of devspaces) {
    const own = byDevspace.get(env.id) ?? [];
    const dev = devContainerOf(own, env.containerName);
    if (dev !== undefined) devContainers.set(env.id, dev);
    // A volume without the labels (created outside of this extension) is found by its name.
    const volume = volumeNames.has(env.volumeName) || (await docker.volumeExists(env.volumeName));
    const state: DevspaceRuntimeState = { container: dev?.state ?? 'missing', volume };
    if (own.some((other) => other.state === 'running' && other.id !== dev?.id)) state.servicesRunning = true;
    runtime.set(env.id, state);
  }
  const branches = new Map<string, string>();
  const limit = new Semaphore(BRANCH_READ_CONCURRENCY);
  const running = devspaces.flatMap((env) => {
    const dev = devContainers.get(env.id);
    return env.branch && dev?.state === 'running' ? [{ env, dev }] : [];
  });
  await Promise.all(
    running.map(({ env, dev }) =>
      limit.run(async () => {
        // From the dev container of the rule, by its ID.
        const branch = await readBranch(docker, dev.id, env.user, env.folder);
        if (branch) branches.set(env.id, branch);
      }),
    ),
  );
  return { runtime, branches };
}
