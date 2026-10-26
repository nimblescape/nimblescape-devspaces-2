// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The two sides of what a flow in the worker needs from the user's computer: workerHostSide sends the requests,
// hostSideHandler answers them. Here they are wired to each other, so one test covers both.
import { describe, expect, it, vi } from 'vitest';
import { HelperOperationError } from '../helperChannel/helperChannel';
import { OP_DELETE, OP_DELETE_CHECK, OP_LIST_CONFIGURATIONS, OP_OPEN, OP_STOP, OP_TOKEN_REMOVE, SECRET_REGISTRY, SECRET_TOKEN, type AskKind } from '../helperChannel/protocol';
import { silentLogger, type Logger } from '../ports';
import type { Devspace, GitHubAccount, RegistryFile, WindowStatus } from '../types';
import type { GitHubViewer } from '../helper/containerGit';
import type { BusyMarkResult } from '../pipeline/busyMarks';
import { FLOW_REQUESTS, parseHostRequest, type HostCall, type HostSide } from './hostSide';
import { hostSideHandler } from './hostSideHandler';
import { parseBusyMarkAnswer, workerHostSide } from './workerHostSide';

const DEVSPACE = { id: 'e1', repository: 'acme/app', owner: { id: 'a1' } } as unknown as Devspace;

/** Every request of HostSide: the tests of the two sides run with all of them allowed. */
const ALL: readonly HostCall[] = [
  ...[
    'confirmUntrustedRepository',
    'configurationChanged',
    'configurationKindChanged',
    'filesMissing',
    'recreateContainer',
    'updateContainer',
    'message',
    'confirmDelete',
    'deleteAdditionalVolumes',
    'deleteServiceData',
    'unknown',
    'Bad-Call',
  ].map(
    (call) => `question ${call}` as const,
  ),
  // There is no request `local settings` (the open carries its settings in its parameters). It is allowed here, so its
  // refusal is the handler's.
  ...['windowStatuses', 'pendings', 'settings', 'processAlive', 'account', 'unknown'].map((call) => `local ${call}` as const),
  // There are no requests `add` and `update` (they are allowed here, so their refusal is the handler's).
  ...['read', 'get', 'list', 'findForAccount', 'add', 'update', 'remove', 'forgetKeptVolumes', 'sessionFile', 'markBusy', 'clearBusy', 'recordGitSummary', 'configuration'].map((call) => `record ${call}` as const),
  'secret token',
  'secret registry',
  'secret unknown',
  // There is no request kind `connect`.
];
const STATUS = { windowId: 'w1', devspaceId: 'e1' } as unknown as WindowStatus;

/** A HostSide of this computer that records its calls and answers from `answers`. */
function fakeHost(answers: Partial<Record<string, unknown>> = {}) {
  const calls: { call: string; args: unknown[] }[] = [];
  const of = <T>(call: string, fallback: T): T => (call in answers ? (answers[call] as T) : fallback);
  const record = (call: string, ...args: unknown[]) => calls.push({ call, args });
  const host: HostSide = {
    questions: {
      confirmUntrustedRepository: async (repository) => (record('confirmUntrustedRepository', repository), of('confirmUntrustedRepository', false)),
      configurationChanged: async (repository, what) => (record('configurationChanged', repository, ...(what !== undefined ? [what] : [])), of('configurationChanged', 'later' as const)),
      configurationKindChanged: async (repository, message) => (record('configurationKindChanged', repository, message), of('configurationKindChanged', 'later' as const)),
      filesMissing: async (repository) => (record('filesMissing', repository), of('filesMissing', undefined)),
      recreateContainer: async (repository, question) => (record('recreateContainer', repository, question), of('recreateContainer', false)),
      updateContainer: async (repository, running) => (record('updateContainer', repository, running), of('updateContainer', 'cancel' as const)),
      message: async (kind, text) => void record('message', kind, text),
      // The questions of Delete.
      confirmDelete: async (repository, confirmation) => (record('confirmDelete', repository, confirmation), of('confirmDelete', undefined as 'delete' | 'open' | undefined)),
      deleteAdditionalVolumes: async (volumes) => (record('deleteAdditionalVolumes', volumes), of('deleteAdditionalVolumes', undefined as 'remove' | 'keep' | undefined)),
      deleteServiceData: async (volumes, possibly) => (record('deleteServiceData', volumes, possibly), of('deleteServiceData', undefined as string[] | undefined)),
    },
    state: {
      windowStatuses: async () => (record('windowStatuses'), of('windowStatuses', [STATUS] as readonly WindowStatus[])),
      pendings: async () => (record('pendings'), of('pendings', [] as readonly { devspaceId: string; windowId: string; createdAt: string }[])),
      processAlive: async (pid) => (record('processAlive', pid), of('processAlive', true)),
      account: async (interactive) => (record('account', interactive), of('account', undefined as GitHubAccount | undefined)),
      // The viewer and the lifecycle of a container.
      viewer: async () => (record('viewer'), of('viewer', undefined as GitHubViewer | undefined)),
      unrecordedLifecycle: async (devspaceId) => (record('unrecordedLifecycle', devspaceId), of('unrecordedLifecycle', undefined as string | undefined)),
    },
    records: {
      read: async () => (record('read'), of('read', { version: 1, devspaces: [] } as RegistryFile)),
      get: async (id) => (record('get', id), of('get', undefined)),
      list: async () => (record('list'), of('list', [] as Devspace[])),
      findForAccount: async (repository, accountId, dockerHost, source) => (record('findForAccount', repository, accountId, dockerHost, ...(source === undefined ? [] : [source])), of('findForAccount', undefined)),
      remove: async (id, volumes) => void record('remove', id, volumes),
      forgetKeptVolumes: async (names) => void record('forgetKeptVolumes', names),
      // The lifecycle of a container.
      rememberLifecycle: async (devspaceId, containerId) => void record('rememberLifecycle', devspaceId, containerId),
      forgetLifecycle: async (devspaceId, containerId) => void record('forgetLifecycle', devspaceId, containerId),
      sessionFile: async (kind, devspaceId) => void record('sessionFile', kind, devspaceId),
      // The busy marks.
      markBusy: async (devspaceId, operation) => (record('markBusy', devspaceId, operation), of('markBusy', undefined as BusyMarkResult)),
      clearBusy: async (devspaceId) => void record('clearBusy', devspaceId),
      recordGitSummary: async (devspaceId, summary) => void record('recordGitSummary', devspaceId, summary),
      // The entries that the worker restored.
      restore: async (entries) => (record('restore', entries), of('restore', { added: entries.length, skipped: [] as string[] })),
      // The registry writes of the open (their tests: hostSide.openRequests.test.ts).
      createMark: async (devspaceId, kind, previous, scope) => (record('createMark', devspaceId, kind, previous, scope), of('createMark', undefined)),
      takeStepMark: async (devspaceId, operation, scope) => (record('takeStepMark', devspaceId, operation, scope), of('takeStepMark', undefined)),
      releaseStepMark: async (devspaceId, mark, scope) => (record('releaseStepMark', devspaceId, mark, scope), of('releaseStepMark', undefined)),
      ownerLogin: async (devspaceId, scope) => (record('ownerLogin', devspaceId, scope), of('ownerLogin', undefined)),
      lifecycleMark: async (devspaceId, change, scope) => (record('lifecycleMark', devspaceId, change, scope), of('lifecycleMark', undefined)),
      openFinished: async (devspaceId, finish, scope) => (record('openFinished', devspaceId, finish, scope), of('openFinished', undefined)),
      // The entry of a first open (their tests: hostSide.entryRequests.test.ts).
      createDevspace: async (id, repository, configPath, scope) => (record('createDevspace', id, repository, configPath, scope), of('createDevspace', DEVSPACE)),
      dropCreated: async (devspaceId, scope) => void record('dropCreated', devspaceId, scope),
      configuration: async (devspaceId, change, scope) => (record('configuration', devspaceId, change, scope), of('configuration', undefined)),
      build: async (devspaceId, change, scope) => (record('build', devspaceId, change, scope), of('build', undefined)),
      // The remembered check result of the configuration.
      configCheck: async (devspaceId, scope) => (record('configCheck', devspaceId, scope), of('configCheck', undefined)),
      rememberConfigCheck: async (devspaceId, entry, scope) => void record('rememberConfigCheck', devspaceId, entry, scope),
    },
    secrets: {
      token: async () => (record('token'), of('token', undefined)),
      registry: async (registry, repository) => (record('registry', registry, repository), of('registry', undefined)),
    },
  };
  return { host, calls };
}

