// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The batch scope of the opens in the devspace service. Start, Rebuild, a change of the configuration, Clone again and a
// first open run their helper steps in the batch scope of the volume of the devspace (batchScope.ts), opened under
// the held lock and closed before its release: on success, on a failure, and on a cancel; before the removal of the
// volume (a failed first open) its session is closed first. The listing of the configuration picker runs in a scope of
// its own under the lock too. Delete's check runs no Git in the batch helper (no scope, no lock). The token write into
// the dev container uses the secret input of the call (through the worker that holds the lock). The FakeHelper does not
// route itself; each of its volume steps runs one step of the scope here, as WorkspaceHelper does.
import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DevspaceLockError, type HeldDevspaceLock } from '../docker/devspaceLock';
import { UserFacingError, isBatchHelperUnavailable } from '../errors';
import { Messages } from '../messages';
import type { BatchStepOptions, HelperBatchSession } from '../helperChannel/helperChannel';
import { currentBatchScope } from '../helper/batchScope';
import { abortError, isAbortError, silentLogger, type RunResult } from '../ports';
import type { BatchStepKind } from '../helper/batchStepKinds';
import { batchStepCommand } from '../helper/batchSteps';
import { composeProjectName } from '../names';
import type { HelperImageUse } from '../helper/helperImage';
import { WorkspaceHelper } from '../helper/workspaceHelper';
import { DEVSPACE_LOCK_WAIT_SECONDS, PipelineTexts, type RepositoryTarget } from './operationBase';
import { BASE_IMAGE, DIGEST_NEW, ENV_ID, REPO, TOKEN, checked, createHarness, seedDevspace, type Harness } from './devspaceService.testkit';
import { DEFAULT_CONFIG_PATH } from './recordRules';
import { resourceName } from '../names';

const TARGET: RepositoryTarget = { repository: REPO, defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };
const VOLUME = resourceName(REPO, ENV_ID);
/** The volume steps of the FakeHelper (each one a step of the batch helper in WorkspaceHelper). */
const VOLUME_STEPS = [
  'clone',
  'readConfigFiles',
  'listConfigurations',
  'readConfiguration',
  'build',
  'composeModel',
  'composeServiceHashes',
  'createRepositoryFolders',
  'up',
  'runUserCommands',
  'prepareGit',
  'fixConfigOwnership',
  // The ownership fix of the repository before the dev container is created.
  'fixRepositoryOwnership',
] as const;

let h: Harness;
/** In order: `lock`, `open <session>`, `step <name> <session>`, `close <session>`, `docker volume rm`, `release`. */
let events: string[];
/** Each volume step of the FakeHelper: its name and the volume of the scope it ran in (or `none`). */
let scopes: string[];
/** Runs before each step of a session (for a cancel during a step). */
let onStep: ((name: string) => void) | undefined;
/** Runs when a close starts; the close settles after `closeGate`. */
let onClose: (() => void) | undefined;
let closeGate: Promise<void> | undefined;
/** Each step of a session, with its kind and parameters. */
let recorded: Array<{ kind: BatchStepKind; params: unknown }>;
/**
 * When set, each volume step of the FakeHelper runs as the real WorkspaceHelper runs it in the scope (with the
 * parameters that the service passes), instead of one `listConfigs` step.
 */
let realHelper: WorkspaceHelper | undefined;
/** When set, the batch helper of the lock cannot be opened (`batch` rejects with it). */
let batchError: Error | undefined;
/** When set, the lock is refused with it (after its wait). */
let lockError: Error | undefined;
/** The wait of each lock asked for, in seconds. */
let lockWaits: number[];
/**
 * Runs during the wait for the lock (for a cancel then); a wait whose signal is aborted ends with an AbortError, as the
 * wait of the real lock does.
 */
let onLockWait: (() => void) | undefined;
const PINNED: HelperImageUse = { tag: 'devspaces-worker:test', id: `sha256:${'4'.repeat(64)}` };

/**
 * The real WorkspaceHelper as the worker builds it, on its own image (PINNED) with its socket; it has no Docker port,
 * and a query of a container in the scope throws.
 */
