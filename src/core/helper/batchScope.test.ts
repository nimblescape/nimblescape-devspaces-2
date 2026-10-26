// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The batch scope of an open (batchScope.ts) and the routing of WorkspaceHelper into it. Checked: within the scope
// every volume step goes to the one session of the held lock (with the inputs of its builder) and never to a `docker
// run`; the token goes only in the `secret` field; a session that cannot be opened, a lock without `batch`, a run
// without a batch kind and a step for another volume refuse and run nothing; a session that ended between two steps is
// replaced once under the same lock, a failed reopen refuses; a step that fails because its session was lost fails the
// operation and is never repeated; the session is closed on success, failure and cancel. Outside a scope a volume step
// throws an internal error and runs nothing (there is no per-step run).
import { describe, expect, it } from 'vitest';
import { composeProjectName, devspaceIdLabel, resourceName } from '../names';
import { configOwnershipFixCommand } from '../git/gitSummary';
import type { HeldDevspaceLock } from '../docker/devspaceLock';
import { UserFacingError, isBatchHelperUnavailable } from '../errors';
import { HelperChannelError, type BatchStepOptions, type HelperBatchSession } from '../helperChannel/helperChannel';
import { Messages } from '../messages';
import { abortError, silentLogger, type RunResult } from '../ports';
import type { BatchStepKind } from './batchStepKinds';
import { BAKE_FS_ENTITLEMENTS_OFF, batchStepCommand } from './batchSteps';
import { COMPOSE_MODEL_PATH } from './compose';
import { CONTAINER_CREDENTIAL_HELPER } from './containerGit';
import { buildArgs, readConfigurationArgs, runUserCommandsArgs, upArgs } from './devcontainerCli';
import {
  OVERRIDE_CONFIG_PATH,
  cloneCommand,
  composeHashCommand,
  composeModelCommand,
  createFoldersCommand,
  gitFilesCommand,
  listConfigsCommand,
  readFilesCommand,
  writeAndRunCommand,
} from './scripts';
import { overrideCommand, overrideInput, writeAndRunInput } from './stepInputs';
import { currentBatchScope, runWithBatchScope } from './batchScope';
import type { HelperImageUse } from './helperImage';
import { WorkspaceHelper } from './workspaceHelper';

// The names of a devspace are resourceName.
const NAME_ID = '3f2a9c1e-0000-4000-8000-000000000000';
const PROJECT = composeProjectName('acme/app', NAME_ID);

const TOKEN = 'gho_0123456789abcdefSECRET';
const VOLUME = resourceName('acme/app', NAME_ID);
const DEVSPACE_ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const IMAGE: HelperImageUse = { tag: 'devspaces-worker:abc', id: `sha256:${'a'.repeat(64)}` };

interface StepCall {
  session: string;
  kind: BatchStepKind;
  params: unknown;
  options: BatchStepOptions;
}

/** A batch session of the fake lock: records its steps; `end` ends it as lost. */
class FakeSession implements HelperBatchSession {
  readonly lost: Promise<string>;
  closed = 0;
  end!: (reason: string) => void;
  constructor(
    readonly session: string,
    private readonly world: FakeLock,
  ) {
    this.lost = new Promise((resolve) => (this.end = resolve));
  }
  async step(kind: BatchStepKind, params: unknown, options: BatchStepOptions = {}): Promise<RunResult> {
    this.world.steps.push({ session: this.session, kind, params, options });
    // As HelperChannel, a closed session runs no step.
    if (this.closed > 0) throw new HelperChannelError('closed', 'The batch helper is closed.');
    return this.world.stepResult(kind, this);
  }
  async close(): Promise<void> {
    this.closed++;
    // A real close is a round trip to the worker; `closeGate` holds it.
    this.world.onClose?.(this);
    await this.world.closeGate;
    this.world.events.push(`close ${this.session}`);
  }
}

/** A held lock whose `batch` opens FakeSessions (or fails with `openError`). */
class FakeLock implements HeldDevspaceLock {
  readonly devspaceId = DEVSPACE_ID;
  /** `lose` resolves `lost`, as the lock does when it was lost. */
  lose!: (reason: string) => void;
  readonly lost = new Promise<string>((resolve) => (this.lose = resolve));
  readonly sessions: FakeSession[] = [];
  readonly opens: Array<{ volume: string; image: string; socket: string }> = [];
  /** The signal of each open. */
  readonly openSignals: Array<AbortSignal | undefined> = [];
  /** Runs when a close starts; the close settles after `closeGate`. */
  onClose: ((session: FakeSession) => void) | undefined;
  closeGate: Promise<void> | undefined;
  readonly steps: StepCall[] = [];
  readonly events: string[] = [];
  openError: Error | undefined;
  stepResult: (kind: BatchStepKind, session: FakeSession) => Promise<RunResult> = async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
  async release(): Promise<void> {}
  batch = async (p: { volume: string; image: string; socket: string }, signal?: AbortSignal): Promise<HelperBatchSession> => {
    this.opens.push(p);
    this.openSignals.push(signal);
    if (this.openError) throw this.openError;
    const session = new FakeSession(`s${this.sessions.length + 1}`, this);
    this.sessions.push(session);
    this.events.push(`open ${session.session}`);
    return session;
  };
}

/**
 * WorkspaceHelper has no Docker port. The one call that it makes outside the session, whether a container runs
 * (HelperDeps.containerRuns), is recorded in `runs`, so a step that reached the engine outside its session fails these
 * tests.
 */
