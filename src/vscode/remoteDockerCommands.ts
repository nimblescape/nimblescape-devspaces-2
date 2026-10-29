// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// "Devspaces: Use a Remote Docker Host…", "Devspaces: Use the Local Docker", and the choice of the first row of the view.
// Devspaces keeps its own list of SSH hosts (RemoteDockerState, docs/architecture.md "Remote Docker hosts"): "Use a
// Remote Docker Host…" tests a host over SSH without questions and makes it the Docker host of Devspaces (it joins the
// list); "Use the Local Docker" goes back to the Docker of this computer, which the current Docker context names. Nothing
// else is written: no Docker context, no setting, no DOCKER_HOST, no setting of the Dev Containers extension, so the
// docker command in the terminals of the user keeps its target. One Docker host at a time, for every window of
// Devspaces on this computer. A Docker context or DOCKER_HOST of the user that reaches a host over SSH is offered once
// for the list (offerDockerContextHost).
import * as vscode from 'vscode';
import {
  describeDockerHost,
  isDockerContextHostTarget,
  parseSshAddress,
  sshTargetOf,
  type DockerTarget,
  type SshAddressProblem,
} from '../core/docker/dockerHost';
import type { DockerTargets } from '../core/docker/dockerTargets';
import {
  recordRootlessSocket,
  sshHostsOfContexts,
  testRemoteDockerHost,
  unsupportedTargetMessage,
  type RemoteDockerCli,
  type SshLoginCache,
} from '../core/docker/remoteDocker';
import { errorMessage, isUserFacingError } from '../core/errors';
import { Actions, Messages, dockerHostReason } from '../core/messages';
import { isAbortError, type Logger, type ProcessRunner } from '../core/ports';
import type { SshHostEntry } from '../core/sshConfig';
import type { RemoteDockerState } from '../core/storage/remoteDockerState';
import { showErrorMessage, showInformationMessage, showWarningMessage } from './notifications';
import { withNotificationProgress } from './progress';
import { MonitorIcons } from './treeModel';

