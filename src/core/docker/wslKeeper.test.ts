// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunOptions, RunResult } from '../ports';
import { WSL_DISTRIBUTION, WSL_HOST, wslCommandArgs } from './dockerHost';
import {
  KEEPER_LAUNCH_MS,
  KEEPER_LOCK,
  KEEPER_SCRIPT,
  MAX_START_ENTRY,
  START_ENTRY_KEY,
  WslKeeper,
  keeperWslgArgs,
  regAddArgs,
  regDeleteArgs,
  regQueryArgs,
  startEntryCommand,
  startEntryName,
  wslgPathOf,
  type WslKeeperDeps,
} from './wslKeeper';

const WSL = 'C:\\Windows\\System32\\wsl.exe';
const WSLG = 'C:\\Program Files\\WSL\\wslg.exe';
const REG = 'C:\\Windows\\System32\\reg.exe';
const ENV = { ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows' };
const NAME = startEntryName(WSL_DISTRIBUTION);
const result = (exitCode: number): RunResult => ({ exitCode, stdout: '', stderr: '', timedOut: false });
const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() });

/**
 * A keeper with fakes: `entry` is whether the start entry exists in the fake registry, `value` its command (default:
 * the command of this version).
 */
function keeper(over: Partial<WslKeeperDeps> & { permanent?: boolean; removed?: boolean; entry?: boolean; value?: string; wslg?: boolean; now?: () => number } = {}) {
  const runs: { file: string; args: readonly string[]; options?: RunOptions }[] = [];
  const launches: { file: string; args: readonly string[] }[] = [];
  const state = { entry: over.entry ?? false, value: over.value ?? startEntryCommand(WSLG, WSL_DISTRIBUTION) };
  const log = logger();
  const deps: WslKeeperDeps = {
    runner: {
      run: async (file, args, options) => {
        runs.push({ file, args, options });
        if (args[0] === 'query') {
          return state.entry ? { ...result(0), stdout: `\r\n${START_ENTRY_KEY.replace('HKCU', 'HKEY_CURRENT_USER')}\r\n    ${NAME}    REG_SZ    ${state.value}\r\n\r\n` } : result(1);
        }
        if (args[0] === 'add') Object.assign(state, { entry: true, value: args[args.indexOf('/d') + 1] });
        if (args[0] === 'delete') state.entry = false;
        return result(0);
      },
    },
    wslPath: () => WSL,
    env: ENV,
    launch: async (file, args) => {
      launches.push({ file, args });
    },
    monitorPermanent: async () => over.permanent ?? false,
    engineRemoved: async () => over.removed ?? false,
    logger: log,
    exists: (file) => file === WSLG && (over.wslg ?? true),
    ...over,
  };
  return { subject: new WslKeeper(deps), runs, launches, state, log };
}

describe('the keeper of the WSL distribution', () => {
  it('starts with wslg.exe (no console window): sh -c with the script as root, from the root folder', async () => {
    const { subject, launches, log } = keeper();
    subject.keep(WSL_HOST, WSL_DISTRIBUTION);
    await vi.waitFor(() => expect(launches).toHaveLength(1));
    expect(launches[0]).toEqual({ file: WSLG, args: ['-d', 'devspaces', '-u', 'root', '--cd', '/', '--shell-type', 'none', 'sh', '-c', KEEPER_SCRIPT] });
    expect(launches[0]?.args).toEqual(keeperWslgArgs(WSL_DISTRIBUTION));
    await vi.waitFor(() => expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Devspaces starts the keeper of the WSL distribution devspaces (wslg.exe)')));
  });

  it('starts with wsl.exe --exec without wslg.exe, and not at all without either', async () => {
    const plain = keeper({ wslg: false });
    plain.subject.keep(WSL_HOST, WSL_DISTRIBUTION);
    await vi.waitFor(() => expect(plain.launches).toEqual([{ file: WSL, args: wslCommandArgs(WSL_DISTRIBUTION, ['sh', '-c', KEEPER_SCRIPT]) }]));
    const none = keeper({ wslg: false, wslPath: () => undefined });
    none.subject.keep(WSL_HOST, WSL_DISTRIBUTION);
    await new Promise((resolve) => setImmediate(resolve));
    expect(none.launches).toEqual([]);
  });

  // Mutation: a keeper that starts at each use (each Docker connection) fails it.
  it('starts at most once a minute in a window, and not after dispose', async () => {
    let now = 1_000_000;
    const { subject, launches } = keeper({ now: () => now });
    subject.keep(WSL_HOST, WSL_DISTRIBUTION);
    subject.keep(WSL_HOST, WSL_DISTRIBUTION);
    now += KEEPER_LAUNCH_MS - 1;
    subject.keep(WSL_HOST, WSL_DISTRIBUTION);
    await new Promise((resolve) => setImmediate(resolve));
    expect(launches).toHaveLength(1);
    now += 1;
    subject.keep(WSL_HOST, WSL_DISTRIBUTION);
    await vi.waitFor(() => expect(launches).toHaveLength(2));
    now += KEEPER_LAUNCH_MS;
    subject.dispose();
    subject.keep(WSL_HOST, WSL_DISTRIBUTION);
    await new Promise((resolve) => setImmediate(resolve));
    expect(launches).toHaveLength(2);
  });

  it('logs a start that fails once while it stays the same', async () => {
    let now = 1_000_000;
    const { subject, log } = keeper({ now: () => now, launch: async () => Promise.reject(new Error('spawn EPERM')) });
    subject.keep(WSL_HOST, WSL_DISTRIBUTION);
    now += KEEPER_LAUNCH_MS;
    subject.keep(WSL_HOST, WSL_DISTRIBUTION);
    await vi.waitFor(() => expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('could not start, so WSL stops the distribution 15 seconds after VS Code closed: spawn EPERM')));
    await new Promise((resolve) => setImmediate(resolve));
    expect(log.warn.mock.calls.filter(([text]) => String(text).includes('could not start'))).toHaveLength(1);
  });
});

