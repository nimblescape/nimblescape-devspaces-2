// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The worker's bundle (dist/helperChannel.js, built here with workerBundleOptions of scripts/bundleOptions.mjs) is the
// program of four uses, each with its own entry: the worker (startChannel), the batch helper (startBatchHelper), the
// Monitor (startMonitor, and `node monitor.js <subcommand>`, where the file is the main module) and the thread of the
// host access analysis (a thread of the file with ANALYSIS_THREAD_DATA). Loading the file starts none of them: a
// `require` and a thread without that data do nothing, and no module of the bundle does I/O when it is loaded.
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Worker } from 'worker_threads';
import * as esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sharedBundleOptions, workerBundleOptions } from '../../scripts/bundleOptions.mjs';
import { runAnalysisJob, type AnalysisJob } from '../core/helper/configurationAnalysis';
import { WorkerConfigurationAnalyzer } from '../core/helper/configurationAnalysisRunner';
import { fileHash } from '../core/helper/configurationAnalysisRunner.testkit';
import { ANALYSIS_THREAD_DATA, type AnalysisWorkerMessage } from '../core/helper/configurationAnalysisWorker';
import { BATCH_ENTRY } from '../core/helperChannel/batch';
import { CHANNEL_ENTRY } from '../core/helperChannel/protocol';
import { REMOTE_MONITOR_ENTRY } from '../core/remoteMonitor/protocol';

/**
 * Loads the bundle (the first argument) with `require` and prints its exported functions, every call of a function of
 * I/O while it loaded: of `fs` (but the reads of the bundle itself by the loader of Node.js), `child_process`, `net`,
 * `http`, `https`, `dgram`, the timers, `fetch` and `Worker`, and the listeners of the process and of its standard
 * input before and after the load (the number of each event).
 */
const LOAD_PROBE = `
const file = process.argv[1];
const calls = [];
let loading = false;
const watch = (owner, label, names = Object.keys(owner)) => {
  for (const name of names) {
    const original = owner[name];
    if (typeof original !== 'function' || /^[A-Z]/.test(name)) continue;
    const wrapper = function (...args) {
      if (loading && !(args[0] === file && label === 'fs')) calls.push(label + '.' + name);
      return original.apply(this, args);
    };
    Object.assign(wrapper, original);
    owner[name] = wrapper;
  }
};
const fs = require('fs');
watch(fs, 'fs');
watch(fs.promises, 'fs.promises');
for (const name of ['child_process', 'net', 'http', 'https', 'dgram']) watch(require(name), name);
watch(globalThis, 'global', ['setTimeout', 'setInterval', 'setImmediate', 'fetch']);
const threads = require('worker_threads');
const OriginalWorker = threads.Worker;
threads.Worker = class extends OriginalWorker {
  constructor(...args) {
    if (loading) calls.push('worker_threads.Worker');
    super(...args);
  }
};
const listeners = () => {
  const count = (emitter) => Object.fromEntries(emitter.eventNames().map((name) => [String(name), emitter.listenerCount(name)]));
  return { process: count(process), stdin: count(process.stdin) };
};
const before = listeners();
loading = true;
const exported = require(file);
loading = false;
const after = listeners();
const functions = Object.keys(exported).filter((name) => typeof exported[name] === 'function');
process.stdout.write(JSON.stringify({ calls, functions, listeners: { before, after } }));
`;

/** A job of the analysis whose result says something. */
const JOB: AnalysisJob = { kind: 'hostAccess', checksOn: true, input: { config: { runArgs: ['--privileged'], mounts: ['type=bind,source=/,target=/host'] }, ownVolume: 'own' } };

