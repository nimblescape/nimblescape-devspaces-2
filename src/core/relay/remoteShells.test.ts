// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The shells before the relay of a window on local `sh -s` logins (in place of `ssh … sh -s`).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { silentLogger, type Logger, type StartedByteProcess } from '../ports';
import { NodeProcessRunner } from '../process';
import { RemoteShells } from './remoteShells';

const describeUnix = process.platform === 'win32' ? describe.skip : describe;
const runner = new NodeProcessRunner();

/** RemoteShells whose logins are `script` (a local `sh -s` by default), with the hosts that each login was for. */
function shells(options: { script?: string; noTransport?: string[]; logger?: Logger; idleCloseMs?: number } = {}) {
  const logins: string[] = [];
  const processes: StartedByteProcess[] = [];
  const registry = new RemoteShells({
    logger: options.logger ?? silentLogger,
    start: (host) => {
      if (options.noTransport?.includes(host)) return undefined;
      logins.push(host);
      const process = runner.startBytes('sh', ['-c', options.script ?? 'exec sh -s']);
      processes.push(process);
      return process;
    },
    idleCloseMs: options.idleCloseMs,
    loginTimeoutMs: 5_000,
  });
  return { registry, logins, processes };
}

describeUnix('RemoteShells', () => {
  it('logs in once per host for the calls at the same time and after, and logs the login', async () => {
    const lines: string[] = [];
    const { registry, logins } = shells({ logger: { ...silentLogger, info: (line) => lines.push(line) } });
    const results = await Promise.all([registry.run('box', 'printf one'), registry.run('box', 'printf two'), registry.login('box'), registry.run('other', 'printf three')]);
    expect(results.map((result) => (result !== undefined && 'stdout' in result ? result.stdout : result))).toEqual(['one', 'two', { ok: true }, 'three']);
    await expect(registry.run('box', 'printf four')).resolves.toMatchObject({ stdout: 'four' });
    expect(logins.sort()).toEqual(['box', 'other']);
    expect(lines.filter((line) => line.startsWith('The shell on box'))).toEqual(['The shell on box is open: one SSH login for the checks before the relay.']);
    registry.dispose();
  });

  it('runs a Docker call with the docker of the other computer, each word as it is, and none with a word that a line cannot carry', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-shells-'));
    try {
      fs.writeFileSync(path.join(dir, 'docker'), `#!/bin/sh\nprintf '%s|' "$@"\necho "words: $#" >&2\nexit 4\n`, { mode: 0o755 });
      const { registry } = shells({ script: `PATH=${dir}:$PATH; export PATH; exec sh -s` });
      await expect(registry.docker('box', ['ps', '--filter', "name=it's $HOME"])).resolves.toEqual({
        exitCode: 4,
        stdout: "ps|--filter|name=it's $HOME|",
        stderr: 'words: 3\n',
        timedOut: false,
      });
      await expect(registry.docker('box', ['ps', 'a\nb'])).resolves.toBeUndefined();
      registry.dispose();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('has no shell for a host without a transport', async () => {
    const { registry, logins } = shells({ noTransport: ['box/path'] });
    await expect(registry.login('box/path')).resolves.toBeUndefined();
    await expect(registry.run('box/path', 'true')).resolves.toBeUndefined();
    await expect(registry.takeOver('box/path')).resolves.toBeUndefined();
    expect(logins).toEqual([]);
  });

  it('gives a failed login as the result of ssh, and logs in again for the next call', async () => {
    const { registry, logins } = shells({ script: 'echo "ssh: connect to host box port 22: Connection refused" >&2; exit 255' });
    await expect(registry.login('box')).resolves.toEqual({ ok: false, detail: 'ssh: connect to host box port 22: Connection refused', timedOut: false });
    await expect(registry.run('box', 'true')).resolves.toEqual({ exitCode: 255, stdout: '', stderr: 'ssh: connect to host box port 22: Connection refused', timedOut: false });
    expect(logins).toEqual(['box', 'box']);
  });

  it('gives the relay the login of the shell after the calls before it, and a new login to the calls after it', async () => {
    const { registry, logins } = shells();
    const before = registry.run('box', 'printf before');
    const taking = registry.takeOver('box');
    await expect(before).resolves.toMatchObject({ stdout: 'before' });
    const taken = await taking;
    expect(taken).toBeDefined();
    expect(logins).toEqual(['box']);
    // The shell is the relay's now: the next call logs in again, and there is nothing more to take over.
    await expect(registry.run('box', 'printf after')).resolves.toMatchObject({ stdout: 'after' });
    expect(logins).toEqual(['box', 'box']);
    taken!.end();
    await taken!.exited;
    registry.dispose();
  });

  it('gives the relay a login that is still in progress, and nothing when there is none', async () => {
    const { registry } = shells();
    await expect(registry.takeOver('box')).resolves.toBeUndefined();
    const login = registry.login('box');
    const taken = await registry.takeOver('box');
    await expect(login).resolves.toEqual({ ok: true });
    expect(taken).toBeDefined();
    taken!.end();
    registry.dispose();
  });

  it('logs in again after a shell was closed for a time without use', async () => {
    const { registry, logins, processes } = shells({ idleCloseMs: 100 });
    await registry.run('box', 'true');
    await processes[0].exited;
    await registry.run('box', 'true');
    expect(logins).toEqual(['box', 'box']);
    registry.dispose();
  });

  it('stops every shell at the end of the window, and opens none after it', async () => {
    const { registry, processes, logins } = shells();
    await registry.login('box');
    registry.dispose();
    await expect(processes[0].exited).resolves.toMatchObject({ exitCode: null });
    await expect(registry.run('box', 'true')).resolves.toBeUndefined();
    expect(logins).toEqual(['box']);
  });

  it('stops a login in progress at the end of the window', async () => {
    const { registry, processes } = shells({ script: 'exec sleep 30' });
    const login = registry.login('box');
    registry.dispose();
    // It ends long before its 30 seconds (and the time limit of the login).
    await processes[0].exited;
    await expect(login).resolves.toMatchObject({ ok: false, timedOut: false });
  });
});
