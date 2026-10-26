// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The devspace of the window at its activation, with the restore of a lost registry by the worker within
// WINDOW_RESTORE_TIMEOUT_MS, and the restore again after the build of the helper image.
import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../core/ports';
import type { Devspace } from '../core/types';
import { resourceName } from '../core/names';
import { LOCAL_DOCKER_TARGET, dockerTargetOf } from '../core/docker/dockerHost';
import { operationDockerTarget } from '../core/docker/dockerTargets';
import type { RunResult } from '../core/ports';
import {
  WINDOW_RESTORE_TIMEOUT_MS,
  backgroundEngineAtStart,
  backgroundWorkAtStart,
  containerDevspace,
  findWindowDevspace,
  removedEngineWindowDevspace,
  restoreAfterPrebuild,
  windowDevspaceName,
} from './windowDevspace';

const ENTRY = { id: 'e1', containerName: 'devspaces-acme-api-x' } as Devspace;

function deps(options: { found?: Devspace[]; needsRestore?: boolean; installed?: boolean; added?: number | Error } = {}) {
  const found = [...(options.found ?? [])];
  const errors: string[] = [];
  const warnings: string[] = [];
  const all = {
    registry: { findByContainerName: vi.fn(async () => found.shift()) },
    needsRestore: vi.fn(async () => options.needsRestore ?? true),
    docker: { isInstalled: () => options.installed ?? true },
    service: {
      reconcileInWorker: vi.fn(async (_options: { passive: boolean; signal?: AbortSignal }) => {
        if (options.added instanceof Error) throw options.added;
        return options.added ?? 0;
      }),
    },
    logger: { ...silentLogger, error: (text: string) => errors.push(text), warn: (text: string) => warnings.push(text) },
  };
  return { all, errors, warnings };
}

