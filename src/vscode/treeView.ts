// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Sidebar view `devspaces.repositories`. The rows come from the pure model in treeModel.ts.
import * as vscode from 'vscode';
import { Actions, Messages } from '../core/messages';
import type { Logger } from '../core/ports';
import { Commands } from './commands';
import {
  MonitorIcons,
  REPOSITORY_NODE_CONTEXT,
  rootNodes,
  stateIcon,
  type GroupNode,
  type HintRow,
  type OwnerGroup,
  type RepositoryNode,
  type RepositoryRow,
  type SignInRow,
} from './treeModel';

export const REPOSITORIES_VIEW_ID = 'devspaces.repositories';

/**
 * The first row names the Docker host. The merged header of the single view does not reliably show the view's title or
 * description, so the list itself names it. Also for the local Docker, and a click opens the choice of the Docker host,
 * which replaces the icons of the title bar.
 */
export interface DockerHostRow {
  kind: 'dockerHost';
  id: typeof DOCKER_HOST_ROW_ID;
  host: ShownDockerHost;
}

/**
 * The Docker host of the first row: the local Docker, a remote host, an endpoint that is not supported, or a docker
 * command that uses Podman (podmanDockerTarget).
 */
export interface ShownDockerHost {
  kind: 'local' | 'remote' | 'unsupported' | 'podman';
  /**
   * The remote host, or the endpoint that is not supported; empty for the local Docker, for a current Docker context
   * that could not be read (kind `unsupported`), and for Podman.
   */
  host: string;
}

export const DOCKER_HOST_ROW_ID = 'dockerHost';

export const DockerHostRowTexts = {
  label: (shown: ShownDockerHost) =>
    shown.kind === 'local'
      ? 'Local Docker'
      : shown.kind === 'remote'
        ? `Remote Docker host: ${shown.host}`
        : shown.kind === 'podman'
          ? Messages.podmanNotSupportedLabel
          : shown.host === ''
            ? Messages.dockerContextUnreadableLabel
            : `Docker endpoint not supported: ${shown.host}`,
  tooltip: (shown: ShownDockerHost) =>
    shown.kind === 'local'
      ? 'Docker runs on this computer. Click to use a remote Docker host.'
      : shown.kind === 'remote'
        ? `Docker runs on ${shown.host} over SSH. Click to choose another host or the local Docker.`
        : shown.kind === 'podman'
          ? Messages.podmanNotSupportedTooltip
          : shown.host === ''
            ? Messages.dockerContextUnreadableTooltip
            : 'Docker is set to an endpoint that Devspaces does not support (only the local Docker and SSH hosts). Click to choose the Docker host.',
} as const;

// The monitors of the rows, switched off, with the connection sign for a remote host and the warning sign for an
// endpoint that is not supported and for Podman.
const DOCKER_HOST_ICONS: Record<ShownDockerHost['kind'], string> = {
  local: MonitorIcons.off,
  remote: MonitorIcons.remote,
  unsupported: MonitorIcons.warning,
  podman: MonitorIcons.warning,
};

/** Command handlers of row actions receive a RepositoryRow as the first argument. */
export type TreeNode = OwnerGroup | GroupNode | RepositoryNode | RepositoryRow | HintRow | SignInRow | DockerHostRow;

/** The nodes of the view that have children. */
type ParentNode = OwnerGroup | GroupNode | RepositoryNode;

