// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunOptions, RunResult, StartedProcess, StartOptions } from '../ports';
import { withSshPrompts } from '../sshAskpass';
import { WSL_HOST, wslCommandArgs } from './dockerHost';
import { IDLE_RETRY_MS, IDLE_SESSION_SCRIPT, WSL_RUNNING_ARGS, WSL_RUNNING_TIMEOUT_MS, WslLifetime, type WslLifetimeDeps } from './wslLifetime';

const WSL = 'C:\\Windows\\System32\\wsl.exe';
const ok = (stdout = ''): RunResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });
const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() });

/** A started process of the fake runner, which the test ends with `exit`. */
interface FakeProcess extends StartedProcess {
  file: string;
  args: readonly string[];
  options?: StartOptions;
  ended: boolean;
  killed: boolean;
  exit(result: { exitCode: number | null; error?: Error }): void;
  stderr(text: string): void;
}

function fakeProcess(file: string, args: readonly string[], options?: StartOptions): FakeProcess {
  let finish: (result: { exitCode: number | null; error?: Error }) => void = () => undefined;
  let errorListener: (text: string) => void = () => undefined;
  const exited = new Promise<{ exitCode: number | null; error?: Error }>((resolve) => (finish = resolve));
  const process: FakeProcess = {
    file,
    args,
    options,
    ended: false,
    killed: false,
    write: () => true,
    end: () => {
      process.ended = true;
    },
    kill: () => {
      process.killed = true;
    },
    killNow: () => {
      process.killed = true;
    },
    onStdout: () => undefined,
    onStderr: (listener) => {
      errorListener = listener;
    },
    exited,
    exit: (result) => finish(result),
    stderr: (text) => errorListener(text),
  };
  return process;
}

function lifetime(overrides: Partial<WslLifetimeDeps> & { list?: () => RunResult; permanent?: boolean; now?: () => number } = {}) {
  const runs: { file: string; args: readonly string[]; options?: RunOptions }[] = [];
  const started: FakeProcess[] = [];
  const log = logger();
  const deps: WslLifetimeDeps = {
    runner: {
      run: async (file, args, options) => {
        runs.push({ file, args, options });
        return overrides.list?.() ?? ok('');
      },
      start: (file, args, options) => {
        const process = fakeProcess(file, args, options);
        started.push(process);
        return process;
      },
    },
    wslPath: () => WSL,
    env: { PATH: 'C:\\Windows\\System32' },
    monitorPermanent: async () => overrides.permanent ?? false,
    logger: log,
    ...overrides,
  };
  return { subject: new WslLifetime(deps), runs, started, log };
}

describe('WslLifetime.running', () => {
  it('reads the running distributions with wsl.exe --list --running --quiet, with WSL_UTF8 and a time limit, and compares the names without case', async () => {
    const { subject, runs } = lifetime({ list: () => ok('Ubuntu\r\nDevSpaces\r\n') });
    expect(await subject.running('devspaces')).toBe(true);
    expect(runs).toEqual([{ file: WSL, args: WSL_RUNNING_ARGS, options: { env: { PATH: 'C:\\Windows\\System32', WSL_UTF8: '1' }, timeoutMs: WSL_RUNNING_TIMEOUT_MS } }]);
  });

  it('reads the list of an older wsl.exe in UTF-16', async () => {
    const utf16 = Buffer.from('\uFEFFdevspaces\r\n', 'utf16le').toString('utf8');
    const { subject } = lifetime({ list: () => ok(utf16) });
    expect(await subject.running('devspaces')).toBe(true);
  });

  it('is false when the list is empty (no distribution runs) or names only other distributions', async () => {
    expect(await lifetime({ list: () => ok('') }).subject.running('devspaces')).toBe(false);
    expect(await lifetime({ list: () => ok('Ubuntu\n') }).subject.running('devspaces')).toBe(false);
    expect(await lifetime({ list: () => ok('devspaces-old\n') }).subject.running('devspaces')).toBe(false);
  });

  it('logs a failure that stays once, and again after it worked', async () => {
    let list: RunResult = { exitCode: 1, stdout: '', stderr: 'broken', timedOut: false };
    const { subject, log } = lifetime({ list: () => list });
    await subject.running('devspaces');
    await subject.running('devspaces');
    expect(log.warn).toHaveBeenCalledTimes(1);
    list = ok('');
    await subject.running('devspaces');
    list = { exitCode: 1, stdout: '', stderr: 'broken', timedOut: false };
    await subject.running('devspaces');
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('is undefined, with a warning, when wsl.exe fails, does not answer, or cannot start; and without wsl.exe', async () => {
    const failing = lifetime({ list: () => ({ exitCode: 1, stdout: '', stderr: 'Wsl/Service/E_UNEXPECTED', timedOut: false }) });
    expect(await failing.subject.running('devspaces')).toBeUndefined();
    expect(failing.log.warn).toHaveBeenCalledWith(expect.stringContaining('Wsl/Service/E_UNEXPECTED'));
    const slow = lifetime({ list: () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }) });
    expect(await slow.subject.running('devspaces')).toBeUndefined();
    expect(slow.log.warn).toHaveBeenCalledWith(expect.stringContaining('did not answer'));
    const broken = lifetime({
      list: () => {
        throw new Error('spawn EPERM');
      },
    });
    expect(await broken.subject.running('devspaces')).toBeUndefined();
    const missing = lifetime({ wslPath: () => undefined });
    expect(await missing.subject.running('devspaces')).toBeUndefined();
    expect(missing.runs).toEqual([]);
  });
});