/**
 * The worker's HostSide wired to the handler of the extension: every call goes through one request, and the secrets of
 * an answer are kept as the operation keeps them.
 */
function wired(answers: Partial<Record<string, unknown>> = {}, logger: Logger = silentLogger, allowed: readonly HostCall[] = ALL, devspaceId = 'e1') {
  const { host, calls } = fakeHost(answers);
  // The requests that change a devspace are answered only for the devspace of the operation (SCOPED_REQUESTS);
  // the operation of these tests is the one of `e1`.
  const handler = hostSideHandler(host, logger, allowed, { devspaceId });
  const secrets: Record<string, string> = {};
  const signal = new AbortController().signal;
  const requests: { kind: string; call: string; args: unknown[] }[] = [];
  /** What the extension answered, as it goes over the channel (JSON). */
  const answers_: unknown[] = [];
  const worker = workerHostSide(
    async (request) => {
      requests.push({ ...request });
      const answer = await handler(request.kind, { call: request.call, args: request.args }, signal);
      answers_.push(answer);
      Object.assign(secrets, answer.secrets ?? {});
      return (JSON.parse(JSON.stringify({ value: answer.value })) as { value?: unknown }).value;
    },
    (name) => secrets[name],
  );
  return { worker, host, calls, requests, answers: answers_, secrets, handler, signal };
}

