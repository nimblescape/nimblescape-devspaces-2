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
  KEEPER_EARLY_END_MS,
  KEEPER_LAUNCH_MS,
  KEEPER_LOCK,
  KEEPER_LOCK_WAIT_SECONDS,
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
  startEntryValueOf,
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
 * the command of this version); `permanent` the answer of monitorPermanent (undefined: it cannot be read). Each launch
 * keeps `exit`, the end of that keeper (default exit code 0).
 */
function keeper(over: Partial<WslKeeperDeps> & { permanent?: boolean | 'unknown'; entry?: boolean; value?: string; wslg?: boolean; now?: () => number } = {}) {
  const runs: { file: string; args: readonly string[]; options?: RunOptions }[] = [];
  const launches: { file: string; args: readonly string[]; exit: (code?: number | null) => void }[] = [];
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
    launch: async (file, args, onExit) => {
      launches.push({ file, args, exit: (code = 0) => onExit(code) });
    },
    monitorPermanent: async () => (over.permanent === 'unknown' ? undefined : (over.permanent ?? false)),
    registered: async () => true,
    knows: async () => true,
    logger: log,
    exists: (file) => file === WSLG && (over.wslg ?? true),
    ...over,
  };
  return { subject: new WslKeeper(deps), runs, launches, state, log };
}