function workerHelper(): WorkspaceHelper {
  return new WorkspaceHelper({
    logger: silentLogger,
    ownImage: PINNED,
    socket: '/var/run/docker.sock',
    containerRuns: async () => {
      throw new Error('A container query in the scope.');
    },
  });
}

function batchLock(devspaceId: string): HeldDevspaceLock {
  let sessions = 0;
  return {
    devspaceId,
    lost: new Promise(() => {}),
    batch: async (p) => {
      if (batchError !== undefined) {
        events.push(`open refused ${p.volume}`);
        throw batchError;
      }
      const session = `s${++sessions}`;
      events.push(`open ${session} ${p.volume}`);
      const handle: HelperBatchSession = {
        session,
        lost: new Promise(() => {}),
        step: async (kind, params, options: BatchStepOptions = {}): Promise<RunResult> => {
          recorded.push({ kind, params });
          onStep?.(kind);
          if (options.signal?.aborted) throw abortError();
          events.push(`step ${kind} ${session}`);
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
        },
        close: async () => {
          onClose?.();
          await closeGate;
          events.push(`close ${session}`);
        },
      };
      return handle;
    },
    release: async () => {
      events.push('release');
    },
  };
}

beforeEach(() => {
  events = [];
  scopes = [];
  onStep = undefined;
  onClose = undefined;
  closeGate = undefined;
  recorded = [];
  realHelper = undefined;
  batchError = undefined;
  lockError = undefined;
  lockWaits = [];
  onLockWait = undefined;
  h = createHarness({
    newDevspaceId: () => ENV_ID,
    devspaceLock: async (devspaceId, waitSeconds, signal) => {
      events.push('lock');
      lockWaits.push(waitSeconds);
      if (onLockWait !== undefined) {
        onLockWait();
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (signal?.aborted) throw abortError();
      }
      if (lockError !== undefined) throw lockError;
      return batchLock(devspaceId);
    },
  });
  const helper = h.helper as unknown as Record<string, (p: { volumeName: string; signal?: AbortSignal }) => Promise<unknown>>;
  for (const name of VOLUME_STEPS) {
    const original = helper[name].bind(h.helper);
    helper[name] = async (p) => {
      const scope = currentBatchScope();
      scopes.push(`${name} ${scope?.volume ?? 'none'}`);
      // As WorkspaceHelper.runInBatch: the step goes to the session of the scope (opened at the first step).
      if (scope !== undefined && realHelper !== undefined) {
        const real = realHelper as unknown as Record<string, (p: unknown) => Promise<unknown>>;
        // Its result is not used (the FakeHelper answers); a refusal or a cancel goes on as in WorkspaceHelper.
        // The fake containers have IDs of their own; Docker's are hexadecimal.
        const ids = 'containerId' in p ? { containerId: createHash('sha256').update(String(p.containerId)).digest('hex') } : {};
        await real[name]({ ...p, ...ids, image: PINNED }).catch((error: unknown) => {
          if (error instanceof UserFacingError || isAbortError(error)) throw error;
        });
      } else if (scope !== undefined) {
        await scope.step({ volume: p.volumeName, kind: 'listConfigs', params: {}, options: { signal: p.signal } }, async () => ({ image: `sha256:${'4'.repeat(64)}`, socket: '/var/run/docker.sock' }));
      }
      return original(p);
    };
  }
  const removeVolume = h.docker.removeVolume.bind(h.docker);
  h.docker.removeVolume = async (name) => {
    events.push('docker volume rm');
    return removeVolume(name);
  };
});

afterEach(() => h.cleanup());

/** The events without the steps (one session, its open and close, and what came around them). */
function frame(): string[] {
  return events.filter((event) => !event.startsWith('step '));
}

