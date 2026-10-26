// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The helper channel end to end without a Docker engine: the real loader (the pipe loader, with a script path in a
// temporary folder) and the script bundled as esbuild.mjs does, in a Node.js process of this computer. The extension's
// side is the real HelperChannel on NodeProcessRunner.start. Checked above all: the script ends by itself when the
// connection is lost (the end of its input, silence), and ends the calls that still run before. The same with the real
// container: test/docker/helperChannel.test.ts. A running call is the prune of the operation `sweep`. The probe and the
// sweep go over the Engine API (the port of the worker, no Docker CLI), so a fake engine answers on a Unix socket of
// the test (the bundle of the worker is built with that socket in place of /var/run/docker.sock, as in
// batch.e2e.test.ts) and holds the prune; a `docker` on PATH only records that no call reaches it.
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as esbuild from 'esbuild';
import { sharedBundleOptions, workerBundleOptions } from '../../scripts/bundleOptions.mjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HelperChannel } from '../core/helperChannel/helperChannel';
import { CHANNEL_ENTRY, OP_PROBE, OP_SWEEP, SWEEP_FILTERS, encodeMessage, parseProbeParams, parseProbeValue, parseServerMessage, parseSweepParams } from '../core/helperChannel/protocol';
import { LOADER_EXIT_CODE, bundleHash, encodeBundle, loaderCommand } from '../core/loader/pipeLoader';
import { silentLogger, type Logger, type StartedProcess } from '../core/ports';
import { NodeProcessRunner } from '../core/process';
import { engineSocketPlugin } from './engineSocket.testkit';

// The worker runs no `docker` process (the probe and the sweep go over the Engine API); a call that reached this
// `docker` on PATH would be recorded.
const FAKE_DOCKER = `#!/usr/bin/env node
require('fs').appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stderr.write('unexpected\\n');
process.exit(1);
`;

/** The identity of the fake engine. */
const ENGINE_ID = '7b1c7a44-2f0e-4d38-9d1d-3a8f7b0e8c11';
/** The request of the prune of the sweep, with its two filters as the Engine API gets them. */
const PRUNE = `POST /containers/prune?filters=${encodeURIComponent(JSON.stringify(SWEEP_FILTERS))}`;

/**
 * The Engine API as the probe and the sweep of the worker use it: the version, the identity (`/info`), and the prune,
 * which it never answers: a call that runs until the worker ends it. `closed`: the requests whose connection ended
 * before an answer.
 */
