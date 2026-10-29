// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Docker CLI of Devspaces (docs/architecture.md "The Docker CLI of Devspaces"): the window of a devspace on another
// computer runs the Dev Containers extension with this one tested version of the Docker CLI, which needs no
// installation. It is the static build of Docker Inc. from download.docker.com, whose version, size and SHA-256 for each
// platform are pinned in dockerCliPin.json (written by scripts/docker-cli-pin.mjs: Docker publishes no checksums for
// these files). The download is checked against the pin before anything is taken out of it, and only the `docker`
// program is kept: `<global storage>/docker-cli/<version>/docker[.exe]`. A new version comes only with a new version of
// Devspaces; the folders of older versions are removed. Windows on Arm runs the x86_64 build (Docker publishes no other).
// No `vscode`.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Logger } from '../ports';
import { extractTarGzEntry, extractZipEntry } from './archive';
import pin from './dockerCliPin.json';
import { downloadFile, type HttpGet } from './dockerDownload';

/** The only host of the Docker CLI of Devspaces. */
export const DOCKER_CLI_DOWNLOAD_HOST = 'download.docker.com';
/** The pinned version of the Docker CLI of Devspaces. */
export const OWN_DOCKER_CLI_VERSION: string = pin.version;
/** The largest program that is taken out of an archive (the CLI 29.9.2 has 42 to 45 MB). */
const MAX_CLI_SIZE = 200 * 1024 * 1024;
/** A part of an earlier download (a window that was closed during it) that is older than this is removed. */
const STALE_PART_MS = 60 * 60_000;
/** A download that receives no bytes for this long stops (also before the answer of the server). */
const STALLED_AFTER_MS = 30_000;
const PART_NAME = /^(archive-[0-9a-f]{8}\.(zip|tgz)(\.download)?|docker-[0-9a-f]{8}\.part)$/;

/** One file of the pin: its URL on download.docker.com, its size in bytes, and its SHA-256 (hex). */
export interface PinnedFile {
  url: string;
  size: number;
  sha256: string;
}

/** The pin of the Docker CLI: the version and the file of each platform key (dockerCliPlatformKey). */
export interface DockerCliPin {
  version: string;
  files: Record<string, PinnedFile>;
}

/** The file of the platform, the type of its archive, and the path of the program in it. */
export interface DockerCliDownload extends PinnedFile {
  version: string;
  kind: 'zip' | 'tgz';
  entry: string;
}

/**
 * The key of the platform in the pin (`windows-x86_64`, `mac-aarch64`, …), or undefined where Docker publishes no
 * static build that runs. Windows on Arm gets the x86_64 build, which Windows 11 runs in emulation.
 */
export function dockerCliPlatformKey(platform: NodeJS.Platform, arch: string): string | undefined {
  const cpu = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : undefined;
  if (platform === 'win32') return arch === 'x64' || arch === 'arm64' ? 'windows-x86_64' : undefined;
  if (cpu === undefined) return undefined;
  if (platform === 'darwin') return `mac-${cpu}`;
  if (platform === 'linux') return `linux-${cpu}`;
  return undefined;
}

/** The download of the Docker CLI for the platform from `current` (the pin by default), or undefined (none). */
export function ownDockerCliDownload(platform: NodeJS.Platform, arch: string, current: DockerCliPin = pin): DockerCliDownload | undefined {
  const key = dockerCliPlatformKey(platform, arch);
  const file = key === undefined ? undefined : current.files[key];
  if (file === undefined) return undefined;
  const zip = platform === 'win32';
  return { ...file, version: current.version, kind: zip ? 'zip' : 'tgz', entry: zip ? 'docker/docker.exe' : 'docker/docker' };
}

/** `<folder>/<version>/docker[.exe]`: the place of the Docker CLI of Devspaces in its folder (StoragePaths.dockerCliDir). */
export function ownDockerCliPath(folder: string, platform: NodeJS.Platform, version: string = OWN_DOCKER_CLI_VERSION): string {
  return path.join(folder, version, platform === 'win32' ? 'docker.exe' : 'docker');
}

/** The Docker CLI of Devspaces when it was installed (installOwnDockerCli), else undefined. */
export function presentOwnDockerCli(folder: string, platform: NodeJS.Platform, arch: string): string | undefined {
  if (ownDockerCliDownload(platform, arch) === undefined) return undefined;
  const file = ownDockerCliPath(folder, platform);
  try {
    return fs.lstatSync(file).isFile() ? file : undefined;
  } catch {
    return undefined;
  }
}

export interface InstallOwnDockerCliOptions {
  /** The folder of the Docker CLI of Devspaces (StoragePaths.dockerCliDir). */
  folder: string;
  platform: NodeJS.Platform;
  arch: string;
  logger: Logger;
  signal?: AbortSignal;
  /** Called while bytes arrive; `total` from Content-Length, when known. */
  onProgress?: (received: number, total: number | undefined) => void;
  /** For tests. Default: 30 seconds without a byte stop the download. */
  stalledAfterMs?: number;
  /** For tests. Default: the pin of this version. */
  pin?: DockerCliPin;
  /** For tests. Default: nodeHttpsGet. */
  get?: HttpGet;
}

/** The installs that run in this extension host, by the path of the program. */
const installing = new Map<string, Promise<string>>();