describe('the requests of a flow in the worker', () => {
  it('asks the questions of the user interface with their kind and gives their answers back', async () => {
    const { worker, calls, requests } = wired({
      confirmUntrustedRepository: true,
      configurationChanged: 'rebuildNow',
      configurationKindChanged: 'rebuildNow',
      filesMissing: 'cloneAgain',
      recreateContainer: true,
    });
    expect(await worker.questions.confirmUntrustedRepository('acme/app')).toBe(true);
    expect(await worker.questions.configurationChanged('acme/app')).toBe('rebuildNow');
    expect(await worker.questions.configurationChanged('acme/app', 'defaultImage')).toBe('rebuildNow');
    expect(await worker.questions.configurationKindChanged('acme/app', 'the kind changed')).toBe('rebuildNow');
    expect(await worker.questions.filesMissing('acme/app')).toBe('cloneAgain');
    expect(await worker.questions.recreateContainer('acme/app', { message: 'm', detail: 'd' })).toBe(true);
    await worker.questions.message('warn', 'careful');
    expect(requests.every((request) => request.kind === 'question')).toBe(true);
    expect(calls.map((call) => call.call)).toEqual([
      'confirmUntrustedRepository',
      'configurationChanged',
      'configurationChanged',
      'configurationKindChanged',
      'filesMissing',
      'recreateContainer',
      'message',
    ]);
    expect(calls[2]).toEqual({ call: 'configurationChanged', args: ['acme/app', 'defaultImage'] });
    expect(calls.at(-1)).toEqual({ call: 'message', args: ['warn', 'careful'] });
  });

  it('reads the state of this computer and changes its records', async () => {
    const { worker, calls, requests } = wired({ get: DEVSPACE, list: [DEVSPACE], findForAccount: DEVSPACE, processAlive: false });
    expect(await worker.state.windowStatuses()).toEqual([STATUS]);
    expect(await worker.state.processAlive(42)).toBe(false);
    expect(await worker.records.get('e1')).toEqual(DEVSPACE);
    expect(await worker.records.list()).toEqual([DEVSPACE]);
    expect(await worker.records.findForAccount('acme/app', 'a1', '')).toEqual(DEVSPACE);
    // The source of the devspace reaches the records of this computer as the worker sends it.
    expect(await worker.records.findForAccount('acme/app', 'a1', '', { kind: 'defaultImage', image: 'ghcr.io/acme/base:latest' })).toEqual(DEVSPACE);
    expect(calls.filter((call) => call.call === 'findForAccount').map((call) => call.args)).toEqual([
      ['acme/app', 'a1', ''],
      ['acme/app', 'a1', '', { kind: 'defaultImage', image: 'ghcr.io/acme/base:latest' }],
    ]);
    await worker.records.remove('e1', { kept: ['v1'] });
    await worker.records.forgetKeptVolumes(['v1']);
    await worker.records.sessionFile('removePending', 'e1');
    // There is no `record add`, no `record update` and no `local settings`.
    expect(requests.map((request) => request.kind)).toEqual(['local', 'local', 'record', 'record', 'record', 'record', 'record', 'record', 'record']);
    expect(calls.filter((call) => call.call === 'processAlive')).toEqual([{ call: 'processAlive', args: [42] }]);
    expect(calls.at(-1)).toEqual({ call: 'sessionFile', args: ['removePending', 'e1'] });
  });

  // The account of the sign-in, its id and login only, and only when it has an id.
  it('reads the signed-in account, with the interactive flag, and nothing but its id and login', async () => {
    const { worker, calls, requests } = wired({ account: { id: '42', login: 'octo', accessToken: 'gho_x' } as unknown as GitHubAccount });
    expect(await worker.state.account(true)).toEqual({ id: '42', login: 'octo' });
    expect(calls).toEqual([{ call: 'account', args: [true] }]);
    expect(requests).toEqual([{ kind: 'local', call: 'account', args: [true] }]);
    expect(JSON.stringify(requests)).not.toContain('gho_x');
    const none = wired({ account: undefined });
    expect(await none.worker.state.account(false)).toBeUndefined();
    expect(none.calls).toEqual([{ call: 'account', args: [false] }]);
    // A flag that is no boolean is refused before this computer is touched.
    await expect(none.handler('local', { call: 'account', args: ['yes'] }, none.signal)).rejects.toMatchObject({ code: 'invalid' });
    await expect(none.handler('local', { call: 'account', args: [] }, none.signal)).rejects.toMatchObject({ code: 'invalid' });
    expect(none.calls).toHaveLength(1);
    // An answer without an id is no account (the worker side).
    for (const answer of [{ id: '' }, { login: 'octo' }, 'octo', 42]) {
      const odd = workerHostSide(async () => answer, () => undefined);
      expect(await odd.state.account(false)).toBeUndefined();
    }
    const noLogin = workerHostSide(async () => ({ id: '7' }), () => undefined);
    expect(await noLogin.state.account(false)).toEqual({ id: '7', login: '' });
    // Each side keeps only the id and the login.
    const { handler, signal } = wired({ account: { id: '42', login: 'octo', accessToken: 'gho_x' } as unknown as GitHubAccount });
    expect(await handler('local', { call: 'account', args: [true] }, signal)).toEqual({ value: { id: '42', login: 'octo' } });
    const extra = workerHostSide(async () => ({ id: '42', login: 'octo', accessToken: 'gho_x' }), () => undefined);
    expect(await extra.state.account(true)).toEqual({ id: '42', login: 'octo' });
  });

  it('gets a secret only through the secrets of the answer, never in its value', async () => {
    const { worker, requests, secrets } = wired({
      token: 'ghp_token_value',
      registry: { username: 'octo', serveraddress: 'ghcr.io', password: 'gho_secret' },
    });
    expect(await worker.secrets.token()).toBe('ghp_token_value');
    expect(await worker.secrets.registry('ghcr.io', 'octo/app')).toEqual({ username: 'octo', serveraddress: 'ghcr.io', password: 'gho_secret' });
    expect(secrets).toEqual({ [SECRET_TOKEN]: 'ghp_token_value', [SECRET_REGISTRY]: 'gho_secret' });
    expect(JSON.stringify(requests)).not.toContain('gho_secret');
  });

  it('gives undefined when this computer has no secret', async () => {
    const { worker, secrets, handler, signal } = wired();
    // Nothing but `given: false`.
    expect(await handler('secret', { call: 'token', args: [] }, signal)).toStrictEqual({ value: { given: false } });
    expect(await handler('secret', { call: 'registry', args: ['ghcr.io', 'octo/app'] }, signal)).toStrictEqual({ value: { given: false } });
    expect(await worker.secrets.token()).toBeUndefined();
    expect(await worker.secrets.registry('ghcr.io', 'octo/app')).toBeUndefined();
    expect(secrets).toEqual({});
  });

  it('passes an identity token on without a user', async () => {
    const { worker } = wired({ registry: { identityToken: true, serveraddress: 'reg.example', password: 'refresh-token' } });
    expect(await worker.secrets.registry('reg.example', 'team/app')).toEqual({ identityToken: true, serveraddress: 'reg.example', password: 'refresh-token' });
  });
});