/** User-visible texts of the remote Docker host (plain language). No `vscode` in them. */
export const RemoteDockerTexts = {
  pickTitle: 'Use a Remote Docker Host',
  pickPlaceholder: 'Choose a host, or enter an SSH address',
  /** The groups of the hosts in the choice. */
  listGroup: 'Hosts of Devspaces',
  sshConfigGroup: 'SSH config',
  contextGroup: 'Docker contexts',
  enterAddress: 'Enter an SSH address…',
  enterAddressDetail: 'user@host or user@host:port',
  addressPrompt: 'The SSH address of the computer with Docker, for example me@build-box or me@192.0.2.10:2222',
  addressProblem: (problem: SshAddressProblem): string => {
    switch (problem) {
      case 'empty':
        return 'Enter an address such as me@build-box.';
      case 'spaces':
        return 'The address must not contain spaces.';
      case 'option':
        return 'The address must not start with "-".';
      case 'path':
        return 'Enter only user@host[:port], without a path or a query.';
      case 'user':
        return 'The user name may contain letters, digits, ".", "_" and "-", and must not start with "-".';
      case 'host':
        return 'The host must be a name such as build-box.example.com or an IPv4 address.';
      case 'ipv6':
        return 'Write an IPv6 address in brackets, for example [2001:db8::1]:22.';
      case 'port':
        return 'The port must be a number from 1 to 65535.';
    }
  },
  /** The description of a host of a Docker context of the user in the choice. */
  dockerContext: (name: string) => `Docker context ${name}`,
  testing: (host: string) => `Testing the connection to ${host}…`,
  useHost: (host: string) => `Use ${host}`,
  useLocal: 'Use the Local Docker',
  nowRemote: (host: string, rootless: boolean) =>
    `Devspaces now uses Docker on ${host}.${rootless ? ' Its Docker engine runs rootless: ports below 1024 cannot be published there.' : ''} The docker command in your terminals keeps its Docker context.`,
  nowLocal: 'Devspaces now uses the local Docker.',
  alreadyLocal: 'Devspaces already uses the local Docker.',
  alreadyHost: (host: string) => `Devspaces already uses ${host}.`,
  switchFailed: 'The Docker host of Devspaces could not be changed.',
  /** The title of the choice of the Docker host (the first row of the view). */
  chooseTitle: (host: string) => `Docker host: ${host}`,
  /** The local Docker in that title while Devspaces cannot use it (the current Docker context is not supported). */
  localNotSupported: 'Local Docker (not supported now)',
  /** One list of the hosts and the local Docker. */
  choosePlaceholder: 'Choose a host, enter an SSH address, or use the local Docker',
  current: 'current',
  /** The Docker CLI of this computer talks to the remote host. */
  cliMissing: 'A remote Docker host needs the Docker CLI on this computer. Install Docker first (Docker Desktop brings the CLI).',
  /** The entry of the choice that removes a host from the list, and its own choice. */
  removeHost: 'Remove a Host from the List…',
  removeTitle: 'Remove a Host from the List',
  removePlaceholder: 'Choose the host that Devspaces forgets',
  removed: (host: string, devspaces: number, wasCurrent: boolean) =>
    `${host} is no longer in the list of Devspaces.${
      devspaces > 0 ? ` ${devspaces === 1 ? 'Its devspace stays' : `Its ${devspaces} devspaces stay`} on that computer: add ${host} again to show ${devspaces === 1 ? 'it' : 'them'} in the sidebar.` : ''
    }${wasCurrent ? ' Devspaces now uses the local Docker.' : ''}`,
  /** The offer of a host of a Docker context or of DOCKER_HOST of the user (offerDockerContextHost). */
  offer: (host: string, context: string | undefined) =>
    `Docker on this computer is set to ${host} over SSH (${context === undefined ? 'DOCKER_HOST' : `Docker context ${context}`}). Devspaces keeps its own list of remote hosts and does not follow the Docker context. Use ${host} for Devspaces?`,
  notNow: 'No',
} as const;

export interface RemoteDockerDeps {
  docker: RemoteDockerCli;
  runner: ProcessRunner;
  targets: Pick<DockerTargets, 'resolve' | 'last'>;
  state: RemoteDockerState;
  logger: Logger;
  showLog: () => void;
  /** The concrete hosts of the user's SSH config (parseSshConfig). */
  sshHosts: () => SshHostEntry[];
  /** The path of `ssh` on this computer (findExecutable), or undefined. */
  sshPath: () => string | undefined;
  env: NodeJS.ProcessEnv;
  /** The successes of the SSH check, shared with the operations. */
  sshLogins?: SshLoginCache;
  /** The number of devspaces of this computer on `host` (its registry), for the message of a removed host. */
  devspaceCount?: (host: string) => Promise<number>;
  /** After a change of the Docker host of Devspaces: the sidebar shows the devspaces of the new host. */
  onDidSwitch: () => Promise<void>;
}

interface HostItem extends vscode.QuickPickItem {
  host?: string;
  /** The entry "Use the Local Docker" of the choice of the Docker host. */
  local?: boolean;
  /** The entry "Remove a Host from the List…". */
  remove?: boolean;
}

/** pickHost: the user chose the local Docker, or to remove a host from the list. */
const LOCAL_CHOICE = Symbol('local Docker');
const REMOVE_CHOICE = Symbol('remove a host');

export class RemoteDockerCommands {
  /** The offer that runs now (offerDockerContextHost): its host, and whether this window asks (claimOffer). */
  private offering: { host: string; claimed: Promise<boolean> } | undefined;

  constructor(private readonly deps: RemoteDockerDeps) {}

