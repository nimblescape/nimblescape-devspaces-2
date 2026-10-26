// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Docker setup lives only in the sidebar (welcome view): no walkthrough, no command that opens it, and no message
// "Docker Desktop is not installed." at activation.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => {
  const { fakeVscode } = await import('./testing/fakeVscode');
  return { ...fakeVscode, ExtensionMode: { Production: 1, Development: 2, Test: 3 } };
});
// No Docker CLI on this computer (activation test).
const foundDockerCli = vi.hoisted(() => vi.fn((): string | undefined => undefined));
vi.mock('../core/docker/dockerCli', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/docker/dockerCli')>();
  return { ...actual, findDockerCli: foundDockerCli };
});
// The extension starts no local Monitor process; the activation test records every process that the activation
// starts, to show that none is a Monitor.
const spawned = vi.hoisted(() => [] as string[][]);
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const spawn = ((command: string, args?: readonly string[], ...rest: unknown[]) => {
    spawned.push([command, ...(Array.isArray(args) ? args.map(String) : [])]);
    return (actual.spawn as (...all: unknown[]) => unknown)(command, args, ...rest);
  }) as typeof actual.spawn;
  return { ...actual, spawn, default: { ...actual, spawn } };
});
// No network in these tests: an HTTPS request of the activation (the repository list after a sign-in) fails at once.
vi.mock('../core/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/http')>();
  return {
    ...actual,
    nodeHttpsTransport: {
      request: async () => {
        throw new Error('No network in this test.');
      },
    },
  };
});
// The wait of the activation for the first use of Devspaces (devspacesUsed): a test can do something while it waits.
const whileFirstUseIsRead = vi.hoisted(() => ({ run: undefined as (() => void) | undefined }));
vi.mock('../core/storage/firstUse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/storage/firstUse')>();
  return {
    ...actual,
    devspacesUsed: async (...args: Parameters<typeof actual.devspacesUsed>) => {
      const used = await actual.devspacesUsed(...args);
      whileFirstUseIsRead.run?.();
      return used;
    },
  };
});

import { ATTACHED_CONTAINER } from '../core/devContainers';
import { DockerContextKeys } from '../core/docker/dockerSetup';
import { Messages } from '../core/messages';
import { GITHUB_ENTERPRISE_CONTEXT_KEY } from './auth';
import { Commands } from './commands';
import { encodeAuthority, REMOTE_SCHEME } from './connection/authority';
import { CLOSE_REMOTE_COMMAND } from './connectionAdapter';
import { Controller } from './controller';
import { DockerSetup } from './dockerSetup';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';

const ROOT = path.join(__dirname, '..', '..');
const REMOVED_COMMAND = 'devspaces.installDocker';

interface Manifest {
  contributes: {
    walkthroughs?: unknown;
    views: Record<string, Array<{ id: string }>>;
    viewsWelcome: Array<{ view: string; contents: string; when: string }>;
    commands: Array<{ command: string }>;
    menus: Record<string, Array<{ command?: string; submenu?: string }>>;
    keybindings?: Array<{ command: string }>;
  };
}

function manifest(): Manifest {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as Manifest;
}

function sourceFiles(folder: string): string[] {
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [file] : [];
  });
}

function messageCalls(): number {
  const { showInformationMessage, showWarningMessage, showErrorMessage } = fakeVscode.window;
  return showInformationMessage.mock.calls.length + showWarningMessage.mock.calls.length + showErrorMessage.mock.calls.length;
}

