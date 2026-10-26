// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The host access analysis in a bundle of its thread (configurationAnalysisRunner.testkit.ts: the start of the worker's
// bundle, without the rest of the worker), started from its file after the check of its hash, with its limits of time
// and memory, and the refusal of every failure (fail closed), also of a file that was changed or removed.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composeProjectName, resourceName } from '../names';
import type { ComposeModel } from './composeModel';
import { helperCliVariables, mayBeSetInHelper } from './cliVariables';
import {
  ANALYSIS_FAILED_ITEM,
  analysisFailure,
  analysisInternalItem,
  runAnalysisJob,
  transferableJob,
  type AnalysisJob,
  type AnalysisResult,
} from './configurationAnalysis';
import { inProcessAnalyzer } from './configurationAnalysis.testkit';
import { ANALYSIS_LIMITS, WorkerConfigurationAnalyzer, analysisSlots, type AnalysisLimits, type AnalysisScript } from './configurationAnalysisRunner';
import { analysisBundle, scriptFile } from './configurationAnalysisRunner.testkit';
import type { ComposeAccessInput } from '../policy';

const ROOT = path.join(__dirname, '..', '..', '..');
const ID = '3f2a9c1e-0000-4000-8000-000000000000';
// One name per devspace (resourceName): the project, the volume, and the container share it.
const PROJECT = composeProjectName('acme/api', ID);
const OWN = resourceName('acme/api', ID);
/** The name of a devspace of another repository and ID. */
const OTHER = resourceName('acme/web', '11111111-2222-4333-8444-555555555555');
const REPO = '/workspaces/api';
const REFUSED = { hostAccess: [], unsupported: [ANALYSIS_FAILED_ITEM] };

let outDir: string;
/** The bundle of the thread in its file, and its hash. */
let bundle: AnalysisScript;

beforeAll(() => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-test-'));
  bundle = analysisBundle(outDir);
});

afterAll(() => {
  fs.rmSync(outDir, { recursive: true, force: true });
});

/** A logger that keeps the warnings. */
function warnings(): { warn: (message: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { warn: (message) => void lines.push(message), lines };
}

function analyzer(limits: Partial<AnalysisLimits> = {}, logger = warnings()): WorkerConfigurationAnalyzer {
  return new WorkerConfigurationAnalyzer(bundle, logger, { ...ANALYSIS_LIMITS, ...limits });
}

function composeInput(model: ComposeModel, extra: Partial<ComposeAccessInput> = {}): ComposeAccessInput {
  return {
    model,
    devService: Object.keys(model.services)[0],
    project: PROJECT,
    repositoryFolder: REPO,
    ownVolume: OWN,
    engineApiVersion: '1.47',
    devspace: { id: ID, ownerId: '42' },
    ...extra,
  };
}

/** A single container with this Dockerfile. */
function singleJob(dockerfileText: string, config: Record<string, unknown> = { build: { dockerfile: 'Dockerfile' } }): AnalysisJob {
  return {
    kind: 'single',
    input: { config, ownVolume: OWN, configFolder: `${REPO}/.devcontainer`, repositoryFolder: REPO },
    checksOn: true,
    config,
    dockerfileText,
  };
}

// Hostile Dockerfiles and Compose models (repros), at sizes that exhaust a parser without limits.
/** ARGs B0 … B13 that double their value, then `lines` ARGs of `form`, then FROM alpine. */
function doubling(first: string, lines: number, form: (i: number) => string): string {
  const head = `ARG B0=${first}\n${Array.from({ length: 13 }, (_, i) => `ARG B${i + 1}=\${B${i}}\${B${i}}`).join('\n')}\n`;
  const body: string[] = [];
  for (let l = 0; l < lines / 50; l++) body.push(`ARG ${Array.from({ length: 50 }, (_, k) => form(l * 50 + k)).join(' ')}`);
  return `${head}${body.join('\n')}\nFROM alpine\n`;
}
const BUDGET = `ARG A=${'a'.repeat(4000)}\nARG P=${'*a'.repeat(500)}b\n${Array.from({ length: 20 }, (_, i) => `FROM \${A#$P}${i}`).join('\n')}\n`;
/** 10000 ARGs of 64 KiB each, which run out of MAX_EXPANDED_CHARACTERS (about 35 ms in extractBaseImages). */
const MEM4 = doubling('€€€€€€€€€€€€€€€€', 10_000, (i) => `X${i}=a$B13`);
// The Dockerfiles of mem4, budget, and services are allowed (the Dockerfiles are not checked), and the update check
// skips what it cannot read.
const REPROS: Array<{ name: string; job: AnalysisJob; refused: boolean }> = [
  // 10000 ARGs of 64 KiB each (extractBaseImages: base).
  { name: 'mem4 and base', job: singleJob(MEM4), refused: false },
  // 1000 forms on a value of 64 KiB (their results are not used: the Dockerfile passes).
  { name: 'trim', job: singleJob(doubling('xxxxxxxxxxxxxxxy', 1000, () => 'X=${B13%x}')), refused: false },
  // Pattern forms that are slow for a backtracking pattern matcher.
  { name: 'budget', job: singleJob(BUDGET), refused: false },
  // A directive with 40000 spaces (a valid Dockerfile).
  { name: 'directive', job: singleJob(`# check=a${' '.repeat(40_000)}b\nFROM alpine\n`), refused: false },
  // 40000 bind mounts.
  {
    name: 'quadfind',
    job: {
      kind: 'compose',
      checksOn: true,
      input: composeInput({ name: PROJECT, services: { app: { image: 'alpine', volumes: Array.from({ length: 40_000 }, (_, i) => ({ type: 'bind', source: `/etc/x${i}`, target: `/x${i}` })) } } }),
    },
    refused: true,
  },
  // 20 services with the Dockerfile of `budget`.
  {
    name: 'services',
    job: {
      kind: 'compose',
      checksOn: true,
      input: composeInput(
        { name: PROJECT, services: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`s${i}`, { build: { context: REPO, dockerfile: 'Dockerfile' } }])) },
        { dockerfiles: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`s${i}`, BUDGET])) },
      ),
    },
    refused: false,
  },
];

