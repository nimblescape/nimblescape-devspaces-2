// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// "Remove Devspaces from This Docker Engine…": the inventory and the removal of what Devspaces keeps on an engine, with
// the Docker CLI of the extension (a BootstrapDocker over a fake process runner, so the calls and their log lines are
// the real ones).
import { describe, expect, it } from 'vitest';
import type { Logger, ProcessRunner, RunOptions, RunResult } from '../ports';
import { BootstrapDocker } from './bootstrapDocker';
import { isReadOnlyDockerCall } from './dockerCli';
import { SHARED_VOLUMES, engineInventory, inventoryIsEmpty, itemText, manualCommand, removeEngineInfrastructure, uninstallCommands, type RemovalOptions } from './engineRemoval';

const COMPUTER = 'a'.repeat(32);
const OTHER_COMPUTER = 'b'.repeat(32);
const KNOWN = '11111111-2222-4333-8444-555555555555';
const UNKNOWN = '99999999-2222-4333-8444-555555555555';

function ok(stdout = ''): RunResult {
  return { exitCode: 0, stdout, stderr: '', timedOut: false };
}

function fail(stderr: string): RunResult {
  return { exitCode: 1, stdout: '', stderr, timedOut: false };
}

const lines = (values: unknown[]): string => values.map((value) => `${JSON.stringify(value)}\n`).join('');

/** The engine of a test: its containers (by label), volumes and images, which the removal calls change. */
interface Engine {
  containers: Array<{ id: string; name: string; labels: Record<string, string> }>;
  volumes: Array<{ name: string; labels?: Record<string, string> }>;
  images: Array<{ id: string; tags: string[] }>;
  /** A call whose `docker <args>` starts with a key gets that result instead. */
  answers: Map<string, RunResult | Error>;
}

function labelText(labels: Record<string, string> = {}): string {
  return Object.entries(labels)
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
}

/** A process runner that plays a Docker engine: `ps`, `volume ls`, `image ls`, and the removals. */
class FakeEngine implements ProcessRunner {
  readonly calls: string[][] = [];
  readonly engine: Engine;
  constructor(engine: Partial<Engine> = {}) {
    this.engine = { containers: [], volumes: [], images: [], answers: new Map(), ...engine };
  }

  async run(_file: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    this.calls.push([...args]);
    if (options.signal?.aborted) {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      throw error;
    }
    const text = args.join(' ');
    for (const [key, answer] of this.engine.answers) {
      if (!text.startsWith(key)) continue;
      if (answer instanceof Error) throw answer;
      return answer;
    }
    const { engine } = this;
    const filter = (flag: string): string | undefined => {
      const index = args.indexOf(flag);
      return index < 0 ? undefined : args[index + 1];
    };
    if (args[0] === 'ps') {
      const label = filter('--filter')?.replace(/^label=/, '') ?? '';
      return ok(lines(engine.containers.filter((c) => label in c.labels).map((c) => ({ ID: c.id, Names: c.name, Labels: labelText(c.labels) }))));
    }
    if (args[0] === 'volume' && args[1] === 'ls') {
      const value = filter('--filter') ?? '';
      const matches = value.startsWith('label=')
        ? (v: Engine['volumes'][number]) => value.slice('label='.length) in (v.labels ?? {})
        : (v: Engine['volumes'][number]) => v.name.includes(value.slice('name='.length));
      return ok(lines(engine.volumes.filter(matches).map((v) => ({ Name: v.name, Labels: labelText(v.labels) }))));
    }
    if (args[0] === 'image' && args[1] === 'ls') {
      // Every image of the test has the helper label; the dangling list only the images without a tag.
      const dangling = args.includes('dangling=true');
      const rows = engine.images
        .filter((image) => !dangling || image.tags.length === 0)
        .flatMap((image) =>
          image.tags.length === 0
            ? [{ ID: image.id, Repository: '<none>', Tag: '<none>', CreatedAt: 'x' }]
            : image.tags.map((tag) => ({ ID: image.id, Repository: tag.split(':')[0], Tag: tag.split(':')[1], CreatedAt: 'x' })),
        );
      return ok(lines(rows));
    }
    if (args[0] === 'rm') {
      const index = engine.containers.findIndex((c) => c.id === args[2]);
      if (index < 0) return fail(`Error response from daemon: No such container: ${args[2]}`);
      engine.containers.splice(index, 1);
      return ok(`${args[2]}\n`);
    }
    if (args[0] === 'image' && args[1] === 'rm') {
      const reference = args[2];
      const image = engine.images.find((candidate) => candidate.id === reference || candidate.tags.includes(reference));
      if (!image) return fail(`Error response from daemon: No such image: ${reference}`);
      if (image.id === reference) engine.images.splice(engine.images.indexOf(image), 1);
      else {
        image.tags = image.tags.filter((tag) => tag !== reference);
        if (image.tags.length === 0) engine.images.splice(engine.images.indexOf(image), 1);
      }
      return ok(`Untagged: ${reference}\n`);
    }
    if (args[0] === 'volume' && args[1] === 'rm') {
      const index = engine.volumes.findIndex((v) => v.name === args[2]);
      if (index < 0) return fail(`Error response from daemon: get ${args[2]}: no such volume`);
      engine.volumes.splice(index, 1);
      return ok(`${args[2]}\n`);
    }
    return fail(`unexpected call: docker ${text}`);
  }
}