describe('the batch scope of the opens', () => {
  it('Start: every helper step runs in the scope of the volume, in one session, closed before the lock is released', async () => {
    await seedDevspace(h, { container: 'stopped' });
    await h.service.openDevspace(ENV_ID, { progress: h.progress });
    expect(scopes.length).toBeGreaterThan(0);
    expect(scopes.every((scope) => scope.endsWith(` ${VOLUME}`))).toBe(true);
    expect(frame()).toEqual(['lock', `open s1 ${VOLUME}`, 'close s1', 'release']);
    expect(currentBatchScope()).toBeUndefined();
  });

  it('Rebuild: one session for the build and `up`', async () => {
    await seedDevspace(h, { container: 'running' });
    await h.service.openDevspace(ENV_ID, { progress: h.progress, forceRebuild: true });
    expect(scopes).toEqual(expect.arrayContaining([`build ${VOLUME}`, `up ${VOLUME}`]));
    expect(frame()).toEqual(['lock', `open s1 ${VOLUME}`, 'close s1', 'release']);
  });

  it('a failed step closes the session before the release', async () => {
    await seedDevspace(h, { container: 'stopped' });
    h.helper.readConfigurationError = new Error('read failed');
    await h.service.openDevspace(ENV_ID, { progress: h.progress }).catch(() => undefined);
    expect(frame().slice(-2)).toEqual(['close s1', 'release']);
    expect(frame().filter((event) => event.startsWith('open'))).toHaveLength(1);
  });

  it('a cancel during a step closes the session before the release', async () => {
    await seedDevspace(h, { container: 'stopped' });
    const controller = new AbortController();
    onStep = () => controller.abort();
    const error = await h.service.openDevspace(ENV_ID, { progress: h.progress, signal: controller.signal }).then(
      () => undefined,
      (reason: unknown) => reason as UserFacingError,
    );
    expect(error?.code).toBe('cancelled');
    expect(frame()).toEqual(['lock', `open s1 ${VOLUME}`, 'close s1', 'release']);
  });

  it('first open: the session opens after the volume exists; a failed clone closes it before the volume is removed', async () => {
    h.helper.cloneError = new Error('Repository not found');
    await h.service.open(TARGET, { progress: h.progress }).catch(() => undefined);
    const [open] = frame().filter((event) => event.startsWith('open'));
    const volume = open.split(' ')[2];
    expect(h.docker.volumes.has(volume)).toBe(false);
    expect(frame()).toEqual(['lock', open, 'close s1', 'docker volume rm', 'release']);
    expect(scopes).toEqual([`clone ${volume}`]);
  });

  it('Clone again: the session opens at the clone, after the new volume', async () => {
    await seedDevspace(h, { volume: false, container: null });
    h.ui.filesMissingAnswer = 'cloneAgain';
    await h.service.open(TARGET, { progress: h.progress });
    expect(scopes[0]).toBe(`clone ${VOLUME}`);
    expect(frame()).toEqual(['lock', `open s1 ${VOLUME}`, 'close s1', 'release']);
  });

  it('the listing of the configuration picker runs in the batch helper under the lock', async () => {
    // The listing of the configurations runs as the step listConfigs in one session under the lock.
    await seedDevspace(h, { container: 'stopped' });
    // The helper of the worker (workerHelper).
    realHelper = workerHelper();
    expect(await h.service.listConfigurations(ENV_ID, { progress: h.progress })).toEqual(Object.keys(h.helper.files));
    expect(scopes).toEqual([`listConfigurations ${VOLUME}`]);
    expect(recorded).toEqual([{ kind: 'listConfigs', params: { repository: REPO } }]);
    expect(frame()).toEqual(['lock', `open s1 ${VOLUME}`, 'close s1', 'release']);
    expect(lockWaits).toEqual([DEVSPACE_LOCK_WAIT_SECONDS]);
  });

  it('the listing of the picker is refused when the batch helper cannot be opened or the lock is busy', async () => {
    await seedDevspace(h, { container: 'stopped' });
    batchError = new Error('the helper image is not on the host');
    const refused = await h.service.listConfigurations(ENV_ID, { progress: h.progress }).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(isBatchHelperUnavailable(refused)).toBe(true);
    expect(frame()).toEqual(['lock', `open refused ${VOLUME}`, 'release']);
    batchError = undefined;
    lockError = new DevspaceLockError('busy', 'The lock stayed held by another holder for 10 s.');
    const busy = await h.service.listConfigurations(ENV_ID, { progress: h.progress }).then(
      () => undefined,
      (reason: unknown) => reason as UserFacingError,
    );
    expect(busy?.message).toBe(PipelineTexts.devspaceLockBusy(REPO));
    expect(h.helper.calls).not.toContain('listConfigurations');
  });

  // A cancel of the picker's listing passes its signal to the step: the listing rejects as cancelled, the session is
  // closed, and the lock is released.
  for (const when of ['lock wait', 'listConfigs step'] as const) {
    it(`a cancel during the ${when} of the picker's listing rejects as cancelled; the lock is released`, async () => {
      await seedDevspace(h, { container: 'stopped' });
      const controller = new AbortController();
      if (when === 'lock wait') onLockWait = () => controller.abort();
      else onStep = () => controller.abort();
      // The step runs as the real WorkspaceHelper sends it (kind listConfigs), with the own image of the worker
      // (workerHelper).
      realHelper = workerHelper();
      const error = await h.service.listConfigurations(ENV_ID, { progress: h.progress, signal: controller.signal }).then(
        (paths) => ({ paths }),
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(UserFacingError);
      expect((error as UserFacingError).code).toBe('cancelled');
      if (when === 'lock wait') {
        // The lock was never granted: nothing to release, no session, no step.
        expect(frame()).toEqual(['lock']);
        expect(recorded).toEqual([]);
      } else {
        // The step saw the aborted signal; the session is closed and the lock released, in that order.
        expect(frame()).toEqual(['lock', `open s1 ${VOLUME}`, 'close s1', 'release']);
        expect(recorded.map((step) => step.kind)).toEqual(['listConfigs']);
        expect(events.filter((event) => event.startsWith('step '))).toEqual([]);
      }
      expect(h.helper.calls).not.toContain('listConfigurations');
    });
  }

  it('the token goes into the dev container as the secret input of the exec, never in its command', async () => {
    await seedDevspace(h, { container: 'stopped' });
    await h.service.openDevspace(ENV_ID, { progress: h.progress });
    const writes = h.docker.execs.filter((exec) => exec.input === TOKEN);
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) {
      expect(write.secret).toBe(true);
      expect(write.command.some((arg) => arg.includes(TOKEN))).toBe(false);
    }
  });

  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  }

  /** One turn of the event loop (no timer). */
  const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  it('the lock is released only after the close of the session settled', async () => {
    await seedDevspace(h, { container: 'stopped' });
    const closing = deferred();
    const gate = deferred();
    onClose = closing.resolve;
    closeGate = gate.promise;
    const run = h.service.openDevspace(ENV_ID, { progress: h.progress });
    await closing.promise;
    await turn();
    expect(events).not.toContain('release');
    gate.resolve();
    await run;
    expect(frame()).toEqual(['lock', `open s1 ${VOLUME}`, 'close s1', 'release']);
  });

  it('a failed first open removes the volume only after the close of the session settled', async () => {
    h.helper.cloneError = new Error('Repository not found');
    const closing = deferred();
    const gate = deferred();
    onClose = closing.resolve;
    closeGate = gate.promise;
    const run = h.service.open(TARGET, { progress: h.progress }).catch(() => undefined);
    await closing.promise;
    await turn();
    expect(events).not.toContain('docker volume rm');
    gate.resolve();
    await run;
    const [open] = frame().filter((event) => event.startsWith('open'));
    expect(frame()).toEqual(['lock', open, 'close s1', 'docker volume rm', 'release']);
  });

  const COMPOSE_CONFIG = `{
  "name": "API",
  "dockerComposeFile": ["compose.yml"],
  "service": "app",
  "workspaceFolder": "/workspaces/\${localWorkspaceFolderBasename}"
}`;

  const opens: Array<[string, () => Promise<unknown>, BatchStepKind[]]> = [
    // The first open runs the step repositoryOwnershipFix in the same session too.
    ['single container (first open)', () => h.service.open(TARGET, { progress: h.progress }), ['clone', 'readConfiguration', 'build', 'repositoryOwnershipFix', 'up', 'gitFiles', 'runUserCommands']],
    [
      'Docker Compose (first open)',
      () => {
        h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: COMPOSE_CONFIG } };
        h.helper.composeOutput = {
          version: '2.40.3',
          dollarEscaped: true,
          model: { name: composeProjectName(REPO, ENV_ID), services: { app: { image: BASE_IMAGE, command: ['sleep', 'infinity'] } } },
          dockerfiles: {},
          realPaths: {},
          inputsHash: 'inputs-1',
        };
        h.checker.outcome = checked({ [BASE_IMAGE]: DIGEST_NEW });
        return h.service.open(TARGET, { progress: h.progress });
      },
      ['clone', 'readConfiguration', 'composeModel', 'build', 'up'],
    ],
    [
      'Rebuild',
      async () => {
        await seedDevspace(h, { container: 'running' });
        return h.service.openDevspace(ENV_ID, { progress: h.progress, forceRebuild: true });
      },
      ['readConfiguration', 'build', 'up', 'runUserCommands'],
    ],
    [
      'Clone again',
      async () => {
        await seedDevspace(h, { volume: false, container: null });
        h.ui.filesMissingAnswer = 'cloneAgain';
        return h.service.open(TARGET, { progress: h.progress });
      },
      ['clone', 'readConfiguration', 'up', 'runUserCommands'],
    ],
  ];
  for (const [name, open, kinds] of opens) {
    it(`every step of a whole open is one the batch helper accepts (batchStepCommand): ${name}`, async () => {
      // The helper of the worker (workerHelper).
      realHelper = workerHelper();
      await open();
      expect(frame().filter((event) => event.startsWith('open '))).toHaveLength(1);
      expect(recorded.map((step) => step.kind)).toEqual(expect.arrayContaining(kinds));
      for (const step of recorded) expect(() => batchStepCommand(step.kind, step.params), step.kind).not.toThrow();
    });
  }
});