export class RepositoriesTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<TreeNode | undefined>();
  private groups: OwnerGroup[] = [];
  private roots: TreeNode[] = [];
  private dockerHost: ShownDockerHost | undefined;
  private readonly parents = new Map<string, ParentNode>();

  readonly onDidChangeTreeData: vscode.Event<TreeNode | undefined> = this.changeEmitter.event;

  constructor(private readonly logger: Logger) {}

  /**
   * Replaces the model and refreshes the view. `signedIn: false` adds the sign-in row at the top when the view is not
   * empty (see `rootNodes`). Default: signed in. While the Docker setup is required, the sidebar passes an empty model.
   */
  setModel(groups: OwnerGroup[], options: { signedIn?: boolean } = {}): void {
    this.groups = groups;
    this.roots = rootNodes(groups, options.signedIn ?? true);
    this.parents.clear();
    // The nodes of the setting repositoryGroups and the repository nodes nest the rows: every parent is recorded, so
    // reveal finds each row.
    const record = (parent: ParentNode): void => {
      for (const child of parent.children) {
        this.parents.set(child.id, parent);
        if (child.kind === 'group' || child.kind === 'repositoryNode') record(child);
      }
    };
    for (const group of groups) record(group);
    this.changeEmitter.fire(undefined);
  }

  /**
   * The Docker host of the first row, or undefined for none (not known yet). The row shows only above other rows: an
   * empty view keeps its welcome content (sign-in, Docker setup).
   */
  setDockerHost(host: ShownDockerHost | undefined): void {
    if (host?.kind === this.dockerHost?.kind && host?.host === this.dockerHost?.host) return;
    this.dockerHost = host === undefined ? undefined : { kind: host.kind, host: host.host };
    this.changeEmitter.fire(undefined);
  }

  /** The current model. */
  getModel(): readonly OwnerGroup[] {
    return this.groups;
  }

  /** The repository row with this id in the current model, or undefined (revealRow). */
  repositoryRow(id: string): RepositoryRow | undefined {
    const row = this.parents.get(id)?.children.find((child) => child.id === id);
    return row?.kind === 'repository' ? row : undefined;
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    try {
      switch (node.kind) {
        case 'owner':
          return ownerItem(node);
        case 'group':
          return groupItem(node);
        case 'repositoryNode':
          return repositoryNodeItem(node);
        case 'repository':
          return repositoryItem(node);
        case 'hint':
          return hintItem(node);
        case 'signIn':
          return signInItem(node);
        case 'dockerHost':
          return dockerHostItem(node);
      }
    } catch (error) {
      this.logger.error('Could not show a row of the sidebar.', error);
      return new vscode.TreeItem(node.id);
    }
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) {
      if (this.dockerHost === undefined || this.roots.length === 0) return this.roots;
      const row: DockerHostRow = { kind: 'dockerHost', id: DOCKER_HOST_ROW_ID, host: this.dockerHost };
      return [row, ...this.roots];
    }
    return node.kind === 'owner' || node.kind === 'group' || node.kind === 'repositoryNode' ? node.children : [];
  }

  getParent(node: TreeNode): TreeNode | undefined {
    return node.kind === 'owner' || node.kind === 'signIn' || node.kind === 'dockerHost' ? undefined : this.parents.get(node.id);
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}

/**
 * Expand All in the title bar of the view (the twin of VS Code's Collapse All): opens every owner, every node of the
 * setting repositoryGroups, and every repository node. Reveal opens a node and its parents; it neither selects nor
 * focuses a row. A node that the view no longer has (the model changed meanwhile) is skipped.
 */
export async function expandAll(view: Pick<vscode.TreeView<TreeNode>, 'reveal'>, groups: readonly OwnerGroup[]): Promise<void> {
  const nodes: ParentNode[] = [];
  const collect = (node: ParentNode): void => {
    nodes.push(node);
    for (const child of node.children) if (child.kind === 'group' || child.kind === 'repositoryNode') collect(child);
  };
  for (const group of groups) collect(group);
  for (const node of nodes) {
    try {
      await view.reveal(node, { expand: true, select: false, focus: false });
    } catch {
      // The node is gone; the others still open.
    }
  }
}

/**
 * Shows a repository row of the view and opens its parents: the child row that a double-click or Enter on a repository
 * with several sources starts (Controller.rowActivated). It neither selects nor focuses the row. A row that the current
 * model does not have is skipped.
 */
export async function revealRow(
  view: Pick<vscode.TreeView<TreeNode>, 'reveal'>,
  tree: Pick<RepositoriesTreeProvider, 'repositoryRow'>,
  rowId: string,
): Promise<void> {
  const row = tree.repositoryRow(rowId);
  if (row) await view.reveal(row, { select: false, focus: false });
}