describe('the devspace of the window at its activation', () => {
  it('the registry knows it: no restore', async () => {
    const { all } = deps({ found: [ENTRY] });
    expect(await findWindowDevspace('devspaces-acme-api-x', all)).toBe(ENTRY);
    expect(all.service.reconcileInWorker).not.toHaveBeenCalled();
  });

  it('a lost registry is restored by the worker, passively and within the time limit of the activation', async () => {
    const { all } = deps({ found: [undefined as unknown as Devspace, ENTRY], added: 1 });
    expect(await findWindowDevspace('devspaces-acme-api-x', all)).toBe(ENTRY);
    const [options] = all.service.reconcileInWorker.mock.calls[0];
    expect(options.passive).toBe(true);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(WINDOW_RESTORE_TIMEOUT_MS).toBe(30_000);
  });

  it('nothing restored, a valid registry, or no Docker: no devspace', async () => {
    const none = deps({ added: 0 });
    expect(await findWindowDevspace('c', none.all)).toBeUndefined();
    // Read again also when nothing was added.
    expect(none.all.registry.findByContainerName).toHaveBeenCalledTimes(2);
    const valid = deps({ needsRestore: false });
    expect(await findWindowDevspace('c', valid.all)).toBeUndefined();
    expect(valid.all.service.reconcileInWorker).not.toHaveBeenCalled();
    const noDocker = deps({ installed: false });
    expect(await findWindowDevspace('c', noDocker.all)).toBeUndefined();
    expect(noDocker.all.service.reconcileInWorker).not.toHaveBeenCalled();
  });

  it('restores nothing when the activation may not (before the first use of Devspaces)', async () => {
    const { all } = deps({ found: [undefined as unknown as Devspace, ENTRY], added: 1 });
    expect(await findWindowDevspace('other-container', { ...all, mayRestore: false })).toBeUndefined();
    expect(all.needsRestore).not.toHaveBeenCalled();
    expect(all.service.reconcileInWorker).not.toHaveBeenCalled();
    expect(all.registry.findByContainerName).toHaveBeenCalledTimes(1);
    // The registry is still read: a known container is found.
    const known = deps({ found: [ENTRY] });
    expect(await findWindowDevspace('devspaces-acme-api-x', { ...known.all, mayRestore: false })).toBe(ENTRY);
    // `mayRestore` true restores, as when it is not given.
    const allowed = deps({ found: [undefined as unknown as Devspace, ENTRY], added: 1 });
    expect(await findWindowDevspace('devspaces-acme-api-x', { ...allowed.all, mayRestore: true })).toBe(ENTRY);
    expect(allowed.all.service.reconcileInWorker).toHaveBeenCalledTimes(1);
  });

  // An engine with the removal mark: the check runs only for a lost registry, and its false restores nothing.
  it('restores nothing when the check of the restore says no, and asks it only for a lost registry', async () => {
    const refused = deps({ found: [undefined as unknown as Devspace, ENTRY], added: 1 });
    const onRemovedEngine = vi.fn(async () => false);
    expect(await findWindowDevspace('devspaces-acme-api-x', { ...refused.all, mayRestore: onRemovedEngine })).toBeUndefined();
    expect(onRemovedEngine).toHaveBeenCalledTimes(1);
    expect(refused.all.service.reconcileInWorker).not.toHaveBeenCalled();
    const allowed = deps({ found: [undefined as unknown as Devspace, ENTRY], added: 1 });
    expect(await findWindowDevspace('devspaces-acme-api-x', { ...allowed.all, mayRestore: async () => true })).toBe(ENTRY);
    expect(allowed.all.service.reconcileInWorker).toHaveBeenCalledTimes(1);
    // A known container, or a valid registry: not asked.
    const check = vi.fn(async () => true);
    expect(await findWindowDevspace('devspaces-acme-api-x', { ...deps({ found: [ENTRY] }).all, mayRestore: check })).toBe(ENTRY);
    expect(await findWindowDevspace('c', { ...deps({ needsRestore: false }).all, mayRestore: check })).toBeUndefined();
    expect(check).not.toHaveBeenCalled();
  });

  it('does the Docker work at the start after the first use, and in the window of a devspace container', () => {
    expect(backgroundWorkAtStart(true, undefined)).toBe(true);
    expect(backgroundWorkAtStart(true, 'my-dev-container')).toBe(true);
    // Before the first use: only a container of a devspace, also one of a Docker Compose service, in any case.
    expect(backgroundWorkAtStart(false, undefined)).toBe(false);
    expect(backgroundWorkAtStart(false, 'my-dev-container')).toBe(false);
    expect(backgroundWorkAtStart(false, 'vsc-api-0123456789abcdef')).toBe(false);
    expect(backgroundWorkAtStart(false, resourceName('acme/api', '11111111-2222-4333-8444-555555555555', 'default'))).toBe(true);
    expect(backgroundWorkAtStart(false, 'devspaces-majikmate-module-html-css-2-x-app-1')).toBe(true);
    expect(backgroundWorkAtStart(false, 'Devspaces-Acme-Api-x')).toBe(true);
    expect(backgroundWorkAtStart(false, 'my-devspaces-x')).toBe(false);
  });

  // "Remove Devspaces from This Docker Engine…": until a flow of the user there, nothing runs there by itself.
  it('does the Docker work at the start on the current engine, unless Devspaces was removed from it', async () => {
    const remote = dockerTargetOf('ssh://build-box', 'devspaces-build-box');
    const lines: string[] = [];
    const logger = { ...silentLogger, info: (line: string) => void lines.push(line) };
    const removed = vi.fn(async (target: { host: string }) => target.host === 'build-box');
    expect(await backgroundEngineAtStart({ current: async () => LOCAL_DOCKER_TARGET, removed, logger })).toBe(LOCAL_DOCKER_TARGET);
    expect(lines).toEqual([]);
    expect(await backgroundEngineAtStart({ current: async () => remote, removed, logger })).toBeUndefined();
    expect(removed).toHaveBeenLastCalledWith(remote);
    expect(lines).toEqual([
      'No Docker work in the background at the start: Devspaces was removed from build-box. Nothing runs there by itself until a Start, a Rebuild or "Update All Images Now" there.',
    ]);
  });

  it('a restore that fails or times out never fails the activation (logged)', async () => {
    const { all, errors, warnings } = deps({ added: new Error('The operation was aborted due to timeout') });
    expect(await findWindowDevspace('c', all)).toBeUndefined();
    // A failed restore is a warning, and the registry is read again.
    expect(errors).toEqual([]);
    expect(warnings).toEqual(['The devspaces could not be restored from the volumes while this window started: The operation was aborted due to timeout']);
    expect(all.registry.findByContainerName).toHaveBeenCalledTimes(2);
  });

  it('finds the entry that the restore added before its time limit ended', async () => {
    const { all } = deps({ found: [undefined as unknown as Devspace, ENTRY], added: new Error('The operation was aborted due to timeout') });
    expect(await findWindowDevspace('devspaces-acme-api-x', all)).toBe(ENTRY);
  });

  it('finds the entry that another window restored first, when this restore added none', async () => {
    const { all } = deps({ found: [undefined as unknown as Devspace, ENTRY], added: 0 });
    expect(await findWindowDevspace('devspaces-acme-api-x', all)).toBe(ENTRY);
  });

  it('an unreadable registry never fails the activation (logged)', async () => {
    const { all, errors } = deps();
    all.registry.findByContainerName.mockRejectedValue(new Error('EACCES'));
    expect(await findWindowDevspace('c', all)).toBeUndefined();
    expect(errors).toEqual(['The devspace of this window could not be found.']);
  });

  it('the restore runs again once the background preparation ended with a helper image', async () => {
    for (const outcome of ['unsupported', 'dockerNotRunning', 'failed', 'cancelled'] as const) {
      const restore = vi.fn(async () => {});
      await restoreAfterPrebuild(outcome, restore);
      expect(restore, outcome).not.toHaveBeenCalled();
    }
    // Also `present` and `notDue`, not only `built`.
    for (const outcome of ['built', 'present', 'notDue'] as const) {
      const restore = vi.fn(async () => {});
      await restoreAfterPrebuild(outcome, restore);
      expect(restore, outcome).toHaveBeenCalledTimes(1);
    }
  });
});

