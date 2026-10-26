// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The remembered check results of the configurations (ConfigCheckEntry, src/core/pipeline/configCheck.ts), one file per
// devspace in the global storage folder of the extension: `checks/<devspace id>.json`, written atomically. Each
// file holds the entry and `code`, the hash of the worker's code that computed it (the bundle that the extension pipes
// into its workers): an entry of other code (an update of the extension) is not given out. An entry is checked
// (parseConfigCheckEntry: its shape and size) when it is stored and when it is read; a file that is larger than the
// limit, not a regular file, or not valid counts as none. The file of a devspace goes with its Delete (the request
// `record remove`), and the sweep removes the file of a devspace that the registry does not have (storageSweep.ts,
// R9). No `vscode`.
import * as fs from 'fs';
import * as path from 'path';
import { MAX_CONFIG_CHECK_CHARACTERS, parseConfigCheckEntry, type ConfigCheckEntry } from './configCheckEntry';
import { removeFile, writeJsonAtomic } from './atomicJson';
import { isStorageId } from './paths';

/** The folder of the files in the global storage folder. */
export const CONFIG_CHECKS_DIR_NAME = 'checks';
/** The largest file: the entry, the stamp and the indentation of writeJsonAtomic. */
const MAX_FILE_BYTES = 4 * MAX_CONFIG_CHECK_CHARACTERS;
const CODE = /^[0-9a-f]{64}$/;

/** The remembered check results of this computer. */
export class ConfigCheckStore {
  /**
   * `dir`: the folder (StoragePaths.configChecksDir). `code`: the hash of the worker's code of this extension
   * (bundleHash of the script that it pipes into its workers).
   */
  constructor(
    private readonly dir: string,
    private readonly code: () => Promise<string>,
  ) {}

  private file(devspaceId: string): string {
    if (!isStorageId(devspaceId)) throw new Error('The devspace ID is not valid for a file name.');
    return path.join(this.dir, `${devspaceId}.json`);
  }

  /** The entry of the devspace, when there is a valid one of the current code; else undefined. Never throws. */
  async get(devspaceId: string): Promise<ConfigCheckEntry | undefined> {
    try {
      const file = this.file(devspaceId);
      const stat = await fs.promises.lstat(file);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined;
      const value: unknown = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
      const { code, entry } = value as { code?: unknown; entry?: unknown };
      if (typeof code !== 'string' || !CODE.test(code) || code !== (await this.code())) return undefined;
      return parseConfigCheckEntry(entry);
    } catch {
      return undefined;
    }
  }

  /** Stores the entry of the devspace (one per devspace: it replaces the previous one). Throws for an invalid entry. */
  async set(devspaceId: string, entry: unknown): Promise<void> {
    const checked = parseConfigCheckEntry(entry);
    if (checked === undefined) throw new Error('The check result is not valid.');
    const code = await this.code();
    if (!CODE.test(code)) throw new Error('The code of the worker is not known.');
    await writeJsonAtomic(this.file(devspaceId), { code, entry: checked });
  }

  /** Removes the entry of the devspace (its Delete). A missing one is no error. */
  async remove(devspaceId: string): Promise<void> {
    await removeFile(this.file(devspaceId));
  }
}
