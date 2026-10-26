// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

/// <reference types="mocha" />
// Attach tests of a devspace window whose container stops or is removed while the window is attached (.vscode-test.mjs,
// label attach, DEVSPACE_TEST_ATTACH=stopped). The tests cannot run in that window, and no window of development
// extensions can stay open after its container stops: VS Code closes such a window when one of its extension hosts
// ends, and the one in the container ends with the container (PR #18; a test window then ends with exit code 0). So the
// test VS Code has a local folder, and the tests start a second VS Code (DEVSPACE_TEST_SECOND_VSCODE: its own user data
// folder, the extensions folder of the test VS Code with the extension and the sign-in provider installed from their
// VSIX files by scripts/install-attach-extensions.mjs, no tests) in the window of the devspace, as a user starts VS
// Code. They stop or remove the container from outside (as the Monitor, or a user with `docker stop` or
// `docker rm -f`), read the log of the second VS Code, quit it and start it again: the next open of the window.
// What a user sees (PR #18, VS Code 1.141.1, Dev Containers 0.469.0): VS Code gives up the remote connection at once
// ("Container is no longer running") and offers to reload the window; the window stays open, and its extension, in the
// local extension host, logs at its next heartbeat that the container does not run (src/vscode/controller.ts,
// checkConnection) and shows Reconnect in the status bar. At the next open, the open pipeline starts the stopped
// container, or makes a new one for a removed container, before the window connects.
import * as assert from 'assert';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { EXTENSION_ID, channelLog, docker, execIn, outputLogs, printLogs, printLong, seed, sessionLogs, waitFor } from './support';

/**
 * The second VS Code (.vscode-test.mjs): its user data folder, the extensions folder of the test VS Code, its
 * arguments.
 */
interface SecondVscode {
  userDataDir: string;
  extensionsDir: string;
  args: string[];
}

function secondVscode(): SecondVscode {
  const value = process.env.DEVSPACE_TEST_SECOND_VSCODE;
  assert.ok(value, 'DEVSPACE_TEST_SECOND_VSCODE is not set (.vscode-test.mjs)');
  return JSON.parse(value) as SecondVscode;
}

