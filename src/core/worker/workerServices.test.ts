// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The core services as the worker builds them (workerServices), the worker's own helper image (ownHelper), and what
// fails closed when the operation does not give it.
import { describe, expect, it } from 'vitest';
import { HELPER_DOCKER_SOCKET } from '../names';
import { silentLogger, type Logger } from '../ports';
import type { Devspace, RegistryFile, WindowStatus } from '../types';
import { unusedEngine } from './dockerEngine.testkit';
import type { HostSide } from './hostSide';
import { ownHelperOf, readOwnHelper } from './ownHelper';
import { hostRegistryCredentials, registryLogins, workerImageChecker, hostAuth, hostBusyMarks, hostOpenRecords, hostSessionFiles, hostStore, hostUi, workerServiceDeps, workerServices, workerSessionMonitor, type WorkerServicesDeps } from './workerServices';
import { EngineError, type DockerEngine } from './dockerEngine';
// The time limit of a monitor command is in monitorFlow.ts (the commands of the monitor in the worker).
import { MONITOR_EXEC_TIMEOUT_MS } from './monitorFlow';
import { RECORDS_RUN_LIMIT_EXIT, REMOTE_MONITOR_CONTAINER, REMOTE_MONITOR_SCRIPT_PATH } from '../remoteMonitor/protocol';
import { scriptCommand } from './containerScripts';
import { stopAfterSeconds } from '../session/sessionRules';
import { SECRET_TOKEN } from '../helperChannel/protocol';
import { IDENTITY_TOKEN_USER } from '../imageCheck/credentials';
import { ImageChecker } from '../imageCheck/imageCheck';

const IMAGE_ID = `sha256:${'c'.repeat(64)}`;

function inspect(overrides: Record<string, unknown> = {}) {
  return {
    Image: IMAGE_ID,
    Config: { Image: 'devspaces-worker:abc' },
    Mounts: [
      { Type: 'volume', Name: 'devspaces-monitor', Destination: '/state' },
      { Type: 'bind', Source: '/run/user/1000/docker.sock', Destination: HELPER_DOCKER_SOCKET },
    ],
    ...overrides,
  };
}

/** A HostSide that records its calls; every call answers with `undefined` unless given. */
function fakeHost(answers: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const answer = <T>(call: string, ...args: unknown[]): Promise<T> => {
    calls.push([call, ...args.map((arg) => JSON.stringify(arg))].join(' '));
    if (answers[call] instanceof Error) return Promise.reject(answers[call]);
    return Promise.resolve(answers[call] as T);
  };
  const host: HostSide = {
    questions: {
      confirmUntrustedRepository: (repository) => answer('confirmUntrustedRepository', repository),
      configurationChanged: (repository) => answer('configurationChanged', repository),
      configurationKindChanged: (repository, message) => answer('configurationKindChanged', repository, message),
      filesMissing: (repository) => answer('filesMissing', repository),
      recreateContainer: (repository, question) => answer('recreateContainer', repository, question),
      updateContainer: (repository, running) => answer('updateContainer', repository, running),
      message: (kind, text) => answer('message', kind, text),
      confirmDelete: (repository, confirmation) => answer('confirmDelete', repository, confirmation),
      deleteAdditionalVolumes: (volumes) => answer('deleteAdditionalVolumes', volumes),
      deleteServiceData: (volumes, possibly) => answer('deleteServiceData', volumes, possibly),
    },
    state: {
      windowStatuses: () => answer<readonly WindowStatus[]>('windowStatuses'),
      pendings: () => answer('pendings').then((value) => (value ?? []) as readonly { devspaceId: string; windowId: string; createdAt: string }[]),
      processAlive: (pid) => answer('processAlive', pid),
      account: (interactive) => answer('account', interactive),
      viewer: () => answer('viewer'),
      unrecordedLifecycle: (devspaceId) => answer('unrecordedLifecycle', devspaceId),
    },
    records: {
      read: () => answer<RegistryFile>('read'),
      get: (id) => answer<Devspace | undefined>('get', id),
      list: () => answer<Devspace[]>('list'),
      findForAccount: (repository, accountId, dockerHost) => answer('findForAccount', repository, accountId, dockerHost),
      remove: (id, volumes) => answer('remove', id, volumes),
      forgetKeptVolumes: (names) => answer('forgetKeptVolumes', names),
      rememberLifecycle: (devspaceId, containerId) => answer('rememberLifecycle', devspaceId, containerId),
      forgetLifecycle: (devspaceId, containerId) => answer('forgetLifecycle', devspaceId, containerId),
      sessionFile: (kind, devspaceId) => answer('sessionFile', kind, devspaceId),
      markBusy: (devspaceId, operation) => answer('markBusy', devspaceId, operation),
      clearBusy: (devspaceId) => answer('clearBusy', devspaceId),
      recordGitSummary: (devspaceId, summary) => answer('recordGitSummary', devspaceId, summary),
      restore: (entries) => answer('restore', entries.map((entry) => entry.id)),
      createMark: (devspaceId, kind, previous) => answer('createMark', devspaceId, kind, previous),
      takeStepMark: (devspaceId, operation) => answer('takeStepMark', devspaceId, operation),
      releaseStepMark: (devspaceId, mark) => answer('releaseStepMark', devspaceId, mark),
      ownerLogin: (devspaceId) => answer('ownerLogin', devspaceId),
      lifecycleMark: (devspaceId, change) => answer('lifecycleMark', devspaceId, change),
      openFinished: (devspaceId, finish) => answer('openFinished', devspaceId, finish),
      createDevspace: (id, repository, configPath) => answer('createDevspace', id, repository, configPath),
      dropCreated: (devspaceId) => answer('dropCreated', devspaceId),
      configuration: (devspaceId, change) => answer('configuration', devspaceId, change),
      build: (devspaceId, change) => answer('build', devspaceId, change),
      configCheck: (devspaceId) => answer('configCheck', devspaceId),
      rememberConfigCheck: (devspaceId, entry) => answer('rememberConfigCheck', devspaceId, entry),
    },
    secrets: {
      token: () => answer('token'),
      registry: (registry) => answer('registry', registry),
    },
  };
  return { host, calls };
}

