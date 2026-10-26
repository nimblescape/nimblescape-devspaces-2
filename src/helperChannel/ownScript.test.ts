// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The script of the process (ownScript): the file that the pipe loader stored and loaded, read and hashed once. Its
// hash must be the hash that the loader checked, from the command line `node -e <loader> <file> <hash> <entry>`.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bundleHash } from '../core/loader/pipeLoader';
import { ownScript, readOwnScript } from './ownScript';

/** The file of the module ownScript.ts, its `__filename` in the tests. */
const MODULE = path.join(__dirname, 'ownScript.ts');

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-own-script-'));
  file = path.join(dir, 'channel.js');
  fs.writeFileSync(file, 'module.exports.startChannel = () => {};\n');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the script of the process', () => {
  it('is the file of the loader, with the hash that the loader checked', () => {
    const text = fs.readFileSync(file, 'utf8');
    expect(readOwnScript(file, ['/usr/local/bin/node', file, bundleHash(text), 'startChannel'])).toEqual({ file, text, hash: bundleHash(text) });
  });

  it('fails when the file changed after the loader checked it', () => {
    const checked = bundleHash(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, 'module.exports.startChannel = () => { /* another script */ };\n');
    expect(() => readOwnScript(file, ['/usr/local/bin/node', file, checked, 'startChannel'])).toThrow(
      `The script ${file} changed after the loader checked it: its SHA-256 hash is ${bundleHash(fs.readFileSync(file, 'utf8'))} instead of ${checked}.`,
    );
  });

  it('has no hash to compare on another command line', () => {
    const text = fs.readFileSync(file, 'utf8');
    // Another program (a test), and a subcommand of the Monitor (`node /opt/devspace/monitor.js heartbeat <json>`).
    expect(readOwnScript(file, ['/usr/local/bin/node', path.join(dir, 'other.js'), bundleHash('other'), 'startChannel']).hash).toBe(bundleHash(text));
    expect(readOwnScript(file, ['/usr/local/bin/node', file, 'heartbeat', '{}']).hash).toBe(bundleHash(text));
    expect(readOwnScript(file, ['/usr/local/bin/node', file]).hash).toBe(bundleHash(text));
  });

  it('ownScript compares its own file with the command line of this process, and reads again after a failure', () => {
    const argv = process.argv;
    try {
      process.argv = ['/usr/local/bin/node', MODULE, bundleHash('another script'), 'startChannel'];
      expect(() => ownScript()).toThrow(`The script ${MODULE} changed after the loader checked it`);
      const text = fs.readFileSync(MODULE, 'utf8');
      process.argv = ['/usr/local/bin/node', MODULE, bundleHash(text), 'startChannel'];
      expect(ownScript()).toEqual({ file: MODULE, text, hash: bundleHash(text) });
    } finally {
      process.argv = argv;
    }
  });
});
