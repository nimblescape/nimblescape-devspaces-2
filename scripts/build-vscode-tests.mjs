// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Bundles each test of test/vscode/ to out/test/vscode/<name>.test.js for the tests in a real VS Code
// (.vscode-test.mjs), and the tests of test/vscode/attach/ and test/vscode/untrusted/ to out/test/vscode/attach/ and
// out/test/vscode/untrusted/. The module `vscode` comes from the extension host, and mocha from @vscode/test-cli.
// test/vscode/attach/prepare.ts becomes a Node program for CI.
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as esbuild from 'esbuild';
import { buildDefines } from './buildDefines.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = path.join(root, 'test', 'vscode');
const outdir = path.join(root, 'out', 'test', 'vscode');

const attach = path.join(source, 'attach');
const untrusted = path.join(source, 'untrusted');
// The compile-time constants of esbuild.mjs: the attach tests bundle modules of src/core.
const define = buildDefines();
const tests = (folder) => fs.readdirSync(folder).filter((name) => name.endsWith('.test.ts')).map((name) => path.join(folder, name));

fs.rmSync(outdir, { recursive: true, force: true });
await esbuild.build({
  entryPoints: [...tests(source), ...tests(attach), ...tests(untrusted)],
  outdir,
  outbase: source,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  sourcemap: true,
  external: ['vscode', 'mocha'],
  define,
  logLevel: 'info',
});

await esbuild.build({
  entryPoints: [path.join(attach, 'prepare.ts')],
  outdir: path.join(outdir, 'attach'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  sourcemap: true,
  external: ['@vscode/test-electron'],
  define,
  logLevel: 'info',
});
