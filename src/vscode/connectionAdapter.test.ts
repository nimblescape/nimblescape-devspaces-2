// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAuthority } from './connection/authority';
import { CLOSE_REMOTE_COMMAND, CLOSE_WINDOW_COMMAND, ConnectionAdapter, OPEN_FOLDER_COMMAND, RELOAD_WINDOW_COMMAND } from './connectionAdapter';

interface FakeUri {
  scheme: string;
  authority: string;
  path: string;
  toString(): string;
}

// The part of the `vscode` API that the Connection Adapter uses.
const fake = vi.hoisted(() => {
  const state = {
    remoteName: undefined as string | undefined,
    workspaceFile: undefined as FakeUri | undefined,
    workspaceFolders: undefined as Array<{ uri: FakeUri; name?: string }> | undefined,
    commands: [] as unknown[][],
  };
  const uri = (parts: { scheme: string; authority?: string; path?: string }): FakeUri => ({
    scheme: parts.scheme,
    authority: parts.authority ?? '',
    path: parts.path ?? '',
    toString: () => `${parts.scheme}://${parts.authority ?? ''}${parts.path ?? ''}`,
  });
  const vscode = {
    env: {
      get remoteName() {
        return state.remoteName;
      },
    },
    workspace: {
      get workspaceFile() {
        return state.workspaceFile;
      },
      get workspaceFolders() {
        return state.workspaceFolders;
      },
    },
    Uri: { from: uri },
    commands: {
      executeCommand: async (...args: unknown[]) => {
        state.commands.push(args);
      },
    },
  };
  return { state, uri, vscode };
});

// Hoisted above the imports by vitest.
vi.mock('vscode', () => fake.vscode);

const NAME = 'devspaces-acme-api-3f2a9c1e';

function remoteFolder(name: string, folder = '/workspaces/api', dockerContext?: string): { uri: FakeUri } {
  return { uri: fake.uri({ scheme: 'vscode-remote', authority: encodeAuthority(name, dockerContext), path: folder }) };
}

