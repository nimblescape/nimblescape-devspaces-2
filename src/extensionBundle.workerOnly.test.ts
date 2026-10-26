// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Mutation probe: the list of extensionBundle.test.ts names the pipeline, the image check and the analysis, but not the
// other modules that only the worker's pipeline runs. A value import of one of them into the extension (for example
// readDevspaceStates, a direct read of Docker that bypasses the worker's refresh, or writeContainerToken, a write of
// the GitHub token into a container from this computer) would pass that test, so this one checks them. Checked on the
// same metafile of dist/extension.js as esbuild.mjs builds it.
import * as path from 'path';
import * as esbuild from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

/** The modules that only the worker's pipeline (DevspaceService) runs, besides those of extensionBundle.test.ts. */
const WORKER_ONLY_MODULES = [
  // The direct reads of Docker of the refresh (never read directly in a window).
  'src/core/pipeline/refreshStates.ts',
  // The check of Delete and its Git reads (only in the worker).
  'src/core/pipeline/deleteCheck.ts',
  // The write of the GitHub token into a container.
  'src/core/helper/containerToken.ts',
  // The checks of a configuration before its build.
  'src/core/helper/configChecks.ts',
];

async function bundledModules(entryPoint: string): Promise<string[]> {
  const result = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['vscode'],
    define: { __DEVCONTAINER_CLI_VERSION__: JSON.stringify('0.0.0') },
    write: false,
    metafile: true,
    logLevel: 'silent',
    outfile: 'dist/extension.js',
  });
  return Object.keys(result.metafile.inputs);
}

let inputs: string[] = [];
let pipelineInputs: string[] = [];

beforeAll(async () => {
  inputs = await bundledModules('src/vscode/extension.ts');
  pipelineInputs = await bundledModules('src/core/pipeline/devspaceService.ts');
}, 60_000);

describe("the extension's bundle: no module that only the worker runs", () => {
  it('was built from the extension (the check below is not empty by accident)', () => {
    expect(inputs).toContain('src/core/pipeline/devspaceOperations.ts');
  });

  it('names each module as the metafile does (the pipeline itself holds each one)', () => {
    expect(WORKER_ONLY_MODULES.filter((module) => !pipelineInputs.includes(module))).toEqual([]);
  });

  it('holds none of the other modules that only the worker runs', () => {
    expect(inputs.filter((input) => WORKER_ONLY_MODULES.includes(input))).toEqual([]);
  });
});
