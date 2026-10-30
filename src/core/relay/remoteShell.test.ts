// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The shell before the relay on a local `sh -s` (in place of `ssh … sh -s`), on NodeProcessRunner.startBytes.
import { describe, expect, it } from 'vitest';
import { silentLogger, type Logger, type StartedByteProcess } from '../ports';
import { NodeProcessRunner } from '../process';
import { RemoteShell, RemoteShellError, ShellGoneError, dockerShellCommand, shellCommandLine } from './remoteShell';

const describeUnix = process.platform === 'win32' ? describe.skip : describe;
const runner = new NodeProcessRunner();

/** A login that prints a greeting on both outputs before its shell reads its input. */
function login(script = 'echo Welcome to the host; echo Last login: today >&2; exec sh -s'): StartedByteProcess {
  return runner.startBytes('sh', ['-c', script]);
}

function logged(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return { logger: { ...silentLogger, info: (line) => lines.push(line), warn: (line) => lines.push(line) }, lines };
}

describe('shellCommandLine', () => {
  const marker = 'devspaces-done-0123';

  it('runs the command without input, then prints its exit code and the marker on both outputs', () => {
    expect(shellCommandLine("'docker' 'info'", marker)).toBe(
      `'docker' 'info' </dev/null; printf '\\n%s %s\\n' ${marker} "$?"; printf '\\n%s\\n' ${marker} >&2\n`,
    );
  });

  it('gives the input as a here-document that ends with the marker, with a line feed at its end', () => {
    const end = `printf '\\n%s %s\\n' ${marker} "$?"; printf '\\n%s\\n' ${marker} >&2`;
    expect(shellCommandLine('cat', marker, 'a\nb')).toBe(`cat <<'${marker}'; ${end}\na\nb\n${marker}\n`);
    expect(shellCommandLine('cat', marker, 'a\n')).toBe(`cat <<'${marker}'; ${end}\na\n${marker}\n`);
    expect(shellCommandLine('cat', marker, '')).toBe(`cat <<'${marker}'; ${end}\n${marker}\n`);
  });

  it('refuses a line break or a NUL in the command, and a NUL in the input', () => {
    expect(() => shellCommandLine('a\nb', marker)).toThrow('line break');
    expect(() => shellCommandLine('a\0', marker)).toThrow('line break');
    expect(() => shellCommandLine('cat', marker, 'a\0')).toThrow('NUL');
  });
});

describe('dockerShellCommand', () => {
  it('puts each word in single quotes', () => {
    expect(dockerShellCommand(['image', 'inspect', '--format', '{{json .Id}}', "it's"])).toBe(`'docker' 'image' 'inspect' '--format' '{{json .Id}}' 'it'\\''s'`);
  });

  it('has no command for a word with a line break or a NUL', () => {
    expect(dockerShellCommand(['ps', '--filter', 'name=a\nb'])).toBeUndefined();
    expect(dockerShellCommand(['ps', 'a\0'])).toBeUndefined();
  });
});

