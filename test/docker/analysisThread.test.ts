// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The host access analysis in the worker. The worker starts each job in a thread of its own bundle (dist/helperChannel.js,
// the file that the pipe loader stored), after the check of the SHA-256 hash of that file, with the limits of the
// extension. This test runs that analyzer in the helper image as the worker runs (no network, no capability, no new
// privileges), with the worker's bundle as a production build of esbuild.mjs builds it, written to a file in the
// container, and checks a result, the time limit, the memory limit and the refusal of a changed file there.
import * as fs from 'fs';
import * as path from 'path';
import * as esbuild from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';
import { sharedBundleOptions, workerBundleOptions } from '../../scripts/bundleOptions.mjs';
import { buildDefines } from '../../scripts/buildDefines.mjs';
// The Docker CLI of the extension (BootstrapDocker).
import { BootstrapDocker } from '../../src/core/docker/bootstrapDocker';
import { NodeProcessRunner } from '../../src/core/process';
import { dockerTestContext, testHelperImage } from './harness';

/**
 * The program in the container: it writes the worker's bundle (__WORKER_BUNDLE__, put in by the build of this test) and
 * two scripts of the test to files, runs the analyzer of the worker over them, and prints the results.
 */
const PROGRAM = `
import { createHash } from 'crypto';
import * as fs from 'fs';
import { WorkerConfigurationAnalyzer, ANALYSIS_LIMITS } from './src/core/helper/configurationAnalysisRunner';
declare const __WORKER_BUNDLE__: string;
const job = { kind: 'hostAccess', checksOn: true, input: { ownVolume: 'own', metadata: [{ mounts: ['source=/etc,target=/host-etc,type=bind'] }] } };
const dir = fs.mkdtempSync('/tmp/analysis-');
function script(name: string, code: string) {
  const file = dir + '/' + name;
  fs.writeFileSync(file, code);
  return { file, hash: createHash('sha256').update(code, 'utf8').digest('hex') };
}
async function main() {
  const worker = script('helperChannel.js', __WORKER_BUNDLE__);
  const real = await new WorkerConfigurationAnalyzer(worker).analyze(job);
  const slow = script('slow.js', 'require("worker_threads").parentPort.on("message", () => { const t = Date.now(); while (Date.now() - t < 5000); });');
  const timed = await new WorkerConfigurationAnalyzer(slow, undefined, { ...ANALYSIS_LIMITS, timeoutMs: 500 }).analyze(job);
  const greedy = script('greedy.js', 'require("worker_threads").parentPort.on("message", () => { const a = []; for (;;) a.push(new Array(1e5).fill(1)); });');
  const memory = await new WorkerConfigurationAnalyzer(greedy, undefined, { ...ANALYSIS_LIMITS, timeoutMs: 30000, maxOldGenerationSizeMb: 32 }).analyze(job);
  fs.appendFileSync(worker.file, '\\n');
  const changed = await new WorkerConfigurationAnalyzer(worker).analyze(job);
  process.stdout.write(JSON.stringify({ real, timed: timed.failure, memory: memory.failure, changed: changed.failure }));
}
main();
`;

describe('the analysis thread of the worker in the helper image', () => {
  const { run, env, cli, log } = dockerTestContext('analysisThread');
  const docker = new BootstrapDocker(new NodeProcessRunner(), run.dockerPath, env, log);
  const root = path.resolve(__dirname, '../..');
  let bundle = '';
  let helperTag = '';

  beforeAll(async () => {
    const worker = await esbuild.build({ ...workerBundleOptions(sharedBundleOptions({ production: true })), write: false, logLevel: 'silent' });
    const entry = path.join(root, `.analysis-thread-${run.runId}.ts`);
    fs.writeFileSync(entry, PROGRAM);
    try {
      const result = await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node24',
        write: false,
        logLevel: 'silent',
        define: { ...buildDefines(), __WORKER_BUNDLE__: JSON.stringify(worker.outputFiles[0].text) },
      });
      bundle = result.outputFiles[0].text;
    } finally {
      fs.rmSync(entry, { force: true });
    }
    // The helper image through the harness.
    helperTag = (await testHelperImage(docker, log, env)).tag;
  });

  it("analyzes in a thread of the worker's bundle file, holds its time and memory limits there, and refuses a changed file", () => {
    const out = cli.ok(['run', '--rm', '-i', '--pull', 'never', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', helperTag, 'node', '-'], bundle);
    const result = JSON.parse(out) as { real: { report: { hostAccess: string[] }; failure?: unknown }; timed: unknown; memory?: { kind: string }; changed: unknown };
    expect(result.real.failure).toBeUndefined();
    expect(result.real.report.hostAccess).toEqual(['bind mount /etc']);
    expect(result.timed).toEqual({ kind: 'limit', reason: 'it took longer than 500 ms' });
    expect(result.memory?.kind).toBe('limit');
    expect(result.changed).toEqual({ kind: 'internal', reason: 'the script of the thread does not match its hash' });
  });
});
