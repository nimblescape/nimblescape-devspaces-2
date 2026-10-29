// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The relay end to end without a Docker engine: the real pipe loader with the entry startRelay and the worker's bundle
// as esbuild.mjs builds it, in a Node.js process of this computer, as the first program of a worker container would
// run. The extension's side is the Mux of src/core/relay on the standard input and output of that process. The Docker
// streams of the relay and the Engine API of the worker reach a fake engine on a Unix socket of the test (the bundle is
// built with that socket in place of /var/run/docker.sock, engineSocketPlugin). Checked above all: every byte value
// passes unchanged (the pipe loader hands the input over as bytes), and the worker starts from the stored file without a
// second bundle.
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sharedBundleOptions, workerBundleOptions } from '../../scripts/bundleOptions.mjs';
import { CHANNEL_PROTOCOL_VERSION, OP_PROBE, encodeMessage, parseServerMessage, type ServerMessage } from '../core/helperChannel/protocol';
import { bundleHash, encodeBundle, loaderCommand } from '../core/loader/pipeLoader';
import { RELAY_ENTRY } from '../core/relay/frames';
import { Mux, type MuxStream } from '../core/relay/mux';
import { engineSocketPlugin } from './engineSocket.testkit';

/** The identity of the fake engine. */
const ENGINE_ID = '0f6c2a8e-3b4d-4c5e-9f70-81a2b3c4d5e6';
/** The tests below start real processes. */
const SLOW_TEST_MS = 30_000;

const describeUnix = process.platform === 'win32' ? describe.skip : describe;

/** More than the credit of a stream. */
const BIG_ANSWER = Buffer.alloc(1024 * 1024, 7);

/**
 * The Engine API of the probe of the worker, `POST /echo`, which answers with the bytes of its body, and `GET /big`,
 * which answers with BIG_ANSWER.
 */
function fakeEngine(socketPath: string) {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const json = (value: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
      const request = `${req.method} ${req.url}`;
      if (request === 'GET /version') return json({ Version: '27.1.0', ApiVersion: '1.47' });
      if (request === 'GET /info') return json({ ID: ENGINE_ID, DockerRootDir: '/var/lib/docker', Containers: 0 });
      const body = Buffer.concat(chunks);
      if (request === 'GET /big') return res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': BIG_ANSWER.length }).end(BIG_ANSWER);
      if (request === 'POST /echo') return res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length }).end(body);
      res.writeHead(404).end();
    });
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

/** The bytes of a stream as they come (taken at once), and its end. */
function collect(stream: MuxStream): { data: () => Buffer; ended: () => boolean } {
  const chunks: Buffer[] = [];
  let ended = false;
  stream.onData((chunk) => {
    chunks.push(chunk);
    stream.consumed(chunk.length);
  });
  stream.onEnd(() => (ended = true));
  return { data: () => Buffer.concat(chunks), ended: () => ended };
}

