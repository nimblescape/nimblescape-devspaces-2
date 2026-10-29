// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The connection of the relay end to end without SSH and without a Docker engine: the transport is a local `sh -s`
// behind a login that prints a greeting (in place of `ssh … sh -s`), on NodeProcessRunner.startBytes; the start script
// starts the real pipe loader with the entry startRelay and the worker's bundle as esbuild.mjs builds it (in place of
// `docker run`). The extension's side is the real RelayConnection, and a HelperChannel on its worker stream. The Engine
// API of the worker reaches a fake engine on a Unix socket of the test (engineSocketPlugin). The same with SSH and the
// real engine: test/docker/remoteHost.test.ts.
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sharedBundleOptions, workerBundleOptions } from '../../scripts/bundleOptions.mjs';
import { HelperChannel } from '../core/helperChannel/helperChannel';
import { OP_PROBE, parseProbeParams, parseProbeValue } from '../core/helperChannel/protocol';
import { bundleHash, loaderCommand } from '../core/loader/pipeLoader';
import { silentLogger, type Logger, type StartOptions, type StartedByteProcess } from '../core/ports';
import { NodeProcessRunner } from '../core/process';
import { RelayConnectionError } from '../core/relay/connection';
import { RELAY_ENTRY } from '../core/relay/frames';
import { RemoteShells } from '../core/relay/remoteShells';
import { openRelayConnection, type RelayTransport } from '../core/relay/transport';
import { engineSocketPlugin } from './engineSocket.testkit';

/** The identity of the fake engine. */
const ENGINE_ID = '3e9a1c55-7d2b-4f60-8a13-c4b5d6e7f809';
/** The tests below start real processes. */
const SLOW_TEST_MS = 30_000;

const describeUnix = process.platform === 'win32' ? describe.skip : describe;

