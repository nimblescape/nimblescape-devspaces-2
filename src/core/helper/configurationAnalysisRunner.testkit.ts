// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Scripts of the analysis thread for the tests that run WorkerConfigurationAnalyzer (nothing of the extension or the
// worker uses this module). The thread always starts from a file with its hash, so each script is written to a file.
// analysisBundle is a small bundle of configurationAnalysisWorker.ts that starts as the end of src/helperChannel/main.ts
// does: a thread with ANALYSIS_THREAD_DATA answers its job. The tests of the limits of time and memory use it; the
// worker's bundle holds much more, and entries.test.ts runs the thread of that bundle.
import { createHash } from 'crypto';
import { buildSync } from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
import type { AnalysisScript } from './configurationAnalysisRunner';

/** The start of the thread at the end of src/helperChannel/main.ts. */
const THREAD_START = "import { isAnalysisThread, startAnalysisThread } from './configurationAnalysisWorker';\nif (isAnalysisThread()) startAnalysisThread();\n";

let files = 0;

/** The SHA-256 hash of the bytes of `file`, as the runner checks it. */
export function fileHash(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** `code` written to a new file in `dir`, and its hash. */
export function scriptFile(dir: string, code: string): AnalysisScript {
  const file = path.join(dir, `script-${++files}.js`);
  fs.writeFileSync(file, code);
  return { file, hash: fileHash(file) };
}

/** The bundle of the analysis thread, built into a new file in `dir`, and its hash. */
export function analysisBundle(dir: string): AnalysisScript {
  const file = path.join(dir, `analysisThread-${++files}.js`);
  buildSync({
    stdin: { contents: THREAD_START, resolveDir: __dirname, sourcefile: 'analysisThread.ts', loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    outfile: file,
    logLevel: 'silent',
    define: { __DEVCONTAINER_CLI_VERSION__: JSON.stringify('0.0.0') },
  });
  return { file, hash: fileHash(file) };
}
