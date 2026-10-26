// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The match jobs of the sidebar: runMatchJob places each name as matchRepositoryGroup does, and the runner runs them in
// the real worker bundle (as esbuild.mjs builds dist/groupsPreviewWorker.js) and stops a regular expression whose
// matching takes seconds after the time limit.
import { buildSync } from 'esbuild';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Worker } from 'worker_threads';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { GROUP_MATCH_START_LIMIT_MS, GROUP_MATCH_TIME_LIMIT_MS, GroupMatchWorkerRunner, runMatchJob, type GroupMatchMessage } from './groupMatcher';
import { matchRepositoryGroup, parseRepositoryGroups } from './repositoryGroups';

let outDir: string;
let bundle: string;
let runner: GroupMatchWorkerRunner | undefined;

beforeAll(() => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-test-'));
  bundle = path.join(outDir, 'groupsPreviewWorker.js');
  // Same options as esbuild.mjs.
  buildSync({
    entryPoints: [path.join(__dirname, 'groupsPreviewWorker.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    outfile: bundle,
    logLevel: 'silent',
    define: { __DEVCONTAINER_CLI_VERSION__: JSON.stringify('0.0.0') },
  });
});

afterEach(() => {
  runner?.dispose();
  runner = undefined;
});

afterAll(() => {
  fs.rmSync(outDir, { recursive: true, force: true });
});

/**
 * A worker script in the test folder that answers each job with `answer`: JavaScript with `job`, `post(message)` and
 * `sleep(ms)` (blocks the worker thread).
 */
function scriptWorker(name: string, answer: string): string {
  const file = path.join(outDir, name);
  fs.writeFileSync(
    file,
    [
      "const { parentPort } = require('worker_threads');",
      'const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);',
      'const post = (message) => parentPort.postMessage(message);',
      `parentPort.on('message', (job) => { ${answer} });`,
      '',
    ].join('\n'),
  );
  return file;
}

/** 2^n steps for a name of n word characters that does not match: seconds for about 27 characters. */
const SLOW = String.raw`^(\w+)+$`;
const SLOW_NAME = `${'a'.repeat(32)}-`;

describe('runMatchJob', () => {
  it('places each name under the first entry that matches it, as matchRepositoryGroup does, with a probe before each entry', () => {
    const entries = ['(', '^(web)-(.+)$', { name: 'Apps', pattern: '^(.+)-(app)$' }, '^(.+)$'];
    const names = ['web-shop', 'shop-app', 'web-app', 'api', 'web-shop'];
    const messages: GroupMatchMessage[] = [];
    runMatchJob({ kind: 'match', id: 7, entries, names }, (message) => messages.push(message));
    expect(messages.slice(0, -1)).toEqual([1, 2, 3].map((entryIndex) => ({ type: 'probe', id: 7, entryIndex })));
    const last = messages.at(-1);
    expect(last).toMatchObject({ type: 'places', id: 7, failures: [] });
    const places = new Map(last?.type === 'places' ? last.places : []);
    const { patterns } = parseRepositoryGroups(entries);
    expect([...places.keys()]).toEqual(['web-shop', 'shop-app', 'web-app', 'api']);
    for (const name of places.keys()) {
      const match = matchRepositoryGroup(patterns, name);
      expect(places.get(name), name).toEqual(match ? { index: match.pattern.index, levels: match.levels, label: match.label } : null);
    }
    expect(places.get('web-app')).toEqual({ index: 1, levels: ['web'], label: 'app' });
  });

  it('gives null for a name that no entry matches, and the failure of an entry that throws', () => {
    const original = RegExp.prototype.exec;
    const exec = vi.spyOn(RegExp.prototype, 'exec').mockImplementation(function (this: RegExp, text: string) {
      if (this.source === 'boom') throw new RangeError('Maximum call stack size exceeded');
      return original.call(this, text);
    });
    const messages: GroupMatchMessage[] = [];
    try {
      runMatchJob({ kind: 'match', id: 1, entries: ['boom', '^(web)-(.+)$'], names: ['api', 'web-shop'] }, (message) => messages.push(message));
    } finally {
      exec.mockRestore();
    }
    expect(messages.at(-1)).toEqual({
      type: 'places',
      id: 1,
      places: [
        ['api', null],
        ['web-shop', { index: 1, levels: ['web'], label: 'shop' }],
      ],
      failures: [[0, 'Maximum call stack size exceeded']],
    });
  });
});

describe('GroupMatchWorkerRunner', () => {
  it('places the names in the worker thread', async () => {
    runner = new GroupMatchWorkerRunner(bundle);
    const run = await runner.run(['^(web)-(.+)$'], ['web-shop', 'api']);
    expect(run).toEqual({
      places: new Map([
        ['web-shop', { index: 0, levels: ['web'], label: 'shop' }],
        ['api', null],
      ]),
      failures: new Map(),
    });
  });

  it('stops a regular expression that is too slow, names the entry, and runs the next job in a new worker', async () => {
    runner = new GroupMatchWorkerRunner(bundle, 300);
    const started = Date.now();
    expect(await runner.run(['^x-', SLOW], [SLOW_NAME])).toEqual({ tooSlow: true, slowEntry: 1 });
    // Without the limit, the expression would take minutes for this name.
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await runner.run(['^(a+)-$'], [SLOW_NAME])).toMatchObject({ places: new Map([[SLOW_NAME, { index: 0, levels: [], label: 'a'.repeat(32) }]]) });
  });

  it('counts the start of a new worker against its own limit, not against the time limit of the job', async () => {
    // A worker that never answers: the start limit ends the job as failed, not as too slow.
    const silent = path.join(outDir, 'silent.js');
    fs.writeFileSync(silent, "require('worker_threads').parentPort.on('message', () => undefined);\n");
    runner = new GroupMatchWorkerRunner(silent, 50, 300);
    const started = Date.now();
    expect(await runner.run(['^a$'], ['a'])).toEqual({ failed: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it('gives each entry its own time limit, so a job with many entries can take longer than one limit', async () => {
    // Eight entries of 250 ms each: 2000 ms for the job, but each entry stays far below the limit of 1500 ms.
    const entries = ['^a$', '^b$', '^c$', '^d$', '^e$', '^f$', '^g$', '^h$'];
    const steady = scriptWorker(
      'steady.js',
      "for (const entryIndex of job.entries.keys()) { post({ type: 'probe', id: job.id, entryIndex }); sleep(250); }" +
        " post({ type: 'places', id: job.id, places: job.names.map((name) => [name, null]), failures: [] });",
    );
    runner = new GroupMatchWorkerRunner(steady, 1500);
    const started = Date.now();
    expect(await runner.run(entries, ['x'])).toEqual({ places: new Map([['x', null]]), failures: new Map() });
    expect(Date.now() - started).toBeGreaterThan(1500);
  }, 10_000);

  it('does not end a job at the start limit when its first entry already runs', async () => {
    // The extension host is busy beyond the start limit while the worker already runs the first entry: the probe still
    // waits in the queue when the start limit is due.
    const late = scriptWorker(
      'late.js',
      "if (job.names.length > 0) { post({ type: 'probe', id: job.id, entryIndex: 0 }); sleep(2000); }" +
        " post({ type: 'places', id: job.id, places: [], failures: [] });",
    );
    const current = new GroupMatchWorkerRunner(late, 5000);
    runner = current;
    // The worker runs after this job, which starts it with the start limit of 10 seconds (a loaded runner starts a
    // worker slowly); the next job has a start limit of 500 ms.
    expect(await current.run(['^a$'], [])).toEqual({ places: new Map(), failures: new Map() });
    (current as unknown as { startLimitMs: number }).startLimitMs = 500;
    const job = current.run(['^a$'], ['a']);
    // The job is posted; then the extension host is busy for longer than the start limit.
    await new Promise((resolve) => setImmediate(resolve));
    const busyUntil = Date.now() + 1500;
    while (Date.now() < busyUntil);
    expect(await job).toEqual({ places: new Map(), failures: new Map() });
  }, 20_000);

  it('ends the running job and the queued jobs at dispose, and runs none after it', async () => {
    const current = new GroupMatchWorkerRunner(bundle, 5000);
    runner = current;
    const slow = current.run([SLOW], [SLOW_NAME]);
    const queued = current.run(['^a$'], ['a']);
    // Time for the worker to start and to run the slow expression.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const started = Date.now();
    current.dispose();
    expect(await slow).toEqual({ failed: true });
    expect(await queued).toEqual({ failed: true });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await current.run(['^a$'], ['a'])).toEqual({ failed: true });
  });

  it('keeps the worker for the next job, ends it after the idle time, and starts a new one for the next job', async () => {
    const current = new GroupMatchWorkerRunner(bundle, GROUP_MATCH_TIME_LIMIT_MS, GROUP_MATCH_START_LIMIT_MS, 200);
    runner = current;
    const workerOf = () => (current as unknown as { worker?: Worker }).worker;
    const placed = (name: string, label: string) => ({ places: new Map([[name, { index: 0, levels: ['web'], label }]]) });
    expect(await current.run(['^(web)-(.+)$'], ['web-shop'])).toMatchObject(placed('web-shop', 'shop'));
    const first = workerOf();
    expect(first).toBeDefined();
    expect(await current.run(['^(web)-(.+)$'], ['web-app'])).toMatchObject(placed('web-app', 'app'));
    expect(workerOf()).toBe(first);
    await new Promise((resolve) => first?.once('exit', resolve));
    expect(workerOf()).toBeUndefined();
    expect(await current.run(['^(web)-(.+)$'], ['web-api'])).toMatchObject(placed('web-api', 'api'));
    expect(workerOf()).toBeDefined();
    expect(workerOf()).not.toBe(first);
  });

  it('reports a worker that cannot start', async () => {
    runner = new GroupMatchWorkerRunner(path.join(outDir, 'missing.js'));
    expect(await runner.run(['^a$'], ['a'])).toEqual({ failed: true });
  });
});
