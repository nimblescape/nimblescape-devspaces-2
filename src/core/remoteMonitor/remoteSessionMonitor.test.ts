// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The ensure runs on the production MonitorEngine of the worker (engineMonitor) over a fake of the worker's engine port
// (DockerEngine), as the worker runs it over the Engine API. The answers are those of the port (the inspect of the
// engine, an exec result or the engine's refusal of the exec, the list of IDs, the clock of the daemon, the outcome of
// the attached create); the calls are those of the port (`inspect <name>`, `rm <id>`, `start <id>`,
// `exec <container> <command>`, `ps <label>`, `info`, `run <name>` with the spec of the create). The tests check the
// decisions, the calls and their order; the production create and readings have their own tests
// (engineClient.attached.test.ts, engineClient.createAttached.test.ts, engineMonitor*.test.ts).
import * as esbuild from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sharedBundleOptions, workerBundleOptions } from '../../../scripts/bundleOptions.mjs';
import { setUserAgentVersion } from '../http';
import { MAX_BUNDLE_LINE_LENGTH, PIPE_LOADER, bundleHash, encodeBundle } from '../loader/pipeLoader';
import { abortError, type Logger } from '../ports';
import { EngineError, type DockerEngine, type MonitorCreated, type MonitorRunSpec } from '../worker/dockerEngine';
import { unusedEngine } from '../worker/dockerEngine.testkit';
import { engineMonitor } from '../worker/engineMonitor';
import {
  LABEL_MONITOR_CREATE,
  LABEL_MONITOR,
  REMOTE_MONITOR_READY_TEXT,
  REMOTE_MONITOR_SCRIPT_PATH,
  remoteMonitorLabelValue,
} from './protocol';
import {
  REMOTE_MONITOR_CONFLICT_WAITS_MS,
  REMOTE_MONITOR_CREATED_WAITS_MS,
  REMOTE_MONITOR_DOCKER_TIMEOUT_MS,
  REMOTE_MONITOR_LOG,
  REMOTE_MONITOR_STALE_CREATED_MS,
  RemoteSessionMonitor,
} from './remoteSessionMonitor';
import { parseDockerTime, type MonitorEngine } from './monitorEngine';

const SCRIPT = 'console.log("monitor")';
const TAG = 'devspaces-worker:0123456789ab';
const SOCKET = '/var/run/docker.sock';
const LABEL = remoteMonitorLabelValue(SCRIPT, TAG);

/** The answer of the read of a file of the container (DockerEngine.containerFile). */
type ArchiveAnswer = Buffer | 'missing' | undefined;
/** The ID of the inspected monitor container. */
const MONITOR_ID = 'feed'.padEnd(64, '1');
/**
 * The inspect of the monitor container by the engine (DockerEngine.inspect): its status, exit code, labels, restart
 * count, ID and, when given, its creation time (without it the creation time cannot be read). `state`: true is
 * `running`, false is `exited` (with `exitCode`), a string is that status.
 */
const inspected = (state: boolean | string, label: string | undefined, exitCode = 0, restartCount: unknown = 0, id: unknown = MONITOR_ID, created?: unknown) => {
  const status = state === true ? 'running' : state === false ? 'exited' : state;
  return {
    Id: id,
    State: { Status: status, ExitCode: exitCode },
    Config: { Labels: label === undefined ? {} : { [LABEL_MONITOR]: label, other: 'x' } },
    RestartCount: restartCount,
    ...(created === undefined ? {} : { Created: created }),
  };
};
/** The engine has no container of the name (the port answers undefined). */
const MISSING = undefined;
/** The ID of the container of a create, as the list of its nonce gives it. */
const CREATED_ID = 'c0ffee'.padEnd(64, '0');
/** The answers for a create after a missing container, with the container of the create found by its nonce label. */
const missingThenCreated = (args: readonly string[]): unknown => (args[0] === 'inspect' ? MISSING : args[0] === 'ps' ? [CREATED_ID] : undefined);
/** The engine answers that the stored script does not exist (DockerEngine.containerFile). */
const NO_SCRIPT: ArchiveAnswer = 'missing';
/** The stored script of this version. */
const SAME: ArchiveAnswer = Buffer.from(SCRIPT);
/** The read of the stored script past its time limit (engineMonitor). */
const TIMED_OUT = new Error('no answer in time');
/** The engine's refusal of the name of the create (status 409, its message as the engine client gives it). */
const CONFLICT = 'Conflict. The container name "/devspaces-monitor" is already in use by container "abc". You have to remove (or rename) that container to be able to reuse that name.';
/** The removal of the container is already in progress (another window). */
const inProgress = () => Promise.reject(new EngineError(`removal of container ${MONITOR_ID} is already in progress`, 409));

/** A call of the engine port, as the fake records it (see the module comment); `signal` and `timeoutMs` as the port got them. */
interface EngineCall {
  args: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  /** The spec and the input (the script line) of a create. */
  spec?: MonitorRunSpec;
  input?: string;
}

/** What the attached create of the engine (createAttached) reports for the container of a create. */
type OnCreate = (call: EngineCall, index: number) => MonitorCreated | Promise<MonitorCreated>;
/** The monitor container starts and prints its ready line. */
const STARTS: OnCreate = () => ({ kind: 'ready' });
/** The engine refuses the name: another container has it. */
const CONFLICTED: OnCreate = () => ({ kind: 'exited', detail: CONFLICT, conflict: true });
/** The container ends before its ready line with `detail` (its error output, or the engine client's text without one). */
const ENDS =
  (detail = 'the container ended before it reported its start'): OnCreate =>
  () => ({ kind: 'exited', detail, conflict: false });
/** No ready line: the time limit of the create ends it (`timeout`), a cancel of its signal (`aborted`), as the engine client does. */
const HANGS: OnCreate = (call) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: 'timeout' }), call.timeoutMs);
    call.signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve({ kind: 'aborted' });
      },
      { once: true },
    );
  });

/**
 * The fake of the worker's engine port: `answer` answers each call but the create (undefined is the port's empty answer:
 * no container for an inspect, done for a removal or a start, no IDs for a list, no regular file for the read of the
 * stored script, an empty time); a rejected promise, or an Error for the read of the stored script, is the failure of
 * the call. `onCreate` is the outcome of each create.
 */
class FakeDocker {
  readonly calls: EngineCall[] = [];
  /** The script lines that reached the engine (one per create that went ahead). */
  readonly inputs: string[] = [];
  readonly engine: DockerEngine;

  constructor(
    answer: (args: readonly string[], index: number, call: EngineCall) => unknown,
    onCreate: OnCreate = STARTS,
  ) {
    const reply = async (call: EngineCall): Promise<unknown> => {
      this.calls.push(call);
      return answer(call.args, this.calls.length - 1, call);
    };
    let creates = 0;
    this.engine = {
      ...unusedEngine(),
      inspect: async (kind, name, signal) => {
        expect(kind).toBe('container');
        return reply({ args: ['inspect', name], signal });
      },
      removeContainer: async (id, signal) => {
        await reply({ args: ['rm', id], signal });
      },
      start: async (id, signal) => {
        await reply({ args: ['start', id], signal });
      },
      containerFile: async (container, path, _maxBytes, signal) => {
        const answer = await reply({ args: ['archive', container, path], signal });
        if (answer instanceof Error) throw answer;
        return answer as ArchiveAnswer;
      },
      containerIds: async (filters, signal) => ((await reply({ args: ['ps', ...(filters.label ?? [])], signal })) as string[] | undefined) ?? [],
      systemTime: async (signal) => ((await reply({ args: ['info'], signal })) as string | undefined) ?? '',
      createAttached: async (spec, options) => {
        const call: EngineCall = { args: ['run', spec.name], signal: options.signal, timeoutMs: options.timeoutMs, spec, input: options.input };
        this.calls.push(call);
        expect(options.readyText).toBe(REMOTE_MONITOR_READY_TEXT);
        // As the engine client: a cancel before anything was sent rejects, and nothing exists then.
        if (options.signal?.aborted) throw abortError();
        this.inputs.push(options.input);
        return onCreate(call, creates++);
      },
    };
  }

  commands(): string[] {
    return this.calls.map((call) => call.args[0]);
  }

  /** The spec of the create of the call at `index`. */
  spec(index: number): MonitorRunSpec {
    const spec = this.calls[index].spec;
    if (spec === undefined) throw new Error(`The call ${index} is no create.`);
    return spec;
  }
}

/** The nonce of a create (LABEL_MONITOR_CREATE) in its spec. */
const createIdOf = (spec: MonitorRunSpec | undefined): string | undefined => spec?.labels[LABEL_MONITOR_CREATE];
/** The list of the containers of the nonce of the create `spec`. */
const nonceList = (spec: MonitorRunSpec | undefined) => ['ps', `${LABEL_MONITOR_CREATE}=${createIdOf(spec)}`];

/**
 * Whether the signals of `calls` follow `controller` (engineMonitor links the signal of each call of the port to the
 * signal of ensure, within the time limit of the call): none aborted before its abort, each aborted after it.
 */
function expectSignalsFollow(calls: readonly EngineCall[], controller: AbortController): void {
  expect(calls.length).toBeGreaterThan(0);
  if (!controller.signal.aborted) {
    expect(calls.map((call) => call.signal?.aborted)).toEqual(calls.map(() => false));
    controller.abort();
  }
  expect(calls.map((call) => call.signal?.aborted)).toEqual(calls.map(() => true));
}

class Log implements Logger {
  readonly lines: string[] = [];
  info(message: string): void {
    this.lines.push(`info ${message}`);
  }
  warn(message: string): void {
    this.lines.push(`warn ${message}`);
  }
  error(message: string): void {
    this.lines.push(`error ${message}`);
  }
  output(): void {}
}

function monitor(docker: FakeDocker, logger = new Log(), script = SCRIPT): RemoteSessionMonitor {
  return new RemoteSessionMonitor({ engine: engineMonitor(docker.engine), logger, script: async () => script });
}

