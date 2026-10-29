// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The start script of a connection of the relay (docs/architecture.md "The connection of the relay"): the text that
// `sh -s` runs on the computer of the Docker engine, written first on the standard input of the transport
// (`ssh … sh -s`). It prints the marker of the connection and then replaces the shell with the command that starts the
// relay (`docker run --rm -i … startRelay`). What the extension writes after the marker (the bundle line for the pipe
// loader, then the frames) is the input of that command. Pure functions; no I/O. No `vscode`.
import { randomBytes } from 'crypto';

/** The marker of a connection: `devspaces-start-` and 32 hex digits, new for each connection. */
const MARKER = /^devspaces-start-[0-9a-f]{32}$/;

/** A new marker (startMarker): random, so that no output of the login on the host can look like it by chance. */
export function startMarker(random: Buffer = randomBytes(16)): string {
  if (random.length !== 16) throw new RangeError('The marker takes 16 random bytes.');
  return `devspaces-start-${random.toString('hex')}`;
}

/** `word` as one word of sh, in single quotes (a single quote in it as `'\''`). */
export function shellWord(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * The script: one line that prints `marker` and replaces the shell with `command`. Both are on one line: sh reads a
 * whole line before it runs it, and the extension writes nothing more until it saw the marker, so sh has read nothing
 * of what comes after, and the command gets all of it. Text that the login prints (a message of `~/.profile`) comes
 * before the marker. Throws for a word with a line break or a NUL (it would end the line or the word).
 */
export function relayStartScript(marker: string, command: readonly string[]): string {
  if (!MARKER.test(marker)) throw new Error('The marker of the start script is invalid.');
  if (command.length === 0) throw new Error('The start script has no command.');
  for (const word of command) {
    if (/[\0\r\n]/.test(word)) throw new Error('A word of the start script has a line break or a NUL.');
  }
  return `printf '%s\\n' ${marker}; exec ${command.map(shellWord).join(' ')}\n`;
}