describe("the worker's own helper image", () => {
  it('reads the image ID, its reference, and the source of the socket mount of the worker', async () => {
    expect(ownHelperOf(inspect())).toEqual({ image: { tag: 'devspaces-worker:abc', id: IMAGE_ID }, socket: '/run/user/1000/docker.sock' });
    for (const odd of [
      inspect({ Image: 'devspaces-worker:abc' }),
      inspect({ Config: {} }),
      inspect({ Mounts: [{ Type: 'volume', Source: 'x', Destination: HELPER_DOCKER_SOCKET }] }),
      inspect({ Mounts: [{ Type: 'bind', Source: '', Destination: HELPER_DOCKER_SOCKET }] }),
      inspect({ Mounts: undefined }),
      null,
      'text',
    ]) {
      expect(ownHelperOf(odd)).toBeUndefined();
    }
    const asked: string[] = [];
    const short = 'abc123def456';
    const full = `${short}${'0'.repeat(52)}`;
    const engine = {
      ...unusedEngine(),
      inspect: async (kind: string, reference: string) => (asked.push(`${kind} ${reference}`), reference === short ? inspect({ Id: full }) : undefined),
    };
    expect((await readOwnHelper(engine, short)).socket).toBe('/run/user/1000/docker.sock');
    expect(asked).toEqual([`container ${short}`]);
    await expect(readOwnHelper(engine, 'fedcba987654')).rejects.toThrow('is not known to the engine');
    await expect(readOwnHelper({ ...unusedEngine(), inspect: async () => inspect({ Id: full, Mounts: [] }) }, short)).rejects.toThrow('cannot be read');
    // A container found by a name like the ID is not the worker; a host name that is no container ID is never asked
    // for.
    await expect(readOwnHelper({ ...unusedEngine(), inspect: async () => inspect({ Id: `ffff${'0'.repeat(60)}` }) }, short)).rejects.toThrow('with another container');
    await expect(readOwnHelper({ ...unusedEngine(), inspect: async () => inspect() }, short)).rejects.toThrow('with another container');
    asked.length = 0;
    // Only 12 to 64 hex characters, the whole host name.
    for (const name of ['devspaces-worker', 'abc', 'x0123456789ab', '0123456789abX', 'ABC123DEF456', 'a'.repeat(65)]) {
      await expect(readOwnHelper(engine, name), name).rejects.toThrow('is not the ID of its container');
    }
    expect(asked).toEqual([]);
    // An ID that contains the host name but does not start with it is another container.
    await expect(readOwnHelper({ ...unusedEngine(), inspect: async () => inspect({ Id: `ff${short}${'0'.repeat(50)}` }) }, short)).rejects.toThrow('with another container');
    // Only the bind mount at the socket's path is the socket; a full image ID and a reference are needed.
    const state = { Type: 'bind', Source: '/srv/state', Destination: '/state' };
    expect(ownHelperOf(inspect({ Mounts: [state, { Type: 'bind', Source: '/var/run/docker.sock', Destination: HELPER_DOCKER_SOCKET }] }))?.socket).toBe('/var/run/docker.sock');
    expect(ownHelperOf(inspect({ Mounts: [state] }))).toBeUndefined();
    expect(ownHelperOf(inspect({ Image: 'sha256:abc' }))).toBeUndefined();
    expect(ownHelperOf(inspect({ Config: { Image: '' } }))).toBeUndefined();
  });
});