function fakeEngine(socketPath: string) {
  const requests: string[] = [];
  const closed: string[] = [];
  const server = http.createServer((req, res) => {
    const request = `${req.method} ${req.url}`;
    requests.push(request);
    req.resume();
    const json = (status: number, value: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    if (request === 'GET /version') return json(200, { Version: '27.1.0', ApiVersion: '1.47' });
    if (request === 'GET /info') return json(200, { ID: ENGINE_ID, DockerRootDir: '/var/lib/docker', Containers: 3 });
    if (request === PRUNE) {
      res.on('close', () => {
        if (!res.writableEnded) closed.push(request);
      });
      return;
    }
    json(500, { message: `unexpected: ${request}` });
  });
  return {
    requests,
    closed,
    listen: () => new Promise<void>((resolve) => server.listen(socketPath, resolve)),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The tests below take a few seconds (the silence). */
const SLOW_TEST_MS = 30_000;

const describeUnix = process.platform === 'win32' ? describe.skip : describe;

async function waitUntil(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describeUnix('the helper channel script in a Node.js process', () => {
  let dir = '';
  let script = '';
  let startCount = 0;
  let env: NodeJS.ProcessEnv = {};
  const runner = new NodeProcessRunner();
  const logLines: string[] = [];
  const logger: Logger = { ...silentLogger, info: (line) => logLines.push(line), warn: (line) => logLines.push(line) };
  let engine: ReturnType<typeof fakeEngine>;
  /** How many prunes reached the fake engine. */
  const prunes = () => engine.requests.filter((request) => request === PRUNE).length;

  /** The calls that reached the `docker` on PATH (expected: none). */
  const calls = (): string[][] => {
    const file = path.join(dir, 'calls.log');
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as string[]);
  };

  function start(silenceMs = 60_000): { process: StartedProcess; ended: () => boolean } {
    // The path, the hash and the entry are arguments of the pipe loader, as in channelRunArgs. A path of its own per
    // start, as each `docker run --rm` has a file system of its own: a stored script would be resumed.
    const [node, ...loader] = loaderCommand({ path: path.join(dir, `script-${++startCount}`, 'channel.js'), hash: bundleHash(script), entry: CHANNEL_ENTRY });
    expect(node).toBe('node');
    const process = runner.start('node', loader, { env: { ...env, DEVSPACE_CHANNEL_SILENCE_MS: String(silenceMs) } });
    let ended = false;
    void process.exited.then(() => (ended = true));
    return { process, ended: () => ended };
  }

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-channel-'));
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.writeFileSync(path.join(dir, 'bin', 'docker'), FAKE_DOCKER, { mode: 0o755 });
    env = { ...process.env, PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`, FAKE_DOCKER_LOG: path.join(dir, 'calls.log') };
    // The fake engine of the worker.
    const socketPath = path.join(dir, 'engine.sock');
    engine = fakeEngine(socketPath);
    await engine.listen();
    const result = await esbuild.build({
      // The worker as a production build of esbuild.mjs bundles it, with the Engine API on the socket of the fake
      // engine.
      ...workerBundleOptions({ ...sharedBundleOptions({ production: true }), plugins: [engineSocketPlugin(socketPath)] }),
      write: false,
      logLevel: 'silent',
    });
    script = result.outputFiles[0].text;
  });

  afterAll(async () => {
    await engine?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // The worker as esbuild.mjs bundles it carries no operation of a test (the `holdBatch` of batchE2eWorker.testkit.ts,
  // whose parameters are not checked).
  it('bundles no operation of a test', () => {
    expect(script).not.toContain('holdBatch');
    expect(script).not.toContain('testkit');
  });

  // An explicit time limit (above the default of 5 s) for its real process spawns. The probe over the Engine API, its
  // requests and its progress line.
  it('opens, answers the probe over the Engine API, and ends when it is closed', { timeout: SLOW_TEST_MS }, async () => {
    const { process, ended } = start();
    const channel = await HelperChannel.open(process, script, { logger, name: 'fake-host', openTimeoutMs: 20_000 });
    // The operations of the worker: the flows that run in the worker, the probe, the refresh, and the sweep of
    // never-started channel containers; no relay operation.
    expect(channel.operations).toEqual(['delete', 'deleteCheck', 'heartbeat', 'listConfigurations', 'monitorEnsure', 'monitorRunNow', 'open', 'prepare', 'probe', 'reconcile', 'recordGitState', 'refresh', 'stop', 'sweep', 'tokenRemove', 'windowState']);
    const before = engine.requests.length;
    // With the identity of the engine as its values.
    expect(parseProbeValue(await channel.operation(OP_PROBE, parseProbeParams({})))).toEqual({
      serverVersion: '27.1.0',
      detail: 'Docker 27.1.0',
      engine: { id: ENGINE_ID, rootDir: '/var/lib/docker' },
    });
    expect(engine.requests.slice(before)).toEqual(['GET /version', 'GET /info']);
    expect(logLines.some((line) => /^\[fake-host\] probe#\d+: probe$/.test(line))).toBe(true);
    expect(calls()).toEqual([]);
    channel.close();
    await waitUntil(ended, 'the end of the script');
  });

  // The held prune of `sweep` is a request to the fake engine, whose connection the worker ends.
  it('ends when its input ends: a running call to the engine ends', { timeout: SLOW_TEST_MS }, async () => {
    const { process, ended } = start();
    const channel = await HelperChannel.open(process, script, { logger, name: 'fake-host', openTimeoutMs: 20_000 });
    const [started, closed] = [prunes(), engine.closed.length];
    const running = channel.operation(OP_SWEEP, parseSweepParams({}));
    await waitUntil(() => prunes() > started, 'the start of the call');
    // As when the connection closes: the input of the script ends.
    process.end();
    await expect(running).rejects.toThrow();
    await waitUntil(ended, 'the end of the script');
    await waitUntil(() => engine.closed.length > closed, 'the end of the call');
    expect(engine.closed.slice(closed)).toEqual([PRUNE]);
    expect(calls()).toEqual([]);
  });

  // The held prune of `sweep` is a request to the fake engine, which the worker ends by the cancel of its operation,
  // answered before the exit.
  it('ends after the silence when the connection hangs (no ping, the input stays open)', { timeout: SLOW_TEST_MS }, async () => {
    const { process, ended } = start(5_000);
    let stdout = '';
    process.onStdout((text) => (stdout += text));
    const [started, closed] = [prunes(), engine.closed.length];
    process.write(encodeBundle(script));
    process.write(encodeMessage({ t: 'hello', protocol: 1 }));
    process.write(encodeMessage({ t: 'op', id: 1, op: OP_SWEEP, params: {} }));
    await waitUntil(() => stdout.includes('"t":"hello"'), 'the answer to hello');
    await waitUntil(() => prunes() > started, 'the start of the call');
    // Nothing more is written and the input stays open.
    await waitUntil(ended, 'the end of the script after the silence');
    await waitUntil(() => engine.closed.length > closed, 'the end of the call');
    expect(engine.closed.slice(closed)).toEqual([PRUNE]);
    const results = stdout.split('\n').map((line) => parseServerMessage(line)).filter((message) => message?.t === 'result');
    expect(results).toEqual([{ t: 'result', id: 1, ok: false, error: { code: 'cancelled', message: 'The operation was cancelled.' }, cancelled: true, timedOut: false }]);
    expect(calls()).toEqual([]);
    process.end();
  });

  // An explicit time limit (above the default of 5 s) for its real process spawns.
  it('the loader exits when the input ends before the script', { timeout: SLOW_TEST_MS }, async () => {
    const { process, ended } = start();
    process.end();
    await waitUntil(ended, 'the end of the loader');
    expect(await process.exited).toEqual({ exitCode: LOADER_EXIT_CODE });
  });

  // The loader checks the script against the hash of its command. An explicit time limit (above the default of 5 s) for
  // its real process spawns.
  it('the loader exits when the script does not match its hash, and starts nothing', { timeout: SLOW_TEST_MS }, async () => {
    const { process, ended } = start();
    let stderr = '';
    process.onStderr((text) => (stderr += text));
    process.write(encodeBundle(`${script}\n// changed`));
    await waitUntil(ended, 'the end of the loader');
    expect(await process.exited).toEqual({ exitCode: LOADER_EXIT_CODE });
    expect(stderr).toBe('devspace loader: the bundle does not match its hash\n');
  });
});