describe('ConnectionAdapter', () => {
  beforeEach(() => {
    fake.state.remoteName = undefined;
    fake.state.workspaceFile = undefined;
    fake.state.workspaceFolders = undefined;
    fake.state.commands = [];
  });

  it('opens the folder URI of the container in the current window, also when the user opens folders in new windows', async () => {
    await new ConnectionAdapter().open(NAME, '/workspaces/api');
    expect(fake.state.commands).toHaveLength(1);
    const [command, uri, options] = fake.state.commands[0] as [string, FakeUri, Record<string, unknown>];
    expect(command).toBe(OPEN_FOLDER_COMMAND);
    expect(uri).toMatchObject({ scheme: 'vscode-remote', authority: encodeAuthority(NAME), path: '/workspaces/api' });
    expect(options).toEqual({ forceNewWindow: false, forceReuseWindow: true });
  });

  it('reloads the window when it has this folder of this container open already (Reconnect)', async () => {
    fake.state.remoteName = 'attached-container';
    fake.state.workspaceFolders = [remoteFolder(NAME, '/workspaces/api/')];
    await new ConnectionAdapter().open(`/${NAME}`, '/workspaces/api');
    expect(fake.state.commands).toEqual([[RELOAD_WINDOW_COMMAND]]);
  });

  it('opens the folder when the window shows another container or another folder', async () => {
    fake.state.remoteName = 'attached-container';
    fake.state.workspaceFolders = [remoteFolder('devspaces-acme-web-7c1d2e3f', '/workspaces/api')];
    await new ConnectionAdapter().open(NAME, '/workspaces/api');
    fake.state.workspaceFolders = [remoteFolder(NAME, '/workspaces/other')];
    await new ConnectionAdapter().open(NAME, '/workspaces/api');
    expect(fake.state.commands.map((call) => call[0])).toEqual([OPEN_FOLDER_COMMAND, OPEN_FOLDER_COMMAND]);
  });

  // The Docker context of a remote devspace is part of the window's authority.
  it('opens the folder URI with the Docker context, in this window and in a new one', async () => {
    await new ConnectionAdapter().open(NAME, '/workspaces/api', 'devspaces-remote-2e9f507b');
    await new ConnectionAdapter().openInNewWindow(NAME, '/workspaces/api', 'devspaces-remote-2e9f507b');
    for (const call of fake.state.commands) {
      expect((call as [string, FakeUri])[1]).toMatchObject({ authority: encodeAuthority(NAME, 'devspaces-remote-2e9f507b'), path: '/workspaces/api' });
    }
    expect(fake.state.commands).toHaveLength(2);
  });

  it('reloads only a window with the same context; a window without it (or with another) opens the new URI', async () => {
    fake.state.remoteName = 'attached-container';
    fake.state.workspaceFolders = [remoteFolder(NAME, '/workspaces/api', 'devspaces-remote-2e9f507b')];
    await new ConnectionAdapter().open(NAME, '/workspaces/api', 'devspaces-remote-2e9f507b');
    fake.state.workspaceFolders = [remoteFolder(NAME, '/workspaces/api')];
    await new ConnectionAdapter().open(NAME, '/workspaces/api', 'devspaces-remote-2e9f507b');
    fake.state.workspaceFolders = [remoteFolder(NAME, '/workspaces/api', 'devspaces-remote-5709ff28')];
    await new ConnectionAdapter().open(NAME, '/workspaces/api', 'devspaces-remote-2e9f507b');
    expect(fake.state.commands.map((call) => call[0])).toEqual([RELOAD_WINDOW_COMMAND, OPEN_FOLDER_COMMAND, OPEN_FOLDER_COMMAND]);
  });

  it('opens the folder URI of the container in a new window (Start in New Window)', async () => {
    await new ConnectionAdapter().openInNewWindow(NAME, '/workspaces/api');
    expect(fake.state.commands).toHaveLength(1);
    const [command, uri, options] = fake.state.commands[0] as [string, FakeUri, Record<string, unknown>];
    expect(command).toBe(OPEN_FOLDER_COMMAND);
    expect(uri).toMatchObject({ scheme: 'vscode-remote', authority: encodeAuthority(NAME), path: '/workspaces/api' });
    expect(options).toEqual({ forceNewWindow: true });
  });

  it('never reloads this window for a new window, also when this window shows the same folder', async () => {
    fake.state.remoteName = 'attached-container';
    fake.state.workspaceFolders = [remoteFolder(NAME, '/workspaces/api')];
    await new ConnectionAdapter().openInNewWindow(NAME, '/workspaces/api');
    expect(fake.state.commands.map((call) => call[0])).toEqual([OPEN_FOLDER_COMMAND]);
  });

  it('closes the remote connection with the command of VS Code', async () => {
    await new ConnectionAdapter().closeRemoteConnection();
    expect(fake.state.commands).toEqual([[CLOSE_REMOTE_COMMAND]]);
  });

  // Close and Keep Running closes the whole window.
  it('closes the window with the command of VS Code', async () => {
    await new ConnectionAdapter().closeWindow();
    expect(fake.state.commands).toEqual([[CLOSE_WINDOW_COMMAND]]);
    expect(CLOSE_WINDOW_COMMAND).toBe('workbench.action.closeWindow');
  });

  it('finds the container of an attached window from its first folder', () => {
    fake.state.remoteName = 'attached-container';
    fake.state.workspaceFolders = [remoteFolder(NAME)];
    expect(new ConnectionAdapter().currentContainerName()).toBe(NAME);
  });

  it('finds the container while remoteName is not set yet', () => {
    fake.state.workspaceFolders = [remoteFolder(NAME)];
    expect(new ConnectionAdapter().currentContainerName()).toBe(NAME);
  });

  it('prefers the workspace file of an attached window', () => {
    fake.state.remoteName = 'attached-container';
    fake.state.workspaceFile = fake.uri({
      scheme: 'vscode-remote',
      authority: encodeAuthority('devspaces-acme-web-7c1d2e3f'),
      path: '/workspaces/web/web.code-workspace',
    });
    fake.state.workspaceFolders = [remoteFolder(NAME)];
    expect(new ConnectionAdapter().currentContainerName()).toBe('devspaces-acme-web-7c1d2e3f');
  });

  // The context in the window's own authority.
  it('reads the Docker context of the attached window, and none without one or outside an attached window', () => {
    fake.state.remoteName = 'attached-container';
    fake.state.workspaceFolders = [remoteFolder(NAME, '/workspaces/api', 'devspaces-remote-5709ff28')];
    expect(new ConnectionAdapter().currentDockerContext()).toBe('devspaces-remote-5709ff28');
    fake.state.workspaceFolders = [remoteFolder(NAME, '/workspaces/api')];
    expect(new ConnectionAdapter().currentDockerContext()).toBeUndefined();
    fake.state.remoteName = 'ssh-remote';
    fake.state.workspaceFolders = [remoteFolder(NAME, '/workspaces/api', 'devspaces-remote-5709ff28')];
    expect(new ConnectionAdapter().currentDockerContext()).toBeUndefined();
  });

  // A local workspace file of remote folders reads the authority of its first folder.
  it('reads the authority of the first remote folder under a local workspace file, with an @<parent> suffix', () => {
    fake.state.remoteName = 'attached-container';
    fake.state.workspaceFile = fake.uri({ scheme: 'file', authority: '', path: '/Users/me/api.code-workspace' });
    fake.state.workspaceFolders = [
      { uri: fake.uri({ scheme: 'vscode-remote', authority: `${encodeAuthority(NAME)}@ssh-remote+box`, path: '/workspaces/api' }) },
    ];
    expect(new ConnectionAdapter().currentDockerContext()).toBeUndefined();
  });

  it('has no container in a local window, in a window of another remote type, and in an attached window without folder', () => {
    const adapter = new ConnectionAdapter();
    fake.state.workspaceFolders = [{ uri: fake.uri({ scheme: 'file', path: '/Users/me/project' }) }];
    expect(adapter.currentContainerName()).toBeUndefined();

    fake.state.remoteName = 'ssh-remote';
    fake.state.workspaceFolders = [remoteFolder(NAME)];
    expect(adapter.currentContainerName()).toBeUndefined();

    fake.state.remoteName = 'attached-container';
    fake.state.workspaceFolders = [];
    expect(adapter.currentContainerName()).toBeUndefined();
  });

  it('knows an empty window', () => {
    const adapter = new ConnectionAdapter();
    expect(adapter.isEmptyWindow()).toBe(true);
    fake.state.workspaceFolders = [];
    expect(adapter.isEmptyWindow()).toBe(true);
    fake.state.workspaceFolders = [remoteFolder(NAME)];
    expect(adapter.isEmptyWindow()).toBe(false);
    fake.state.workspaceFolders = undefined;
    fake.state.workspaceFile = fake.uri({ scheme: 'untitled', path: '/Untitled (Workspace)' });
    expect(adapter.isEmptyWindow()).toBe(false);
  });

  it('does not count a remote window without a folder as empty (the reopen rule takes an empty local window only)', () => {
    const adapter = new ConnectionAdapter();
    for (const remoteName of ['ssh-remote', 'wsl', 'tunnel', 'attached-container']) {
      fake.state.remoteName = remoteName;
      fake.state.workspaceFolders = undefined;
      expect(adapter.isEmptyWindow()).toBe(false);
      fake.state.workspaceFolders = [];
      expect(adapter.isEmptyWindow()).toBe(false);
    }
    fake.state.remoteName = undefined;
    expect(adapter.isEmptyWindow()).toBe(true);
  });

  it('names the window as its title does: by its saved workspace file, else its first folder', () => {
    const adapter = new ConnectionAdapter();
    expect(adapter.windowName()).toBe('');
    fake.state.workspaceFolders = [{ uri: fake.uri({ scheme: 'file', path: '/Users/me/My Project' }), name: 'My Project' }];
    expect(adapter.windowName()).toBe('My Project');
    // A remote folder, for example over SSH, by its name too.
    fake.state.remoteName = 'ssh-remote';
    fake.state.workspaceFolders = [{ uri: fake.uri({ scheme: 'vscode-remote', authority: 'ssh-remote+box', path: '/srv/api' }), name: 'api' }];
    expect(adapter.windowName()).toBe('api');
    // A saved workspace file by its name without `.code-workspace`; an untitled one by its first folder.
    fake.state.remoteName = undefined;
    fake.state.workspaceFile = fake.uri({ scheme: 'file', path: '/Users/me/course.code-workspace' });
    expect(adapter.windowName()).toBe('course');
    fake.state.workspaceFile = fake.uri({ scheme: 'untitled', path: '1555503116870' });
    expect(adapter.windowName()).toBe('api');
    // A workspace file without a name before `.code-workspace` too.
    fake.state.workspaceFile = fake.uri({ scheme: 'file', path: '/Users/me/.code-workspace' });
    expect(adapter.windowName()).toBe('api');
    // The window of a devspace by its repository folder, not by its container.
    fake.state.remoteName = 'attached-container';
    fake.state.workspaceFile = undefined;
    fake.state.workspaceFolders = [{ ...remoteFolder(NAME), name: 'api' }];
    expect(adapter.windowName()).toBe('api');
    // An attached window without a folder has no name.
    fake.state.workspaceFolders = [];
    expect(adapter.windowName()).toBe('');
  });
});
