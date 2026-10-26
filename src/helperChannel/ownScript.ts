// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The script of this process: the file that the pipe loader checked against the hash on its command line, stored and
// loaded (`__filename` of the bundle dist/helperChannel.js). The same file is the program of the batch helpers and of
// the Monitor, which the worker starts with its text, and of the threads of the host access analysis, which start from
// the file itself (configurationAnalysisRunner.ts). Read and hashed once, at the first use, and compared with the hash
// that the loader checked; no I/O when the module is loaded.
import * as fs from 'fs';
import { bundleHash } from '../core/loader/pipeLoader';

/** The script of this process. */
export interface OwnScript {
  /** The file of the script. */
  file: string;
  /** Its text. */
  text: string;
  /** The SHA-256 hash of the text (bundleHash): the hash that the loader checked. */
  hash: string;
}

let own: OwnScript | undefined;

/**
 * The script of this process, read and hashed at the first call (readOwnScript of this file and the command line of
 * this process). A failed read or a hash that differs from the loader's throws, and the next call reads again.
 */
export function ownScript(): OwnScript {
  own ??= readOwnScript(__filename, process.argv);
  return own;
}

/**
 * The script in `file`, read and hashed. When `argv` is the command line of the pipe loader of that file (`node -e
 * <loader> <file> <hash> <entry>`: `argv[1]` is the file, `argv[2]` a hash), the hash of the text must be that hash:
 * a file that changed after the loader checked it throws, so the operation that needs the script fails. Another
 * command line (a test, or `node monitor.js <subcommand>`) has no hash to compare.
 */
export function readOwnScript(file: string, argv: readonly string[]): OwnScript {
  const text = fs.readFileSync(file, 'utf8');
  const hash = bundleHash(text);
  const checked = argv[1] === file && /^[0-9a-f]{64}$/.test(argv[2] ?? '') ? argv[2] : undefined;
  if (checked !== undefined && checked !== hash) {
    throw new Error(`The script ${file} changed after the loader checked it: its SHA-256 hash is ${hash} instead of ${checked}.`);
  }
  return { file, text, hash };
}