describe('RemoteSessionMonitor.ensure', () => {
  it('does nothing when the container of this version runs', async () => {
    const docker = new FakeDocker(() => inspected(true, LABEL));
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('running');
    expect(docker.commands()).toEqual(['inspect']);
    // The inspect of the container by its name, whose answer engineMonitor reads for the status, the exit code, the
    // labels, the restart count, the ID and the creation time (monitorInspected).
    expect(docker.calls[0].args).toEqual(['inspect', 'devspaces-monitor']);
  });

  it('starts the container of this version when it is stopped', async () => {
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(false, LABEL) : undefined));
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('started');
    // Started by its ID, then its stored script is checked (here no regular file: kept).
    expect(docker.calls.map((call) => call.args)).toEqual([
      expect.anything(),
      ['start', MONITOR_ID],
      ['archive', 'devspaces-monitor', REMOTE_MONITOR_SCRIPT_PATH],
      // The check that fails is followed by an inspect by the same ID (exited with 0 again: no evidence, kept).
      ['inspect', 'devspaces-monitor'],
    ]);
  });

  it('replaces a container of another version (another script or helper image)', async () => {
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(true, 'aaaaaaaaaaaa') : undefined));
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('created');
    expect(docker.commands()).toEqual(['inspect', 'rm', 'run']);
    // By the ID that inspect read, never by the name.
    expect(docker.calls[1].args).toEqual(['rm', MONITOR_ID]);
  });

  // Never by the name: an ID that cannot be read fails, and nothing is removed.
  it('a replace whose inspect gave no readable ID fails and removes nothing', async () => {
    for (const id of [null, 42, 'not-an-id', 'A'.repeat(64), 'f'.repeat(63)]) {
      const logger = new Log();
      const docker = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(true, 'aaaaaaaaaaaa', 0, 0, id) : undefined));
      expect(await monitor(docker, logger).ensure(TAG, SOCKET), String(id)).toBe('failed');
      expect(docker.commands()).toEqual(['inspect']);
      expect(logger.lines.join('\n')).toContain('the ID of the Monitor container cannot be read; it is kept.');
    }
    // Without an ID in the answer too.
    const short = new FakeDocker((args) => (args[0] === 'inspect' ? { State: { Status: 'running', ExitCode: 0 }, Config: { Labels: { [LABEL_MONITOR]: 'aaaaaaaaaaaa' } }, RestartCount: 0 } : undefined));
    expect(await monitor(short).ensure(TAG, SOCKET)).toBe('failed');
    expect(short.commands()).toEqual(['inspect']);
  });

  it('when another window replaced the container meanwhile, the removal by the old ID misses and the create accepts the new one', async () => {
    const docker = new FakeDocker((args, index) => {
      // The port's removal of a container that is gone is no failure.
      if (args[0] === 'rm') return undefined;
      // The conflict check finds no container with the nonce of this create.
      if (args[0] === 'ps') return [];
      return index === 0 ? inspected(true, LABEL, 0, 1) : args[0] === 'archive' ? NO_SCRIPT : inspected(true, LABEL, 0, 0, 'b'.repeat(64));
    }, CONFLICTED);
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('running');
    // The conflict is checked by the nonce.
    expect(docker.commands()).toEqual(['inspect', 'archive', 'rm', 'run', 'ps', 'inspect']);
    expect(docker.calls[2].args).toEqual(['rm', MONITOR_ID]);
    expect(docker.calls.some((call) => call.args[0] === 'rm' && call.args.includes('devspaces-monitor'))).toBe(false);
  });

  it('runs the helper image of the open by its checked image ID, with the label and the log line of its tag', async () => {
    const imageId = `sha256:${'7'.repeat(64)}`;
    const docker = new FakeDocker(() => MISSING);
    const logger = new Log();
    expect(await monitor(docker, logger).ensure(TAG, SOCKET, undefined, imageId)).toBe('created');
    const byId = docker.spec(1);
    const byTag = new FakeDocker(() => MISSING);
    await monitor(byTag).ensure(TAG, SOCKET);
    // The same spec as with the tag, the label included; only the image reference and the nonce of each create differ.
    const tagged = byTag.spec(1);
    expect(byId).toEqual({
      ...tagged,
      image: imageId,
      labels: { ...tagged.labels, [LABEL_MONITOR_CREATE]: createIdOf(byId) },
      env: { ...tagged.env, DEVSPACE_MONITOR_CREATE_ID: createIdOf(byId) },
    });
    expect(createIdOf(byId)).not.toBe(createIdOf(tagged));
    expect(byId.labels[LABEL_MONITOR]).toBe(LABEL);
    expect(JSON.stringify(byId)).not.toContain(TAG);
    expect(logger.lines).toContain(`info The Monitor on the Docker host was created (devspaces-monitor, image ${TAG}).`);
  });

  it('replaces a container of the name without the label', async () => {
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(true, undefined) : undefined));
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('created');
    expect(docker.commands()).toEqual(['inspect', 'rm', 'run']);
  });

  it('creates a missing container: its own capability-less container with the default network, the socket and the volume', async () => {
    const docker = new FakeDocker(() => MISSING);
    expect(await monitor(docker).ensure(TAG, '/run/user/1000/docker.sock')).toBe('created');
    expect(docker.commands()).toEqual(['inspect', 'run']);
    const spec = docker.spec(1);
    const createId = createIdOf(spec);
    expect(createId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // The spec of the attached create of the engine, which sets the open input, the dropped capabilities, no new
    // privileges and never a pull itself (engineClient.attached.test.ts).
    expect(spec).toEqual({
      name: 'devspaces-monitor',
      image: TAG,
      // The nonce of this create next to the label of the version.
      labels: { [LABEL_MONITOR]: LABEL, [LABEL_MONITOR_CREATE]: createId },
      // The monitor exits with 0 when it is idle and stays exited; a failure (the loader's exit 3) is restarted.
      restartPolicy: 'on-failure',
      // The monitor always has the default network (outbound only; no published port).
      network: 'default',
      // The log of the monitor is capped, with the driver named.
      log: { driver: 'json-file', maxSize: '1m', maxFile: '2' },
      mounts: { socket: '/run/user/1000/docker.sock', volume: 'devspaces-monitor', volumeTarget: '/state' },
      // The nonce again, so the monitor finds its own container (its end after 30 days without use).
      env: { DEVSPACE_MONITOR_CREATE_ID: createId },
      // The pipe loader with the path, the hash and the entry; the script is not on the command line.
      command: ['node', '-e', PIPE_LOADER, REMOTE_MONITOR_SCRIPT_PATH, bundleHash(SCRIPT), 'startMonitor'],
    });
    // No published port, no environment variable of this computer, never DOCKER_HOST.
    expect(JSON.stringify(spec)).not.toContain('DOCKER_HOST');
    expect(JSON.stringify(spec)).not.toContain(SCRIPT);
    // The create gets the time limit of a Docker call.
    expect(docker.calls[1].timeoutMs).toBe(REMOTE_MONITOR_DOCKER_TIMEOUT_MS);
    // The script is the first and only input line.
    expect(docker.inputs).toEqual([encodeBundle(SCRIPT)]);
  });

  it('accepts the container that another window created at the same time', async () => {
    // The attached create reports the conflict.
    const docker = new FakeDocker((args, index) => (index === 0 ? MISSING : args[0] === 'ps' ? [] : inspected(true, LABEL)), CONFLICTED);
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('running');
    // The conflict is checked by the nonce of this create first (none: a true conflict).
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'inspect']);
  });

  it('fails (logged, no throw) when the other window created another version', async () => {
    const logger = new Log();
    const docker = new FakeDocker((args, index) => (index === 0 ? MISSING : args[0] === 'ps' ? [] : inspected(true, 'bbbbbbbbbbbb')), CONFLICTED);
    expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('failed');
    // The windows send the heartbeats; an open is refused without the monitor (ensureOrThrow).
    expect(logger.lines.join('\n')).toMatch(/warn The Monitor on the Docker host could not be started: docker run failed: .*already in use/);
    // The container of the other window is not removed: the nonce is checked, and the failure cleans up by the nonce
    // (nothing).
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'inspect', 'ps']);
  });

  it('fails (logged) when Docker does not answer, and does not create anything', async () => {
    const logger = new Log();
    // Every call of the port fails.
    const docker = new FakeDocker(() => Promise.reject(new Error('connect ETIMEDOUT /var/run/docker.sock')));
    expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('failed');
    expect(docker.commands()).toEqual(['inspect']);
    expect(logger.lines.some((line) => line.startsWith('warn'))).toBe(true);
  });

  // A script whose JSON line is beyond the memory guard of the loader, MAX_BUNDLE_LINE_LENGTH, is refused before
  // anything is removed.
  it('refuses a script whose line is longer than the loader takes', async () => {
    const docker = new FakeDocker(() => MISSING);
    // Each line feed doubles in JSON: short enough as text, too long as its line.
    expect(await monitor(docker, new Log(), '\n'.repeat(MAX_BUNDLE_LINE_LENGTH / 2 + 1)).ensure(TAG, SOCKET)).toBe('failed');
    expect(docker.calls).toEqual([]);
  });

  // The script is never on the command line, so its length and its quotes do not matter there.
  it('a 1 MB script is accepted and never in argv', async () => {
    const script = `/* ${'"quoted" \\ line\n'.repeat(80_000)} */`;
    expect(script.length).toBeGreaterThan(1024 * 1024);
    const docker = new FakeDocker(() => MISSING);
    const logger = new Log();
    expect(await monitor(docker, logger, script).ensure(TAG, SOCKET)).toBe('created');
    // The spec of the create: its command, labels and variables.
    const spec = docker.spec(1);
    expect(JSON.stringify(spec).length).toBeLessThan(5_000);
    expect(JSON.stringify(spec)).not.toContain('quoted');
    expect(spec.command.slice(-2)).toEqual([bundleHash(script), 'startMonitor']);
    expect(docker.inputs).toEqual([encodeBundle(script)]);
    // Never in the log either.
    expect(logger.lines.some((line) => line.includes('quoted'))).toBe(false);
  });

  it('fails when the script cannot be read', async () => {
    const docker = new FakeDocker(() => MISSING);
    const failing = new RemoteSessionMonitor({ engine: engineMonitor(docker.engine), logger: new Log(), script: async () => Promise.reject(new Error('ENOENT')) });
    expect(await failing.ensure(TAG, SOCKET)).toBe('failed');
  });

  it('passes a cancellation on', async () => {
    // The cancel of the signal of ensure, which engineMonitor passes on as such (an AbortError without it is a failure
    // of the call).
    const controller = new AbortController();
    const docker = new FakeDocker(() => {
      controller.abort();
      return Promise.reject(abortError());
    });
    await expect(monitor(docker).ensure(TAG, SOCKET, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('gives the tests their own names, labels, and variables', () => {
    const custom = new RemoteSessionMonitor({
      engine: engineMonitor(new FakeDocker(() => undefined).engine),
      logger: new Log(),
      script: async () => SCRIPT,
      containerName: 'devspaces-test-monitor',
      volumeName: 'devspaces-test-monitor-state',
      labels: { 'devspaces-test.run': 'abc' },
      containerEnv: { DEVSPACE_MONITOR_TICK_MS: '500' },
    });
    const spec = custom.runSpec(TAG, SOCKET, LABEL, SCRIPT);
    expect(spec.name).toBe('devspaces-test-monitor');
    expect(spec.mounts).toMatchObject({ volume: 'devspaces-test-monitor-state', volumeTarget: '/state' });
    expect(spec.labels['devspaces-test.run']).toBe('abc');
    expect(spec.env).toEqual({ DEVSPACE_MONITOR_TICK_MS: '500' });
  });
});

// Pipe loading: the state of the container decides, and the create is the
// attached create that gets the script on its input and is let go after the ready line.
describe('RemoteSessionMonitor.ensure with the pipe loader', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pins the ready text of the monitor', () => {
    expect(REMOTE_MONITOR_READY_TEXT).toBe('Monitor started');
  });

  for (const [state, exitCode, outcome, commands] of [
    ['running', 0, 'running', ['inspect']],
    ['paused', 0, 'running', ['inspect']],
    // Stopped by `docker stop`, a daemon restart without the policy, or an error of the script: the stored script resumes.
    // Then the stored script is checked (here an answer without a hash: no evidence, kept); a check that fails is
    // followed by an inspect by the same ID (here exited again with an exit code other than 3 and the same
    // RestartCount: no evidence, kept).
    ['exited', 0, 'started', ['inspect', 'start', 'archive', 'inspect']],
    ['exited', 137, 'started', ['inspect', 'start', 'archive', 'inspect']],
    ['exited', 1, 'started', ['inspect', 'start', 'archive', 'inspect']],
    // The loader refused (exit 3), or the container never ran as it should: replaced.
    ['exited', 3, 'created', ['inspect', 'rm', 'run']],
    // A `created` one may be the create of another window; its own tests cover it.
    // Restarting: the stored script is read; without evidence of the same script (here an answer without a hash) it is
    // replaced. Its own tests cover the same script.
    ['restarting', 3, 'created', ['inspect', 'archive', 'rm', 'run']],
    ['dead', 0, 'created', ['inspect', 'rm', 'run']],
  ] as const) {
    it(`the container of this version, ${state} with exit code ${exitCode} → ${outcome}`, async () => {
      const docker = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(state, LABEL, exitCode) : undefined));
      expect(await monitor(docker).ensure(TAG, SOCKET)).toBe(outcome);
      expect(docker.commands()).toEqual(commands);
      // By the ID, never by the name.
      if (outcome === 'started') expect(docker.calls[1].args).toEqual(['start', MONITOR_ID]);
      if (outcome === 'created') expect(docker.calls.find((call) => call.args[0] === 'rm')?.args).toEqual(['rm', MONITOR_ID]);
    });
  }

  // A restarting container of this version that failed once (RestartCount 1) is kept only with the stored script of
  // this version; another or no stored script, or a read that fails, replaces it by its ID.
  for (const [what, answer, outcome, commands] of [
    ['the stored script of this version', SAME, 'running', ['inspect', 'archive']],
    ['another stored script', Buffer.from('another script'), 'created', ['inspect', 'archive', 'rm', 'run']],
    ['no stored script', NO_SCRIPT, 'created', ['inspect', 'archive', 'rm', 'run']],
    ['a read without an answer in time', TIMED_OUT, 'created', ['inspect', 'archive', 'rm', 'run']],
  ] as const) {
    it(`a restarting container of this version with ${what} → ${outcome}`, async () => {
      const logger = new Log();
      const docker = new FakeDocker((args) => (args[0] === 'inspect' ? inspected('restarting', LABEL, 1, 1) : args[0] === 'archive' ? answer : undefined));
      expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe(outcome);
      expect(docker.commands()).toEqual(commands);
      expect(docker.calls[1].args).toEqual(['archive', 'devspaces-monitor', REMOTE_MONITOR_SCRIPT_PATH]);
      if (outcome === 'created') expect(docker.calls[2].args).toEqual(['rm', MONITOR_ID]);
      else expect(logger.lines.join('\n')).toContain('is restarting with its script; it is kept');
    });
  }

  // One that failed more often fails at each start, also with its script: replaced without a read, so the create's
  // ready check reports the cause.
  it('a restarting container of this version with RestartCount 2 is replaced without a read', async () => {
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? inspected('restarting', LABEL, 1, 2) : args[0] === 'archive' ? SAME : undefined));
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('created');
    expect(docker.commands()).toEqual(['inspect', 'rm', 'run']);
    expect(docker.calls[1].args).toEqual(['rm', MONITOR_ID]);
  });

  // Keeping it needs no ID: nothing is removed or started.
  it('a restarting container of this version with its script and an ID that cannot be read is kept', async () => {
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? inspected('restarting', LABEL, 1, 1, null) : args[0] === 'archive' ? SAME : undefined));
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('running');
    expect(docker.commands()).toEqual(['inspect', 'archive']);
  });

  it('fails without a ready line within the time limit: the container is removed', async () => {
    vi.useFakeTimers();
    const logger = new Log();
    const docker = new FakeDocker(missingThenCreated, HANGS);
    const ensured = monitor(docker, logger).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(REMOTE_MONITOR_DOCKER_TIMEOUT_MS);
    expect(await ensured).toBe('failed');
    // The container of this create is found by its nonce and removed by its ID.
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'rm']);
    expect(docker.calls[1].timeoutMs).toBe(REMOTE_MONITOR_DOCKER_TIMEOUT_MS);
    expect(docker.calls[2].args).toEqual(nonceList(docker.spec(1)));
    expect(docker.calls[3].args).toEqual(['rm', CREATED_ID]);
    expect(logger.lines.join('\n')).toContain('did not report its start within 60 seconds');
  });

  it('fails when the loader exits with 3: its line is logged, the container removed, the script never', async () => {
    const logger = new Log();
    const docker = new FakeDocker(missingThenCreated, ENDS('devspace loader: the bundle does not match its hash'));
    expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('failed');
    // By the nonce, never by the name.
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'rm']);
    expect(docker.calls[3].args).toEqual(['rm', CREATED_ID]);
    expect(logger.lines.join('\n')).toContain('docker run failed: devspace loader: the bundle does not match its hash');
    expect(logger.lines.some((line) => line.includes(SCRIPT))).toBe(false);
  });

  it('fails when the container ends before the ready line without a word', async () => {
    const docker = new FakeDocker(missingThenCreated, ENDS());
    const logger = new Log();
    expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('failed');
    // By the nonce, never by the name.
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'rm']);
    expect(docker.calls[3].args).toEqual(['rm', CREATED_ID]);
    // The text of the engine client for a container that ended without error output.
    expect(logger.lines.join('\n')).toContain('docker run failed: the container ended before it reported its start');
  });

  it('passes a cancellation during the create on, after it removed the container', async () => {
    const controller = new AbortController();
    const docker = new FakeDocker(missingThenCreated, () => {
      controller.abort();
      return { kind: 'aborted' };
    });
    await expect(monitor(docker).ensure(TAG, SOCKET, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    // By the nonce, never by the name.
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'rm']);
    expect(docker.calls[3].args).toEqual(['rm', CREATED_ID]);
    // The removal does not take the cancelled signal (engineMonitor gives each call the signal of its own time limit).
    expect(docker.calls[2].signal?.aborted).toBe(false);
    expect(docker.calls[3].signal?.aborted).toBe(false);
  });

  // A create that fails before its container exists. The port allows that rejection when nothing was sent; the
  // production client rejects only on a cancelled signal and reports a failed connection as `exited`, so this pins the
  // port's contract, not a failure the client produces.
  it('fails when the create fails before its container exists', async () => {
    const docker = new FakeDocker(() => MISSING, () => Promise.reject(new EngineError('connect ENOENT /var/run/docker.sock', 0)));
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('failed');
    expect(docker.commands()).toEqual(['inspect', 'run']);
  });

  // The real script, the worker's bundle as a production build of esbuild.mjs builds it: no part of the script is in the
  // spec of the create (its command, labels and variables), which stays short.
  it('the command line holds no bundle (the real script)', { timeout: 30_000 }, async () => {
    const built = await esbuild.build({ ...workerBundleOptions(sharedBundleOptions({ production: true })), write: false, logLevel: 'silent' });
    const script = built.outputFiles[0].text;
    expect(script).toContain(REMOTE_MONITOR_READY_TEXT);
    const spec = monitor(new FakeDocker(() => undefined), new Log(), script).runSpec(TAG, '/run/user/1000/docker.sock', LABEL, script, {
      schedule: '7 6 * * *',
      timeZone: 'America/Argentina/Buenos_Aires',
    });
    expect(spec.command).toEqual(['node', '-e', PIPE_LOADER, REMOTE_MONITOR_SCRIPT_PATH, bundleHash(script), 'startMonitor']);
    const text = JSON.stringify(spec);
    for (let at = 0; at + 64 <= script.length; at += 4096) {
      const piece = script.slice(at, at + 64);
      // The bundle holds the text of the pipe loader too (remoteSessionMonitor.ts), which the command line carries by
      // design; a piece of it is no piece of the bundle on the command line (it depends on the offsets only).
      if (PIPE_LOADER.includes(piece)) continue;
      expect(text.includes(piece)).toBe(false);
    }
    expect(text.length).toBeLessThan(10_000);
  });
});