  /** "Use a Remote Docker Host…": pick, test, use. Never throws. */
  async useRemoteHost(): Promise<void> {
    try {
      if (this.refuseMissingCli()) return;
      const current = await this.deps.state.dockerHost();
      const host = await this.pickHost({ currentHost: current });
      if (host === undefined || host === LOCAL_CHOICE) return;
      if (host === REMOVE_CHOICE) {
        await this.removeHost();
        return;
      }
      if (host === current) {
        this.inform(RemoteDockerTexts.alreadyHost(host));
        return;
      }
      await this.switchToRemote(host);
    } catch (error) {
      this.showFailure(error);
    }
  }

  /**
   * The first row of the sidebar, which names the Docker host (the title bar has no icons for it): another remote host
   * ("Use a Remote Docker Host…") or the local Docker ("Use the Local Docker"), the current one marked. Never throws.
   */
  async chooseDockerHost(): Promise<void> {
    try {
      const current = await this.deps.state.dockerHost();
      // The local Docker as the first row shows it (the last read): one that Devspaces cannot use is not marked current.
      const localSupported = current !== undefined || this.deps.targets.last?.kind !== 'unsupported';
      // One choice: the hosts, the current one marked, and the local Docker last.
      const picked = await this.pickHost({
        title: RemoteDockerTexts.chooseTitle(localSupported ? describeDockerHost(current ?? '') : RemoteDockerTexts.localNotSupported),
        placeHolder: RemoteDockerTexts.choosePlaceholder,
        currentHost: current,
        offerLocal: true,
        localSupported,
      });
      if (picked === undefined) return;
      if (picked === LOCAL_CHOICE) {
        await this.useLocalDocker();
        return;
      }
      if (picked === REMOVE_CHOICE) {
        await this.removeHost();
        return;
      }
      if (picked === current) {
        this.inform(RemoteDockerTexts.alreadyHost(picked));
        return;
      }
      if (this.refuseMissingCli()) return;
      await this.switchToRemote(picked);
    } catch (error) {
      this.showFailure(error);
    }
  }

  /**
   * "Use the Local Docker": Devspaces uses the Docker of this computer again. While it uses it already, it says so, or
   * why that Docker is not supported now. Never throws.
   */
  async useLocalDocker(): Promise<void> {
    try {
      if ((await this.deps.state.dockerHost()) === undefined) {
        await this.reportLocal(await this.deps.targets.resolve(), RemoteDockerTexts.alreadyLocal);
        return;
      }
      await this.switchToLocal();
    } catch (error) {
      this.showFailure(error);
    }
  }

  /**
   * The offer of the host of a Docker context, or of DOCKER_HOST, of the user that reaches a host over SSH while
   * Devspaces uses the local Docker (isDockerContextHostTarget): once per host on this computer (remembered before the
   * question, under the lock of the file, so that another window does not ask it too: RemoteDockerState.claimOffer),
   * "Use <host>" makes it the Docker host of Devspaces as "Use a Remote Docker Host…" does. A host of the list is not
   * offered. Never throws.
   */
  async offerDockerContextHost(target: DockerTarget): Promise<void> {
    if (!isDockerContextHostTarget(target) || this.offering !== undefined) return;
    const host = target.sshHost;
    const claimed = this.claimOffer(host);
    this.offering = { host, claimed };
    try {
      if (!(await claimed)) return;
      this.deps.logger.info(`Docker on this computer is set to ${host} over SSH, which is not in the list of Devspaces; Devspaces offers it once.`);
      const use = RemoteDockerTexts.useHost(host);
      const choice = await showInformationMessage(RemoteDockerTexts.offer(host, target.context), use, RemoteDockerTexts.notNow);
      if (choice !== use || this.refuseMissingCli()) return;
      await this.switchToRemote(host);
    } catch (error) {
      this.showFailure(error);
    } finally {
      this.offering = undefined;
    }
  }