/**
 * A batch helper that cannot be opened is an inconsistent state: a refusal of the batch scope refuses Start, Rebuild
 * and a change of the configuration, also for a running container that is current: it is not opened as it is (that rule applies
 * only to a helper image that cannot be prepared).
 */
describe('a batch helper that cannot be opened refuses the open', () => {
  const PYTHON = '.devcontainer/python/devcontainer.json';
  const cases: Array<[string, () => { forceRebuild?: boolean; configPath?: string }]> = [
    ['Start', () => ({})],
    ['Rebuild', () => ({ forceRebuild: true })],
    [
      'a change of the configuration',
      () => {
        h.helper.files[PYTHON] = { configText: '{ "image": "python:3.12" }' };
        h.helper.config = { image: 'python:3.12' };
        return { configPath: PYTHON };
      },
    ],
  ];

  for (const [name, options] of cases) {
    it(`${name}: a refused batch session refuses the open of a running, current container, which is not opened as it is`, async () => {
      const env = await seedDevspace(h, { container: 'running' });
      const before = h.docker.containersOf(ENV_ID).map((container) => `${container.id} ${container.state}`);
      batchError = new Error('the helper container did not start');
      const extra = options();
      const opened = await h.service.openDevspace(ENV_ID, { progress: h.progress, ...extra }).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      // Refused: no result, so the window does not connect to the container.
      expect('result' in opened ? opened.result : undefined).toBeUndefined();
      const error = (opened as { error: unknown }).error;
      expect(isBatchHelperUnavailable(error)).toBe(true);
      expect((error as UserFacingError).code).toBe('helperFailed');
      expect((error as UserFacingError).message).toBe(
        Messages.batchHelperUnavailable(`The batch helper on the volume ${VOLUME} could not be opened: the helper container did not start`),
      );
      // Not opened as it is (the rule for a helper image that cannot be prepared): no warning, no log line about it,
      // nothing created or changed.
      expect(h.ui.warnings).toEqual([]);
      expect(h.logger.errors.filter((line) => line.includes('opened as it is'))).toEqual([]);
      expect(h.helper.ups).toEqual([]);
      expect(h.docker.containersOf(ENV_ID).map((container) => `${container.id} ${container.state}`)).toEqual(before);
      if (extra.configPath !== undefined) expect((await h.registry.get(ENV_ID))?.configPath).toBe(env.configPath);
      expect(frame()).toEqual(['lock', `open refused ${VOLUME}`, 'release']);
    });
  }

  it('a step that fails in its session after the configuration was read refuses the open too (no Git warning, not opened as it is)', async () => {
    await seedDevspace(h, { container: 'running' });
    // The session is lost at the Git setup of the running container (Step 9): the step fails in its session.
    onStep = () => {
      if (scopes.at(-1)?.startsWith('prepareGit ')) throw new Error('the session was lost');
    };
    const error = await h.service.openDevspace(ENV_ID, { progress: h.progress }).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(isBatchHelperUnavailable(error)).toBe(true);
    expect(h.ui.warnings).toEqual([]);
    expect(scopes.map((scope) => scope.split(' ')[0])).toContain('prepareGit');
    expect(frame()).toEqual(['lock', `open s1 ${VOLUME}`, 'close s1', 'release']);
  });

  // Also after Step 8, the refusal of the scope at fixConfigOwnership is no warning.
  it('a step that fails in its session at fixConfigOwnership refuses the open', async () => {
    await seedDevspace(h, { container: 'running' });
    h.helper.config = { ...h.helper.config, remoteUser: 'vscode' };
    onStep = () => {
      if (scopes.at(-1)?.startsWith('fixConfigOwnership ')) throw new Error('the lock was lost');
    };
    const error = await h.service.openDevspace(ENV_ID, { progress: h.progress, forceRebuild: true }).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(scopes.map((scope) => scope.split(' ')[0])).toContain('fixConfigOwnership');
    expect(isBatchHelperUnavailable(error)).toBe(true);
  });

  // As at fixConfigOwnership, the refusal of the scope at the fix before the container is created refuses the open; it
  // is no warning, and nothing is created.
  it('a step that fails in its session at fixRepositoryOwnership refuses the first open', async () => {
    onStep = () => {
      if (scopes.at(-1)?.startsWith('fixRepositoryOwnership ')) throw new Error('the lock was lost');
    };
    const error = await h.service.open(TARGET, { progress: h.progress }).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(scopes.map((scope) => scope.split(' ')[0])).toContain('fixRepositoryOwnership');
    expect(isBatchHelperUnavailable(error)).toBe(true);
    expect(h.helper.ups).toEqual([]);
    expect(h.logger.warnings.filter((line) => line.includes('could not be changed before the container was created'))).toEqual([]);
  });

  it('the fix before the container is created runs in the session of the open, before `up`, with parameters the batch helper accepts', async () => {
    // The helper of the worker (workerHelper).
    realHelper = workerHelper();
    await h.service.open(TARGET, { progress: h.progress });
    const kinds = recorded.map((step) => step.kind);
    expect(kinds.indexOf('repositoryOwnershipFix')).toBeGreaterThan(kinds.indexOf('build'));
    expect(kinds.indexOf('repositoryOwnershipFix')).toBeLessThan(kinds.indexOf('up'));
    const fix = recorded.find((step) => step.kind === 'repositoryOwnershipFix')!;
    expect(fix.params).toEqual({ repository: REPO, uid: '1000', gid: '1000' });
    expect(() => batchStepCommand(fix.kind, fix.params)).not.toThrow();
    expect(frame().filter((event) => event.startsWith('open '))).toHaveLength(1);
  });

  // Only the refusal of the scope is rethrown at fixConfigOwnership. Any other failure of the fix, also a user-facing
  // helperFailed, is logged and the open goes on.
  it('a helperFailed of fixConfigOwnership that is no refusal is logged and the open goes on', async () => {
    await seedDevspace(h, { container: 'running' });
    h.helper.config = { ...h.helper.config, remoteUser: 'vscode' };
    h.helper.configOwnershipResult = new UserFacingError('helperFailed', Messages.helperFailed);
    const result = await h.service.openDevspace(ENV_ID, { progress: h.progress, forceRebuild: true });
    expect(result.containerName).toBe(h.docker.containersOf(ENV_ID)[0].name);
    expect(scopes.map((scope) => scope.split(' ')[0])).toContain('fixConfigOwnership');
    expect(h.logger.warnings.some((line) => line.includes('could not be changed') && line.includes(Messages.helperFailed))).toBe(true);
  });

  // helperFailedInUpdate with a detail keeps the message of the refusal.
  it('a refusal of the scope after `up` keeps its message', async () => {
    await seedDevspace(h, { container: 'running' });
    onStep = () => {
      if (scopes.at(-1)?.startsWith('runUserCommands ')) throw new Error('the lock was lost');
    };
    const error = await h.service.openDevspace(ENV_ID, { progress: h.progress, forceRebuild: true }).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(scopes.map((scope) => scope.split(' ')[0])).toContain('runUserCommands');
    expect(isBatchHelperUnavailable(error)).toBe(true);
    expect((error as UserFacingError).message).not.toBe(Messages.helperFailed);
    expect((error as UserFacingError).detail).toBeTruthy();
  });

  it('a helper image that cannot be prepared: a running, current container opens as it is', async () => {
    await seedDevspace(h, { container: 'running' });
    h.helper.ensureImageError = new UserFacingError('helperFailed', Messages.helperFailed);
    // The tag of the helper image exists (the lock builds only a missing tag); the maintaining ensure fails.
    h.helper.tagPresent = true;
    const result = await h.service.openDevspace(ENV_ID, { progress: h.progress });
    expect(result.containerName).toBe(h.docker.containersOf(ENV_ID)[0].name);
    expect(h.ui.warnings).toEqual([Messages.helperFailed]);
    expect(h.logger.errors).toEqual([`The workspace helper is not available for ${REPO}. The running devspace is opened as it is. ${Messages.helperFailed}`]);
    expect(h.helper.ups).toEqual([]);
  });
});