// A monitor whose first load was cut off, the removal of a failed create by its nonce, and more edge cases.
describe('RemoteSessionMonitor.ensure: the stored script and the nonce of a create', () => {
  const SHA = ['archive', 'devspaces-monitor', REMOTE_MONITOR_SCRIPT_PATH];
  // Only definite evidence of another or no stored script replaces the monitor: the engine's answer that the file or
  // the container does not exist, or a file of another script.
  const replacing = [
    ['no stored script', NO_SCRIPT],
    ['another stored script', Buffer.from(`${SCRIPT}// changed`)],
    ['an empty stored script', Buffer.alloc(0)],
  ] as const;
  // A check that fails is no evidence; the monitor is kept.
  const keeping = [
    ['no answer in time', TIMED_OUT],
    ['a failed call', new Error('Docker Desktop is not installed.')],
    ['an SSH failure', new EngineError('error during connect: ssh: connect to host build-box port 22: Connection refused', 0)],
    ['another failure of the engine', new EngineError('the engine is busy', 500)],
    ['no regular file or a file too large to read', undefined],
  ] as const;
  const answering = (state: string, answer: ArchiveAnswer | Error) =>
    new FakeDocker((args) => {
      if (args[0] === 'inspect') return inspected(state, LABEL, 3, 1);
      if (args[0] === 'archive') return answer;
      return undefined;
    });

  for (const [what, answer] of replacing) {
    it(`running with RestartCount 1 and ${what} → replaced`, async () => {
      const logger = new Log();
      const docker = answering('running', answer);
      expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('created');
      expect(docker.commands()).toEqual(['inspect', 'archive', 'rm', 'run']);
      expect(docker.calls[1].args).toEqual(SHA);
      // By the ID, never by the name.
      expect(docker.calls[2].args).toEqual(['rm', MONITOR_ID]);
      expect(logger.lines).toContain('info The Monitor on the Docker host was restarted without its script; it is replaced (devspaces-monitor).');
    });
  }

  for (const [what, answer] of keeping) {
    // A check that fails keeps the monitor, logged at info level.
    it(`running with RestartCount 1 and ${what} → kept, logged`, async () => {
      const logger = new Log();
      const docker = answering('running', answer);
      expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('running');
      // A check that fails is followed by an inspect by the same ID (still running with the same RestartCount: no
      // evidence, kept without a second read).
      expect(docker.commands()).toEqual(['inspect', 'archive', 'inspect']);
      expect(docker.calls[1].args).toEqual(SHA);
      expect(logger.lines).toEqual([
        'info The Monitor on the Docker host was restarted and its stored script could not be checked; it is kept (devspaces-monitor).',
      ]);
    });
  }

  // The read runs nothing in the container, so a paused one is checked as a running one.
  for (const [what, answer] of replacing) {
    it(`paused with RestartCount 1 and ${what} → replaced`, async () => {
      const docker = answering('paused', answer);
      expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('created');
      expect(docker.commands()).toEqual(['inspect', 'archive', 'rm', 'run']);
      expect(docker.calls[2].args).toEqual(['rm', MONITOR_ID]);
    });
  }

  for (const [what, answer] of keeping) {
    it(`paused with RestartCount 1 and ${what} → kept, logged`, async () => {
      const logger = new Log();
      const docker = answering('paused', answer);
      expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('running');
      // The inspect by the same ID finds it paused again: no evidence, kept without another check.
      expect(docker.commands()).toEqual(['inspect', 'archive', 'inspect']);
      expect(logger.lines).toEqual([
        'info The Monitor on the Docker host was restarted and its stored script could not be checked; it is kept (devspaces-monitor).',
      ]);
    });
  }

  for (const state of ['running', 'paused'] as const) {
    it(`${state} with RestartCount 1 and the stored script of this version → running, nothing removed`, async () => {
      const docker = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(state, LABEL, 0, 1) : args[0] === 'archive' ? SAME : undefined));
      expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('running');
      expect(docker.commands()).toEqual(['inspect', 'archive']);
      expect(docker.calls[1].args).toEqual(SHA);
    });

    it(`${state} with RestartCount 0 → running without any other call`, async () => {
      const docker = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(state, LABEL, 0, 0) : undefined));
      expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('running');
      expect(docker.commands()).toEqual(['inspect']);
    });
  }

  it('a larger RestartCount is checked too; one that cannot be read counts as 0', async () => {
    // The check answers that no script is stored (no regular file would be no evidence and keep it).
    const restarted = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(true, LABEL, 3, 17) : args[0] === 'archive' ? NO_SCRIPT : undefined));
    expect(await monitor(restarted).ensure(TAG, SOCKET)).toBe('created');
    expect(restarted.commands()).toEqual(['inspect', 'archive', 'rm', 'run']);
    const unreadable = new FakeDocker((args) => (args[0] === 'inspect' ? { State: { Status: 'running', ExitCode: 0 }, Config: { Labels: { [LABEL_MONITOR]: LABEL } }, RestartCount: null } : undefined));
    expect(await monitor(unreadable).ensure(TAG, SOCKET)).toBe('running');
    expect(unreadable.commands()).toEqual(['inspect']);
  });

  it('a cancellation during the check of the stored script passes', async () => {
    // The cancel of the signal of ensure (see "passes a cancellation on").
    const controller = new AbortController();
    const docker = new FakeDocker((args) => {
      if (args[0] === 'inspect') return inspected(true, LABEL, 0, 1);
      controller.abort();
      return Promise.reject(abortError());
    });
    await expect(monitor(docker).ensure(TAG, SOCKET, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(docker.commands()).toEqual(['inspect', 'archive']);
  });

  it('a create whose container is gone ("No such container") removes only its own container, by its nonce', async () => {
    const docker = new FakeDocker(missingThenCreated, ENDS('No such container: 4f1c2a9e.'));
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('failed');
    const createId = createIdOf(docker.spec(1));
    expect(createId).toBeDefined();
    expect(docker.calls.map((call) => call.args)).toEqual([
      ['inspect', 'devspaces-monitor'],
      ['run', 'devspaces-monitor'],
      ['ps', `${LABEL_MONITOR_CREATE}=${createId}`],
      ['rm', CREATED_ID],
    ]);
    expect(docker.calls.some((call) => call.args[0] === 'rm' && call.args.includes('devspaces-monitor'))).toBe(false);
  });

  it('nothing is removed when no container has the nonce, or the list fails; each create has its own nonce', async () => {
    const none = new FakeDocker((args) => (args[0] === 'inspect' ? MISSING : []), ENDS());
    expect(await monitor(none).ensure(TAG, SOCKET)).toBe('failed');
    expect(none.commands()).toEqual(['inspect', 'run', 'ps']);
    const failing = new FakeDocker((args) => (args[0] === 'inspect' ? MISSING : args[0] === 'ps' ? Promise.reject(new EngineError('error', 500)) : undefined), ENDS());
    expect(await monitor(failing).ensure(TAG, SOCKET)).toBe('failed');
    expect(failing.commands()).toEqual(['inspect', 'run', 'ps']);
    // One instance, ensure twice.
    const twice = new FakeDocker(() => MISSING);
    const once = monitor(twice);
    await once.ensure(TAG, SOCKET);
    await once.ensure(TAG, SOCKET);
    const runs = twice.calls.filter((call) => call.args[0] === 'run').map((call) => createIdOf(call.spec));
    expect(runs).toHaveLength(2);
    expect(runs[0]).not.toBe(runs[1]);
    // Not part of the label of the version.
    expect(remoteMonitorLabelValue(SCRIPT, TAG)).toBe(LABEL);
  });

  it('a conflict with a container of this version that does not run is a failure', async () => {
    const docker = new FakeDocker((args, index) => (index === 0 ? MISSING : args[0] === 'ps' ? [] : inspected(false, LABEL, 3)), CONFLICTED);
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('failed');
    // Not ours: not removed. The nonce is checked first, and the failure cleans up by the nonce only (nothing).
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'inspect', 'ps']);
    expect(docker.calls.some((call) => call.args[0] === 'rm')).toBe(false);
  });

  it('a signal aborted before the create is passed on without writing the script or waiting for the monitor', async () => {
    const controller = new AbortController();
    const docker = new FakeDocker((args) => {
      if (args[0] === 'inspect') controller.abort();
      return missingThenCreated(args);
    });
    await expect(monitor(docker).ensure(TAG, SOCKET, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(docker.inputs).toEqual([]);
    // The create gets the cancelled signal, and the engine client sends nothing then, so there is nothing to remove.
    expect(docker.commands()).toEqual(['inspect', 'run']);
    expect(docker.calls[1].signal).toBe(controller.signal);
  });

  it('a script whose line is exactly MAX_BUNDLE_LINE_LENGTH is accepted', async () => {
    const script = 'a'.repeat(MAX_BUNDLE_LINE_LENGTH - 2);
    expect(encodeBundle(script).length - 1).toBe(MAX_BUNDLE_LINE_LENGTH);
    const docker = new FakeDocker(() => MISSING);
    expect(await monitor(docker, new Log(), script).ensure(TAG, SOCKET)).toBe('created');
    expect(docker.inputs[0]).toHaveLength(MAX_BUNDLE_LINE_LENGTH + 1);
  });
});