describeUnix('RemoteShell', () => {
  it('ignores what the login printed, and runs commands one after the other with their output and exit code', async () => {
    const { logger, lines } = logged();
    const shell = await RemoteShell.open(login(), { logger, name: 'box' });
    expect(shell.isOpen).toBe(true);
    expect(lines).toEqual(['The login on box printed 20 bytes before the shell answered; they are ignored.']);
    // Started together, they run in order on the one shell.
    const results = await Promise.all([
      shell.run(`printf 'a\\nb'`),
      shell.run(`sh -c 'echo why >&2; exit 3'`),
      shell.run(`printf 'last\\n'`),
      shell.run('cat', { input: 'line 1\nline 2' }),
    ]);
    expect(results).toEqual([
      { exitCode: 0, stdout: 'a\nb', stderr: '', timedOut: false },
      { exitCode: 3, stdout: '', stderr: 'why\n', timedOut: false },
      { exitCode: 0, stdout: 'last\n', stderr: '', timedOut: false },
      { exitCode: 0, stdout: 'line 1\nline 2\n', stderr: '', timedOut: false },
    ]);
    // A command never reads the input of the shell.
    await expect(shell.run('cat')).resolves.toEqual({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
    shell.close();
  });

  it('reads an output that comes in many chunks, also with characters of several bytes', async () => {
    const shell = await RemoteShell.open(login(), { logger: silentLogger, name: 'box' });
    const result = await shell.run(`i=0; while [ $i -lt 3000 ]; do printf 'äöü-%s\\n' $i; i=$((i+1)); done`);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(3000);
    expect(lines.at(-1)).toBe('äöü-2999');
    shell.close();
  });

  it('stops the shell after the time limit of a command, and takes no command after it', async () => {
    const shell = await RemoteShell.open(login(), { logger: silentLogger, name: 'box' });
    await expect(shell.run(`printf 'started\\n'; sleep 30`, { timeoutMs: 300 })).resolves.toEqual({ exitCode: null, stdout: 'started\n', stderr: '', timedOut: true });
    expect(shell.isOpen).toBe(false);
    await expect(shell.run('true')).rejects.toBeInstanceOf(ShellGoneError);
  });

  it('stops the shell when the signal of a command aborts', async () => {
    const shell = await RemoteShell.open(login(), { logger: silentLogger, name: 'box' });
    const controller = new AbortController();
    const running = shell.run('sleep 30', { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(shell.isOpen).toBe(false);
  });

  it('gives the end of the shell during a command as the result of that command', async () => {
    let ended = 0;
    const shell = await RemoteShell.open(login(), { logger: silentLogger, name: 'box', onEnd: () => ended++ });
    const result = await shell.run(`echo going >&2; kill -9 $$`);
    expect(result).toMatchObject({ exitCode: 255, timedOut: false });
    expect(result.stderr).toContain('going');
    expect(shell.isOpen).toBe(false);
    expect(ended).toBe(1);
  });

  it('fails the open with the error output of a login that ends, and after the time limit of the login', async () => {
    const refused = RemoteShell.open(login('echo "user@box: Permission denied (publickey)." >&2; exit 255'), { logger: silentLogger, name: 'box' });
    await expect(refused).rejects.toBeInstanceOf(RemoteShellError);
    await expect(refused).rejects.toMatchObject({ detail: 'user@box: Permission denied (publickey).', timedOut: false });
    const silent = RemoteShell.open(login('sleep 30'), { logger: silentLogger, name: 'box', loginTimeoutMs: 300 });
    await expect(silent).rejects.toMatchObject({ detail: 'ssh did not answer within 0.3 seconds.', timedOut: true });
  });

  // A question of the login in VS Code (a password, a host key) waits for the user, longer than the time limit.
  it('stops the time limit of the login while a question is open, and starts it anew after it', async () => {
    const listeners = new Set<(open: boolean) => void>();
    const prompts = {
      onPrompt: (listener: (open: boolean) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const ask = (open: boolean) => listeners.forEach((listener) => listener(open));
    // Answers after 600 ms, twice the time limit: the question is open from 50 ms to 450 ms.
    const opening = RemoteShell.open(login('sleep 0.6; exec sh -s'), { logger: silentLogger, name: 'box', loginTimeoutMs: 300, prompts });
    setTimeout(() => ask(true), 50);
    setTimeout(() => ask(false), 450);
    const shell = await opening;
    expect(shell.isOpen).toBe(true);
    expect(listeners.size).toBe(0);
    shell.killNow();
    // After the question, the full time limit again.
    const late = RemoteShell.open(login('sleep 30'), { logger: silentLogger, name: 'box', loginTimeoutMs: 300, prompts });
    const started = Date.now();
    setTimeout(() => ask(true), 50);
    setTimeout(() => ask(false), 250);
    await expect(late).rejects.toMatchObject({ timedOut: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
    expect(listeners.size).toBe(0);
  });

  it('closes a shell that no command used for a while', async () => {
    const { logger, lines } = logged();
    let ended = 0;
    const process = login();
    const shell = await RemoteShell.open(process, { logger, name: 'box', idleCloseMs: 200, onEnd: () => ended++ });
    await shell.run('true');
    await expect(process.exited).resolves.toEqual({ exitCode: 0 });
    expect(shell.isOpen).toBe(false);
    expect(ended).toBe(1);
    expect(lines).toContain('The shell on box was closed after a time without use.');
  });

  it('stays open during keepOpenDuring, also after a command in it, and is closed after a time without use afterwards', async () => {
    const process = login();
    const shell = await RemoteShell.open(process, { logger: silentLogger, name: 'box', idleCloseMs: 100 });
    const result = await shell.keepOpenDuring(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const ran = await shell.run('printf in');
      await new Promise((resolve) => setTimeout(resolve, 250));
      return ran.stdout;
    });
    expect(result).toBe('in');
    expect(shell.isOpen).toBe(true);
    await expect(process.exited).resolves.toEqual({ exitCode: 0 });
    expect(shell.isOpen).toBe(false);
  });

  it('gives its process to the relay after the commands before, with the output from then on', async () => {
    let ended = 0;
    const shell = await RemoteShell.open(login(), { logger: silentLogger, name: 'box', onEnd: () => ended++ });
    const before = shell.run(`printf before`);
    const taking = shell.takeOver();
    const after = shell.run('true');
    await expect(before).resolves.toMatchObject({ stdout: 'before' });
    const taken = await taking;
    expect(taken).toBeDefined();
    expect(shell.isOpen).toBe(false);
    expect(ended).toBe(1);
    await expect(after).rejects.toBeInstanceOf(ShellGoneError);
    // The start script of a connection: the shell runs it, and the program that it starts gets the rest of the input,
    // written after the marker (as RelayConnection does: the shell may read ahead what comes before).
    const chunks: Buffer[] = [];
    let stderr = '';
    const outputEnded = new Promise<void>((resolve) => taken!.onStdout((chunk) => chunks.push(chunk), resolve));
    taken!.onStderr((text) => (stderr += text));
    taken!.write(Buffer.from(`printf 'marker\\n'; echo to-stderr >&2; exec cat\n`));
    while (!Buffer.concat(chunks).toString('utf8').includes('marker\n')) await new Promise((resolve) => setTimeout(resolve, 10));
    taken!.write(Buffer.from('frames'));
    taken!.end();
    await outputEnded;
    expect(Buffer.concat(chunks).toString('utf8')).toBe('marker\nframes');
    expect(stderr).toBe('to-stderr\n');
    await expect(taken!.exited).resolves.toEqual({ exitCode: 0 });
    // Taken over, the shell is not closed by `close`; it has no takeover anymore.
    shell.close();
    await expect(shell.takeOver()).resolves.toBeUndefined();
  });
});