class RecordingDocker {
  readonly runs: Array<{ containerId: string }> = [];
  readonly containerRuns = async (containerId: string): Promise<boolean> => {
    this.runs.push({ containerId });
    return true;
  };
}

/** The own image of the worker and its socket. */
function setup(socket = '/var/run/docker.sock') {
  const docker = new RecordingDocker();
  const helper = new WorkspaceHelper({ logger: silentLogger, ownImage: IMAGE, socket, containerRuns: docker.containerRuns });
  const lock = new FakeLock();
  return { docker, helper, lock };
}

/**
 * The variables that WorkspaceHelper gives each of its steps (the arguments of its runInBatch), as the reference of the
 * equivalence tests below. WorkspaceHelper builds neither the command nor the input: the batch helper builds them from
 * the kind and the inputs of the step.
 */
function recordBuilt(helper: WorkspaceHelper): Array<{ env: Record<string, string> }> {
  type RunInBatch = (scope: unknown, volume: string, options: { env?: Record<string, string> }) => Promise<RunResult>;
  const internal = helper as unknown as { runInBatch: RunInBatch };
  const inner = internal.runInBatch.bind(helper);
  const built: Array<{ env: Record<string, string> }> = [];
  internal.runInBatch = (scope, volume, options) => {
    built.push({ env: options.env ?? {} });
    return inner(scope, volume, options);
  };
  return built;
}

async function refusal(promise: Promise<unknown>): Promise<UserFacingError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UserFacingError) return error;
    throw error;
  }
  throw new Error('The promise did not reject.');
}