let dir: string;
let bundle: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-entries-'));
  bundle = path.join(dir, 'helperChannel.js');
  // As a production build of esbuild.mjs builds it.
  await esbuild.build({ ...workerBundleOptions(sharedBundleOptions({ production: true })), outfile: bundle, logLevel: 'silent' });
}, 60_000);

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Runs Node.js with `args`; a process that does not end within 30 s is stopped and fails the test. */
function node(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, { timeout: 30_000, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error !== null && error.killed) reject(new Error(`node ${args.slice(0, 2).join(' ')} did not end: ${stderr}`));
      else resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : null, stdout, stderr });
    });
  });
}

/** A thread of the bundle: its messages, its output, and its exit code; `job` is posted to it once it is online. */
function thread(options: { workerData?: unknown; job?: AnalysisJob }): Promise<{ code: number; messages: unknown[]; stdout: string; stderr: string; errors: string[] }> {
  return new Promise((resolve) => {
    const worker = new Worker(bundle, { workerData: options.workerData, stdout: true, stderr: true });
    const messages: unknown[] = [];
    const errors: string[] = [];
    let stdout = '';
    let stderr = '';
    worker.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    worker.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    worker.on('message', (message: unknown) => messages.push(message));
    worker.on('error', (error) => errors.push(error.message));
    worker.on('online', () => {
      if (options.job !== undefined) worker.postMessage(options.job);
    });
    worker.on('exit', (code) => setImmediate(() => resolve({ code, messages, stdout, stderr, errors })));
  });
}

describe("the entries of the worker's bundle", () => {
  it('exports the entries of the worker, the batch helper and the Monitor; a require starts nothing and does no I/O', async () => {
    const { code, stdout, stderr } = await node(['-e', LOAD_PROBE, bundle]);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    const loaded = JSON.parse(stdout) as { calls: string[]; functions: string[]; listeners: { before: unknown; after: unknown } };
    expect(loaded.calls).toEqual([]);
    // No listener of a signal, of an error or of the standard input.
    expect(loaded.listeners.after).toEqual(loaded.listeners.before);
    expect(loaded.functions).toEqual(expect.arrayContaining([CHANNEL_ENTRY, BATCH_ENTRY, REMOTE_MONITOR_ENTRY]));
    expect([CHANNEL_ENTRY, BATCH_ENTRY, REMOTE_MONITOR_ENTRY]).toEqual(['startChannel', 'startBatchHelper', 'startMonitor']);
  });

  // `docker exec … node /opt/devspace/monitor.js heartbeat <json>`: the stored bundle as the main module.
  it('runs a subcommand of the Monitor as the main module', async () => {
    expect(await node([bundle, 'heartbeat', 'x'])).toEqual({ code: 2, stdout: '', stderr: 'Invalid heartbeat.\n' });
  });

  // A thread of the file has the file as its main module too: the Monitor runs only in the main thread.
  it('does nothing in a thread without the data of the analysis', async () => {
    expect(await thread({})).toEqual({ code: 0, messages: [], stdout: '', stderr: '', errors: [] });
    expect(await thread({ workerData: { devspaceThread: 'other' } })).toEqual({ code: 0, messages: [], stdout: '', stderr: '', errors: [] });
  });

  it('answers one job in a thread with the data of the analysis, and then ends', async () => {
    const expected = runAnalysisJob(JOB);
    expect(expected.report.hostAccess).not.toEqual([]);
    const answered = await thread({ workerData: ANALYSIS_THREAD_DATA, job: JOB });
    expect(answered).toEqual({ code: 0, messages: [{ ok: true, result: expected } satisfies AnalysisWorkerMessage], stdout: '', stderr: '', errors: [] });
  });

  // As the worker runs the analysis (flowOperations.ts: workerThreadAnalyzer): the bundle in a thread, after the check
  // of the hash of its file.
  it('runs the analysis of the worker from the file of the bundle', async () => {
    const warnings: string[] = [];
    const analyzer = new WorkerConfigurationAnalyzer({ file: bundle, hash: fileHash(bundle) }, { warn: (line) => void warnings.push(line) });
    expect(await analyzer.analyze(JOB)).toEqual(runAnalysisJob(JOB));
    expect(warnings).toEqual([]);
  });
});