describe('the name of the devspace of the window, for the names of its workers', () => {
  const ID = '11111111-2222-4333-8444-555555555555';
  // A Docker Compose devspace of the configuration `python`: its container is named by Compose, its volume is its
  // resource name.
  const devspace = {
    id: ID,
    repository: 'majikmate/module-html-css-2',
    volumeName: resourceName('majikmate/module-html-css-2', ID, 'python'),
    containerName: 'devspaces-majikmate-module-html-css-2-x-app-1',
  } as Devspace;
  const remote = { ...devspace, dockerHost: 'build-box' } as Devspace;
  const old = { ...devspace, volumeName: resourceName('majikmate/module-html-css-2', ID), containerName: resourceName('majikmate/module-html-css-2', ID) } as Devspace;

  it('is the resource name of the devspace of the attached container on its engine (with the word of its source), also of Docker Compose', async () => {
    const registry = { findByContainerName: vi.fn(async () => devspace) };
    expect(await windowDevspaceName(devspace.containerName, '', registry)).toBe(resourceName(devspace.repository, ID, 'python'));
    expect(registry.findByContainerName).toHaveBeenCalledWith(devspace.containerName);
    expect(await windowDevspaceName(remote.containerName, 'build-box', { findByContainerName: async () => remote })).toBe(resourceName(devspace.repository, ID, 'python'));
    // A devspace of version 0.5.0 or older: its name has no word of its source.
    expect(await windowDevspaceName(old.containerName, '', { findByContainerName: async () => old })).toBe(resourceName(devspace.repository, ID));
  });

  it('is undefined on another engine, for a window of no container, and for a container that the registry does not know', async () => {
    expect(await windowDevspaceName(devspace.containerName, 'build-box', { findByContainerName: async () => devspace })).toBeUndefined();
    expect(await windowDevspaceName(remote.containerName, '', { findByContainerName: async () => remote })).toBeUndefined();
    const registry = { findByContainerName: vi.fn(async () => undefined) };
    expect(await windowDevspaceName(undefined, '', registry)).toBeUndefined();
    expect(registry.findByContainerName).not.toHaveBeenCalled();
    expect(await windowDevspaceName('other', '', registry)).toBeUndefined();
  });
});