/**
 * The Git state never blocks Delete: Delete's check runs no step of the batch helper and takes no lock. It names the
 * recorded Git state, refreshed with `docker exec` in a running dev container; Delete itself still takes the lock.
 */
describe("Delete's check runs no Git in the batch helper", () => {
  it('a stopped container: no lock, no session, no step; the recorded state; Delete takes the lock for itself', async () => {
    const env = await seedDevspace(h, { container: 'stopped' });
    expect(await h.service.safetyCheck(ENV_ID, { progress: h.progress })).toEqual(env.gitSummary);
    expect(events).toEqual([]);
    expect(scopes).toEqual([]);
    expect(recorded).toEqual([]);
    expect(h.helper.calls).toEqual([]);
    expect(h.docker.execs).toEqual([]);
    await h.service.delete(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] });
    expect(frame().filter((event) => event === 'lock')).toHaveLength(1);
    expect(await h.registry.get(ENV_ID)).toBeUndefined();
  });

  it('a running container: the refresh runs in the dev container, never as a step of the batch helper', async () => {
    await seedDevspace(h, { container: 'running' });
    h.docker.execHandler = () => ({ stdout: 'feature\n1\n2\n3\n' });
    expect(await h.service.safetyCheck(ENV_ID, { progress: h.progress })).toMatchObject({ branch: 'feature', uncommittedFiles: 1, unpushedCommits: 2, stashes: 3 });
    expect(h.docker.execs.map((exec) => exec.user)).toEqual(['vscode']);
    expect(events).toEqual([]);
    expect(scopes).toEqual([]);
    expect(recorded).toEqual([]);
    expect(h.helper.calls).toEqual([]);
  });

  it('a batch helper that cannot be opened and a busy lock do not hinder the check', async () => {
    const env = await seedDevspace(h, { container: 'stopped' });
    batchError = new Error('the helper image is not on the host');
    lockError = new DevspaceLockError('busy', 'The lock stayed held by another holder for 10 s.');
    expect(await h.service.safetyCheck(ENV_ID, { progress: h.progress })).toEqual(env.gitSummary);
    expect(events).toEqual([]);
  });

  it('a missing volume needs no lock: the check returns undefined', async () => {
    await seedDevspace(h, { volume: false, container: null });
    expect(await h.service.safetyCheck(ENV_ID, { progress: h.progress })).toBeUndefined();
    expect(events).toEqual([]);
  });
});