describe('the core services in the worker', () => {
  it('the registry goes through the record requests; it has no write by a function and no added entry', async () => {
    const { host, calls } = fakeHost({ get: { id: 'e1' }, restore: { added: 1, skipped: [] } });
    const store = hostStore(host.records);
    expect(await store.get('e1')).toEqual({ id: 'e1' });
    await store.findForAccount('acme/api', '42');
    await store.remove('e1');
    // The entries rebuilt from the volumes go as `record restore`.
    expect(await store.restore([{ id: 'e2' } as Devspace])).toEqual({ added: 1, skipped: [] });
    expect(calls).toEqual(['get "e1"', 'findForAccount "acme/api" "42" ""', 'remove "e1" {}', 'restore ["e2"]']);
    // DevspaceStore has no `updateDevspace` and no `add`: each write of the pipeline is a specific request
    // (hostBusyMarks, hostOpenRecords with the entry of a first open as `record createDevspace`, `record
    // recordGitSummary`).
    expect(store).not.toHaveProperty('updateDevspace');
    expect(store).not.toHaveProperty('add');
    expect(calls).toHaveLength(4);
  });

  it('the session files and the reads of the window go to the extension; the reopen record only by its devspace', async () => {
    const { host, calls } = fakeHost({ pendings: [{ devspaceId: 'e1', windowId: 'w', createdAt: 't' }] });
    const files = hostSessionFiles(host);
    await files.writePending('e1', 'ignored-window');
    await files.removeDisconnectRequest('e1');
    expect(await files.readPendings()).toEqual([{ devspaceId: 'e1', windowId: 'w', createdAt: 't' }]);
    expect(calls).toEqual(['sessionFile "writePending" "e1"', 'sessionFile "removeDisconnectRequest" "e1"', 'pendings']);
    // DevspaceSessionFiles has no `readReopen` and no `removeReopen`; the pipeline removes the reopen record only by
    // its devspace (`removeReopenOf`).
    expect(files).not.toHaveProperty('readReopen');
    expect(files).not.toHaveProperty('removeReopen');
  });

  // The token is asked without a dialog also for `interactive` (the extension signed in before it sent the open), so it
  // is asked twice here.
  it('the account and the token of the sign-in come from the extension; no dialog for the token; a rejected token stays here', async () => {
    const warnings: string[] = [];
    const logger: Logger = { ...silentLogger, warn: (text) => warnings.push(text) };
    const { host, calls } = fakeHost({ account: { id: '42', login: 'octo' }, token: 'ghp_x' });
    const auth = hostAuth(host, logger);
    expect(await auth.getAccount({ interactive: true })).toEqual({ id: '42', login: 'octo' });
    expect(await auth.getToken({ interactive: false })).toBe('ghp_x');
    expect(await auth.getToken({ interactive: true })).toBe('ghp_x');
    auth.reportRejectedToken?.('ghp_x');
    expect(calls).toEqual(['account true', 'token', 'token']);
    expect(warnings).toEqual(['GitHub rejected the token of the operation.']);
    expect(warnings.join()).not.toContain('ghp_x');
  });

  it('the questions go to the extension; a message that cannot be shown is logged, never thrown', async () => {
    const warnings: string[] = [];
    const { host, calls } = fakeHost({ filesMissing: 'cloneAgain', message: new Error('the window is gone') });
    const ui = hostUi(host.questions, { ...silentLogger, warn: (text) => warnings.push(text) });
    expect(await ui.filesMissing('acme/api')).toBe('cloneAgain');
    ui.warn('careful');
    ui.registrySignIn('ghcr.io');
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toEqual(['filesMissing "acme/api"', 'message "warn" "careful"', 'message "registrySignIn" "ghcr.io"']);
    expect(warnings).toEqual(['A message for the user could not be shown: the window is gone', 'A message for the user could not be shown: the window is gone']);
  });

  it("the helper runs from the worker's own image, builds nothing, and the open-only parts fail closed", async () => {
    const { host } = fakeHost();
    const { helper } = workerServices({
      host,
      engine: unusedEngine(),
      secretOf: () => undefined,
      forgetSecret: () => undefined,
      logger: silentLogger,
      ownHelper: { image: { tag: 'devspaces-worker:abc', id: IMAGE_ID }, socket: '/s.sock' },
      dockerHost: 'build-box',
      owner: { windowId: 'w', pid: 1 },
      devspaceLock: async () => {
        throw new Error('no lock in this test');
      },
    });
    // The pipeline reads the own image with one call (ownImageUse).
    expect(await helper.ownImageUse()).toEqual({ tag: 'devspaces-worker:abc', id: IMAGE_ID });
    // The worker's helper has no other image call (the helper image code of the extension is not in the worker's
    // bundle).
    expect((helper as unknown as Record<string, unknown>).presentImage).toBeUndefined();
    const controller = new AbortController();
    controller.abort();
    await expect(helper.ownImageUse(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

// The deps of the pipeline in the worker, one by one.
describe('the deps of the pipeline in the worker', () => {
  function deps(overrides: Partial<WorkerServicesDeps> = {}) {
    const { host, calls } = fakeHost({ windowStatuses: [{ windowId: 'w' }], confirmUntrustedRepository: false, recreateContainer: true, updateContainer: 'later' });
    const all = workerServiceDeps({
      host,
      engine: { ...unusedEngine(), version: async () => ({ apiVersion: '1.48', version: '29.0.0' }) },
      secretOf: (name) => (name === SECRET_TOKEN ? 'ghp_x' : undefined),
      forgetSecret: () => undefined,
      logger: silentLogger,
      ownHelper: { image: { tag: 'devspaces-worker:abc', id: IMAGE_ID }, socket: '/s.sock' },
      dockerHost: 'build-box',
      owner: { windowId: 'w', pid: 1 },
      devspaceLock: async () => {
        throw new Error('no lock in this test');
      },
      ...overrides,
    });
    return { all, calls };
  }

  it('fails closed where the operation gives nothing: the analysis, the settings; no process runner and no flow', async () => {
    const { all } = deps();
    // The message names what the operation did not give.
    await expect(all.analyzer.analyze({} as never)).rejects.toThrow('The operation gives the worker no host access analysis.');
    // The image check runs in the worker.
    expect(all.imageChecker).toBeInstanceOf(ImageChecker);
    // The pipeline has no process runner at all.
    expect(all).not.toHaveProperty('runner');
    // The pipeline has no flow at all (the flows are the window's: DevspaceOperations).
    expect(all).not.toHaveProperty('flow');
    // The message names what the operation did not give.
    expect(() => all.settings()).toThrow('The operation gives the worker no settings.');
    const settings = { stopAfterMinutes: 5 } as never;
    expect(deps({ settings }).all.settings()).toBe(settings);
  });

  it('the registry writes of the open go to the extension as their requests', async () => {
    const { all, calls } = deps();
    const records = all.openRecords!;
    const mark = { operation: 'update' as const, since: '2026-10-04T12:00:00.000Z', pid: 1, windowId: 'w' };
    await records.createMark('e1', 'previous', mark);
    await records.takeStepMark('e1', 'update');
    await records.releaseStepMark('e1', mark);
    // The worker sends no account, no time of the last use and no liveness: the extension takes its own.
    await records.ownerLogin('e1', { id: '42', login: 'mallory' });
    await records.lifecycleMark('e1', 'clear');
    await records.openFinished('e1', { lastUsedAt: '2030-01-01T00:00:00.000Z', remoteWorkspaceFolder: '/workspaces/api', remoteUser: 'node', liveness: { now: 0, windowStatuses: [] } });
    expect(calls).toEqual([
      `createMark "e1" "previous" ${JSON.stringify(mark)}`,
      'takeStepMark "e1" "update"',
      `releaseStepMark "e1" ${JSON.stringify(mark)}`,
      'ownerLogin "e1"',
      'lifecycleMark "e1" "clear"',
      'openFinished "e1" {"remoteUser":"node","remoteWorkspaceFolder":"/workspaces/api"}',
    ]);
    expect(calls).toHaveLength(6);
    // hostOpenRecords over the HostSide alone.
    const alone = fakeHost();
    await hostOpenRecords(alone.host).lifecycleMark('e2', { set: 'a'.repeat(12) });
    expect(alone.calls).toEqual([`lifecycleMark "e2" {"set":"${'a'.repeat(12)}"}`]);
  });

  it('hostOpenRecords sends the entry of a first open, its removal, the configuration and the build records', async () => {
    const entry = { id: 'e1', repository: 'acme/api', configPath: '.devcontainer/devcontainer.json', owner: { id: 'w', login: 'w' }, createdAt: 'worker clock' } as Devspace;
    const { host, calls } = fakeHost({ createDevspace: entry });
    const records = hostOpenRecords(host);
    await records.createDevspace(entry);
    await records.dropCreated('e1');
    await records.configuration('e1', { addVolumes: ['v1'], cloned: true });
    await records.build('e1', { kind: 'number', buildNumber: 3 });
    // The worker sends the ID, the repository and the configuration of the entry; the owner and the times are the extension's.
    expect(calls).toEqual([
      'createDevspace "e1" "acme/api" ".devcontainer/devcontainer.json"',
      'dropCreated "e1"',
      'configuration "e1" {"addVolumes":["v1"],"cloned":true}',
      'build "e1" {"kind":"number","buildNumber":3}',
    ]);
    // The entry of the repository that another window created meanwhile: the open finds and uses it (openFirst).
    const other = fakeHost({ createDevspace: { ...entry, id: 'e9' } });
    await expect(hostOpenRecords(other.host).createDevspace(entry)).rejects.toThrow('exists already');
    // None of these writes of the open fails closed.
    for (const write of [() => records.createDevspace(entry), () => records.dropCreated('e1'), () => records.configuration('e1', {}), () => records.build('e1', { kind: 'number', buildNumber: 1 })]) {
      await expect(write()).resolves.toBeUndefined();
    }
    expect(calls).toHaveLength(8);
  });

  it('the analysis of the operation, when it brings one (the analysis thread of the worker)', () => {
    const analyzer = { analyze: async () => ({}) as never };
    expect(deps({ analyzer }).all.analyzer).toBe(analyzer);
  });

  it('the Docker host of the operation, the engine check, the window reads, the questions, and the secret of the operation', async () => {
    const { all, calls } = deps();
    expect(await all.dockerTarget!()).toEqual({ kind: 'remote', host: 'build-box', endpoint: '' });
    expect(await deps({ dockerHost: '' }).all.dockerTarget!()).toEqual({ kind: 'local', host: '', endpoint: '' });
    await all.startDocker!({ onStarting: () => {} });
    const down = deps({ engine: { ...unusedEngine(), version: async () => Promise.reject(new Error('connect ENOENT')) } }).all;
    await expect(down.startDocker!({ onStarting: () => {} })).rejects.toMatchObject({ code: 'dockerEngineNotRunning' });
    // The worker never answers synchronously whether a process of the computer runs; the pipeline asks the extension
    // (processAlive).
    expect(() => all.isProcessAlive!(1)).toThrow('synchronously');
    expect(await all.windowStatuses!()).toEqual([{ windowId: 'w' }]);
    expect(await all.ui.confirmUntrustedRepository('acme/api')).toBe(false);
    expect(await all.ui.recreateContainer('acme/api', { message: 'm', detail: 'd' })).toBe(true);
    // The question of the update of a running container.
    expect(await all.ui.updateContainer('acme/api', false)).toBe('later');
    expect(calls).toEqual(['windowStatuses', 'confirmUntrustedRepository "acme/api"', 'recreateContainer "acme/api" {"message":"m","detail":"d"}', 'updateContainer "acme/api" false']);
    // The secret input of an exec must be the token of the operation (EngineDocker over secretOf), by its name: another
    // secret than the token is refused, the token of the operation is taken.
    await expect(all.docker.exec('c', ['cat'], { secretInputName: 'registry' as typeof SECRET_TOKEN })).rejects.toThrow('token secret of the operation');
    const execs: unknown[] = [];
    const withExec = deps({ engine: { ...unusedEngine(), exec: async (_c, _command, options) => (execs.push(options), { exitCode: 0, stdout: '', stderr: '', timedOut: false }) } }).all;
    await withExec.docker.exec('c', ['cat'], { secretInputName: SECRET_TOKEN });
    expect(execs).toEqual([{ secretInputName: SECRET_TOKEN }]);
    // The image call of the pipeline: ownImageUse, the one read of the own image.
    await expect(all.helper.ownImageUse()).resolves.toEqual({ tag: 'devspaces-worker:abc', id: IMAGE_ID });
  });
});

// Delete's `forget` is the worker's: it forgets a record; a failure is logged, a missing container is not.
describe("the worker's Monitor for Delete", () => {
  const SOURCE = '0123456789abcdef0123456789abcdef';
  const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';

  function engineWith(answer: () => Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>) {
    const execs: { container: string; command: readonly string[]; timeoutMs?: number }[] = [];
    const engine: DockerEngine = {
      ...unusedEngine(),
      exec: async (container, command, options = {}) => (execs.push({ container, command, timeoutMs: options.timeoutMs }), answer()),
    };
    return { engine, execs };
  }

  function log() {
    const lines: string[] = [];
    return { lines, logger: { ...silentLogger, warn: (text: string) => lines.push(`warn ${text}`) } as Logger };
  }

  it('forgets the record of the computer by the command of the monitor script, under the lock of its records, within its limit', async () => {
    const { engine, execs } = engineWith(async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }));
    const { lines, logger } = log();
    await workerSessionMonitor(engine, SOURCE, logger).forget(ID);
    // The command of the entry monitorForget.
    expect(execs).toEqual([{ container: REMOTE_MONITOR_CONTAINER, command: scriptCommand('monitorForget', [SOURCE, ID]), timeoutMs: MONITOR_EXEC_TIMEOUT_MS }]);
    expect(execs[0].command.slice(-5)).toEqual(['node', REMOTE_MONITOR_SCRIPT_PATH, 'forget', SOURCE, ID]);
    expect(execs[0].command[0]).toBe('flock');
    expect(lines).toEqual([]);
  });

  it('a missing monitor container is not logged; a failure, a kill and no end in time are', async () => {
    const { lines, logger } = log();
    await workerSessionMonitor(engineWith(async () => Promise.reject(new EngineError('No such container', 404))).engine, SOURCE, logger).forget(ID);
    expect(lines).toEqual([]);
    await workerSessionMonitor(engineWith(async () => ({ exitCode: 1, stdout: '', stderr: 'boom', timedOut: false })).engine, SOURCE, logger).forget(ID);
    await workerSessionMonitor(engineWith(async () => ({ exitCode: RECORDS_RUN_LIMIT_EXIT, stdout: '', stderr: '', timedOut: false })).engine, SOURCE, logger).forget(ID);
    await workerSessionMonitor(engineWith(async () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true })).engine, SOURCE, logger).forget(ID);
    // A monitor that does not run (idle) is not logged either.
    await workerSessionMonitor(engineWith(async () => Promise.reject(new EngineError('Container abc is not running', 409))).engine, SOURCE, logger).forget(ID);
    await workerSessionMonitor(engineWith(async () => Promise.reject(new EngineError('conflict', 409))).engine, SOURCE, logger).forget(ID);
    expect(lines).toEqual([
      `warn The heartbeat record of ${ID} could not be removed from the Monitor: boom`,
      `warn The heartbeat record of ${ID} could not be removed from the Monitor: the command was killed (its limit of 10 s, or a kill from outside)`,
      `warn The heartbeat record of ${ID} could not be removed from the Monitor: docker exec did not end within ${MONITOR_EXEC_TIMEOUT_MS / 1000} seconds.`,
      `warn The heartbeat record of ${ID} could not be removed from the Monitor: conflict`,
    ]);
  });

  it('without the computer of the operation, it refuses; the rest of the monitor fails closed', async () => {
    const { engine, execs } = engineWith(async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }));
    const monitor = workerSessionMonitor(engine, undefined, silentLogger);
    await expect(monitor.forget(ID)).rejects.toThrow('names no computer');
    // The heartbeats of a window are the operation `heartbeat`. The ensure fails closed without the ensure of its
    // operation (the message names what the operation did not give), and the first heartbeat is not sent without the
    // computer.
    await expect(monitor.ensure(undefined)).rejects.toThrow('The operation gives the worker no ensure of the Monitor');
    expect(await monitor.heartbeat(ID, false, 1)).toEqual({ ok: false, detail: 'The operation names no computer for the Monitor.' });
    expect(execs).toEqual([]);
  });

  describe("the open's Monitor in the worker", () => {
    /** The ID of the computer of the operation, as computer.id makes it. */
    const COMPUTER = 'c'.repeat(32);
    it("the first heartbeat of the open: this computer's record with the time limit, by the command of the monitor script", async () => {
      const { engine, execs } = engineWith(async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }));
      const monitor = workerSessionMonitor(engine, COMPUTER, silentLogger, { limitSeconds: () => 900 });
      expect(await monitor.heartbeat(ID, true, 7)).toEqual({ ok: true });
      // The command of the entry monitorHeartbeat.
      expect(execs).toEqual([
        {
          container: REMOTE_MONITOR_CONTAINER,
          command: scriptCommand('monitorHeartbeat', [JSON.stringify({ source: COMPUTER, limitSeconds: 900, devspaces: [{ id: ID, keepRunning: true, seq: 7 }] })]),
          timeoutMs: MONITOR_EXEC_TIMEOUT_MS,
        },
      ]);
    });

    it('a computer ID that the monitor would refuse is not sent; the limit is clamped', async () => {
      const { engine, execs } = engineWith(async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }));
      for (const source of ['', 'a b', '../x', 'x'.repeat(200)]) {
        expect(await workerSessionMonitor(engine, source, silentLogger, { limitSeconds: () => 900 }).heartbeat(ID, false, 1), source).toEqual({
          ok: false,
          detail: 'The computer of the operation has no valid ID for the Monitor.',
        });
      }
      expect(execs).toEqual([]);
      // The time limit of odd settings is the clamped one that the window's heartbeats send too.
      for (const minutes of [Number.NaN, -5, 1e9]) {
        const limit = stopAfterSeconds(minutes);
        expect(Number.isInteger(limit) && limit > 0, String(minutes)).toBe(true);
      }
    });

    it('a failed heartbeat is answered as not sent, with its cause; without the time limit it is not sent', async () => {
      const failing = engineWith(async () => ({ exitCode: 1, stdout: '', stderr: 'records locked', timedOut: false }));
      expect(await workerSessionMonitor(failing.engine, COMPUTER, silentLogger, { limitSeconds: () => 900 }).heartbeat(ID, false, 1)).toEqual({ ok: false, detail: 'records locked' });
      const { engine, execs } = engineWith(async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }));
      expect(await workerSessionMonitor(engine, COMPUTER, silentLogger).heartbeat(ID, false, 1)).toEqual({
        ok: false,
        detail: 'The operation has no settings for the time limit of the heartbeat.',
      });
      expect(execs).toEqual([]);
    });

    it("the ensure is the operation's, with the signal of the run; its failure refuses (it rejects with the cause)", async () => {
      const { engine } = engineWith(async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }));
      const signals: (AbortSignal | undefined)[] = [];
      const signal = new AbortController().signal;
      await workerSessionMonitor(engine, COMPUTER, silentLogger, { ensure: async (s) => void signals.push(s) }).ensure(signal);
      expect(signals).toEqual([signal]);
      const failing = workerSessionMonitor(engine, COMPUTER, silentLogger, { ensure: async () => Promise.reject(new Error('no space left')) });
      await expect(failing.ensure(undefined)).rejects.toThrow('no space left');
    });

    it('the deps of the pipeline: the ensure of the operation, and the time limit of its settings', async () => {
      const { engine, execs } = engineWith(async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }));
      const ensured: unknown[] = [];
      const deps = (overrides: Partial<WorkerServicesDeps>) =>
        workerServiceDeps({
          host: {} as HostSide,
          engine,
          secretOf: () => undefined,
          forgetSecret: () => undefined,
          logger: silentLogger,
          ownHelper: { image: { tag: 'devspaces-worker:abc', id: `sha256:${'e'.repeat(64)}` }, socket: '/s.sock' },
          dockerHost: '',
          owner: { windowId: 'w', pid: 1 },
          devspaceLock: async () => Promise.reject(new Error('no lock in this test')),
          ...overrides,
        });
      const all = deps({ monitorSource: COMPUTER, settings: { stopAfterMinutes: 30 } as never, monitorEnsure: async (s) => void ensured.push(s) });
      await all.sessionMonitor!.ensure(undefined);
      // The signal of the run goes to the ensure of the operation.
      const run = new AbortController().signal;
      await all.sessionMonitor!.ensure(run);
      expect(ensured).toEqual([undefined, run]);
      expect(await all.sessionMonitor!.heartbeat(ID, false, 3)).toEqual({ ok: true });
      // The command of the entry monitorHeartbeat.
      expect(execs.map((exec) => exec.command)).toEqual([
        scriptCommand('monitorHeartbeat', [JSON.stringify({ source: COMPUTER, limitSeconds: stopAfterSeconds(30), devspaces: [{ id: ID, keepRunning: false, seq: 3 }] })]),
      ]);
      // Without them, the ensure fails closed and no heartbeat is sent.
      const bare = deps({});
      // The message names what the operation did not give.
      await expect(bare.sessionMonitor!.ensure(undefined)).rejects.toThrow('The operation gives the worker no ensure of the Monitor');
      expect(await bare.sessionMonitor!.heartbeat(ID, false, 3)).toMatchObject({ ok: false });
      expect(execs).toHaveLength(1);
    });
  });

  describe('the login of a registry for one use', () => {
    function host(answer: () => Promise<unknown>) {
      const asked: string[] = [];
      return {
        asked,
        host: {
          secrets: {
            registry: async (registry: string) => (asked.push(registry), answer()),
          },
        } as unknown as HostSide,
      };
    }

    it('asked for the registry when it is needed, and forgotten by the operation right after, whatever the answer', async () => {
      for (const [answer, expected] of [
        [async () => ({ username: 'octo', serveraddress: 'ghcr.io', password: 'p1' }), { username: 'octo', password: 'p1' }],
        [async () => ({ identityToken: true, serveraddress: 'registry.example.com', password: 't1' }), { username: IDENTITY_TOKEN_USER, password: 't1' }],
        [async () => undefined, undefined],
        [async () => Promise.reject(new Error('channel closed')), undefined],
      ] as const) {
        const { host: side, asked } = host(answer as () => Promise<unknown>);
        let forgotten = 0;
        const warnings: string[] = [];
        // The logins of the operation are one after the other (registryLogins).
        const provider = hostRegistryCredentials(registryLogins(side, () => void forgotten++, { ...silentLogger, warn: (text: string) => warnings.push(text) }));
        expect(await provider('ghcr.io', undefined, 'o/i')).toEqual(expected);
        expect(asked).toEqual(['ghcr.io']);
        expect(forgotten).toBe(1);
        // The next use asks again.
        await provider('ghcr.io', undefined, 'o/i');
        expect(asked).toEqual(['ghcr.io', 'ghcr.io']);
        // Only a failed request is logged.
        expect(warnings.length > 0).toBe(expected === undefined && warnings.some((text) => text.includes('channel closed')));
      }
    });

    it('two logins asked at once are asked one after the other, each read and forgotten before the next', async () => {
      // One secret slot, as the operation has it: an answer sets it; the reader reads it after the answer.
      let slot: string | undefined;
      const events: string[] = [];
      const pending: (() => void)[] = [];
      const side = {
        secrets: {
          registry: (registry: string) =>
            new Promise((resolve) => {
              events.push(`ask ${registry}`);
              pending.push(() => {
                slot = `PASS-${registry}`;
                resolve({ username: `u-${registry}`, serveraddress: registry, password: slot });
              });
            }),
        },
      } as unknown as HostSide;
      const logins = registryLogins(side, () => {
        events.push('forget');
        slot = undefined;
      }, silentLogger);
      const provider = hostRegistryCredentials(logins);
      const both = Promise.all([provider('a.example', undefined, 'o/i'), provider('b.example', undefined, 'o/i')]);
      // The turn takes a few steps (a cancelable wait).
      for (let i = 0; i < 10 && events.length === 0; i++) await Promise.resolve();
      for (let i = 0; i < 10; i++) await Promise.resolve();
      // Only the first is asked while it is open.
      expect(events).toEqual(['ask a.example']);
      pending.shift()!();
      for (let i = 0; i < 10 && pending.length === 0; i++) await Promise.resolve();
      pending.shift()!();
      expect(await both).toEqual([
        { username: 'u-a.example', password: 'PASS-a.example' },
        { username: 'u-b.example', password: 'PASS-b.example' },
      ]);
      expect(events).toEqual(['ask a.example', 'forget', 'ask b.example', 'forget']);
    });

    it('a login whose user gave up while it waited is not asked, and nothing is forgotten', async () => {
      const side = host(async () => ({ username: 'octo', serveraddress: 'ghcr.io', password: 'p1' }));
      let forgotten = 0;
      const provider = hostRegistryCredentials(registryLogins(side.host, () => void forgotten++, silentLogger));
      const gaveUp = new AbortController();
      gaveUp.abort();
      expect(await provider('ghcr.io', gaveUp.signal, 'o/i')).toBeUndefined();
      expect(side.asked).toEqual([]);
      // Nothing was asked, so nothing is forgotten.
      expect(forgotten).toBe(0);
      expect(await provider('ghcr.io', new AbortController().signal, 'o/i')).toEqual({ username: 'octo', password: 'p1' });
      expect(side.asked).toEqual(['ghcr.io']);
    });

    it("the pipeline's pulls ask the login of their registry through the operation only after a refusal, and forget the registry secret", async () => {
      const asked: string[] = [];
      const forgotten: string[] = [];
      let slot: string | undefined;
      const side = {
        secrets: {
          registry: async (registry: string) => {
            asked.push(registry);
            slot = 'gho_x';
            return { username: 'octo', serveraddress: registry, password: 'gho_x' };
          },
        },
      } as unknown as HostSide;
      const logins: string[] = [];
      const all = workerServiceDeps({
        host: side,
        engine: {
          ...unusedEngine(),
          pull: async (reference, options) => {
            // ghcr.io/o/i:1 is private: its pull without a login is refused.
            if (options?.login === undefined && reference === 'ghcr.io/o/i:1') throw new EngineError('unauthorized: authentication required', 401);
            logins.push(`${options?.login?.secretName} ${slot}`);
          },
        },
        secretOf: (name) => (name === 'registry' ? slot : undefined),
        forgetSecret: (name) => {
          forgotten.push(name);
          slot = undefined;
        },
        logger: silentLogger,
        ownHelper: { image: { tag: 'devspaces-worker:abc', id: `sha256:${'e'.repeat(64)}` }, socket: '/s.sock' },
        dockerHost: '',
        owner: { windowId: 'w', pid: 1 },
        devspaceLock: async () => Promise.reject(new Error('no lock in this test')),
      });
      // A public image: no login is asked.
      await all.docker.pullImage('ghcr.io/o/public:1', { onOutput: () => {} });
      expect(asked).toEqual([]);
      expect(logins).toEqual(['undefined undefined']);
      await all.docker.pullImage('ghcr.io/o/i:1', { onOutput: () => {} });
      expect(asked).toEqual(['ghcr.io']);
      expect(logins).toEqual(['undefined undefined', 'registry gho_x']);
      expect(forgotten).toEqual(['registry']);
    });

    it('a turn whose user cancels while it waits ends at once, without a request; the turns after it keep their order', async () => {
      const events: string[] = [];
      let release: () => void = () => {};
      const side = {
        secrets: {
          registry: (registry: string) =>
            new Promise((resolve) => {
              events.push(`ask ${registry}`);
              release = () => resolve({ username: 'u', serveraddress: registry, password: `p-${registry}` });
            }),
        },
      } as unknown as HostSide;
      const logins = registryLogins(side, () => void events.push('forget'), silentLogger);
      const first = logins({ registry: 'a.example', repository: 'o/i' }, async (login) => login?.password);
      const cancel = new AbortController();
      const second = logins({ registry: 'b.example', repository: 'o/i' }, async (login) => login?.password, cancel.signal);
      const third = logins({ registry: 'c.example', repository: 'o/i' }, async (login) => login?.password);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      cancel.abort();
      await expect(second).rejects.toMatchObject({ name: 'AbortError' });
      // The first still holds its turn: the third waits for it.
      expect(events).toEqual(['ask a.example']);
      release();
      expect(await first).toBe('p-a.example');
      for (let i = 0; i < 20 && events.length < 3; i++) await Promise.resolve();
      release();
      expect(await third).toBe('p-c.example');
      expect(events).toEqual(['ask a.example', 'forget', 'ask c.example', 'forget']);
    });

    it('an abort during the request of a login: AbortError, no use, and the login is forgotten', async () => {
      const cancel = new AbortController();
      let forgotten = 0;
      let used = 0;
      const side = {
        secrets: {
          registry: async (registry: string) => {
            cancel.abort();
            return { username: 'u', serveraddress: registry, password: 'p' };
          },
        },
      } as unknown as HostSide;
      const logins = registryLogins(side, () => void forgotten++, silentLogger);
      await expect(logins({ registry: 'a.example', repository: 'o/i' }, async () => void used++, cancel.signal)).rejects.toMatchObject({ name: 'AbortError' });
      expect({ forgotten, used }).toEqual({ forgotten: 1, used: 0 });
      // The next turn still runs.
      expect(await logins({ registry: 'b.example', repository: 'o/i' }, async (login) => login?.password)).toBe('p');
    });

    it("the worker never passes credentials of its own to a pull (they would bypass the turns)", () => {
      const all = workerServiceDeps({
        host: {} as HostSide,
        engine: unusedEngine(),
        secretOf: () => undefined,
        forgetSecret: () => undefined,
        logger: silentLogger,
        ownHelper: { image: { tag: 'devspaces-worker:abc', id: `sha256:${'e'.repeat(64)}` }, socket: '/s.sock' },
        dockerHost: '',
        owner: { windowId: 'w', pid: 1 },
        devspaceLock: async () => Promise.reject(new Error('no lock in this test')),
      });
      // The pipeline has no such dep.
      expect(all).not.toHaveProperty('pullCredentials');
    });

    it('a use that fails still forgets, and the next login is still asked', async () => {
      const side = host(async () => ({ username: 'octo', serveraddress: 'ghcr.io', password: 'p1' }));
      let forgotten = 0;
      const logins = registryLogins(side.host, () => void forgotten++, silentLogger);
      await expect(logins({ registry: 'ghcr.io', repository: 'o/i' }, async () => Promise.reject(new Error('pull failed')))).rejects.toThrow('pull failed');
      expect(await logins({ registry: 'ghcr.io', repository: 'o/i' }, async (login) => login?.password)).toBe('p1');
      expect(forgotten).toBe(2);
    });

    it("the worker's image check reads neither the proxy nor a login before a check needs them", async () => {
      let proxies = 0;
      const side = host(async () => undefined);
      const checker = workerImageChecker({
        host: side.host,
        engine: { ...unusedEngine(), proxy: async () => (proxies++, {}) },
        forgetSecret: () => undefined,
        logger: silentLogger,
      });
      expect(checker).toBeInstanceOf(ImageChecker);
      expect(proxies).toBe(0);
      expect(side.asked).toEqual([]);
    });
  });

  it('the busy marks and the reopen record of the devspace go to the extension as their requests', async () => {
    const calls: { call: string; args: unknown[] }[] = [];
    const records = {
      markBusy: async (...args: unknown[]) => (calls.push({ call: 'markBusy', args }), undefined),
      clearBusy: async (...args: unknown[]) => void calls.push({ call: 'clearBusy', args }),
      sessionFile: async (...args: unknown[]) => void calls.push({ call: 'sessionFile', args }),
    } as unknown as HostSide['records'];
    const marks = hostBusyMarks(records);
    expect(await marks.mark(ID, 'delete')).toBeUndefined();
    await marks.clear(ID);
    await hostSessionFiles({ records } as unknown as HostSide).removeReopenOf(ID);
    expect(calls).toEqual([
      { call: 'markBusy', args: [ID, 'delete'] },
      { call: 'clearBusy', args: [ID] },
      { call: 'sessionFile', args: ['removeReopenOf', ID] },
    ]);
  });
});
