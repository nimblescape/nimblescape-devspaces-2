// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The preparation (the helper image for the worker, and for the start of a missing Monitor container) that a
// heartbeat of the window starts. The deadline of a heartbeat's attempt (HEARTBEAT_ATTEMPT_DEADLINE_MS) ends only the
// heartbeat's wait, never this shared work: it runs with its own long signal (HELPER_PREBUILD_TIMEOUT_MS, aborted when
// the window closes), so the next attempt joins the build that runs instead of starting it again. Everything else (an
// operation of the user) keeps its own signal for its preparation.
//
// After a failed preparation of a heartbeat on an engine, the next one there waits REPAIR_BACKOFF_MS (1, 2, then 5
// minutes), as the repair does: within the wait, a heartbeat's preparation on that engine is refused at once (no new
// build), so its send or check fails and counts as a failed heartbeat (the warning after failed heartbeats still
// comes); a successful preparation ends the wait.
//
// The wait exists only to avoid repeated builds, never to hold back a heartbeat that needs none. Only a preparation
// whose build of the helper image started (`onBuild`) and then failed starts or lengthens the wait; an unreachable
// engine or a failed presence check does not. Within the wait, a heartbeat's preparation first checks (bounded, never
// builds: `present`) whether the tag exists: if so it succeeds with it (and ends the wait), else it is refused without
// a build. Any successful preparation on the engine ends its wait, also one of an operation of the user (outside the
// scope) and a build that succeeded (`clear`).
//
// A heartbeat's preparation on an engine joins the one that still runs there (its wait, and the accounting of its
// build: `onBuild`, the failures at its start) instead of starting the work again. The workspace helper keeps one cache
// of the image per window, which a preparation on another engine resets, so the work itself would not join the running
// build: without the join, each attempt on the engine would start another one while the previous one still runs under
// the long signal.
//
// The join lasts only as long as the long signal of the work: when it aborts (the timeout, dispose) and the work
// ignores it, the next preparation on the engine starts new work instead of joining. No `vscode`.
import { AsyncLocalStorage } from 'async_hooks';
import type { DockerTarget } from '../docker/dockerHost';
import { HELPER_PREBUILD_TIMEOUT_MS } from '../helper/helperPrebuild';
import { abortError, systemClock, type Clock } from '../ports';
import { engineKey, repairBackoffMs } from './windowHeartbeats';

/**
 * A preparation: `signal` ends it; `onBuild` is called when it starts (or joins) a build of the helper image (only a
 * failure after that counts towards the wait).
 */
export type PreparationWork<T, S = AbortSignal> = (signal: S, onBuild: () => void) => Promise<T>;

/** The helper image when its tag exists on the engine, else `undefined`; never builds. */
export type PresenceCheck<T> = (signal: AbortSignal | undefined) => Promise<T | undefined>;

/** The failed builds for heartbeats on one engine in a row. */
interface Backoff {
  failures: number;
  notBefore: number;
}