describe('the batch scope of an open', () => {
  it('runs every volume step in the one session of the held lock, never as a docker run, with the inputs of its builder', async () => {
    const { docker, helper, lock } = setup();
    lock.stepResult = async (kind) => ({
      exitCode: 0,
      stdout:
        kind === 'listConfigs'
          ? '[".devcontainer/devcontainer.json"]\n'
          : kind === 'readFiles'
            ? '{"configText":"{}"}\n'
            : kind === 'readConfiguration'
              ? '{"configuration":{"image":"x"}}\n'
              : kind === 'up' || kind === 'build' || kind === 'runUserCommands'
                ? '{"outcome":"success","containerId":"0123456789ab"}\n'
                : kind === 'composeModel'
                  ? '{"error":"none"}\n'
                  : '',
      stderr: '',
      timedOut: false,
    });
    const folder = '/workspaces/app';
    await runWithBatchScope(lock, VOLUME, silentLogger, async () => {
      await helper.clone({ volumeName: VOLUME, repository: 'acme/app', branch: 'main', token: TOKEN, image: IMAGE });
      await helper.readConfigFiles({ volumeName: VOLUME, repository: 'acme/app', configPath: '.devcontainer/devcontainer.json', image: IMAGE });
      await helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE });
      await helper.readConfiguration({ volumeName: VOLUME, repository: 'acme/app', configPath: '.devcontainer/devcontainer.json', devspaceId: DEVSPACE_ID, merged: false, env: { COMPOSE_PROJECT_NAME: 'p', DOCKER_HOST: 'tcp://x' }, image: IMAGE });
      await helper.build({ volumeName: VOLUME, repository: 'acme/app', configPath: '.devcontainer/devcontainer.json', imageName: `${PROJECT}:1`, image: IMAGE });
      await helper.composeModel({ volumeName: VOLUME, repository: 'acme/app', files: [`${folder}/compose.yml`], project: 'p', image: IMAGE });
      await helper.composeServiceHashes({ volumeName: VOLUME, repository: 'acme/app', model: '{}', project: 'p', image: IMAGE });
      await helper.createRepositoryFolders({ volumeName: VOLUME, repository: 'acme/app', folders: [`${folder}/data`], image: IMAGE });
      await helper.up({ volumeName: VOLUME, repository: 'acme/app', override: {}, devspaceId: DEVSPACE_ID, removeExistingContainer: false, token: TOKEN, image: IMAGE });
      await helper.runUserCommands({ volumeName: VOLUME, repository: 'acme/app', override: {}, devspaceId: DEVSPACE_ID, containerId: '0123456789ab', token: TOKEN, image: IMAGE });
      await helper.prepareGit({ volumeName: VOLUME, repository: 'acme/app', identity: { name: 'Octo', email: 'octo@example.com' }, image: IMAGE });
      await helper.fixConfigOwnership({ volumeName: VOLUME, folder: '/workspaces/.devspace+', uid: '1000', gid: '1000', timeoutMs: 5000, image: IMAGE });
    });
    expect(docker.runs).toEqual([]);
    expect(lock.opens).toEqual([{ volume: VOLUME, image: IMAGE.id, socket: '/var/run/docker.sock' }]);
    expect(lock.steps.map((step) => `${step.session} ${step.kind}`)).toEqual([
      's1 clone',
      's1 readFiles',
      's1 listConfigs',
      's1 readConfiguration',
      's1 build',
      's1 composeModel',
      's1 composeHash',
      's1 createFolders',
      's1 up',
      's1 runUserCommands',
      's1 gitFiles',
      's1 ownershipFix',
    ]);
    const byKind = Object.fromEntries(lock.steps.map((step) => [step.kind, step]));
    // The token: only in the `secret` field (the clone's standard input in the helper; `up` and run-user-commands mask it).
    expect(byKind.clone).toMatchObject({ params: { repository: 'acme/app', branch: 'main' }, options: { secrets: { token: TOKEN } } });
    for (const step of lock.steps) expect(JSON.stringify(step.params)).not.toContain(TOKEN);
    expect(lock.steps.filter((step) => step.options.secrets?.token !== undefined).map((step) => step.kind)).toEqual(['clone', 'up', 'runUserCommands']);
    // The variables pass the checks of `-e` (DOCKER_HOST never), and only to the kinds that take them.
    expect(byKind.readConfiguration.params).toEqual({ repository: 'acme/app', configPath: '.devcontainer/devcontainer.json', devspaceId: DEVSPACE_ID, merged: false, env: { COMPOSE_PROJECT_NAME: 'p' } });
    expect(byKind.composeModel.params).toEqual({ repository: 'acme/app', files: [`${folder}/compose.yml`], project: 'p' });
    // Compose reads as the repository owner, so composeHash names its repository.
    expect(byKind.composeHash.params).toEqual({ repository: 'acme/app', model: '{}', project: 'p' });
    expect(byKind.ownershipFix).toMatchObject({ params: { folder: '/workspaces/.devspace+', uid: '1000', gid: '1000' }, options: { timeoutMs: 5000 } });
    // Closed at the end of the scope.
    expect(lock.events).toEqual(['open s1', 'close s1']);
    expect(currentBatchScope()).toBeUndefined();
  });

  it('outside the scope a volume step throws an internal error and runs nothing', async () => {
    // Outside a scope there is no `docker run` of its own.
    const { docker, helper } = setup();
    await expect(helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE })).rejects.toThrow(/^Internal error: .* ran outside the batch helper of an operation; it was not run\.$/);
    expect(docker.runs).toEqual([]);
  });

  it('a session that cannot be opened refuses the operation with the cause; nothing runs, also not the next step', async () => {
    const { docker, helper, lock } = setup();
    lock.openError = new HelperChannelError('unsendable', 'too many batch helpers');
    await runWithBatchScope(lock, VOLUME, silentLogger, async () => {
      const error = await refusal(helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE }));
      expect(error.code).toBe('helperFailed');
      expect(error.message).toBe(Messages.batchHelperUnavailable(`The batch helper on the volume ${VOLUME} could not be opened: too many batch helpers`));
      // The refusal is marked, so the open never takes it for the helperFailed of a helper image, under whose rule a
      // running, current container opens as it is.
      expect(isBatchHelperUnavailable(error)).toBe(true);
      expect(isBatchHelperUnavailable(new UserFacingError('helperFailed', Messages.helperFailed))).toBe(false);
      lock.openError = undefined;
      // The scope refused: a caller that catches the error cannot go on with another step.
      await expect(helper.readConfigFiles({ volumeName: VOLUME, repository: 'acme/app', configPath: 'a.json', image: IMAGE })).rejects.toBe(error);
    });
    expect(lock.opens).toHaveLength(1);
    expect(docker.runs).toEqual([]);
  });

  it('a lock without batch, a step for another volume, and an image without an ID refuse', async () => {
    const cases: Array<[string, (helper: WorkspaceHelper) => Promise<unknown>, (lock: FakeLock) => HeldDevspaceLock, string]> = [
      ['no batch', (helper) => helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE }), (lock) => ({ ...lock, devspaceId: lock.devspaceId, lost: lock.lost, release: lock.release, batch: undefined }), 'has no batch helper'],
      // Every run of WorkspaceHelper names its batch kind, so there is no case of a run without one.
      ['volume', (helper) => helper.listConfigurations({ volumeName: 'other', repository: 'acme/app', image: IMAGE }), (lock) => lock, 'is for the volume other'],
      ['no image ID', (helper) => helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: { tag: IMAGE.tag } }), (lock) => lock, 'the ID of the helper image'],
    ];
    for (const [name, run, held, cause] of cases) {
      const { docker, helper, lock } = setup();
      await runWithBatchScope(held(lock), VOLUME, silentLogger, async () => {
        const error = await refusal(run(helper));
        expect(error.code, name).toBe('helperFailed');
        expect(error.detail, name).toContain(cause);
      });
      expect(docker.runs, name).toEqual([]);
      expect(lock.steps, name).toEqual([]);
    }
  });

  it('a session that ended between two steps (its idle end) is replaced once under the same lock; the step is not repeated', async () => {
    const { docker, helper, lock } = setup();
    lock.stepResult = async () => ({ exitCode: 0, stdout: '["a"]\n', stderr: '', timedOut: false });
    await runWithBatchScope(lock, VOLUME, silentLogger, async () => {
      await helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE });
      lock.sessions[0].end('the helper ended after 15 minutes without a step');
      await Promise.resolve();
      await helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE });
      await helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE });
    });
    expect(lock.steps.map((step) => step.session)).toEqual(['s1', 's2', 's2']);
    expect(lock.events).toEqual(['open s1', 'open s2', 'close s2']);
    expect(docker.runs).toEqual([]);
  });

  it('a failed reopen refuses the operation', async () => {
    const { docker, helper, lock } = setup();
    lock.stepResult = async () => ({ exitCode: 0, stdout: '["a"]\n', stderr: '', timedOut: false });
    await runWithBatchScope(lock, VOLUME, silentLogger, async () => {
      await helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE });
      lock.sessions[0].end('lost');
      await Promise.resolve();
      lock.openError = new HelperChannelError('lost', 'the worker was lost');
      const error = await refusal(helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE }));
      expect(error.detail).toBe(`The batch helper on the volume ${VOLUME} could not be opened again: the worker was lost`);
    });
    expect(lock.opens).toHaveLength(2);
    expect(lock.steps).toHaveLength(1);
    expect(docker.runs).toEqual([]);
  });

  it('a step that fails because its session was lost fails the operation; it is never repeated, and no later step runs', async () => {
    const { docker, helper, lock } = setup();
    lock.stepResult = async (_kind, session) => {
      session.end('the helper was lost');
      throw new HelperChannelError('lost', 'The helper channel was lost.');
    };
    await runWithBatchScope(lock, VOLUME, silentLogger, async () => {
      const error = await refusal(helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE }));
      expect(error.code).toBe('helperFailed');
      expect(error.detail).toBe('The step listConfigs failed in the batch helper s1: The helper channel was lost.');
      await expect(helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE })).rejects.toBe(error);
    });
    expect(lock.opens).toHaveLength(1);
    expect(lock.steps).toHaveLength(1);
    expect(docker.runs).toEqual([]);
  });

  it('closes the session on success, on a failure, and on a cancel', async () => {
    for (const outcome of ['success', 'failure', 'cancel'] as const) {
      const { helper, lock } = setup();
      const controller = new AbortController();
      lock.stepResult = async (kind) => {
        if (outcome === 'cancel' && kind === 'readFiles') {
          controller.abort();
          throw abortError();
        }
        return { exitCode: outcome === 'failure' && kind === 'readFiles' ? 1 : 0, stdout: kind === 'readFiles' ? '{"configText":"{}"}\n' : '["a"]\n', stderr: 'boom', timedOut: false };
      };
      const run = runWithBatchScope(lock, VOLUME, silentLogger, async () => {
        await helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE, signal: controller.signal });
        await helper.readConfigFiles({ volumeName: VOLUME, repository: 'acme/app', configPath: 'a.json', image: IMAGE, signal: controller.signal });
      });
      if (outcome === 'success') await expect(run).resolves.toBeUndefined();
      else if (outcome === 'failure') await expect(run).rejects.toMatchObject({ name: 'CommandError' });
      else await expect(run).rejects.toMatchObject({ name: 'AbortError' });
      expect(lock.events, outcome).toEqual(['open s1', 'close s1']);
    }
  });

  it('the time limit of a step is an Error that is no AbortError, and the session stays', async () => {
    const { helper, lock } = setup();
    lock.stepResult = async (kind) => ({ exitCode: kind === 'composeModel' ? null : 0, stdout: '', stderr: '', timedOut: kind === 'composeModel' });
    await runWithBatchScope(lock, VOLUME, silentLogger, async () => {
      await expect(helper.composeModel({ volumeName: VOLUME, repository: 'acme/app', files: ['/workspaces/app/c.yml'], project: 'p', timeoutMs: 2000, image: IMAGE })).rejects.toThrow(
        'The step composeModel of the batch helper did not end within 2 seconds.',
      );
      await helper.createRepositoryFolders({ volumeName: VOLUME, repository: 'acme/app', folders: ['/workspaces/app/d'], image: IMAGE });
    });
    expect(lock.steps.map((step) => `${step.session} ${step.kind}`)).toEqual(['s1 composeModel', 's1 createFolders']);
    expect(lock.steps[0].options.timeoutMs).toBe(2000);
  });

  it('closeSession ends the session before the volume is removed; a later step opens a new one', async () => {
    const { helper, lock } = setup();
    lock.stepResult = async () => ({ exitCode: 0, stdout: '["a"]\n', stderr: '', timedOut: false });
    await runWithBatchScope(lock, VOLUME, silentLogger, async () => {
      await helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE });
      await currentBatchScope()!.closeSession();
      lock.events.push('volume rm');
      await helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE });
    });
    expect(lock.events).toEqual(['open s1', 'close s1', 'volume rm', 'open s2', 'close s2']);
  });

  // The lock lost while a step runs closes the session, which ends that step; the step fails the operation, and no
  // later step runs.
  it('closes the session when the lock is lost, so the running step ends and the scope refuses', async () => {
    const { docker, helper, lock } = setup();
    let loseLock!: (reason: string) => void;
    Object.assign(lock, { lost: new Promise<string>((resolve) => (loseLock = resolve)) });
    let closedDuringStep = false;
    lock.stepResult = async (_kind, session) => {
      loseLock('its hold limit was reached');
      for (let i = 0; i < 100 && session.closed === 0; i++) await new Promise((resolve) => setTimeout(resolve, 1));
      closedDuringStep = session.closed > 0;
      throw new HelperChannelError('lost', 'The batch helper was closed.');
    };
    await runWithBatchScope(lock, VOLUME, silentLogger, async () => {
      const error = await refusal(helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE }));
      expect(error.code).toBe('helperFailed');
      await expect(helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE })).rejects.toBe(error);
    });
    expect(closedDuringStep).toBe(true);
    expect(lock.opens).toHaveLength(1);
    expect(lock.steps).toHaveLength(1);
    expect(docker.runs).toEqual([]);
  });

  // A step queued while end() closes the session is refused; it never opens a new session that nothing would close.
  it('refuses a step that is queued while the scope ends, and opens no new session', async () => {
    const { helper, lock } = setup();
    lock.stepResult = async () => ({ exitCode: 0, stdout: '["a"]\n', stderr: '', timedOut: false });
    let scope!: NonNullable<ReturnType<typeof currentBatchScope>>;
    let closeStarted!: () => void;
    const closing = new Promise<void>((resolve) => (closeStarted = resolve));
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => (openGate = resolve));
    const run = runWithBatchScope(lock, VOLUME, silentLogger, async () => {
      scope = currentBatchScope()!;
      await helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE });
      const session = lock.sessions[0];
      const close = session.close.bind(session);
      session.close = async () => {
        closeStarted();
        await gate;
        return close();
      };
    });
    await closing;
    const late = scope.step({ volume: VOLUME, kind: 'listConfigs', params: { repository: 'acme/app' }, options: {} }, async () => ({ image: IMAGE.id!, socket: '/var/run/docker.sock' }));
    openGate();
    await run;
    const error = await refusal(late);
    expect(error.code).toBe('helperFailed');
    expect(lock.opens).toHaveLength(1);
    expect(lock.events).toEqual(['open s1', 'close s1']);
  });

  it('runs the steps of the scope one at a time', async () => {
    const { helper, lock } = setup();
    let running = 0;
    let most = 0;
    lock.stepResult = async () => {
      running++;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return { exitCode: 0, stdout: '["a"]\n', stderr: '', timedOut: false };
    };
    await runWithBatchScope(lock, VOLUME, silentLogger, async () => {
      await Promise.all([1, 2, 3].map(() => helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE })));
    });
    expect(most).toBe(1);
    expect(lock.opens).toHaveLength(1);
  });

  // Mutation testing: the lock, the close and the cancel of the scope.

  /** A promise and its resolve (no timers). */
  function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }

  /** One turn of the event loop: every pending microtask has run (no timer). */
  const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  it('after the lock was lost between two steps, no later step runs, also while the session still answers', async () => {
    const { docker, helper, lock } = setup();
    lock.stepResult = async () => ({ exitCode: 0, stdout: '["a"]\n', stderr: '', timedOut: false });
    await runWithBatchScope(lock, VOLUME, silentLogger, async () => {
      await helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE });
      lock.lose('its hold limit was reached');
      // After the handler of the scope (registered first).
      await lock.lost;
      const error = await refusal(helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE }));
      expect(error.code).toBe('helperFailed');
      expect(error.detail).toBe('The lock of the devspace was lost (its hold limit was reached), so the step listConfigs is not run');
      await expect(helper.readConfigFiles({ volumeName: VOLUME, repository: 'acme/app', configPath: 'a.json', image: IMAGE })).rejects.toBe(error);
    });
    expect(lock.steps).toHaveLength(1);
    expect(lock.opens).toHaveLength(1);
    expect(lock.sessions[0].closed).toBeGreaterThan(0);
    expect(docker.runs).toEqual([]);
  });

  it('a lock lost while the session opens closes the new session and runs no step', async () => {
    const { docker, helper, lock } = setup();
    const open = lock.batch;
    lock.batch = async (p, signal) => {
      const session = await open(p, signal);
      // The lock ends before the open answers: its loss finds no session of the scope to close.
      lock.lose('the worker was lost');
      await lock.lost;
      await turn();
      return session;
    };
    await runWithBatchScope(lock, VOLUME, silentLogger, async () => {
      const error = await refusal(helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE }));
      expect(error.code).toBe('helperFailed');
      expect(error.detail).toBe('The lock of the devspace was lost (the worker was lost) while the batch helper opened, so the step listConfigs is not run');
    });
    expect(lock.steps).toEqual([]);
    expect(lock.sessions[0].closed).toBeGreaterThan(0);
    expect(docker.runs).toEqual([]);
  });

  it('runWithBatchScope settles only after the close of the session settled', async () => {
    const { helper, lock } = setup();
    lock.stepResult = async () => ({ exitCode: 0, stdout: '["a"]\n', stderr: '', timedOut: false });
    const closing = deferred();
    const gate = deferred();
    lock.onClose = () => closing.resolve();
    lock.closeGate = gate.promise;
    let settled = false;
    const run = runWithBatchScope(lock, VOLUME, silentLogger, () => helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE })).finally(() => {
      settled = true;
    });
    await closing.promise;
    await turn();
    expect(settled).toBe(false);
    expect(lock.events).toEqual(['open s1']);
    gate.resolve();
    await run;
    expect(lock.events).toEqual(['open s1', 'close s1']);
  });

  it('closeSession resolves only after the close settled, so the volume is removed after it', async () => {
    const { helper, lock } = setup();
    lock.stepResult = async () => ({ exitCode: 0, stdout: '["a"]\n', stderr: '', timedOut: false });
    const closing = deferred();
    const gate = deferred();
    await runWithBatchScope(lock, VOLUME, silentLogger, async () => {
      await helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE });
      lock.onClose = () => closing.resolve();
      lock.closeGate = gate.promise;
      const closed = currentBatchScope()!
        .closeSession()
        .then(() => lock.events.push('volume rm'));
      await closing.promise;
      await turn();
      expect(lock.events).toEqual(['open s1']);
      gate.resolve();
      await closed;
    });
    expect(lock.events).toEqual(['open s1', 'close s1', 'volume rm']);
  });

  it('the cancel of the caller reaches the open and every step of the session', async () => {
    const { helper, lock } = setup();
    lock.stepResult = async () => ({ exitCode: 0, stdout: '["a"]\n', stderr: '', timedOut: false });
    const controller = new AbortController();
    await runWithBatchScope(lock, VOLUME, silentLogger, async () => {
      await helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE, signal: controller.signal });
      await helper.build({ volumeName: VOLUME, repository: 'acme/app', configPath: '.devcontainer/devcontainer.json', imageName: `${PROJECT}:1`, image: IMAGE, signal: controller.signal }).catch(() => undefined);
    });
    expect(lock.openSignals).toEqual([controller.signal]);
    expect(lock.steps.map((step) => step.options.signal)).toEqual([controller.signal, controller.signal]);
  });

  it('a step with an aborted signal is cancelled before anything opens or runs; the scope goes on', async () => {
    const { docker, helper, lock } = setup();
    lock.stepResult = async () => ({ exitCode: 0, stdout: '["a"]\n', stderr: '', timedOut: false });
    const controller = new AbortController();
    controller.abort();
    await runWithBatchScope(lock, VOLUME, silentLogger, async () => {
      await expect(helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
      expect(lock.opens).toEqual([]);
      expect(lock.steps).toEqual([]);
      await helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE });
    });
    expect(lock.steps).toHaveLength(1);
    expect(docker.runs).toEqual([]);
  });

  it('a step or an open that fails with any error after the cancel is the cancel, never a refusal of the scope', async () => {
    for (const where of ['step', 'open'] as const) {
      const { helper, lock } = setup();
      const controller = new AbortController();
      const plain = new HelperChannelError('lost', 'The batch helper ended.');
      lock.stepResult = async () => {
        if (controller.signal.aborted) return { exitCode: 0, stdout: '["a"]\n', stderr: '', timedOut: false };
        controller.abort();
        throw plain;
      };
      if (where === 'open') {
        const open = lock.batch;
        lock.batch = async (p, signal) => {
          if (controller.signal.aborted) return open(p, signal);
          controller.abort();
          lock.opens.push(p);
          throw plain;
        };
      }
      await runWithBatchScope(lock, VOLUME, silentLogger, async () => {
        const failed = helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE, signal: controller.signal });
        await expect(failed, where).rejects.toBe(plain);
        // The scope did not refuse: the next step (of the next operation's caller) runs.
        await expect(helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE }), where).resolves.toEqual(['a']);
      });
      expect(lock.steps.map((step) => step.kind), where).toEqual(where === 'step' ? ['listConfigs', 'listConfigs'] : ['listConfigs']);
    }
  });

  it('every step of the scope makes in the helper the command, variables and input of its builders (batchStepCommand)', async () => {
    const E = DEVSPACE_ID;
    const env = { COMPOSE_PROJECT_NAME: 'p' };
    const override = { name: 'o' };
    // The reference of the command: the builders of each step on the inputs of the call (WorkspaceHelper builds no
    // command).
    const folder = '/workspaces/app';
    const configFile = `${folder}/.devcontainer/devcontainer.json`;
    // The reference of the input: the builders of stepInputs.ts on the inputs of the call (WorkspaceHelper gives the
    // step no input; it only checks the files).
    const calls: Array<[BatchStepKind, (helper: WorkspaceHelper) => Promise<unknown>, readonly string[], string?]> = [
      ['clone', (h) => h.clone({ volumeName: VOLUME, repository: 'acme/app', branch: 'dev', token: TOKEN, image: IMAGE }), cloneCommand('acme/app', 'app', 'dev')],
      [
        'readFiles',
        (h) => h.readConfigFiles({ volumeName: VOLUME, repository: 'acme/app', configPath: '.devcontainer/a/devcontainer.json', dockerfile: 'Dockerfile.dev', image: IMAGE }),
        readFilesCommand(folder, '.devcontainer/a/devcontainer.json', 'Dockerfile.dev'),
      ],
      ['listConfigs', (h) => h.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE }), listConfigsCommand(folder)],
      [
        'readConfiguration',
        (h) => h.readConfiguration({ volumeName: VOLUME, repository: 'acme/app', configPath: '.devcontainer/devcontainer.json', devspaceId: E, merged: true, override, files: { [COMPOSE_MODEL_PATH]: '{}' }, env, image: IMAGE }),
        writeAndRunCommand({}, readConfigurationArgs({ workspaceFolder: folder, configPath: configFile, idLabel: devspaceIdLabel(E), merged: true, overrideConfigPath: OVERRIDE_CONFIG_PATH })),
        writeAndRunInput({ [COMPOSE_MODEL_PATH]: '{}' }, override),
      ],
      [
        'build',
        (h) => h.build({ volumeName: VOLUME, repository: 'acme/app', configPath: '.devcontainer/devcontainer.json', imageName: `${PROJECT}:7`, env, image: IMAGE }),
        writeAndRunCommand({ repositoryConfig: configFile }, buildArgs({ workspaceFolder: folder, configPath: configFile, imageName: `${PROJECT}:7` })),
        writeAndRunInput(undefined, undefined),
      ],
      [
        'build',
        (h) => h.build({ volumeName: VOLUME, repository: 'acme/app', configPath: '.devcontainer/devcontainer.json', imageName: `${PROJECT}:7`, override, files: { [COMPOSE_MODEL_PATH]: '{}' }, env, image: IMAGE }),
        writeAndRunCommand({ repositoryConfig: configFile, config: OVERRIDE_CONFIG_PATH }, buildArgs({ workspaceFolder: folder, configPath: OVERRIDE_CONFIG_PATH, imageName: `${PROJECT}:7` })),
        writeAndRunInput({ [COMPOSE_MODEL_PATH]: '{}' }, override),
      ],
      [
        'composeModel',
        (h) => h.composeModel({ volumeName: VOLUME, repository: 'acme/app', files: ['/workspaces/app/compose.yml'], project: 'p', image: IMAGE }),
        composeModelCommand(folder, ['/workspaces/app/compose.yml']),
      ],
      ['composeHash', (h) => h.composeServiceHashes({ volumeName: VOLUME, repository: 'acme/app', model: '{"a":1}', project: 'p', image: IMAGE }), composeHashCommand(COMPOSE_MODEL_PATH, 'p'), '{"a":1}'],
      [
        'createFolders',
        (h) => h.createRepositoryFolders({ volumeName: VOLUME, repository: 'acme/app', folders: ['/workspaces/app/data'], image: IMAGE }),
        createFoldersCommand(folder, ['/workspaces/app/data']),
      ],
      [
        'up',
        (h) => h.up({ volumeName: VOLUME, repository: 'acme/app', override, devspaceId: E, removeExistingContainer: true, env, token: TOKEN, image: IMAGE }),
        overrideCommand(upArgs({ workspaceFolder: folder, overrideConfigPath: OVERRIDE_CONFIG_PATH, idLabel: devspaceIdLabel(E), removeExistingContainer: true }), undefined),
        overrideInput(undefined, override),
      ],
      [
        'runUserCommands',
        (h) => h.runUserCommands({ volumeName: VOLUME, repository: 'acme/app', override, devspaceId: E, containerId: 'abcdef012345', env, token: TOKEN, image: IMAGE }),
        overrideCommand(runUserCommandsArgs({ workspaceFolder: folder, overrideConfigPath: OVERRIDE_CONFIG_PATH, idLabel: devspaceIdLabel(E), containerId: 'abcdef012345' }), undefined),
        overrideInput(undefined, override),
      ],
      [
        'gitFiles',
        (h) => h.prepareGit({ volumeName: VOLUME, repository: 'acme/app', identity: { name: 'Octo', email: 'octo@example.com' }, image: IMAGE }),
        gitFilesCommand('app', { name: 'Octo', email: 'octo@example.com' }, CONTAINER_CREDENTIAL_HELPER),
      ],
      [
        'ownershipFix',
        (h) => h.fixConfigOwnership({ volumeName: VOLUME, folder: '/workspaces/.devspace+', uid: '1000', gid: '1001', timeoutMs: 5000, image: IMAGE }),
        configOwnershipFixCommand('/workspaces/.devspace+', '1000', '1001'),
      ],
    ];
    for (const [kind, call, expected, input] of calls) {
      // The reference: the variables that WorkspaceHelper gives the step (recordBuilt).
      const { helper, lock } = setup();
      const built = recordBuilt(helper);
      await runWithBatchScope(lock, VOLUME, silentLogger, () => call(helper).catch(() => undefined));
      // (readConfiguration reads once more when its first output has no configuration.)
      expect([...new Set(lock.steps.map((step) => step.kind))], kind).toEqual([kind]);
      const command = batchStepCommand(kind, lock.steps[0].params);
      expect(command.command, kind).toEqual(expected);
      // The helper adds BAKE_FS_ENTITLEMENTS_OFF to the variables of build and up (Buildx 0.37.2; the request never
      // carries it).
      expect(command.env, kind).toEqual(kind === 'build' || kind === 'up' ? { ...built[0].env, ...BAKE_FS_ENTITLEMENTS_OFF } : built[0].env);
      // The clone takes the token as its secret, not as an input of the step.
      if (kind !== 'clone') expect(command.input, kind).toBe(input);
      else expect(lock.steps[0].options.secrets?.token, kind).toBe(TOKEN);
    }
  });

  it('an up with Compose override files makes in the helper the command and input of its builders (batchStepCommand)', async () => {
    const files = { [COMPOSE_MODEL_PATH]: '{"services":{}}' };
    const call = (h: WorkspaceHelper): Promise<unknown> =>
      h.up({ volumeName: VOLUME, repository: 'acme/app', override: { name: 'o' }, devspaceId: DEVSPACE_ID, removeExistingContainer: false, files, env: { COMPOSE_PROJECT_NAME: 'p' }, token: TOKEN, image: IMAGE });
    const { helper, lock } = setup();
    await runWithBatchScope(lock, VOLUME, silentLogger, () => call(helper).catch(() => undefined));
    expect(lock.steps.map((step) => step.kind)).toEqual(['up']);
    expect(lock.steps[0].params).toEqual(expect.objectContaining({ files }));
    const command = batchStepCommand('up', lock.steps[0].params);
    // The command is the batch helper's only (WorkspaceHelper builds none): with the Compose files it is
    // WRITE_AND_RUN_SCRIPT.
    expect(command.command).toEqual(overrideCommand(upArgs({ workspaceFolder: '/workspaces/app', overrideConfigPath: OVERRIDE_CONFIG_PATH, idLabel: devspaceIdLabel(DEVSPACE_ID), removeExistingContainer: false }), files));
    // The reference of the input: the builders of stepInputs.ts on the inputs of the call (WorkspaceHelper gives the
    // step no input; it only checks the files).
    expect(command.input).toBe(writeAndRunInput(files, { name: 'o' }));
  });

  /**
   * The step params of `call` in a scope, and the helper command that the batch helper builds from them
   * (batchStepCommand).
   */
  async function perStepAndBatch(kind: BatchStepKind, call: (helper: WorkspaceHelper) => Promise<unknown>) {
    const { helper, lock } = setup();
    await runWithBatchScope(lock, VOLUME, silentLogger, () => call(helper).catch(() => undefined));
    expect([...new Set(lock.steps.map((step) => step.kind))], kind).toEqual([kind]);
    return { params: lock.steps[0].params, command: batchStepCommand(kind, lock.steps[0].params) };
  }

  it('a runUserCommands with Compose override files makes in the helper the command and input of its builders (batchStepCommand)', async () => {
    const files = { [COMPOSE_MODEL_PATH]: '{"services":{}}' };
    const { params, command } = await perStepAndBatch('runUserCommands', (h) =>
      h.runUserCommands({ volumeName: VOLUME, repository: 'acme/app', override: { name: 'o' }, devspaceId: DEVSPACE_ID, containerId: 'abcdef012345', files, env: { COMPOSE_PROJECT_NAME: 'p' }, token: TOKEN, image: IMAGE }),
    );
    expect(params).toEqual(expect.objectContaining({ files }));
    // The command is the batch helper's only (WorkspaceHelper builds none): with the Compose files it is
    // WRITE_AND_RUN_SCRIPT.
    expect(command.command).toEqual(
      overrideCommand(runUserCommandsArgs({ workspaceFolder: '/workspaces/app', overrideConfigPath: OVERRIDE_CONFIG_PATH, idLabel: devspaceIdLabel(DEVSPACE_ID), containerId: 'abcdef012345' }), files),
    );
    // The reference of the input: the builders of stepInputs.ts on the inputs of the call (WorkspaceHelper gives the
    // step no input; it only checks the files).
    expect(command.input).toBe(writeAndRunInput(files, { name: 'o' }));
  });

  it('build and readConfiguration with a configuration that is not the default one make in the helper the command of their builders', async () => {
    const configPath = '.devcontainer/b/devcontainer.json';
    const override = { name: 'o' };
    const files = { [COMPOSE_MODEL_PATH]: '{}' };
    const env = { COMPOSE_PROJECT_NAME: 'p' };
    // The reference of the input: the builders of stepInputs.ts on the inputs of the call (WorkspaceHelper gives the
    // step no input; it only checks the files).
    const calls: Array<[BatchStepKind, (helper: WorkspaceHelper) => Promise<unknown>, string]> = [
      ['build', (h) => h.build({ volumeName: VOLUME, repository: 'acme/app', configPath, imageName: `${PROJECT}:7`, env, image: IMAGE }), writeAndRunInput(undefined, undefined)],
      ['build', (h) => h.build({ volumeName: VOLUME, repository: 'acme/app', configPath, imageName: `${PROJECT}:7`, override, files, env, image: IMAGE }), writeAndRunInput(files, override)],
      ['readConfiguration', (h) => h.readConfiguration({ volumeName: VOLUME, repository: 'acme/app', configPath, devspaceId: DEVSPACE_ID, merged: true, override, files, env, image: IMAGE }), writeAndRunInput(files, override)],
    ];
    for (const [kind, call, input] of calls) {
      const { params, command } = await perStepAndBatch(kind, call);
      expect(params, kind).toEqual(expect.objectContaining({ configPath }));
      // The command of the batch helper (WorkspaceHelper builds none) names the configuration.
      expect(command.command.join(' '), kind).toContain('b/devcontainer.json');
      expect(command.input, kind).toBe(input);
    }
  });

  it('a step that comes after the end of the scope is refused and opens nothing', async () => {
    const { helper, lock } = setup();
    lock.stepResult = async () => ({ exitCode: 0, stdout: '["a"]\n', stderr: '', timedOut: false });
    const later = deferred();
    let late!: Promise<unknown>;
    await runWithBatchScope(lock, VOLUME, silentLogger, async () => {
      await helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE });
      // A continuation that keeps the context of the scope beyond its end (not awaited by the operation).
      late = later.promise.then(() => helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE }));
    });
    later.resolve();
    const error = await refusal(late);
    expect(error.code).toBe('helperFailed');
    expect(error.detail).toBe('The step listConfigs came after the end of the operation');
    expect(lock.opens).toHaveLength(1);
    expect(lock.events).toEqual(['open s1', 'close s1']);
  });

  // The socket is the worker's own (HelperDeps.socket).
  it('the session opens with the socket of the engine of the operation', async () => {
    const { helper, lock } = setup('/run/user/1000/docker.sock');
    lock.stepResult = async () => ({ exitCode: 0, stdout: '["a"]\n', stderr: '', timedOut: false });
    await runWithBatchScope(lock, VOLUME, silentLogger, () => helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE }));
    expect(lock.opens).toEqual([{ volume: VOLUME, image: IMAGE.id, socket: '/run/user/1000/docker.sock' }]);
  });
});
