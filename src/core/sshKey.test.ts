// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authorizedKeysCommand, devspacesKeyPath, keyComment, parsePublicKey, sshWrapper } from './sshKey';

const BLOB = 'AAAAC3NzaC1lZDI1NTE5AAAAIHgJ3c2oQkQe4m4oY0bJ6qNnV6l0Sx5Jm8m2bq9b3n1d';
const KEY = { type: 'ssh-ed25519', blob: BLOB };

describe('the key of Devspaces: its file, its public key and its comment', () => {
  it('is devspaces_ed25519 in the .ssh folder of the home folder', () => {
    expect(devspacesKeyPath('/home/ann', 'linux')).toBe('/home/ann/.ssh/devspaces_ed25519');
    expect(devspacesKeyPath('C:\\Users\\ann', 'win32')).toBe('C:\\Users\\ann\\.ssh\\devspaces_ed25519');
  });

  it('reads an Ed25519 public key from the output of ssh-keygen -y, with or without a comment', () => {
    expect(parsePublicKey(`ssh-ed25519 ${BLOB}\n`)).toEqual(KEY);
    expect(parsePublicKey(`ssh-ed25519 ${BLOB} devspaces@box\r\n`)).toEqual(KEY);
    expect(parsePublicKey(`ssh-rsa ${BLOB}`)).toBeUndefined();
    expect(parsePublicKey(`ssh-ed25519 ${BLOB}'; rm -rf ~`)).toBeUndefined();
    expect(parsePublicKey('Load key: invalid format')).toBeUndefined();
    expect(parsePublicKey('')).toBeUndefined();
  });

  it('names this computer in the comment, with plain characters only', () => {
    expect(keyComment('ann-laptop.local')).toBe('devspaces@ann-laptop.local');
    expect(keyComment("Ann's Mac Book")).toBe('devspaces@AnnsMacBook');
    expect(keyComment('$()')).toBe('devspaces@computer');
  });
});

describe('the command that adds the key to authorized_keys (run by sh in a home folder of the test)', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-ssh-key-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function runCommand(): void {
    execFileSync('sh', ['-c', authorizedKeysCommand(KEY, 'devspaces@box')], { env: { HOME: home, PATH: process.env.PATH }, cwd: os.tmpdir() });
  }

  const file = (): string => path.join(home, '.ssh', 'authorized_keys');

  it('creates the folder and the file only for the owner, and adds the key once', () => {
    runCommand();
    runCommand();
    expect(fs.readFileSync(file(), 'utf8')).toBe(`ssh-ed25519 ${BLOB} devspaces@box\n`);
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(home, '.ssh')).mode & 0o777).toBe(0o700);
      expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
    }
  });

  it('keeps the keys there, adds a line feed to a last line without one, and adds no key that is there with another comment', () => {
    fs.mkdirSync(path.join(home, '.ssh'), { mode: 0o700 });
    fs.writeFileSync(file(), 'ssh-ed25519 AAAAother ann@desk', { mode: 0o644 });
    runCommand();
    expect(fs.readFileSync(file(), 'utf8')).toBe(`ssh-ed25519 AAAAother ann@desk\nssh-ed25519 ${BLOB} devspaces@box\n`);
    // A file mode of the user stays.
    if (process.platform !== 'win32') expect(fs.statSync(file()).mode & 0o777).toBe(0o644);
    fs.writeFileSync(file(), `ssh-ed25519 ${BLOB} renamed@other\n`);
    runCommand();
    expect(fs.readFileSync(file(), 'utf8')).toBe(`ssh-ed25519 ${BLOB} renamed@other\n`);
  });

  it('changes neither the folder nor the umask of the shell that runs it', () => {
    const out = execFileSync('sh', ['-c', `umask 022; ${authorizedKeysCommand(KEY, 'devspaces@box')}; umask; pwd`], {
      env: { HOME: home, PATH: process.env.PATH },
      cwd: os.tmpdir(),
    }).toString();
    expect(out.trim().split('\n')).toEqual(['0022', fs.realpathSync(os.tmpdir())]);
  });

  it('fails when the file cannot be written', () => {
    fs.mkdirSync(path.join(home, '.ssh', 'authorized_keys'), { recursive: true });
    expect(() => runCommand()).toThrow();
  });
});

describe('the wrapper ssh of the Docker CLI', () => {
  it('is a batch file on Windows that gives -i and the key before the arguments', () => {
    expect(sshWrapper('win32')).toEqual({
      fileName: 'ssh.cmd',
      text: '@echo off\r\n"%DEVSPACES_SSH%" -i "%DEVSPACES_SSH_IDENTITY%" %*\r\n',
    });
  });

  it.skipIf(process.platform === 'win32')('is a shell script elsewhere that runs ssh with -i and the key before the arguments', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-ssh-wrapper-'));
    try {
      const wrapper = sshWrapper('linux');
      expect(wrapper.fileName).toBe('ssh');
      const file = path.join(dir, wrapper.fileName);
      fs.writeFileSync(file, wrapper.text, { mode: 0o700 });
      // A fake ssh that prints its arguments, one per line.
      const fake = path.join(dir, 'fake ssh');
      fs.writeFileSync(fake, '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\n', { mode: 0o700 });
      const out = execFileSync(file, ['-o', 'ConnectTimeout=30', '-T', '--', 'box', 'docker system dial-stdio'], {
        env: { PATH: process.env.PATH, DEVSPACES_SSH: fake, DEVSPACES_SSH_IDENTITY: '/home/ann/.ssh/devspaces_ed25519' },
      }).toString();
      expect(out.split('\n').slice(0, -1)).toEqual(['-i', '/home/ann/.ssh/devspaces_ed25519', '-o', 'ConnectTimeout=30', '-T', '--', 'box', 'docker system dial-stdio']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
