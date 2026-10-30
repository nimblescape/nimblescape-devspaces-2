// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Finding the Docker CLI and the process environment for Docker calls.
// The platform is a parameter, so that the Windows rules can be tested on every computer.
import * as fs from 'fs';
import * as path from 'path';

const WINDOWS_PROGRAM_FILES = 'C:\\Program Files';
const WINDOWS_DOCKER_FOLDER = 'Docker\\Docker';
/** The folder of a per-user installation of Docker Desktop in %LOCALAPPDATA%. */
const WINDOWS_PER_USER_DOCKER_FOLDER = 'Programs\\DockerDesktop';

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

function pathDelimiter(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':';
}

/** Value of an environment variable. On Windows, names are case-insensitive (`Path`, `ProgramFiles`). */
export function envValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return env[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === lower && env[key] !== undefined) return env[key];
  }
  return undefined;
}

/** Removes a variable in every spelling of its name (names are case-insensitive on Windows); `name` in upper case. */
export function deleteEnv(env: NodeJS.ProcessEnv, name: string): void {
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === name) delete env[key];
  }
}

/** A copy of `base` with the variable `name` (in upper case) set to `value`, without its other spellings (deleteEnv). */
export function withEnvValue(base: NodeJS.ProcessEnv, name: string, value: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  deleteEnv(env, name);
  env[name] = value;
  return env;
}

/**
 * Installation folders of Docker Desktop on Windows. First the folder of an installation for all users, for example
 * `C:\Program Files\Docker\Docker` (in `ProgramW6432` / `ProgramFiles` when set, then in the default folder). Then the
 * folder of a per-user installation, `%LOCALAPPDATA%\Programs\DockerDesktop`, which the installer of Docker Desktop
 * selects by default since version 4.83. Both folders have the same layout (`resources\bin\docker.exe`,
 * `Docker Desktop.exe`). The installer adds `resources\bin` to the PATH of the user, but a program that started before
 * the installation keeps its old PATH: VS Code until it restarts, and a browser that starts VS Code for a link.
 */
export function windowsDockerDesktopFolders(env: NodeJS.ProcessEnv = {}): string[] {
  const folders: string[] = [];
  const add = (root: string | undefined, name: string): void => {
    if (!root || !path.win32.isAbsolute(root)) return;
    const folder = path.win32.join(root, name);
    if (!folders.some((existing) => existing.toLowerCase() === folder.toLowerCase())) folders.push(folder);
  };
  for (const root of [envValue(env, 'ProgramW6432', 'win32'), envValue(env, 'ProgramFiles', 'win32'), WINDOWS_PROGRAM_FILES]) {
    add(root, WINDOWS_DOCKER_FOLDER);
  }
  add(envValue(env, 'LOCALAPPDATA', 'win32'), WINDOWS_PER_USER_DOCKER_FOLDER);
  return folders;
}

/**
 * Extra folders to search after PATH: /usr/local/bin, /opt/homebrew/bin, /Applications/Docker.app/Contents/Resources/bin, and with
 * HOME ~/.docker/bin and ~/Applications/Docker.app/Contents/Resources/bin (darwin),
 * C:\Program Files\Docker\Docker\resources\bin and with LOCALAPPDATA %LOCALAPPDATA%\Programs\DockerDesktop\resources\bin
 * (win32, see windowsDockerDesktopFolders). On Linux: /usr/local/bin and /usr/bin.
 * `env` is optional: on Windows, it gives the Program Files folder if it is not on drive C, and the folder LOCALAPPDATA.
 */
export function extraSearchFolders(platform: NodeJS.Platform, env?: NodeJS.ProcessEnv): string[] {
  switch (platform) {
    case 'darwin': {
      const folders = ['/usr/local/bin', '/opt/homebrew/bin', '/Applications/Docker.app/Contents/Resources/bin'];
      // Docker Desktop's per-user CLI setting ("User") puts the tools in ~/.docker/bin and leaves PATH to the user, and
      // Docker.app may be installed in ~/Applications (these installations are found too).
      const home = env?.HOME;
      if (home && path.posix.isAbsolute(home)) {
        folders.push(path.posix.join(home, '.docker', 'bin'), path.posix.join(home, 'Applications', 'Docker.app', 'Contents', 'Resources', 'bin'));
      }
      return folders;
    }
    case 'win32':
      return windowsDockerDesktopFolders(env).map((folder) => path.win32.join(folder, 'resources', 'bin'));
    default:
      // The extension host can have a short PATH on Linux too, for example when VS Code starts from a desktop entry.
      return ['/usr/local/bin', '/usr/bin'];
  }
}