describe('the keeper of the WSL distribution', () => {
  it('starts with wslg.exe (no console window): sh -c with the script as root, from the root folder', async () => {
    const { subject, launches, log } = keeper();
    subject.keep(WSL_DISTRIBUTION);
    await vi.waitFor(() => expect(launches).toHaveLength(1));
    expect(launches[0]).toMatchObject({ file: WSLG, args: ['-d', 'devspaces', '-u', 'root', '--cd', '/', '--shell-type', 'none', 'sh', '-c', KEEPER_SCRIPT] });
    expect(launches[0]?.args).toEqual(keeperWslgArgs(WSL_DISTRIBUTION));
    await vi.waitFor(() => expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Devspaces starts the keeper of the WSL distribution devspaces (wslg.exe)')));
  });

  // Mutation: a keeper in a distribution of the user fails it: it would hold that distribution while any container of
  // the user runs there.
  it('starts only in the WSL distribution of Devspaces', async () => {
    const { subject, launches } = keeper();
    subject.keep('Ubuntu');
    await new Promise((resolve) => setImmediate(resolve));
    expect(launches).toEqual([]);
  });

  it('starts with wsl.exe --exec without wslg.exe, and not at all without either', async () => {
    const plain = keeper({ wslg: false });
    plain.subject.keep(WSL_DISTRIBUTION);
    await vi.waitFor(() => expect(plain.launches).toMatchObject([{ file: WSL, args: wslCommandArgs(WSL_DISTRIBUTION, ['sh', '-c', KEEPER_SCRIPT]) }]));
    const none = keeper({ wslg: false, wslPath: () => undefined });
    none.subject.keep(WSL_DISTRIBUTION);
    await new Promise((resolve) => setImmediate(resolve));
    expect(none.launches).toEqual([]);
  });

  // Mutation: a keeper that starts at each use (each Docker connection) fails it; so does one that starts while the one
  // of the window still runs or waits for the lock (a window would keep several waiting).
  it('starts at most once a minute in a window, only after its last one ended, and not after dispose', async () => {
    let now = 1_000_000;
    const { subject, launches } = keeper({ now: () => now });
    subject.keep(WSL_DISTRIBUTION);
    subject.keep(WSL_DISTRIBUTION);
    now += KEEPER_LAUNCH_MS;
    subject.keep(WSL_DISTRIBUTION);
    await new Promise((resolve) => setImmediate(resolve));
    expect(launches).toHaveLength(1);
    launches[0]?.exit();
    now -= 1;
    launches[0]?.exit();
    subject.keep(WSL_DISTRIBUTION);
    await new Promise((resolve) => setImmediate(resolve));
    expect(launches).toHaveLength(1);
    now += 1;
    subject.keep(WSL_DISTRIBUTION);
    await vi.waitFor(() => expect(launches).toHaveLength(2));
    launches[1]?.exit();
    now += KEEPER_LAUNCH_MS;
    subject.dispose();
    subject.keep(WSL_DISTRIBUTION);
    await new Promise((resolve) => setImmediate(resolve));
    expect(launches).toHaveLength(2);
  });

  it('logs a start that fails once while it stays the same', async () => {
    let now = 1_000_000;
    const { subject, log } = keeper({ now: () => now, launch: async () => Promise.reject(new Error('spawn EPERM')) });
    subject.keep(WSL_DISTRIBUTION);
    now += KEEPER_LAUNCH_MS;
    subject.keep(WSL_DISTRIBUTION);
    await vi.waitFor(() =>
      expect(log.warn).toHaveBeenCalledWith(
        'The keeper of the WSL distribution devspaces could not start: spawn EPERM. Without a keeper, WSL stops the distribution 15 seconds after VS Code closed, also while a container runs there.',
      ),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(log.warn.mock.calls.filter(([text]) => String(text).includes('could not start'))).toHaveLength(1);
  });

  // Mutation: a keeper whose end is not looked at fails it (a keeper that cannot hold the lock, or a wslg.exe that does
  // not wait, would end at once each minute without a word); so does a warning at each end, or one that is not logged
  // again after a keeper that ran.
  it('logs a keeper that ends at once, once while it stays so, and again after a keeper that ran', async () => {
    let now = 1_000_000;
    const { subject, launches, log } = keeper({ now: () => now });
    const endsAtOnce = () => log.warn.mock.calls.filter(([text]) => String(text).includes('ended at once'));
    const start = async (count: number) => {
      now += KEEPER_LAUNCH_MS;
      subject.keep(WSL_DISTRIBUTION);
      await vi.waitFor(() => expect(launches).toHaveLength(count));
    };
    await start(1);
    now += KEEPER_EARLY_END_MS - 1;
    launches[0]?.exit(1);
    expect(log.warn).toHaveBeenCalledWith(
      'The keeper of the WSL distribution devspaces ended at once (exit code 1). Without a keeper, WSL stops the distribution 15 seconds after VS Code closed, also while a container runs there.',
    );
    await start(2);
    launches[1]?.exit(1);
    expect(endsAtOnce()).toHaveLength(1);
    // A keeper that ran (two checks, or a wait for the lock) is no failure, also with exit code 1 after its wait.
    await start(3);
    now += KEEPER_EARLY_END_MS;
    launches[2]?.exit(1);
    expect(endsAtOnce()).toHaveLength(1);
    await start(4);
    launches[3]?.exit(null);
    expect(endsAtOnce()).toHaveLength(2);
    expect(log.warn).toHaveBeenLastCalledWith(expect.stringContaining('ended at once (exit code none)'));
  });

  // Mutation: a start log that is used up by a keep without a program fails it.
  it('logs the start of the first keeper that starts in the window, once', async () => {
    let now = 1_000_000;
    let wsl: string | undefined;
    const { subject, launches, log } = keeper({ now: () => now, wslg: false, wslPath: () => wsl });
    const starts = () => log.info.mock.calls.filter(([text]) => String(text).includes('Devspaces starts the keeper'));
    subject.keep(WSL_DISTRIBUTION);
    await new Promise((resolve) => setImmediate(resolve));
    expect(launches).toEqual([]);
    wsl = WSL;
    now += KEEPER_LAUNCH_MS;
    subject.keep(WSL_DISTRIBUTION);
    await vi.waitFor(() => expect(starts()).toHaveLength(1));
    expect(starts()[0]?.[0]).toContain('(wsl.exe)');
    launches[0]?.exit();
    now += KEEPER_LAUNCH_MS;
    subject.keep(WSL_DISTRIBUTION);
    await vi.waitFor(() => expect(launches).toHaveLength(2));
    expect(starts()).toHaveLength(1);
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
  });

  // Mutation: a state of the Monitor read before the registry fails it: an answer that another window records between
  // the two reads, after this window read the state, would be undone here.
  it('reads the registry first and the state of the Monitor after it', async () => {
    const order: string[] = [];
    const { subject } = keeper({
      runner: {
        run: async (_file, args) => {
          order.push(String(args[0]));
          return result(1);
        },
      },
      monitorPermanent: async () => {
        order.push('monitor');
        return false;
      },
    });
    await subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    expect(order).toEqual(['query', 'monitor']);
  });

  it('is kept as it is when it exists (one read)', async () => {
    const { subject, runs } = keeper({ permanent: true, entry: true });
    await subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    expect(runs.map((run) => run.args[0])).toEqual(['query']);
  });

  // Mutation: an entry that is kept with another command (an older script, wslg.exe in another folder, or the command
  // with more after it) fails it.
  it('is replaced when it has another command', async () => {
    const command = startEntryCommand(WSLG, WSL_DISTRIBUTION);
    for (const value of ['"D:\\Old\\wslg.exe" -d devspaces sh -c exit', `${command} --more`]) {
      const { subject, runs, state } = keeper({ permanent: true, entry: true, value });
      await subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
      expect(runs.map((run) => run.args[0])).toEqual(['query', 'add']);
      expect(state.value).toBe(command);
    }
    expect(startEntryValueOf(`\r\nHKEY_CURRENT_USER\\X\r\n    ${NAME}    REG_SZ    ${command}\r\n`, NAME)).toBe(command);
    expect(startEntryValueOf(`    other    REG_SZ    ${command}`, NAME)).toBeUndefined();
  });

  // Mutation: a failed read of the answer that counts as no answer fails it: a moment of a locked file at the start of
  // a window would remove the start entry of the user. So does a failed list of WSL that counts as a removed one.
  it('stays as it is while the answer about the Monitor cannot be read, or WSL does not tell whether it lists the distribution', async () => {
    for (const entry of [true, false]) {
      for (const over of [{ permanent: 'unknown' as const }, { permanent: true, registered: async () => undefined }]) {
        const { subject, runs, state } = keeper({ ...over, entry });
        await subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
        expect(runs.map((run) => run.args[0])).toEqual(['query']);
        expect(state.entry).toBe(entry);
      }
    }
  });

  // Mutation: an entry for a distribution that was removed by hand (`wsl --unregister devspaces`) fails it: WSL would
  // fail at each logon. Asked only when an entry is wanted.
  it('is removed, or not added, when WSL does not list the distribution', async () => {
    for (const entry of [true, false]) {
      const asked: string[] = [];
      const { subject, state } = keeper({ permanent: true, entry, registered: async (distribution) => (asked.push(distribution), false) });
      await subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
      expect(state.entry).toBe(false);
      expect(asked).toEqual([WSL_DISTRIBUTION]);
    }
    const asked: string[] = [];
    const notWanted = keeper({ permanent: false, entry: true, registered: async (distribution) => (asked.push(distribution), true) });
    await notWanted.subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    expect(asked).toEqual([]);
  });

  // Mutation: a warning when another window removed the entry between the read and the removal fails it.
  it('a removal that another window did first counts as done, without a warning; another failure names the output of reg.exe', async () => {
    // The first read finds the entry; the removal fails, and the read after it finds none.
    const calls: string[] = [];
    const raced = keeper({
      permanent: false,
      runner: {
        run: async (_file, args) => {
          calls.push(String(args[0]));
          return result(calls.length === 1 ? 0 : 1);
        },
      },
    });
    await raced.subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    expect(calls).toEqual(['query', 'delete', 'query']);
    expect(raced.log.warn).not.toHaveBeenCalled();
    const denied = keeper({
      permanent: false,
      runner: { run: async (_file, args) => (args[0] === 'query' ? result(0) : { ...result(1), stderr: 'ERROR: Access is denied.\r\n' }) },
    });
    await denied.subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    expect(denied.log.warn).toHaveBeenCalledWith('The start entry "nimblescape Devspaces WSL devspaces" could not be removed: reg.exe delete ended with exit code 1: ERROR: Access is denied.');
  });

  // Mutation: an entry that stays after the answer Stop When Idle, or after the removal of Devspaces from the engine
  // (its mark forgets the answer, so the Monitor does not run permanently), fails it: WSL would start the distribution
  // at each logon for nothing.
  it('is removed while the Monitor does not run permanently', async () => {
    const { subject, runs, state, log } = keeper({ permanent: false, entry: true });
    await subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    expect(runs.map((run) => run.args)).toEqual([regQueryArgs(NAME), regDeleteArgs(NAME)]);
    expect(state.entry).toBe(false);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('removed the start entry'));
    // Nothing to remove: one read.
    const absent = keeper({ permanent: false });
    await absent.subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    expect(absent.runs.map((run) => run.args[0])).toEqual(['query']);
  });

  // Mutation: a window that remembers the state that it wrote fails it: another window may have changed the entry.
  it('follows a change of the Monitor mode in the same window, and reads the registry each time', async () => {
    let permanent = true;
    const { subject, state } = keeper({ monitorPermanent: async () => permanent });
    await subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    expect(state.entry).toBe(true);
    permanent = false;
    await subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    expect(state.entry).toBe(false);
    // Another window (or the user) removed the entry while the Monitor runs permanently again: it is added again.
    permanent = true;
    await subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    state.entry = false;
    await subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    expect(state.entry).toBe(true);
  });

  // Mutation: an update per call fails it (an answer runs it twice: the change of the setting and the answer); so does
  // one that is skipped while another one already began (it may have read the state before the change).
  it('one update that waits and has not begun yet covers a second call', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const reads: string[] = [];
    const { subject } = keeper({
      runner: {
        run: async (_file, args) => {
          reads.push(String(args[0]));
          if (reads.length === 1) await gate;
          return result(1);
        },
      },
    });
    const first = subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    await vi.waitFor(() => expect(reads).toEqual(['query']));
    // The first began: a second one waits, and a third joins it.
    const second = subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    const third = subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    release();
    await Promise.all([first, second, third]);
    expect(reads).toEqual(['query', 'query']);
  });

  // Mutation: an update that clears the mark of the update after a removal when it begins fails it: a later call would
  // then add a third update.
  it('the update that waits after a removal covers a later call, also after the update before the removal began', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const reads: string[] = [];
    const { subject } = keeper({
      runner: {
        run: async (_file, args) => {
          reads.push(String(args[0]));
          if (reads.length === 1) await gate;
          return result(1);
        },
      },
    });
    const before = subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    const removal = subject.removeStartEntry(WSL_DISTRIBUTION);
    const after = subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    await vi.waitFor(() => expect(reads).toEqual(['query']));
    const later = subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    release();
    await Promise.all([before, removal, after, later]);
    expect(reads).toEqual(['query', 'query', 'query']);
  });

  // Mutation: an update that joins one that waits before a removal fails it: the removal would run last.
  it('an update after a removal runs after it, also while an update waits before the removal', async () => {
    const { subject, state, runs } = keeper({ permanent: true, entry: true });
    // The first two wait together (one update); then the removal; then a new update.
    const updates = [subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION), subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION)];
    const removal = subject.removeStartEntry(WSL_DISTRIBUTION);
    const after = subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    await Promise.all([...updates, removal, after]);
    expect(runs.map((run) => run.args[0])).toEqual(['query', 'query', 'delete', 'query', 'add']);
    expect(state.entry).toBe(true);
  });

  // Mutation: a state of the Monitor that is not read again after the list of WSL fails it: an answer that another
  // window forgot during that list would be undone.
  it('reads the state of the Monitor again after the list of WSL', async () => {
    let permanent = true;
    const { subject, state } = keeper({
      monitorPermanent: async () => permanent,
      registered: async () => {
        permanent = false;
        return true;
      },
    });
    await subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    expect(state.entry).toBe(false);
  });

  // Mutation: a keeper whose start writes the registry fails it (one read per minute and window for nothing).
  it('is not read or written by the start of the keeper', async () => {
    const { subject, runs, launches } = keeper({ permanent: true });
    subject.keep(WSL_DISTRIBUTION);
    await vi.waitFor(() => expect(launches).toHaveLength(1));
    expect(runs).toEqual([]);
  });

  // Mutation: an entry that stays when it cannot be written as it should fails it: Windows would run a program that is
  // gone, or an older script, at each logon.
  // Mutation: an entry that is removed without wslg.exe fails it (a WSL update that replaces wslg.exe at that moment
  // would remove the entry of the user); so does a too long entry that stays.
  it('is not added without wslg.exe (logged) and one that is there stays then; one that would be too long is removed', async () => {
    const noWslg = keeper({ permanent: true, wslg: false });
    await noWslg.subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    await noWslg.subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    expect(noWslg.state.entry).toBe(false);
    // Once while it stays.
    expect(noWslg.log.warn.mock.calls).toEqual([[expect.stringContaining(`There is no ${WSLG}, so Devspaces does not add or change the start entry "${NAME}"`)]]);
    const stays = keeper({ permanent: true, wslg: false, entry: true });
    await stays.subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    expect(stays.runs.map((run) => run.args[0])).toEqual(['query']);
    expect(stays.state.entry).toBe(true);
    // An entry that is not wanted goes also without wslg.exe.
    const unwanted = keeper({ permanent: false, wslg: false, entry: true });
    await unwanted.subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    expect(unwanted.state.entry).toBe(false);
    const long = 'C:\\' + 'x'.repeat(100);
    const tooLong = keeper({ permanent: true, env: { ProgramFiles: long }, exists: () => true, entry: true });
    await tooLong.subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    expect(tooLong.runs.map((run) => run.args[0])).toEqual(['query', 'delete']);
    expect(tooLong.state.entry).toBe(false);
    expect(tooLong.log.warn).toHaveBeenCalledWith(expect.stringContaining(`longer than ${MAX_START_ENTRY} characters`));
  });

  it('logs a failure of reg.exe, and the next update tries again', async () => {
    let fail = true;
    const failing = keeper({
      permanent: true,
      runner: { run: async (_file, args) => (args[0] === 'query' ? result(1) : result(fail ? 5 : 0)) },
    });
    await failing.subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    expect(failing.log.warn).toHaveBeenCalledWith('The start entry "nimblescape Devspaces WSL devspaces" could not be added: reg.exe add ended with exit code 5: (no output)');
    fail = false;
    await failing.subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    expect(failing.log.info).toHaveBeenCalledWith(expect.stringContaining('added the start entry'));
  });

  // Mutation: a VS Code without records that follows its (missing) answer fails it (VS Code Insiders next to VS Code
  // would remove the entry of VS Code); so does one that never removes an entry of a removed distribution (a removal of
  // the entry that failed, or an entry that another window added at the same moment, would stay at each logon).
  it('without records of this VS Code, only an entry of a distribution that WSL does not list is removed', async () => {
    const registered = vi.fn(async () => true as boolean | undefined);
    const monitorPermanent = vi.fn(async () => true as boolean | undefined);
    const none = keeper({ knows: async () => false, registered, monitorPermanent });
    await none.subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    expect(none.runs.map((run) => run.args[0])).toEqual(['query']);
    expect(none.state.entry).toBe(false);
    expect(registered).not.toHaveBeenCalled();
    const listed = keeper({ knows: async () => false, registered, monitorPermanent, entry: true, value: 'another command' });
    await listed.subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    expect(listed.runs.map((run) => run.args[0])).toEqual(['query']);
    expect(listed.state).toMatchObject({ entry: true, value: 'another command' });
    registered.mockResolvedValue(undefined);
    await listed.subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    expect(listed.state.entry).toBe(true);
    registered.mockResolvedValue(false);
    await listed.subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    expect(listed.state.entry).toBe(false);
    expect(monitorPermanent).not.toHaveBeenCalled();
    const failing = keeper({ knows: async () => Promise.reject(new Error('EBUSY')), entry: true });
    await failing.subject.updateStartEntry(WSL_HOST, WSL_DISTRIBUTION);
    expect(failing.state.entry).toBe(true);
    expect(failing.log.warn).toHaveBeenCalledWith(`The start entry "${NAME}" could not be read: EBUSY`);
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

  /**
   * Starts the script in its own folder `name`, with the lock of the test: `docker ps -q` prints the next line of
   * `answers` (the last one stays); `none`: nothing. `lockWait`: the wait for the lock in seconds, in place of
   * KEEPER_LOCK_WAIT_SECONDS.
   */
  function startScript(answers: readonly string[], options: { slowSleep?: boolean; name?: string; lockWait?: number } = {}) {
    folder ??= fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-keeper-'));
    const lock = path.join(folder, 'lock');
    const dir = path.join(folder, options.name ?? 'first');
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
    const script = KEEPER_SCRIPT.replace(KEEPER_LOCK, lock).replace(`-w ${KEEPER_LOCK_WAIT_SECONDS} `, `-w ${options.lockWait ?? KEEPER_LOCK_WAIT_SECONDS} `);
    expect(script).not.toBe(KEEPER_SCRIPT);
    const child = spawn('sh', ['-c', script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` }, stdio: 'ignore' });
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    const calls = () => (fs.existsSync(path.join(dir, 'calls')) ? Number(fs.readFileSync(path.join(dir, 'calls'), 'utf8').trim()) : 0);
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

  // Mutation: a script without the lock lets every window start one more keeper; one that ends at once while another
  // holds the lock leaves no keeper when that one ends right after (it was on its last check).
  it('waits for the lock while another keeper holds it, and takes over when that one ends', async () => {
    const first = startScript(['abc123'], { slowSleep: true });
    await vi.waitFor(() => expect(fs.existsSync(path.join(folder as string, 'lock'))).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const second = startScript(['none'], { name: 'second' });
    let secondEnded = false;
    void second.exited.then(() => (secondEnded = true));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(secondEnded).toBe(false);
    expect(second.calls()).toBe(0);
    // The end of the first one frees the lock at once, also while its `sleep` runs on (it does not hold the lock).
    first.child.kill();
    await first.exited;
    expect(await second.exited).toBe(0);
    expect(second.calls()).toBe(2);
  });

  it('ends after its wait for the lock while another keeper holds it', async () => {
    const first = startScript(['abc123'], { slowSleep: true });
    await vi.waitFor(() => expect(fs.existsSync(path.join(folder as string, 'lock'))).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const second = startScript(['abc123'], { name: 'second', lockWait: 1 });
    expect(await second.exited).not.toBe(0);
    expect(second.calls()).toBe(0);
    first.child.kill();
    await first.exited;
  });
});