describe('the handler of the requests on the side of the extension', () => {
  it('refuses a request that it does not know, or whose arguments do not fit', async () => {
    const { handler, signal, calls } = wired();
    for (const [kind, payload] of [
      ['question', { call: 'unknown', args: [] }],
      ['question', { call: 'confirmUntrustedRepository', args: [] }],
      ['question', { call: 'recreateContainer', args: ['acme/app', { message: 'm' }] }],
      ['question', { call: 'message', args: ['shout', 'x'] }],
      ['local', { call: 'processAlive', args: ['42'] }],
      ['local', { call: 'unknown', args: [] }],
      ['record', { call: 'add', args: ['not an object'] }],
      ['record', { call: 'forgetKeptVolumes', args: [[1]] }],
      ['record', { call: 'sessionFile', args: ['writeEverything', 'e1'] }],
      // Requests that do not exist are refused.
      ['local', { call: 'settings', args: [] }],
      ['record', { call: 'sessionFile', args: ['removeReopen', 'e1'] }],
      ['secret', { call: 'unknown', args: [] }],
      // `connect` is no request kind.
      ['connect', { call: 'connect', args: ['x'] }],
      ['question', { call: 'Bad-Call', args: [] }],
      ['question', { args: [] }],
      ['question', 'not an object'],
      // The types of the arguments, not only their number.
      ['record', { call: 'get', args: [['..', '..', 'etc']] }],
      ['record', { call: 'sessionFile', args: ['removePending', 42] }],
      ['question', { call: 'confirmUntrustedRepository', args: [{}] }],
      ...[0, -1, 1.5, Number.MAX_VALUE, null].map((pid) => ['local', { call: 'processAlive', args: [pid] }] as const),
      ['connect', { call: 'connect', args: [null] }],
      // What a record write may carry, and the registry of a sign-in hint.
      ['record', { call: 'add', args: [{ id: 'e1' }] }],
      ['record', { call: 'add', args: [[]] }],
      ...['id', 'owner', '__proto__', 'constructor'].map((key) => ['record', { call: 'update', args: ['e1', JSON.parse(`{"${key}": {}}`)] }] as const),
      ['record', { call: 'update', args: ['e1', ['x']] }],
      ['record', { call: 'remove', args: ['e1', { kept: 'name' }] }],
      ['record', { call: 'remove', args: ['e1', { removed: [1] }] }],
      ['record', { call: 'remove', args: ['e1', 'x'] }],
      ['question', { call: 'message', args: ['registrySignIn', 'not a host/at all'] }],
      ['record', { call: 'add', args: [{ owner: { id: 'a1' } }] }],
      ...['a:b:c', '.x', 'x:123456', 'x.', ''].map((registry) => ['question', { call: 'message', args: ['registrySignIn', registry] }] as const),
      ['question', { call: 'recreateContainer', args: ['acme/app', null] }],
      ['secret', { call: 'registry', args: [42] }],
    ] as const) {
      const thrown = await handler(kind as AskKind, payload, signal).catch((error: unknown) => error);
      expect((thrown as HelperOperationError).code, JSON.stringify(payload)).toBe('invalid');
    }
    expect(calls).toEqual([]);
  });

  it('answers `failed` with the message of a call that throws, and logs it', async () => {
    const lines: string[] = [];
    const { host } = fakeHost();
    host.records.get = async () => {
      throw new Error('the registry file is locked');
    };
    const handler = hostSideHandler(host, { ...silentLogger, warn: (text) => lines.push(text) }, ALL);
    const thrown = await handler('record', { call: 'get', args: ['e1'] }, new AbortController().signal).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(HelperOperationError);
    expect(thrown).toMatchObject({ code: 'failed', message: 'the registry file is locked' });
    expect(lines).toEqual(['The request record get of the worker failed: the registry file is locked']);
  });

  it('answers `cancelled` once the operation ended', async () => {
    const { handler, calls } = wired();
    const controller = new AbortController();
    controller.abort();
    // `local windowStatuses`.
    await expect(handler('local', { call: 'windowStatuses', args: [] }, controller.signal)).rejects.toMatchObject({ code: 'cancelled' });
    expect(calls).toEqual([]);
  });

  it('parseHostRequest takes a call name and an argument list, nothing else', () => {
    expect(parseHostRequest({ call: 'settings', args: [1, 'x'] }, 'local')).toEqual({ kind: 'local', call: 'settings', args: [1, 'x'] });
    for (const value of [null, 'x', [], { call: 'settings' }, { call: 1, args: [] }, { call: '', args: [] }, { call: 'a'.repeat(65), args: [] }, { call: 'x', args: {} }]) {
      expect(parseHostRequest(value, 'local'), JSON.stringify(value)).toBeUndefined();
    }
  });

  it('a question that the user dismisses comes back as undefined, not as null', async () => {
    const { worker } = wired({ filesMissing: undefined });
    expect(await worker.questions.filesMissing('acme/app')).toBeUndefined();
  });

  it('answers only the requests of the operation, and refuses the others before this computer is touched', async () => {
    const lines: string[] = [];
    const { handler, signal, calls } = wired({ token: 'ghp_token_value', get: DEVSPACE }, { ...silentLogger, warn: (text) => lines.push(text) }, FLOW_REQUESTS[OP_TOKEN_REMOVE]);
    expect(FLOW_REQUESTS[OP_TOKEN_REMOVE]).toEqual(['record get']);
    // Stop asks for nothing.
    expect(FLOW_REQUESTS[OP_STOP]).toEqual([]);
    // The listing reads the record and the account, nothing else.
    expect(FLOW_REQUESTS[OP_LIST_CONFIGURATIONS]).toEqual(['record get', 'local account']);
    for (const [kind, call] of [
      ['secret', 'token'],
      ['record', 'remove'],
      ['record', 'list'],
      ['question', 'message'],
    ] as const) {
      await expect(handler(kind, { call, args: [] }, signal)).rejects.toMatchObject({ code: 'invalid' });
    }
    expect(calls).toEqual([]);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('The worker sent the request secret token, which its operation may not send.');
    expect(await handler('record', { call: 'get', args: ['e1'] }, signal)).toEqual({ value: DEVSPACE });
    // An operation without requests sends none.
    const none = wired({}, silentLogger, []);
    await expect(none.handler('record', { call: 'get', args: ['e1'] }, none.signal)).rejects.toMatchObject({ code: 'invalid' });
    expect(none.calls).toEqual([]);
  });

  it('answers a secret only in `secrets`, never in the value', async () => {
    const { handler, signal } = wired({ token: 'ghp_token_value', registry: { username: 'octo', serveraddress: 'ghcr.io', password: 'gho_secret' } });
    expect(await handler('secret', { call: 'token', args: [] }, signal)).toEqual({ value: { given: true }, secrets: { [SECRET_TOKEN]: 'ghp_token_value' } });
    expect(await handler('secret', { call: 'registry', args: ['ghcr.io', 'octo/app'] }, signal)).toEqual({
      value: { given: true, username: 'octo', serveraddress: 'ghcr.io' },
      secrets: { [SECRET_REGISTRY]: 'gho_secret' },
    });
  });

  it('gives the refusals of the user and unexpected answers as the safe value', async () => {
    const refused = wired({ confirmUntrustedRepository: false, configurationChanged: 'later', configurationKindChanged: 'later', filesMissing: 'deleteDevspace', recreateContainer: false });
    expect(await refused.worker.questions.confirmUntrustedRepository('acme/app')).toBe(false);
    expect(await refused.worker.questions.configurationChanged('acme/app')).toBe('later');
    expect(await refused.worker.questions.configurationKindChanged('acme/app', 'm')).toBe('later');
    expect(await refused.worker.questions.filesMissing('acme/app')).toBe('deleteDevspace');
    expect(await refused.worker.questions.recreateContainer('acme/app', { message: 'm', detail: 'd' })).toBe(false);
    for (const odd of ['maybe', null, 1, 'true']) {
      const { worker } = wired({ confirmUntrustedRepository: odd, configurationChanged: odd, configurationKindChanged: odd, filesMissing: odd, recreateContainer: odd });
      expect(await worker.questions.confirmUntrustedRepository('acme/app')).toBe(false);
      expect(await worker.questions.configurationChanged('acme/app')).toBe('later');
      expect(await worker.questions.configurationKindChanged('acme/app', 'm')).toBe('later');
      expect(await worker.questions.filesMissing('acme/app')).toBeUndefined();
      expect(await worker.questions.recreateContainer('acme/app', { message: 'm', detail: 'd' })).toBe(false);
    }
  });

  // The question of the update of an existing container; the window words it after its own setting, the worker sends
  // only the repository of its operation and whether the container runs, and takes only a known answer.
  it('asks the update of a container for the repository of the operation only, and takes only a known answer', async () => {
    for (const answer of ['update', 'later', 'cancel'] as const) {
      for (const running of [true, false]) {
        const { worker, calls } = wired({ updateContainer: answer });
        expect(await worker.questions.updateContainer('acme/app', running)).toBe(answer);
        expect(calls).toEqual([{ call: 'updateContainer', args: ['acme/app', running] }]);
      }
    }
    for (const odd of ['Update Now', 'continue', null, 1, true, { answer: 'update' }]) {
      const { worker } = wired({ updateContainer: odd });
      expect(await worker.questions.updateContainer('acme/app', true), JSON.stringify(odd)).toBe('cancel');
    }
    const { host, calls } = fakeHost({ updateContainer: 'update' });
    const handler = hostSideHandler(host, silentLogger, FLOW_REQUESTS[OP_OPEN], { devspaceId: 'e1', repository: 'acme/app' });
    const signal = new AbortController().signal;
    for (const args of [
      [],
      ['acme/app'],
      ['acme/other', true],
      ['acme/app', 'true'],
      ['acme/app', 1],
      ['acme/app', null],
      ['acme/app', true, 'more'],
      [42, true],
      ['', true],
      ['acme/app\n', true],
      [{ repository: 'acme/app' }, true],
    ]) {
      const thrown = await handler('question', { call: 'updateContainer', args }, signal).catch((error: unknown) => error);
      expect((thrown as HelperOperationError).code, JSON.stringify(args)).toBe('invalid');
    }
    expect(calls).toEqual([]);
    // As the registry compares repositories: without case.
    expect(await handler('question', { call: 'updateContainer', args: ['Acme/App', false] }, signal)).toEqual({ value: 'update' });
    expect(calls).toEqual([{ call: 'updateContainer', args: ['Acme/App', false] }]);
    // Only the open asks it.
    for (const op of [OP_DELETE, OP_DELETE_CHECK, OP_STOP, OP_LIST_CONFIGURATIONS, OP_TOKEN_REMOVE]) expect(FLOW_REQUESTS[op], op).not.toContain('question updateContainer');
  });

  it('answers null for what this computer does not have, and clips the text of a message', async () => {
    const { handler, signal, calls } = wired();
    expect(await handler('record', { call: 'get', args: ['nope'] }, signal)).toEqual({ value: null });
    expect(await handler('record', { call: 'findForAccount', args: ['acme/app', 'a1', ''] }, signal)).toEqual({ value: null });
    expect(await handler('question', { call: 'filesMissing', args: ['acme/app'] }, signal)).toEqual({ value: null });
    await handler('question', { call: 'message', args: ['warn', 'x'.repeat(5000)] }, signal);
    await handler('question', { call: 'message', args: ['registrySignIn', 'registry.example:5000'] }, signal);
    expect(calls.filter((call) => call.call === 'message').map((call) => [call.args[0], (call.args[1] as string).length])).toEqual([
      ['warn', 2001],
      ['registrySignIn', 21],
    ]);
  });

  it('passes only the volumes of a removal', async () => {
    const { handler, signal, calls } = wired();
    await handler('record', { call: 'remove', args: ['e1', { kept: ['v1'], removed: ['v2'], other: 1 }] }, signal);
    // The removal of `e2` is refused: it is not the devspace of the operation.
    await expect(handler('record', { call: 'remove', args: ['e2'] }, signal)).rejects.toMatchObject({ code: 'invalid' });
    await handler('record', { call: 'remove', args: ['e1'] }, signal);
    expect(calls).toEqual([
      { call: 'remove', args: ['e1', { kept: ['v1'], removed: ['v2'] }] },
      { call: 'remove', args: ['e1', {}] },
    ]);
    // `record update` and `record add` are unknown to the handler; nothing reaches this computer.
    for (const payload of [{ call: 'update', args: ['e1', { lastUsedAt: 't' }] }, { call: 'add', args: [DEVSPACE] }]) {
      await expect(handler('record', payload, signal)).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('unknown') });
    }
    expect(calls).toHaveLength(2);
  });

  it('every request of a flow is one round trip', async () => {
    const ask = vi.fn(async () => ({ given: false }));
    const worker = workerHostSide(ask, () => undefined);
    await worker.secrets.token();
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('the worker side: what a missing or odd answer becomes', async () => {
    const answers = new Map<string, unknown>();
    const worker = workerHostSide(async (request) => answers.get(`${request.kind} ${request.call}`) ?? null, () => undefined);
    expect(await worker.records.get('nope')).toBeUndefined();
    expect(await worker.records.list()).toEqual([]);
    expect(await worker.state.windowStatuses()).toEqual([]);
    // A missing or odd answer counts as a running process (fail closed: another window keeps its devspace); only
    // `false` is an ended one.
    expect(await worker.state.processAlive(1)).toBe(true);
    answers.set('local processAlive', 'true');
    expect(await worker.state.processAlive(1)).toBe(true);
    answers.set('local processAlive', false);
    expect(await worker.state.processAlive(1)).toBe(false);
    // A login whose password the operation does not hold is no login; without its server the asked one.
    answers.set('secret registry', { given: true, username: 'octo' });
    expect(await worker.secrets.registry('ghcr.io', 'octo/app')).toBeUndefined();
    const held = workerHostSide(async () => ({ given: true, username: 'octo' }), (name) => (name === SECRET_REGISTRY ? 'pw' : undefined));
    expect(await held.secrets.registry('ghcr.io', 'octo/app')).toEqual({ username: 'octo', serveraddress: 'ghcr.io', password: 'pw' });
    const notGiven = workerHostSide(async () => ({ given: 'yes' }), () => 'pw');
    expect(await notGiven.secrets.registry('ghcr.io', 'octo/app')).toBeUndefined();
    expect(await notGiven.secrets.token()).toBeUndefined();
  });
});

