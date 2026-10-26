// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// No bypass of the worker, by construction: the extension's bundle holds no pipeline. Its operations send their flows
// to the worker (DevspaceOperations); the pipeline (DevspaceService), the image update check and the host access
// analysis run only there. Checked on the modules that esbuild bundles into dist/extension.js (its metafile), as
// esbuild.mjs builds it.
import * as fs from 'fs';
import * as path from 'path';
import * as esbuild from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

/** The modules of the pipeline that only the worker runs (relative to the repository root). */
const PIPELINE_MODULES = [
  'src/core/pipeline/devspaceService.ts',
  'src/core/imageCheck/imageCheck.ts',
  'src/core/helper/configurationAnalysis.ts',
  'src/core/helper/configurationAnalysisRunner.ts',
  'src/core/helper/configurationAnalysisWorker.ts',
  'src/core/worker/workerServices.ts',
  'src/core/worker/engineDocker.ts',
];

/**
 * The only modules of these folders that the extension may bundle: the bootstrap (the Docker CLI of this computer, the
 * helper image, the start of the worker, the Docker contexts, the attach diagnostics), the operations of the window
 * that send their flows to the worker, and the window's side of the worker's requests. Every other module of these
 * folders is the pipeline or the Docker of the flows, which only the worker runs. A new module in a bundle must be
 * named here on purpose.
 */
const ALLOWED_MODULES: Record<string, readonly string[]> = {
  'src/core/docker': [
    'attachDiagnostics.ts',
    'bootstrapDocker.ts',
    'dockerCli.ts',
    'dockerDownload.ts',
    'dockerHost.ts',
    'dockerObjects.ts',
    'dockerSetup.ts',
    'dockerStart.ts',
    'dockerTargets.ts',
    // The time limits of Docker calls, a module of their own, which the worker shares without the bootstrap.
    'dockerTimeouts.ts',
    // "Remove Devspaces from This Docker Engine…": the removal of the Monitor, the helper containers and images and the
    // shared volumes with the Docker CLI of the bootstrap, after the worker was ended.
    'engineRemoval.ts',
    'remoteDocker.ts',
  ],
  // missingHelperBuild.ts: the background build of a helper image that the refresh found missing.
  'src/core/helper': ['analysisLimits.ts', 'batchStepKinds.ts', 'helperImage.ts', 'helperImages.ts', 'helperPrebuild.ts', 'helperState.ts', 'missingHelperBuild.ts'],
  'src/core/imageCheck': ['credentials.ts', 'dockerfile.ts', 'reference.ts', 'registryClient.ts'],
  'src/core/pipeline': [
    'busyMarks.ts',
    'containerIds.ts',
    'devspaceOperations.ts',
    'imageRecord.ts',
    'lifecycleMemory.ts',
    'openRecords.ts',
    'operationBase.ts',
    'recordRules.ts',
  ],
  'src/core/policy': ['hostAccessChecks.ts', 'report.ts'],
  'src/core/worker': ['hostSide.ts', 'hostSideHandler.ts', 'openRequests.ts'],
};

/** Modules that the extension's bundle never holds: the workspace helper and its steps, the pipeline rules, policy. */
const BOOTSTRAP_ONLY_REMOVED = [
  'src/core/helper/workspaceHelper.ts',
  'src/core/helper/batchSteps.ts',
  'src/core/helper/scripts.ts',
  'src/core/helper/compose.ts',
  'src/core/helper/devcontainerCli.ts',
  'src/core/pipeline/pipelineRules.ts',
  'src/core/policy/index.ts',
];

let inputs: string[] = [];

beforeAll(async () => {
  const result = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: ['src/vscode/extension.ts'],
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
  inputs = Object.keys(result.metafile.inputs);
}, 60_000);

describe("the extension's bundle: no pipeline", () => {
  it('holds the operations of the window, which send the flows to the worker', () => {
    expect(inputs).toContain('src/core/pipeline/devspaceOperations.ts');
    expect(inputs).toContain('src/core/helperChannel/helperChannels.ts');
  });

  it('holds no module of the pipeline', () => {
    expect(inputs.filter((input) => PIPELINE_MODULES.includes(input))).toEqual([]);
  });
});

describe("the extension's bundle: only the bootstrap of Docker", () => {
  it('holds the Docker CLI of the bootstrap and the helper image', () => {
    expect(inputs).toContain('src/core/docker/bootstrapDocker.ts');
    expect(inputs).toContain('src/core/helper/helperImages.ts');
  });

  it('holds no module of the pipeline folders beyond the bootstrap and the operations of the window', () => {
    const outside = inputs.filter((input) => {
      const folder = path.posix.dirname(input);
      const allowed = ALLOWED_MODULES[folder];
      return allowed !== undefined && !allowed.includes(path.posix.basename(input));
    });
    expect(outside).toEqual([]);
  });

  it('holds no Docker CLI adapter of the flows, no step of the workspace helper and no policy', () => {
    expect(inputs.filter((input) => BOOTSTRAP_ONLY_REMOVED.includes(input))).toEqual([]);
  });

  it('names only modules that exist (a renamed module would pass unseen)', () => {
    const named = [...Object.entries(ALLOWED_MODULES).flatMap(([folder, files]) => files.map((file) => `${folder}/${file}`)), ...BOOTSTRAP_ONLY_REMOVED, ...PIPELINE_MODULES];
    expect(named.filter((file) => !fs.existsSync(path.join(ROOT, file)))).toEqual([]);
    // Each folder of the allowlist has modules that the extension must not bundle, so the check of the folder does something.
    for (const [folder, files] of Object.entries(ALLOWED_MODULES)) {
      const others = fs.readdirSync(path.join(ROOT, folder)).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && !files.includes(file));
      expect(others.length, folder).toBeGreaterThan(0);
    }
  });
});