describeUnix('the relay in a Node.js process', () => {
  let dir = '';
  let script = '';
  let starts = 0;
  let engine: ReturnType<typeof fakeEngine>;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-relay-e2e-'));
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

  /**
   * The pipe loader with RELAY_ENTRY in a process of its own (a path of its own per start, as each `docker run --rm` has
   * a file system of its own), the bundle written as its first line, and the extension's side on its output.
   */
  function start() {
    const [node, ...loader] = loaderCommand({ path: path.join(dir, `script-${++starts}`, 'channel.js'), hash: bundleHash(script), entry: RELAY_ENTRY });
    expect(node).toBe('node');
    const child = childProcess.spawn(process.execPath, loader, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.stdin.on('error', () => {});
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    const closes: { reason: string; failed: boolean }[] = [];
    const mux = new Mux({
      side: 'extension',
      onClose: (reason, failed) => closes.push({ reason, failed }),
      link: {
        write: (chunk) => child.stdin.write(chunk),
        onDrain: (listener) => child.stdin.once('drain', listener),
        end: () => child.stdin.end(),
      },
    });
    child.stdout.on('data', (chunk: Buffer) => mux.input(chunk));
    child.stdout.on('end', () => mux.inputEnded());
    child.stdin.write(encodeBundle(script));
    return { child, mux, exited, closes, stderr: () => stderr };
  }

  it('passes every byte value through a Docker stream to the engine and back', { timeout: SLOW_TEST_MS }, async () => {
    const { mux, exited, stderr } = start();
    // Every byte value, text of several bytes per character, and more than one window of the stream.
    const piece = Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, value) => value)), Buffer.from('äü€😀\r\n', 'utf8')]);
    const body = Buffer.concat(Array.from({ length: 1500 }, () => piece));
    const stream = mux.open('docker');
    const answer = collect(stream);
    stream.write(Buffer.from(`POST /echo HTTP/1.1\r\nHost: docker\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`, 'latin1'));
    for (let at = 0; at < body.length; at += 40_000) {
      if (!stream.write(body.subarray(at, at + 40_000))) await new Promise<void>((resolve) => stream.onDrain(resolve));
    }
    await waitUntil(answer.ended, 'the end of the answer');
    const text = answer.data();
    const head = text.indexOf('\r\n\r\n');
    expect(text.subarray(0, head).toString('latin1')).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
    expect(text.subarray(head + 4).equals(body)).toBe(true);
    stream.end();
    await waitUntil(() => mux.streamCount === 0, 'the end of the stream');
    mux.close('the test ended');
    expect(await exited).toEqual({ code: 0, signal: null });
    expect(stderr()).toBe('');
  });

  it('starts the worker from the stored file on a worker stream, and ends it with its input', { timeout: SLOW_TEST_MS }, async () => {
    const { child, mux, exited, stderr } = start();
    const stream = mux.open('worker');
    const output = collect(stream);
    const messages = (): ServerMessage[] =>
      output
        .data()
        .toString('utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => parseServerMessage(line) as ServerMessage);
    stream.write(Buffer.from(encodeMessage({ t: 'hello', protocol: CHANNEL_PROTOCOL_VERSION }), 'utf8'));
    stream.write(Buffer.from(encodeMessage({ t: 'op', id: 1, op: OP_PROBE, params: {} }), 'utf8'));
    await waitUntil(() => messages().some((message) => message.t === 'result'), 'the answer to the probe');
    const [hello] = messages();
    expect(hello).toMatchObject({ t: 'hello', protocol: CHANNEL_PROTOCOL_VERSION });
    expect(hello.t === 'hello' && hello.ops).toContain(OP_PROBE);
    expect(messages().find((message) => message.t === 'result')).toMatchObject({ t: 'result', id: 1, ok: true, value: { engine: { id: ENGINE_ID } } });
    // The worker is a process of the relay, not the relay itself.
    const workers = childProcess.execFileSync('pgrep', ['-P', String(child.pid)], { encoding: 'utf8' }).trim().split('\n').map(Number);
    expect(workers).toHaveLength(1);
    // The connection ends: the relay ends the worker and exits after it.
    mux.close('the test ended');
    expect(await exited).toEqual({ code: 0, signal: null });
    expect(() => process.kill(workers[0], 0)).toThrow();
    expect(stderr()).toBe('');
  });

  it('at SIGTERM, exits after the frames that wait in its output went', { timeout: SLOW_TEST_MS }, async () => {
    const { child, mux, exited, closes, stderr } = start();
    // The credit of 8 streams is more than the buffers of the pipe (a socket pair of the kernel) and of the reader.
    const answers = Array.from({ length: 8 }, () => {
      const stream = mux.open('docker');
      stream.write(Buffer.from('GET /big HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n\r\n', 'latin1'));
      return collect(stream);
    });
    await waitUntil(() => answers.every((answer) => answer.data().length > 0), 'the start of the answers');
    // The extension reads nothing more: the pipe fills, and frames wait in the output of the relay.
    child.stdout.pause();
    await new Promise((resolve) => setTimeout(resolve, 500));
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 500));
    child.stdout.resume();
    expect(await exited).toEqual({ code: 0, signal: null });
    await waitUntil(() => closes.length > 0, 'the end of the connection');
    // Whole frames up to the end: no frame was cut.
    expect(closes).toEqual([{ reason: 'the connection ended', failed: false }]);
    expect(stderr()).toBe('devspace relay: stopped by SIGTERM\n');
  });
});
