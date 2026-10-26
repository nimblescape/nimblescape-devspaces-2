// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The worker's bundle (dist/helperChannel.js), built with the options of esbuild.mjs (workerBundleOptions of
// scripts/bundleOptions.mjs), checked on the modules that esbuild bundles into it (its metafile) and on its text. It is
// the one program of the worker, the batch helpers, the Monitor and the threads of the host access analysis, which are
// modules of it, not text in it. Nothing in it runs with `eval`; it holds fixed scripts as text (the pipe loader, and
// the scripts that run in containers with `node -e` or `sh -c`). It holds no code of the helper image of the extension:
// the worker runs from its own image, so its WorkspaceHelper builds, checks, maintains and records no helper image;
// HelperImages and what it runs (helperImage.ts) are the extension's.
import * as fs from 'fs';
import * as path from 'path';
import * as esbuild from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';
import { sharedBundleOptions, workerBundleOptions } from '../scripts/bundleOptions.mjs';

const ROOT = path.resolve(__dirname, '..');

/** The modules of the helper image of the extension: HelperImages, its build, check, cleanup and record, its prebuild. */
const HELPER_IMAGE_MODULES = ['src/core/helper/helperImages.ts', 'src/core/helper/helperImage.ts', 'src/core/helper/helperPrebuild.ts'];
/** The entries of the uses of the bundle: the worker and the batch helper, the Monitor, the analysis thread. */
const ENTRY_MODULES = ['src/helperChannel/main.ts', 'src/remoteMonitor/main.ts', 'src/core/helper/configurationAnalysisWorker.ts'];

let inputs: string[] = [];
let text = '';

beforeAll(async () => {
  // The options of a production build of esbuild.mjs.
  const result = await esbuild.build({
    ...workerBundleOptions(sharedBundleOptions({ production: true })),
    absWorkingDir: ROOT,
    outfile: 'dist/helperChannel.js',
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  inputs = Object.keys(result.metafile.inputs);
  text = result.outputFiles[0].text;
}, 60_000);

describe("the worker's bundle", () => {
  it('holds the worker, the Monitor and the thread of the host access analysis as its own modules', () => {
    for (const module of ENTRY_MODULES) expect(inputs).toContain(module);
  });

  // Before, a plugin built the Monitor and the analysis thread apart and put each into the bundle as a string
  // (the modules `devspace:monitor-script` and `devspace:analysis-script`), and the analysis thread ran that string.
  it('carries neither the Monitor nor the analysis as text', () => {
    expect(inputs.filter((input) => input.includes(':'))).toEqual([]);
    expect(text).not.toContain('devspace:monitor-script');
    expect(text).not.toContain('devspace:analysis-script');
  });

  // The bundle gives its fixed scripts to `node -e` or `sh -c` and runs no text as code itself. The only text "eval" in
  // the bundle today is `[eval` in a regular expression (pipeLoader.ts), which this check does not match.
  it('runs nothing with eval, Function or the module vm', () => {
    // eval( and (0, eval)( | Worker with { eval: true } | Function( and new Function( | require("vm")
    expect(text).not.toMatch(/\beval\s*\)?\s*\(|\beval:\s*(?:true|!0)|\bFunction\s*\(|require\("(?:node:)?vm"\)/);
  });

  it('holds the pipeline and the workspace helper (the check below is not empty by accident)', () => {
    expect(inputs).toContain('src/core/worker/workerServices.ts');
    expect(inputs).toContain('src/core/helper/workspaceHelper.ts');
  });

  it('holds no module of the helper image of the extension', () => {
    expect(inputs.filter((input) => HELPER_IMAGE_MODULES.includes(input))).toEqual([]);
  });

  // A renamed or moved module would make the checks above pass without checking it.
  it('names modules that exist', () => {
    for (const module of [...HELPER_IMAGE_MODULES, ...ENTRY_MODULES]) expect(fs.existsSync(path.join(ROOT, module)), module).toBe(true);
  });
});