describe('WslLifetime.leavesStopped', () => {
  it('is true in the background for a WSL host whose distribution does not run while its Monitor does not run permanently; logged once', async () => {
    const { subject, log } = lifetime({ list: () => ok('Ubuntu\n') });
    expect(await subject.leavesStopped(WSL_HOST)).toBe(true);
    expect(await subject.leavesStopped(WSL_HOST)).toBe(true);
    const said = log.info.mock.calls.filter(([text]) => String(text).includes('does not run. Devspaces does not start it'));
    expect(said).toHaveLength(1);
  });

  it('is false while the distribution runs, and logs the change after it was stopped', async () => {
    let list = ok('');
    const { subject, log } = lifetime({ list: () => list });
    expect(await subject.leavesStopped(WSL_HOST)).toBe(true);
    list = ok('devspaces\n');
    expect(await subject.leavesStopped(WSL_HOST)).toBe(false);
    expect(log.info).toHaveBeenLastCalledWith(expect.stringContaining('runs, or may be started'));
  });

  it('is false, without wsl.exe, while the Monitor of the host runs permanently', async () => {
    const monitorPermanent = vi.fn(async () => true);
    const { subject, runs } = lifetime({ monitorPermanent });
    expect(await subject.leavesStopped(WSL_HOST)).toBe(false);
    expect(monitorPermanent).toHaveBeenCalledWith(WSL_HOST);
    expect(runs).toEqual([]);
  });

  it('is false in a flow of the user, which starts the distribution', async () => {
    const { subject, runs } = lifetime({ list: () => ok('') });
    expect(await withSshPrompts(() => subject.leavesStopped(WSL_HOST))).toBe(false);
    expect(runs).toEqual([]);
  });

  it('is false when the state cannot be told (the call runs as before)', async () => {
    const { subject } = lifetime({ list: () => ({ exitCode: 1, stdout: '', stderr: 'broken', timedOut: false }) });
    expect(await subject.leavesStopped(WSL_HOST)).toBe(false);
  });

  it('is false for the local Docker and for SSH hosts, without a question to WSL', async () => {
    const monitorPermanent = vi.fn(async () => false);
    const { subject, runs } = lifetime({ monitorPermanent, list: () => ok('') });
    expect(await subject.leavesStopped('')).toBe(false);
    expect(await subject.leavesStopped('build-server')).toBe(false);
    expect(await subject.leavesStopped('wsl:2222')).toBe(false);
    expect(runs).toEqual([]);
    expect(monitorPermanent).not.toHaveBeenCalled();
  });
});

