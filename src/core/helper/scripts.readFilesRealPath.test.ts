// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Tests of readInRepository (READ_FILES_SCRIPT) for wrong variants of it (mutants) that scripts.test.ts,
// scripts.readFiles.test.ts, and scripts.readFilesChecks.test.ts do not catch: the real path of the opened descriptor,
// its stat, the fallback without /proc/self/fd, open errors, closed descriptors, and O_NOCTTY.

import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { readFilesCommand } from './scripts';

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const has = (command: string, args: string[]): boolean => !spawnSync(command, args, { stdio: 'ignore', timeout: 10_000 }).error;
const isRoot = process.getuid?.() === 0;
const isLinux = process.platform === 'linux';

/** Runs the command of readFilesCommand. `preload`: a module that node loads first (-r); `prefix`: a command that runs node. */
function runScript(command: string[], options: { preload?: string; env?: NodeJS.ProcessEnv; prefix?: string[] } = {}): { status: number | null; stdout: string; stderr: string } {
  expect(command[0]).toBe('node');
  const args = [...(options.preload !== undefined ? ['-r', options.preload] : []), ...command.slice(1)];
  const [file, ...rest] = [...(options.prefix ?? []), process.execPath, ...args];
  const result = spawnSync(file, rest, { encoding: 'utf8', timeout: 10_000, env: { ...process.env, ...options.env } });
  expect(result.error).toBeUndefined();
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A pseudo-terminal that a python3 process holds open: the path of its terminal side, and its close. */
async function pseudoTerminal(): Promise<{ path: string; close: () => void }> {
  const holder = spawn('python3', ['-c', 'import os, sys\nmaster, terminal = os.openpty()\nprint(os.ttyname(terminal), flush=True)\nsys.stdin.read()'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const close = (): void => {
    holder.stdin.end();
    holder.kill();
  };
  const line = await new Promise<string>((resolve, reject) => {
    let out = '';
    holder.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes('\n')) resolve(out.trim());
    });
    holder.on('error', reject);
    holder.on('exit', () => reject(new Error('python3 ended before it opened a pseudo-terminal')));
  }).catch((error: unknown) => {
    close();
    throw error;
  });
  return { path: line, close };
}

const BUILD_CONFIG = '{ "build": { "dockerfile": "Dockerfile" } }';
const REFUSED = 'The configuration file is not a file of the repository.';

/** A repository with `b/devcontainer.json` (BUILD_CONFIG) and `b/Dockerfile`, below a fresh folder `root`. */
function repository(): { root: string; repo: string } {
  const root = fs.realpathSync.native(tempDir());
  const repo = path.join(root, 'repo');
  write(path.join(repo, 'b', 'devcontainer.json'), BUILD_CONFIG);
  write(path.join(repo, 'b', 'Dockerfile'), 'FROM alpine\n');
  return { root, repo };
}

function preloadFile(root: string, text: string): string {
  const file = path.join(root, 'hook.js');
  fs.writeFileSync(file, text);
  return file;
}

const READ = { configText: BUILD_CONFIG, dockerfilePath: 'b/Dockerfile', dockerfileText: 'FROM alpine\n' };