describe('RemoteSessionMonitor.ensure: the signal of the stored-script check', () => {
  // Without the signal, a cancellation during the check would be ignored until the time limit of the call (up to 60 s)
  // ends it: the cancellation of the open is delayed by up to 60 s.
  it('the check of the stored script gets the signal of ensure, so a cancellation stops it', async () => {
    const controller = new AbortController();
    const docker = new FakeDocker((args, _index, call) => {
      if (args[0] === 'inspect') return inspected(true, LABEL, 0, 1);
      return new Promise<ArchiveAnswer>((resolve, reject) => {
        call.signal?.addEventListener('abort', () => reject(abortError()));
        // Without the signal: the time limit of the call ends it.
        setTimeout(() => resolve(undefined), 100);
      });
    });
    const ensured = monitor(docker).ensure(TAG, SOCKET, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await expect(ensured).rejects.toMatchObject({ name: 'AbortError' });
    expect(docker.commands()).toEqual(['inspect', 'archive']);
    expect(docker.calls[1].signal?.aborted).toBe(true);
  });
});

// The settings of the monitor's background run in the spec of the create.
describe('RemoteSessionMonitor: images', () => {
  // The daily time 06:07 as the cron schedule `7 6 * * *`.
  const IMAGES = { schedule: '7 6 * * *', timeZone: 'Europe/Vienna' };

  it('gives the container the schedule and outbound network, and no prefixes', () => {
    const plain = monitor(new FakeDocker(() => undefined));
    // The default network also without the settings of the background run.
    expect(plain.runSpec(TAG, SOCKET, LABEL, SCRIPT).network).toBe('default');
    const spec = plain.runSpec(TAG, SOCKET, LABEL, SCRIPT, IMAGES);
    expect(spec.network).toBe('default');
    expect(spec.env.DEVSPACE_IMAGE_PREFIXES).toBeUndefined();
    expect(spec.env.DEVSPACE_IMAGE_SCHEDULE).toBe('7 6 * * *');
    expect(spec.env.DEVSPACE_IMAGE_TZ).toBe('Europe/Vienna');
    // The schedule and the time zone of the background run, and no other variable.
    expect(spec.env).toEqual({ DEVSPACE_IMAGE_SCHEDULE: '7 6 * * *', DEVSPACE_IMAGE_TZ: 'Europe/Vienna' });
    // No published port: the spec has none to give (the create of the engine drops every capability and sets no new
    // privileges itself: engineClient.attached.test.ts).
    expect(Object.keys(spec).sort()).toEqual(['command', 'env', 'image', 'labels', 'log', 'mounts', 'name', 'network', 'restartPolicy']);
  });

  // The log of the monitor is capped with and without the settings of the background run,
  // with the json-file driver named (max-size alone fails where journald or syslog is the default driver).
  it('caps the Docker log of the container in every variant', () => {
    const plain = monitor(new FakeDocker(() => undefined));
    // The log of the container as the create of the engine takes it.
    expect(REMOTE_MONITOR_LOG).toEqual({ driver: 'json-file', maxSize: '1m', maxFile: '2' });
    for (const spec of [plain.runSpec(TAG, SOCKET, LABEL, SCRIPT), plain.runSpec(TAG, SOCKET, LABEL, SCRIPT, IMAGES)]) {
      expect(spec.log).toEqual({ driver: 'json-file', maxSize: '1m', maxFile: '2' });
    }
  });

  // The settings of the background run are not part of the label (they come with `settings -`), so two computers with
  // other settings do not replace the monitor of a shared engine at each open, and a computer without the settings
  // keeps it too. The mode is part of the label (remoteSessionMonitor.mode.test.ts).
  it('keeps the running container whatever the settings of the background run, also without them', async () => {
    const withImages = LABEL;
    expect(remoteMonitorLabelValue(SCRIPT, TAG, [])).toBe(LABEL);
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(true, LABEL) : undefined));
    const withSetting = new RemoteSessionMonitor({ engine: engineMonitor(docker.engine), logger: new Log(), script: async () => SCRIPT, imageMaintenance: () => IMAGES });
    expect(await withSetting.ensure(TAG, SOCKET)).toBe('running');
    expect(docker.calls.some((call) => call.args[0] === 'rm' || call.args[0] === 'run')).toBe(false);
    // Another computer: another schedule, another time zone: the running monitor stays.
    for (const other of [
      { ...IMAGES, schedule: '0 5 * * 1-5' },
      { ...IMAGES, timeZone: 'America/New_York' },
    ]) {
      const running = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(true, withImages) : undefined));
      const otherComputer = new RemoteSessionMonitor({ engine: engineMonitor(running.engine), logger: new Log(), script: async () => SCRIPT, imageMaintenance: () => other });
      expect(await otherComputer.ensure(TAG, SOCKET)).toBe('running');
      expect(running.calls.some((call) => call.args[0] === 'rm' || call.args[0] === 'run')).toBe(false);
    }
    // A computer without the settings of the background run: kept too.
    const off = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(true, withImages) : undefined));
    const offComputer = new RemoteSessionMonitor({ engine: engineMonitor(off.engine), logger: new Log(), script: async () => SCRIPT });
    expect(await offComputer.ensure(TAG, SOCKET)).toBe('running');
  });

  // The command line holds no script, so its length does not depend on the script (Windows limits a command line).
  it('keeps the command line independent of the length of the script', () => {
    const plain = monitor(new FakeDocker(() => undefined));
    const script = 'x'.repeat(28_000);
    const spec = plain.runSpec(TAG, SOCKET, LABEL, script, IMAGES);
    expect(JSON.stringify(spec).includes(script)).toBe(false);
    const short = plain.runSpec(TAG, SOCKET, LABEL, SCRIPT, IMAGES);
    expect(JSON.stringify(short).length).toBe(JSON.stringify(spec).length);
  });
});

// The version of Devspaces of the program that creates the Monitor (the worker: the version of the extension that
// started it) is a variable of the container (DEVSPACES_VERSION), for the header User-Agent of the Monitor and of its
// prepares, and never part of the label: a new version without a change of the script keeps the running Monitor.
describe('RemoteSessionMonitor: the version of Devspaces', () => {
  afterEach(() => {
    setUserAgentVersion(undefined);
  });

  it('gives a new container the version of this program; none without one, and the label is the same', async () => {
    const labels: string[] = [];
    const envs: Array<Record<string, string>> = [];
    for (const version of [undefined, '1.20.3', '1.20.4']) {
      setUserAgentVersion(version);
      const docker = new FakeDocker(missingThenCreated);
      const created = new RemoteSessionMonitor({ engine: engineMonitor(docker.engine), logger: new Log(), script: async () => SCRIPT });
      expect(await created.ensure(TAG, SOCKET)).toBe('created');
      const spec = docker.spec(docker.commands().indexOf('run'));
      labels.push(spec.labels[LABEL_MONITOR]);
      const { DEVSPACE_MONITOR_CREATE_ID: _nonce, ...env } = spec.env;
      envs.push(env);
    }
    expect(envs).toEqual([{}, { DEVSPACES_VERSION: '1.20.3' }, { DEVSPACES_VERSION: '1.20.4' }]);
    expect(labels).toEqual([LABEL, LABEL, LABEL]);
  });

  it('keeps the running Monitor that a window of another version created from the same script', async () => {
    setUserAgentVersion('1.20.4');
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(true, LABEL) : undefined));
    const current = new RemoteSessionMonitor({ engine: engineMonitor(docker.engine), logger: new Log(), script: async () => SCRIPT });
    expect(await current.ensure(TAG, SOCKET)).toBe('running');
    expect(docker.commands()).toEqual(['inspect']);
  });
});

// Two windows that replace or create the monitor at the same time. The
// removal of the old monitor tolerates a removal in progress; a name conflict of the create waits a few seconds while the
// container of the name is `created` or `removing`, accepts only a matching running or paused one, creates once more when
// the name became free, and never removes anything but the container of its own nonce.
describe('RemoteSessionMonitor.ensure: two windows at the same time', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The first create meets the name conflict; the next one (if any) starts. */
  const conflictThenStarts: OnCreate = (call, index) => (index === 0 ? CONFLICTED(call, index) : STARTS(call, index));
  /** The answers of the inspects in their order; the last one repeats. */
  const inspects = (...answers: unknown[]) => {
    let at = 0;
    return () => answers[Math.min(at++, answers.length - 1)];
  };
  // The conflict is checked by the nonce of this create (`ps`, a read), so only the `rm` calls count as removals;
  // noncePs checks that every `ps` is the list of the nonce of a create of this ensure.
  const removals = (docker: FakeDocker) => docker.calls.filter((call) => call.args[0] === 'rm');
  const noncePs = (docker: FakeDocker) => {
    const nonces = docker.calls.filter((call) => call.args[0] === 'run').map((call) => createIdOf(call.spec));
    for (const call of docker.calls.filter((each) => each.args[0] === 'ps')) {
      expect(call.args).toHaveLength(2);
      expect(nonces.map((nonce) => `${LABEL_MONITOR_CREATE}=${nonce}`)).toContain(call.args[1]);
    }
  };

  it('an rm that finds the removal already in progress goes on; the create waits for the name and creates once more', async () => {
    vi.useFakeTimers();
    const logger = new Log();
    const next = inspects(inspected(true, 'old-label'), inspected('removing', 'old-label'), MISSING);
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : args[0] === 'rm' ? inProgress() : undefined), conflictThenStarts);
    const ensured = monitor(docker, logger).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await ensured).toBe('created');
    // The nonce check after the conflict.
    expect(docker.commands()).toEqual(['inspect', 'rm', 'run', 'ps', 'inspect', 'inspect', 'run']);
    noncePs(docker);
    // Only the old monitor by its ID, once; nothing in the conflict loop.
    expect(removals(docker).map((call) => call.args)).toEqual([['rm', MONITOR_ID]]);
    const runs = docker.calls.filter((call) => call.args[0] === 'run');
    expect(createIdOf(runs[1].spec)).toBe(createIdOf(runs[0].spec));
    expect(docker.inputs[1]).toBe(encodeBundle(SCRIPT));
    expect(logger.lines.some((line) => line.startsWith('warn'))).toBe(false);
  });

  it('an rm that fails otherwise still fails, without a create', async () => {
    for (const answer of [
      () => Promise.reject(new EngineError('permission denied', 403)),
      // A failure that is no refusal of the engine is no removal in progress, whatever its text.
      () => Promise.reject(new Error(`removal of container ${MONITOR_ID} is already in progress`)),
    ]) {
      const docker = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(true, 'old-label') : args[0] === 'rm' ? answer() : undefined));
      expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('failed');
      expect(docker.commands()).toEqual(['inspect', 'rm']);
    }
  });

  it('a conflict with a matching container that another window is still creating waits until it runs', async () => {
    vi.useFakeTimers();
    const next = inspects(MISSING, inspected('created', LABEL), inspected('created', LABEL), inspected(true, LABEL));
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : undefined), CONFLICTED);
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await ensured).toBe('running');
    // The nonce check after the conflict.
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'inspect', 'inspect', 'inspect']);
    expect(removals(docker)).toEqual([]);
  });

  it('a paused matching container after a removal is accepted too', async () => {
    vi.useFakeTimers();
    const next = inspects(MISSING, inspected('removing', 'old-label'), inspected('paused', LABEL));
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : undefined), CONFLICTED);
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await ensured).toBe('running');
    expect(removals(docker)).toEqual([]);
  });

  it('a container that is still created after a few seconds is a failure, never accepted and never removed', async () => {
    vi.useFakeTimers();
    const logger = new Log();
    const next = inspects(MISSING, inspected('created', LABEL));
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : undefined), CONFLICTED);
    let settled = false;
    const ensured = monitor(docker, logger)
      .ensure(TAG, SOCKET)
      .finally(() => (settled = true));
    // The waits for a `removing` one: a few seconds in all.
    const conflictTotal = REMOTE_MONITOR_CONFLICT_WAITS_MS.reduce((sum, ms) => sum + ms, 0);
    expect(conflictTotal).toBeGreaterThanOrEqual(2_000);
    expect(conflictTotal).toBeLessThanOrEqual(5_000);
    // A `created` one gets the waits of the first look (REMOTE_MONITOR_CREATED_WAITS_MS, 12.75 s).
    const total = REMOTE_MONITOR_CREATED_WAITS_MS.reduce((sum, ms) => sum + ms, 0);
    await vi.advanceTimersByTimeAsync(total - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await ensured).toBe('failed');
    // The nonce check after the conflict, a look after each of REMOTE_MONITOR_CREATED_WAITS_MS, and the cleanup by the
    // nonce before the failure (it finds nothing: the conflict made no container).
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', ...REMOTE_MONITOR_CREATED_WAITS_MS.map(() => 'inspect'), 'inspect', 'ps']);
    expect(removals(docker)).toEqual([]);
    noncePs(docker);
    expect(logger.lines.join('\n')).toMatch(/warn The Monitor on the Docker host could not be started: docker run failed: .*already in use/);
  });

  it('a running container of another label after a removal is a failure, not removed', async () => {
    vi.useFakeTimers();
    const next = inspects(MISSING, inspected('removing', LABEL), inspected(true, 'other-label'));
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : undefined), CONFLICTED);
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await ensured).toBe('failed');
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'inspect', 'inspect', 'ps']);
    expect(removals(docker)).toEqual([]);
  });

  it('another status (restarting) fails at once, without a wait', async () => {
    const next = inspects(MISSING, inspected('restarting', LABEL, 3));
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : undefined), CONFLICTED);
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('failed');
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'inspect', 'ps']);
    expect(removals(docker)).toEqual([]);
  });

  it('when the name is free after a conflict, the create is tried once more only', async () => {
    const docker = new FakeDocker(() => MISSING, CONFLICTED);
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('failed');
    // The nonce check after each conflict, and the cleanup by the nonce before the failure.
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'inspect', 'run', 'ps', 'inspect', 'ps']);
    expect(removals(docker)).toEqual([]);
    noncePs(docker);
  });

  it('a create once more that fails otherwise removes only the container of its own nonce', async () => {
    // The nonce check after the conflict finds no container (the conflict made none); only the cleanup after the second
    // create finds it.
    let lists = 0;
    const docker = new FakeDocker(
      (args) => (args[0] === 'inspect' ? MISSING : args[0] === 'ps' ? (lists++ === 0 ? [] : [CREATED_ID]) : undefined),
      (call, index) => (index === 0 ? CONFLICTED(call, index) : ENDS()(call, index)),
    );
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('failed');
    // The nonce check after the conflict.
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'inspect', 'run', 'ps', 'rm']);
    expect(docker.calls[5].args).toEqual(nonceList(docker.spec(4)));
    expect(docker.calls[6].args).toEqual(['rm', CREATED_ID]);
  });

  it('a cancellation during a wait of the conflict passes at once, and nothing is removed', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const next = inspects(MISSING, inspected('created', LABEL));
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : undefined), CONFLICTED);
    const ensured = monitor(docker).ensure(TAG, SOCKET, controller.signal);
    const rejected = expect(ensured).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(100);
    // The nonce check after the conflict, which gets the signal too.
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'inspect']);
    // The list and the inspect of the conflict get the signal (engineMonitor links it to the time limit of each call).
    expect([docker.calls[2], docker.calls[3]].map((call) => call.signal?.aborted)).toEqual([false, false]);
    controller.abort();
    await rejected;
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'inspect']);
    expect(removals(docker)).toEqual([]);
    expect([docker.calls[2], docker.calls[3]].map((call) => call.signal?.aborted)).toEqual([true, true]);
  });
});