/** Removes quotes around a PATH entry (possible on Windows) and surrounding white space. */
function cleanEntry(entry: string): string {
  const trimmed = entry.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1).trim();
  return trimmed;
}

/** Key for comparing folders: without trailing separators, case-insensitive on Windows. */
function folderKey(folder: string, platform: NodeJS.Platform): string {
  let value = cleanEntry(folder);
  const separators = platform === 'win32' ? /[\\/]+$/ : /\/+$/;
  const root = pathApi(platform).parse(value).root;
  if (value.length > root.length) value = value.replace(separators, '');
  return platform === 'win32' ? value.toLowerCase() : value;
}

/** Absolute folders of PATH, in order, followed by the extra folders, without duplicates. Relative entries are ignored. */
function searchFolders(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const api = pathApi(platform);
  const pathValue = envValue(env, 'PATH', platform) ?? '';
  const candidates = [...pathValue.split(pathDelimiter(platform)).map(cleanEntry), ...extraSearchFolders(platform, env)];
  const seen = new Set<string>();
  const folders: string[] = [];
  for (const folder of candidates) {
    // A relative entry (or an empty one, which means the current folder) could run a program of the opened folder.
    if (!folder || !api.isAbsolute(folder)) continue;
    const key = folderKey(folder, platform);
    if (seen.has(key)) continue;
    seen.add(key);
    folders.push(folder);
  }
  return folders;
}

/** True if the file exists, is a regular file (symbolic links are followed), and is executable. */
export function isExecutableFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds a program in PATH and then in the extra folders. On win32 the file name gets `.exe` (for example `docker.exe`).
 * An absolute `name` is only checked. Returns the full path, or `undefined`.
 */
export function findExecutable(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  exists: (file: string) => boolean = isExecutableFile,
): string | undefined {
  const api = pathApi(platform);
  const fileName = platform === 'win32' && !/\.exe$/i.test(name) ? `${name}.exe` : name;
  if (api.isAbsolute(fileName)) return exists(fileName) ? fileName : undefined;
  for (const folder of searchFolders(env, platform)) {
    const candidate = api.join(folder, fileName);
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/** Full path of the Docker CLI (`docker`, or `docker.exe` on win32), or `undefined` if Docker is not installed. */
export function findDockerCli(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  exists?: (file: string) => boolean,
): string | undefined {
  return findExecutable('docker', env, platform, exists);
}

/**
 * Process environment for Docker calls: PATH extended with the folder of the Docker CLI and the extra folders,
 * because the Docker CLI starts credential helpers (docker-credential-*) and CLI plugins through PATH.
 * Existing entries keep their order. The function is idempotent. On win32, the existing spelling of the key (`Path`) is kept.
 */
export function dockerProcessEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, dockerPath?: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env };
  let key = 'PATH';
  if (platform === 'win32') {
    const pathKeys = Object.keys(result).filter((name) => name.toLowerCase() === 'path');
    key = pathKeys.find((name) => result[name] !== undefined) ?? pathKeys[0] ?? 'Path';
    // Two spellings of the same variable would make the value that Windows uses unpredictable.
    for (const other of pathKeys) if (other !== key) delete result[other];
  }
  const current = result[key] ?? '';
  const delimiter = pathDelimiter(platform);
  const present = new Set(
    current
      .split(delimiter)
      .filter((entry) => entry.trim() !== '')
      .map((entry) => folderKey(entry, platform)),
  );
  const additions: string[] = [];
  const candidates = [dockerPath ? pathApi(platform).dirname(dockerPath) : undefined, ...extraSearchFolders(platform, env)];
  for (const folder of candidates) {
    if (!folder) continue;
    const folderId = folderKey(folder, platform);
    if (present.has(folderId)) continue;
    present.add(folderId);
    additions.push(folder);
  }
  if (additions.length > 0) {
    result[key] = current.trim() === '' ? additions.join(delimiter) : `${current}${delimiter}${additions.join(delimiter)}`;
  }
  return result;
}

