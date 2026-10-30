// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The key offer after a login with a password: the real `ssh-keygen` in a home folder of the test, the command for
// authorized_keys run by a real `sh` in another home folder (the "host"), and a fake `ssh` for the check login that
// records its arguments. The whole offer against a real OpenSSH server is in test/docker/sshLogin.test.ts.
import { vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findExecutable } from '../core/docker/dockerCli';
import { silentLogger, type Logger, type RunResult } from '../core/ports';
import { NodeProcessRunner } from '../core/process';
import { RemoteDockerState } from '../core/storage/remoteDockerState';
import { SshKeyOffer, type SshKeyDialogs } from './sshKeyOffer';

const keygen = findExecutable('ssh-keygen', process.env, process.platform);
const describeWithKeygen = process.platform === 'win32' || keygen === undefined ? describe.skip : describe;

let dir: string;
let home: string;
let hostHome: string;
let state: RemoteDockerState;
let asked: string[];
let warnings: string[];
let answer: 'use' | 'never' | undefined;
let sshExit: number;

const dialogs: SshKeyDialogs = {
  offer: async (host, keyPath) => {
    asked.push(`offer ${host} ${keyPath}`);
    return answer;
  },
  installed: (host) => asked.push(`installed ${host}`),
  failed: (host, detail) => asked.push(`failed ${host}: ${detail}`),
};

const logger: Logger = { ...silentLogger, warn: (line) => warnings.push(line) };

/** The shell before the relay on the "host": the command runs in its home folder. */
const shell = {
  run: (command: string): Promise<RunResult> =>
    new Promise((resolve) =>
      execFile('sh', ['-c', command], { env: { HOME: hostHome, PATH: process.env.PATH } }, (error, stdout, stderr) =>
        resolve({ exitCode: error ? Number(error.code ?? 1) : 0, stdout, stderr, timedOut: false }),
      ),
    ),
};

function offer(options: { ssh?: string | undefined; keygen?: string | undefined } = {}): SshKeyOffer {
  return new SshKeyOffer({
    home,
    platform: process.platform,
    computerName: 'test box',
    wrapperFolder: path.join(dir, 'wrapper'),
    runner: new NodeProcessRunner(),
    sshPath: () => ('ssh' in options ? options.ssh : path.join(dir, 'bin', 'ssh')),
    sshKeygenPath: () => ('keygen' in options ? options.keygen : keygen),
    env: { PATH: process.env.PATH, FAKE_SSH_LOG: path.join(dir, 'ssh-args'), FAKE_SSH_EXIT: String(sshExit) },
    state,
    dialogs,
    logger,
  });
}

