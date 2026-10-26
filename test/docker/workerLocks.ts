// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The real workers for the Docker test files of the open pipeline, as extension.ts wires them (HelperChannels,
// openHelperChannel, the bundled worker script), with a state volume of the test. Their flows take the devspace lock
// and start the batch helper of an operation in the worker. `dispose` closes the workers and returns the worker and
// batch helper containers that are left over. Also a holder of a lock in a plain container (holdLockInContainer,
// lockIsFree), and the batch helper of the worker started from the test process (inProcessBatches), for the tests that
// need them without an operation of the worker.
import type { DevspaceStates, StateDevspace } from '../../src/core/pipeline/refreshStates';
import * as fs from 'fs';
import * as path from 'path';
import * as esbuild from 'esbuild';
import { sharedBundleOptions, workerBundleOptions } from '../../scripts/bundleOptions.mjs';
// The Docker CLI of the extension (BootstrapDocker).
import type { BootstrapDocker } from '../../src/core/docker/bootstrapDocker';
import type { DockerTarget } from '../../src/core/docker/dockerHost';
import type { DockerTargets } from '../../src/core/docker/dockerTargets';
import type { HeldDevspaceLock } from '../../src/core/docker/devspaceLock';
import { runWithBatchScope } from '../../src/core/helper/batchScope';
import { helperImageTag } from '../../src/core/helper/helperImage';
import type { HelperBatchSession } from '../../src/core/helperChannel/helperChannel';
import { HelperChannels, openHelperChannel } from '../../src/core/helperChannel/helperChannels';
import { LABEL_CHANNEL_STEP, LABEL_HELPER_CHANNEL } from '../../src/core/names';
import { LOCK_BUSY_EXIT, LOCK_STATE_DIR } from '../../src/core/helperChannel/protocol';
import { workerBatchSession } from '../../src/helperChannel/batch';
import { engineApi, engineHijack } from '../../src/helperChannel/engineApi';
import { dockerEngine } from '../../src/helperChannel/engineClient';
import { contextSecrets } from '../../src/helperChannel/operationContext.testkit';
import type { OperationContext } from '../../src/helperChannel/server';
import { TEST_RUN_LABEL, readBaseline } from './dockerRun';
import { HELPER_DOCKERFILE, testStateVolume, testVscodeVolume, type DockerTestContext } from './harness';

let bundled: Promise<string> | undefined;

/** The worker script (dist/helperChannel.js) bundled from the sources, once per test process. */
export function workerScript(): Promise<string> {
  bundled ??= esbuild
    .build({
      // The worker's bundle as a production build of esbuild.mjs builds it: also the program of the Monitor and of
      // the analysis thread.
      ...workerBundleOptions(sharedBundleOptions({ production: true })),
      write: false,
      logLevel: 'silent',
    })
    .then((result) => result.outputFiles[0].text);
  return bundled;
}

export interface WorkerLocks {
  readonly channels: HelperChannels;
  /** DevspaceServiceDeps.flow, a flow in the worker of the current Docker target (as extension.ts). */
  flow(op: string, params: unknown, options: { signal?: AbortSignal; timeoutMs?: number }): Promise<unknown>;
  /** DevspaceServiceDeps.workerRefresh, the refresh in the worker of the current Docker target (as extension.ts). */
  refresh(devspaces: readonly StateDevspace[]): Promise<DevspaceStates>;
  /** The names of the worker containers that this object started, in order. */
  readonly workerNames: string[];
  /** The worker and batch helper containers of this object that still exist. */
  leftovers(): string[];
  /** Closes the workers; waits for their containers and the batch helpers to be gone, and returns those left over. */
  dispose(): Promise<string[]>;
}

/**
 * The workers of one window for a Docker test file (see the module comment). `socketPath`: the socket source of a worker
 * for its target (default: the local socket of the target, as extension.ts for a local engine).
 */