// After a lost registry on an engine with the removal mark, nothing is restored there; the labels of the container of
// the window still give its devspace and owner, for the account rule.
describe('the devspace of the window by the labels of its container', () => {
  const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
  const CONTAINER = 'devspaces-acme-api-3f2a9c1e';
  const LABELS = {
    'nimblescape.devspaces.id': ID,
    'nimblescape.devspaces.repository': 'acme/api',
    'nimblescape.devspaces.owner-id': '1001',
    'nimblescape.devspaces.config-path': '.devcontainer/python/devcontainer.json',
    'devcontainer.local_folder': '/tmp/x',
  };
  const answer = (result: Partial<RunResult>): RunResult => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, ...result });
  const labelsOf = (labels: unknown) => ({ run: vi.fn(async () => answer({ stdout: `${JSON.stringify(labels)}\n` })) });
  const NOW = '2026-10-16T08:00:00.000Z';

  it('makes an entry of the labels, on the host of the call, with one plain inspect', async () => {
    const docker = labelsOf(LABELS);
    expect(await containerDevspace(CONTAINER, { docker, host: 'build-box', now: NOW })).toEqual({
      kind: 'devspace',
      devspace: {
        id: ID,
        repository: 'acme/api',
        configPath: '.devcontainer/python/devcontainer.json',
        volumeName: CONTAINER,
        containerName: CONTAINER,
        createdAt: NOW,
        lastUsedAt: NOW,
        owner: { id: '1001', login: '' },
        dockerHost: 'build-box',
      },
    });
    expect(docker.run.mock.calls).toEqual([[['container', 'inspect', '--format', '{{json .Config.Labels}}', CONTAINER], { timeoutMs: 60_000 }]]);
    // The local Docker has no host field; a configuration path that is not valid is the default one.
    const local = await containerDevspace(CONTAINER, { docker: labelsOf({ ...LABELS, 'nimblescape.devspaces.config-path': '../x.json' }), host: '', now: NOW, timeoutMs: 5 });
    expect(local).toEqual({ kind: 'devspace', devspace: expect.objectContaining({ configPath: '.devcontainer/devcontainer.json' }) });
    expect(local.kind === 'devspace' && 'dockerHost' in local.devspace).toBe(false);
  });

  it('is none for a container that the engine does not have, one of no devspace, and another container of a Compose devspace', async () => {
    const missing = { run: vi.fn(async () => answer({ exitCode: 1, stderr: `Error: No such container: ${CONTAINER}\n` })) };
    expect(await containerDevspace(CONTAINER, { docker: missing, host: '', now: NOW })).toEqual({ kind: 'none' });
    expect(await containerDevspace(CONTAINER, { docker: labelsOf({ 'devcontainer.local_folder': '/tmp/x' }), host: '', now: NOW })).toEqual({ kind: 'none' });
    expect(await containerDevspace(CONTAINER, { docker: labelsOf(null), host: '', now: NOW })).toEqual({ kind: 'none' });
    expect(await containerDevspace(CONTAINER, { docker: labelsOf({ ...LABELS, 'nimblescape.devspaces.compose-service': 'db' }), host: '', now: NOW })).toEqual({ kind: 'none' });
  });

  it('cannot read the owner when the inspect fails or a label is missing or not valid; it names the devspace when it can', async () => {
    const failed = { run: vi.fn(async () => answer({ exitCode: 1, stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.\n' })) };
    expect(await containerDevspace(CONTAINER, { docker: failed, host: '', now: NOW })).toEqual({
      kind: 'unreadable',
      reason: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.',
    });
    const late = { run: vi.fn(async () => answer({ exitCode: -1, timedOut: true })) };
    expect(await containerDevspace(CONTAINER, { docker: late, host: '', now: NOW })).toEqual({ kind: 'unreadable', reason: 'Docker did not answer in time' });
    const thrown = { run: vi.fn(async () => Promise.reject(new Error('spawn docker ENOENT'))) };
    expect(await containerDevspace(CONTAINER, { docker: thrown, host: '', now: NOW })).toEqual({ kind: 'unreadable', reason: 'spawn docker ENOENT' });
    expect(await containerDevspace(CONTAINER, { docker: { run: async () => answer({ stdout: 'not json' }) }, host: '', now: NOW })).toMatchObject({ kind: 'unreadable' });
    expect(await containerDevspace(CONTAINER, { docker: labelsOf({ ...LABELS, 'nimblescape.devspaces.id': '../x' }), host: '', now: NOW })).toEqual({
      kind: 'unreadable',
      reason: 'its label nimblescape.devspaces.id is not valid',
    });
    const { 'nimblescape.devspaces.owner-id': _owner, ...ownerless } = LABELS;
    expect(await containerDevspace(CONTAINER, { docker: labelsOf(ownerless), host: '', now: NOW })).toEqual({
      kind: 'unreadable',
      devspaceId: ID,
      reason: 'it has no valid label nimblescape.devspaces.owner-id',
    });
    expect(await containerDevspace(CONTAINER, { docker: labelsOf({ ...LABELS, 'nimblescape.devspaces.repository': 'not a repository' }), host: '', now: NOW })).toEqual({
      kind: 'unreadable',
      devspaceId: ID,
      reason: 'it has no valid label nimblescape.devspaces.repository',
    });
  });

  // Mutation: the activation without this read leaves the window of another account on an engine with the mark
  // connected (role C).
  it('the activation reads them only for a lost registry on an engine with the mark, on that engine, within the time limit of the activation', async () => {
    const remote = dockerTargetOf('ssh://build-box', 'devspaces-build-box');
    const lines: string[] = [];
    const engines: unknown[] = [];
    const run = vi.fn(async () => {
      engines.push(operationDockerTarget());
      return answer({ stdout: JSON.stringify(LABELS) });
    });
    const all = (options: { lost?: boolean; removed?: boolean; installed?: boolean } = {}) => ({
      needsRestore: async () => options.lost ?? true,
      docker: { isInstalled: () => options.installed ?? true, run },
      current: async () => remote,
      removed: vi.fn(async () => options.removed ?? true),
      now: () => NOW,
      logger: { ...silentLogger, info: (line: string) => void lines.push(line) },
    });
    const found = await removedEngineWindowDevspace(CONTAINER, all());
    expect(found).toEqual({ kind: 'devspace', devspace: expect.objectContaining({ id: ID, owner: { id: '1001', login: '' }, dockerHost: 'build-box' }) });
    expect(engines).toEqual([remote]);
    expect(run).toHaveBeenCalledWith(['container', 'inspect', '--format', '{{json .Config.Labels}}', CONTAINER], { timeoutMs: WINDOW_RESTORE_TIMEOUT_MS });
    expect(lines).toEqual([
      `The devspaces are not restored from build-box: Devspaces was removed from it. The labels of the container ${CONTAINER} are read for its devspace and its owner.`,
    ]);
    // A registry that did not lose its content, an engine without the mark (the restore ran there), no Docker CLI.
    run.mockClear();
    expect(await removedEngineWindowDevspace(CONTAINER, all({ lost: false }))).toEqual({ kind: 'none' });
    expect(await removedEngineWindowDevspace(CONTAINER, all({ removed: false }))).toEqual({ kind: 'none' });
    expect(await removedEngineWindowDevspace(CONTAINER, all({ installed: false }))).toEqual({ kind: 'none' });
    expect(run).not.toHaveBeenCalled();
    // A registry that cannot be read: nothing (logged).
    const unreadable = { ...all(), needsRestore: async () => Promise.reject(new Error('EACCES')) };
    const warnings: string[] = [];
    expect(await removedEngineWindowDevspace(CONTAINER, { ...unreadable, logger: { ...silentLogger, warn: (line: string) => void warnings.push(line) } })).toEqual({ kind: 'none' });
    expect(warnings).toEqual([`The labels of the container ${CONTAINER} could not be read: EACCES`]);
  });
});