function recordingLogger(): Logger & { lines: string[] } {
  const all: string[] = [];
  return {
    lines: all,
    info: (line: string) => void all.push(`info ${line}`),
    warn: (line: string) => void all.push(`warn ${line}`),
    error: (line: string) => void all.push(`error ${line}`),
    output: () => {},
    show: () => {},
  } as unknown as Logger & { lines: string[] };
}

function dockerOf(runner: FakeEngine): BootstrapDocker {
  // The Docker CLI's own log lines are not part of these tests.
  const quiet = { info: () => {}, warn: () => {}, error: () => {}, output: () => {}, show: () => {} } as unknown as Logger;
  return new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, quiet, 'linux');
}

/** A full engine: a Monitor of this computer, a worker and a batch helper, the helper image with both tags, an old one, the volumes. */
function fullEngine(): Partial<Engine> {
  return {
    containers: [
      { id: 'm1', name: 'devspaces-monitor', labels: { 'nimblescape.devspaces.monitor': 'abc', 'nimblescape.devspaces.monitor-owner': COMPUTER } },
      { id: 'w1', name: 'devspaces-api-worker1', labels: { 'nimblescape.devspaces.worker-run': 'true' } },
      { id: 'b1', name: 'devspaces-batch-1', labels: { 'nimblescape.devspaces.worker-run': 'true' } },
      { id: 'd1', name: 'devspaces-acme-api-1111', labels: { 'nimblescape.devspaces.id': KNOWN } },
    ],
    volumes: [
      { name: 'devspaces-monitor' },
      { name: 'devspaces-worker-cache' },
      { name: 'devspaces-vscode' },
      { name: 'devspaces-acme-api-1111', labels: { 'nimblescape.devspaces.id': KNOWN } },
    ],
    images: [
      { id: 'sha256:new', tags: ['devspaces-monitor:0123456789ab', 'devspaces-worker:0123456789ab'] },
      { id: 'sha256:old', tags: [] },
      // A tag of another repository on a helper image: it stays, and with it the image.
      { id: 'sha256:mine', tags: ['devspaces-worker:aaaaaaaaaaaa', 'my-copy:1'] },
    ],
  };
}

function options(logger: Logger, overrides: Partial<RemovalOptions> = {}): RemovalOptions {
  return { answers: async () => true, logger, ...overrides };
}

