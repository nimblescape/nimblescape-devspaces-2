// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The host access analysis in the worker. The operations of the worker give their pipeline an analyzer that starts
// each job in a thread of the worker's own file (ownScript; here a file of the test whose script throws, so a job is
// refused and logged), and the operations share MAX_WORKER_ANALYSIS_THREADS threads.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/** The worker's own script in this test (ownScript reads the file of the bundle). */
const own = vi.hoisted(() => ({ script: undefined as { file: string; text: string; hash: string } | undefined }));
vi.mock('./ownScript', () => ({ ownScript: () => own.script }));

import { analysisInternalItem } from '../core/helper/configurationAnalysis';
import { MAX_WORKER_ANALYSIS_THREADS, workerAnalyzer } from './flowOperations';
import { WorkerConfigurationAnalyzer } from '../core/helper/configurationAnalysisRunner';
import { scriptFile } from '../core/helper/configurationAnalysisRunner.testkit';
import type { AnalysisJob, AnalysisResult } from '../core/helper/configurationAnalysis';
import { contextSecrets } from './operationContext.testkit';
import type { OperationContext } from './server';

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-test-'));
  const { file, hash } = scriptFile(dir, 'throw new Error("the analysis thread of the unit tests");');
  own.script = { file, hash, text: fs.readFileSync(file, 'utf8') };
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the analysis thread in the worker', () => {
  it("the analyzer of an operation starts each job from the worker's own file, and its failure is refused and logged to the operation", async () => {
    const lines: string[] = [];
    const context = {
      signal: new AbortController().signal,
      ...contextSecrets(),
      progress: () => {},
      log: (text: string, level?: string) => lines.push(`${level ?? 'info'}: ${text}`),
      output: () => {},
    } satisfies OperationContext;
    // The script of the test throws.
    const result = await workerAnalyzer(context).analyze({ kind: 'hostAccess', checksOn: true, input: { ownVolume: 'own' } });
    expect(result.failure?.kind).toBe('internal');
    expect(result.failure?.reason).toContain('the analysis thread of the unit tests');
    expect(result.report).toEqual({ hostAccess: [], unsupported: [analysisInternalItem(result.failure!.reason)] });
    expect(lines).toEqual([expect.stringMatching(/^warn: The host access analysis of the configuration failed \(.*the analysis thread of the unit tests.*\); the configuration is refused\.$/)]);
  });

  /** An OperationContext for the analyzer, with its own cancel. */
  function contextOf(controller = new AbortController()) {
    return {
      signal: controller.signal,
      ...contextSecrets(),
      progress: () => {},
      log: () => {},
      output: () => {},
    } satisfies OperationContext;
  }

  it('the operations share MAX_WORKER_ANALYSIS_THREADS threads; a job of a cancelled one starts none', async () => {
    const pending: Array<(value: AnalysisResult<AnalysisJob>) => void> = [];
    const spy = vi.spyOn(WorkerConfigurationAnalyzer.prototype, 'analyze').mockImplementation(
      () => new Promise((resolve) => pending.push(resolve as (value: AnalysisResult<AnalysisJob>) => void)) as never,
    );
    try {
      const job: AnalysisJob = { kind: 'hostAccess', checksOn: true, input: { ownVolume: 'own' } };
      const cancelled = new AbortController();
      // Three operations, each with its own analyzer: only MAX_WORKER_ANALYSIS_THREADS threads start.
      const first = workerAnalyzer(contextOf()).analyze(job);
      const second = workerAnalyzer(contextOf()).analyze(job);
      const third = workerAnalyzer(contextOf(cancelled)).analyze(job);
      const fourth = workerAnalyzer(contextOf()).analyze(job);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(MAX_WORKER_ANALYSIS_THREADS).toBe(2);
      expect(spy).toHaveBeenCalledTimes(2);
      // The third operation is cancelled while it waits: its slot starts no thread, and goes on to the fourth.
      cancelled.abort();
      pending[0]({ report: { hostAccess: [], unsupported: [] } } as never);
      await first;
      expect(await third).toMatchObject({ failure: { kind: 'internal', reason: 'the operation was cancelled' } });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(spy).toHaveBeenCalledTimes(3);
      pending[1]({ report: { hostAccess: [], unsupported: [] } } as never);
      pending[2]({ report: { hostAccess: [], unsupported: [] } } as never);
      await Promise.all([second, fourth]);
    } finally {
      spy.mockRestore();
    }
  });
});