describe('the start entry of the WSL distribution', () => {
  it('is wslg.exe in quotes with the script in quotes, within the 260 characters of Windows', () => {
    const command = startEntryCommand(WSLG, WSL_DISTRIBUTION);
    expect(command).toBe(`"${WSLG}" -d devspaces -u root --cd / --shell-type none sh -c "${KEEPER_SCRIPT}"`);
    expect(command.length).toBeLessThanOrEqual(MAX_START_ENTRY);
    expect(wslgPathOf(ENV)).toBe(WSLG);
    expect(wslgPathOf({ PROGRAMFILES: 'D:\\Apps' })).toBe('D:\\Apps\\WSL\\wslg.exe');
    expect(START_ENTRY_KEY).toBe('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run');
    expect(NAME).toBe('nimblescape Devspaces WSL devspaces');
  });

  it('is added while the Monitor runs permanently, with reg.exe of System32', async () => {
    const { subject, runs, state, log } = keeper({ permanent: true });
    await subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    expect(runs.map((run) => [run.file, run.args])).toEqual([
      [REG, regQueryArgs(NAME)],
      [REG, regAddArgs(NAME, startEntryCommand(WSLG, WSL_DISTRIBUTION))],
    ]);
    expect(regAddArgs(NAME, 'x')).toEqual(['add', START_ENTRY_KEY, '/v', NAME, '/t', 'REG_SZ', '/d', 'x', '/f']);
    expect(state.entry).toBe(true);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('added the start entry "nimblescape Devspaces WSL devspaces"'));
    // Found or written once per window: no second read.
    await subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    expect(runs).toHaveLength(2);
  });

  it('is kept as it is when it exists (one read)', async () => {
    const { subject, runs } = keeper({ permanent: true, entry: true });
    await subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    expect(runs.map((run) => run.args[0])).toEqual(['query']);
  });

  // Mutation: an entry that is kept with another command (an older script, or wslg.exe in another folder) fails it.
  it('is replaced when it has another command', async () => {
    const { subject, runs, state } = keeper({ permanent: true, entry: true, value: '"D:\\Old\\wslg.exe" -d devspaces sh -c exit' });
    await subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    expect(runs.map((run) => run.args[0])).toEqual(['query', 'add']);
    expect(state.value).toBe(startEntryCommand(WSLG, WSL_DISTRIBUTION));
  });

  // Mutation: an entry that stays after the answer Stop When Idle, or after the removal of Devspaces from the engine,
  // fails it: WSL would start the distribution at each logon for nothing.
  it('is removed while the Monitor stops when idle, and after Devspaces was removed from the engine', async () => {
    for (const over of [{ permanent: false }, { permanent: true, removed: true }]) {
      const { subject, runs, state, log } = keeper({ ...over, entry: true });
      await subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
      expect(runs.map((run) => run.args)).toEqual([regQueryArgs(NAME), regDeleteArgs(NAME)]);
      expect(state.entry).toBe(false);
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('removed the start entry'));
    }
    // Nothing to remove: one read.
    const absent = keeper({ permanent: false });
    await absent.subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    expect(absent.runs.map((run) => run.args[0])).toEqual(['query']);
  });

  it('follows a change of the Monitor mode in the same window', async () => {
    let permanent = true;
    const { subject, state } = keeper({ monitorPermanent: async () => permanent });
    await subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    expect(state.entry).toBe(true);
    permanent = false;
    await subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    expect(state.entry).toBe(false);
  });

  it('is updated with the start of the keeper', async () => {
    const { subject, state } = keeper({ permanent: true });
    subject.keep(WSL_HOST, WSL_DISTRIBUTION);
    await vi.waitFor(() => expect(state.entry).toBe(true));
  });

  it('is not added without wslg.exe or when it would be too long (logged), and a failure of reg.exe is tried again', async () => {
    const noWslg = keeper({ permanent: true, wslg: false });
    await noWslg.subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    expect(noWslg.state.entry).toBe(false);
    expect(noWslg.log.warn).toHaveBeenCalledWith(expect.stringContaining(`There is no ${WSLG}`));
    const long = 'C:\\' + 'x'.repeat(100);
    const tooLong = keeper({ permanent: true, env: { ProgramFiles: long }, exists: () => true });
    await tooLong.subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    expect(tooLong.state.entry).toBe(false);
    expect(tooLong.log.warn).toHaveBeenCalledWith(expect.stringContaining(`longer than ${MAX_START_ENTRY} characters`));
    let fail = true;
    const failing = keeper({
      permanent: true,
      runner: { run: async (_file, args) => (args[0] === 'query' ? result(1) : result(fail ? 5 : 0)) },
    });
    await failing.subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    expect(failing.log.warn).toHaveBeenCalledWith('The start entry "nimblescape Devspaces WSL devspaces" could not be added: reg.exe add ended with exit code 5');
    fail = false;
    await failing.subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    expect(failing.log.info).toHaveBeenCalledWith(expect.stringContaining('added the start entry'));
  });

  it('removeStartEntry removes it whatever the Monitor mode', async () => {
    const { subject, state } = keeper({ permanent: true, entry: true });
    await subject.removeStartEntry(WSL_DISTRIBUTION);
    expect(state.entry).toBe(false);
  });
});