describe('WorkerConfigurationAnalyzer', () => {
  it('gives the results of this thread for normal configurations', async () => {
    const worker = analyzer();
    const dockerfile = 'ARG VARIANT=3.12\nFROM mcr.microsoft.com/devcontainers/python:${VARIANT} AS base\nCOPY --from=base / /\nFROM base\n';
    const jobs: AnalysisJob[] = [
      singleJob(dockerfile, { build: { dockerfile: 'Dockerfile', args: { VARIANT: '3.11' } }, features: { 'ghcr.io/devcontainers/features/node:1': {} } }),
      singleJob(`FROM ${OTHER}:1\n`),
      { kind: 'hostAccess', checksOn: true, input: { config: { runArgs: ['--privileged', '-p', '3000:3000'], mounts: ['type=bind,source=/,target=/host'] }, ownVolume: OWN } },
      { kind: 'hostAccess', checksOn: false, input: { config: { runArgs: ['--privileged'] }, ownVolume: OWN } },
      {
        kind: 'compose',
        checksOn: true,
        features: { 'ghcr.io/devcontainers/features/node:1': {} },
        input: composeInput(
          {
            name: PROJECT,
            services: {
              app: { build: { context: REPO, dockerfile: 'Dockerfile' }, volumes: [{ type: 'bind', source: '/workspaces', target: '/workspaces' }] },
              db: { image: 'postgres:16', restart: 'unless-stopped', volumes: [{ type: 'volume', source: 'pgdata', target: '/var/lib/postgresql/data' }] },
              cache: { image: `${OTHER}:1`, privileged: true },
            },
            volumes: { pgdata: { name: `${PROJECT}_pgdata` } },
          },
          { dockerfiles: { app: dockerfile } },
        ),
      },
    ];
    for (const job of jobs) {
      const expected = runAnalysisJob(job);
      expect(await worker.analyze(job)).toEqual(expected);
      expect(await inProcessAnalyzer.analyze(job)).toEqual(expected);
    }
    // Not empty: the results say something.
    expect(runAnalysisJob(jobs[0])).toMatchObject({ references: { images: ['mcr.microsoft.com/devcontainers/python:3.11'], features: ['ghcr.io/devcontainers/features/node:1'] } });
    // A name like devspaces-… is allowed; the pipeline refuses an image of another account by its ID.
    expect(runAnalysisJob(jobs[4]).report.hostAccess).toEqual(['service cache: privileged mode']);
  });

  it('finishes the repros in less than 2 s together, and refuses the hostile ones', async () => {
    const worker = analyzer();
    const start = performance.now();
    const results = await Promise.all(REPROS.map(async ({ job }) => worker.analyze(job)));
    const ms = performance.now() - start;
    expect(ms).toBeLessThan(2000);
    REPROS.forEach(({ name, refused }, index) => {
      const report = results[index].report;
      expect(report.hostAccess.length + report.unsupported.length > 0, name).toBe(refused);
    });
    // The Dockerfiles are not checked.
    expect(results[0].report).toEqual({ hostAccess: [], unsupported: [] });
    expect(results[0]).toMatchObject({ references: { images: [] } });
  });

  it('refuses a job that takes longer than its time limit, and stops its worker', async () => {
    // 80 services whose Dockerfiles run out of the expansion budget of the update check: seconds in this thread.
    const services: ComposeModel['services'] = {};
    const dockerfiles: Record<string, string> = {};
    for (let i = 0; i < 80; i++) {
      services[`s${i}`] = { build: { context: REPO, dockerfile: 'Dockerfile', args: { N: String(i) } } };
      dockerfiles[`s${i}`] = MEM4;
    }
    const job: AnalysisJob = { kind: 'compose', checksOn: true, input: composeInput({ name: PROJECT, services }, { dockerfiles }) };
    const logger = warnings();
    const start = performance.now();
    const result = await analyzer({ timeoutMs: 300 }, logger).analyze(job);
    expect(performance.now() - start).toBeLessThan(1500);
    // The result names the failure (a limit: the configuration is too complex).
    expect(result).toEqual(analysisFailure(job, { kind: 'limit', reason: 'it took longer than 300 ms' }));
    expect(result.report).toEqual(REFUSED);
    expect(logger.lines).toEqual(['The host access analysis of the configuration failed (it took longer than 300 ms); the configuration is refused.']);
  });

  // The test process runs with NODE_OPTIONS=--max-old-space-size (vitest.config.mts does not set it, the environment
  // may), where V8 ignores `resourceLimits`: the watch of the heap stops the worker.
  it('refuses a job whose worker runs out of memory', async () => {
    // 200000 bind mounts (their items alone take more than 8 MB) in a worker of 8 MB.
    const volumes = Array.from({ length: 200_000 }, (_, i) => ({ type: 'bind', source: `/etc/x${i}`, target: `/x${i}` }));
    const job: AnalysisJob = { kind: 'compose', checksOn: true, input: composeInput({ name: PROJECT, services: { app: { image: 'alpine', volumes } } }) };
    const logger = warnings();
    const start = performance.now();
    const result = await analyzer({ maxOldGenerationSizeMb: 8, maxYoungGenerationSizeMb: 1 }, logger).analyze(job);
    expect(performance.now() - start).toBeLessThan(2000);
    // The result names the failure (a limit).
    expect(result).toEqual(analysisFailure(job, { kind: 'limit', reason: 'it used too much memory' }));
    expect(logger.lines).toEqual(['The host access analysis of the configuration failed (it used too much memory); the configuration is refused.']);
  });

  it('refuses a job whose worker cannot start, crashes, ends, throws, or answers with anything but a result', async () => {
    const job: AnalysisJob = { kind: 'hostAccess', checksOn: true, input: { config: {}, ownVolume: OWN } };
    const scripts: Record<string, string> = {
      crash: 'throw new Error("crash");',
      exit: 'process.exit(3);',
      silent: 'require("worker_threads").parentPort.on("message", () => process.exit(0));',
      thrown: 'require("worker_threads").parentPort.on("message", () => require("worker_threads").parentPort.postMessage({ ok: false, error: "thrown" }));',
      garbage: 'require("worker_threads").parentPort.on("message", () => require("worker_threads").parentPort.postMessage({ ok: true, result: { report: { hostAccess: [1] } } }));',
      allow: 'require("worker_threads").parentPort.on("message", () => require("worker_threads").parentPort.postMessage({ ok: true, result: {} }));',
    };
    // The scripts in their files, and one that cannot load its module as the worker that does not start.
    const codes = ['require("./missing-module-of-the-test");', ...Object.values(scripts)];
    // None of them is a limit of the configuration: an internal error, with its own item (still refused: never
    // allowed).
    const internal = (result: { report: unknown; failure?: { kind: string; reason: string } }) => {
      expect(result.failure?.kind).toBe('internal');
      expect(result.report).toEqual({ hostAccess: [], unsupported: [analysisInternalItem(result.failure!.reason)] });
    };
    const reasons: string[] = [];
    for (const code of codes) {
      const logger = warnings();
      const result = await new WorkerConfigurationAnalyzer(scriptFile(outDir, code), logger, { ...ANALYSIS_LIMITS, timeoutMs: 5000 }).analyze(job);
      internal(result);
      reasons.push(result.failure!.reason);
      expect(logger.lines, code).toHaveLength(1);
    }
    expect(reasons[0]).toMatch(/^the worker did not start: /);
    expect(reasons.slice(1)).toEqual(['error: crash', 'the worker ended with exit code 3', 'the worker ended with exit code 0', 'error: thrown', 'an answer that is no result', 'an answer that is no result']);
    // A job that cannot be passed to a worker (a function is no structured clone).
    const unclonable = { kind: 'hostAccess', checksOn: true, input: { config: { f: () => 1 }, ownVolume: OWN } } as unknown as AnalysisJob;
    internal(await analyzer().analyze(unclonable));
    // A job that the analysis throws on, in this thread too.
    const unknown = { kind: 'other' } as unknown as AnalysisJob;
    const thrown = await analyzer().analyze(unknown);
    internal(thrown);
    expect(thrown).toMatchObject({ imageReferences: [], references: { images: [], features: [] } });
    internal(await inProcessAnalyzer.analyze(unknown));
  });

  it('refuses a job whose texts are larger than the budget before it is passed to a worker', async () => {
    const logger = warnings();
    const worker = new WorkerConfigurationAnalyzer(bundle, logger, ANALYSIS_LIMITS, 1000);
    const job: AnalysisJob = singleJob(`FROM alpine\n# ${'a'.repeat(2000)}\n`);
    const result = await worker.analyze(job);
    // A size limit (deterministic), not `limit` (time or memory of the worker).
    expect(result.failure).toEqual({ kind: 'size', reason: 'the configuration is larger than 0 million characters' });
    expect(result.report).toEqual(REFUSED);
    // Many small values count too.
    const many: AnalysisJob = { kind: 'hostAccess', checksOn: true, input: { config: { runArgs: Array.from({ length: 200 }, () => '') }, ownVolume: OWN } };
    expect((await worker.analyze(many)).failure?.kind).toBe('size');
    // Within the budget: the worker runs it.
    expect((await new WorkerConfigurationAnalyzer(bundle, logger).analyze(job)).failure).toBeUndefined();
  });

  it('tells a worker that did not start in time apart from one that took too long', async () => {
    const script = scriptFile(outDir, 'require("worker_threads").parentPort.on("message", () => { const t = Date.now(); while (Date.now() - t < 2000); });');
    const job: AnalysisJob = { kind: 'hostAccess', checksOn: true, input: { config: {}, ownVolume: OWN } };
    const result = await new WorkerConfigurationAnalyzer(script, warnings(), { ...ANALYSIS_LIMITS, timeoutMs: 300 }).analyze(job);
    expect(result.failure).toEqual({ kind: 'limit', reason: 'it took longer than 300 ms' });
    const early = await new WorkerConfigurationAnalyzer(script, warnings(), { ...ANALYSIS_LIMITS, timeoutMs: 1 }).analyze(job);
    expect(early.failure).toEqual({ kind: 'internal', reason: 'the worker did not start within 1 ms' });
  });

  it('passes the variables of the Dev Container CLI to the worker (postMessage copies no function)', async () => {
    const variables = helperCliVariables('acme/api');
    const input = {
      ownVolume: OWN,
      variables,
      metadata: [{ mounts: ['source=${localEnv:HOME}/.ssh,target=/root/.ssh,type=bind', 'source=${localEnv:TERM}-x,target=/x,type=volume'] }],
    };
    const job: AnalysisJob = { kind: 'hostAccess', checksOn: true, input };
    const result = await analyzer().analyze(job);
    expect(result.failure).toBeUndefined();
    expect(result.report).toEqual(runAnalysisJob(job).report);
    expect(result.report.hostAccess).toEqual(['bind mount /root/.ssh']);
    // The job of the caller keeps its function; only the copy for the worker is without it.
    expect(transferableJob(job)).toEqual({ ...job, input: { ...input, variables: { localWorkspaceFolder: REPO, containerWorkspaceFolder: REPO, env: variables.env } } });
    expect(job.input.variables?.mayBeSet).toBe(mayBeSetInHelper);
    // Another function is not passed: the job is refused (it cannot be checked as the caller meant it).
    const other: AnalysisJob = { kind: 'hostAccess', checksOn: true, input: { ...input, variables: { ...variables, mayBeSet: () => true } } };
    expect((await analyzer().analyze(other)).failure?.kind).toBe('internal');
  });

  // The file is the only way: its result is the one of the analysis in this thread.
  it('runs from the file of its script, with its limits', async () => {
    const variables = helperCliVariables('acme/api');
    const job: AnalysisJob = {
      kind: 'hostAccess',
      checksOn: true,
      input: { ownVolume: OWN, variables, metadata: [{ mounts: ['source=${localEnv:HOME}/.ssh,target=/root/.ssh,type=bind'] }] },
    };
    const fromFile = await new WorkerConfigurationAnalyzer(bundle, warnings()).analyze(job);
    expect(fromFile.failure).toBeUndefined();
    expect(fromFile.report).toEqual(runAnalysisJob(job).report);
    expect(fromFile.report.hostAccess).toEqual(['bind mount /root/.ssh']);
    // The time limit holds for any script.
    const slow = scriptFile(outDir, 'require("worker_threads").parentPort.on("message", () => { const t = Date.now(); while (Date.now() - t < 2000); });');
    const result = await new WorkerConfigurationAnalyzer(slow, warnings(), { ...ANALYSIS_LIMITS, timeoutMs: 300 }).analyze(job);
    expect(result.failure).toEqual({ kind: 'limit', reason: 'it took longer than 300 ms' });
    // So does the memory limit.
    const greedy = scriptFile(outDir, 'require("worker_threads").parentPort.on("message", () => { const a = []; for (;;) a.push(new Array(1e5).fill(1)); });');
    const memory = await new WorkerConfigurationAnalyzer(greedy, warnings(), { ...ANALYSIS_LIMITS, timeoutMs: 20_000, maxOldGenerationSizeMb: 32 }).analyze(job);
    expect(memory.failure?.kind).toBe('limit');
    expect(memory.report).toEqual(REFUSED);
    // A file that does not compile is an internal failure, refused.
    const broken = await new WorkerConfigurationAnalyzer(scriptFile(outDir, 'this is not JavaScript'), warnings()).analyze(job);
    expect(broken.failure?.kind).toBe('internal');
    expect(broken.report).toEqual({ hostAccess: [], unsupported: [analysisInternalItem(broken.failure!.reason)] });
  });

  // Each start reads the file again and checks its hash: a file that was changed or removed since the last start does
  // not run.
  it('refuses a job when the file of its script was changed or removed, and runs nothing of it', async () => {
    const job: AnalysisJob = { kind: 'hostAccess', checksOn: true, input: { config: { runArgs: ['--privileged'] }, ownVolume: OWN } };
    const script = analysisBundle(outDir);
    const original = fs.readFileSync(script.file);
    const logger = warnings();
    const worker = new WorkerConfigurationAnalyzer(script, logger);
    expect(await worker.analyze(job)).toEqual(runAnalysisJob(job));
    // The changed file does not run: its added line would write the marker.
    const marker = path.join(outDir, 'the-changed-script-ran');
    fs.appendFileSync(script.file, `\nrequire("fs").writeFileSync(${JSON.stringify(marker)}, "");\n`);
    const changed = await worker.analyze(job);
    expect(changed).toEqual(analysisFailure(job, { kind: 'internal', reason: 'the script of the thread does not match its hash' }));
    expect(changed.report).toEqual({ hostAccess: [], unsupported: [analysisInternalItem('the script of the thread does not match its hash')] });
    // A missing file.
    fs.rmSync(script.file);
    const missing = await worker.analyze(job);
    expect(missing.failure).toEqual({ kind: 'internal', reason: expect.stringMatching(/^the script of the thread cannot be read: ENOENT/) });
    expect(missing.report.unsupported).toEqual([analysisInternalItem(missing.failure!.reason)]);
    expect(logger.lines).toEqual([
      'The host access analysis of the configuration failed (the script of the thread does not match its hash); the configuration is refused.',
      expect.stringMatching(/^The host access analysis of the configuration failed \(the script of the thread cannot be read: ENOENT.*\); the configuration is refused\.$/),
    ]);
    // The file as it was runs again.
    fs.writeFileSync(script.file, original);
    expect(await worker.analyze(job)).toEqual(runAnalysisJob(job));
    expect(fs.existsSync(marker)).toBe(false);
  });

  // The extension does not run the analysis (the worker does, in a thread of its own bundle), so the analysis has no
  // bundle of its own in the extension.
  it('is no bundle of the extension: neither built by esbuild.mjs nor packaged', () => {
    expect(fs.readFileSync(path.join(ROOT, 'esbuild.mjs'), 'utf8')).not.toContain("entryPoints: ['src/core/helper/configurationAnalysisWorker.ts']");
    expect(fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8').split('\n')).not.toContain('!dist/configurationAnalysisWorker.js');
    expect(fs.readFileSync(path.join(ROOT, 'src', 'vscode', 'extension.ts'), 'utf8')).not.toContain('WorkerConfigurationAnalyzer');
  });
});

describe('analysisSlots', () => {
  it('runs at most `max` jobs at once, the others in order, and frees a slot also when a job fails', async () => {
    const slots = analysisSlots(2);
    const started: string[] = [];
    const finish = new Map<string, (fail?: boolean) => void>();
    const job = (name: string) =>
      slots(
        () =>
          new Promise<AnalysisResult<AnalysisJob>>((resolve, reject) => {
            started.push(name);
            finish.set(name, (fail) => (fail ? reject(new Error(name)) : resolve({ name } as never)));
          }),
      );
    const a = job('a');
    const b = job('b');
    const c = job('c');
    const d = job('d');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(['a', 'b']);
    finish.get('a')!(true);
    await expect(a).rejects.toThrow('a');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(['a', 'b', 'c']);
    finish.get('b')!();
    expect(await b).toEqual({ name: 'b' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(['a', 'b', 'c', 'd']);
    finish.get('c')!();
    finish.get('d')!();
    await Promise.all([c, d]);
    // Both slots are free again: two new jobs start at once.
    const e = job('e');
    const f = job('f');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started.slice(-2)).toEqual(['e', 'f']);
    finish.get('e')!();
    finish.get('f')!();
    await Promise.all([e, f]);
  });
});

describe('analysisSlots: its guards', () => {
  it('refuses fewer than one slot, and frees a slot when a job throws at once', async () => {
    for (const max of [0, -1, 1.5, Number.NaN]) expect(() => analysisSlots(max)).toThrow(RangeError);
    const slots = analysisSlots(1);
    await expect(
      slots((): Promise<AnalysisResult<AnalysisJob>> => {
        throw new Error('at once');
      }),
    ).rejects.toThrow('at once');
    // The slot is free again.
    expect(await slots(async () => ({ ok: true }) as never)).toEqual({ ok: true });
  });
});