const authorizedKeys = (): string => fs.readFileSync(path.join(hostHome, '.ssh', 'authorized_keys'), 'utf8');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-key-offer-'));
  home = path.join(dir, 'home');
  hostHome = path.join(dir, 'host');
  fs.mkdirSync(home);
  fs.mkdirSync(hostHome);
  fs.mkdirSync(path.join(dir, 'bin'));
  // The fake ssh of the check login: it records its arguments, one per line, and ends with FAKE_SSH_EXIT.
  fs.writeFileSync(
    path.join(dir, 'bin', 'ssh'),
    '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done > "$FAKE_SSH_LOG"\n[ "$FAKE_SSH_EXIT" = 0 ] || echo "Permission denied (publickey)." >&2\nexit "$FAKE_SSH_EXIT"\n',
    { mode: 0o755 },
  );
  state = new RemoteDockerState(path.join(dir, 'remote-docker.json'));
  asked = [];
  warnings = [];
  answer = 'use';
  sshExit = 0;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describeWithKeygen('SshKeyOffer: the offer after a login with a password', () => {
  it('asks nothing after a login without a password, and nothing for a host that declined the key', async () => {
    await offer().afterLogin('box', { passwordAsked: false }, shell);
    await state.setSshKey('box', 'declined');
    await offer().afterLogin('box', { passwordAsked: true }, shell);
    expect(asked).toEqual([]);
    expect(fs.existsSync(path.join(home, '.ssh'))).toBe(false);
  });

  it('creates its key, adds it to authorized_keys on the host, checks a login with only that key, and records the host', async () => {
    const keys = offer();
    expect(keys.keyPath).toBe(path.join(home, '.ssh', 'devspaces_ed25519'));
    expect(keys.identityFor('me@box:2222')).toBeUndefined();
    await keys.afterLogin('me@box:2222', { passwordAsked: true }, shell);
    expect(warnings).toEqual([]);
    expect(asked).toEqual([`offer me@box:2222 ${keys.keyPath}`, 'installed me@box:2222']);
    // The key pair, only for the user, and its public key on the host with the name of this computer.
    expect(fs.statSync(keys.keyPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(home, '.ssh')).mode & 0o777).toBe(0o700);
    const publicKey = fs.readFileSync(`${keys.keyPath}.pub`, 'utf8').split(' ').slice(0, 2).join(' ');
    expect(authorizedKeys()).toBe(`${publicKey} devspaces@testbox\n`);
    // The check: no question, only this key, the address of the host.
    expect(fs.readFileSync(path.join(dir, 'ssh-args'), 'utf8').trim().split('\n')).toEqual([
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-T', '-i', keys.keyPath, '-o', 'IdentitiesOnly=yes', '-o', 'PreferredAuthentications=publickey',
      '-p', '2222', '-l', 'me', '--', 'box', 'true',
    ]);
    expect(await state.sshKey('me@box:2222')).toBe('installed');
    expect(keys.identityFor('me@box:2222')).toBe(keys.keyPath);
    expect(keys.identityFor('other')).toBeUndefined();
  });

  it('uses a key file that is there already, and never writes over it', async () => {
    const keys = offer();
    await keys.afterLogin('a', { passwordAsked: true }, shell);
    const before = fs.readFileSync(keys.keyPath, 'utf8');
    await keys.afterLogin('b', { passwordAsked: true }, shell);
    expect(fs.readFileSync(keys.keyPath, 'utf8')).toBe(before);
    // The same key once in authorized_keys of the same account.
    expect(authorizedKeys().trim().split('\n')).toHaveLength(1);
    expect(await state.sshKey('b')).toBe('installed');
  });

  it('records "Not for This Host", and asks again next time when the question was closed', async () => {
    answer = undefined;
    await offer().afterLogin('box', { passwordAsked: true }, shell);
    expect(await state.sshKey('box')).toBeUndefined();
    answer = 'never';
    await offer().afterLogin('box', { passwordAsked: true }, shell);
    expect(await state.sshKey('box')).toBe('declined');
    await offer().afterLogin('box', { passwordAsked: true }, shell);
    expect(asked).toHaveLength(2);
    expect(fs.existsSync(path.join(home, '.ssh', 'devspaces_ed25519'))).toBe(false);
  });

  it('shows why the key could not be set up, and records nothing: a failed check login', async () => {
    sshExit = 255;
    const keys = offer();
    await keys.afterLogin('box', { passwordAsked: true }, shell);
    expect(asked[1]).toBe('failed box: the key is in ~/.ssh/authorized_keys on box, but a login with it failed: Permission denied (publickey).');
    expect(warnings).toHaveLength(1);
    expect(await state.sshKey('box')).toBeUndefined();
    expect(keys.identityFor('box')).toBeUndefined();
  });

  it('shows why the key could not be set up: authorized_keys that cannot be written, and no ssh-keygen', async () => {
    fs.mkdirSync(path.join(hostHome, '.ssh', 'authorized_keys'), { recursive: true });
    await offer().afterLogin('box', { passwordAsked: true }, shell);
    expect(asked[1]).toMatch(/^failed box: ~\/\.ssh\/authorized_keys on box could not be changed: .*Is a directory/);
    await offer({ keygen: undefined }).afterLogin('other', { passwordAsked: true }, shell);
    expect(asked[3]).toBe('failed other: ssh-keygen was not found on this computer.');
    expect(await state.read()).toEqual({});
  });

  // For example a jump host that asks for a password, or a server that wants a key and a password.
  it('does not offer the key again after a login that had it and still asked for a password', async () => {
    const keys = offer();
    await keys.afterLogin('box', { passwordAsked: true }, shell);
    expect(asked).toHaveLength(2);
    await keys.afterLogin('box', { passwordAsked: true }, shell);
    expect(asked).toHaveLength(2);
    // Without the key file, the offer comes again.
    fs.rmSync(keys.keyPath);
    fs.rmSync(`${keys.keyPath}.pub`);
    await keys.afterLogin('box', { passwordAsked: true }, shell);
    expect(asked.slice(2)).toEqual([`offer box ${keys.keyPath}`, 'installed box']);
  });

  it('writes over no public key file that is there without its private key', async () => {
    fs.mkdirSync(path.join(home, '.ssh'), { mode: 0o700 });
    const keys = offer();
    fs.writeFileSync(`${keys.keyPath}.pub`, 'mine');
    await keys.afterLogin('box', { passwordAsked: true }, shell);
    expect(asked[1]).toBe(`failed box: ${keys.keyPath}.pub is there without its private key; remove it, then try again.`);
    expect(fs.readFileSync(`${keys.keyPath}.pub`, 'utf8')).toBe('mine');
    expect(fs.existsSync(keys.keyPath)).toBe(false);
  });

  it('gives no key for a host whose key file is gone', async () => {
    const keys = offer();
    await keys.afterLogin('box', { passwordAsked: true }, shell);
    fs.rmSync(keys.keyPath);
    expect(keys.identityFor('box')).toBeUndefined();
  });
});

describeWithKeygen('SshKeyOffer: the ssh of the Docker CLI', () => {
  it('puts the wrapper first in PATH of a call to a host with the key, after it was written, with ssh and the key', async () => {
    const keys = offer();
    await keys.afterLogin('box', { passwordAsked: true }, shell);
    const before: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    keys.dockerSshEnv('box', before);
    expect(before).toEqual({ PATH: '/usr/bin' });
    await keys.prepare();
    const wrapper = path.join(dir, 'wrapper', 'ssh');
    expect(fs.readFileSync(wrapper, 'utf8')).toContain('exec "$DEVSPACES_SSH" -i "$DEVSPACES_SSH_IDENTITY" "$@"');
    expect(fs.statSync(wrapper).mode & 0o777).toBe(0o700);
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    keys.dockerSshEnv('box', env);
    expect(env).toEqual({ PATH: `${path.join(dir, 'wrapper')}:/usr/bin`, DEVSPACES_SSH: path.join(dir, 'bin', 'ssh'), DEVSPACES_SSH_IDENTITY: keys.keyPath });
    const other: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    keys.dockerSshEnv('other', other);
    const withoutSsh = offer({ ssh: undefined });
    await withoutSsh.prepare();
    withoutSsh.dockerSshEnv('box', other);
    expect(other).toEqual({ PATH: '/usr/bin' });
  });
});