// The busy marks and the removal of a reopen record as specific requests, and the requests that change a devspace
// only for the devspace of the operation.
describe('the requests of Delete', () => {
  const MARK = { operation: 'delete', since: '2026-10-04T10:00:00.000Z', pid: 7, windowId: 'w2' } as const;

  it('marks and clears the busy mark of the window that sent the operation, and removes its reopen record', async () => {
    const { worker, calls } = wired({ markBusy: { devspace: DEVSPACE } });
    expect(await worker.records.markBusy('e1', 'delete')).toEqual({ devspace: DEVSPACE });
    await worker.records.clearBusy('e1');
    await worker.records.sessionFile('removeReopenOf', 'e1');
    expect(calls).toEqual([
      { call: 'markBusy', args: ['e1', 'delete'] },
      { call: 'clearBusy', args: ['e1'] },
      { call: 'sessionFile', args: ['removeReopenOf', 'e1'] },
    ]);
  });

  it('gives the mark of another window as the conflict, and no entry as undefined', async () => {
    expect(await wired({ markBusy: { conflict: MARK } }).worker.records.markBusy('e1', 'delete')).toEqual({ conflict: MARK });
    expect(await wired({ markBusy: undefined }).worker.records.markBusy('e1', 'delete')).toBeUndefined();
  });

  it('refuses an unknown busy operation, and the requests for another devspace than the one of the operation', async () => {
    const lines: string[] = [];
    const { handler, signal, calls } = wired({}, { ...silentLogger, warn: (text) => lines.push(text) });
    for (const [call, args] of [
      ['markBusy', ['e1', 'stop']],
      ['markBusy', ['e2', 'delete']],
      ['clearBusy', ['e2']],
      ['sessionFile', ['removeReopenOf', 'e2']],
      // `record configuration` is scoped.
      ['configuration', ['e2', { cloned: true }]],
    ] as const) {
      await expect(handler('record', { call, args: [...args] }, signal), `${call} ${JSON.stringify(args)}`).rejects.toMatchObject({ code: 'invalid' });
    }
    expect(calls).toEqual([]);
    expect(lines.filter((line) => line.includes('another devspace'))).toHaveLength(4);
    // An operation without a devspace changes none.
    const { host } = fakeHost();
    const unscoped = hostSideHandler(host, silentLogger, ALL);
    await expect(unscoped('record', { call: 'clearBusy', args: ['e1'] }, signal)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('the worker never takes an odd answer of the busy mark as "not busy"', async () => {
    for (const odd of [{}, { devspace: { id: 'e2' } }, { conflict: { operation: 'stop', since: 't', pid: 1, windowId: 'w' } }, { devspace: DEVSPACE, conflict: MARK }, 'x', 1]) {
      await expect(parseBusyMarkAnswerOf(odd), JSON.stringify(odd)).rejects.toThrow('invalid value');
    }
    expect(parseBusyMarkAnswer(null, 'e1')).toBeUndefined();
  });

  // `record read` (the volumes of the other devspaces), the busy mark for `delete` only, and only the session files
  // of Delete.
  it('Delete may send only its requests, its busy mark for delete only, and only its session files', async () => {
    expect(FLOW_REQUESTS[OP_DELETE]).toEqual([
      'record get',
      'record list',
      'record read',
      'local account',
      'record markBusy.delete',
      'record clearBusy',
      'record remove',
      'record sessionFile.removePending',
      'record sessionFile.removeOperation',
      'record sessionFile.removeDisconnectRequest',
      'record sessionFile.removeReopenOf',
    ]);
    const { handler, signal, calls } = wired({ markBusy: { devspace: DEVSPACE } }, silentLogger, FLOW_REQUESTS[OP_DELETE]);
    await handler('record', { call: 'markBusy', args: ['e1', 'delete'] }, signal);
    await handler('record', { call: 'sessionFile', args: ['removeReopenOf', 'e1'] }, signal);
    await handler('record', { call: 'read', args: [] }, signal);
    for (const [call, args] of [
      ['markBusy', ['e1', 'update']],
      ['sessionFile', ['removeReopen', 'e1']],
      ['sessionFile', ['writePending', 'e1']],
      ['sessionFile', [1, 'e1']],
      ['update', ['e1', { lastUsedAt: 't' }]],
    ] as const) {
      await expect(handler('record', { call, args: [...args] }, signal), `${call} ${JSON.stringify(args)}`).rejects.toMatchObject({ code: 'invalid' });
    }
    expect(calls.map((call) => call.call)).toEqual(['markBusy', 'sessionFile', 'read']);
    // A detail is the whole kind, never a prefix of it.
    await expect(handler('record', { call: 'sessionFile', args: ['removePending.x', 'e1'] }, signal)).rejects.toMatchObject({ code: 'invalid' });
    await expect(handler('record', { call: 'markBusy', args: ['e1', 'delete.x'] }, signal)).rejects.toMatchObject({ code: 'invalid' });
    // The bare allowance allows every kind of the request.
    const bare = wired({}, silentLogger, ['record sessionFile']);
    await bare.handler('record', { call: 'sessionFile', args: ['writePending', 'e1'] }, bare.signal);
    expect(bare.calls).toEqual([{ call: 'sessionFile', args: ['writePending', 'e1'] }]);
  });
});

async function parseBusyMarkAnswerOf(value: unknown): Promise<unknown> {
  return parseBusyMarkAnswer(value, 'e1');
}

// The questions of Delete and the Git state, checked before this computer is touched.
describe('the requests of the check of Delete', () => {
  // The changes are counts.
  const CONFIRMATION = { changes: { uncommittedFiles: 2, unpushedCommits: 0 }, recordedAt: '2026-10-04T10:00:00.000Z', lastSeenInUse: '2026-10-04T09:00:00.000Z', repositoryData: ['data/db'], otherWindow: false };
  const SUMMARY = { branch: 'main', uncommittedFiles: 2, unpushedCommits: 0, stashes: 0, recordedAt: '2026-10-04T10:00:00.000Z' };

  it('asks the questions of Delete with their facts, and answers with the answer of the user', async () => {
    const { worker, calls } = wired({ confirmDelete: 'open', deleteAdditionalVolumes: 'keep', deleteServiceData: ['api-db'] });
    expect(await worker.questions.confirmDelete('Acme/API', CONFIRMATION)).toBe('open');
    expect(await worker.questions.deleteAdditionalVolumes(['api-cache'])).toBe('keep');
    expect(await worker.questions.deleteServiceData(['api-db', 'api-x'], ['api-x'])).toEqual(['api-db']);
    await worker.records.recordGitSummary('e1', SUMMARY as never);
    expect(calls).toEqual([
      { call: 'confirmDelete', args: ['Acme/API', CONFIRMATION] },
      { call: 'deleteAdditionalVolumes', args: [['api-cache']] },
      { call: 'deleteServiceData', args: [['api-db', 'api-x'], ['api-x']] },
      { call: 'recordGitSummary', args: ['e1', SUMMARY] },
    ]);
  });

  it('a dismissed question, or an answer that is not one, is cancel on the side of the worker', async () => {
    expect(await wired({ confirmDelete: undefined }).worker.questions.confirmDelete('r', CONFIRMATION)).toBeUndefined();
    expect(await wired({ confirmDelete: 'yes' }).worker.questions.confirmDelete('r', CONFIRMATION)).toBeUndefined();
    expect(await wired({ deleteAdditionalVolumes: 'all' }).worker.questions.deleteAdditionalVolumes(['v'])).toBeUndefined();
    // A volume that was not offered makes the whole answer invalid (cancel).
    expect(await wired({ deleteServiceData: ['other'] }).worker.questions.deleteServiceData(['v'], [])).toBeUndefined();
    expect(await wired({ deleteServiceData: undefined }).worker.questions.deleteServiceData(['v'], [])).toBeUndefined();
  });

  it('refuses facts and Git states that do not fit, before this computer is touched', async () => {
    const { handler, signal, calls } = wired();
    for (const [kind, call, args] of [
      ['question', 'confirmDelete', ['r', { ...CONFIRMATION, changes: '0 uncommitted, all pushed' }]],
      ['question', 'confirmDelete', ['r', { ...CONFIRMATION, changes: { uncommittedFiles: -1, unpushedCommits: 0 } }]],
      ['question', 'confirmDelete', ['r', { ...CONFIRMATION, changes: { uncommittedFiles: 1.5, unpushedCommits: 0 } }]],
      ['question', 'confirmDelete', ['a\nb', CONFIRMATION]],
      ['question', 'confirmDelete', ['', CONFIRMATION]],
      ['question', 'confirmDelete', ['r', { ...CONFIRMATION, otherWindow: 'no' }]],
      ['question', 'confirmDelete', ['r', { ...CONFIRMATION, recordedAt: 'a\nb' }]],
      ['question', 'confirmDelete', ['r', { ...CONFIRMATION, repositoryData: [''] }]],
      ['question', 'confirmDelete', ['r', { ...CONFIRMATION, repositoryData: 'data' }]],
      // Folders of normal length, without `..`.
      ['question', 'confirmDelete', ['r', { ...CONFIRMATION, repositoryData: ['../../etc'] }]],
      ['question', 'confirmDelete', ['r', { ...CONFIRMATION, repositoryData: ['d'.repeat(256)] }]],
      ['question', 'confirmDelete', ['r', null]],
      ['question', 'deleteAdditionalVolumes', [['../x']]],
      ['question', 'deleteServiceData', [['v'], 'v']],
      ['record', 'recordGitSummary', ['e1', { branch: 'main' }]],
      ['record', 'recordGitSummary', ['e2', SUMMARY]],
    ] as const) {
      await expect(handler(kind, { call, args: [...args] }, signal), `${call} ${JSON.stringify(args)}`).rejects.toMatchObject({ code: 'invalid' });
    }
    expect(calls).toEqual([]);
  });

  it('the check of Delete may send only its requests', () => {
    expect(FLOW_REQUESTS[OP_DELETE_CHECK]).toEqual([
      'record get',
      'record read',
      'local account',
      'record recordGitSummary',
      'question confirmDelete',
      'question deleteAdditionalVolumes',
      'question deleteServiceData',
    ]);
  });
});

// The questions name the repository of the operation, and each answer of the user is observed by the extension.
describe('the questions of a flow name its repository, and their answers are observed', () => {
  it('refuses a confirmation of another repository than the one of the operation, and observes each answer', async () => {
    const { host, calls } = fakeHost({ confirmDelete: 'delete' });
    const observed: unknown[] = [];
    const handler = hostSideHandler(host, silentLogger, ALL, { devspaceId: 'e1', repository: 'acme/api', onAnswer: (call, args, value) => observed.push([call, args, value]) });
    const signal = new AbortController().signal;
    const confirmation = { repositoryData: [], otherWindow: false };
    await expect(handler('question', { call: 'confirmDelete', args: ['acme/other', confirmation] }, signal)).rejects.toMatchObject({ code: 'invalid' });
    expect(calls).toEqual([]);
    await handler('question', { call: 'confirmDelete', args: ['acme/api', confirmation] }, signal);
    expect(observed).toEqual([['confirmDelete', ['acme/api', confirmation], 'delete']]);
    // Each question is announced and settled, also one that fails.
    const states: string[] = [];
    const tracked = hostSideHandler(host, silentLogger, ALL, { devspaceId: 'e1', repository: 'acme/api', onQuestion: (state) => states.push(state) });
    await tracked('question', { call: 'confirmDelete', args: ['acme/api', confirmation] }, signal);
    await expect(tracked('question', { call: 'deleteAdditionalVolumes', args: [['../x']] }, signal)).rejects.toMatchObject({ code: 'invalid' });
    await tracked('record', { call: 'get', args: ['e1'] }, signal);
    expect(states).toEqual(['asked', 'settled', 'asked', 'settled']);
    // A question whose arguments are refused is not observed.
    await expect(handler('question', { call: 'deleteAdditionalVolumes', args: [['../x']] }, signal)).rejects.toMatchObject({ code: 'invalid' });
    expect(observed).toHaveLength(1);
  });
});

describe('the remembered check result of the configuration', () => {
  const ENTRY = {
    key: 'a'.repeat(64),
    config: { image: 'node:20' },
    merged: { image: 'node:20', remoteUser: 'node' },
    analyses: [{ job: 'b'.repeat(64), result: { report: { hostAccess: [], unsupported: [] }, imageReferences: [{ what: 'image', reference: 'node:20' }], references: { images: ['node:20'], features: [] } } }],
  };

  it('asks and offers only for the devspace of the operation, on its Docker host; the worker reads an invalid answer as none', async () => {
    const scoped = (answer: unknown) => {
      const { host, calls } = fakeHost({ configCheck: answer });
      const handler = hostSideHandler(host, silentLogger, FLOW_REQUESTS[OP_OPEN], { devspaceId: 'e1', dockerHost: 'ssh://devspace' });
      const signal = new AbortController().signal;
      const worker = workerHostSide(
        async (request) => (JSON.parse(JSON.stringify({ value: (await handler(request.kind, { call: request.call, args: request.args }, signal)).value })) as { value?: unknown }).value,
        () => undefined,
      );
      return { worker, calls };
    };
    const { worker, calls } = scoped(ENTRY);
    expect(await worker.records.configCheck('e1')).toEqual(ENTRY);
    await worker.records.rememberConfigCheck('e1', ENTRY as never);
    expect(calls).toEqual([
      { call: 'configCheck', args: ['e1', { dockerHost: 'ssh://devspace' }] },
      { call: 'rememberConfigCheck', args: ['e1', ENTRY, { dockerHost: 'ssh://devspace' }] },
    ]);
    await expect(worker.records.configCheck('e2')).rejects.toThrow();
    await expect(worker.records.rememberConfigCheck('e2', ENTRY as never)).rejects.toThrow();
    for (const odd of [{ ...ENTRY, key: 'short' }, { ...ENTRY, extra: 1 }, 'entry', 42]) {
      expect(await scoped(odd).worker.records.configCheck('e1'), JSON.stringify(odd)).toBeUndefined();
    }
  });

  it('refuses an offered entry that is not a valid check result that passed, before this computer is touched', async () => {
    const { host, calls } = fakeHost();
    const handler = hostSideHandler(host, silentLogger, FLOW_REQUESTS[OP_OPEN], { devspaceId: 'e1', dockerHost: 'ssh://devspace' });
    const signal = new AbortController().signal;
    const refused = { ...ENTRY.analyses[0], result: { ...ENTRY.analyses[0].result, report: { hostAccess: ['privileged'], unsupported: [] } } };
    for (const args of [
      ['e1'],
      ['e1', ENTRY, 'more'],
      ['e1', { ...ENTRY, key: 'x' }],
      ['e1', { ...ENTRY, analyses: [refused] }],
      ['e1', { ...ENTRY, analyses: [ENTRY.analyses[0], ENTRY.analyses[0], ENTRY.analyses[0]] }],
      ['e1', { ...ENTRY, config: [] }],
      ['e1', null],
    ]) {
      const thrown = await handler('record', { call: 'rememberConfigCheck', args }, signal).catch((error: unknown) => error);
      expect((thrown as HelperOperationError).code, JSON.stringify(args).slice(0, 80)).toBe('invalid');
    }
    expect(calls).toEqual([]);
  });
});
