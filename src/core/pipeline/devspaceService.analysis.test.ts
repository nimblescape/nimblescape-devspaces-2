// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The open pipeline with the host access analysis in a thread (WorkerConfigurationAnalyzer, as the worker runs it, with
// a bundle of the thread: configurationAnalysisRunner.testkit.ts; the analysis runs with limits of time and memory,
// against a denial of service by the parser). A normal configuration opens as with the analysis in this thread; a
// failed analysis (too slow, too much memory, a worker that does not start, a script file that was changed) refuses the
// configuration before anything is built.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { UserFacingError } from '../errors';
import { analysisInternalItem } from '../helper/configurationAnalysis';
import { ANALYSIS_LIMITS, WorkerConfigurationAnalyzer, type AnalysisLimits, type AnalysisScript } from '../helper/configurationAnalysisRunner';
import { analysisBundle, scriptFile } from '../helper/configurationAnalysisRunner.testkit';
import { Messages } from '../messages';
import { resourceName } from '../names';
import type { RepositoryTarget } from './operationBase';
import { REPO, createHarness, type Harness } from './devspaceService.testkit';
import { DEFAULT_CONFIG_PATH } from './recordRules';

const TARGET: RepositoryTarget = { repository: REPO, defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };
const FAILED_LINE = /^The host access analysis of the configuration failed \((.*)\); the configuration is refused\.$/;

let outDir: string;
/** The bundle of the thread in its file, and its hash. */
let bundle: AnalysisScript;
let h: Harness | undefined;

beforeAll(() => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-test-'));
  bundle = analysisBundle(outDir);
});

afterEach(() => {
  h?.cleanup();
  h = undefined;
});

afterAll(() => {
  fs.rmSync(outDir, { recursive: true, force: true });
});

/** A harness whose pipeline analyses in a thread of `script` with `limits`. */
function harness(limits: Partial<AnalysisLimits> = {}, script = bundle): Harness {
  let created: Harness | undefined;
  const logger = { warn: (message: string) => created?.logger.warn(message) };
  created = createHarness({ analyzer: new WorkerConfigurationAnalyzer(script, logger, { ...ANALYSIS_LIMITS, ...limits }) });
  h = created;
  return created;
}

async function rejection(promise: Promise<unknown>): Promise<UserFacingError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(UserFacingError);
    return error as UserFacingError;
  }
  throw new Error('The promise did not reject.');
}

/** A single container with this Dockerfile. */
function withDockerfile(harness: Harness, dockerfileText: string): void {
  harness.helper.config = { build: { dockerfile: 'Dockerfile' }, features: {} };
  harness.helper.files[DEFAULT_CONFIG_PATH] = { configText: '{ "build": { "dockerfile": "Dockerfile" } }', dockerfilePath: '.devcontainer/Dockerfile', dockerfileText };
}

