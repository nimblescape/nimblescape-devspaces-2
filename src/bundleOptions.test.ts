// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The bundles of the package are readable JavaScript: not minified, with the names of the source (`keepNames`), and
// with source maps only in a development build (scripts/bundleOptions.mjs, from which esbuild.mjs builds them). The
// worker's bundle holds the Monitor as readable code. No bundle holds the path of the folder that it was built in, or
// the version of package.json: a new version without a change of the code builds the same files.
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as esbuild from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';
import { packageBundleOptions, sharedBundleOptions } from '../scripts/bundleOptions.mjs';

const ROOT = path.resolve(__dirname, '..');
const OUTFILES = ['dist/extension.js', 'dist/groupsPreviewWorker.js', 'dist/helperChannel.js'];

/** The text of each bundle of a production build, by its output file. */
const bundles = new Map<string, string>();

beforeAll(async () => {
  for (const options of packageBundleOptions(sharedBundleOptions({ production: true }))) {
    const result = await esbuild.build({ ...options, absWorkingDir: ROOT, write: false, logLevel: 'silent' });
    expect(result.outputFiles.map((file) => path.relative(ROOT, file.path))).toEqual([options.outfile]);
    bundles.set(options.outfile, result.outputFiles[0].text);
  }
}, 120_000);

describe('the bundles of the package', () => {
  it('are the files of dist/ that the package holds', () => {
    expect([...bundles.keys()]).toEqual(OUTFILES);
    const packaged = fs
      .readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('!dist/'));
    expect(packaged).toEqual(OUTFILES.map((file) => `!${file}`));
  });

  it('are readable in a production build, without source maps', () => {
    expect(sharedBundleOptions({ production: true })).toMatchObject({ minify: false, keepNames: true, sourcemap: false });
    for (const options of packageBundleOptions(sharedBundleOptions({ production: true }))) {
      expect(options, options.outfile).toMatchObject({ minify: false, keepNames: true, sourcemap: false });
    }
  });

  it('have source maps in a development build, except the bundle of the worker', () => {
    expect(sharedBundleOptions({ production: false })).toMatchObject({ minify: false, keepNames: true, sourcemap: true });
    const development = packageBundleOptions(sharedBundleOptions({ production: false }));
    expect(development.map((options) => [options.outfile, options.sourcemap])).toEqual([
      ['dist/extension.js', true],
      ['dist/groupsPreviewWorker.js', true],
      ['dist/helperChannel.js', false],
    ]);
    for (const options of development) expect(options, options.outfile).toMatchObject({ minify: false, keepNames: true });
  });

  it('hold the code with its names and a comment that names each source file', () => {
    const worker = bundles.get('dist/helperChannel.js')!;
    expect(worker).toContain('function startMonitor(');
    expect(worker).toContain('\n// src/remoteMonitor/main.ts\n');
    expect(worker.split('\n').length).toBeGreaterThan(20_000);
    for (const [file, text] of bundles) {
      expect(text, file).toContain('var __name = ');
      expect(text, file).toMatch(/\n\/\/ src\/[\w/.-]+\.ts\n/);
    }
  });

  it('hold no path of the folder that they were built in', () => {
    for (const [file, text] of bundles) {
      expect(text.includes(ROOT), file).toBe(false);
      expect(text.includes(ROOT.split(path.sep).join('/')), file).toBe(false);
    }
  });
});

/**
 * A copy of the sources in `dir` with `version` in its package.json, and the files of its package that depend on the
 * build: package.json and the files that the build of the package writes to dist/ in that copy, by their path below
 * extension/ in the package. The copy has its own esbuild.mjs and scripts/, which read its own package.json, and
 * tsconfig.json, which esbuild also reads.
 */
function buildCopy(dir: string, version: string): Map<string, Buffer> {
  fs.cpSync(path.join(ROOT, 'src'), path.join(dir, 'src'), { recursive: true, filter: (source) => !source.endsWith('.test.ts') });
  fs.cpSync(path.join(ROOT, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
  for (const file of ['esbuild.mjs', 'tsconfig.json']) fs.copyFileSync(path.join(ROOT, file), path.join(dir, file));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as Record<string, unknown>;
  const packageJson = Buffer.from(`${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'package.json'), packageJson);
  // The build of the package: `npm run vscode:prepublish`, which `vsce package` runs first.
  execFileSync(process.execPath, ['esbuild.mjs', '--production'], { cwd: dir, stdio: 'pipe' });
  const files = new Map<string, Buffer>([['package.json', packageJson]]);
  for (const name of fs.readdirSync(path.join(dir, 'dist')).sort()) {
    files.set(`dist/${name}`, fs.readFileSync(path.join(dir, 'dist', name)));
  }
  return files;
}

describe('a new version without a change of the code', () => {
  it('builds the same bundles', () => {
    const { scripts } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    // buildCopy runs this build.
    expect(scripts['vscode:prepublish']).toBe('node esbuild.mjs --production');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-version-'));
    try {
      fs.mkdirSync(path.join(dir, 'a'));
      fs.mkdirSync(path.join(dir, 'b'));
      const previous = buildCopy(path.join(dir, 'a'), '97.531.8642');
      const next = buildCopy(path.join(dir, 'b'), '97.531.8643');
      expect([...next.keys()]).toEqual(['package.json', ...OUTFILES]);
      // Only the version of package.json differs.
      expect(previous.get('package.json')!.equals(next.get('package.json')!)).toBe(false);
      for (const file of OUTFILES) {
        expect(next.get(file)!.equals(previous.get(file)!), file).toBe(true);
        expect(next.get(file)!.includes('97.531.'), file).toBe(false);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
