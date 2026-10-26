// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// JSON files in the global storage folder. Every write is atomic: a temporary file in the same folder, then a rename.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The temporary file of an atomic write of `file`: `.<name>.<pid>.<8 hex>.tmp` in the same folder. Every atomic writer
 * of the global storage folder names its temporary file with it (writeJsonAtomic, the heartbeat of SessionCoordinator,
 * computerId.ts), so that the sweep of the storage folder (storageSweep.ts, R8, ATOMIC_TEMPORARY_FILE) removes one that
 * a killed write left behind.
 */
export function atomicTemporaryPath(file: string): string {
  return path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
}

/** Reads a JSON file. Returns `undefined` if the file does not exist or does not contain valid JSON. */
export async function readJson<T>(file: string): Promise<T | undefined> {
  let text: string;
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

export interface AtomicWriteOptions {
  /**
   * Runs after the temporary file is written, right before the rename (for example a last check of a lock). When it
   * throws, the temporary file is removed, `file` is not changed, and the error is thrown.
   */
  beforeRename?: () => Promise<void>;
}

export async function writeJsonAtomic(file: string, value: unknown, options: AtomicWriteOptions = {}): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temp = atomicTemporaryPath(file);
  try {
    await fs.promises.writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
    await options.beforeRename?.();
    await fs.promises.rename(temp, file);
  } catch (error) {
    await fs.promises.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/** Synchronous variant for `deactivate()`. */
export function writeJsonAtomicSync(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = atomicTemporaryPath(file);
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(temp, file);
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Ignore.
    }
    throw error;
  }
}

/** Removes a file. A missing file is not an error. */
export async function removeFile(file: string): Promise<void> {
  await fs.promises.rm(file, { force: true });
}

/** Synchronous variant for `deactivate()`. */
export function removeFileSync(file: string): void {
  fs.rmSync(file, { force: true });
}

/**
 * Full paths of the `*.json` files in a folder. Temporary files are not included. A missing folder (ENOENT, or ENOTDIR
 * as listNames of paths.ts) gives an empty list. Any other error (permissions, a disk error, a link loop) is thrown: a
 * folder that cannot be read is never "nothing there" (the other-window checks then count it as not known).
 */
export async function listJsonFiles(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw error;
  }
  return names.filter((name) => name.endsWith('.json') && !name.startsWith('.')).map((name) => path.join(dir, name));
}
