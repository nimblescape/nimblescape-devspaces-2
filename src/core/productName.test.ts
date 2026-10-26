// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The product is Devspaces, a devspace, the devspaces: never two words, a hyphen, or the old name of the extension.
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');
const FOLDERS = ['.github', '.vscode', 'docs', 'resources', 'scripts', 'src', 'test'];
const FILES = ['README.md', 'package.json', '.vscodeignore', 'esbuild.mjs', 'ThirdPartyNotices.txt', 'SUPPORT.md'];
const TEXT = /\.(ts|js|mjs|json|md|py|sh|ya?ml|html|css|svg|txt)$|Dockerfile$/;

// "Dev Space", "Dev Spaces", "dev-space", "dev_space"; "devenv", "dev-env", "Dev Environments".
const OLD_NAMES = /\bdev[\s_-]+spaces?\b|\bdev[\s_-]?env/i;

function textFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && TEXT.test(entry.name)) files.push(full);
    }
  };
  for (const folder of FOLDERS) if (fs.existsSync(path.join(ROOT, folder))) walk(path.join(ROOT, folder));
  for (const file of FILES) if (fs.existsSync(path.join(ROOT, file))) files.push(path.join(ROOT, file));
  return files;
}

describe('the product name', () => {
  it('the pattern recognises the old spellings, the plural too, and leaves Devspaces alone', () => {
    for (const old of ['Dev Space', 'Dev Spaces', 'dev-space', 'DEV_SPACES', 'devenv', 'dev-env-1', 'Dev Environments']) expect(old).toMatch(OLD_NAMES);
    for (const name of ['Devspace', 'Devspaces', 'devspaces.reopenLastOnStartup', 'nimblescape.devspaces.id', 'DevSpaces-abcd1234', '/dev/null', 'process.env']) expect(name).not.toMatch(OLD_NAMES);
  });

  it('no source, test, resource, script or document names it the old way', () => {
    const files = textFiles();
    expect(files.length).toBeGreaterThan(500);
    const hits: string[] = [];
    for (const file of files) {
      fs.readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (path.resolve(file) !== __filename && OLD_NAMES.test(line)) hits.push(`${path.relative(ROOT, file)}:${index + 1}: ${line.trim()}`);
        });
    }
    expect(hits).toEqual([]);
  });
});
