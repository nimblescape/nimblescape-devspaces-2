// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The background build of a helper image that the refresh of the sidebar found missing (for example after the user
// purged the images of a Docker engine). The refresh itself never builds and never waits for a build; it only asks
// for this build, which runs apart from it, at most once at a time per window and engine, and after a build (failed,
// or one that the next refresh still does not see) not again on that engine within MISSING_HELPER_RETRY_MS (a Start,
// Stop or Delete still builds it at once; a build of the helper image ends that wait). The build is the one of
// Start, Stop and Delete (`build`: HelperChannelsOptions.prepare without the maintenance of an open, so the same
// Dockerfile, tag and privileges, and the window's shared build of HelperImages, which a Start at the same time joins);
// it runs only when the engine answers (`engineAnswers`, as for the background prebuild: Docker is never started, and a
// remote host gets the SSH check without questions first). After a build, `onBuilt` (the refresh of the sidebar).
// "Remove Devspaces from This Docker Engine…" stops the build on its engine (`stop`). No `vscode`.
import { engineKey } from '../session/windowHeartbeats';
import type { DockerTarget } from '../docker/dockerHost';
import { errorMessage } from '../errors';
import { abortError, isAbortError, systemClock, type Clock, type Logger } from '../ports';
import { HELPER_PREBUILD_TIMEOUT_MS } from './helperPrebuild';

/**
 * After a background build on an engine, the next one there waits this long (a Start builds at once): after a failed
 * one, and after one that succeeded, so that a refresh that still finds no image (for example when the image cannot be
 * checked while the window's build of it is cached) never starts a loop of builds and refreshes.
 */
export const MISSING_HELPER_RETRY_MS = 10 * 60_000;

/**
 * What a background build did. `built`: the helper image is on the engine now (built, or found built by another window
 * or operation); `unreachable`: the engine did not answer, so nothing was built; `failed`: the build failed (the wait
 * MISSING_HELPER_RETRY_MS starts); `cancelled`: the window closed, or a removal of Devspaces from the engine stopped it.
 */
export type MissingHelperBuildOutcome = 'built' | 'unreachable' | 'failed' | 'cancelled';

/** What the sidebar shows for an engine: its helper image is being built, or its last background build failed. */
export type MissingHelperStatus = 'building' | 'failed';

export interface MissingHelperBuildDeps {
  /**
   * Whether the Docker engine of `target` answers (dockerEngineAnswers: Docker is never started; a remote host first
   * gets the SSH check without questions). Never throws, except an AbortError.
   */
  engineAnswers: (target: DockerTarget, signal: AbortSignal) => Promise<boolean>;
  /** The build of Start, Stop and Delete on `target` (HelperChannelsOptions.prepare without maintenance). */
  build: (target: DockerTarget, signal: AbortSignal) => Promise<void>;
  /** Shows `work` (the build) in the status bar. Default: not shown. */
  progress?: <T>(target: DockerTarget, work: () => Promise<T>) => Promise<T>;
  /** After a build that succeeded: the refresh of the sidebar. */
  onBuilt: (target: DockerTarget) => void;
  /** The status of an engine changed (MissingHelperStatus): the sidebar shows it again. */
  onChange?: () => void;
  logger: Logger;
  clock?: Clock;
  retryAfterFailureMs?: number;
  /** The time limit of one build (HELPER_PREBUILD_TIMEOUT_MS by default, as the background prebuild). */
  timeoutMs?: number;
}

/** The name of the engine of `target` in the log. */
function engineName(target: DockerTarget): string {
  return target.kind === 'local' ? 'the local Docker' : target.host;
}

export class MissingHelperBuild {
  /** Engine key → the background build that runs there, its target, and what stops it (stop). */
  private readonly running = new Map<string, { target: DockerTarget; job: Promise<MissingHelperBuildOutcome>; stop: AbortController }>();
  /** Engine key → when the last background build there ended (MISSING_HELPER_RETRY_MS), its target, and whether it failed. */
  private readonly ended = new Map<string, { target: DockerTarget; at: number; failed: boolean }>();
  private readonly disposal = new AbortController();
  private readonly clock: Clock;

