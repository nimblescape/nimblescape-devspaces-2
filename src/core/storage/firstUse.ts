// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Whether Devspaces was used with this global storage folder. Before the first use, the activation does no Docker work
// in the background: no restore of lost devspaces and no prebuild of the helper image (src/vscode/extension.ts).
import * as fs from 'fs';
import { errorMessage } from '../errors';
import { silentLogger, type Logger } from '../ports';
import { errorCode, retryTransient, type StoragePaths } from './paths';

/**
 * Whether Devspaces was used: registry.json exists, or the marker `used` exists. registry.json exists once a devspace
 * was recorded or restored, also after every devspace was deleted, and also when its content is not valid. While
 * registry.json exists, the marker is written (once; windows that start together may each try), so that a later loss
 * of registry.json still counts as a use. A file that cannot be checked for another reason than that it is missing
 * counts as a use. Never throws.
 */
export async function devspacesUsed(paths: Pick<StoragePaths, 'registry' | 'usedMarker'>, logger: Logger = silentLogger): Promise<boolean> {
  const registry = await present(paths.registry, logger);
  if (registry === true) await writeMarker(paths.usedMarker, logger);
  if (registry !== false) return true;
  return (await present(paths.usedMarker, logger)) !== false;
}

/** Whether `file` exists; 'unknown' when the check failed for another reason than a missing file (logged). */
async function present(file: string, logger: Logger): Promise<boolean | 'unknown'> {
  try {
    await retryTransient(() => fs.promises.stat(file));
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    logger.warn(`Whether Devspaces was used before could not be read (${file}): ${errorMessage(error)}. It counts as used.`);
    return 'unknown';
  }
}

/** Creates the empty marker file; one that exists already is kept. A failure is logged. */
async function writeMarker(file: string, logger: Logger): Promise<void> {
  try {
    await retryTransient(() => fs.promises.writeFile(file, '', { flag: 'wx' }));
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return;
    logger.warn(`The marker of the first use of Devspaces could not be written (${file}): ${errorMessage(error)}`);
  }
}