describe('the open pipeline with the host access analysis in the worker', () => {
  it('opens a normal configuration as with the analysis in this thread', async () => {
    const worker = harness();
    withDockerfile(worker, 'ARG VARIANT=22\nFROM node:${VARIANT} AS build\nFROM ubuntu:24.04\n');
    await worker.service.open(TARGET, { progress: worker.progress });
    // The same as with the analysis in this thread.
    const local = createHarness();
    try {
      withDockerfile(local, 'ARG VARIANT=22\nFROM node:${VARIANT} AS build\nFROM ubuntu:24.04\n');
      await local.service.open(TARGET, { progress: local.progress });
      // The name of the devspace (resourceName).
      const names = new Map<Harness, string>();
      for (const one of [worker, local]) names.set(one, (await one.registry.list())[0].id);
      // The volume carries the word of the source, the images do not: both are the name of the devspace here.
      const calls = (harness: Harness): string[] =>
        harness.helper.calls.map((call) => call.split(resourceName(REPO, names.get(harness)!, 'config')).join('<name>').split(resourceName(REPO, names.get(harness)!)).join('<name>'));
      expect(calls(worker)).toEqual(calls(local));
      expect(calls(worker)).toContain('build <name>:1');
      expect(worker.checker.calls).toEqual(local.checker.calls);
      expect(worker.checker.calls.at(-1)?.images).toEqual(['node:22', 'ubuntu:24.04']);
    } finally {
      local.cleanup();
    }
    expect(worker.logger.warnings.filter((line) => FAILED_LINE.test(line))).toEqual([]);
  });

  it('refuses the configuration when the worker does not start, before anything is built', async () => {
    // A script that cannot load a module, as Node names it (the require stack of a real one would break the lines of the
    // message).
    const failing = harness({}, scriptFile(outDir, 'throw Object.assign(new Error("Cannot find module \'./missing\'"), { code: "MODULE_NOT_FOUND" });'));
    const error = await rejection(failing.service.open(TARGET, { progress: failing.progress }));
    expect(error.code).toBe('hostAccess');
    // An internal error, not "too complex, change the configuration" (the configuration is not to blame); still
    // refused.
    expect(error.message).toMatch(/^The configuration check failed to start \(internal error\): the worker did not start: .*\. Try again; if it fails again, reinstall Devspaces\.$/);
    expect(failing.helper.builds).toEqual([]);
    expect(failing.helper.ups).toEqual([]);
    expect(failing.logger.warnings.filter((line) => FAILED_LINE.test(line))).toHaveLength(1);
  });

  it('refuses the configuration when the file of the analysis was changed, before anything is built', async () => {
    const script = analysisBundle(outDir);
    fs.appendFileSync(script.file, '\n// changed\n');
    const changed = harness({}, script);
    const error = await rejection(changed.service.open(TARGET, { progress: changed.progress }));
    expect(error.code).toBe('hostAccess');
    // An internal error, not a limit of the configuration; still refused.
    expect(error.message).toBe(Messages.configurationCheckInternal(analysisInternalItem('the script of the thread does not match its hash')));
    expect(changed.helper.builds).toEqual([]);
    expect(changed.helper.ups).toEqual([]);
    expect(changed.logger.warnings.filter((line) => FAILED_LINE.test(line))).toEqual([
      'The host access analysis of the configuration failed (the script of the thread does not match its hash); the configuration is refused.',
    ]);
  });

  it('refuses the configuration when the analysis takes longer than its time limit', async () => {
    const slow = harness({ timeoutMs: 1 });
    const error = await rejection(slow.service.open(TARGET, { progress: slow.progress }));
    // Within 1 ms the worker is not even running: that is no limit of the configuration.
    expect(error.message).toBe(Messages.configurationCheckInternal(analysisInternalItem('the worker did not start within 1 ms')));
    expect(slow.helper.builds).toEqual([]);
    expect(slow.logger.warnings.filter((line) => FAILED_LINE.test(line))).toEqual([
      'The host access analysis of the configuration failed (the worker did not start within 1 ms); the configuration is refused.',
    ]);
  });

  it('allows a Dockerfile whose expansions grow without bound, within 2 s', async () => {
    const worker = harness();
    const head = `ARG B0=€€€€€€€€€€€€€€€€\n${Array.from({ length: 13 }, (_, i) => `ARG B${i + 1}=\${B${i}}\${B${i}}`).join('\n')}\n`;
    const body = Array.from({ length: 200 }, (_, l) => `ARG ${Array.from({ length: 50 }, (_, k) => `X${l * 50 + k}=a$B13`).join(' ')}`).join('\n');
    withDockerfile(worker, `${head}${body}\nFROM alpine\n`);
    const start = performance.now();
    await worker.service.open(TARGET, { progress: worker.progress });
    expect(performance.now() - start).toBeLessThan(2000);
    // Never refused as too complex to check: the update check skips it (no base images).
    expect(worker.helper.builds).toHaveLength(1);
    expect(worker.checker.calls.at(-1)?.images ?? []).toEqual([]);
  });
});
