// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The start script of the connection of the relay: the marker, the quoting of the words, and what a real `sh -s` makes
// of the script (its words reach the command unchanged, and the input after the marker belongs to the command).
import { spawn } from 'child_process';
import { describe, expect, it } from 'vitest';
import { PIPE_LOADER } from '../loader/pipeLoader';
import { relayStartScript, shellWord, startMarker } from './startScript';

const describeUnix = process.platform === 'win32' ? describe.skip : describe;

/** Runs `script` with `sh -s`; after the marker, writes `input`. The output after the marker, and the exit code. */
function runScript(script: string, marker: string, input = ''): Promise<{ after: string; before: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'inherit'] });
    let output = '';
    let seen = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (text: string) => {
      output += text;
      if (!seen && output.includes(`${marker}\n`)) {
        seen = true;
        child.stdin.end(input);
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const at = output.indexOf(`${marker}\n`);
      resolve({ before: at < 0 ? output : output.slice(0, at), after: at < 0 ? '' : output.slice(at + marker.length + 1), code });
    });
    child.stdin.write(script);
  });
}

describe('startMarker', () => {
  it('is new for each connection, from 16 random bytes', () => {
    expect(startMarker(Buffer.alloc(16, 0xab))).toBe(`devspaces-start-${'ab'.repeat(16)}`);
    expect(startMarker()).toMatch(/^devspaces-start-[0-9a-f]{32}$/);
    expect(startMarker()).not.toBe(startMarker());
    expect(() => startMarker(Buffer.alloc(8))).toThrow(RangeError);
  });
});

describe('relayStartScript', () => {
  const marker = startMarker(Buffer.alloc(16, 1));

  it('prints the marker and replaces the shell with the command, on one line', () => {
    expect(relayStartScript(marker, ['docker', 'run', "it's"])).toBe(`printf '%s\\n' ${marker}; exec 'docker' 'run' 'it'\\''s'\n`);
    expect(shellWord('')).toBe("''");
  });

  it('refuses an invalid marker, no command, and a word with a line break or a NUL', () => {
    expect(() => relayStartScript('devspaces-start-x; rm -rf /', ['true'])).toThrow('marker');
    expect(() => relayStartScript(marker, [])).toThrow('no command');
    for (const word of ['a\nb', 'a\rb', 'a\0b']) expect(() => relayStartScript(marker, ['echo', word])).toThrow('line break');
  });
});

describeUnix('the start script with a real sh -s', () => {
  it('passes every word unchanged, the pipe loader too', async () => {
    const marker = startMarker();
    const words = ["it's", '"$HOME" `id` $(id) \\ * ? [a] ~ ; & | < > !', '', '  spaces  ', 'äü€😀', PIPE_LOADER];
    const script = relayStartScript(marker, [process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...words]);
    const result = await runScript(script, marker);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.after)).toEqual(words);
  });

  it('gives the command all the input after the marker, and the login text comes before it', async () => {
    const marker = startMarker();
    const input = `first line\n${'x'.repeat(100_000)}\nlast line without a line feed`;
    const script = `echo a greeting of the login\n${relayStartScript(marker, ['cat'])}`;
    const result = await runScript(script, marker, input);
    expect(result).toEqual({ before: 'a greeting of the login\n', after: input, code: 0 });
  });
});