describe('READ_FILES_SCRIPT: the real path of the opened descriptor', () => {
  // Mutant: realInRepository compares with the repository folder as given (rootReal = root), not with its real path.
  // The real path of a file of the repository is below the real folder, so every file of a repository folder that is
  // reached through a link would be refused.
  it('reads the files of a repository whose folder is reached through a link, and still refuses a link out of it', () => {
    const root = fs.realpathSync.native(tempDir());
    const real = path.join(root, 'real');
    write(path.join(real, 'b', 'devcontainer.json'), BUILD_CONFIG);
    write(path.join(real, 'b', 'Dockerfile'), 'FROM alpine\n');
    write(path.join(root, 'secret'), '{ "image": "LINKED_ROOT_SECRET" }');
    fs.mkdirSync(path.join(real, 'a'));
    fs.symlinkSync(path.join(root, 'secret'), path.join(real, 'a', 'devcontainer.json'));
    const repo = path.join(root, 'repo');
    fs.symlinkSync(real, repo, 'dir');
    const result = runScript(readFilesCommand(repo, 'b/devcontainer.json'));
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(READ);
    const out = runScript(readFilesCommand(repo, 'a/devcontainer.json'));
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain(REFUSED);
    expect(`${out.stdout}${out.stderr}`).not.toContain('LINKED_ROOT_SECRET');
  });

  // Mutants: statSync(real) -> lstatSync(real), and a failed stat of the real path throws, not null. A writer of
  // the repository changes the file between the real path of the descriptor and its stat: HOOK_MODE=link moves it to
  // `<name>.moved` and puts a link of the repository to it in its place (stat names the opened file: read; lstat names
  // the link: refused), HOOK_MODE=gone moves it away (refused, never a failure of the script).
  const STAT_HOOK = String.raw`'use strict';
const fs = require('fs');
const path = require('path');
const { HOOK_FILE, HOOK_MODE } = process.env;
let done = false;
const native = fs.realpathSync.native;
fs.realpathSync.native = function (file, ...rest) {
  const result = native.call(this, file, ...rest);
  if (!done && String(file).startsWith('/proc/self/fd/') && result === HOOK_FILE) {
    done = true;
    fs.renameSync(HOOK_FILE, HOOK_FILE + '.moved');
    if (HOOK_MODE === 'link') fs.symlinkSync(path.basename(HOOK_FILE) + '.moved', HOOK_FILE);
  }
  return result;
};
`;
  describe.each(['b/devcontainer.json', 'b/Dockerfile'])('a file of the repository changed between the real path of its descriptor and the stat: %s', (file) => {
    it.skipIf(!isLinux)('reads it when a link of the repository to the opened file takes its place', () => {
      const { root, repo } = repository();
      const env = { HOOK_FILE: path.join(repo, file), HOOK_MODE: 'link' };
      const result = runScript(readFilesCommand(repo, 'b/devcontainer.json'), { env, preload: preloadFile(root, STAT_HOOK) });
      // The hook ran.
      expect(fs.lstatSync(path.join(repo, file)).isSymbolicLink()).toBe(true);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(READ);
    });

    it.skipIf(!isLinux)('refuses it, without a failure of the script, when it is gone', () => {
      const { root, repo } = repository();
      const env = { HOOK_FILE: path.join(repo, file), HOOK_MODE: 'gone' };
      const result = runScript(readFilesCommand(repo, 'b/devcontainer.json'), { env, preload: preloadFile(root, STAT_HOOK) });
      expect(fs.existsSync(path.join(repo, `${file}.moved`))).toBe(true);
      expect(fs.existsSync(path.join(repo, file))).toBe(false);
      if (file === 'b/devcontainer.json') {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(REFUSED);
      } else {
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({ configText: BUILD_CONFIG, dockerfilePath: 'b/Dockerfile' });
      }
    });
  });

  // Mutants: the existsSync guard dropped (always /proc/self/fd/<fd>), and the fallback without /proc/self/fd refuses
  // every file. On Linux without /proc/self/fd (here: a preload that hides it) the real path of the file is unknown,
  // and the file is refused (a check of the real path of the file by its path is open to a race of a writer of the
  // repository); a link out stays refused.
  const NO_PROC_HOOK = String.raw`'use strict';
const fs = require('fs');
const existsSync = fs.existsSync;
fs.existsSync = function (file, ...rest) {
  return String(file) === '/proc/self/fd' ? false : existsSync.call(this, file, ...rest);
};
const native = fs.realpathSync.native;
fs.realpathSync.native = function (file, ...rest) {
  if (String(file).startsWith('/proc/self/fd')) {
    const error = new Error('ENOENT: no such file or directory, realpath ' + file);
    error.code = 'ENOENT';
    throw error;
  }
  return native.call(this, file, ...rest);
};
`;
  it.skipIf(process.platform !== 'linux')('without /proc/self/fd, refuses a file of the repository and a link out', () => {
    const { root, repo } = repository();
    const preload = preloadFile(root, NO_PROC_HOOK);
    const result = runScript(readFilesCommand(repo, 'b/devcontainer.json'), { preload });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(REFUSED);
    write(path.join(root, 'secret'), '{ "image": "NO_PROC_SECRET" }');
    fs.mkdirSync(path.join(repo, 'a'));
    fs.symlinkSync(path.join(root, 'secret'), path.join(repo, 'a', 'devcontainer.json'));
    const out = runScript(readFilesCommand(repo, 'a/devcontainer.json'), { preload });
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain(REFUSED);
    expect(`${out.stdout}${out.stderr}`).not.toContain('NO_PROC_SECRET');
  });

  // Mutant: an open error of no known kind (here EMFILE: the process has no free descriptor) taken for a file that is
  // not a file of the repository (null). It is no property of the file: the script fails with the error, so the step
  // reports it, and a Dockerfile of the repository is never taken for one that may not be read.
  const EMFILE_HOOK = String.raw`'use strict';
const fs = require('fs');
const { HOOK_FILE } = process.env;
const openSync = fs.openSync;
fs.openSync = function (file, ...rest) {
  if (file !== HOOK_FILE) return openSync.call(this, file, ...rest);
  const fillers = [];
  try {
    for (;;) fillers.push(openSync.call(fs, '/dev/null', 'r'));
  } catch (error) {
    if (error.code !== 'EMFILE') throw error;
  }
  try {
    return openSync.call(this, file, ...rest);
  } finally {
    for (const fd of fillers) fs.closeSync(fd);
  }
};
`;
  it.each(['b/devcontainer.json', 'b/Dockerfile'])('fails with an open error of no known kind (EMFILE) of %s', (file) => {
    const { root, repo } = repository();
    const env = { HOOK_FILE: path.join(repo, file) };
    const prefix = ['sh', '-c', 'ulimit -n 256 && exec "$0" "$@"'];
    const result = runScript(readFilesCommand(repo, 'b/devcontainer.json'), { env, preload: preloadFile(root, EMFILE_HOOK), prefix });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('EMFILE');
    expect(result.stderr).not.toContain(REFUSED);
    expect(result.stdout).toBe('');
  });

  // Mutant: the descriptor of readInRepository not closed. At the exit of the script, no descriptor of a file of the
  // repository is open: neither one that was read nor one that was refused after the open (a FIFO of the repository).
  const OPEN_FDS_HOOK = String.raw`'use strict';
const fs = require('fs');
const { HOOK_REPO, HOOK_OUT } = process.env;
process.on('exit', () => {
  const open = [];
  for (const name of fs.readdirSync('/proc/self/fd')) {
    try {
      const target = fs.readlinkSync('/proc/self/fd/' + name);
      if (target.startsWith(HOOK_REPO + '/')) open.push(target);
    } catch {
      // The descriptor of readdirSync.
    }
  }
  fs.writeFileSync(HOOK_OUT, JSON.stringify(open));
});
`;
  it.skipIf(!isLinux || !has('mkfifo', ['--version']))('closes the descriptor of each file that it opened', () => {
    const { root, repo } = repository();
    write(path.join(repo, 'c', 'devcontainer.json'), BUILD_CONFIG);
    expect(spawnSync('mkfifo', [path.join(repo, 'c', 'Dockerfile')], { timeout: 10_000 }).status).toBe(0);
    const preload = preloadFile(root, OPEN_FDS_HOOK);
    const out = path.join(root, 'open.json');
    const env = { HOOK_REPO: repo, HOOK_OUT: out };
    const read = runScript(readFilesCommand(repo, 'b/devcontainer.json'), { env, preload });
    expect(read.status, read.stderr).toBe(0);
    expect(JSON.parse(read.stdout)).toEqual(READ);
    expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toEqual([]);
    fs.rmSync(out);
    const fifo = runScript(readFilesCommand(repo, 'c/devcontainer.json'), { env, preload });
    expect(fifo.status, fifo.stderr).toBe(0);
    expect(JSON.parse(fifo.stdout)).toEqual({ configText: BUILD_CONFIG, dockerfilePath: 'c/Dockerfile' });
    expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toEqual([]);
  });

  // Mutant: the open of readInRepository without O_NOCTTY. A terminal device of the repository (a root process of a
  // dev container may create one: Docker gives it CAP_MKNOD) that a script without a controlling terminal opens becomes
  // its controlling terminal (a hangup of that terminal then ends the step). Refused either way (no plain file); the
  // probe reads the controlling terminal of the script right after the open (field tty_nr of /proc/self/stat). A pseudo
  // terminal slave of mknod out of devpts cannot be opened (EIO), and the device cgroup of a default Docker container
  // denies a virtual console: the probe takes tty1 (4, 1) and runs only where its open makes it the controlling
  // terminal (root, no device cgroup, a kernel with virtual consoles). The script runs as the leader of a new session
  // (setsid -w).
  const CTTY_HOOK = String.raw`'use strict';
const fs = require('fs');
const { HOOK_FILE, HOOK_OUT } = process.env;
const openSync = fs.openSync;
fs.openSync = function (file, ...rest) {
  const fd = openSync.call(this, file, ...rest);
  if (file === HOOK_FILE) {
    const stat = fs.readFileSync('/proc/self/stat', 'utf8');
    fs.appendFileSync(HOOK_OUT, stat.slice(stat.lastIndexOf(')') + 2).split(' ')[4] + '\n');
  }
  return fd;
};
`;
  it.skipIf(!isRoot || !isLinux || !has('setsid', ['--version']) || !has('unshare', ['--version']) || !has('python3', ['--version']))('never takes a terminal device of the repository for its controlling terminal', async (context) => {
    const { root, repo } = repository();
    fs.mkdirSync(path.join(repo, 'a'));
    // The terminal device: the terminal side of a pseudo-terminal, which every Linux has (a virtual console such as
    // /dev/tty1 is missing on many machines, CI runners too). python3 opens the pair with os.openpty, which unlocks
    // the terminal side, and holds it open until the test ends; Node has no call for that. A bind mount in a mount
    // namespace of the script puts the terminal at the files of the repository: a node of mknod would name the
    // terminal of another devpts instance in a container.
    const terminal = await pseudoTerminal();
    context.onTestFinished(terminal.close);
    const files = ['a/devcontainer.json', 'b/Dockerfile'].map((file) => path.join(repo, file));
    for (const file of files) fs.writeFileSync(file, '');
    // Where the mounts are refused, the script does not run and the probe below skips the test.
    const prefix = ['unshare', '-m', 'sh', '-c', 'mount --bind "$1" "$2" && mount --bind "$1" "$3" && shift 3 && exec setsid -w "$@"', 'sh', terminal.path, ...files];
    // Whether the setup holds here: an open without O_NOCTTY makes the terminal the controlling terminal of the script.
    const probe = runScript(['node', '-e', "const fs = require('fs'); try { fs.openSync(process.argv[1], fs.constants.O_RDONLY | fs.constants.O_NONBLOCK); } catch { process.exit(); } const stat = fs.readFileSync('/proc/self/stat', 'utf8'); process.stdout.write(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[4]);", path.join(repo, 'b', 'Dockerfile')], { prefix });
    if (probe.stdout === '' || probe.stdout === '0') context.skip();
    const out = path.join(root, 'tty.txt');
    for (const [file, config] of [['a/devcontainer.json', 'a/devcontainer.json'], ['b/Dockerfile', 'b/devcontainer.json']]) {
      fs.rmSync(out, { force: true });
      const result = runScript(readFilesCommand(repo, config), { env: { HOOK_FILE: path.join(repo, file), HOOK_OUT: out }, preload: preloadFile(root, CTTY_HOOK), prefix });
      if (config === 'a/devcontainer.json') {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(REFUSED);
      } else {
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({ configText: BUILD_CONFIG, dockerfilePath: 'b/Dockerfile' });
      }
      expect(fs.readFileSync(out, 'utf8'), file).toBe('0\n');
    }
  });
});
