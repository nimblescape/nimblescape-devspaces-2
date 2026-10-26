// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The operation of the check of Delete (deleteCheckOperation) in detail.
import { describe, expect, it } from 'vitest';
import { OP_DELETE_CHECK, type AskKind } from '../core/helperChannel/protocol';
import { LABEL_DEVSPACE_ID } from '../core/names';
import { silentLogger } from '../core/ports';
import type { Devspace } from '../core/types';
import type { DockerEngine } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import { FLOW_REQUESTS, type HostSide } from '../core/worker/hostSide';
import { hostSideHandler } from '../core/worker/hostSideHandler';
import type { OwnHelper } from '../core/worker/ownHelper';
import { deleteCheckOperation } from './flowOperations';
import { contextSecrets } from './operationContext.testkit';
import type { OperationContext } from './server';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const NAME = 'devspaces-acme-api-brave-noether';
const DEVSPACE = {
  id: ID,
  repository: 'acme/api',
  owner: { id: '42', login: 'octo' },
  volumeName: NAME,
  containerName: NAME,
  configPath: '.devcontainer/devcontainer.json',
  createdAt: '2026-10-01T00:00:00.000Z',
  lastUsedAt: '2026-10-01T00:00:00.000Z',
} as unknown as Devspace;
const OWN: OwnHelper = { image: { tag: 'devspaces-worker:abc', id: `sha256:${'a'.repeat(64)}` }, socket: '/run/user/1000/docker.sock' };
const PARAMS = { devspaceId: ID, dockerHost: '', owner: { windowId: 'window-1', pid: 4242 }, repository: 'Acme/API', otherWindow: true };

interface Setup {
  record?: Devspace;
  account?: unknown;
  secrets?: Record<string, string>;
  onConfirm?: (controller: AbortController) => void;
  ownHelper?: (controller: AbortController) => Promise<OwnHelper>;
}

function run(setup: Setup = {}, params: Record<string, unknown> = {}) {
  const record = setup.record ?? DEVSPACE;
  const controller = new AbortController();
  const progress: unknown[][] = [];
  const answers: Record<string, unknown> = { get: record, read: { version: 1, devspaces: [record] }, account: setup.account ?? { id: '42', login: 'octo' } };
  const answer = (call: string) => async () => (call === 'confirmDelete' ? (setup.onConfirm?.(controller), 'delete') : answers[call]);
  const of = (_kind: AskKind, calls: string[]) => Object.fromEntries(calls.map((call) => [call, answer(call)]));
  const host = {
    records: of('record', ['get', 'read', 'recordGitSummary']),
    state: of('local', ['account']),
    questions: of('question', ['confirmDelete', 'deleteAdditionalVolumes', 'deleteServiceData']),
  } as unknown as HostSide;
  const handler = hostSideHandler(host, silentLogger, FLOW_REQUESTS[OP_DELETE_CHECK], { devspaceId: ID });
  const context: OperationContext = {
    signal: controller.signal,
    ...contextSecrets(setup.secrets ?? {}, async (kind, payload) => (await handler(kind, payload, new AbortController().signal)).value),
    progress: (...args: unknown[]) => void progress.push(args),
    log: () => {},
    output: () => {},
  } as unknown as OperationContext;
  const engine: DockerEngine = {
    ...unusedEngine(),
    version: async () => ({ apiVersion: '1.48', version: '29.0.0' }),
    containers: async () => [],
    container: async () => undefined,
    inspect: async (kind, reference) => (kind === 'volume' && reference === NAME ? { Name: NAME, Labels: { [LABEL_DEVSPACE_ID]: ID } } : undefined),
  };
  const operation = deleteCheckOperation(
    () => engine,
    setup.ownHelper ? () => setup.ownHelper!(controller) : async () => OWN,
    async () => {
      throw new Error('no batch helper');
    },
  );
  return { result: operation({ ...PARAMS, ...params }, context), progress, controller };
}

describe('deleteCheckOperation in detail', () => {
  it('takes no secret', async () => {
    await expect(run({ secrets: { token: 'gho_x' } }).result).rejects.toMatchObject({ code: 'invalid' });
  });

  it('reports its progress with the devspace', async () => {
    const { result, progress } = run();
    await result;
    expect(progress).toContainEqual(['deleteCheck', ID]);
  });

  it('a cancel while the user answers cancels the operation', async () => {
    await expect(run({ onConfirm: (controller) => controller.abort() }).result).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('a refusal of the pipeline (another account) is answered as the refusal', async () => {
    expect(await run({ account: { id: '99', login: 'other' } }).result).toMatchObject({ refused: { code: 'otherAccount' } });
  });

  it('runs on the Docker host of the parameters', async () => {
    const remote = { ...DEVSPACE, dockerHost: 'build-box' } as Devspace;
    expect(await run({ record: remote }, { dockerHost: 'build-box' }).result).toEqual({ decision: 'delete', additionalVolumesToRemove: [] });
  });

  it('a helper that cannot be read after the cancel is the cancellation', async () => {
    const ownHelper = async (controller: AbortController) => {
      controller.abort();
      throw new Error('gone');
    };
    await expect(run({ ownHelper }).result).rejects.toMatchObject({ code: 'cancelled' });
  });
});