  /**
   * Whether offerDockerContextHost asks about `host`: one that Devspaces can use, and that is neither in the list nor
   * offered before (RemoteDockerState.claimOffer, which remembers it). False when the file cannot be changed (logged).
   */
  private async claimOffer(host: string): Promise<boolean> {
    if (sshTargetOf(host) === undefined) return false;
    try {
      return await this.deps.state.claimOffer(host);
    } catch (error) {
      this.deps.logger.warn(`The offer of ${host} could not be remembered, so it is not shown: ${errorMessage(error)}`);
      return false;
    }
  }

  /** Test, rootless socket, use. True when Devspaces uses `host` afterwards. */
  private async switchToRemote(host: string): Promise<boolean> {
    const check = await withNotificationProgress(
      { title: RemoteDockerTexts.testing(host), cancellable: true },
      async (_progress, token) => {
        const controller = new AbortController();
        const subscription = token.onCancellationRequested(() => controller.abort());
        try {
          const result = await testRemoteDockerHost(
            this.deps.docker,
            host,
            { runner: this.deps.runner, sshPath: this.deps.sshPath(), env: this.deps.env, sshLogins: this.deps.sshLogins },
            { signal: controller.signal },
          );
          // A rootless engine: its socket is read once (ssh, without questions) and recorded with the host.
          if (result.ok) {
            await recordRootlessSocket(host, result.rootless, {
              runner: this.deps.runner,
              state: this.deps.state,
              logger: this.deps.logger,
              sshPath: this.deps.sshPath(),
              env: this.deps.env,
            }, controller.signal);
          }
          return result;
        } finally {
          subscription.dispose();
        }
      },
    );
    if (!check.ok) {
      this.deps.logger.warn(`The Docker host ${host} cannot be reached: ${check.detail}`);
      this.showError(Messages.dockerHostUnreachable(host, dockerHostReason(check.problem, host)));
      return false;
    }
    this.deps.logger.info(`The Docker host ${host} answers: Docker engine ${check.version}${check.rootless ? ' (rootless)' : ''}.`);
    await this.deps.state.setDockerHost(host);
    this.deps.logger.info(`Devspaces uses ${host} (ssh://${host}). No Docker context was changed.`);
    await this.deps.targets.resolve();
    this.inform(RemoteDockerTexts.nowRemote(host, check.rootless));
    await this.afterSwitch();
    return true;
  }

  /** Devspaces uses the local Docker again (reportLocal). */
  private async switchToLocal(): Promise<void> {
    await this.deps.state.setDockerHost(undefined);
    this.deps.logger.info('Devspaces uses the local Docker again.');
    await this.reportLocal(await this.deps.targets.resolve(), RemoteDockerTexts.nowLocal);
    await this.afterSwitch();
  }

  /**
   * Says `local` when the local Docker of Devspaces, as read in `now`, is supported; else its message, except for the
   * SSH host of a context of the user that this window offers now (the read of `now` started the offer, extension.ts).
   */
  private async reportLocal(now: DockerTarget, local: string): Promise<void> {
    if (now.kind === 'local') {
      this.inform(local);
      return;
    }
    this.deps.logger.warn(`The local Docker of Devspaces is not supported now: ${now.endpoint || now.host}`);
    const offering = this.offering;
    const offered = isDockerContextHostTarget(now) && offering?.host === now.sshHost && (await offering.claimed);
    if (!offered) this.showWarning(unsupportedTargetMessage(now));
  }