describe('WslLifetime.use', () => {
  it('starts one idle session per WSL host: the idle script as root in the distribution, with WSL_UTF8', () => {
    const { subject, started, log } = lifetime();
    subject.use(WSL_HOST);
    subject.use(WSL_HOST);
    expect(started).toHaveLength(1);
    expect(started[0]?.file).toBe(WSL);
    expect(started[0]?.args).toEqual(wslCommandArgs('devspaces', ['sh', '-c', IDLE_SESSION_SCRIPT]));
    expect(started[0]?.options).toEqual({ env: { PATH: 'C:\\Windows\\System32', WSL_UTF8: '1' } });
    expect(subject.holds(WSL_HOST)).toBe(true);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('holds an idle session'));
  });

  // Mutation: a background call that starts a new session after the end, so that each refresh of the sidebar keeps the
  // distribution running, fails it.
  it('after the session ended itself (exit code 0), only a flow of the user starts a new one; then the background may again', async () => {
    let now = 1_000_000;
    const { subject, started, log } = lifetime({ now: () => now });
    subject.use(WSL_HOST);
    started[0]?.exit({ exitCode: 0 });
    await vi.waitFor(() => expect(subject.holds(WSL_HOST)).toBe(false));
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('ended: no devspace and no Monitor ran there'));
    subject.use(WSL_HOST);
    expect(started).toHaveLength(1);
    await withSshPrompts(async () => subject.use(WSL_HOST));
    expect(started).toHaveLength(2);
    // That one ended with an error after a minute or longer (not by itself): a call in the background starts the next one.
    now += IDLE_RETRY_MS;
    started[1]?.exit({ exitCode: null });
    await vi.waitFor(() => expect(subject.holds(WSL_HOST)).toBe(false));
    subject.use(WSL_HOST);
    expect(started).toHaveLength(3);
  });

  it('leavesStopped asks WSL nothing while this window holds the idle session (the distribution runs)', async () => {
    const { subject, runs } = lifetime({ list: () => ok('') });
    subject.use(WSL_HOST);
    expect(await subject.leavesStopped(WSL_HOST)).toBe(false);
    expect(runs).toEqual([]);
  });

  it('starts no new session within a minute after one failed, with the error output in the warning; then again', async () => {
    let now = 1_000_000;
    const { subject, started, log } = lifetime({ now: () => now });
    subject.use(WSL_HOST);
    started[0]?.stderr('There is no distribution with the supplied name.\r\n');
    started[0]?.exit({ exitCode: 4294967295 });
    await vi.waitFor(() => expect(subject.holds(WSL_HOST)).toBe(false));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('failed (exit code 4294967295: There is no distribution with the supplied name.)'));
    now += IDLE_RETRY_MS - 1;
    subject.use(WSL_HOST);
    expect(started).toHaveLength(1);
    now += 1;
    subject.use(WSL_HOST);
    expect(started).toHaveLength(2);
  });

  it('starts a new session at once after one that ran for a minute or longer ended with an error (the distribution was stopped)', async () => {
    let now = 1_000_000;
    const { subject, started, log } = lifetime({ now: () => now });
    subject.use(WSL_HOST);
    now += IDLE_RETRY_MS;
    started[0]?.exit({ exitCode: 1 });
    await vi.waitFor(() => expect(subject.holds(WSL_HOST)).toBe(false));
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('ended (exit code 1)'));
    expect(log.warn).not.toHaveBeenCalled();
    subject.use(WSL_HOST);
    expect(started).toHaveLength(2);
  });

  it('counts a process that could not start as a failed session', async () => {
    const { subject, started, log } = lifetime();
    subject.use(WSL_HOST);
    started[0]?.exit({ exitCode: null, error: new Error('spawn ENOENT') });
    await vi.waitFor(() => expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('spawn ENOENT')));
    subject.use(WSL_HOST);
    expect(started).toHaveLength(1);
  });

  it('starts nothing for other hosts, without wsl.exe, without a runner that starts programs, and after dispose', () => {
    const { subject, started } = lifetime();
    subject.use('');
    subject.use('build-server');
    expect(started).toHaveLength(0);
    const missing = lifetime({ wslPath: () => undefined });
    missing.subject.use(WSL_HOST);
    expect(missing.started).toHaveLength(0);
    const noStart = lifetime();
    const runOnly = new WslLifetime({ runner: { run: async () => ok('') }, wslPath: () => WSL, env: {}, monitorPermanent: async () => false, logger: logger() });
    runOnly.use(WSL_HOST);
    expect(runOnly.holds(WSL_HOST)).toBe(false);
    noStart.subject.dispose();
    noStart.subject.use(WSL_HOST);
    expect(noStart.started).toHaveLength(0);
  });

  it('dispose ends the input of each session and stops it at once, and logs nothing about its end', async () => {
    const { subject, started, log } = lifetime();
    subject.use(WSL_HOST);
    subject.dispose();
    expect(started[0]?.ended).toBe(true);
    expect(started[0]?.killed).toBe(true);
    expect(subject.holds(WSL_HOST)).toBe(false);
    started[0]?.exit({ exitCode: null });
    await new Promise((resolve) => setImmediate(resolve));
    expect(log.warn).not.toHaveBeenCalled();
  });
});

