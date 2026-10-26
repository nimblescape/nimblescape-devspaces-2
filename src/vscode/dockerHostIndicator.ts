// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Docker host in the sidebar, for a remote host and for the local Docker. The view's title names the Docker host:
// "<host> (remote)", "Local Docker", "<endpoint> (not supported)", that the current Docker context cannot be read, or
// that Podman is not supported ("Devspaces", and no host row, while no Docker CLI is found); the sidebar has one view,
// so VS Code merges its header with the sidebar title and shows "Devspaces:
// <title>" (the description of a merged view is not shown; it is set too, for a layout with more views). The merged
// header does not show it in every window, so the first row of the list names the host too (treeView.ts,
// DockerHostRow); a click on it chooses the Docker host (the title bar has no icon for it).
import { isPodmanDockerTarget, isUnreadableDockerTarget, type DockerTarget } from '../core/docker/dockerHost';
import { Messages } from '../core/messages';
import type { Logger } from '../core/ports';
import type { ShownDockerHost } from './treeView';

export const DockerHostTexts = {
  /** The description next to the view's name (shown when VS Code does not merge the view with the sidebar title). */
  remote: (host: string) => `Remote: ${host}`,
  /** The view's title on a remote host; in the merged header "Devspaces: <host> (remote)". */
  remoteTitle: (host: string) => `${host} (remote)`,
  /** The view's title on the local Docker; in the merged header "Devspaces: Local Docker". */
  localTitle: 'Local Docker',
  /** The view's title for an endpoint that is not supported ('': the current Docker context cannot be read). */
  unsupportedTitle: (endpoint: string) => (endpoint === '' ? Messages.dockerContextUnreadableLabel : `${endpoint} (not supported)`),
  /** The view's title while the docker command uses Podman. */
  podmanTitle: Messages.podmanNotSupportedLabel,
  /** The view name of package.json, while no Docker CLI is found. */
  noDockerTitle: 'Devspaces',
} as const;

/** The part of the TreeView that the indicator sets. */
export interface DescribedView {
  description?: string;
  title?: string;
}

export class DockerHostIndicator {
  private shown: (ShownDockerHost & { installed: boolean }) | undefined;

  constructor(
    private readonly view: DescribedView,
    private readonly logger: Logger,
    /** The first row of the list names the Docker host (treeView.ts, DockerHostRow). */
    private readonly showHostRow: (host: ShownDockerHost | undefined) => void = () => {},
  ) {}

  /**
   * Shows `target`: the local Docker, a remote host, or an endpoint that is not supported. `installed` false (no Docker
   * CLI found; the target then reads as the local Docker): no Docker host at all (the header would otherwise say "Local
   * Docker" above the Docker setup).
   */
  update(target: DockerTarget, installed = true): void {
    // A context that could not be read shows without a host, and Podman as its own kind (ShownDockerHost).
    const shown: ShownDockerHost = isPodmanDockerTarget(target)
      ? { kind: 'podman', host: '' }
      : { kind: target.kind, host: target.kind === 'local' || isUnreadableDockerTarget(target) ? '' : target.host };
    if (this.shown && this.shown.kind === shown.kind && this.shown.host === shown.host && this.shown.installed === installed) return;
    this.shown = { ...shown, installed };
    if (!installed) {
      this.view.description = undefined;
      this.view.title = DockerHostTexts.noDockerTitle;
      this.showHostRow(undefined);
      return;
    }
    this.view.description = shown.kind === 'remote' ? DockerHostTexts.remote(shown.host) : undefined;
    this.view.title =
      shown.kind === 'remote'
        ? DockerHostTexts.remoteTitle(shown.host)
        : shown.kind === 'local'
          ? DockerHostTexts.localTitle
          : shown.kind === 'podman'
            ? DockerHostTexts.podmanTitle
            : DockerHostTexts.unsupportedTitle(shown.host);
    this.showHostRow(shown);
    this.logger.info(`Docker host of the sidebar: ${describeShown(shown)}.`);
  }
}

/** The Docker host of the sidebar, for the log. */
function describeShown(shown: ShownDockerHost): string {
  switch (shown.kind) {
    case 'local':
      return 'the local Docker';
    case 'remote':
      return shown.host;
    case 'podman':
      return Messages.podmanDockerHost;
    case 'unsupported':
      return shown.host === '' ? Messages.unreadableDockerContextHost : `${shown.host} (not supported)`;
  }
}