/**
 * Windows: puts the folder of the Docker CLI at `dockerPath` at the end of PATH in `env` (under the spelling of the key
 * that `env` has, for example `Path`) when PATH does not contain that folder. Changes `env`; true when it changed it.
 * Nothing on other platforms, where VS Code takes PATH from the login shell when it starts.
 */
export function addDockerFolderToPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, dockerPath: string): boolean {
  if (platform !== 'win32') return false;
  const folder = path.win32.dirname(dockerPath);
  const key = Object.keys(env).find((name) => name.toLowerCase() === 'path' && env[name] !== undefined) ?? 'Path';
  const current = env[key] ?? '';
  const folderId = folderKey(folder, platform);
  if (current.split(';').some((entry) => entry.trim() !== '' && folderKey(entry, platform) === folderId)) return false;
  const kept = current.replace(/;+\s*$/, '');
  env[key] = kept.trim() === '' ? folder : `${kept};${folder}`;
  return true;
}

/**
 * Puts `folder` first in PATH of `env` (under the spelling of the key that `env` has on Windows, for example `Path`),
 * and removes its other entries, so that a program started with `env` finds the `docker` in it first. Changes `env`.
 */
export function putFolderFirstInPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, folder: string): void {
  const key = platform === 'win32' ? (Object.keys(env).find((name) => name.toLowerCase() === 'path' && env[name] !== undefined) ?? 'Path') : 'PATH';
  const delimiter = pathDelimiter(platform);
  const folderId = folderKey(folder, platform);
  const others = (env[key] ?? '').split(delimiter).filter((entry) => entry.trim() !== '' && folderKey(entry, platform) !== folderId);
  env[key] = [folder, ...others].join(delimiter);
}

// The words of a Docker command and the calls that only read, for the Docker CLI of the bootstrap.

/** Options of the Docker CLI before the command that take a value (`docker -H ssh://box info`). */
const GLOBAL_OPTIONS_WITH_VALUE = new Set(['-H', '--host', '-c', '--context', '--config', '-l', '--log-level', '--tlscacert', '--tlscert', '--tlskey']);

/** Docker commands that only read: `docker <command>`, or `docker <object> <command>`. */
const READ_ONLY_COMMANDS = new Set(['info', 'version', 'ps', 'images', 'inspect']);
const READ_ONLY_OBJECT_COMMANDS: Record<string, readonly string[]> = {
  container: ['inspect', 'ls', 'list', 'ps'],
  image: ['inspect', 'ls', 'list', 'history'],
  volume: ['inspect', 'ls', 'list'],
  network: ['inspect', 'ls', 'list'],
  context: ['inspect', 'ls', 'list', 'show'],
  system: ['info', 'df'],
};

/** The first two words after the global options of the Docker CLI (`docker -H ssh://box image inspect x` → image inspect). */
export function dockerCommandWords(args: readonly string[]): string[] {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) i += GLOBAL_OPTIONS_WITH_VALUE.has(args[i]) ? 2 : 1;
  return args.slice(i, i + 2);
}

/**
 * True for a Docker call that only reads (inspect, ls, ps, info, version…), which may run again without any effect.
 * Everything else (create, run, exec, start, stop, rm, build, pull, …) is never repeated.
 */
export function isReadOnlyDockerCall(args: readonly string[]): boolean {
  const [command, subcommand] = dockerCommandWords(args);
  // `docker --version` prints the version of the CLI.
  if (command === undefined) return args.length === 1 && args[0] === '--version';
  if (READ_ONLY_COMMANDS.has(command)) return true;
  return READ_ONLY_OBJECT_COMMANDS[command]?.includes(subcommand ?? '') ?? false;
}