/**
 * The Docker CLI of Devspaces: its path when it is installed, else after a download from download.docker.com that has
 * the pinned size and SHA-256, out of which only the program is kept. The calls of this extension host at the same time
 * share one download; another window may download the same file meanwhile (the last rename wins, with the same
 * content). Throws where Docker publishes no build for the platform, when the download or its check fails, when no byte
 * came for 30 seconds, and with an AbortError when the signal aborts.
 */
export function installOwnDockerCli(options: InstallOwnDockerCliOptions): Promise<string> {
  const current = options.pin ?? pin;
  const target = ownDockerCliPath(options.folder, options.platform, current.version);
  const running = installing.get(target);
  if (running !== undefined) return running;
  const install = installNow(options, current, target).finally(() => installing.delete(target));
  installing.set(target, install);
  return install;
}

async function installNow(options: InstallOwnDockerCliOptions, current: DockerCliPin, target: string): Promise<string> {
  const { folder, platform, arch, logger } = options;
  const download = ownDockerCliDownload(platform, arch, current);
  if (download === undefined) throw new Error(`Docker publishes no Docker CLI for ${platform} on ${arch}.`);
  if (await isFile(target)) return target;
  const versionFolder = path.dirname(target);
  await fs.promises.mkdir(versionFolder, { recursive: true });
  await removeOtherVersions(folder, current.version, logger);
  await removeStaleParts(versionFolder);
  const id = crypto.randomBytes(4).toString('hex');
  const archive = path.join(versionFolder, `archive-${id}.${download.kind}`);
  const part = path.join(versionFolder, `docker-${id}.part`);
  const stalledAfterMs = options.stalledAfterMs ?? STALLED_AFTER_MS;
  const stall = new AbortController();
  let stallTimer: NodeJS.Timeout | undefined;
  const watch = (): void => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => stall.abort(), stalledAfterMs);
  };
  try {
    logger.info(`The Docker CLI ${download.version} of Devspaces is downloaded from ${download.url}.`);
    watch();
    try {
      await downloadFile({
        url: download.url,
        target: archive,
        host: DOCKER_CLI_DOWNLOAD_HOST,
        expected: { size: download.size, sha256: download.sha256 },
        // The pinned URL is the file itself.
        maxRedirects: 0,
        signal: options.signal === undefined ? stall.signal : AbortSignal.any([options.signal, stall.signal]),
        onProgress: (received, total) => {
          watch();
          options.onProgress?.(received, total);
        },
        get: options.get,
      });
    } catch (error) {
      if (stall.signal.aborted && options.signal?.aborted !== true) {
        throw new Error(`The download of ${download.url} received no bytes for ${Math.round(stalledAfterMs / 1000)} seconds.`);
      }
      throw error;
    } finally {
      clearTimeout(stallTimer);
    }
    if (download.kind === 'zip') await extractZipEntry(archive, download.entry, part, MAX_CLI_SIZE);
    else await extractTarGzEntry(archive, download.entry, part, MAX_CLI_SIZE);
    await fs.promises.chmod(part, 0o755);
    try {
      await fs.promises.rename(part, target);
    } catch (error) {
      // Windows: another window installed it meanwhile, and runs it.
      if (!(await isFile(target))) throw error;
    }
    logger.info(`The Docker CLI ${download.version} of Devspaces is installed: ${target}`);
    return target;
  } finally {
    await fs.promises.rm(archive, { force: true }).catch(() => undefined);
    await fs.promises.rm(part, { force: true }).catch(() => undefined);
  }
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await fs.promises.lstat(file)).isFile();
  } catch {
    return false;
  }
}

/** The order of two versions x.y.z: negative when `a` is older. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/**
 * Removes the folders of older versions (a link is removed, never what it points to). A newer version stays: an older
 * version of Devspaces in a window that was not reloaded after an update must not remove the program of the newer one.
 */
async function removeOtherVersions(folder: string, version: string, logger: Logger): Promise<void> {
  let names: string[];
  try {
    names = await fs.promises.readdir(folder);
  } catch {
    return;
  }
  for (const name of names) {
    if (!/^\d+\.\d+\.\d+$/.test(name) || compareVersions(name, version) >= 0) continue;
    try {
      await fs.promises.rm(path.join(folder, name), { recursive: true, force: true });
      logger.info(`The Docker CLI ${name} of Devspaces was removed.`);
    } catch (error) {
      // A program of a window that still runs it (Windows); the next install tries again.
      logger.warn(`The Docker CLI ${name} of Devspaces could not be removed: ${(error as Error).message}`);
    }
  }
}

/** Removes the parts of earlier downloads that are older than STALE_PART_MS. */
async function removeStaleParts(versionFolder: string): Promise<void> {
  let names: string[];
  try {
    names = await fs.promises.readdir(versionFolder);
  } catch {
    return;
  }
  for (const name of names) {
    if (!PART_NAME.test(name)) continue;
    const file = path.join(versionFolder, name);
    try {
      const stat = await fs.promises.lstat(file);
      if (stat.isFile() && Date.now() - stat.mtimeMs > STALE_PART_MS) await fs.promises.rm(file, { force: true });
    } catch {
      // Removed by another window meanwhile.
    }
  }
}
