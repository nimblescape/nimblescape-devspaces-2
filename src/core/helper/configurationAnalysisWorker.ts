// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The thread of the host access analysis: it runs one job of configurationAnalysis.ts and posts its result, or the error
// that it threw. It is part of the worker's bundle (dist/helperChannel.js): configurationAnalysisRunner.ts checks the
// SHA-256 hash of that file and starts the file in a thread with ANALYSIS_THREAD_DATA as its `workerData`, and the end
// of src/helperChannel/main.ts then calls startAnalysisThread. The runner sets the limits of memory and stops the thread
// after its time limit. No `vscode` import, and no I/O when the module is loaded.
import { isMainThread, parentPort, workerData } from 'worker_threads';
import { runAnalysisJob, type AnalysisJob } from './configurationAnalysis';

/** The answer of the thread to a job. */
export type AnalysisWorkerMessage = { ok: true; result: unknown } | { ok: false; error: string };

/** The `workerData` of a thread of the analysis: only a thread with it runs the analysis. */
export const ANALYSIS_THREAD_DATA = { devspaceThread: 'analysis' } as const;

/** True in a thread that configurationAnalysisRunner.ts started for a job: not the main thread, with ANALYSIS_THREAD_DATA. */
export function isAnalysisThread(): boolean {
  return !isMainThread && (workerData as { devspaceThread?: unknown } | null | undefined)?.devspaceThread === ANALYSIS_THREAD_DATA.devspaceThread;
}

/** Answers the one job that the runner posts to this thread. */
export function startAnalysisThread(): void {
  parentPort?.once('message', (job: AnalysisJob) => {
    let message: AnalysisWorkerMessage;
    try {
      message = { ok: true, result: runAnalysisJob(job) };
    } catch (error) {
      message = { ok: false, error: String(error instanceof Error ? error.message : error).slice(0, 500) };
    }
    parentPort?.postMessage(message);
  });
}
