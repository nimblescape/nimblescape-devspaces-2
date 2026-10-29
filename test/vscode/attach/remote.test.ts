// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

/// <reference types="mocha" />
// Attach tests in the window of a devspace on the Docker engine of another computer (.vscode-test.mjs, label attach,
// DEVSPACE_TEST_ATTACH=remote): Docker uses that engine over SSH (its Docker context is the current context, as after
// "Use a Remote Docker Host…"), and VS Code starts in the window of the devspace there, whose folder URI names the
// Docker pipe of the window (`settings.host`, src/core/relay/windowPipe.ts). prepare.ts made the devspace without
// container, so the extension restores it from its volume labels on that engine and runs the open pipeline there
// before the window connects; the Dev Containers extension attaches through the Docker pipe, which the extension serves
// through the connection of the relay of its worker. The engine of the runner has a container with the name of the
// devspace container, which the window must not use. The window of another Docker host than the current one closes
// before it attaches (controller.ts, onWindowHost).
// The first test counts the SSH logins of the open on the other computer, writes them to the log of the test and to the
// summary of the CI job, and allows one: the checks before the relay run on the shell whose login the relay takes over.
import * as assert from 'assert';
import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { DEFAULT_CONTEXT_NAME } from '../../../src/core/docker/dockerHost';
import { LABEL_DEVSPACE_ID, LABEL_HELPER } from '../../../src/core/names';
import { LABEL_MONITOR } from '../../../src/core/remoteMonitor/protocol';
import { decodeAuthorityParts } from '../../../src/vscode/connection/authority';
import { loginsUntil, sshLogEvents } from './sshLogins';
import { EXTENSION_ID, channelLog, connectedFolder, docker, printLogs, printLong, seed, serverDataFolder } from './support';

/** A file that the window writes into its container. */
const WINDOW_MARK = '/tmp/devspaces-test-window-mark';
/**
 * The count of the logins of the open ends when no login came for LOGINS_QUIET_MS after the connection of the window
 * and after the last login, at the latest LOGINS_WAIT_MS after the connection.
 */
const LOGINS_QUIET_MS = 15_000;
const LOGINS_WAIT_MS = 90_000;
/** The longest command of a session in the timeline. */
const SESSION_TEXT_LENGTH = 200;
/** The most SSH logins of the open of the devspace on the other computer, until the last one. */
const MAX_OPEN_LOGINS = 1;
/**
 * The lines of the Devspaces log that the timeline shows next to the logins: the Docker calls that log in with the
 * Docker context, the shell before the relay, the connections of the relay, and the Docker pipes (also the requests
 * that the pipe of the extension logs).
 */
const LOGIN_LOG_LINE = /logs? in|SSH login|The shell on|without the connection of the relay|The connection to \S+ (is open|could not be opened)|Docker pipe of (the extension|.* listens)/;
/** The most lines of the Devspaces log in the timeline. */
const LOGIN_LOG_LINES = 60;

/**
 * The log of the container of the other computer since `since` (ISO 8601), with the time of each line: its standard
 * output and standard error, where sshd writes. The container runs on the Docker engine of the runner (the context
 * `default`), so this read is no SSH login. Read without blocking the extension host, whose Docker pipe serves the
 * window meanwhile.
 */
function remoteHostLog(container: string, since: string): Promise<string> {
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      'docker',
      ['--context', DEFAULT_CONTEXT_NAME, 'logs', '--timestamps', '--since', since, container],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`docker logs ${container}: ${stderr || error.message}`));
        else resolve(`${stdout}\n${stderr}`);
      },
    );
  });
}

/**
 * The time of the first line of `log` (the Devspaces log, `[HH:MM:SS] <level> <message>` in local time) that matches
 * `pattern`, on the day of `near`, or of the day before when it would be later than `near`. Undefined without such a
 * line.
 */
function logLineTime(log: string, pattern: RegExp, near: number): number | undefined {
  const line = log.split('\n').find((text) => pattern.test(text));
  return line === undefined ? undefined : lineTime(line, near);
}

/** The time of a line of the Devspaces log (see logLineTime), or undefined for a line without a time. */
function lineTime(line: string, near: number): number | undefined {
  const match = /^\[(\d\d):(\d\d):(\d\d)\]/.exec(line);
  if (!match) return undefined;
  const date = new Date(near);
  date.setHours(Number(match[1]), Number(match[2]), Number(match[3]), 0);
  if (date.getTime() > near) date.setDate(date.getDate() - 1);
  return date.getTime();
}

