// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The SSH key of Devspaces (docs/architecture.md "The key of Devspaces"). After a login with a password in a flow of
// the user, Devspaces offers to log in with a key next time (src/vscode/sshKeyOffer.ts). On yes, it creates its own
// Ed25519 key without a passphrase, `~/.ssh/devspaces_ed25519` (never another file of the user), adds its public key to
// `~/.ssh/authorized_keys` of the account on the host with a command on the same login (the shell before the relay),
// and checks it with a login that uses only this key. Later logins of Devspaces to that host give the key to `ssh` with
// `-i`; the `ssh` that the Docker CLI starts for `ssh://<host>` gets it through a small wrapper first in PATH
// (sshWrapper). Pure parts. No `vscode`.
import * as path from 'path';
import { shellWord } from './relay/startScript';

/** The file name of the private key of Devspaces in `~/.ssh`; the public key is next to it with `.pub`. */
export const DEVSPACES_KEY_FILE = 'devspaces_ed25519';

/** The private key of Devspaces in the home folder `home`. */
export function devspacesKeyPath(home: string, platform: NodeJS.Platform): string {
  return (platform === 'win32' ? path.win32 : path.posix).join(home, '.ssh', DEVSPACES_KEY_FILE);
}

/** A public key in the form of `authorized_keys`: its type and its key data (base64). */
export interface PublicKey {
  type: string;
  blob: string;
}

/** The Ed25519 public key in the first line of `text` (for example the output of `ssh-keygen -y`), or undefined. */
export function parsePublicKey(text: string): PublicKey | undefined {
  const match = /^(ssh-ed25519) ([A-Za-z0-9+/]+={0,2})(?:\s.*)?$/.exec(text.split(/\r?\n/)[0].trim());
  return match === null ? undefined : { type: match[1], blob: match[2] };
}

/** The comment of the key in `authorized_keys`: `devspaces@<name of this computer>`, with plain characters only. */
export function keyComment(computerName: string): string {
  return `devspaces@${computerName.replace(/[^A-Za-z0-9._-]/g, '') || 'computer'}`;
}

const AUTHORIZED_KEYS = '.ssh/authorized_keys';

/** A test of the shell whose exit code is 0 when `key` is in a line of `~/.ssh/authorized_keys` that is no comment. */
function keyInAuthorizedKeys(key: PublicKey): string {
  return `{ grep -v '^[[:space:]]*#' ${AUTHORIZED_KEYS} 2>/dev/null | grep -qF ${shellWord(`${key.type} ${key.blob}`)}; }`;
}

/**
 * One line for the shell before the relay that adds `key` to `~/.ssh/authorized_keys` of the account, as `ssh-copy-id`
 * does: in the home folder, with umask 077 (a new folder 0700, a new file 0600), only when the key is not in a line of
 * the file that is no comment, after a line feed when the file does not end with one, and with `restorecon` when the
 * host has it (SELinux). In a subshell, so the folder and the umask of the shell stay as they are for the commands
 * after it and for the relay. Its exit code is 0 when the key is in the file.
 */
export function authorizedKeysCommand(key: PublicKey, comment: string): string {
  const file = AUTHORIZED_KEYS;
  const line = shellWord(`${key.type} ${key.blob} ${comment}`);
  const steps = [
    `cd && umask 077 && mkdir -p .ssh`,
    `{ ${keyInAuthorizedKeys(key)} || { { [ -z "$(tail -c 1 ${file} 2>/dev/null)" ] || echo >> ${file}; } && printf '%s\\n' ${line} >> ${file}; }; }`,
    `{ ! command -v restorecon >/dev/null 2>&1 || restorecon -F .ssh ${file} >/dev/null 2>&1 || true; }`,
  ];
  return `( ${steps.join(' && ')} )`;
}

/** One line for the shell before the relay whose exit code is 0 when `key` is in `~/.ssh/authorized_keys` (no comment). */
export function authorizedKeyPresentCommand(key: PublicKey): string {
  return `( cd && ${keyInAuthorizedKeys(key)} )`;
}

/** The program that the Docker CLI starts as `ssh` for a host with the key of Devspaces, and its environment. */
export const SSH_WRAPPER_SSH_ENV = 'DEVSPACES_SSH';
export const SSH_WRAPPER_IDENTITY_ENV = 'DEVSPACES_SSH_IDENTITY';

/**
 * The wrapper `ssh` of the Docker CLI: it runs the `ssh` of the system (SSH_WRAPPER_SSH_ENV) with `-i` and the key of
 * Devspaces (SSH_WRAPPER_IDENTITY_ENV) before the arguments of the Docker CLI. A shell script, or on Windows a batch file
 * (the Docker CLI finds `ssh.cmd` through PATHEXT); its arguments come only from the Docker CLI (`-o ConnectTimeout=30
 * -T -- <host> docker system dial-stdio`, with a host of the list, which has no shell character).
 */
export function sshWrapper(platform: NodeJS.Platform): { fileName: string; text: string } {
  if (platform === 'win32') {
    return { fileName: 'ssh.cmd', text: ['@echo off', `"%${SSH_WRAPPER_SSH_ENV}%" -i "%${SSH_WRAPPER_IDENTITY_ENV}%" %*`, ''].join('\r\n') };
  }
  return { fileName: 'ssh', text: ['#!/bin/sh', `exec "$${SSH_WRAPPER_SSH_ENV}" -i "$${SSH_WRAPPER_IDENTITY_ENV}" "$@"`, ''].join('\n') };
}
