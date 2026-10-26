// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The worker's script in the volume of the Monitor (the Monitor triggers the prepare), so that the
// monitor runs the headless prepare (the worker operation `prepare`) with the worker of the same extension version,
// without a computer. The worker that ensures the monitor stores its own script (storeWorkerScript) at
// `<volume>/worker-scripts/<sha256>.js` and gives the monitor container that it creates the hash in
// MONITOR_WORKER_HASH_ENV; the monitor reads exactly that file (readWorkerScript: a plain file whose sha256 is that
// hash) and starts it with the pipe loader, which checks the hash again. So a monitor runs only the worker script of
// the worker that created it. The folder holds nothing else of value: the monitor removes the scripts of other hashes
// after a day (removeOtherWorkerScripts), and a worker of that version stores its own again at its next ensure. Like
// every file of the volume, it is no defence against someone who already has the Docker socket of the engine. No
// `vscode`.
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { MAX_BUNDLE_LINE_LENGTH, bundleHash } from '../loader/pipeLoader';

/** The variable of the monitor container with the sha256 of the worker script that its prepares run (64 hex digits). */
export const MONITOR_WORKER_HASH_ENV = 'DEVSPACE_WORKER_HASH';
/** The folder of the worker scripts in the volume of the Monitor (0700). */
export const WORKER_SCRIPT_FOLDER = 'worker-scripts';
/** The largest worker script that is stored or read (the pipe loader takes no longer line either). */
export const MAX_WORKER_SCRIPT_BYTES = MAX_BUNDLE_LINE_LENGTH;
/** A script of another hash whose file is older than this is removed by the monitor (removeOtherWorkerScripts). */
export const WORKER_SCRIPT_MAX_AGE_MS = 24 * 60 * 60_000;

const HASH = /^[0-9a-f]{64}$/;
const SCRIPT_NAME = /^([0-9a-f]{64})\.js$/;
const TEMPORARY_NAME = /^[0-9a-f]{64}\.js\.[0-9a-f]{12}\.tmp$/;

/** Whether `value` is the hash of a worker script (64 lower-case hex digits). */
export function isWorkerScriptHash(value: unknown): value is string {
  return typeof value === 'string' && HASH.test(value);
}

/** The file of the worker script with the hash `hash` under the volume folder `stateDir`. */
export function workerScriptPath(stateDir: string, hash: string): string {
  if (!isWorkerScriptHash(hash)) throw new Error('The hash of the worker script is invalid.');
  return path.posix.join(stateDir, WORKER_SCRIPT_FOLDER, `${hash}.js`);
}

/** The folder of the worker scripts: created with 0700 when it is missing, never a symbolic link. */
function scriptFolder(stateDir: string): string {
  const folder = path.posix.join(stateDir, WORKER_SCRIPT_FOLDER);
  try {
    fs.mkdirSync(folder, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = fs.lstatSync(folder);
  if (!stat.isDirectory()) throw new Error(`${folder} is not a folder.`);
  if ((stat.mode & 0o777) !== 0o700) fs.chmodSync(folder, 0o700);
  return folder;
}

/**
 * The text of the plain file `file` (never through a link: O_NOFOLLOW), when it is at most MAX_WORKER_SCRIPT_BYTES;
 * undefined for anything else. Never throws.
 */
function readPlain(file: string): string | undefined {
  let fd: number | undefined;
  try {
    const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
    fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_WORKER_SCRIPT_BYTES) return undefined;
    return fs.readFileSync(fd, 'utf8');
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** The files (`<stateDir>\0<hash>`) that this process stored or found current already. */
const stored = new Set<string>();

/**
 * Worker side: stores `script` (the worker's own) under its hash, unless the file is there with that content already
 * (checked once per process); written atomically (a temporary file of its own, then a rename), 0600. Returns the hash.
 * Throws when it cannot store it.
 */
export function storeWorkerScript(stateDir: string, script: string): string {
  const hash = bundleHash(script);
  const bytes = Buffer.byteLength(script, 'utf8');
  if (bytes > MAX_WORKER_SCRIPT_BYTES) throw new Error(`The worker script is too long (${bytes} bytes).`);
  const file = workerScriptPath(stateDir, hash);
  const key = `${stateDir}\0${hash}`;
  try {
    const stat = fs.lstatSync(file);
    if (stat.isFile() && stat.size === bytes && (stored.has(key) || readPlain(file) === script)) {
      stored.add(key);
      return hash;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  scriptFolder(stateDir);
  // A name of its own (two workers of other containers may have the same process ID).
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const { O_WRONLY, O_CREAT, O_TRUNC, O_NOFOLLOW } = fs.constants;
    const fd = fs.openSync(temporary, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0o600);
    try {
      fs.writeFileSync(fd, script, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  stored.add(key);
  return hash;
}

/**
 * Monitor side: the worker script with the hash `hash` from the volume folder `stateDir`: a plain file of at most
 * MAX_WORKER_SCRIPT_BYTES whose sha256 is `hash`; else why not (one sentence). Never throws.
 */
export function readWorkerScript(stateDir: string, hash: string): { script: string } | { reason: string } {
  if (!isWorkerScriptHash(hash)) return { reason: 'the hash of its worker script is invalid' };
  const script = readPlain(workerScriptPath(stateDir, hash));
  if (script === undefined) return { reason: `the worker script ${hash.slice(0, 12)} is not in the volume (the next open stores it)` };
  if (bundleHash(script) !== hash) return { reason: `the worker script ${hash.slice(0, 12)} in the volume does not match its hash (the next open stores it again)` };
  return { script };
}

/**
 * Monitor side: removes the worker scripts of other hashes than `keep` whose files are older than
 * WORKER_SCRIPT_MAX_AGE_MS (another version of the extension stores its own again at its next ensure), and leftover
 * temporary files of a store older than that. Only plain files of those names, never a link; every failure is ignored.
 * Returns the names it removed.
 */
export function removeOtherWorkerScripts(stateDir: string, keep: string, now: number): string[] {
  const folder = path.posix.join(stateDir, WORKER_SCRIPT_FOLDER);
  const removed: string[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(folder);
  } catch {
    return removed;
  }
  for (const name of names) {
    const script = SCRIPT_NAME.exec(name);
    if (script === null ? !TEMPORARY_NAME.test(name) : script[1] === keep) continue;
    const file = path.posix.join(folder, name);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || now - stat.mtimeMs <= WORKER_SCRIPT_MAX_AGE_MS) continue;
      fs.unlinkSync(file);
      removed.push(name);
    } catch {
      // Removed meanwhile, or not ours to remove.
    }
  }
  return removed;
}
