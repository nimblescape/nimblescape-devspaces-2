// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Shared parts of the two runs of the update from the last released version (previous.test.ts, updated.test.ts): the
// installed extension that VS Code loads, the registry entry of the devspace in the user data folder, the Monitor
// container, and the Docker objects of the devspace. Each reads only Docker and files, never a log line, so that the run
// `previous` can use them with a released version too.
import * as assert from 'assert';
import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { LABEL_DEVSPACE_ID } from '../../../src/core/names';
import { LABEL_MONITOR, REMOTE_MONITOR_CONTAINER } from '../../../src/core/remoteMonitor/protocol';
import { EXTENSION_ID, docker } from './support';

/** What the run `previous` saved for the run `updated`, next to the bundles of the tests. */
export const PREVIOUS_STATE_FILE = path.join(__dirname, 'previous-state.json');
/** The version and the SHA-256 of dist/extension.js of the VSIX of this checkout (scripts/install-attach-extensions.mjs). */
export const PACKAGED_FILE = path.join(__dirname, 'vsix', 'packaged.json');

export interface InstalledExtension {
  /** The folder of the extension in the extensions folder of the test VS Code. */
  path: string;
  version: string;
  /** The SHA-256 of its dist/extension.js. */
  extensionSha256: string;
  /** How VS Code installed it (`gallery` or `vsix`), from extensions.json of the extensions folder; for the log only. */
  source: string | undefined;
}

export function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** The extension that VS Code runs, active and loaded from the extensions folder (not from a development folder). */
export function installedExtension(): InstalledExtension {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension?.isActive, `${EXTENSION_ID} is not active`);
  const extensionsDir = path.dirname(extension.extensionPath);
  assert.strictEqual(path.basename(extensionsDir), 'extensions', `VS Code does not load ${EXTENSION_ID} from its extensions folder: ${extension.extensionPath}`);
  let source: string | undefined;
  try {
    const list = JSON.parse(fs.readFileSync(path.join(extensionsDir, 'extensions.json'), 'utf8')) as { relativeLocation?: string; metadata?: { source?: string } }[];
    source = list.find((item) => item.relativeLocation === path.basename(extension.extensionPath))?.metadata?.source;
  } catch {
    // Only for the log.
  }
  const { version } = extension.packageJSON as { version: string };
  return { path: extension.extensionPath, version, extensionSha256: sha256File(path.join(extension.extensionPath, 'dist', 'extension.js')), source };
}

/** The folders of the extension in the extensions folder of the test VS Code, for the log. */
export function extensionFolders(installed: InstalledExtension): string[] {
  return fs.readdirSync(path.dirname(installed.path)).filter((name) => name.toLowerCase().startsWith(`${EXTENSION_ID}-`));
}

export interface RegistryState {
  /** The format version of registry.json. */
  version: unknown;
  /** The number of devspaces in it. */
  count: number;
  /** The entry of the devspace, or undefined. */
  entry: Record<string, unknown> | undefined;
}

/** registry.json of the extension in the user data folder of the test VS Code, with the entry of `devspaceId`. */
export function registryOf(devspaceId: string): RegistryState {
  const userDataDir = process.env.DEVSPACE_TEST_USER_DATA_DIR;
  assert.ok(userDataDir, 'DEVSPACE_TEST_USER_DATA_DIR is not set (.vscode-test.mjs)');
  const file = path.join(userDataDir, 'User', 'globalStorage', EXTENSION_ID, 'registry.json');
  assert.ok(fs.existsSync(file), `${file} does not exist`);
  const registry = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown; devspaces?: Record<string, unknown>[] };
  const devspaces = registry.devspaces ?? [];
  return { version: registry.version, count: devspaces.length, entry: devspaces.find((devspace) => devspace.id === devspaceId) };
}

export interface MonitorState {
  id: string;
  status: string;
  /** The label nimblescape.devspaces.monitor: the hash of its script, its helper tag and its mode. */
  label: string;
}

/** The Monitor container of the engine, or undefined when there is none. */
export function monitorState(): MonitorState | undefined {
  const format = `{{.Id}} {{.State.Status}} {{index .Config.Labels "${LABEL_MONITOR}"}}`;
  const result = childProcess.spawnSync('docker', ['inspect', '--type', 'container', '-f', format, REMOTE_MONITOR_CONTAINER], { encoding: 'utf8' });
  if (result.status !== 0 && /No such/i.test(result.stderr)) return undefined;
  assert.strictEqual(result.status, 0, `docker inspect ${REMOTE_MONITOR_CONTAINER}: ${result.stderr}`);
  const [id, status, label] = result.stdout.trim().split(' ');
  return { id, status, label: label ?? '' };
}

export interface DevspaceObjects {
  /** The containers with the label of the devspace, without its worker containers (<name>-worker<n>). */
  containers: string[];
  volumes: string[];
  /** The images with the label of the devspace; for the log only (a new version can build its image again). */
  images: string[];
}

/** The Docker objects with the label nimblescape.devspaces.id of the devspace, by name. */
export function devspaceObjects(devspaceId: string): DevspaceObjects {
  const filter = `label=${LABEL_DEVSPACE_ID}=${devspaceId}`;
  const names = (args: string[]): string[] =>
    docker(args)
      .split('\n')
      .filter((line) => line !== '')
      .sort();
  return {
    containers: names(['ps', '-a', '--filter', filter, '--format', '{{.Names}}']).filter((name) => !/-worker\d+$/.test(name)),
    volumes: names(['volume', 'ls', '--filter', filter, '--format', '{{.Name}}']),
    images: names(['images', '--filter', filter, '--format', '{{.Repository}}:{{.Tag}}']),
  };
}

/** What the run `previous` saved for the run `updated`. */
export interface PreviousState {
  containerId: string;
  monitor: MonitorState;
  registry: RegistryState;
  objects: DevspaceObjects;
}