/** Three heartbeats of 15 seconds: the longest time from a change of the container to the log of the window. */
const NOTICE_WAIT_MS = 45_000;
/** How long the tests watch the container after the stop: whether something starts it again. */
const WATCH_MS = 60_000;
/** The longest time from the start of the second VS Code to the attach of its window (with the open pipeline). */
const ATTACH_WAIT_MS = 300_000;
/** The longest time that the second VS Code may take to quit. */
const QUIT_WAIT_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('a devspace window whose container stops or is removed', () => {
  const { containerName, user } = seed();
  const second = secondVscode();
  const repository = 'devspaces-test/attach';
  let running: childProcess.ChildProcess | undefined;
  let starts = 0;
  let failed = false;
  /** The last start of the second VS Code whose logs were printed after a failure. */
  let printedStart = 0;
  /** The lines of postAttachCommand when the container stopped. */
  let attachesAtStop = 0;

  afterEach(function () {
    if (this.currentTest?.state === 'failed') failed = true;
  });

  after(async function () {
    this.timeout(QUIT_WAIT_MS + 30_000);
    await quitSecond();
    if (!failed) return;
    printSecondLogs();
    printLogs();
  });

  /**
   * The state of the container: `running`, `exited`, … or `missing`; another error of Docker as it is. With `--type`,
   * because the volume and the image of the devspace have the name of its container.
   */
  function containerState(): string {
    const result = childProcess.spawnSync('docker', ['inspect', '--type', 'container', '-f', '{{.State.Status}}', containerName], { encoding: 'utf8' });
    if (result.status === 0) return result.stdout.trim();
    return /No such (object|container)/i.test(result.stderr) ? 'missing' : `docker inspect failed: ${result.stderr.trim()}`;
  }

  function containerId(): string {
    return docker(['inspect', '--type', 'container', '-f', '{{.Id}}', containerName]).trim();
  }

  /** The lines that postAttachCommand wrote: one per attach of a window; -1 while the container does not run. */
  function attaches(): number {
    const result = execIn(user, 'if [ -f /tmp/attach-count ]; then wc -l < /tmp/attach-count; else echo 0; fi');
    return result.code === 0 ? Number(result.out) : -1;
  }

  /** The Devspaces log of the last start of the second VS Code from position `from` on. */
  function secondLog(from = 0): string {
    return channelLog('Devspaces', second.userDataDir).slice(from);
  }

  /** The lines of a log without the ones about GitHub, which rejects the dummy token of the sign-in provider. */
  function withoutGitHub(log: string): string {
    return log
      .split('\n')
      .filter((line) => !/GitHub|^\s+at |^Canceled/.test(line))
      .join('\n');
  }

  /** The renderer log of the last start of the second VS Code. */
  function rendererLog(): string {
    return [...sessionLogs(second.userDataDir)].find(([name]) => /^window\d+[\\/]renderer\.log$/.test(name))?.[1] ?? '';
  }

  /** The lines of the renderer log about the remote connection of the window, from position `from` on. */
  function connectionLines(from = 0): string {
    return rendererLog()
      .slice(from)
      .split('\n')
      .filter((line) => /\[remote-connection\]|resolveAuthority/.test(line))
      .join('\n');
  }

  /** The log line of the heartbeat check when the container of the window does not run (checkConnection). */
  const NOT_RUNNING = new RegExp(`^\\[[\\d:]+\\] info The container of ${repository} does not run\\.$`, 'm');

  /** The number of Devspaces logs of the last start of the second VS Code: one per load of the window. */
  function windowLoads(): number {
    return [...outputLogs(second.userDataDir)].filter(([name]) => name.endsWith('-Devspaces.log')).length;
  }

  /**
   * After a failed test, prints the logs of the last start of the second VS Code, once, after it quit (with what it
   * logged at the quit) and before the next start, which logs into a folder of its own.
   */
  function printSecondLogs(): void {
    if (starts === printedStart) return;
    printedStart = starts;
    console.log(`\n===== start ${starts} of the second VS Code =====`);
    printLogs(second.userDataDir);
    for (const [name, text] of sessionLogs(second.userDataDir)) if (!/output_logging_/.test(name)) printLong(`\n===== ${name} =====\n${text}`);
    const output = path.join(second.userDataDir, `output-${starts}.txt`);
    printLong(`\n===== output of start ${starts} =====\n${fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : ''}`);
  }

  /**
   * Starts the second VS Code in the window of the devspace, in a process group of its own. Without the variables of the
   * test VS Code (VSCODE_*, ELECTRON_*, DEVSPACE_TEST_*), so that it starts as a VS Code of its own and not as a Node.js
   * process; DEVSPACE_TEST_USER_DATA_DIR names its own user data folder, so that scripts/run-attach-tests.mjs also finds
   * the programs that it leaves running (the extension does not read it).
   */
  function startSecond(): void {
    starts += 1;
    // No update of the installed extensions from the Marketplace between the starts.
    const settings = path.join(second.userDataDir, 'User', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    if (!fs.existsSync(settings)) fs.writeFileSync(settings, JSON.stringify({ 'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false }, null, 2));
    const output = fs.openSync(path.join(second.userDataDir, `output-${starts}.txt`), 'w');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ELECTRON_|VSCODE_|DEVSPACE_TEST_)/.test(key)));
    env.DEVSPACE_TEST_USER_DATA_DIR = second.userDataDir;
    running = childProcess.spawn(process.execPath, second.args, { env, detached: true, stdio: ['ignore', output, output] });
    fs.closeSync(output);
    running.unref();
  }

  /**
   * Quits the second VS Code as a user quits it: SIGTERM to its main process, which closes its window, and the extension
   * deactivates. Then SIGKILL to its process group, for any process that remains. Returns how the main process ended.
   */
  async function quitSecond(): Promise<string> {
    const child = running;
    running = undefined;
    if (child?.pid === undefined) return 'not started';
    const pid = child.pid;
    const ending = (): string | undefined => (child.exitCode !== null ? `exit code ${child.exitCode}` : (child.signalCode ?? undefined));
    const exited = ending() !== undefined ? Promise.resolve() : new Promise<void>((resolve) => child.once('exit', () => resolve()));
    if (ending() === undefined) child.kill('SIGTERM');
    await Promise.race([exited, sleep(QUIT_WAIT_MS)]);
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // The process group has ended.
    }
    await Promise.race([exited, sleep(10_000)]);
    if (failed) printSecondLogs();
    return ending() ?? 'still running';
  }

  /** Starts the second VS Code and waits until its window attached: postAttachCommand wrote one more line. */
  async function startAndAttach(before: number): Promise<void> {
    const startedAt = Date.now();
    startSecond();
    try {
      await waitFor('the attach of the window of the second VS Code', () => (attaches() > before ? true : undefined), ATTACH_WAIT_MS);
    } finally {
      console.log(`    start ${starts} of the second VS Code: attaches ${before} -> ${attaches()} after ${Math.round((Date.now() - startedAt) / 1000)} s`);
    }
    // One heartbeat after the attach, so that the window knows its container as running.
    await sleep(20_000);
  }

  /** Quits the second VS Code, which must quit on its own and release the devspace at its close. */
  async function quitAndRelease(): Promise<void> {
    const from = secondLog().length;
    const ended = await quitSecond();
    console.log(`    the second VS Code quit: ${ended}`);
    try {
      assert.ok(ended === 'exit code 0' || ended === 'SIGTERM', `The second VS Code did not quit on its own (${ended})`);
      assert.match(secondLog(from), new RegExp(`Released ${repository}: the Monitor stops it after`), 'The window did not release the devspace at its close');
    } catch (error) {
      printSecondLogs();
      throw error;
    }
  }

  /**
   * Watches the container and the log of the window after a stop or a removal: the states of the container, and when the
   * window logged that its container does not run.
   */
  async function watchAfter(change: string, from: number, rendererFrom: number): Promise<{ noticedAt: number | undefined; states: string[] }> {
    const changedAt = Date.now();
    const seconds = (): number => Math.round((Date.now() - changedAt) / 1000);
    const states: string[] = [];
    let last = '';
    let noticedAt: number | undefined;
    while (Date.now() - changedAt < WATCH_MS || (noticedAt === undefined && Date.now() - changedAt < NOTICE_WAIT_MS + 15_000)) {
      const state = containerState();
      if (state !== last) states.push(`${seconds()} s: ${state}`);
      last = state;
      if (noticedAt === undefined && NOT_RUNNING.test(secondLog(from))) noticedAt = seconds();
      await sleep(1_000);
    }
    console.log(`    the container after the ${change}: ${states.join('; ')}`);
    console.log(`    the window logged after ${noticedAt ?? '(never)'} s that its container does not run`);
    printLong(`    the log of the window after the ${change}:\n${withoutGitHub(secondLog(from))}`);
    printLong(`    the remote connection of the window after the ${change}:\n${connectionLines(rendererFrom)}`);
    return { noticedAt, states };
  }

  /** The states that watchAfter recorded, without their times. */
  function statesOnly(states: string[]): string[] {
    return states.map((state) => state.replace(/^\d+ s: /, ''));
  }

  /**
   * The window noticed the change in time with its heartbeat check, and VS Code keeps it open, without a reload, although
   * it gave up its remote connection.
   */
  function assertNoticed(noticedAt: number | undefined, rendererFrom: number): void {
    assert.ok(noticedAt !== undefined, 'The window did not log that its container does not run');
    assert.ok(noticedAt * 1000 <= NOTICE_WAIT_MS + 5_000, `The window logged it only after ${noticedAt} s`);
    assert.ok(running !== undefined && running.exitCode === null && running.signalCode === null, 'The second VS Code ended');
    assert.strictEqual(windowLoads(), 1, 'The window was loaded again');
    assert.match(connectionLines(rendererFrom), /\[Management +\].*Will give up now/, 'VS Code did not give up the remote connection');
  }

  it('a second VS Code opens the window of the devspace, which attaches', async function () {
    this.timeout(ATTACH_WAIT_MS + 60_000);
    console.log(`    the second VS Code: ${process.execPath} ${second.args.join(' ')}`);
    const installed = fs.existsSync(second.extensionsDir) ? fs.readdirSync(second.extensionsDir) : [];
    for (const id of ['ms-vscode-remote.remote-containers', EXTENSION_ID, 'nimblescape-test.devspaces-vscode-test-github']) {
      assert.ok(installed.some((name) => name.startsWith(`${id}-`)), `${second.extensionsDir} has no ${id} (scripts/install-attach-extensions.mjs)`);
    }
    assert.strictEqual(containerState(), 'running', 'The devspace does not run after the earlier runs');
    await startAndAttach(attaches());
    printLong(`    the log of the window:\n${withoutGitHub(secondLog())}`);
    assert.match(secondLog(), new RegExp(`The open pipeline of ${repository} runs before it connects\\.`));
    assert.match(secondLog(), new RegExp(`${repository} is ready in the container ${containerName}\\.`));
  });

  it('the window notices that its container stopped and stays open, and nothing starts the container again', async function () {
    this.timeout(WATCH_MS + NOTICE_WAIT_MS + 60_000);
    assert.ok(running, 'The second VS Code does not run');
    const from = secondLog().length;
    const rendererFrom = rendererLog().length;
    attachesAtStop = attaches();
    docker(['stop', containerName]);
    const { noticedAt, states } = await watchAfter('stop', from, rendererFrom);
    assertNoticed(noticedAt, rendererFrom);
    assert.deepStrictEqual(statesOnly(states), ['exited'], 'Something started the container again');
  });

  it('at the next open of the window, the open pipeline starts the stopped container, and the window attaches', async function () {
    this.timeout(QUIT_WAIT_MS + ATTACH_WAIT_MS + 90_000);
    await quitAndRelease();
    assert.strictEqual(containerState(), 'exited');
    const id = containerId();
    // The container does not run, so its lines are the ones at the stop.
    await startAndAttach(attachesAtStop);
    printLong(`    the log of the window:\n${withoutGitHub(secondLog())}`);
    assert.match(secondLog(), new RegExp(`State of ${repository}: container stopped,`));
    assert.match(secondLog(), new RegExp(`Starting the container of ${repository}\\.`));
    assert.strictEqual(containerState(), 'running');
    assert.strictEqual(containerId(), id, 'The open made a new container');
  });

  it('the window notices that its container was removed, and its next open makes a new container', async function () {
    this.timeout(WATCH_MS + NOTICE_WAIT_MS + QUIT_WAIT_MS + ATTACH_WAIT_MS + 120_000);
    assert.ok(running, 'The second VS Code does not run');
    const id = containerId();
    const from = secondLog().length;
    const rendererFrom = rendererLog().length;
    docker(['rm', '-f', containerName]);
    const { noticedAt, states } = await watchAfter('removal', from, rendererFrom);
    assertNoticed(noticedAt, rendererFrom);
    assert.deepStrictEqual(statesOnly(states), ['missing'], 'Something made the container again before the next open');
    await quitAndRelease();
    // A new container starts without the lines of the old one.
    await startAndAttach(0);
    printLong(`    the log of the window:\n${withoutGitHub(secondLog())}`);
    assert.match(secondLog(), new RegExp(`State of ${repository}: container missing,`));
    assert.strictEqual(containerState(), 'running');
    assert.notStrictEqual(containerId(), id, 'The container is the removed one');
  });
});