beforeEach(() => {
  resetFakeVscode();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** The events of a TreeView when a node opens or closes, which the activation listens to. */
function nodeEvents(): { onDidExpandElement: unknown; onDidCollapseElement: unknown } {
  return { onDidExpandElement: new fakeVscode.EventEmitter<unknown>().event, onDidCollapseElement: new fakeVscode.EventEmitter<unknown>().event };
}

describe('no message at activation when Docker is missing', () => {
  it('activates with the sidebar visible and no Docker CLI without any notification, also when the view is shown again', async () => {
    vi.useRealTimers();
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-activation-test-'));
    const visibility = new fakeVscode.EventEmitter<{ visible: boolean }>();
    const expanded = new fakeVscode.EventEmitter<unknown>();
    const collapsed = new fakeVscode.EventEmitter<unknown>();
    const view = { visible: true, onDidChangeVisibility: visibility.event, onDidExpandElement: expanded.event, onDidCollapseElement: collapsed.event, dispose() {} };
    const window = fakeVscode.window as unknown as Record<string, unknown>;
    window.createTreeView = vi.fn(() => view);
    window.onDidChangeWindowState = vi.fn(() => ({ dispose() {} }));
    const workspace = fakeVscode.workspace as unknown as Record<string, unknown>;
    workspace.onDidChangeConfiguration = vi.fn(() => ({ dispose() {} }));
    workspace.workspaceFolders = undefined;
    workspace.workspaceFile = undefined;
    fakeVscode.workspace.getConfiguration.mockImplementation(() => ({
      get: () => undefined,
      inspect: () => undefined,
      update: async () => {},
    }));
    const context = {
      subscriptions: [] as Array<{ dispose(): unknown }>,
      globalStorageUri: { fsPath: storage },
      extensionUri: { fsPath: ROOT },
      extensionMode: 1,
      // As VS Code gives it: the manifest, whose version the header User-Agent names.
      extension: { packageJSON: manifest() },
      asAbsolutePath: (relative: string) => path.join(storage, 'extension', relative),
    };
    try {
      const { activate } = await import('./extension');
      await activate(context as never);
      await new Promise((resolve) => setTimeout(resolve, 100));
      // The view becomes visible again (for example after another view was shown).
      view.visible = false;
      visibility.fire({ visible: false });
      view.visible = true;
      visibility.fire({ visible: true });
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(foundDockerCli).toHaveBeenCalled();
      // A node of the view that opens or closes tells the controller (an Enter on an owner or a group runs no command).
      const toggled = vi.spyOn(Controller.prototype, 'nodeToggled');
      expanded.fire({ element: { kind: 'owner', id: 'owner:acme' } });
      collapsed.fire({ element: { kind: 'owner', id: 'owner:acme' } });
      expect(toggled).toHaveBeenCalledTimes(2);
      toggled.mockRestore();
      // A link to Devspaces goes to the controller (links.ts).
      expect(fakeVscode.window.registerUriHandler).toHaveBeenCalledTimes(1);
      const opened = vi.spyOn(Controller.prototype, 'openLink').mockResolvedValue();
      const [handler] = fakeVscode.window.registerUriHandler.mock.calls[0] as [{ handleUri(uri: unknown): unknown }];
      const uri = { path: '/open', query: 'repository=acme/api' };
      await handler.handleUri(uri);
      expect(opened).toHaveBeenCalledWith(uri);
      opened.mockRestore();
      // The HTTPS requests name the version of the manifest, which the activation took (src/core/http.ts).
      const { userAgent } = await import('../core/http');
      const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string };
      expect(userAgent()).toBe(`nimblescape-devspaces/${version}`);
      // The sidebar shows the Docker setup (welcome view) instead of the repositories.
      expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith('setContext', DockerContextKeys.setupRequired, true);
      // The activation sets the context key of the note on GitHub Enterprise; here no setting names an instance.
      expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith('setContext', GITHUB_ENTERPRISE_CONTEXT_KEY, false);
      expect(fakeVscode.window.showInformationMessage).not.toHaveBeenCalled();
      expect(fakeVscode.window.showWarningMessage).not.toHaveBeenCalled();
      expect(fakeVscode.window.showErrorMessage).not.toHaveBeenCalled();
      expect(messageCalls()).toBe(0);
      // No local Monitor: no process of it, and none of its files in the storage folder.
      expect(spawned.filter((call) => call.some((part) => part.includes('sessionMonitor')))).toEqual([]);
      for (const name of ['monitor.json', 'monitor.lock', 'monitor.version', 'monitor.exit', 'monitor.log']) {
        expect(fs.existsSync(path.join(storage, name))).toBe(false);
      }
      // deactivate() writes `closing` at once and resolves (a window without a devspace has nothing to release).
      const { deactivate } = await import('./extension');
      await deactivate();
      const statuses = fs.readdirSync(path.join(storage, 'sessions')).filter((name) => name.endsWith('.json'));
      expect(statuses).toHaveLength(1);
      expect(JSON.parse(fs.readFileSync(path.join(storage, 'sessions', statuses[0]), 'utf8'))).toMatchObject({ state: 'closing', devspaceId: null });
    } finally {
      for (const subscription of context.subscriptions) {
        try {
          subscription.dispose();
        } catch {
          // Only the cleanup of the test.
        }
      }
      fs.rmSync(storage, { recursive: true, force: true });
    }
  });

  it('lets the Docker setup look at a view that became visible while the activation waited, before its listener existed', async () => {
    vi.useRealTimers();
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-activation-test-'));
    const view = { visible: false, onDidChangeVisibility: new fakeVscode.EventEmitter<{ visible: boolean }>().event, ...nodeEvents(), dispose() {} };
    // The view becomes visible while the activation waits for the first use (after the setup looked at the view):
    // VS Code sends that event once, before the listener exists, so the listener never hears it.
    let visibleAtInitialize: boolean | undefined;
    const initialize = DockerSetup.prototype.initialize;
    const initialized = vi.spyOn(DockerSetup.prototype, 'initialize').mockImplementation(function (this: DockerSetup) {
      visibleAtInitialize = view.visible;
      initialize.call(this);
    });
    whileFirstUseIsRead.run = () => {
      view.visible = true;
    };
    const shown = vi.spyOn(DockerSetup.prototype, 'onViewShown');
    const window = fakeVscode.window as unknown as Record<string, unknown>;
    window.createTreeView = vi.fn(() => view);
    window.onDidChangeWindowState = vi.fn(() => ({ dispose() {} }));
    const workspace = fakeVscode.workspace as unknown as Record<string, unknown>;
    workspace.onDidChangeConfiguration = vi.fn(() => ({ dispose() {} }));
    workspace.workspaceFolders = undefined;
    workspace.workspaceFile = undefined;
    fakeVscode.workspace.getConfiguration.mockImplementation(() => ({ get: () => undefined, inspect: () => undefined, update: async () => {} }));
    const context = {
      subscriptions: [] as Array<{ dispose(): unknown }>,
      globalStorageUri: { fsPath: storage },
      extensionUri: { fsPath: ROOT },
      extensionMode: 1,
      // As VS Code gives it: the manifest, whose version the header User-Agent names.
      extension: { packageJSON: manifest() },
      asAbsolutePath: (relative: string) => path.join(storage, 'extension', relative),
    };
    try {
      const { activate } = await import('./extension');
      await activate(context as never);
      expect(visibleAtInitialize).toBe(false);
      // On Windows without Docker, the setup runs `wsl --status` now, so that the step Install WSL 2 shows the state.
      expect(shown).toHaveBeenCalledTimes(1);
    } finally {
      whileFirstUseIsRead.run = undefined;
      initialized.mockRestore();
      shown.mockRestore();
      for (const subscription of context.subscriptions) {
        try {
          subscription.dispose();
        } catch {
          // Only the cleanup of the test.
        }
      }
      fs.rmSync(storage, { recursive: true, force: true });
    }
  });

  it('has no check of the view that shows "Docker Desktop is not installed." once', () => {
    expect('onViewVisible' in Controller.prototype).toBe(false);
    const extension = fs.readFileSync(path.join(ROOT, 'src', 'vscode', 'extension.ts'), 'utf8');
    expect(extension).not.toContain('onViewVisible');
  });

  it('uses "Docker Desktop is not installed." only as the error of an operation that needs Docker', () => {
    const uses: string[] = [];
    for (const file of sourceFiles(path.join(ROOT, 'src'))) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (line.includes('Messages.dockerNotInstalled')) uses.push(`${path.relative(ROOT, file)}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) expect(use).toMatch(/UserFacingError\('dockerNotInstalled', Messages\.dockerNotInstalled/);
    expect(Messages.dockerNotInstalled).toBe('Docker Desktop is not installed.');
  });
});

describe('nothing before the first use of Devspaces', () => {
  /**
   * A Docker CLI (a script) whose `docker context inspect` names the local Docker and whose `docker info` fails as
   * without a running engine, so nothing goes further than `docker info` (no image, build, or worker). With `running`,
   * `docker info` names an engine, and every other call fails. With `labels`, `docker container inspect` answers them
   * as the labels of the container.
   */
  function fakeDockerCli(folder: string, running = false, labels?: Record<string, string>): string {
    const file = path.join(folder, 'docker');
    fs.writeFileSync(
      file,
      [
        '#!/bin/sh',
        'case "$1 $2" in',
        `  context*) echo '{"Name":"default","Endpoints":{"docker":{"Host":"unix:///var/run/docker.sock"}}}' ;;`,
        ...(running ? [`  info*) echo '"27.3.1"' ;;`] : []),
        ...(labels ? [`  'container inspect') echo '${JSON.stringify(labels)}' ;;`] : []),
        '  *) echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2; exit 1 ;;',
        'esac',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    return file;
  }

  /**
   * Activates the extension with the sidebar visible, as a window without a folder, or with `containerName` as the
   * window of that container (role A); `prepare` fills the storage first. `running`: the Docker engine answers.
   */
  async function activateWithDocker(
    prepare: (storage: string) => void,
    check: (storage: string, docker: string, log: () => string) => Promise<void>,
    options: { containerName?: string; running?: boolean; labels?: Record<string, string> } = {},
  ): Promise<void> {
    vi.useRealTimers();
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-first-use-test-'));
    const docker = fakeDockerCli(fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-first-use-cli-')), options.running, options.labels);
    // The Dockerfile of the helper image, as in the installed extension.
    const dockerfile = path.join(storage, 'extension', 'resources', 'helper', 'Dockerfile');
    fs.mkdirSync(path.dirname(dockerfile), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'resources', 'helper', 'Dockerfile'), dockerfile);
    prepare(storage);
    foundDockerCli.mockReturnValue(docker);
    spawned.length = 0;
    const view = { visible: true, onDidChangeVisibility: new fakeVscode.EventEmitter<{ visible: boolean }>().event, ...nodeEvents(), dispose() {} };
    const window = fakeVscode.window as unknown as Record<string, unknown>;
    window.createTreeView = vi.fn(() => view);
    window.onDidChangeWindowState = vi.fn(() => ({ dispose() {} }));
    const workspace = fakeVscode.workspace as unknown as Record<string, unknown>;
    workspace.onDidChangeConfiguration = vi.fn(() => ({ dispose() {} }));
    workspace.workspaceFolders =
      options.containerName === undefined
        ? undefined
        : [{ uri: { scheme: REMOTE_SCHEME, authority: encodeAuthority(options.containerName), path: '/workspaces/api' }, name: 'api', index: 0 }];
    workspace.workspaceFile = undefined;
    fakeVscode.env.remoteName = options.containerName === undefined ? undefined : ATTACHED_CONTAINER;
    fakeVscode.workspace.getConfiguration.mockImplementation(() => ({ get: () => undefined, inspect: () => undefined, update: async () => {} }));
    const context = {
      subscriptions: [] as Array<{ dispose(): unknown }>,
      globalStorageUri: { fsPath: storage },
      extensionUri: { fsPath: ROOT },
      extensionMode: 1,
      // As VS Code gives it: the manifest, whose version the header User-Agent names.
      extension: { packageJSON: manifest() },
      asAbsolutePath: (relative: string) => path.join(storage, 'extension', relative),
    };
    try {
      const { activate } = await import('./extension');
      await activate(context as never);
      await check(storage, docker, () => fakeVscode.outputChannels.map((channel) => channel.text).join(''));
    } finally {
      for (const subscription of context.subscriptions) {
        try {
          subscription.dispose();
        } catch {
          // Only the cleanup of the test.
        }
      }
      foundDockerCli.mockReturnValue(undefined);
      workspace.workspaceFolders = undefined;
      fakeVscode.env.remoteName = undefined;
      fs.rmSync(storage, { recursive: true, force: true });
      fs.rmSync(path.dirname(docker), { recursive: true, force: true });
    }
  }

  /** Waits for `condition`, at most 10 seconds; the tests that wait have a time limit of 20 seconds. */
  async function waitFor(condition: () => boolean, what: string): Promise<void> {
    for (let waited = 0; !condition(); waited += 20) {
      if (waited > 10_000) throw new Error(`Waited in vain for ${what}.`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it('a fresh storage folder: the activation asks Docker only for its context, and writes no registry, helper record, or marker', async () => {
    await activateWithDocker(
      () => {},
      async (storage, docker) => {
        // The view title reads the Docker context; then some time for anything else that would start.
        await waitFor(() => spawned.some(([command, sub]) => command === docker && sub === 'context'), 'docker context inspect');
        await new Promise((resolve) => setTimeout(resolve, 500));
        // No `docker info`, image, build or run, no worker, no credential helper, no ssh, no wsl.exe: nothing but the
        // context.
        expect(spawned.filter(([command, sub]) => !(command === docker && sub === 'context'))).toEqual([]);
        for (const name of ['registry.json', 'helper.json', 'used']) expect(fs.existsSync(path.join(storage, name)), name).toBe(false);
      },
    );
  }, 20_000);

  it('after the first use (registry.json exists), the activation prepares the helper image in the background and writes the marker', async () => {
    await activateWithDocker(
      (storage) => fs.writeFileSync(path.join(storage, 'registry.json'), '{"version":1,"devspaces":[]}'),
      async (storage, docker, log) => {
        await waitFor(() => spawned.some(([command, sub]) => command === docker && sub === 'info'), 'docker info');
        expect(spawned).toContainEqual([docker, 'info', '--format', '{{json .ServerVersion}}']);
        await waitFor(() => log().includes('The workspace helper image is not prepared in the background: Docker is not running.'), 'the log of the preparation');
        expect(fs.readFileSync(path.join(storage, 'used'), 'utf8')).toBe('');
        // An empty registry: no devspace whose state the sidebar reads, and nothing to restore.
        expect(spawned.filter(([command, sub]) => command === docker && sub === 'info')).toHaveLength(1);
      },
    );
  }, 20_000);

  it('after "Remove Devspaces from This Docker Engine…" (its mark in docker-engines.json), the activation asks Docker only for its context', async () => {
    await activateWithDocker(
      (storage) => {
        fs.writeFileSync(path.join(storage, 'registry.json'), '{"version":1,"devspaces":[]}');
        fs.writeFileSync(path.join(storage, 'docker-engines.json'), '{"engines":[{"host":"","removedAt":1760000000000}]}');
      },
      async (_storage, docker, log) => {
        await waitFor(() => log().includes('No Docker work in the background at the start: Devspaces was removed from the local Docker.'), 'the log of the mark');
        await new Promise((resolve) => setTimeout(resolve, 500));
        // No `docker info`: no preparation of the helper image and no reconcile of the registry.
        expect(spawned.filter(([command, sub]) => !(command === docker && sub === 'context'))).toEqual([]);
      },
    );
  }, 20_000);

  /** A devspace of the account 1001 that the user kept on the local Docker, which has the removal mark. */
  const kept = {
    id: '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d',
    repository: 'acme/api',
    volumeName: 'devspaces-acme-api-3f2a9c1e',
    containerName: 'devspaces-acme-api-3f2a9c1e',
    remoteWorkspaceFolder: '/workspaces/api',
    owner: { id: '1001', login: 'octo' },
  };
  function keptOnRemovedEngine(storage: string): void {
    fs.writeFileSync(path.join(storage, 'registry.json'), JSON.stringify({ version: 1, devspaces: [kept] }));
    fs.writeFileSync(path.join(storage, 'docker-engines.json'), '{"engines":[{"host":"","removedAt":1760000000000}]}');
  }
  /** The GitHub session of VS Code: the account `id`. */
  function signIn(id: string, login: string): void {
    fakeVscode.authentication.getSession.mockResolvedValue({ id: `session-${id}`, accessToken: 'gho_test', account: { id, label: login }, scopes: ['repo', 'read:org'] });
  }

  it('the window of a devspace kept on an engine with the mark stays connected: no heartbeat, no open, no Docker work, one message', async () => {
    signIn('1001', 'octo');
    await activateWithDocker(
      keptOnRemovedEngine,
      async (storage, docker, log) => {
        await waitFor(() => log().includes('This window of acme/api works without Devspaces'), 'the log of the window');
        await new Promise((resolve) => setTimeout(resolve, 500));
        // Its status file names the devspace apart from the devspace of the window, so that the removal and the
        // operations of other windows see the window.
        const sessions = path.join(storage, 'sessions');
        const statuses = fs.readdirSync(sessions).map((name) => JSON.parse(fs.readFileSync(path.join(sessions, name), 'utf8')) as unknown);
        expect(statuses).toEqual([expect.objectContaining({ devspaceId: null, plainDevspaceId: kept.id, state: 'active' })]);
        expect(log()).toContain(
          'This window of acme/api works without Devspaces: Devspaces was removed from the local Docker. No background updates and no stop on close; a Start of acme/api sets Devspaces up there again.',
        );
        expect(fakeVscode.window.showInformationMessage.mock.calls).toEqual([
          [
            'Devspaces was removed from the local Docker, so this window works without it: no background updates and no stop on close. A Start of this devspace sets Devspaces up again there.',
          ],
        ]);
        expect(fakeVscode.window.showWarningMessage).not.toHaveBeenCalled();
        // The connection stays.
        expect(fakeVscode.commands.executeCommand.mock.calls.filter(([command]) => command === CLOSE_REMOTE_COMMAND)).toEqual([]);
        // Not even `docker info` for the states in the sidebar. No heartbeat (whose repair would start the Monitor), no
        // worker, no open pipeline.
        expect(spawned.filter(([command, sub]) => !(command === docker && sub === 'context'))).toEqual([]);
      },
      { containerName: kept.containerName, running: true },
    );
  }, 20_000);

  // The account rule outranks the removal mark.
  it('the window of a devspace of another account on an engine with the mark closes after the token removal through the worker', async () => {
    signIn('2002', 'someone');
    await activateWithDocker(
      keptOnRemovedEngine,
      async (_storage, docker, log) => {
        await waitFor(() => fakeVscode.commands.executeCommand.mock.calls.some(([command]) => command === CLOSE_REMOTE_COMMAND), 'the close of the connection');
        expect(log()).toContain('This window is attached to a devspace of another GitHub account. It closes its remote connection.');
        expect(fakeVscode.window.showWarningMessage.mock.calls.map((call) => call[0])).toContain(Messages.otherAccountConnection('acme/api'));
        expect(fakeVscode.window.showInformationMessage).not.toHaveBeenCalled();
        // The removal of the token ran through the worker of that engine (its preparation asks for the helper image;
        // this Docker answers nothing but its context and `docker info`).
        expect(spawned.some(([command, sub]) => command === docker && sub === 'image')).toBe(true);
        expect(log()).toContain(`The GitHub token could not be removed from the container ${kept.containerName}`);
      },
      { containerName: kept.containerName, running: true },
    );
  }, 20_000);

  /** registry.json is lost; the local Docker has the removal mark. */
  function lostOnRemovedEngine(storage: string): void {
    fs.writeFileSync(path.join(storage, 'docker-engines.json'), '{"engines":[{"host":"","removedAt":1760000000000}]}');
  }
  /** The labels of the dev container of `kept`: the id label of the Dev Container CLI, and those of the devspace image. */
  const keptLabels = (ownerId: string): Record<string, string> => ({
    'nimblescape.devspaces.id': kept.id,
    'nimblescape.devspaces.repository': kept.repository,
    'nimblescape.devspaces.owner-id': ownerId,
  });
  const inspect = (docker: string): string[] => [docker, 'container', 'inspect', '--format', '{{json .Config.Labels}}', kept.containerName];

  // No restore there, so the labels of the container give the devspace and its owner. Mutation: the activation without
  // that read (role C) fails it.
  it('the window of a devspace container restores no lost registry from an engine with the mark; its owner cannot be read: it closes', async () => {
    await activateWithDocker(
      lostOnRemovedEngine,
      async (_storage, docker, log) => {
        await waitFor(() => fakeVscode.commands.executeCommand.mock.calls.some(([command]) => command === CLOSE_REMOTE_COMMAND), 'the close of the connection');
        await new Promise((resolve) => setTimeout(resolve, 500));
        // Not even `docker info`: no restore is tried there; only one plain inspect of the container (it fails here).
        expect(spawned.filter(([command, sub]) => !(command === docker && sub === 'context'))).toEqual([inspect(docker)]);
        expect(log()).not.toContain('could not be restored from the volumes');
        expect(log()).toContain(
          `The window closes its remote connection: the owner of the devspace of the container ${kept.containerName} cannot be read (Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?).`,
        );
        expect(fakeVscode.window.showWarningMessage.mock.calls.map((call) => call[0])).toEqual([
          `Devspaces cannot tell which GitHub account owns the container ${kept.containerName}. This window closes its connection to it.`,
        ]);
      },
      { containerName: kept.containerName, running: true },
    );
  }, 20_000);

  it('the window of a devspace container of the account on an engine with the mark and a lost registry works without Devspaces', async () => {
    signIn('1001', 'octo');
    await activateWithDocker(
      lostOnRemovedEngine,
      async (storage, docker, log) => {
        await waitFor(() => log().includes('This window of acme/api works without Devspaces'), 'the log of the window');
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(log()).toContain(
          `The devspaces are not restored from the local Docker: Devspaces was removed from it. The labels of the container ${kept.containerName} are read for its devspace and its owner.`,
        );
        const sessions = path.join(storage, 'sessions');
        const statuses = fs.readdirSync(sessions).map((name) => JSON.parse(fs.readFileSync(path.join(sessions, name), 'utf8')) as unknown);
        expect(statuses).toEqual([expect.objectContaining({ devspaceId: null, plainDevspaceId: kept.id, state: 'active' })]);
        expect(fakeVscode.window.showWarningMessage).not.toHaveBeenCalled();
        expect(fakeVscode.commands.executeCommand.mock.calls.filter(([command]) => command === CLOSE_REMOTE_COMMAND)).toEqual([]);
        // No restore, no heartbeat, no worker: only the inspect.
        expect(spawned.filter(([command, sub]) => !(command === docker && sub === 'context'))).toEqual([inspect(docker)]);
        expect(fs.existsSync(path.join(storage, 'registry.json'))).toBe(false);
      },
      { containerName: kept.containerName, running: true, labels: keptLabels('1001') },
    );
  }, 20_000);

  it('the window of a devspace container of another account on an engine with the mark and a lost registry closes after the token removal', async () => {
    signIn('2002', 'someone');
    await activateWithDocker(
      lostOnRemovedEngine,
      async (_storage, docker, log) => {
        await waitFor(() => fakeVscode.commands.executeCommand.mock.calls.some(([command]) => command === CLOSE_REMOTE_COMMAND), 'the close of the connection');
        expect(log()).toContain('This window is attached to a devspace of another GitHub account. It closes its remote connection.');
        expect(fakeVscode.window.showWarningMessage.mock.calls.map((call) => call[0])).toContain(Messages.otherAccountConnection('acme/api'));
        expect(fakeVscode.window.showInformationMessage).not.toHaveBeenCalled();
        // The removal of the token ran through the worker of that engine, as for a registry that knows the devspace.
        expect(spawned.some(([command, sub]) => command === docker && sub === 'image')).toBe(true);
        expect(log()).toContain(`The GitHub token could not be removed from the container ${kept.containerName}`);
      },
      { containerName: kept.containerName, running: true, labels: keptLabels('1001') },
    );
  }, 20_000);
});

describe('package.json without the walkthrough', () => {
  it('has no walkthroughs and no walkthrough media', () => {
    expect(manifest().contributes.walkthroughs).toBeUndefined();
    expect(fs.existsSync(path.join(ROOT, 'resources', 'walkthrough'))).toBe(false);
  });

  it('declares only commands that the extension registers, and references only declared commands', () => {
    const contributes = manifest().contributes;
    const declared = contributes.commands.map((entry) => entry.command);
    const registered = new Set<string>(Object.values(Commands));
    for (const command of declared) expect(registered.has(command), command).toBe(true);
    expect(declared).not.toContain(REMOVED_COMMAND);
    expect(Object.values(Commands)).not.toContain(REMOVED_COMMAND);

    const referenced = [
      ...Object.values(contributes.menus).flatMap((entries) => entries.flatMap((entry) => (entry.command ? [entry.command] : []))),
      ...(contributes.keybindings ?? []).map((entry) => entry.command),
      ...contributes.viewsWelcome.flatMap((view) => [...view.contents.matchAll(/\(command:([\w.]+)\)/g)].map((match) => match[1])),
    ];
    expect(referenced.length).toBeGreaterThan(0);
    for (const command of referenced) expect(declared, command).toContain(command);
  });
});

describe('the Docker setup in the sidebar welcome view', () => {
  it('links no Setup Guide', () => {
    const welcome = manifest().contributes.viewsWelcome;
    for (const view of welcome) {
      expect(view.contents).not.toContain(REMOVED_COMMAND);
      expect(view.contents).not.toContain('Setup Guide');
    }
    const after = welcome.filter((view) => view.contents.startsWith('Your repositories appear here once Docker is installed'));
    expect(after).toEqual([
      {
        view: 'devspaces.repositories',
        contents: 'Your repositories appear here once Docker is installed. Devspaces starts Docker when needed.',
        when: `${DockerContextKeys.setupRequired} && !isLinux`,
      },
      {
        // Docker Engine on Linux needs administrator rights to start: the error offers Start Docker instead.
        view: 'devspaces.repositories',
        contents: 'Your repositories appear here once Docker is installed. Devspaces asks to start Docker Engine when needed.',
        when: `${DockerContextKeys.setupRequired} && isLinux`,
      },
    ]);
  });

  it('keeps the buttons of the setup and the sign-in', () => {
    const links = manifest()
      .contributes.viewsWelcome.map((view) => view.contents)
      .join('\n');
    expect(links).toContain(`(command:${Commands.dockerSetupInstall})`);
    expect(links).toContain(`(command:${Commands.dockerSetupInstallWsl})`);
    expect(links).toContain(`(command:${Commands.signIn})`);
  });

  it('names the license of Docker Desktop in the steps that install it', () => {
    const welcome = manifest().contributes.viewsWelcome;
    const desktopSteps = welcome.filter((view) => view.contents.includes('Install Docker Desktop'));
    expect(desktopSteps.map((view) => view.when)).toEqual([
      `${DockerContextKeys.setupRequired} && isMac`,
      `${DockerContextKeys.setupRequired} && isWindows`,
    ]);
    for (const view of desktopSteps) {
      // A short text; the license terms are named and linked.
      expect(view.contents).toContain('free for personal use, education, non-commercial open source, and small businesses');
      expect(view.contents).toContain('(https://www.docker.com/legal/docker-subscription-service-agreement/)');
    }
  });
});