describe('engineInventory', () => {
  it('lists the Monitor, the helper containers and images, the shared volumes, with calls that only read', async () => {
    const runner = new FakeEngine(fullEngine());
    const inventory = await engineInventory(dockerOf(runner), { computerId: COMPUTER, knownDevspaces: new Set([KNOWN]) });
    expect(inventory).toEqual({
      monitors: ['devspaces-monitor'],
      helpers: ['devspaces-api-worker1', 'devspaces-batch-1'],
      images: [
        { id: 'sha256:new', tags: ['devspaces-monitor:0123456789ab', 'devspaces-worker:0123456789ab'] },
        { id: 'sha256:old', tags: [] },
        { id: 'sha256:mine', tags: ['devspaces-worker:aaaaaaaaaaaa', 'my-copy:1'] },
      ],
      volumes: SHARED_VOLUMES,
      unknownDevspaces: [],
      otherComputerMonitor: false,
    });
    expect(inventoryIsEmpty(inventory)).toBe(false);
    expect(runner.calls.length).toBeGreaterThan(0);
    for (const call of runner.calls) expect(isReadOnlyDockerCall(call), `docker ${call.join(' ')}`).toBe(true);
  });

  it('finds devspaces that this computer does not know (containers and volumes) and a Monitor of another computer', async () => {
    const engine = fullEngine();
    engine.containers![0].labels['nimblescape.devspaces.monitor-owner'] = OTHER_COMPUTER;
    engine.volumes!.push({ name: 'devspaces-other-9999', labels: { 'nimblescape.devspaces.id': UNKNOWN } });
    engine.containers!.push({ id: 'd2', name: 'devspaces-other-9999', labels: { 'nimblescape.devspaces.id': UNKNOWN } });
    const inventory = await engineInventory(dockerOf(new FakeEngine(engine)), { computerId: COMPUTER, knownDevspaces: new Set([KNOWN]) });
    expect(inventory.unknownDevspaces).toEqual([UNKNOWN]);
    expect(inventory.otherComputerMonitor).toBe(true);
    // An idle Monitor has no owner: nothing shows another computer.
    delete engine.containers![0].labels['nimblescape.devspaces.monitor-owner'];
    expect((await engineInventory(dockerOf(new FakeEngine(engine)), { computerId: COMPUTER, knownDevspaces: new Set([KNOWN, UNKNOWN]) })).otherComputerMonitor).toBe(false);
  });

  it('an empty engine has nothing; a list that fails throws', async () => {
    const empty = await engineInventory(dockerOf(new FakeEngine()), { computerId: COMPUTER, knownDevspaces: new Set() });
    expect(inventoryIsEmpty(empty)).toBe(true);
    const failing = new FakeEngine({ answers: new Map([['ps', fail('Cannot connect to the Docker daemon')]]) });
    await expect(engineInventory(dockerOf(failing), { computerId: COMPUTER, knownDevspaces: new Set() })).rejects.toThrow('Cannot connect to the Docker daemon');
  });
});