export class HeartbeatPreparation {
  private readonly heartbeat = new AsyncLocalStorage<true>();
  private readonly disposal = new AbortController();
  /** Engine key → the wait after failed preparations there. */
  private readonly backoffs = new Map<string, Backoff>();
  /** Engine key → the preparation of a heartbeat that runs there (until it settles). */
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(
    private readonly timeoutMs: number = HELPER_PREBUILD_TIMEOUT_MS,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Runs `fn` as the work of a heartbeat (its send, its repair): `prepare` within it gets the long signal. */
  scope<T>(fn: () => Promise<T>): Promise<T> {
    return this.heartbeat.run(true, fn);
  }

  /** True within `scope`: the caller runs as the work of a heartbeat. */
  inScope(): boolean {
    return this.heartbeat.getStore() === true;
  }

  /**
   * A preparation. In the scope of a heartbeat, `work` gets the long signal (ended after `timeoutMs`, aborted by
   * dispose) and is waited for until `wait` aborts (then an AbortError, while `work` goes on); with `engine`, it waits
   * after a failed build there (see run). Elsewhere `work` gets `wait` itself, and its success ends the wait of
   * `engine`.
   */
  prepare<T>(
    work: PreparationWork<T, AbortSignal | undefined>,
    wait: AbortSignal | undefined,
    engine?: DockerTarget,
    present?: PresenceCheck<T>,
  ): Promise<T> {
    if (!this.inScope()) {
      return work(wait, () => undefined).then((value) => {
        if (engine !== undefined) this.clear(engine);
        return value;
      });
    }
    return this.run(work, wait, engine, present);
  }

  /**
   * `work` with the long signal, waited for until `wait` aborts. With `engine`: within the wait after a failed build
   * there, `work` does not run: `present` (bounded by `wait`) gives the image when its tag exists (the wait ends), else
   * the preparation is refused at once. A failure of `work` after its build started (`onBuild`) starts or lengthens the
   * wait, any other failure leaves it as it is; a success ends it. While a preparation runs on `engine`, another one
   * there joins it (waits for its result until its own `wait` aborts) and runs no `work`; only until its long signal
   * aborts.
   */
  run<T>(work: PreparationWork<T>, wait: AbortSignal | undefined, engine?: DockerTarget, present?: PresenceCheck<T>): Promise<T> {
    if (wait?.aborted) return Promise.reject(abortError());
    const key = engine === undefined ? undefined : engineKey(engine);
    // The work that runs on this engine is joined, never started a second time.
    const running = key === undefined ? undefined : this.pending.get(key);
    if (running !== undefined) return waitFor(running as Promise<T>, wait);
    const backoff = key === undefined ? undefined : this.backoffs.get(key);
    const now = this.clock.now();
    if (key !== undefined && backoff !== undefined && now < backoff.notBefore) {
      const seconds = Math.ceil((backoff.notBefore - now) / 1000);
      const refusal = `The helper image is prepared again in ${seconds} seconds at the earliest (its last build failed)`;
      if (present === undefined) return Promise.reject(new Error(`${refusal}.`));
      const check = present(wait).then((image) => {
        if (image === undefined) throw new Error(`${refusal}, and it is not on the Docker engine.`);
        // The tag exists (another build made it, or it came back): no build is needed, the wait ends.
        if (this.backoffs.get(key) === backoff) this.backoffs.delete(key);
        return image;
      });
      check.catch(() => undefined);
      return waitFor(check, wait);
    }
    const failuresAtStart = backoff?.failures ?? 0;
    let built = false;
    const onBuild = (): void => {
      built = true;
    };
    const controller = new AbortController();
    const onDispose = (): void => controller.abort(abortError());
    if (this.disposal.signal.aborted) onDispose();
    else this.disposal.signal.addEventListener('abort', onDispose, { once: true });
    const timer = setTimeout(() => controller.abort(abortError()), this.timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    const job = Promise.resolve()
      .then(() => work(controller.signal, onBuild))
      .finally(() => {
        clearTimeout(timer);
        this.disposal.signal.removeEventListener('abort', onDispose);
      });
    if (key !== undefined) {
      this.pending.set(key, job);
      // Only this job's own entry is dropped. It matters when the long signal dropped it already (below) and a later
      // preparation on the engine started new work there: this job settling late must not drop that one.
      const settled = (): void => {
        if (this.pending.get(key) === job) this.pending.delete(key);
      };
      // A work that ignores its long signal must not block the engine forever. When the long signal aborts (its
      // timeout, the window closes), the job is not joined any longer: the next preparation on the engine starts fresh.
      if (controller.signal.aborted) settled();
      else controller.signal.addEventListener('abort', settled, { once: true });
      job.then(
        () => {
          settled();
          this.backoffs.delete(key);
        },
        () => {
          settled();
          if (built) this.recordFailure(key, failuresAtStart);
        },
      );
    }
    // The waiter may have left (its deadline); the work's own failure is then nobody's to handle.
    job.catch(() => undefined);
    return waitFor(job, wait);
  }

  /** A preparation on `engine` succeeded elsewhere (an operation of the user, a build): its wait ends. */
  clear(engine: DockerTarget): void {
    this.backoffs.delete(engineKey(engine));
  }

  /** A build of the helper image succeeded on an engine that is not known here: every wait ends. */
  clearAll(): void {
    this.backoffs.clear();
  }

  /** The window closes: the preparations it started are aborted. */
  dispose(): void {
    this.disposal.abort(abortError());
  }

  /**
   * A build for a preparation on the engine `key` failed (only one whose build started). Preparations that ran at the
   * same time (a joined build) count once: only the first of them to fail after `failuresAtStart` failures lengthens
   * the wait.
   */
  private recordFailure(key: string, failuresAtStart: number): void {
    if (this.disposal.signal.aborted) return;
    const current = this.backoffs.get(key);
    if ((current?.failures ?? 0) !== failuresAtStart) return;
    const failures = failuresAtStart + 1;
    this.backoffs.set(key, { failures, notBefore: this.clock.now() + repairBackoffMs(failures) });
  }
}

/** `job`, waited for until `wait` aborts (then an AbortError, while `job` goes on). */
function waitFor<T>(job: Promise<T>, wait: AbortSignal | undefined): Promise<T> {
  if (wait === undefined) return job;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    wait.addEventListener('abort', onAbort, { once: true });
    job.then(
      (value) => {
        wait.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        wait.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