function ownerItem(group: OwnerGroup): vscode.TreeItem {
  const item = new vscode.TreeItem(group.owner, vscode.TreeItemCollapsibleState.Expanded);
  item.id = group.id;
  item.contextValue = 'owner';
  return item;
}

/** Node of the setting repositoryGroups. Its contextValue does not start with `repository`, so no row action applies. */
function groupItem(node: GroupNode): vscode.TreeItem {
  const item = new vscode.TreeItem(
    node.label,
    node.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
  );
  item.id = node.id;
  item.contextValue = 'group';
  if (node.tooltip !== undefined) item.tooltip = node.tooltip;
  return item;
}

/**
 * A repository with several sources: a level of the tree with the repository name, expanded while a child row has a
 * devspace (its child rows carry the buttons). No state icon (the blank icon keeps the names aligned), no description,
 * and a contextValue without any flag of a row, so no row action applies to it. Its command is the command of a
 * repository row: a double-click or Enter starts its first child row (rowActivation.ts). With a command, a single click
 * on its name only selects the node; VS Code opens and closes it with its arrow, the arrow keys, and a double-click.
 * After a start, the controller shows the child row that starts (revealRow), so the node is open then.
 */
function repositoryNodeItem(node: RepositoryNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.label, node.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
  item.id = node.id;
  item.tooltip = node.tooltip;
  item.contextValue = REPOSITORY_NODE_CONTEXT;
  item.iconPath = new vscode.ThemeIcon('blank');
  item.accessibilityInformation = { label: node.repository };
  item.command = { command: Commands.rowActivated, title: 'Start', arguments: [node] };
  return item;
}

function repositoryItem(row: RepositoryRow): vscode.TreeItem {
  const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None);
  item.id = row.id;
  item.description = row.description;
  item.tooltip = row.tooltip;
  item.contextValue = row.contextValue;
  if (row.state) {
    const icon = stateIcon(row.state);
    item.iconPath = new vscode.ThemeIcon(icon.id, icon.color ? new vscode.ThemeColor(icon.color) : undefined);
  } else {
    // A repository without devspace has no symbol; the blank icon keeps the names aligned.
    item.iconPath = new vscode.ThemeIcon('blank');
  }
  item.accessibilityInformation = { label: [row.child ? `${row.repository} ${row.label}` : row.repository, row.description].filter((text) => text !== '').join(', ') };
  // VS Code runs this command on each click (or only on a double-click, per workbench.list.openMode); the controller
  // runs Start on a double-click (rowActivation.ts).
  item.command = { command: Commands.rowActivated, title: 'Start', arguments: [row] };
  return item;
}

function signInItem(row: SignInRow): vscode.TreeItem {
  const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None);
  item.id = row.id;
  item.tooltip = row.tooltip;
  item.contextValue = 'signIn';
  item.iconPath = new vscode.ThemeIcon('account');
  item.command = { command: Commands.signIn, title: row.label };
  return item;
}

function dockerHostItem(row: DockerHostRow): vscode.TreeItem {
  const item = new vscode.TreeItem(DockerHostRowTexts.label(row.host), vscode.TreeItemCollapsibleState.None);
  item.id = row.id;
  item.tooltip = DockerHostRowTexts.tooltip(row.host);
  item.contextValue = 'dockerHost';
  item.iconPath = new vscode.ThemeIcon(DOCKER_HOST_ICONS[row.host.kind]);
  item.command = { command: Commands.chooseDockerHost, title: DockerHostRowTexts.label(row.host) };
  return item;
}

function hintItem(hint: HintRow): vscode.TreeItem {
  const item = new vscode.TreeItem(hint.label, vscode.TreeItemCollapsibleState.None);
  item.id = hint.id;
  // An owner that GitHub does not return has nothing to authorize: the row opens its page.
  const action = hint.notFound ? Actions.open : Actions.authorize;
  if (!hint.notFound) item.description = action;
  item.tooltip = `${action}: ${hint.url}`;
  item.contextValue = 'hint';
  item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
  item.command = { command: 'vscode.open', title: action, arguments: [vscode.Uri.parse(hint.url)] };
  return item;
}