// Mutation probes of the stored-script check, the signals and the IDs.
describe('RemoteSessionMonitor.ensure: probes of the stored-script check and the IDs', () => {
  // The removal of the old monitor gets the signal of ensure: a cancellation of the open must not wait up to 60 s for
  // it.
  it('the removal of the old monitor gets the signal of ensure', async () => {
    const controller = new AbortController();
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(true, 'old-label') : undefined));
    expect(await monitor(docker).ensure(TAG, SOCKET, controller.signal)).toBe('created');
    expect(docker.calls[1].args).toEqual(['rm', MONITOR_ID]);
    // Linked to it by engineMonitor.
    expectSignalsFollow([docker.calls[1]], controller);
  });

  // The cleanup of a failed create removes only what the list of its nonce gave as a full ID: never a name or another
  // word of the answer.
  it('the cleanup of a failed create removes only full IDs of its list', async () => {
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? MISSING : args[0] === 'ps' ? ['devspaces-monitor', CREATED_ID.slice(0, 12), CREATED_ID] : undefined), ENDS());
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('failed');
    expect(docker.calls.filter((call) => call.args[0] === 'rm').map((call) => call.args)).toEqual([['rm', CREATED_ID]]);
  });

  // An ID that is not exactly 64 lower-case hex digits is not used.
  for (const id of [`x${MONITOR_ID}`, `${MONITOR_ID}0`]) {
    it(`an inspected ID ${id.startsWith('x') ? 'with a prefix' : 'with a suffix'} is not used for the removal`, async () => {
      const docker = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(true, 'old-label', 0, 0, id) : undefined));
      // Never removed by its name; the ensure fails and removes nothing.
      expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('failed');
      expect(docker.commands()).toEqual(['inspect']);
    });
  }
});

