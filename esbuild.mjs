// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as esbuild from 'esbuild';
import { packageBundleOptions, sharedBundleOptions } from './scripts/bundleOptions.mjs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// Watch mode output for the problem matcher of .vscode/tasks.json: one "[watch] build started" / "[watch] build
// finished" pair while any of the bundles builds (so the debugger starts only when all are written), and each message
// as "✘ [ERROR] <text>" followed by "    <file>:<line>:<column>:" (1-based column).
let runningBuilds = 0;
const watchReporter = {
  name: 'watch-reporter',
  setup(build) {
    build.onStart(() => {
      if (runningBuilds++ === 0) console.log('[watch] build started');
    });
    build.onEnd((result) => {
      for (const [kind, messages] of [['ERROR', result.errors], ['WARNING', result.warnings]]) {
        for (const { text, location } of messages) {
          console.error(`✘ [${kind}] ${text}`);
          if (location) console.error(`    ${location.file}:${location.line}:${location.column + 1}:`);
        }
      }
      if (--runningBuilds === 0) console.log('[watch] build finished');
    });
  },
};

const shared = {
  // The options of every bundle (scripts/bundleOptions.mjs): readable, with source maps only in a development build.
  ...sharedBundleOptions({ production }),
  // In watch mode the reporter above writes all output; esbuild's own "[watch] build finished" lines per bundle would
  // end the problem matcher's build too early.
  logLevel: watch ? 'silent' : 'info',
  plugins: watch ? [watchReporter] : [],
};

// The three bundles of the package (scripts/bundleOptions.mjs).
const bundles = packageBundleOptions(shared);

// A production build writes no source maps: remove maps of an earlier development build, so that no map that does not
// match the bundles stays in dist/.
if (production) {
  for (const { outfile } of bundles) fs.rmSync(`${outfile}.map`, { force: true });
}

const contexts = await Promise.all(bundles.map((options) => esbuild.context(options)));

if (watch) {
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
}
