// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.
// workerAnalyzer starts each job from the worker's own file (ownScript: in the bundle, the file that the pipe loader
// checked and stored) with its hash and the limits of the extension (ANALYSIS_LIMITS), and each of the 5 operations whose
// pipeline is workerServices gives it that analyzer (none of them falls back to ANALYZER_NOT_IN_WORKER).
import * as fs from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({ deps: [] as Array<Record<string, unknown>> }));
vi.mock('../core/worker/workerServices', () => ({
  workerServices: (deps: Record<string, unknown>) => {
    captured.deps.push(deps);
    return {
      service: {
        listConfigurations: async () => [],
        delete: async () => undefined,
        deleteCheck: async () => ({ decision: 'cancel' }),
        reconcileFromVolumes: async () => 0,
        recordGitState: async () => false,
      },
    };
  },
}));

import { ANALYSIS_LIMITS, WorkerConfigurationAnalyzer } from '../core/helper/configurationAnalysisRunner';
import { bundleHash } from '../core/loader/pipeLoader';
import type { DockerEngine } from '../core/worker/dockerEngine';
import type { OwnHelper } from '../core/worker/ownHelper';
import {
  deleteCheckOperation,
  deleteOperation,
  listConfigurationsOperation,
  reconcileOperation,
  recordGitStateOperation,
  workerThreadAnalyzer,
  type OpenWorkerBatch,
} from './flowOperations';
import { contextSecrets } from './operationContext.testkit';
import { ownScript } from './ownScript';
import type { OperationContext } from './server';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const SOURCE = '0123456789abcdef0123456789abcdef';
const TARGET = { dockerHost: '', owner: { windowId: 'window-1', pid: 4242 } };

function context(): OperationContext {
  return {
    signal: new AbortController().signal,
    ...contextSecrets(),
    progress: () => {},
    log: () => {},
    output: () => {},
  };
}

const engineOf = () => ({}) as DockerEngine;
const ownHelperOf = async () => ({}) as OwnHelper;
const openBatch: OpenWorkerBatch = async () => {
  throw new Error('No batch in this test.');
};

beforeEach(() => {
  captured.deps.length = 0;
});

describe('the analyzer of the operations of the worker: the script and its limits', () => {
  it("workerAnalyzer starts the worker's own file with its hash, with the limits of the extension", () => {
    // The shared slots wrap the analyzer: the thread's analyzer of the operation is workerThreadAnalyzer.
    const analyzer = workerThreadAnalyzer(context()) as unknown as { script: unknown; limits: unknown };
    expect(analyzer).toBeInstanceOf(WorkerConfigurationAnalyzer);
    // The file of the module itself (`__filename`; in the bundle: the bundle), never a text.
    const file = path.join(__dirname, 'ownScript.ts');
    expect(analyzer.script).toEqual({ file, hash: bundleHash(fs.readFileSync(file, 'utf8')) });
    expect(ownScript()).toEqual({ file, text: fs.readFileSync(file, 'utf8'), hash: bundleHash(fs.readFileSync(file, 'utf8')) });
    expect(analyzer.limits).toBe(ANALYSIS_LIMITS);
  });

  it.each([
    ['listConfigurations', () => listConfigurationsOperation(engineOf, ownHelperOf, openBatch), { devspaceId: ID, ...TARGET }],
    ['delete', () => deleteOperation(engineOf, ownHelperOf, openBatch), { devspaceId: ID, ...TARGET, additionalVolumesToRemove: [], monitorSource: SOURCE }],
    ['deleteCheck', () => deleteCheckOperation(engineOf, ownHelperOf, openBatch), { devspaceId: ID, ...TARGET, repository: 'Acme/API', otherWindow: false }],
    ['reconcile', () => reconcileOperation(engineOf, ownHelperOf, openBatch), { ...TARGET }],
    ['recordGitState', () => recordGitStateOperation(engineOf, ownHelperOf, openBatch), { devspaceId: ID, ...TARGET }],
  ])('%s gives its pipeline the analysis thread of the worker', async (_name, operation, params) => {
    await operation()(params, context());
    expect(captured.deps).toHaveLength(1);
    // An analyzer through the shared slots (not the thread's own object).
    expect(captured.deps[0].analyzer).toBeDefined();
    expect(captured.deps[0].analyzer).not.toBeInstanceOf(WorkerConfigurationAnalyzer);
  });
});