// A `created` container is removed only when it is certainly abandoned, the name conflict is only the engine's refusal
// of the name and no container of our nonce, a restarted container after a conflict is accepted only with its stored
// script, a started exited container is checked for its stored script, and nothing is ever removed or started by the
// name.
describe('RemoteSessionMonitor.ensure: created containers, the nonce, and IDs', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const SHA = ['archive', 'devspaces-monitor', REMOTE_MONITOR_SCRIPT_PATH];
  const OTHER_ID = 'beef'.padEnd(64, '2');
  /** `.Created` of the inspected container, as Docker gives it (nanoseconds), and the same in ms. */
  const CREATED_AT = '2026-09-30T10:00:00.123456789Z';
  const CREATED_MS = Date.UTC(2026, 8, 30, 10, 0, 0, 123);
  const createdIn = (label: string | undefined, id: unknown = MONITOR_ID) => inspected('created', label, 0, 0, id, CREATED_AT);
  /** The clock of the daemon (DockerEngine.systemTime) at `ageMs` after the create, with an offset as the daemon may give it. */
  const systemTime = (ageMs: number) => {
    const at = new Date(CREATED_MS + ageMs + 2 * 3_600_000);
    return `${at.toISOString().slice(0, 23)}456789+02:00`;
  };
  const inspects = (...answers: unknown[]) => {
    let at = 0;
    return () => answers[Math.min(at++, answers.length - 1)];
  };
  const removals = (docker: FakeDocker) => docker.calls.filter((call) => call.args[0] === 'rm');
  const CREATED_WAIT_TOTAL = REMOTE_MONITOR_CREATED_WAITS_MS.reduce((sum, ms) => sum + ms, 0);
  const allCreatedLooks = ['inspect', ...REMOTE_MONITOR_CREATED_WAITS_MS.map(() => 'inspect')];

  it('the created-wait is bounded to 10-15 s and the stale age is the Docker time limit plus 30 s', () => {
    expect(CREATED_WAIT_TOTAL).toBeGreaterThanOrEqual(10_000);
    expect(CREATED_WAIT_TOTAL).toBeLessThanOrEqual(15_000);
    expect(REMOTE_MONITOR_STALE_CREATED_MS).toBe(REMOTE_MONITOR_DOCKER_TIMEOUT_MS + 30_000);
  });

  // A failed create that never ends fails, with its cleanup, within the Docker time limit plus 10 s of fake time: a
  // create without an answer, which the time limit of the create ends.
  it('a failed create that never ends fails within the Docker time limit plus 10 s', async () => {
    vi.useFakeTimers();
    const docker = new FakeDocker(missingThenCreated, HANGS);
    let outcome: string | undefined;
    void monitor(docker)
      .ensure(TAG, SOCKET)
      .then((value) => (outcome = value));
    await vi.advanceTimersByTimeAsync(REMOTE_MONITOR_DOCKER_TIMEOUT_MS + 10_000);
    expect(outcome).toBe('failed');
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'rm']);
  });

  it('a matching created container that another window starts meanwhile is accepted, never removed', async () => {
    vi.useFakeTimers();
    const next = inspects(createdIn(LABEL), createdIn(LABEL), inspected(true, LABEL));
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : undefined));
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL);
    expect(await ensured).toBe('running');
    expect(docker.commands()).toEqual(['inspect', 'inspect', 'inspect']);
    expect(removals(docker)).toEqual([]);
  });

  it('a matching created container that goes on to paused is accepted too', async () => {
    vi.useFakeTimers();
    const next = inspects(createdIn(LABEL), inspected('paused', LABEL, 0, 3));
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : undefined));
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL);
    expect(await ensured).toBe('running');
    expect(removals(docker)).toEqual([]);
  });

  it('a created container that is gone meanwhile (the other window gave up) is created, nothing removed', async () => {
    vi.useFakeTimers();
    const next = inspects(createdIn(LABEL), MISSING);
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : undefined));
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL);
    expect(await ensured).toBe('created');
    expect(docker.commands()).toEqual(['inspect', 'inspect', 'run']);
    expect(removals(docker)).toEqual([]);
  });

  it('a created container that exits with 3 meanwhile goes through the table (replaced by its ID)', async () => {
    vi.useFakeTimers();
    const next = inspects(createdIn(LABEL), inspected(false, LABEL, 3));
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : undefined));
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL);
    expect(await ensured).toBe('created');
    expect(docker.commands()).toEqual(['inspect', 'inspect', 'rm', 'run']);
    expect(docker.calls[2].args).toEqual(['rm', MONITOR_ID]);
  });

  it('another ID at the name during the wait ends the wait; that container goes through the table', async () => {
    vi.useFakeTimers();
    const next = inspects(createdIn(LABEL), inspected(true, LABEL, 0, 0, OTHER_ID));
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : undefined));
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL);
    expect(await ensured).toBe('running');
    expect(docker.commands()).toEqual(['inspect', 'inspect']);
  });

  // Another ID found `created` during the wait: the waits start once more for the new ID. It starts → running; still
  // `created` after the second wait → judged by its own age: young, so kept (failed), nothing removed.
  it('a created container of another ID gets the wait once more; it starts → running, nothing removed', async () => {
    vi.useFakeTimers();
    // The old ID was abandoned long ago, but another window just created a new one (its own Created, 1 s before now).
    const now = REMOTE_MONITOR_STALE_CREATED_MS * 10;
    const young = inspected('created', LABEL, 0, 0, OTHER_ID, new Date(CREATED_MS + now - 1_000).toISOString());
    const next = inspects(createdIn(LABEL), young, young, inspected(true, LABEL, 0, 0, OTHER_ID));
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : args[0] === 'info' ? systemTime(now) : undefined));
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL);
    expect(await ensured).toBe('running');
    expect(docker.commands()).toEqual(['inspect', 'inspect', 'inspect', 'inspect']);
    expect(removals(docker)).toEqual([]);
  });

  it('a created container of another ID still created after the second wait is judged by its own age: young, so kept', async () => {
    vi.useFakeTimers();
    const now = REMOTE_MONITOR_STALE_CREATED_MS * 10;
    const young = inspected('created', LABEL, 0, 0, OTHER_ID, new Date(CREATED_MS + now - 1_000).toISOString());
    const next = inspects(createdIn(LABEL), young);
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : args[0] === 'info' ? systemTime(now) : undefined));
    let settled = false;
    const ensured = monitor(docker)
      .ensure(TAG, SOCKET)
      .finally(() => (settled = true));
    // The first look at the new ID uses the first wait (250 ms) of the first list; then its own full list.
    const first = REMOTE_MONITOR_CREATED_WAITS_MS[0];
    await vi.advanceTimersByTimeAsync(first + CREATED_WAIT_TOTAL - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await ensured).toBe('failed');
    expect(docker.commands()).toEqual(['inspect', 'inspect', ...REMOTE_MONITOR_CREATED_WAITS_MS.map(() => 'inspect'), 'info']);
    expect(removals(docker)).toEqual([]);
  });

  it('a matching container that stays created but is young fails after the bounded wait, nothing removed', async () => {
    vi.useFakeTimers();
    const logger = new Log();
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? createdIn(LABEL) : args[0] === 'info' ? systemTime(10_000) : undefined));
    let settled = false;
    const ensured = monitor(docker, logger)
      .ensure(TAG, SOCKET)
      .finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await ensured).toBe('failed');
    expect(docker.commands()).toEqual([...allCreatedLooks, 'info']);
    // The clock of the daemon from the port.
    expect(docker.calls.at(-1)?.args).toEqual(['info']);
    expect(removals(docker)).toEqual([]);
    expect(logger.lines.join('\n')).toMatch(/warn .*created 10 seconds ago and has not started yet .*it is kept\./);
  });

  it('a matching container that stays created and is older than the stale age is removed by its ID, then created', async () => {
    vi.useFakeTimers();
    const logger = new Log();
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? createdIn(LABEL) : args[0] === 'info' ? systemTime(REMOTE_MONITOR_STALE_CREATED_MS + 1) : undefined));
    const ensured = monitor(docker, logger).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL);
    expect(await ensured).toBe('created');
    expect(docker.commands()).toEqual([...allCreatedLooks, 'info', 'rm', 'run']);
    expect(removals(docker).map((call) => call.args)).toEqual([['rm', MONITOR_ID]]);
    expect(logger.lines).toContain('info The Monitor on the Docker host was created 90 seconds ago and never started; it is replaced (devspaces-monitor).');
  });

  it('exactly at the stale age it is kept', async () => {
    vi.useFakeTimers();
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? createdIn(LABEL) : args[0] === 'info' ? systemTime(REMOTE_MONITOR_STALE_CREATED_MS) : undefined));
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL);
    expect(await ensured).toBe('failed');
    expect(removals(docker)).toEqual([]);
  });

  // The clock of the port, or its failure.
  for (const [what, info] of [
    ['a failed docker info', () => Promise.reject(new EngineError('Cannot connect to the Docker daemon', 500))],
    ['docker info without an answer in time', () => Promise.reject(new Error('no answer in time'))],
    ['docker info that throws', () => Promise.reject(new Error('Docker Desktop is not installed.'))],
    ['a time of the daemon that is not a time', () => 'yesterday'],
    ['an empty answer of docker info', () => ''],
    ['a time of the daemon without a zone', () => '2026-09-30T10:05:00'],
  ] as const) {
    it(`${what} keeps an old created container (failed, nothing removed)`, async () => {
      vi.useFakeTimers();
      const logger = new Log();
      const docker = new FakeDocker((args) => (args[0] === 'inspect' ? createdIn(LABEL) : args[0] === 'info' ? info() : undefined));
      const ensured = monitor(docker, logger).ensure(TAG, SOCKET);
      await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL);
      expect(await ensured).toBe('failed');
      expect(docker.commands()).toEqual([...allCreatedLooks, 'info']);
      expect(removals(docker)).toEqual([]);
      expect(logger.lines.some((line) => line.startsWith('info The time of the Docker host cannot be read'))).toBe(true);
      expect(logger.lines.join('\n')).toContain('its age cannot be read; it is kept.');
    });
  }

  // A creation time after the daemon's clock (the clock was set back) is a negative age, never a large one: the young
  // container of a live create is kept.
  it('a created container whose creation time is after the clock of the daemon is kept', async () => {
    vi.useFakeTimers();
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? createdIn(LABEL) : args[0] === 'info' ? systemTime(-(REMOTE_MONITOR_STALE_CREATED_MS + 60_000)) : undefined));
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL);
    expect(await ensured).toBe('failed');
    expect(docker.commands()).toEqual([...allCreatedLooks, 'info']);
    expect(removals(docker)).toEqual([]);
  });

  // A cancellation during `docker info` of the age check passes as an AbortError; nothing is removed and nothing runs
  // after it.
  it('a cancellation during docker info of the age check passes; nothing removed, nothing after it', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const docker = new FakeDocker((args) => {
      if (args[0] === 'inspect') return createdIn(LABEL);
      if (args[0] === 'info') {
        controller.abort();
        return Promise.reject(abortError());
      }
      return undefined;
    });
    const ensured = monitor(docker).ensure(TAG, SOCKET, controller.signal);
    const rejected = expect(ensured).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL);
    await rejected;
    expect(docker.commands()).toEqual([...allCreatedLooks, 'info']);
    expect(removals(docker)).toEqual([]);
  });

  for (const [what, created] of [
    ['no creation time', undefined],
    ['Docker\'s zero time', '0001-01-01T00:00:00Z'],
    ['a creation time that is not one', 'soon'],
    ['a creation time that is a number', 1_727_690_400],
  ] as const) {
    it(`a created container with ${what} is kept without asking the daemon's clock`, async () => {
      vi.useFakeTimers();
      const docker = new FakeDocker((args) =>
        args[0] === 'inspect' ? inspected('created', LABEL, 0, 0, MONITOR_ID, created) : args[0] === 'info' ? systemTime(REMOTE_MONITOR_STALE_CREATED_MS * 100) : undefined,
      );
      const ensured = monitor(docker).ensure(TAG, SOCKET);
      await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL);
      expect(await ensured).toBe('failed');
      expect(docker.commands()).toEqual(allCreatedLooks);
      expect(removals(docker)).toEqual([]);
    });
  }

  it('a created container of another label is not removed at once either: young → kept, old → removed by its ID', async () => {
    vi.useFakeTimers();
    for (const [age, outcome] of [
      [5_000, 'failed'],
      [REMOTE_MONITOR_STALE_CREATED_MS + 60_000, 'created'],
    ] as const) {
      const docker = new FakeDocker((args) => (args[0] === 'inspect' ? createdIn('old-label') : args[0] === 'info' ? systemTime(age) : undefined));
      const ensured = monitor(docker).ensure(TAG, SOCKET);
      await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL);
      expect(await ensured).toBe(outcome);
      expect(removals(docker).map((call) => call.args)).toEqual(outcome === 'created' ? [['rm', MONITOR_ID]] : []);
    }
  });

  it('an old created container whose ID cannot be read is kept (never removed by its name)', async () => {
    vi.useFakeTimers();
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? createdIn(LABEL, null) : args[0] === 'info' ? systemTime(REMOTE_MONITOR_STALE_CREATED_MS * 2) : undefined));
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL);
    expect(await ensured).toBe('failed');
    expect(removals(docker)).toEqual([]);
    expect(docker.commands()).not.toContain('run');
  });

  // engineMonitor links the signal of each call to that of ensure, within the time limit of a Docker call
  // (engineMonitor.timeLimits.test.ts pins that limit).
  it('a cancellation during the created-wait passes at once; the looks and docker info get the signal', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? createdIn(LABEL) : undefined));
    const ensured = monitor(docker).ensure(TAG, SOCKET, controller.signal);
    const rejected = expect(ensured).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(300);
    expect(docker.commands()).toEqual(['inspect', 'inspect']);
    expect(docker.calls.map((call) => call.signal?.aborted)).toEqual([false, false]);
    controller.abort();
    await rejected;
    expect(docker.commands()).toEqual(['inspect', 'inspect']);
    expect(docker.calls.map((call) => call.signal?.aborted)).toEqual([true, true]);
    // docker info with the signal.
    const timed = new FakeDocker((args) => (args[0] === 'inspect' ? createdIn(LABEL) : args[0] === 'info' ? systemTime(1_000) : undefined));
    const other = new AbortController();
    const again = monitor(timed).ensure(TAG, SOCKET, other.signal);
    await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL);
    expect(await again).toBe('failed');
    expectSignalsFollow(timed.calls.filter((call) => call.args[0] === 'info'), other);
  });

  it('a conflict while a container with the nonce of this create exists is no conflict: removed by its nonce, fails', async () => {
    const docker = new FakeDocker((args, index) => (index === 0 ? MISSING : args[0] === 'ps' ? [CREATED_ID] : inspected(true, LABEL)), CONFLICTED);
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('failed');
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'ps', 'rm']);
    expect(removals(docker).map((call) => call.args)).toEqual([['rm', CREATED_ID]]);
    expect(docker.calls[2].args).toEqual(nonceList(docker.spec(1)));
  });

  // The failure of the list of the port.
  for (const [what, list] of [
    ['a list of the nonce that fails', () => Promise.reject(new EngineError('error during connect', 500))],
    ['a list of the nonce without an answer in time', () => Promise.reject(new Error('no answer in time'))],
    ['a list of the nonce that throws', () => Promise.reject(new Error('spawn failed'))],
  ] as const) {
    it(`${what} after a conflict fails; nothing is accepted or removed`, async () => {
      const docker = new FakeDocker((args, index) => (index === 0 ? MISSING : args[0] === 'ps' ? list() : inspected(true, LABEL)), CONFLICTED);
      expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('failed');
      expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'ps']);
      expect(removals(docker)).toEqual([]);
    });
  }

  // A cancellation during the nonce check after a conflict passes as an AbortError: no cleanup, no look at the
  // container, no warning.
  it('a cancellation during the nonce check after a conflict passes; nothing removed, no warning', async () => {
    const controller = new AbortController();
    const logger = new Log();
    const docker = new FakeDocker((args, index) => {
      if (index === 0) return MISSING;
      if (args[0] === 'ps') {
        controller.abort();
        return Promise.reject(abortError());
      }
      return inspected(true, LABEL);
    }, CONFLICTED);
    await expect(monitor(docker, logger).ensure(TAG, SOCKET, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps']);
    expect(logger.lines.some((line) => line.startsWith('warn'))).toBe(false);
  });

  // The signal of the nonce check follows that of ensure; that of the cleanup does not (engineMonitor gives it only its
  // own time limit, engineMonitor.timeLimits.test.ts).
  it('the nonce check after a conflict gets the signal; the cleanup does not', async () => {
    const controller = new AbortController();
    const docker = new FakeDocker((args, index) => (index === 0 ? MISSING : args[0] === 'ps' ? [] : inspected(true, 'other-label')), CONFLICTED);
    expect(await monitor(docker).ensure(TAG, SOCKET, controller.signal)).toBe('failed');
    const lists = docker.calls.filter((call) => call.args[0] === 'ps');
    expect(lists).toHaveLength(2);
    expectSignalsFollow([lists[0]], controller);
    expect(lists[1].signal?.aborted).toBe(false);
  });

  // After a conflict, a matching running container that Docker restarted is accepted only with its stored script.
  for (const [what, answer, outcome] of [
    ['the stored script of this version', SAME, 'running'],
    ['no stored script', NO_SCRIPT, 'failed'],
    ['a check without an answer in time', TIMED_OUT, 'failed'],
  ] as const) {
    it(`a conflict with a matching running container with RestartCount 2 and ${what} → ${outcome}, nothing removed`, async () => {
      const docker = new FakeDocker((args, index) => (index === 0 ? MISSING : args[0] === 'ps' ? [] : args[0] === 'archive' ? answer : inspected(true, LABEL, 0, 2)), CONFLICTED);
      expect(await monitor(docker).ensure(TAG, SOCKET)).toBe(outcome);
      expect(docker.commands()).toEqual(outcome === 'running' ? ['inspect', 'run', 'ps', 'inspect', 'archive'] : ['inspect', 'run', 'ps', 'inspect', 'archive', 'ps']);
      expect(docker.calls[4].args).toEqual(SHA);
      expect(removals(docker)).toEqual([]);
    });
  }

  // The check of the stored script of a restarted container after a conflict gets the signal of ensure and a time
  // limit.
  it('the stored-script check after a conflict gets the signal and a time limit of ensure', async () => {
    const controller = new AbortController();
    const docker = new FakeDocker((args, index) => (index === 0 ? MISSING : args[0] === 'ps' ? [] : args[0] === 'archive' ? SAME : inspected(true, LABEL, 0, 2)), CONFLICTED);
    expect(await monitor(docker).ensure(TAG, SOCKET, controller.signal)).toBe('running');
    const read = docker.calls.find((call) => call.args[0] === 'archive');
    expect(read).toBeDefined();
    // Linked to it within the time limit of a Docker call, by engineMonitor.
    expectSignalsFollow([read!], controller);
  });

  it('a conflict with a matching paused container with RestartCount 2 is accepted only with its stored script', async () => {
    const docker = new FakeDocker((args, index) => (index === 0 ? MISSING : args[0] === 'ps' ? [] : args[0] === 'archive' ? SAME : inspected('paused', LABEL, 0, 2)), CONFLICTED);
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('running');
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'inspect', 'archive']);
    const without = new FakeDocker((args, index) => (index === 0 ? MISSING : args[0] === 'ps' ? [] : args[0] === 'archive' ? NO_SCRIPT : inspected('paused', LABEL, 0, 2)), CONFLICTED);
    expect(await monitor(without).ensure(TAG, SOCKET)).toBe('failed');
    expect(without.calls.some((call) => call.args[0] === 'rm')).toBe(false);
  });

  // An exited container of this version is started by its ID, then its stored script is checked.
  it('started by its ID with the stored script of this version → started', async () => {
    const logger = new Log();
    const controller = new AbortController();
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(false, LABEL, 137) : args[0] === 'archive' ? SAME : undefined));
    expect(await monitor(docker, logger).ensure(TAG, SOCKET, controller.signal)).toBe('started');
    expect(docker.calls.map((call) => call.args)).toEqual([expect.anything(), ['start', MONITOR_ID], SHA]);
    // The signals of the start and of the check are linked to it.
    expectSignalsFollow([docker.calls[1], docker.calls[2]], controller);
    expect(logger.lines).toEqual(['info The Monitor on the Docker host was started again (devspaces-monitor).']);
  });

  for (const [what, answer] of [
    ['no stored script', NO_SCRIPT],
    ['another stored script', Buffer.from(`${SCRIPT}x`)],
  ] as const) {
    it(`started, then ${what} → removed by that ID and created`, async () => {
      const logger = new Log();
      const docker = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(false, LABEL, 0) : args[0] === 'archive' ? answer : undefined));
      expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('created');
      expect(docker.commands()).toEqual(['inspect', 'start', 'archive', 'rm', 'run']);
      expect(docker.calls[1].args).toEqual(['start', MONITOR_ID]);
      expect(docker.calls[3].args).toEqual(['rm', MONITOR_ID]);
      expect(logger.lines).toContain('info The Monitor on the Docker host was started again without its script; it is replaced (devspaces-monitor).');
    });
  }

  for (const [what, answer] of [
    ['a check without an answer in time', TIMED_OUT],
    ['an SSH failure', new EngineError('error during connect: ssh: connect to host build-box port 22: Connection refused', 0)],
  ] as const) {
    it(`started, then ${what} → kept (started, logged), nothing removed`, async () => {
      const logger = new Log();
      const docker = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(false, LABEL, 0) : args[0] === 'archive' ? answer : undefined));
      expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('started');
      // A check that fails is followed by an inspect by the same ID (here exited again with an exit code other than 3
      // and the same RestartCount: no evidence, kept).
      expect(docker.commands()).toEqual(['inspect', 'start', 'archive', 'inspect']);
      expect(logger.lines).toEqual([
        'info The Monitor on the Docker host was started again and its stored script could not be checked; it is kept (devspaces-monitor).',
      ]);
    });
  }

  it('a failed start fails, nothing removed', async () => {
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(false, LABEL, 0) : args[0] === 'start' ? Promise.reject(new EngineError('permission denied', 403)) : undefined));
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('failed');
    expect(docker.commands()).toEqual(['inspect', 'start']);
  });

  // Never by the name. An ID that cannot be read keeps the container and fails, for each path of the table.
  for (const [what, answer, commands] of [
    ['exited (to be started)', inspected(false, LABEL, 0, 0, null), ['inspect']],
    ['exited with 3', inspected(false, LABEL, 3, 0, null), ['inspect']],
    ['restarting', inspected('restarting', LABEL, 3, 0, null), ['inspect', 'archive']],
    ['dead', inspected('dead', LABEL, 0, 0, null), ['inspect']],
    ['of another label', inspected(true, 'old-label', 0, 0, null), ['inspect']],
    ['running with RestartCount 1 and no stored script', inspected(true, LABEL, 0, 1, null), ['inspect', 'archive']],
  ] as const) {
    it(`a container ${what} whose ID cannot be read is kept: failed, nothing removed or started by its name`, async () => {
      const logger = new Log();
      const docker = new FakeDocker((args) => (args[0] === 'inspect' ? answer : args[0] === 'archive' ? NO_SCRIPT : undefined));
      expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('failed');
      expect(docker.commands()).toEqual(commands);
      expect(docker.calls.some((call) => call.args.includes('devspaces-monitor') && call.args[0] !== 'inspect' && call.args[0] !== 'archive')).toBe(false);
      expect(logger.lines.join('\n')).toContain('the ID of the Monitor container cannot be read; it is kept.');
      expect(logger.lines.some((line) => line.includes('it is replaced'))).toBe(false);
    });
  }

  it('parseDockerTime reads Docker times and nothing else', () => {
    expect(parseDockerTime(CREATED_AT)).toBe(CREATED_MS);
    expect(parseDockerTime('2026-09-30T12:00:00.123+02:00')).toBe(CREATED_MS);
    expect(parseDockerTime('2026-09-30T06:30:00.123999-03:30')).toBe(CREATED_MS);
    expect(parseDockerTime('2026-09-30T10:00:00Z')).toBe(CREATED_MS - 123);
    for (const bad of [undefined, null, 1, '', 'soon', '2026-09-30T10:00:00', '2026-09-30 10:00:00Z', '2026-13-01T00:00:00Z', '2026-02-30T00:00:00Z', '2026-09-30T24:00:00Z', '0001-01-01T00:00:00Z', '2026-09-30T10:00:00.1234567890Z', ` ${CREATED_AT}`]) {
      expect(parseDockerTime(bad), String(bad)).toBeUndefined();
    }
  });
});