  /**
   * "Remove a Host from the List…": the chosen host leaves the list; when Devspaces uses it, the local Docker takes its
   * place. Its devspaces stay on that computer, and nothing there is changed.
   */
  private async removeHost(): Promise<void> {
    const { remoteHosts: hosts = [], dockerHost: current } = await this.deps.state.read();
    if (hosts.length === 0) return;
    const picked = await vscode.window.showQuickPick(
      hosts.map((host) => (host === current ? { label: host, description: RemoteDockerTexts.current, host } : { label: host, host })),
      { title: RemoteDockerTexts.removeTitle, placeHolder: RemoteDockerTexts.removePlaceholder },
    );
    if (picked === undefined) return;
    // What the file holds now counts, not what was read before the choice (another window may have changed it).
    const { removed, wasDockerHost } = await this.deps.state.removeHost(picked.host);
    if (!removed) {
      this.deps.logger.info(`${picked.host} is not in the list of Devspaces anymore.`);
      return;
    }
    const count = await (this.deps.devspaceCount?.(picked.host) ?? Promise.resolve(0)).catch((error: unknown) => {
      this.deps.logger.warn(`The devspaces on ${picked.host} could not be counted: ${errorMessage(error)}`);
      return 0;
    });
    this.deps.logger.info(`${picked.host} was removed from the list of Devspaces (${count} devspaces on it).`);
    this.inform(RemoteDockerTexts.removed(picked.host, count, wasDockerHost));
    if (!wasDockerHost) return;
    await this.deps.targets.resolve();
    await this.afterSwitch();
  }

  /** No Docker CLI on this computer: says so, true when refused. */
  private refuseMissingCli(): boolean {
    if (this.deps.docker.isInstalled()) return false;
    this.deps.logger.warn('No Docker CLI on this computer; no remote Docker host is set.');
    this.showError(RemoteDockerTexts.cliMissing);
    return true;
  }

