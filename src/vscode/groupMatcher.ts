// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The regular expressions of the setting `repositoryGroups` for the sidebar: they run in a worker thread
// (groupsPreviewWorker.ts) with a time limit, never on the extension host. A regular expression with a nested
// repetition such as `(\w+)+$` can take seconds for one repository name, and on the extension host it would stop
// every extension of the window, at each start. After the limit, the worker is stopped (Worker.terminate stops even a
// running regular expression) and the next job starts a new one. The worker also ends when no job comes for
// GROUP_MATCH_IDLE_MS: the sidebar keeps the places of the names, so it needs the worker only for new names and a changed
// setting. No `vscode` import.
import { Worker } from 'worker_threads';
import { matchRepositoryGroup, parseRepositoryGroups } from './repositoryGroups';

/** Time limit of each entry of a job: from the moment the worker starts to run its regular expression on the names. */
export const GROUP_MATCH_TIME_LIMIT_MS = 1000;
/** Time limit of the start of a new worker and of the compilation of the entries, before the first regular expression runs. */
export const GROUP_MATCH_START_LIMIT_MS = 10_000;
/** Time without a job after which the worker ends; the next job starts a new one. */
export const GROUP_MATCH_IDLE_MS = 60_000;

/** Where a repository name goes under the entries: the entry that matched (`index`), the group levels, and the label. */
export interface GroupPlace {
  index: number;
  levels: string[];
  label: string;
}

/** A job of the sidebar: the value of the setting `repositoryGroups` and the repository names to place. */
export interface GroupMatchJob {
  kind: 'match';
  id: number;
  entries: readonly unknown[];
  names: readonly string[];
}

/** Messages of the worker for a match job: `probe` before each entry runs on the names, then the places. */
export type GroupMatchMessage =
  | { type: 'probe'; id: number; entryIndex: number }
  | { type: 'places'; id: number; places: Array<[string, GroupPlace | null]>; failures: Array<[number, string]> };

/**
 * The result of a job: the place of each name (`null`: no entry matches it) and the entries that threw while they were
 * matched (their `failure`, as matchRepositoryGroup keeps it); or `tooSlow`, with the entry that ran when the time
 * limit was reached; or `failed` when the worker could not run the job.
 */
export type GroupMatchRun =
  | { places: Map<string, GroupPlace | null>; failures: Map<number, string> }
  | { tooSlow: true; slowEntry?: number }
  | { failed: true };

export interface GroupMatcher {
  /** Places `names` under the entries of the setting `repositoryGroups`, after the jobs before it; never rejects. */
  run(entries: readonly unknown[], names: readonly string[]): Promise<GroupMatchRun>;
  dispose(): void;
}

/**
 * Runs a match job and reports each step through `post`: a `probe` before an entry runs on the names (so a stopped
 * worker names the slow entry), then the places. Each name goes to the first entry that matches it, as
 * matchRepositoryGroup decides.
 */
export function runMatchJob(job: GroupMatchJob, post: (message: GroupMatchMessage) => void): void {
  const { patterns } = parseRepositoryGroups(job.entries);
  const places = new Map<string, GroupPlace | null>(job.names.map((name) => [name, null]));
  const open = new Set(places.keys());
  for (const pattern of patterns) {
    post({ type: 'probe', id: job.id, entryIndex: pattern.index });
    for (const name of open) {
      const match = matchRepositoryGroup([pattern], name);
      if (!match) continue;
      places.set(name, { index: pattern.index, levels: match.levels, label: match.label });
      open.delete(name);
    }
  }
  const failures = patterns.flatMap((pattern): Array<[number, string]> => (pattern.failure !== undefined ? [[pattern.index, pattern.failure]] : []));
  post({ type: 'places', id: job.id, places: [...places], failures });
}

/** The GroupMatcher of the sidebar: one worker thread, one job at a time, each with the time limits above. */
export class GroupMatchWorkerRunner implements GroupMatcher {
  private worker: Worker | undefined;
  private nextId = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private disposed = false;
  /** The jobs given to run() that did not end yet. */
  private jobs = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly scriptPath: string,
    private readonly timeLimitMs = GROUP_MATCH_TIME_LIMIT_MS,
    private readonly startLimitMs = GROUP_MATCH_START_LIMIT_MS,
    private readonly idleMs = GROUP_MATCH_IDLE_MS,
  ) {}

  run(entries: readonly unknown[], names: readonly string[]): Promise<GroupMatchRun> {
    this.jobs += 1;
    clearTimeout(this.idleTimer);
    const result = this.chain.then(() => (this.disposed ? ({ failed: true } satisfies GroupMatchRun) : this.runNow(entries, names)));
    this.chain = result.catch(() => undefined).then(() => this.jobEnded());
    return result;
  }

  /**
   * Stops the worker. The jobs queued before this call and every later job resolve `{ failed: true }` without starting a
   * new worker. The running job resolves with its places when the worker had already posted them, with `tooSlow` when
   * its time limit had already ended it, and otherwise with `failed: true`.
   */
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.idleTimer);
    this.endWorker();
  }

  /** After the last job, the worker ends when no job comes for idleMs. */
  private jobEnded(): void {
    this.jobs -= 1;
    if (this.jobs > 0 || this.disposed) return;
    this.idleTimer = setTimeout(() => this.endWorker(), this.idleMs);
    this.idleTimer.unref();
  }

  private endWorker(): void {
    const worker = this.worker;
    this.worker = undefined;
    void worker?.terminate();
  }

  private runNow(entries: readonly unknown[], names: readonly string[]): Promise<GroupMatchRun> {
    return new Promise((resolve) => {
      let worker: Worker;
      try {
        worker = this.worker ?? new Worker(this.scriptPath);
      } catch {
        resolve({ failed: true });
        return;
      }
      this.worker = worker;
      const id = ++this.nextId;
      /** The entry that runs on the names now (from its probe); undefined before the first probe. */
      let runningEntry: number | undefined;
      let done = false;
      const finish = (result: GroupMatchRun) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
        resolve(result);
      };
      const stop = (result: GroupMatchRun) => {
        if (this.worker === worker) this.worker = undefined;
        void worker.terminate();
        finish(result);
      };
      // A message that the worker posted before a limit may still wait in the queue of the extension host (a busy
      // start of VS Code). A limit ends the job only after the messages that are already there (setImmediate runs after
      // them), and only when its phase did not end: the start limit while no entry runs, the time limit of an entry
      // while this entry still runs.
      const onLimit = (stillSlow: () => boolean, result: GroupMatchRun) => () =>
        setImmediate(() => !done && stillSlow() && stop(result));
      let timer = setTimeout(onLimit(() => runningEntry === undefined, { failed: true }), this.startLimitMs);
      const onMessage = (message: GroupMatchMessage) => {
        if (done || message.id !== id) return;
        if (message.type === 'probe') {
          // An entry starts to run on the names: its own time limit starts.
          const entry = message.entryIndex;
          runningEntry = entry;
          clearTimeout(timer);
          timer = setTimeout(onLimit(() => runningEntry === entry, { tooSlow: true, slowEntry: entry }), this.timeLimitMs);
          return;
        }
        finish({ places: new Map(message.places), failures: new Map(message.failures) });
      };
      const onError = () => stop({ failed: true });
      const onExit = () => {
        if (this.worker === worker) this.worker = undefined;
        finish({ failed: true });
      };
      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.on('exit', onExit);
      worker.postMessage({ kind: 'match', id, entries, names } satisfies GroupMatchJob);
    });
  }
}