// Mutation probes of the start, the removal and the conflict.
describe('RemoteSessionMonitor.ensure: probes of the start, the removal and the conflict', () => {
  // A test here uses fake timers; every test gets the real ones back.
  afterEach(() => {
    vi.useRealTimers();
  });

  // The tolerance of a missing container or a removal in progress is for the removal only: a start that fails so must
  // not report `started` while nothing runs (the engine's refusals).
  for (const [what, answer] of [
    ['a missing container', () => Promise.reject(new EngineError(`No such container: ${MONITOR_ID}`, 404))],
    ['a removal in progress', inProgress],
  ] as const) {
    it(`a docker start that finds ${what} fails`, async () => {
      const logger = new Log();
      const docker = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(false, LABEL, 0) : args[0] === 'start' ? answer() : undefined));
      expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('failed');
      expect(docker.commands()).toEqual(['inspect', 'start']);
      // Started by its ID.
      expect(docker.calls[1].args).toEqual(['start', MONITOR_ID]);
      expect(logger.lines.join('\n')).toMatch(/^warn The Monitor on the Docker host could not be started: docker start failed/m);
    });
  }

  // A failed removal without a message is a failure too.
  it('an rm that fails without stderr fails, without a create', async () => {
    const logger = new Log();
    // The engine refuses without a message, as the engine client reports it.
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(true, 'old-label') : args[0] === 'rm' ? Promise.reject(new EngineError('HTTP status 500', 500)) : undefined));
    expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('failed');
    expect(docker.commands()).toEqual(['inspect', 'rm']);
    // The rm is by the ID.
    expect(docker.calls[1].args).toEqual(['rm', MONITOR_ID]);
    expect(logger.lines.join('\n')).toContain('docker rm failed: HTTP status 500');
  });

  // A cancellation between the look at the conflict and its wait passes at once.
  it('a cancellation during the look of the conflict passes without a wait', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let looks = 0;
    const docker = new FakeDocker((args) => {
      if (args[0] !== 'inspect') return undefined;
      looks += 1;
      if (looks === 1) return MISSING;
      controller.abort();
      return inspected('created', LABEL);
    }, CONFLICTED);
    // With fake timers (a real elapsed time depends on the load of the machine): no time passes and the ensure has
    // already rejected, with no timer left.
    const ensured = monitor(docker).ensure(TAG, SOCKET, controller.signal);
    const rejected = expect(ensured).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    await rejected;
    // The nonce check changes the exact calls, so the outcome is checked.
    expect(docker.commands().filter((command) => command === 'run')).toHaveLength(1);
    expect(docker.commands()).not.toContain('rm');
  });

  // A look of the conflict that fails is a failure, not a free name.
  it('a failed inspect after a conflict fails without another create', async () => {
    let looks = 0;
    // The inspect of the port fails.
    const docker = new FakeDocker((args) => (args[0] !== 'inspect' ? undefined : (looks += 1) === 1 ? MISSING : Promise.reject(new Error('no answer in time'))), CONFLICTED);
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('failed');
    // The nonce check changes the exact calls, so the outcome is checked.
    expect(docker.commands().filter((command) => command === 'run')).toHaveLength(1);
    expect(docker.commands()).not.toContain('rm');
  });
});

describe('RemoteSessionMonitor.ensure: the waits of a conflict and of a created container', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const OTHER_ID = 'beef'.padEnd(64, '2');
  const THIRD_ID = 'dead'.padEnd(64, '3');
  const CREATED_AT = '2026-09-30T10:00:00.123456789Z';
  const CREATED_MS = Date.UTC(2026, 8, 30, 10, 0, 0, 123);
  const createdIn = (label: string | undefined, id: unknown = MONITOR_ID) => inspected('created', label, 0, 0, id, CREATED_AT);
  const systemTime = (ageMs: number) => new Date(CREATED_MS + ageMs).toISOString();
  const inspects = (...answers: unknown[]) => {
    let at = 0;
    return () => answers[Math.min(at++, answers.length - 1)];
  };
  const sum = (waits: readonly number[]) => waits.reduce((total, ms) => total + ms, 0);
  const removals = (docker: FakeDocker) => docker.calls.filter((call) => call.args[0] === 'rm' || call.args[0] === 'start');
  /** The inspects after a conflict: `created` until `untilMs` of fake time have passed, then `after`. */
  const createdUntil = (untilMs: number, after: unknown) => {
    const start = Date.now();
    let first = true;
    return () => {
      if (first) {
        first = false;
        return MISSING;
      }
      return Date.now() - start < untilMs ? inspected('created', LABEL) : after;
    };
  };

  it('a conflict with a container that is created for about 8 s and then runs with the matching label → running, nothing removed', async () => {
    vi.useFakeTimers();
    const logger = new Log();
    const next = createdUntil(8_000, inspected(true, LABEL));
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : undefined), CONFLICTED);
    const ensured = monitor(docker, logger).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(sum(REMOTE_MONITOR_CREATED_WAITS_MS));
    expect(await ensured).toBe('running');
    expect(removals(docker)).toEqual([]);
    expect(docker.commands().filter((command) => command === 'run')).toHaveLength(1);
    expect(logger.lines.some((line) => line.startsWith('warn'))).toBe(false);
  });

  it('a conflict with a container that stays created through all waits → failed after 12.75 s, nothing removed', async () => {
    vi.useFakeTimers();
    const next = createdUntil(Number.POSITIVE_INFINITY, MISSING);
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : undefined), CONFLICTED);
    let settled = false;
    const ensured = monitor(docker)
      .ensure(TAG, SOCKET)
      .finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(sum(REMOTE_MONITOR_CREATED_WAITS_MS) - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await ensured).toBe('failed');
    expect(removals(docker)).toEqual([]);
    expect(docker.commands().filter((command) => command === 'info')).toEqual([]);
  });

  it('a container that stays removing gets the short waits, the last one repeated up to the budget (7.75 s), nothing removed', async () => {
    vi.useFakeTimers();
    const next = inspects(MISSING, inspected('removing', LABEL));
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : undefined), CONFLICTED);
    let settled = false;
    const ensured = monitor(docker)
      .ensure(TAG, SOCKET)
      .finally(() => (settled = true));
    // Only the budget (the longer list, 9 waits) ends the looks; the shorter list repeats its last wait.
    const budget = Math.max(REMOTE_MONITOR_CREATED_WAITS_MS.length, REMOTE_MONITOR_CONFLICT_WAITS_MS.length);
    const waits = Array.from({ length: budget }, (_, at) => REMOTE_MONITOR_CONFLICT_WAITS_MS[Math.min(at, REMOTE_MONITOR_CONFLICT_WAITS_MS.length - 1)]);
    expect(sum(waits)).toBe(7_750);
    await vi.advanceTimersByTimeAsync(sum(waits) - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await ensured).toBe('failed');
    // A look after each wait of the budget.
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', ...waits.map(() => 'inspect'), 'inspect', 'ps']);
    expect(removals(docker)).toEqual([]);
  });

  // A status that changes from `created` to `removing` late in the budget still gets a wait: the counter is not tested
  // against the shorter list of `removing`.
  it('a conflict with a container that is created for six looks, then removing, then gone → a second create, nothing removed', async () => {
    vi.useFakeTimers();
    const created = inspected('created', LABEL);
    const next = inspects(MISSING, created, created, created, created, created, created, inspected('removing', LABEL), MISSING);
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : undefined), (call, index) => (index === 0 ? CONFLICTED(call, index) : STARTS(call, index)));
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(sum(REMOTE_MONITOR_CREATED_WAITS_MS));
    expect(await ensured).toBe('created');
    expect(docker.commands().filter((command) => command === 'run')).toHaveLength(2);
    expect(docker.commands()).not.toContain('rm');
    expect(docker.commands().filter((command) => command === 'inspect').length).toBeLessThanOrEqual(10);
  });

  it('one counter for both lists: a status that changes between created and removing ends after the longer list at most', async () => {
    vi.useFakeTimers();
    // removing, created, removing, created, …: never more looks than the longer list has waits, plus the first.
    let at = 0;
    const next = () => (at++ === 0 ? MISSING : at % 2 === 0 ? inspected('removing', LABEL) : inspected('created', LABEL));
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : undefined), CONFLICTED);
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(sum(REMOTE_MONITOR_CREATED_WAITS_MS));
    expect(await ensured).toBe('failed');
    const looks = docker.commands().filter((command) => command === 'inspect').length - 1;
    expect(looks).toBeLessThanOrEqual(Math.max(REMOTE_MONITOR_CREATED_WAITS_MS.length, REMOTE_MONITOR_CONFLICT_WAITS_MS.length) + 1);
    expect(removals(docker)).toEqual([]);
  });

  it('a created container after a conflict is never judged by its age, even when it is old (inspect only)', async () => {
    vi.useFakeTimers();
    const next = inspects(MISSING, createdIn(LABEL));
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : args[0] === 'info' ? systemTime(REMOTE_MONITOR_STALE_CREATED_MS * 10) : undefined), CONFLICTED);
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(sum(REMOTE_MONITOR_CREATED_WAITS_MS));
    expect(await ensured).toBe('failed');
    expect(docker.commands()).not.toContain('info');
    expect(removals(docker)).toEqual([]);
  });

  it('a cancellation during a long created wait of the conflict passes at once, nothing removed', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const next = inspects(MISSING, inspected('created', LABEL));
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : undefined), CONFLICTED);
    const ensured = monitor(docker).ensure(TAG, SOCKET, controller.signal);
    const rejected = expect(ensured).rejects.toMatchObject({ name: 'AbortError' });
    // Past the old 3.75 s: still waiting.
    await vi.advanceTimersByTimeAsync(sum(REMOTE_MONITOR_CONFLICT_WAITS_MS) + 1_000);
    const before = docker.commands();
    controller.abort();
    await rejected;
    expect(docker.commands()).toEqual(before);
    expect(removals(docker)).toEqual([]);
  });

  it('the restart of the created-wait for another ID happens once only: a third ID ends it (young → kept)', async () => {
    vi.useFakeTimers();
    const now = REMOTE_MONITOR_STALE_CREATED_MS * 10;
    const createdAtNow = new Date(CREATED_MS + now - 1_000).toISOString();
    const other = inspected('created', LABEL, 0, 0, OTHER_ID, createdAtNow);
    const third = inspected('created', LABEL, 0, 0, THIRD_ID, createdAtNow);
    const next = inspects(createdIn(LABEL), other, third);
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : args[0] === 'info' ? systemTime(now) : undefined));
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(2 * sum(REMOTE_MONITOR_CREATED_WAITS_MS));
    expect(await ensured).toBe('failed');
    expect(docker.commands()).toEqual(['inspect', 'inspect', 'inspect', 'info']);
    expect(removals(docker)).toEqual([]);
  });

  it('the whole created-wait stays bounded at 2 x 12.75 s even when the ID keeps changing', async () => {
    vi.useFakeTimers();
    let at = 0;
    const ids = [MONITOR_ID, OTHER_ID];
    // Old enough to be replaced only if the ID had been stable; it alternates, so the wait ends at the second change.
    const next = () => inspected('created', LABEL, 0, 0, ids[at++ % 2], CREATED_AT);
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : args[0] === 'info' ? systemTime(1_000) : undefined));
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(2 * sum(REMOTE_MONITOR_CREATED_WAITS_MS));
    expect(await ensured).toBe('failed');
    expect(docker.commands().filter((command) => command === 'inspect').length).toBeLessThanOrEqual(2 * REMOTE_MONITOR_CREATED_WAITS_MS.length + 1);
    expect(removals(docker)).toEqual([]);
  });

  it('a cancellation during the second created-wait passes at once, nothing removed', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const next = inspects(createdIn(LABEL), createdIn(LABEL, OTHER_ID));
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : undefined));
    const ensured = monitor(docker).ensure(TAG, SOCKET, controller.signal);
    const rejected = expect(ensured).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(sum(REMOTE_MONITOR_CREATED_WAITS_MS) - 1_000);
    const before = docker.commands();
    expect(before.length).toBeGreaterThan(2);
    // Each call's signal is linked to it.
    expectSignalsFollow(docker.calls, controller);
    await rejected;
    expect(docker.commands()).toEqual(before);
    expect(removals(docker)).toEqual([]);
  });

  it('a second ID that is old and stays created after its own wait is removed by that ID, never by the name', async () => {
    vi.useFakeTimers();
    const next = inspects(createdIn(LABEL), createdIn(LABEL, OTHER_ID));
    const docker = new FakeDocker((args) =>
      args[0] === 'inspect' ? next() : args[0] === 'info' ? systemTime(REMOTE_MONITOR_STALE_CREATED_MS + 1) : args[0] === 'ps' ? [CREATED_ID] : undefined,
    );
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(2 * sum(REMOTE_MONITOR_CREATED_WAITS_MS));
    expect(await ensured).toBe('created');
    expect(docker.calls.filter((call) => call.args[0] === 'rm').map((call) => call.args)).toEqual([['rm', OTHER_ID]]);
  });
});

