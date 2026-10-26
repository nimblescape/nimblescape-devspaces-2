// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The programs that a test VS Code left running after it quit (Linux only, from /proc). The configurations of
// .vscode-test.mjs give the test VS Code the environment variable DEVSPACE_TEST_USER_DATA_DIR, and the run `stopped`
// gives it to its second VS Code (test/vscode/attach/stopped.test.ts); every program that they start, and every program
// that those start, inherits it (the extension and the Dev Containers extension pass the environment of the extension
// host on), and no other program of a CI job has it. VS Code does not end the programs of its extension host when it
// quits.
// Seen in CI (PR #22): after each attach run, only programs of the Dev Containers extension stay: `docker exec` into
// the container of the window (the VS Code server, and scripts that watch the machine settings and the installed
// extensions for up to 60 seconds) and, for a Docker engine over SSH, the `ssh … docker system dial-stdio` that those
// start. The extension itself runs no `docker exec` program (its exec calls use the Docker API), so these count as
// programs of Dev Containers; every other program counts as one of the extension (VS Code ends its own programs when it
// quits; none stayed in CI). A program of the extension that
// still runs WAIT_MS after the quit fails the check: `node scripts/leftoverPrograms.mjs` after the tests of the job
// "vscode", and scripts/run-attach-tests.mjs after each attach run, which counts only the programs that started during
// that run (the run `updated` follows the run `previous` of the last released version).
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const MARKER = 'DEVSPACE_TEST_USER_DATA_DIR=';
/** How long a program of the extension may still run after the quit (a `docker` call that was about to end). */
export const WAIT_MS = 10_000;
/** The longest part of a command line in the log (the watch scripts of Dev Containers are long). */
const MAX_COMMAND_CHARACTERS = 200;

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function argv(pid) {
  return (readText(`/proc/${pid}/cmdline`) ?? '').split('\0').filter(Boolean);
}

/** The seconds since the system started (the time base of `startSeconds`). */
export function uptimeSeconds() {
  return Number(readText('/proc/uptime')?.split(' ')[0] ?? 0);
}

let ticksPerSecond;
/** Clock ticks per second of /proc/<pid>/stat. */
function clockTicks() {
  if (ticksPerSecond === undefined) {
    try {
      ticksPerSecond = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()) || 100;
    } catch {
      ticksPerSecond = 100;
    }
  }
  return ticksPerSecond;
}

/** Options of the Docker CLI before its command that take a value in the next argument. */
const DOCKER_VALUE_OPTIONS = new Set(['-c', '--context', '--config', '-H', '--host', '-l', '--log-level', '--tlscacert', '--tlscert', '--tlskey']);

/** True for `docker exec …`, also with options of the Docker CLI before `exec` (`docker --context x exec …`). */
function isDockerExec(args) {
  if (path.basename(args[0] ?? '') !== 'docker') return false;
  for (let i = 1; i < args.length; i++) {
    if (!args[i].startsWith('-')) return args[i] === 'exec';
    if (DOCKER_VALUE_OPTIONS.has(args[i])) i++;
  }
  return false;
}

/**
 * The running programs with DEVSPACE_TEST_USER_DATA_DIR in their environment, except this process, each with `owner`
 * `Dev Containers` or `extension` and its start in seconds since the system started. Empty on other systems than Linux.
 * @returns {{ pid: number, ppid: number, startSeconds: number, ageSeconds: number, userDataDir: string, argv: string[], parentArgv: string[], owner: 'Dev Containers' | 'extension' }[]}
 */
export function leftoverPrograms() {
  if (process.platform !== 'linux') return [];
  const ticks = clockTicks();
  const uptime = uptimeSeconds();
  const found = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    const pid = Number(entry);
    const marker = readText(`/proc/${pid}/environ`)
      ?.split('\0')
      .find((variable) => variable.startsWith(MARKER));
    const stat = readText(`/proc/${pid}/stat`);
    if (marker === undefined || stat === undefined) continue;
    // The fields after the name in parentheses, which can hold spaces and parentheses: state, ppid, … starttime (22).
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    // A program that ended during the scan has no command line any more.
    const args = argv(pid);
    if (fields[0] === 'Z' || args.length === 0) continue;
    const ppid = Number(fields[1]);
    const startSeconds = Number(fields[19]) / ticks;
    found.push({
      pid,
      ppid,
      startSeconds,
      ageSeconds: Math.round(uptime - startSeconds),
      userDataDir: marker.slice(MARKER.length),
      argv: args,
      parentArgv: argv(ppid),
    });
  }
  const devContainers = new Set(found.filter((p) => isDockerExec(p.argv)).map((p) => p.pid));
  // The Docker CLI of a `docker exec` reaches an engine over SSH through `ssh … docker system dial-stdio`.
  for (const p of found) if (devContainers.has(p.ppid) && path.basename(p.argv[0] ?? '') === 'ssh') devContainers.add(p.pid);
  return found
    .map((p) => ({ ...p, owner: devContainers.has(p.pid) ? 'Dev Containers' : 'extension' }))
    .sort((a, b) => a.pid - b.pid);
}

function shortCommand(args) {
  const text = args.join(' ').replace(/\s+/g, ' ');
  return text.length > MAX_COMMAND_CHARACTERS ? `${text.slice(0, MAX_COMMAND_CHARACTERS)}…` : text;
}

/** Two lines per program; `since` as in reportLeftoverPrograms. */
export function describePrograms(programs, since = 0) {
  return programs.map(
    (p) =>
      `  [${p.owner}${p.owner === 'extension' && p.startSeconds < since ? ', earlier run' : ''}] pid ${p.pid}, ${p.ageSeconds} s old, user data folder ${path.basename(p.userDataDir)}: ${shortCommand(p.argv)}\n` +
      `    parent ${p.ppid}: ${shortCommand(p.parentArgv)}`,
  );
}

/**
 * Prints the programs that run right after the quit and waits up to `waitMs` for those of the extension to end. Only the
 * programs that started at `since` (seconds since the system started, see uptimeSeconds) or later count. Resolves the
 * programs of the extension that still run then (also printed).
 * @param {{ waitMs?: number, since?: number }} [options]
 */
export async function reportLeftoverPrograms({ waitMs = WAIT_MS, since = 0 } = {}) {
  if (process.platform !== 'linux') {
    console.log('The programs that stay after VS Code quits are only checked on Linux.');
    return [];
  }
  let programs = leftoverPrograms();
  if (programs.length === 0) {
    console.log('No program of the test VS Code runs after it quit.');
    return [];
  }
  console.log(`Programs of the test VS Code that run after it quit (${programs.length}):\n${describePrograms(programs, since).join('\n')}`);
  const own = () => programs.filter((p) => p.owner === 'extension' && p.startSeconds >= since);
  const deadline = Date.now() + waitMs;
  while (own().length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    programs = leftoverPrograms();
  }
  if (own().length === 0) {
    console.log(`No program of the extension${since > 0 ? ' that started during this run' : ''} runs.`);
    return [];
  }
  console.log(`Programs of the extension that still run ${waitMs / 1000} s after the quit (${own().length}):\n${describePrograms(own()).join('\n')}`);
  return own();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if ((await reportLeftoverPrograms()).length > 0) process.exitCode = 1;
}