// The idle script with the real `sh`, `cat`, `kill` and `grep`, and with a `sleep` that returns at once and a `docker`
// that answers from a file of the test.
describe.skipIf(process.platform === 'win32')('the idle script', () => {
  let folder: string | undefined;
  afterEach(() => {
    if (folder !== undefined) fs.rmSync(folder, { recursive: true, force: true });
    folder = undefined;
  });

  /**
   * Starts the script with stubs: `docker` prints the next line of `answers` (one per check; the last one stays) as its
   * output, or fails for the line `fail`; it counts its calls in `calls`.
   */
  function startScript(answers: readonly string[]) {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-idle-'));
    const bin = path.join(folder, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(folder, 'answers'), answers.join('\n') + '\n');
    fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexec /bin/sleep 0.01\n', { mode: 0o755 });
    fs.writeFileSync(
      path.join(bin, 'docker'),
      [
        '#!/bin/sh',
        `dir='${folder}'`,
        'echo "$*" >> "$dir/args"',
        'n=$(($(cat "$dir/calls" 2>/dev/null || echo 0) + 1)); echo "$n" > "$dir/calls"',
        'total=$(wc -l < "$dir/answers")',
        '[ "$n" -le "$total" ] || n=$total',
        'line=$(sed -n "${n}p" "$dir/answers")',
        '[ "$line" = fail ] && exit 1',
        '[ "$line" = none ] && exit 0',
        'printf "%s\\n" "$line"',
      ].join('\n'),
      { mode: 0o755 },
    );
    const child = spawn('sh', ['-c', IDLE_SESSION_SCRIPT], { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` }, stdio: ['pipe', 'ignore', 'ignore'] });
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    const calls = () => Number(fs.readFileSync(path.join(folder as string, 'calls'), 'utf8').trim() || '0');
    return { child, exited, calls, args: () => fs.readFileSync(path.join(folder as string, 'args'), 'utf8') };
  }

  it('ends with exit code 0 after two checks in a row without a running devspace or Monitor, while its input stays open', async () => {
    const { child, exited, calls, args } = startScript(['none']);
    expect(await exited).toBe(0);
    expect(calls()).toBe(2);
    expect(args()).toContain('ps --filter status=running --format {{.Label "nimblescape.devspaces.id"}}{{.Label "nimblescape.devspaces.monitor"}}');
    child.stdin.end();
  });

  it('runs on while a devspace or the Monitor runs; a running container without either label counts as quiet', async () => {
    // A devspace, the Monitor (the value of its label), then an empty line: a container without either label.
    const { child, exited, calls } = startScript(['abc', '1f2e3d4c5b6a', '', 'none']);
    expect(await exited).toBe(0);
    expect(calls()).toBe(4);
    child.stdin.end();
  });

  it('starts the count again after a check that found a running container with a label', async () => {
    const { child, exited, calls } = startScript(['none', 'abc', 'none', 'none']);
    expect(await exited).toBe(0);
    expect(calls()).toBe(4);
    child.stdin.end();
  });

  it('counts a failed check as quiet', async () => {
    const { child, exited, calls } = startScript(['fail', 'fail']);
    expect(await exited).toBe(0);
    expect(calls()).toBe(2);
    child.stdin.end();
  });

  it('ends soon after the end of its input, also while a devspace runs', async () => {
    const { child, exited } = startScript(['abc']);
    await new Promise((resolve) => setTimeout(resolve, 200));
    child.stdin.end();
    expect(await exited).toBe(0);
  });
});
