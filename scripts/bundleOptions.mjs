// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The options of the bundles of esbuild.mjs. The tests that bundle the worker build it with the same options, so that
// they test the real bundle, and src/bundleOptions.test.ts checks the bundles of the package.
//
// Every bundle is readable JavaScript: not minified, and with the names of the source (`keepNames`), so that anyone can
// read the code of the package. Only a development build writes source maps.
//
// The worker's bundle, dist/helperChannel.js, is the program of four uses, each with its own entry
// (src/helperChannel/main.ts): the worker (startChannel), the batch helpers (startBatchHelper), the Monitor
// (startMonitor, and `node /opt/devspace/monitor.js <subcommand>`) and the threads of the host access analysis. Nothing
// in it runs with `eval`. It holds fixed scripts as text, which run with `node -e` or `sh -c`: the one-line pipe
// loader, and the scripts that the worker and the steps of the batch helpers run in containers.
import { fileURLToPath } from 'url';
import { buildDefines } from './buildDefines.mjs';

/** The entry of the worker's bundle. */
export const WORKER_ENTRY = fileURLToPath(new URL('../src/helperChannel/main.ts', import.meta.url));

/**
 * The options that every bundle shares: CommonJS for Node.js 24, readable (not minified, with the names of the source),
 * with source maps only in a development build, and with the compile-time constants (src/types/globals.d.ts), so that
 * code of src/core that a bundle imports never contains an undefined global.
 * @param {{ production: boolean }} options
 * @returns {import('esbuild').BuildOptions & { define: Record<string, string> }}
 */
export function sharedBundleOptions({ production }) {
  return {
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    minify: false,
    keepNames: true,
    sourcemap: !production,
    define: buildDefines(),
  };
}

/**
 * The options of the worker's bundle on top of the shared options (sharedBundleOptions, with the plugins of the
 * build): its entry, and never a source map. The extension sends the bundle over SSH as the first input line of the
 * pipe loader, and it runs in containers, which have no map.
 * @param {import('esbuild').BuildOptions} shared
 * @returns {import('esbuild').BuildOptions}
 */
export function workerBundleOptions(shared) {
  return { ...shared, entryPoints: [WORKER_ENTRY], sourcemap: false };
}

/**
 * The three bundles of the package, with `shared` (sharedBundleOptions, with the plugins and the log level of the
 * build). The paths are relative to the folder of the repository.
 * @param {import('esbuild').BuildOptions} shared
 * @returns {Array<import('esbuild').BuildOptions & { outfile: string }>}
 */
export function packageBundleOptions(shared) {
  return [
    // The extension.
    { ...shared, entryPoints: ['src/vscode/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] },
    // The worker thread of the repository groups editor: runs the regular expressions of the draft with a time limit.
    { ...shared, entryPoints: ['src/vscode/groupsPreviewWorker.ts'], outfile: 'dist/groupsPreviewWorker.js' },
    // The program of the worker, the batch helpers, the Monitor and the analysis threads.
    { ...workerBundleOptions(shared), outfile: 'dist/helperChannel.js' },
  ];
}
