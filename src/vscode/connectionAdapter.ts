// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Connection Adapter: connects the window to a running container through the Dev Containers extension, and finds out
// which container the window uses. The URI format lives in connection/authority.ts (the literal ATTACHED_CONTAINER in
// core/devContainers.ts); the command IDs of VS Code for this live here.
import * as vscode from 'vscode';
import { ATTACHED_CONTAINER } from '../core/devContainers';
import { silentLogger, type Logger } from '../core/ports';
import { containerNameOfUri, decodeAuthorityParts, folderUriParts, REMOTE_SCHEME } from './connection/authority';

/** Opens a folder or workspace URI (built-in command of VS Code). */
export const OPEN_FOLDER_COMMAND = 'vscode.openFolder';
/** "Close Remote Connection". */
export const CLOSE_REMOTE_COMMAND = 'workbench.action.remote.close';
/** "Developer: Reload Window". */
export const RELOAD_WINDOW_COMMAND = 'workbench.action.reloadWindow';
/** "Close Window" (Close and Keep Running). */
export const CLOSE_WINDOW_COMMAND = 'workbench.action.closeWindow';

export class ConnectionAdapter {
  constructor(private readonly logger: Logger = silentLogger) {}

  /**
   * Container name (without the leading `/`) of this window, or `undefined` when the window is not attached to a
   * container. The name comes from the authority of the workspace file or of the first workspace folder. A window of
   * another remote type (`vscode.env.remoteName` set to something else) never has one.
   */
  currentContainerName(): string | undefined {
    const remoteName = vscode.env.remoteName;
    if (remoteName !== undefined && remoteName !== ATTACHED_CONTAINER) return undefined;
    const candidates: vscode.Uri[] = [];
    const workspaceFile = vscode.workspace.workspaceFile;
    if (workspaceFile) candidates.push(workspaceFile);
    const firstFolder = vscode.workspace.workspaceFolders?.[0];
    if (firstFolder) candidates.push(firstFolder.uri);
    for (const uri of candidates) {
      const name = containerNameOfUri(uri);
      if (name) return name;
    }
    return undefined;
  }

  /**
   * The name of this window in the names of its workers (workerNameStart; not of the worker of a devspace window on the
   * engine of the devspace, which is named after the devspace), the name that its title starts with: the name of its
   * saved workspace file without `.code-workspace`, else the name of its first folder (also of a remote folder, for
   * example over SSH, and the repository folder of a devspace; an untitled workspace, which the title calls
   * `Untitled (Workspace)`, too), and empty for a window without a folder. Not `vscode.workspace.name`, which adds the
   * remote to the name of a remote window and `(Workspace)` to the name of a workspace.
   */
  windowName(): string {
    const workspaceFile = vscode.workspace.workspaceFile;
    // An untitled workspace (`untitled:<number>`) has no name of its own.
    if (workspaceFile !== undefined && workspaceFile.scheme !== 'untitled') {
      const name = workspaceFile.path.slice(workspaceFile.path.lastIndexOf('/') + 1).replace(/\.code-workspace$/i, '');
      if (name !== '') return name;
    }
    return vscode.workspace.workspaceFolders?.[0]?.name ?? '';
  }

  /**
   * The Docker context named in the authority of this window (`settings.context`, authority.ts), or `undefined` for a
   * window without one (the local Docker, DOCKER_HOST, or no attached container).
   */
  currentDockerContext(): string | undefined {
    const shown = this.shownAttachedUri();
    return shown ? decodeAuthorityParts(shown.authority)?.dockerContext : undefined;
  }

  /**
   * The URI through which this window is attached to a container: its workspace file when that is an attached-container
   * URI, else its first folder when that is one (a local or untitled workspace file of remote folders).
   */
  private shownAttachedUri(): vscode.Uri | undefined {
    const remoteName = vscode.env.remoteName;
    if (remoteName !== undefined && remoteName !== ATTACHED_CONTAINER) return undefined;
    const candidates: vscode.Uri[] = [];
    const workspaceFile = vscode.workspace.workspaceFile;
    if (workspaceFile) candidates.push(workspaceFile);
    const firstFolder = vscode.workspace.workspaceFolders?.[0];
    if (firstFolder) candidates.push(firstFolder.uri);
    return candidates.find((uri) => uri.scheme === REMOTE_SCHEME && decodeAuthorityParts(uri.authority) !== undefined);
  }