describe('removeEngineInfrastructure', () => {
  it('removes the Monitor, the helper containers, the helper images (never with force) and the volumes, in this order', async () => {
    const runner = new FakeEngine(fullEngine());
    const logger = recordingLogger();
    const steps: string[] = [];
    const result = await removeEngineInfrastructure(dockerOf(runner), options(logger, { onItem: (text) => void steps.push(text) }));
    expect(result.ended).toBeUndefined();
    const removals = runner.calls.filter((call) => !isReadOnlyDockerCall(call));
    expect(removals).toEqual([
      ['rm', '-f', 'm1'],
      ['rm', '-f', 'w1'],
      ['rm', '-f', 'b1'],
      ['image', 'rm', 'devspaces-monitor:0123456789ab'],
      ['image', 'rm', 'devspaces-worker:0123456789ab'],
      ['image', 'rm', 'devspaces-worker:aaaaaaaaaaaa'],
      ['image', 'rm', 'sha256:old'],
      ['volume', 'rm', 'devspaces-monitor'],
      ['volume', 'rm', 'devspaces-worker-cache'],
      ['volume', 'rm', 'devspaces-vscode'],
    ]);
    expect(result.items.every((item) => item.outcome === 'removed')).toBe(true);
    expect(steps[0]).toBe('the container devspaces-monitor');
    expect(steps.at(-1)).toBe('the volume devspaces-vscode');
    // A devspace, its volume and an image tag of another repository stay.
    expect(runner.engine.containers.map((c) => c.name)).toEqual(['devspaces-acme-api-1111']);
    expect(runner.engine.volumes.map((v) => v.name)).toEqual(['devspaces-acme-api-1111']);
    expect(runner.engine.images).toEqual([{ id: 'sha256:mine', tags: ['my-copy:1'] }]);
    expect(logger.lines).toContain('info Removed the container devspaces-monitor.');
    expect(logger.lines).toContain('info Removed the volume devspaces-vscode.');
    expect(logger.lines.filter((line) => line.startsWith('warn'))).toEqual([]);
  });

  it('lists each step right before it: a container that appeared after the inventory goes too', async () => {
    const runner = new FakeEngine({ containers: [{ id: 'm1', name: 'devspaces-monitor', labels: { 'nimblescape.devspaces.monitor': 'abc' } }] });
    const docker = dockerOf(runner);
    const inventory = await engineInventory(docker, { computerId: COMPUTER, knownDevspaces: new Set() });
    expect(inventory.helpers).toEqual([]);
    runner.engine.containers.push({ id: 'w9', name: 'devspaces-late-worker1', labels: { 'nimblescape.devspaces.worker-run': 'true' } });
    await removeEngineInfrastructure(docker, options(recordingLogger()));
    expect(runner.calls).toContainEqual(['rm', '-f', 'w9']);
  });

  it('names a missing item, and an item in use with the command that removes it; both do not stop the removal', async () => {
    const engine = fullEngine();
    engine.answers = new Map<string, RunResult | Error>([
      ['volume rm devspaces-vscode', fail('Error response from daemon: remove devspaces-vscode: volume is in use - [d1]')],
      ['image rm devspaces-worker:aaaaaaaaaaaa', fail('Error response from daemon: conflict: unable to remove repository reference (must force) - container x is using its referenced image')],
    ]);
    engine.volumes = engine.volumes!.filter((volume) => volume.name !== 'devspaces-worker-cache');
    const runner = new FakeEngine(engine);
    const logger = recordingLogger();
    const answers = { count: 0 };
    const result = await removeEngineInfrastructure(dockerOf(runner), options(logger, { answers: async () => (answers.count++, true), context: 'devspaces-build-box' }));
    expect(result.ended).toBeUndefined();
    const outcome = (name: string) => result.items.find((item) => item.name === name)?.outcome;
    expect(outcome('devspaces-worker-cache')).toBe('missing');
    expect(outcome('devspaces-vscode')).toBe('inUse');
    expect(outcome('devspaces-worker:aaaaaaaaaaaa')).toBe('inUse');
    expect(outcome('devspaces-monitor')).toBe('removed');
    // Only a failure asks whether Docker still answers.
    expect(answers.count).toBe(0);
    expect(logger.lines).toContain('info The volume devspaces-worker-cache was not there anymore.');
    expect(logger.lines).toContain(
      'warn The volume devspaces-vscode is in use and was not removed (Error response from daemon: remove devspaces-vscode: volume is in use - [d1]). Remove it later with: docker --context devspaces-build-box volume rm devspaces-vscode',
    );
  });

  it('goes on after a failure while Docker answers, and ends when it stops answering', async () => {
    const engine = fullEngine();
    engine.answers = new Map<string, RunResult | Error>([['rm -f w1', { exitCode: 1, stdout: '', stderr: 'error during connect: EOF', timedOut: false }]]);
    const going = new FakeEngine(engine);
    const goingResult = await removeEngineInfrastructure(dockerOf(going), options(recordingLogger()));
    expect(goingResult.ended).toBeUndefined();
    expect(goingResult.items.find((item) => item.name === 'devspaces-api-worker1')).toEqual({
      kind: 'container',
      name: 'devspaces-api-worker1',
      outcome: 'failed',
      detail: 'error during connect: EOF',
    });
    expect(going.calls).toContainEqual(['volume', 'rm', 'devspaces-vscode']);

    const stopping = new FakeEngine(fullEngine());
    stopping.engine.answers.set('rm -f w1', { exitCode: null, stdout: '', stderr: '', timedOut: true });
    const logger = recordingLogger();
    const result = await removeEngineInfrastructure(dockerOf(stopping), options(logger, { answers: async () => false }));
    expect(result.ended).toBe('notAnswering');
    expect(result.items.map((item) => [item.name, item.outcome])).toEqual([
      ['devspaces-monitor', 'removed'],
      ['devspaces-api-worker1', 'failed'],
    ]);
    // Nothing after the failure.
    expect(stopping.calls.filter((call) => !isReadOnlyDockerCall(call))).toEqual([
      ['rm', '-f', 'm1'],
      ['rm', '-f', 'w1'],
    ]);
    const last = logger.lines.at(-1) ?? '';
    expect(last).toMatch(/^warn The removal ended: Docker does not answer anymore\. The rest can be removed with these commands/);
    for (const command of uninstallCommands()) expect(last).toContain(command);
  });

  it('a list that fails is an item that is left, with the command that removes all of its label', async () => {
    const runner = new FakeEngine(fullEngine());
    runner.engine.answers.set('ps --all --no-trunc --filter label=nimblescape.devspaces.worker-run', fail('permission denied'));
    const logger = recordingLogger();
    const result = await removeEngineInfrastructure(dockerOf(runner), options(logger));
    expect(result.items).toContainEqual({ kind: 'container', name: 'label=nimblescape.devspaces.worker-run', outcome: 'failed', detail: expect.stringContaining('permission denied') });
    expect(logger.lines.some((line) => line.includes('Remove it with: docker rm -f $(docker ps -aq --filter label=nimblescape.devspaces.worker-run)'))).toBe(true);
    // The images and volumes are still removed.
    expect(runner.calls).toContainEqual(['volume', 'rm', 'devspaces-vscode']);
  });

  it('Cancel ends the removal before its next call, and the log names the commands for the rest', async () => {
    const cancel = new AbortController();
    const runner = new FakeEngine(fullEngine());
    const logger = recordingLogger();
    const result = await removeEngineInfrastructure(dockerOf(runner), options(logger, { signal: cancel.signal, onItem: (text) => text.includes('devspaces-api-worker1') && cancel.abort() }));
    expect(result.ended).toBe('cancelled');
    expect(result.items.map((item) => item.name)).toEqual(['devspaces-monitor']);
    expect(runner.calls.filter((call) => !isReadOnlyDockerCall(call))).toEqual([
      ['rm', '-f', 'm1'],
      ['rm', '-f', 'w1'],
    ]);
    expect(logger.lines.at(-1)).toMatch(/^warn The removal was cancelled\. The rest can be removed with these commands/);
  });
});