// The keeper script with the real `sh`, `flock`, `timeout` and `grep`, and with a `sleep` that returns at once and a
// `docker` that answers from a file of the test. The lock file is one of the test instead of KEEPER_LOCK.
describe.skipIf(process.platform === 'win32')('the keeper script', () => {
  let folder: string | undefined;
  afterEach(() => {
    if (folder !== undefined) fs.rmSync(folder, { recursive: true, force: true });
    folder = undefined;
  });

  /** Starts the script: `docker ps -q` prints the next line of `answers` (the last one stays); `none`: nothing. */
  function startScript(answers: readonly string[], options: { slowSleep?: boolean } = {}) {
    folder ??= fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-keeper-'));
    const dir = folder;
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(dir, 'answers'), answers.join('\n') + '\n');
    fs.writeFileSync(path.join(bin, 'sleep'), `#!/bin/sh\nexec /bin/sleep ${options.slowSleep ? '5' : '0.01'}\n`, { mode: 0o755 });
    fs.writeFileSync(
      path.join(bin, 'docker'),
      [
        '#!/bin/sh',
        `dir='${dir}'`,
        'echo "$*" >> "$dir/args"',
        'n=$(($(cat "$dir/calls" 2>/dev/null || echo 0) + 1)); echo "$n" > "$dir/calls"',
        'total=$(wc -l < "$dir/answers")',
        '[ "$n" -le "$total" ] || n=$total',
        'line=$(sed -n "${n}p" "$dir/answers")',
        '[ "$line" = none ] && exit 0',
        'printf "%s\\n" "$line"',
      ].join('\n'),
      { mode: 0o755 },
    );
    const script = KEEPER_SCRIPT.replace(KEEPER_LOCK, path.join(dir, 'lock'));
    const child = spawn('sh', ['-c', script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` }, stdio: 'ignore' });
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    const calls = () => Number(fs.readFileSync(path.join(dir, 'calls'), 'utf8').trim() || '0');
    return { child, exited, calls, args: () => fs.readFileSync(path.join(dir, 'args'), 'utf8') };
  }

  it('is one line without a double quote and without a backslash', () => {
    expect(KEEPER_SCRIPT).not.toMatch(/["\\\n\r]/);
  });

  it('ends after two checks in a row without a running container, and runs on while one runs', async () => {
    const { exited, calls, args } = startScript(['abc123', 'abc123', 'none']);
    expect(await exited).toBe(0);
    expect(calls()).toBe(4);
    expect(args()).toContain('ps -q');
  });

  it('starts the count again after a check that found a running container', async () => {
    const { exited, calls } = startScript(['none', 'abc123', 'none', 'none']);
    expect(await exited).toBe(0);
    expect(calls()).toBe(4);
  });

  // Mutation: a script without the lock lets every window start one more keeper.
  it('ends at once while another keeper holds the lock', async () => {
    const first = startScript(['abc123'], { slowSleep: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const second = startScript(['abc123']);
    expect(await second.exited).not.toBe(0);
    expect(fs.existsSync(path.join(folder as string, 'calls'))).toBe(false);
    first.child.kill();
    await first.exited;
  });
});