// A restarted monitor whose stored-script check fails (no answer in time, a transport error) is inspected again
// before it is kept, so that one that exits 3 again and again is not kept until the next open. A check that gives
// `unknown` is followed by an inspect by the same ID: restarting, exited with 3, or a grown RestartCount is definite
// evidence (replaced by its ID); anything else → kept, without a second read.
describe('RemoteSessionMonitor.ensure: remote monitor restart check', () => {
  const NAME = 'remote monitor restart check';
  const SHA = ['archive', 'devspaces-monitor', REMOTE_MONITOR_SCRIPT_PATH];
  /** A check that fails without an answer that counts as evidence (a transport error of the read). */
  const FAILED = new EngineError('error during connect: read: connection reset by peer', 0);
  const OTHER_ID = 'beef'.padEnd(64, '2');
  const KEPT_LOG = 'info The Monitor on the Docker host was restarted and its stored script could not be checked; it is kept (devspaces-monitor).';
  const REPLACED_LOG = 'info The Monitor on the Docker host was restarted without its script; it is replaced (devspaces-monitor).';
  /**
   * The answers of inspect and of the checks in order (the last one repeats); any other call succeeds. An Error is the
   * failure of the call; a function is called for its answer.
   */
  const sequenced = (inspects: readonly unknown[], checks: ReadonlyArray<ArchiveAnswer | Error>) => {
    let inspectIndex = 0;
    let checkIndex = 0;
    const answerOf = (answer: unknown) => (typeof answer === 'function' ? (answer as () => unknown)() : answer instanceof Error ? Promise.reject(answer) : answer);
    return new FakeDocker((args) => {
      if (args[0] === 'inspect') return answerOf(inspects[Math.min(inspectIndex++, inspects.length - 1)]);
      if (args[0] === 'archive') return answerOf(checks[Math.min(checkIndex++, checks.length - 1)]);
      return undefined;
    });
  };
  const RESTARTED = inspected(true, LABEL, 3, 1);

  for (const [what, again] of [
    ['found restarting', inspected('restarting', LABEL, 3, 1)],
    ['exited with 3', inspected(false, LABEL, 3, 1)],
    ['running with a grown RestartCount', inspected(true, LABEL, 3, 2)],
  ] as const) {
    it(`${NAME}: unknown, then ${what} → replaced by its ID`, async () => {
      const logger = new Log();
      const docker = sequenced([RESTARTED, again, MISSING], [FAILED]);
      expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('created');
      expect(docker.commands()).toEqual(['inspect', 'archive', 'inspect', 'rm', 'run']);
      expect(docker.calls[1].args).toEqual(SHA);
      expect(docker.calls[2].args.at(-1)).toBe('devspaces-monitor');
      expect(docker.calls[3].args).toEqual(['rm', MONITOR_ID]);
      expect(logger.lines).toContain(REPLACED_LOG);
      expect(logger.lines).not.toContain(KEPT_LOG);
    });
  }

  // The read works in every state of the container, so a failed one is not tried again.
  it(`${NAME}: unknown, still running with the same RestartCount → kept, logged, without a second read`, async () => {
    const logger = new Log();
    const docker = sequenced([RESTARTED, RESTARTED], [FAILED, NO_SCRIPT]);
    expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('running');
    expect(docker.commands()).toEqual(['inspect', 'archive', 'inspect']);
    expect(logger.lines).toEqual([KEPT_LOG]);
  });

  // The failures of the inspect of the port.
  for (const [what, again] of [
    ['a failed second inspect', new EngineError('error during connect: read: connection reset by peer', 500)],
    ['a second inspect without an answer in time', new Error('no answer in time')],
    ['a second inspect that throws', new Error('connect ENOENT /var/run/docker.sock')],
    ['a container that is gone at the second inspect', MISSING],
  ] as const) {
    it(`${NAME}: unknown, then ${what} → kept, nothing removed`, async () => {
      const logger = new Log();
      const docker = sequenced([RESTARTED, again], [FAILED]);
      expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('running');
      expect(docker.commands()).toEqual(['inspect', 'archive', 'inspect']);
      expect(logger.lines).toEqual([KEPT_LOG]);
    });
  }

  for (const [what, again] of [
    ['restarting', inspected('restarting', LABEL, 3, 1, OTHER_ID)],
    ['exited with 3', inspected(false, LABEL, 3, 1, OTHER_ID)],
    ['running with a grown RestartCount', inspected(true, LABEL, 3, 5, OTHER_ID)],
    ['running', inspected(true, LABEL, 0, 1, OTHER_ID)],
  ] as const) {
    it(`${NAME}: unknown, then an ID that changed (${what}) → kept, nothing removed`, async () => {
      const logger = new Log();
      const docker = sequenced([RESTARTED, again], [FAILED, SAME]);
      expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('running');
      expect(docker.commands()).toEqual(['inspect', 'archive', 'inspect']);
      expect(docker.calls.some((call) => call.args[0] === 'rm')).toBe(false);
      expect(logger.lines).toEqual([KEPT_LOG]);
    });
  }

  it(`${NAME}: unknown, then an ID that cannot be read → kept, nothing removed`, async () => {
    const docker = sequenced([RESTARTED, inspected('restarting', LABEL, 3, 2, 'not-an-id')], [FAILED]);
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('running');
    expect(docker.commands()).toEqual(['inspect', 'archive', 'inspect']);
  });

  it(`${NAME}: unknown, then paused → kept without another check`, async () => {
    const docker = sequenced([RESTARTED, inspected('paused', LABEL, 3, 1)], [FAILED]);
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('running');
    expect(docker.commands()).toEqual(['inspect', 'archive', 'inspect']);
  });

  it(`${NAME}: a cancellation during the second inspect passes, nothing removed`, async () => {
    // The cancel of the signal of ensure (see "passes a cancellation on").
    const controller = new AbortController();
    const cancel = () => {
      controller.abort();
      return Promise.reject(abortError());
    };
    const docker = sequenced([RESTARTED, cancel], [FAILED]);
    await expect(monitor(docker).ensure(TAG, SOCKET, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(docker.commands()).toEqual(['inspect', 'archive', 'inspect']);
  });

  it(`${NAME}: the check and the second inspect get the signal of ensure`, async () => {
    const controller = new AbortController();
    const docker = sequenced([RESTARTED, RESTARTED], [FAILED]);
    expect(await monitor(docker).ensure(TAG, SOCKET, controller.signal)).toBe('running');
    // The signals of the check and of the inspect are linked to it.
    expectSignalsFollow([docker.calls[1], docker.calls[2]], controller);
  });

  // The start path (an exited container of this version) shares the check.
  const STOPPED = inspected(false, LABEL, 137, 0);
  for (const [what, again] of [
    ['found restarting', inspected('restarting', LABEL, 3, 1)],
    ['exited with 3', inspected(false, LABEL, 3, 0)],
    ['running with a grown RestartCount', inspected(true, LABEL, 0, 1)],
  ] as const) {
    it(`${NAME}: started, unknown, then ${what} → replaced by its ID`, async () => {
      const logger = new Log();
      const docker = sequenced([STOPPED, again, MISSING], [FAILED]);
      expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('created');
      expect(docker.commands()).toEqual(['inspect', 'start', 'archive', 'inspect', 'rm', 'run']);
      expect(docker.calls[1].args).toEqual(['start', MONITOR_ID]);
      expect(docker.calls[4].args).toEqual(['rm', MONITOR_ID]);
      expect(logger.lines).toContain('info The Monitor on the Docker host was started again without its script; it is replaced (devspaces-monitor).');
    });
  }

  it(`${NAME}: started after earlier restarts (docker start resets RestartCount), unknown, then running with RestartCount 1 → replaced`, async () => {
    const docker = sequenced([inspected(false, LABEL, 137, 4), inspected(true, LABEL, 0, 1), MISSING], [FAILED, FAILED]);
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('created');
    expect(docker.commands()).toEqual(['inspect', 'start', 'archive', 'inspect', 'rm', 'run']);
    expect(docker.calls[4].args).toEqual(['rm', MONITOR_ID]);
  });

  it(`${NAME}: started, unknown, still running → kept (started, logged), without a second read`, async () => {
    const logger = new Log();
    const docker = sequenced([STOPPED, inspected(true, LABEL, 0, 0)], [FAILED]);
    expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('started');
    expect(docker.commands()).toEqual(['inspect', 'start', 'archive', 'inspect']);
    expect(logger.lines).toEqual([
      'info The Monitor on the Docker host was started again and its stored script could not be checked; it is kept (devspaces-monitor).',
    ]);
  });

  it(`${NAME}: started, unknown, then a failed second inspect → kept (started), nothing removed`, async () => {
    const docker = sequenced([STOPPED, new EngineError('error during connect: EOF', 500)], [FAILED]);
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('started');
    expect(docker.commands()).toEqual(['inspect', 'start', 'archive', 'inspect']);
  });

  it(`${NAME}: started, unknown, then an ID that changed (restarting) → kept (started), nothing removed`, async () => {
    const docker = sequenced([STOPPED, inspected('restarting', LABEL, 3, 4, OTHER_ID)], [FAILED]);
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('started');
    expect(docker.commands()).toEqual(['inspect', 'start', 'archive', 'inspect']);
    expect(docker.calls.some((call) => call.args[0] === 'rm')).toBe(false);
  });
});

describe('the image ID of a monitor tag', () => {
  it('the spec carries the image ID only when it is given, and the ensure passes it to the create', async () => {
    const plain = monitor(new FakeDocker(() => undefined));
    expect(plain.runSpec(TAG, SOCKET, LABEL, SCRIPT)).not.toHaveProperty('imageId');
    const id = `sha256:${'b'.repeat(64)}`;
    expect(plain.runSpec('devspaces-monitor:0123456789ab', SOCKET, LABEL, SCRIPT, undefined, 'nonce', id)).toMatchObject({ image: 'devspaces-monitor:0123456789ab', imageId: id });
    const specs: MonitorRunSpec[] = [];
    const engine: MonitorEngine = {
      inspect: async () => ({ exists: false }),
      daemonTime: async () => Date.now(),
      remove: async () => {},
      start: async () => {},
      storedScript: async () => 'none',
      idsWithLabel: async () => [],
      create: async (spec) => {
        specs.push(spec);
        return { kind: 'ready' };
      },
    };
    const ensuring = new RemoteSessionMonitor({ engine, logger: new Log(), script: async () => SCRIPT });
    expect(await ensuring.ensureOrThrow(TAG, SOCKET, undefined, 'devspaces-monitor:0123456789ab', id)).toBe('created');
    expect(specs[0]).toMatchObject({ image: 'devspaces-monitor:0123456789ab', imageId: id });
    expect(specs[0].labels[LABEL_MONITOR]).toBe(remoteMonitorLabelValue(SCRIPT, TAG));
    expect(await new RemoteSessionMonitor({ engine, logger: new Log(), script: async () => SCRIPT }).ensure(TAG, SOCKET, undefined, 'devspaces-monitor:0123456789ab', id)).toBe('created');
    expect(specs[1]).toMatchObject({ imageId: id });
  });
});