  /**
   * A host or a typed SSH address: the hosts of the list of Devspaces, then the other hosts of the SSH config, then the
   * SSH hosts of the Docker contexts of the user (each host once); `currentHost` is marked. "Remove a Host from the
   * List…" when the list has a host. With `offerLocal` (the choice of the first row of the sidebar), the local Docker is
   * the last entry (LOCAL_CHOICE), marked when no host is current and `localSupported` is not false.
   */
  private async pickHost(
    options: { title?: string; placeHolder?: string; currentHost?: string; offerLocal?: boolean; localSupported?: boolean },
  ): Promise<string | typeof LOCAL_CHOICE | typeof REMOVE_CHOICE | undefined> {
    let entries: SshHostEntry[] = [];
    try {
      entries = this.deps.sshHosts();
    } catch (error) {
      this.deps.logger.warn(`The SSH config could not be read: ${errorMessage(error)}`);
    }
    const [listed, contextHosts] = await Promise.all([this.deps.state.remoteHosts(), this.contextHosts()]);
    const shown = new Set<string>();
    const item = (host: string, description: string | undefined): HostItem => {
      shown.add(host);
      if (host !== options.currentHost) return { label: host, description, host };
      return { label: `$(check) ${host}`, description: description ? `${description} · ${RemoteDockerTexts.current}` : RemoteDockerTexts.current, host };
    };
    const describe = (host: string): string | undefined => {
      const entry = entries.find((candidate) => candidate.alias === host);
      return entry === undefined ? undefined : describeEntry(entry);
    };
    const groups: Array<{ label: string; items: HostItem[] }> = [
      { label: RemoteDockerTexts.listGroup, items: listed.map((host) => item(host, describe(host))) },
      { label: RemoteDockerTexts.sshConfigGroup, items: entries.filter((entry) => !shown.has(entry.alias)).map((entry) => item(entry.alias, describeEntry(entry))) },
      {
        label: RemoteDockerTexts.contextGroup,
        items: contextHosts.filter((entry) => !shown.has(entry.host)).map((entry) => item(entry.host, RemoteDockerTexts.dockerContext(entry.context))),
      },
    ];
    const items: HostItem[] = [];
    for (const group of groups) {
      if (group.items.length === 0) continue;
      items.push({ label: group.label, kind: vscode.QuickPickItemKind.Separator }, ...group.items);
    }
    if (items.length > 0) items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: RemoteDockerTexts.enterAddress, description: RemoteDockerTexts.enterAddressDetail });
    if (listed.length > 0) items.push({ label: RemoteDockerTexts.removeHost, remove: true });
    if (options.offerLocal) {
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
      // The local Docker is marked when it is current and Devspaces can use it.
      items.push(
        options.currentHost === undefined && options.localSupported !== false
          ? { label: `$(check) ${RemoteDockerTexts.useLocal}`, description: RemoteDockerTexts.current, local: true }
          : { label: `$(${MonitorIcons.off}) ${RemoteDockerTexts.useLocal}`, local: true },
      );
    }
    const picked = await vscode.window.showQuickPick(items, {
      title: options.title ?? RemoteDockerTexts.pickTitle,
      placeHolder: options.placeHolder ?? RemoteDockerTexts.pickPlaceholder,
      matchOnDescription: true,
    });
    if (!picked) return undefined;
    if (picked.local) return LOCAL_CHOICE;
    if (picked.remove) return REMOVE_CHOICE;
    if (picked.host !== undefined) return picked.host;
    const typed = await vscode.window.showInputBox({
      title: RemoteDockerTexts.pickTitle,
      prompt: RemoteDockerTexts.addressPrompt,
      placeHolder: 'me@build-box',
      ignoreFocusOut: true,
      validateInput: (value: string) => {
        const parsed = parseSshAddress(value);
        return parsed.ok ? undefined : RemoteDockerTexts.addressProblem(parsed.problem);
      },
    });
    if (typed === undefined) return undefined;
    const parsed = parseSshAddress(typed);
    if (!parsed.ok) {
      this.showError(RemoteDockerTexts.addressProblem(parsed.problem));
      return undefined;
    }
    return parsed.address;
  }

  /** The SSH hosts of the Docker contexts of the user (sshHostsOfContexts); none when they cannot be listed (logged). */
  private async contextHosts(): Promise<Array<{ host: string; context: string }>> {
    if (!this.deps.docker.isInstalled()) return [];
    try {
      return await sshHostsOfContexts(this.deps.docker);
    } catch (error) {
      this.deps.logger.warn(`The Docker contexts could not be listed: ${errorMessage(error)}`);
      return [];
    }
  }

  private async afterSwitch(): Promise<void> {
    await this.deps.onDidSwitch().catch((error: unknown) => this.deps.logger.error('Could not update the sidebar.', error));
  }

  private showFailure(error: unknown): void {
    if (isAbortError(error)) {
      this.deps.logger.info('The change of the Docker host was cancelled.');
      return;
    }
    if (isUserFacingError(error)) {
      this.deps.logger.error(error.message, error);
      this.showError(error.message);
      return;
    }
    this.deps.logger.error(RemoteDockerTexts.switchFailed, error);
    this.showError(RemoteDockerTexts.switchFailed);
  }

  private showError(message: string): void {
    showErrorMessage(message, Actions.showDetails).then(
      (choice) => {
        if (choice === Actions.showDetails) this.deps.showLog();
      },
      (error: unknown) => this.deps.logger.error('Could not show the message.', error),
    );
  }

  private showWarning(message: string): void {
    showWarningMessage(message, Actions.showDetails).then(
      (choice) => {
        if (choice === Actions.showDetails) this.deps.showLog();
      },
      (error: unknown) => this.deps.logger.error('Could not show the message.', error),
    );
  }

  private inform(message: string): void {
    showInformationMessage(message).then(undefined, (error: unknown) => this.deps.logger.error('Could not show the message.', error));
  }
}

/** HostName and User of an entry, for the quick pick: `me@build-box.example.com:2222`. */
export function describeEntry(entry: SshHostEntry): string | undefined {
  if (entry.hostName === undefined && entry.user === undefined && entry.port === undefined) return undefined;
  const user = entry.user !== undefined ? `${entry.user}@` : '';
  const port = entry.port !== undefined ? `:${entry.port}` : '';
  return `${user}${entry.hostName ?? entry.alias}${port}`;
}