  /**
   * True for an empty local window: no remote, no folder, and no workspace. A window of a remote (SSH, WSL, a tunnel,
   * an attached container) without a folder is not empty: the user opened it for that remote, so the reopen rule and
   * the pending operations do not take it over.
   */
  isEmptyWindow(): boolean {
    return (
      vscode.env.remoteName === undefined &&
      !vscode.workspace.workspaceFile &&
      (vscode.workspace.workspaceFolders?.length ?? 0) === 0
    );
  }

  /**
   * Connects this window to the running container: `vscode.openFolder` with the folder URI in the current window. VS Code
   * reloads the window; the returned promise may not settle before that.
   *
   * `forceReuseWindow` is set in addition to `forceNewWindow: false`, because without it the user setting
   * `window.openFoldersInNewWindow: "on"` would open a new window (Start in the current window stays in it; a new
   * window is `openInNewWindow`).
   *
   * When this window has exactly this folder open already (Reconnect after the connection was lost),
   * `vscode.openFolder` would only focus the window, so the window is reloaded instead: the reload connects again.
   *
   * `dockerContext`: the Docker context of a devspace on another Docker host, named in the authority so that the
   * Dev Containers extension attaches through it (authority.ts). A window with the same folder under another context
   * (or none) is not "this folder": it opens the new URI.
   */
  async open(containerName: string, remoteWorkspaceFolder: string, dockerContext?: string): Promise<void> {
    const parts = folderUriParts(containerName, remoteWorkspaceFolder, dockerContext);
    if (this.hasFolderOpen(parts)) {
      this.logger.info(`Reloading the window to connect it to ${containerName} again.`);
      await vscode.commands.executeCommand(RELOAD_WINDOW_COMMAND);
      return;
    }
    // Assumption: the Dev Containers extension attaches to the container of this URI without a prompt, and VS Code
    // shows an existing window instead when another window has the same folder open.
    const uri = vscode.Uri.from(parts);
    this.logger.info(`Connecting the window to ${containerName} (${uri.toString()}).`);
    await vscode.commands.executeCommand(OPEN_FOLDER_COMMAND, uri, { forceNewWindow: false, forceReuseWindow: true });
  }

  /**
   * Opens the folder URI of the running container in a NEW window (Start in New Window): `vscode.openFolder` with
   * `forceNewWindow: true`. This window keeps its folder and its connection; its extension host keeps running.
   *
   * When another window has this folder open already, VS Code shows that window instead of opening a second one: its
   * main process looks for a window with the same folder URI before it opens a new one, also with `forceNewWindow` (the
   * same assumption as in `open`). The caller does not open a devspace that another window uses.
   */
  async openInNewWindow(containerName: string, remoteWorkspaceFolder: string, dockerContext?: string): Promise<void> {
    const uri = vscode.Uri.from(folderUriParts(containerName, remoteWorkspaceFolder, dockerContext));
    this.logger.info(`Connecting a new window to ${containerName} (${uri.toString()}).`);
    await vscode.commands.executeCommand(OPEN_FOLDER_COMMAND, uri, { forceNewWindow: true });
  }

  /** "Close Remote Connection": the window becomes an empty local window, and the extension activates again in it. */
  async closeRemoteConnection(): Promise<void> {
    this.logger.info('Closing the remote connection of this window.');
    await vscode.commands.executeCommand(CLOSE_REMOTE_COMMAND);
  }

  /**
   * "Close Window" (Close and Keep Running): the whole window closes, and this extension host ends with it. VS Code may
   * ask about unsaved files first; with Cancel the window stays open.
   */
  async closeWindow(): Promise<void> {
    this.logger.info('Closing this window.');
    await vscode.commands.executeCommand(CLOSE_WINDOW_COMMAND);
  }

  /** The window shows exactly this folder of this container, through the same Docker context (a folder window). */
  private hasFolderOpen(target: { authority: string; path: string }): boolean {
    const folders = vscode.workspace.workspaceFolders;
    if (vscode.workspace.workspaceFile || folders?.length !== 1) return false;
    const current = folders[0].uri;
    if (current.scheme !== REMOTE_SCHEME) return false;
    const currentParts = decodeAuthorityParts(current.authority);
    const targetParts = decodeAuthorityParts(target.authority);
    return (
      currentParts !== undefined &&
      targetParts !== undefined &&
      currentParts.containerName === targetParts.containerName &&
      currentParts.dockerContext === targetParts.dockerContext &&
      withoutTrailingSlash(current.path) === withoutTrailingSlash(target.path)
    );
  }
}

function withoutTrailingSlash(folder: string): string {
  return folder.replace(/\/+$/, '') || '/';
}