export function workerLocks(
  context: Pick<DockerTestContext, 'run' | 'cli' | 'log'>,
  docker: BootstrapDocker,
  targets: Pick<DockerTargets, 'current'>,
  name: string,
  socketPath: (target: DockerTarget) => Promise<string>,
  /** `none` starts the workers without network (the offline scenarios). */
  options: { network?: 'none' } = {},
): WorkerLocks {
  const { run, cli, log } = context;
  const helperTag = helperImageTag(fs.readFileSync(HELPER_DOCKERFILE, 'utf8'));
  const workerNames: string[] = [];
  const channels = new HelperChannels({
    logger: log,
    open: (target) =>
      openHelperChannel(
        {
          start: (args) => {
            const all = [...args];
            all.splice(all.indexOf(helperTag), 0, '--label', `${TEST_RUN_LABEL}=${run.runId}`);
            if (options.network !== undefined) all[all.indexOf('--network') + 1] = options.network;
            workerNames.push(all[all.indexOf('--name') + 1]);
            return docker.start(all);
          },
          runDirect: (args, options) => docker.run(args, options),
          logger: log,
          script: workerScript,
          helperTag: async () => helperTag,
          socketPath: async () => socketPath(target),
          stateVolume: testStateVolume(context, name),
          // The shared VS Code server store, a volume of the test file.
          vscodeVolume: testVscodeVolume(context, name),
        },
        target,
      ),
  });
  // Only the workers that this object started (the leftovers of one window, which the other windows of a test file do
  // not hold up).
  const workerContainers = () =>
    cli.lines(['ps', '-a', '--filter', `label=${LABEL_HELPER_CHANNEL}`, '--filter', `label=${TEST_RUN_LABEL}=${run.runId}`, '--format', '{{.Names}}']).filter((name) => workerNames.includes(name));
  // The batch helpers that the flows of the workers start (workerBatchSession) carry no label of the run; the test
  // files run one at a time, so every batch helper that the engine did not have before the tests is one of this file.
  const baselineNames = new Set(readBaseline(run).containers.map((container) => container.name));
  const flowBatchContainers = () => cli.lines(['ps', '-a', '--filter', `label=${LABEL_CHANNEL_STEP}`, '--format', '{{.Names}}']).filter((name) => !baselineNames.has(name));
  const leftovers = () => [...new Set([...workerContainers(), ...flowBatchContainers()])];
  return {
    channels,
    workerNames,
    leftovers,
    flow: async (op, params, options) => channels.flow(await targets.current(), op, params, options),
    refresh: async (devspaces) => channels.refresh(await targets.current(), devspaces),
    dispose: async () => {
      channels.dispose();
      const deadline = Date.now() + 60_000;
      while (leftovers().length > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
      return leftovers();
    },
  };
}

let lockHolderBundle: Promise<string> | undefined;

/** The bundle of lockHolder.ts, once per test process. */
function lockHolderScript(): Promise<string> {
  lockHolderBundle ??= esbuild
    .build({ entryPoints: [path.resolve(__dirname, 'lockHolder.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node24', minify: true, write: false, logLevel: 'silent' })
    .then((result) => result.outputFiles[0].text);
  return lockHolderBundle;
}

/** The arguments of `docker run` of a lockHolder.ts container on the state volume (root, no network, no capabilities, as the worker). */
async function lockHolderArgs(context: Pick<DockerTestContext, 'run'>, stateVolume: string, helperTag: string, args: string[]): Promise<string[]> {
  return [
    '--label', `${TEST_RUN_LABEL}=${context.run.runId}`, '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--mount', `type=volume,source=${stateVolume},target=${LOCK_STATE_DIR}`,
    helperTag, 'node', '-e', await lockHolderScript(), ...args,
  ];
}

/**
 * The lock of a devspace held by a plain container of the helper image on the state volume of the workers, for a
 * test that needs a holder elsewhere without an operation of the worker. Taken with the code of the worker and the
 * Monitor (lockHolder.ts: openLockFile, then `flock` on its file descriptor), so the lock file is the one that
 * they make and check. Resolves once the lock is held; `release` removes the container (the kernel lets go of the lock
 * with its process).
 */
export async function holdLockInContainer(
  context: Pick<DockerTestContext, 'run' | 'cli'>,
  stateVolume: string,
  helperTag: string,
  devspaceId: string,
): Promise<{ container: string; release(): void }> {
  const { cli } = context;
  const container = cli.ok(['run', '-d', ...(await lockHolderArgs(context, stateVolume, helperTag, ['hold', devspaceId, '30']))]);
  const deadline = Date.now() + 45_000;
  while (!cli.run(['logs', container]).out.includes('held')) {
    if (Date.now() > deadline || cli.container(container)?.State.Running !== true) {
      const logs = cli.run(['logs', container]);
      cli.run(['rm', '-f', container]);
      throw new Error(`The lock of ${devspaceId} was not taken by the holder container: ${logs.out} ${logs.err}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // A removal that fails is an error (else the lock stays held, and a later check reads busy).
  return { container, release: () => void cli.ok(['rm', '-f', container]) };
}

/**
 * Whether the lock of a devspace can be taken on the state volume within `waitSeconds` (a plain container of the
 * helper image takes it as a worker does, lockHolder.ts, and lets go at once): true when taken, false when another
 * holder kept it for the whole wait (LOCK_BUSY_EXIT).
 */
export async function lockIsFree(context: Pick<DockerTestContext, 'run' | 'cli'>, stateVolume: string, helperTag: string, devspaceId: string, waitSeconds: number): Promise<boolean> {
  const result = context.cli.run(['run', '--rm', ...(await lockHolderArgs(context, stateVolume, helperTag, ['try', devspaceId, String(waitSeconds)]))]);
  if (result.code !== 0 && result.code !== LOCK_BUSY_EXIT) throw new Error(`The lock of ${devspaceId} could not be tried: ${result.err}`);
  return result.code === 0;
}

export interface InProcessBatches {
  /** Opens a batch session as the worker's own flow opens it (workerBatchSession), from the test process. */
  open(p: { volume: string; image: string; socket: string }, signal?: AbortSignal): Promise<HelperBatchSession>;
  /** The sessions opened, in order. */
  readonly sessions: string[];
  /**
   * Runs `fn` in the batch scope of `volume`, as an operation of the worker runs its helper steps (runWithBatchScope over
   * a held lock whose `batch` is `open`): its session is closed at the end.
   */
  inScope<T>(devspaceId: string, volume: string, fn: () => Promise<T>): Promise<T>;
  /** The batch helper containers of the sessions that still exist. */
  leftovers(): string[];
  /** Ends the operation of the sessions; waits for their containers to be gone, and returns those left over. */
  dispose(): Promise<string[]>;
}

/**
 * The batch helper of the worker run from the test process (the pieces of the worker in process: workerBatchSession
 * with the bundled worker script, over the Engine API of `socket`, the socket of the engine as the test process reaches
 * it), for the steps of WorkspaceHelper that no flow sends directly, without an operation of the worker. The helper is
 * the one that a flow of the worker starts.
 */
export async function inProcessBatches(context: Pick<DockerTestContext, 'cli' | 'log'>, socket: string): Promise<InProcessBatches> {
  const { cli, log } = context;
  const script = await workerScript();
  const operation = new AbortController();
  const operationContext: OperationContext = {
    signal: operation.signal,
    ...contextSecrets(),
    progress: () => {},
    log: (text, level) => (level === 'warn' ? log.warn(text) : log.info(text)),
    output: () => {},
  };
  const engine = dockerEngine(engineApi(socket), engineHijack(socket));
  const deps = { engineOf: () => engine, readScript: () => script };
  const sessions: string[] = [];
  // The cancel of an open (its `signal`) ends that open, as the worker's operation would.
  const open = async (p: { volume: string; image: string; socket: string }, signal?: AbortSignal): Promise<HelperBatchSession> => {
    const context = signal === undefined ? operationContext : { ...operationContext, signal: AbortSignal.any([operation.signal, signal]) };
    const session = await workerBatchSession(deps, context, p);
    sessions.push(session.session);
    return session;
  };
  const leftovers = () => sessions.flatMap((session) => cli.lines(['ps', '-a', '-q', '--filter', `label=${LABEL_CHANNEL_STEP}=${session}`]));
  return {
    open,
    sessions,
    leftovers,
    inScope: (devspaceId, volume, fn) => {
      const lock: HeldDevspaceLock = {
        devspaceId,
        lost: new Promise<string>(() => {}),
        batch: (p, signal) => open(p, signal),
        release: async () => {},
      };
      return runWithBatchScope(lock, volume, log, fn);
    },
    dispose: async () => {
      operation.abort();
      const deadline = Date.now() + 60_000;
      while (leftovers().length > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
      return leftovers();
    },
  };
}