/** The Engine API of the probe of the worker. */
function fakeEngine(socketPath: string) {
  const server = http.createServer((req, res) => {
    req.resume();
    const json = (value: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    const request = `${req.method} ${req.url}`;
    if (request === 'GET /version') return json({ Version: '27.1.0', ApiVersion: '1.47' });
    if (request === 'GET /info') return json({ ID: ENGINE_ID, DockerRootDir: '/var/lib/docker', Containers: 0 });
    res.writeHead(404).end();
  });
  return {
    listen: () => new Promise<void>((resolve) => server.listen(socketPath, resolve)),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function waitUntil(condition: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describeUnix('the connection of the relay through sh -s', () => {
  let dir = '';
  let script = '';
  let starts = 0;
  let engine: ReturnType<typeof fakeEngine>;
  const logLines: string[] = [];
  const logger: Logger = { ...silentLogger, info: (line) => logLines.push(line), warn: (line) => logLines.push(line) };
  // The login prints a greeting before the shell reads the start script.
  const transport: RelayTransport = { file: 'sh', args: ['-c', 'echo Welcome to the host; exec sh -s'], env: process.env };
  /** The transports that were started. */
  const started: StartedByteProcess[] = [];
  const nodeRunner = new NodeProcessRunner();
  const runner = {
    startBytes: (file: string, args: readonly string[], options?: StartOptions) => {
      const process = nodeRunner.startBytes(file, args, options);
      started.push(process);
      return process;
    },
  };
  /** A new login on the transport. */
  const start = () => ({ process: runner.startBytes(transport.file, transport.args, { env: transport.env }) });

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-connection-e2e-'));
    const socketPath = path.join(dir, 'engine.sock');
    engine = fakeEngine(socketPath);
    await engine.listen();
    const result = await esbuild.build({
      ...workerBundleOptions({ ...sharedBundleOptions({ production: true }), plugins: [engineSocketPlugin(socketPath)] }),
      write: false,
      logLevel: 'silent',
    });
    script = result.outputFiles[0].text;
  }, 60_000);

  afterAll(async () => {
    await engine?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** The command of the start script: the pipe loader with RELAY_ENTRY (a path of its own, as each `docker run --rm`). */
  function relayCommand(): string[] {
    const [node, ...loader] = loaderCommand({ path: path.join(dir, `script-${++starts}`, 'channel.js'), hash: bundleHash(script), entry: RELAY_ENTRY });
    expect(node).toBe('node');
    return [process.execPath, ...loader];
  }

  it('opens, runs a helper channel on the worker stream, and ends with it', { timeout: SLOW_TEST_MS }, async () => {
    logLines.length = 0;
    const connection = await openRelayConnection(start, relayCommand(), script, { logger, name: 'fake-host' });
    const process = started.at(-1)!;
    expect(logLines).toEqual(['The login on fake-host printed 20 bytes before the start; they are ignored.', 'The connection to fake-host is open.']);
    const worker = connection.openWorker();
    void worker.exited.then(() => connection.close('the worker ended'));
    const channel = await HelperChannel.open(worker, undefined, { logger, name: 'fake-host', openTimeoutMs: 20_000 });
    const probe = parseProbeValue(await channel.operation(OP_PROBE, parseProbeParams({})));
    expect(probe?.engine).toEqual({ id: ENGINE_ID, rootDir: '/var/lib/docker' });
    // The relay is the transport itself (`exec` replaced the shells), the worker its one process.
    const relayPid = process.pid!;
    const workers = childProcess.execFileSync('pgrep', ['-P', String(relayPid)], { encoding: 'utf8' }).trim().split('\n').map(Number);
    expect(workers).toHaveLength(1);
    // The close of the channel ends the worker, the connection, and then the relay, which exits by itself.
    channel.close();
    await expect(worker.exited).resolves.toEqual({ exitCode: 0 });
    await expect(process.exited).resolves.toEqual({ exitCode: 0 });
    expect(connection.isOpen).toBe(false);
    expect(alive(workers[0])).toBe(false);
  });

  it('starts on the login of the shell before the relay, after the checks on that shell', { timeout: SLOW_TEST_MS }, async () => {
    logLines.length = 0;
    const startsBefore = started.length;
    const shells = new RemoteShells({ logger, start });
    // The checks before the relay: commands of the shell on the one login.
    await expect(shells.run('fake-host', `printf '%s' "$PPID" >/dev/null; printf checked`)).resolves.toMatchObject({ exitCode: 0, stdout: 'checked' });
    await expect(shells.run('fake-host', 'cat', { input: 'input of a check\n' })).resolves.toMatchObject({ exitCode: 0, stdout: 'input of a check\n' });
    const connection = await openRelayConnection(start, relayCommand(), script, { logger, name: 'fake-host', takeOver: () => shells.takeOver('fake-host') });
    // One login for the checks and the connection.
    expect(started.length - startsBefore).toBe(1);
    expect(logLines).toEqual([
      'The login on fake-host printed 20 bytes before the shell answered; they are ignored.',
      'The shell on fake-host is open: one SSH login for the checks before the relay.',
      'The connection to fake-host starts on the SSH login of the shell before the relay.',
      'The connection to fake-host is open.',
    ]);
    const worker = connection.openWorker();
    const channel = await HelperChannel.open(worker, undefined, { logger, name: 'fake-host', openTimeoutMs: 20_000 });
    const probe = parseProbeValue(await channel.operation(OP_PROBE, parseProbeParams({})));
    expect(probe?.engine).toEqual({ id: ENGINE_ID, rootDir: '/var/lib/docker' });
    channel.close();
    await expect(worker.exited).resolves.toEqual({ exitCode: 0 });
    connection.close('the test ended');
    await expect(started.at(-1)!.exited).resolves.toEqual({ exitCode: 0 });
    shells.dispose();
  });

  it('a closed window stops the relay and its worker at once', { timeout: SLOW_TEST_MS }, async () => {
    const connection = await openRelayConnection(start, relayCommand(), script, { logger, name: 'fake-host' });
    const process = started.at(-1)!;
    const worker = connection.openWorker();
    const channel = await HelperChannel.open(worker, undefined, { logger, name: 'fake-host', openTimeoutMs: 20_000 });
    const relayPid = process.pid!;
    const workerPid = Number(childProcess.execFileSync('pgrep', ['-P', String(relayPid)], { encoding: 'utf8' }).trim());
    // The worker channel closes only its stream (the connection carries the Docker streams of the window too); then
    // RelayConnections.dispose stops the transport at once.
    channel.closeNow();
    expect(connection.isOpen).toBe(true);
    connection.killNow();
    await process.exited;
    await waitUntil(() => !alive(workerPid), 'the end of the worker');
    expect(connection.isOpen).toBe(false);
  });

  it('fails with the error output of the command that should start the relay', { timeout: SLOW_TEST_MS }, async () => {
    const refusal = 'docker: Error response from daemon: Conflict. The container name "/w-worker1" is already in use by container "abc".';
    const command = [process.execPath, '-e', `process.stderr.write(${JSON.stringify(`${refusal}\nSee 'docker run --help'.\n`)}); process.exit(125)`];
    const opening = openRelayConnection(start, command, script, { logger, name: 'fake-host' });
    await expect(opening).rejects.toBeInstanceOf(RelayConnectionError);
    await expect(opening).rejects.toThrow(`The connection to fake-host could not be opened: it ended (${refusal}\nSee 'docker run --help'.)`);
  });
});