  constructor(private readonly deps: MissingHelperBuildDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  /**
   * The refresh found the helper image of `target` missing (or could not check it). Starts the background build there,
   * unless one runs there already, the last one there ended less than MISSING_HELPER_RETRY_MS ago, the endpoint is
   * neither local nor SSH, or the window closes: then `undefined`. Never throws; the returned build never rejects.
   */
  request(target: DockerTarget): Promise<MissingHelperBuildOutcome> | undefined {
    if (this.disposal.signal.aborted || (target.kind !== 'local' && target.kind !== 'remote')) return undefined;
    const key = engineKey(target);
    if (this.running.has(key)) return undefined;
    const last = this.ended.get(key);
    if (last !== undefined && this.within(last.at)) return undefined;
    const stop = new AbortController();
    const job = this.run(target, key, stop.signal);
    this.running.set(key, { target, job, stop });
    this.changed();
    return job;
  }

  /**
   * "Remove Devspaces from This Docker Engine…" on the Docker host of `target`: a background build that runs there is
   * cancelled, and the call waits for its end, so that it does not build the helper image again after its removal. It
   * counts as cancelled: no wait starts, and the sidebar shows the engine without it.
   */
  async stop(target: Pick<DockerTarget, 'host'>): Promise<void> {
    const stopping = [...this.running.values()].filter((entry) => entry.target.host === target.host);
    for (const entry of stopping) entry.stop.abort(abortError());
    await Promise.all(stopping.map((entry) => entry.job));
  }

  /** The status of the Docker host `dockerHost` ('' for the local Docker); `undefined` when neither applies. */
  status(dockerHost: string): MissingHelperStatus | undefined {
    for (const { target } of this.running.values()) if (target.host === dockerHost) return 'building';
    for (const { target, at, failed } of this.ended.values()) {
      if (failed && target.host === dockerHost && this.within(at)) return 'failed';
    }
    return undefined;
  }

  /** A build of the helper image succeeded (HelperImagesDeps.onImageBuilt, a Start for example): every wait ends. */
  clearFailures(): void {
    if (this.ended.size === 0) return;
    this.ended.clear();
    this.changed();
  }

  /** The window closes: a build that runs is cancelled. */
  dispose(): void {
    this.disposal.abort(abortError());
  }

  private async run(target: DockerTarget, key: string, stopped: AbortSignal): Promise<MissingHelperBuildOutcome> {
    const name = engineName(target);
    const limit = new AbortController();
    const timer = setTimeout(() => limit.abort(abortError()), this.deps.timeoutMs ?? HELPER_PREBUILD_TIMEOUT_MS);
    (timer as { unref?: () => void }).unref?.();
    const signal = AbortSignal.any([this.disposal.signal, limit.signal, stopped]);
    let outcome: MissingHelperBuildOutcome;
    try {
      // The job starts after request() recorded it, so a request at the same time finds it.
      await Promise.resolve();
      if (!(await this.deps.engineAnswers(target, signal))) {
        this.deps.logger.info(`The workspace helper image is not built in the background on ${name}: its Docker engine does not answer.`);
        outcome = 'unreachable';
      } else {
        this.deps.logger.info(`The workspace helper image is not on ${name}. It is built in the background.`);
        const build = (): Promise<void> => this.deps.build(target, signal);
        await (this.deps.progress !== undefined ? this.deps.progress(target, build) : build());
        this.deps.logger.info(`The workspace helper image is ready on ${name}.`);
        outcome = 'built';
      }
    } catch (error) {
      if (this.disposal.signal.aborted) outcome = 'cancelled';
      else if (stopped.aborted) {
        this.deps.logger.info(`The background build of the workspace helper image on ${name} was stopped: Devspaces is being removed from there.`);
        outcome = 'cancelled';
      } else {
        const why = limit.signal.aborted ? 'its time limit ended' : isAbortError(error) ? 'it was cancelled' : errorMessage(error);
        this.deps.logger.warn(
          `The workspace helper image could not be built in the background on ${name}: ${why}. It is tried again in ${Math.round((this.deps.retryAfterFailureMs ?? MISSING_HELPER_RETRY_MS) / 60_000)} minutes at the earliest, or by the next Start, Stop or Delete.`,
        );
        outcome = 'failed';
      }
    } finally {
      clearTimeout(timer);
    }
    this.running.delete(key);
    // An engine that did not answer starts no wait (nothing was built; the next refresh that finds no image asks again).
    if (outcome === 'failed' || outcome === 'built') this.ended.set(key, { target, at: this.clock.now(), failed: outcome === 'failed' });
    if (outcome === 'cancelled') {
      // A stop leaves the window open: the sidebar no longer shows the build.
      if (!this.disposal.signal.aborted) this.changed();
      return outcome;
    }
    // After a build, the refresh shows the states (and its render the status); otherwise only the status changed.
    try {
      if (outcome === 'built') this.deps.onBuilt(target);
      else this.changed();
    } catch (error) {
      this.deps.logger.warn(`The end of the background build of the workspace helper image could not be shown: ${errorMessage(error)}`);
    }
    return outcome;
  }

  /** Whether `at` is less than MISSING_HELPER_RETRY_MS ago. */
  private within(at: number): boolean {
    return Math.abs(this.clock.now() - at) < (this.deps.retryAfterFailureMs ?? MISSING_HELPER_RETRY_MS);
  }

  private changed(): void {
    try {
      this.deps.onChange?.();
    } catch (error) {
      this.deps.logger.warn(`The state of the background build of the workspace helper image could not be shown: ${errorMessage(error)}`);
    }
  }
}