describe('the window of a devspace on a Docker engine over SSH', () => {
  const { containerName, dockerContext = '', remoteHost = '', dockerHost = '', remoteHostContainer = '', preparedAt = '' } = seed();
  let failed = false;

  afterEach(function () {
    if (this.currentTest?.state === 'failed') failed = true;
  });

  after(() => {
    if (failed) printLogs();
  });

  // The first test: the tests after it run Docker over SSH themselves.
  it('logs in to that engine once for the open', async () => {
    // The tests start once the window has connected, so the age of the extension host is the time of the connection.
    const connected = Date.now();
    const started = connected - process.uptime() * 1000;
    await connectedFolder();
    assert.ok(remoteHostContainer && preparedAt, 'The seed names no container of the other computer and no time of the preparation (prepare.ts)');
    let output = await remoteHostLog(remoteHostContainer, preparedAt);
    let events = sshLogEvents(output);
    const quietSince = () => Math.max(connected, events.filter((event) => event.kind === 'login').at(-1)?.time ?? connected);
    while (Date.now() - quietSince() < LOGINS_QUIET_MS && Date.now() - connected < LOGINS_WAIT_MS) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      output = await remoteHostLog(remoteHostContainer, preparedAt);
      events = sshLogEvents(output);
    }
    const settled = Date.now() - quietSince() >= LOGINS_QUIET_MS;
    assert.ok(loginsUntil(events) > 0, `The log of ${remoteHostContainer} shows no SSH login since ${preparedAt}:\n${output.slice(-4_000)}`);
    assert.ok(
      events.some((event) => event.kind === 'session'),
      `The log of ${remoteHostContainer} shows no command of a session since ${preparedAt} (REMOTE_HOST_SESSION of prepare.ts):\n${output.slice(-4_000)}`,
    );

    // The worker of the open starts before Dev Containers attaches: the logins until the devspace was ready are those
    // of Devspaces (the log of Devspaces has whole seconds, so this count may include the logins of one more second).
    const devspacesLog = channelLog('Devspaces');
    const ready = logLineTime(devspacesLog, / is ready in the container /, connected);
    // The lines of the log about logins and connections since the start of the extension host (whole seconds).
    const loginLines = devspacesLog
      .split('\n')
      .filter((line) => LOGIN_LOG_LINE.test(line))
      .map((line) => ({ time: lineTime(line, connected), text: `(Devspaces) ${line.replace(/^\[[^\]]*\]\s*/, '').slice(0, SESSION_TEXT_LENGTH)}` }))
      .filter((entry): entry is { time: number; text: string } => entry.time !== undefined && entry.time >= started - 1_000)
      .slice(0, LOGIN_LOG_LINES);
    const seconds = (time: number) => ((time - started) / 1000).toFixed(1);
    const lastLogin = events.filter((event) => event.kind === 'login').at(-1)?.time;
    const rows: [string, string, string][] = [
      ['the devspace was ready (log of Devspaces, whole seconds)', ready === undefined ? '?' : String(loginsUntil(events, ready + 999)), ready === undefined ? '?' : seconds(ready)],
      ['the window was connected (the tests started)', String(loginsUntil(events, connected)), seconds(connected)],
      [
        settled ? `the last login (no login for ${LOGINS_QUIET_MS / 1000} s after it)` : `the last login (logins still came ${LOGINS_WAIT_MS / 1000} s after the connection)`,
        String(loginsUntil(events)),
        lastLogin === undefined ? '-' : seconds(lastLogin),
      ],
    ];
    const timeline = [
      ...events.filter((event) => event.kind === 'session').map((event) => ({ time: event.time, text: event.text.slice(0, SESSION_TEXT_LENGTH) })),
      ...(ready === undefined ? [] : [{ time: ready, text: '(Devspaces: the devspace is ready)' }]),
      ...loginLines,
      { time: connected, text: '(the window is connected, the tests start)' },
    ]
      .sort((a, b) => a.time - b.time)
      .map((entry) => `${seconds(entry.time).padStart(7)} s  ${entry.text}`);
    printLong(
      [
        `    SSH logins on ${remoteHost} for the open of the devspace (seconds after the start of the extension host of the window):`,
        ...rows.map(([until, logins, at]) => `      until ${until}: ${logins} logins, at ${at} s`),
        '    the sessions:',
        ...timeline.map((line) => `      ${line}`),
      ].join('\n'),
    );
    // The summary of the CI job (GitHub Actions); without it, only the log of the test has the numbers.
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) {
      const table = ['| Until | SSH logins | Seconds after the start of the extension host |', '| --- | ---: | ---: |', ...rows.map((row) => `| ${row.join(' | ')} |`)];
      const text = [`### SSH logins of one open on a remote Docker host`, '', ...table, '', '<details><summary>The sessions</summary>', '', '```text', ...timeline, '```', '', '</details>', ''];
      try {
        fs.appendFileSync(summary, `${text.join('\n')}\n`);
      } catch (error) {
        console.log(`    the summary of the job could not be written: ${String(error)}`);
      }
    }
    assert.ok(loginsUntil(events) <= MAX_OPEN_LOGINS, `The open logged in ${loginsUntil(events)} times to ${remoteHost}, at most ${MAX_OPEN_LOGINS} expected (see the sessions above).`);
  });

  it('connects after the extension restored the devspace on that engine and ran its open pipeline there', async () => {
    assert.ok(dockerContext && remoteHost && dockerHost, 'The seed names no Docker context, host, or Docker pipe (prepare.ts, DEVSPACE_TEST_ATTACH_PREPARE=remote)');
    const folder = await connectedFolder();
    assert.deepStrictEqual(decodeAuthorityParts(folder.authority), { containerName, dockerHost });
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension?.isActive, `${EXTENSION_ID} is not active`);
    const log = channelLog('Devspaces');
    assert.match(log, /1 devspaces were restored from the labels of their volumes\./);
    assert.match(log, /The open pipeline of devspaces-test\/attach runs before it connects\./);
    assert.match(log, /devspaces-test\/attach is ready in the container /);
    // The Dev Containers extension reached the engine through the Docker pipe of the window, which the extension served.
    assert.ok(log.includes(`The Docker pipe of ${containerName} listens on ${dockerHost}.`), 'The Docker pipe of the window did not listen');
    assert.ok(log.includes(`Docker pipe of ${containerName}: `), 'No Docker call came through the Docker pipe of the window');
    assert.ok(!log.includes(`The Docker pipe of ${containerName} could not reach`), 'A Docker call through the Docker pipe failed');
    assert.ok(!log.includes(`The Docker pipe of ${containerName} goes without the connection of the relay`), 'The Docker pipe went without the relay');
    // Each line of a worker names its engine: the operations ran on the other computer, none on the local Docker.
    assert.ok(log.includes(`[${remoteHost}] open#`), `No operation open on ${remoteHost} in the log`);
    assert.doesNotMatch(log, /\[the local Docker\]/);
    assert.strictEqual(docker(['--context', dockerContext, 'inspect', '-f', '{{.State.Status}}', containerName]).trim(), 'running');
    const entries = (await vscode.workspace.fs.readDirectory(folder)).map(([name]) => name);
    assert.ok(entries.includes('.devcontainer'), entries.join(', '));
  });

  it('works in the container on that engine, not in the container of the same name on the local Docker', async () => {
    const folder = await connectedFolder();
    const text = crypto.randomUUID();
    await vscode.workspace.fs.writeFile(folder.with({ path: WINDOW_MARK }), Buffer.from(text, 'utf8'));
    assert.strictEqual(docker(['--context', dockerContext, 'exec', containerName, 'cat', WINDOW_MARK]), text);
    // The container of the local Docker still runs, and the window left nothing there: no file and no VS Code server.
    assert.strictEqual(docker(['--context', DEFAULT_CONTEXT_NAME, 'inspect', '-f', '{{.State.Status}}', containerName]).trim(), 'running');
    const found = docker(['--context', DEFAULT_CONTEXT_NAME, 'exec', containerName, 'sh', '-c', 'for f in "$@"; do if [ -e "$f" ]; then echo "$f"; fi; done', 'sh', WINDOW_MARK, `/root/${serverDataFolder()}`]);
    assert.strictEqual(found.trim(), '', 'The window changed the container of the same name on the local Docker');
  });

  it('runs the Monitor on that engine and creates nothing on the local Docker', () => {
    assert.notStrictEqual(docker(['--context', dockerContext, 'ps', '-q', '--filter', `label=${LABEL_MONITOR}`, '--filter', 'status=running']).trim(), '', `No Monitor runs on ${remoteHost}`);
    // Workers and the Monitor are containers of the helper image, which carries LABEL_HELPER.
    const local = (args: string[]): string => docker(['--context', DEFAULT_CONTEXT_NAME, ...args]).trim();
    assert.strictEqual(local(['images', '-q', '--filter', `label=${LABEL_HELPER}`]), '', 'A helper image on the local Docker');
    assert.strictEqual(local(['ps', '-aq', '--filter', `label=${LABEL_HELPER}`]), '', 'A container of the helper image on the local Docker');
    assert.strictEqual(local(['volume', 'ls', '-q', '--filter', `label=${LABEL_DEVSPACE_ID}`]), '', 'A devspace volume on the local Docker');
  });
});