describe('the commands in the log', () => {
  it('names each item, with --context for a remote engine', () => {
    expect(manualCommand({ kind: 'container', name: 'devspaces-monitor' })).toBe('docker rm -f devspaces-monitor');
    expect(manualCommand({ kind: 'image', name: 'devspaces-worker:0123456789ab' }, 'devspaces-build-box')).toBe('docker --context devspaces-build-box image rm devspaces-worker:0123456789ab');
    expect(manualCommand({ kind: 'volume', name: 'devspaces-vscode' })).toBe('docker volume rm devspaces-vscode');
    expect(manualCommand({ kind: 'image', name: 'label=nimblescape.devspaces.worker=true' })).toBe('docker image prune -a -f --filter label=nimblescape.devspaces.worker=true');
    expect(itemText({ kind: 'container', name: 'label=nimblescape.devspaces.monitor' })).toBe('the containers with the label nimblescape.devspaces.monitor');
    expect(uninstallCommands('ctx')).toEqual([
      'docker --context ctx rm -f $(docker --context ctx ps -aq --filter label=nimblescape.devspaces.monitor)',
      'docker --context ctx rm -f $(docker --context ctx ps -aq --filter label=nimblescape.devspaces.worker-run)',
      'docker --context ctx image prune -a -f --filter label=nimblescape.devspaces.worker',
      'docker --context ctx volume rm devspaces-monitor devspaces-worker-cache devspaces-vscode',
    ]);
  });
});
