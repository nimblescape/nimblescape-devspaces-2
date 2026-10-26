// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Pure model of the sidebar: one list of repositories, grouped by owner. This module never imports `vscode`, so the
// rules for rows, states, actions, and sorting are unit-tested; treeView.ts only maps the model to tree items.
import { defaultImageOf, hasConfiguration, isSourceOf, possibleSources, sourceKey, sourceLabel, sourceOf } from '../core/devspaceSource';
import { filterRepositories } from '../core/discovery/discoveryService';
import { isOnDockerHost } from '../core/docker/dockerHost';
import { hostAccessChecks, type HostAccessChecks } from '../core/policy/hostAccessChecks';
import { formatChanges, Messages, StateTexts } from '../core/messages';
import { DEFAULT_CONFIG_PATH } from '../core/pipeline/recordRules';
import { keepFlagsOf, keptWhenClosed } from '../core/session/sessionRules';
import type {
  BusyOperation,
  ContainerState,
  DiscoveryData,
  Devspace,
  DevspaceSource,
  DevspaceState,
  ExtensionSettings,
  RepositoryInfo,
} from '../core/types';
import { matchRepositoryGroup, type RepositoryGroupMatch, type RepositoryGroupPattern } from './repositoryGroups';

// User-visible texts that messages.ts lacks; to be moved there.
export const TreeTexts = {
  branch: (branch: string) => `Branch: ${branch}`,
  defaultBranch: (branch: string) => `Default branch: ${branch}`,
  /** Tooltip line of a row of the default image (DevspaceSource `defaultImage`): the image. */
  sourceDefaultImage: (image: string) => `Source: the default image ${image}`,
  /** Tooltip line of a row of a configuration (DevspaceSource `configuration`): its path in the repository. */
  sourceConfiguration: (configPath: string) => `Source: the configuration ${configPath}`,
  /** The brackets of the description of the one row of a repository whose devspace is the default-image devspace. */
  defaultImageShort: 'default image',
  lastUsed: (time: string) => `Last used: ${time}`,
  noDevspace: 'No devspace yet. Start creates it on the default branch.',
  noConfiguration: 'No Dev Container configuration: Start uses the default image.',
  /** Tooltip of a repository with child rows: each child row is one source. */
  sources: (count: number) => `${count} sources. Each child row is its own devspace.`,
  notListedOnGitHub: 'GitHub does not list this repository.',
  archived: 'Archived repository',
  /** Tooltip line of a kept devspace (Keep Running When Closed). */
  kept: 'Keeps running when closed: stop it yourself.',
  /** Tooltip line of a devspace closed with Close and Keep Running. */
  keptOnce: 'Keeps running this time: it stops when a window uses it and closes again, or when you stop it.',
  /** Tooltip line of a devspace that a setting keeps running when closed (the heartbeats say keepRunning). */
  keptByStopOnClose: 'Keeps running when closed: the setting Stop On Close is off. Stop it yourself.',
  keptByShutdownAction: 'Keeps running when closed: its configuration says "shutdownAction": "none" and the setting Respect Shutdown Action None is on. Stop it yourself.',
  /**
   * Tooltip line of a devspace whose dev container does not run while another of its containers does (another
   * service of Docker Compose or another dev container of the devspace, servicesRunning).
   */
  servicesRunning: 'Other containers of the devspace run. Stop stops them.',
  /**
   * Why the state of the devspaces on an engine is unknown (StatesUnknown), in short words: in brackets after the
   * state text, for example `State unknown (Docker not ready)` (docs/guide.md quotes these texts).
   */
  unknownShort: (engine: string, reason: StatesUnknownReason) =>
    reason === 'unreachable' ? `${engine} cannot be reached` : reason === 'removed' ? `Devspaces removed from ${engine}` : `${engine} not ready`,
  /** The tooltip line of a devspace whose state is unknown. */
  unknownDetail: (engine: string, reason: StatesUnknownReason) => {
    switch (reason) {
      case 'unreachable':
        return `${engine} cannot be reached, so the state of the devspace is not known.`;
      case 'building':
        return `${engine} not ready: the helper image is being built.`;
      case 'buildFailed':
        return `${engine} not ready: the helper image could not be built (see the Devspaces output). Start builds it.`;
      case 'notReady':
        return `${engine} not ready: the state could not be read (see the Devspaces output).`;
      case 'removed':
        return `Devspaces was removed from ${engine}, so the state of the devspace is not read. A Start of the devspace sets Devspaces up there again.`;
    }
  },
  /** Label of the sign-in row (the title of the command devspaces.signIn). */
  signIn: 'Sign in with GitHub',
  /** Tooltip of the sign-in row: the text of the sign-in in the welcome view (package.json viewsWelcome), without its button. */
  signInTooltip:
    'Sign in with GitHub to see your repositories that have a Dev Container configuration.\n' +
    'Devspaces asks for the scopes repo (read and change the repositories that you can access, also the private ones) and read:org (read your organization memberships). It works only with accounts on github.com.',
} as const;

/** Container and volume state of one devspace, as Docker reports it. */
export interface DevspaceRuntime {
  /** The state of the dev container (not of the other services of Docker Compose). */
  container: ContainerState;
  volume: boolean;
  /**
   * Another container of the devspace runs: a container of another service of Docker Compose, or another dev
   * container of the devspace.
   */
  servicesRunning?: boolean;
}

/**
 * Why the last refresh could not read the states on an engine. `unreachable`: the remote engine does not answer;
 * `building`: the engine answers, and its helper image is being built in the background (MissingHelperBuild);
 * `buildFailed`: its last background build failed; `notReady`: the worker could not read the states for another cause;
 * `removed`: the engine has the removal mark of "Remove Devspaces from This Docker Engine…", so Docker is not asked.
 */
export type StatesUnknownReason = 'unreachable' | 'building' | 'buildFailed' | 'notReady' | 'removed';

/** The engine whose states the last refresh could not read, and why. */
export interface StatesUnknown {
  /** The Docker host of the engine ('' = the local Docker). */
  dockerHost: string;
  reason: StatesUnknownReason;
}

export interface TreeInput {
  /** Stored or fresh result of the discovery. `undefined` while no list is loaded. */
  discovery: DiscoveryData | undefined;
  /**
   * `hostAccessChecksOff`: the repositories whose host access checks are off (a marker and a warning in the row).
   * `showOnlyDevspaces`: only the rows of devspaces, without the other repositories and the hints. `defaultImage`: with
   * one, the repositories without a Dev Container configuration are listed too (their devspaces start from it), and
   * every repository gets the row of the default image. `startWithDefaultImage`: the default image is the first child
   * row (on, the default) or the last one (off).
   */
  settings: Pick<ExtensionSettings, 'owners' | 'includeArchived' | 'includeForks'> &
    Partial<Pick<ExtensionSettings, 'hostAccessChecksOff' | 'stopOnClose' | 'respectShutdownActionNone' | 'showOnlyDevspaces' | 'defaultImage' | 'startWithDefaultImage'>>;
  /**
   * The entries of the Devspace Registry that the signed-in account may use (`availableDevspaces`). Devspaces
   * of another account are never passed, so no row, name, or count reveals them.
   */
  devspaces: readonly Devspace[];
  /** Container and volume state per devspace ID. `undefined`: Docker is not running or not asked yet. */
  runtime: ReadonlyMap<string, DevspaceRuntime> | undefined;
  /**
   * The last refresh could not read the states on this engine. The rows of its devspaces show `State unknown` with
   * the reason, not the state that the registry alone gives (except while an operation runs: Updating); their state and
   * actions stay as they are (Start works). Not set: every row shows its state.
   */
  statesUnknown?: StatesUnknown;
  /** Devspace of this window. */
  currentDevspaceId: string | null;
  /** Devspaces of other live windows. */
  otherWindowDevspaceIds: ReadonlySet<string>;
  /** Devspaces with a busy mark whose owner process is alive. */
  busyDevspaceIds: ReadonlySet<string>;
  /** Devspace ID → branch read from the running container. */
  liveBranches: ReadonlyMap<string, string>;
  signedIn: boolean;
  /**
   * Compiled entries of the setting `repositoryGroups` (`parseRepositoryGroups`). Empty or missing: no grouping, the
   * model is the same as without the setting.
   */
  repositoryGroups?: readonly RepositoryGroupPattern[];
  /**
   * The place of a repository name under `repositoryGroups`, as matchRepositoryGroup finds it. The sidebar gives the
   * places that its worker thread found (groupMatcher.ts), so that no regular expression of the setting runs on the
   * extension host. Default: matchRepositoryGroup, which runs them here (the worker of the editor's preview).
   */
  groupMatch?: (name: string) => RepositoryGroupMatch | undefined;
  /**
   * Results of single repository lookups on GitHub (`DiscoveryService.getRepository`) for devspaces whose repository
   * the discovery does not list (outside of its scan, or not visible to the account). Key: lower-case
   * `owner/name`. A `RepositoryInfo`: GitHub has the repository (no `not on GitHub`, Show on GitHub). `null`: GitHub
   * does not return it (not found, or no access), so the row shows `not on GitHub`.
   * When the map is given, a devspace whose repository is neither in the discovery nor in the map is unknown (for
   * example the lookup failed) and shows no `not on GitHub`. Without the map, every devspace that the discovery does
   * not list shows `not on GitHub`.
   */
  repositoryLookups?: ReadonlyMap<string, RepositoryInfo | null>;
  /** Formats the time of the last use for the tooltip. Default: the local date and time format. */
  formatTime?: (isoTime: string) => string;
}

/** Actions that a row offers. The flags of `contextValue` are made from these. */
export interface RowActions {
  canStart: boolean;
  canStop: boolean;
  canDelete: boolean;
  canRebuild: boolean;
  /** The discovery lists the repository: Show on GitHub. */
  onGitHub: boolean;
}

/**
 * A row of one source of a repository (DevspaceSource): the one row of a repository with one possible source, or a
 * child row of a repository with several (RepositoryNode). The row carries the devspace of its source, if it exists.
 */
export interface RepositoryRow {
  kind: 'repository';
  /**
   * Stable tree item ID: `repo:` + lower-case owner/name for the one row of a repository; `repo:<owner/name>:<source
   * key>` (sourceKey) for a child row; with the suffix `#<devspace ID>` for the second and further devspaces of one
   * source (one per Docker host).
   */
  id: string;
  /** `owner/name`, with the case that GitHub uses when the discovery lists it. */
  repository: string;
  owner: string;
  name: string;
  /** From the discovery. */
  info?: RepositoryInfo;
  /** The source of the row: what Start builds its devspace from, or what its devspace was built from. */
  source: DevspaceSource;
  /** The row is a child row of its repository (RepositoryNode): its label is the word of its source. */
  child: boolean;
  devspace?: Devspace;
  /** `undefined`: the row has no devspace (no symbol). */
  state?: DevspaceState;
  /**
   * The last refresh could not read the state of the devspace (TreeInput.statesUnknown); the row shows
   * `State unknown`, and `state` is the state that its actions are made from.
   */
  stateUnknown?: true;
  /** Branch shown in the row, if known. */
  branch?: string;
  /** The row has a devspace, and GitHub does not list its repository. */
  notOnGitHub: boolean;
  /**
   * The switch of the host access checks of the repository (setting devspaces.hostAccessChecksOff): `off` shows the
   * marker `host access unrestricted` and a warning in the tooltip, and offers Turn On Host Access Checks instead of
   * Turn Off Host Access Checks….
   */
  hostAccessChecks: HostAccessChecks;
  actions: RowActions;
  /** The repository name, or the word of the source of a child row (sourceLabel). */
  label: string;
  /** For example `main   Stopped · 3 unpushed`, `main (default image)   Connected`, or `` for a row without devspace. */
  description: string;
  /** Includes the source and the time of the last use. */
  tooltip: string;
  /**
   * `repository;canStart;canStop;canDelete;canRebuild;onGitHub;hostAccessChecked;canKeepRunning`, only the flags that
   * apply (package.json menus); `hostAccessUnrestricted` in place of `hostAccessChecked` while the checks are off;
   * `kept` in place of `canKeepRunning` for a kept devspace; neither without a devspace; and `canCloseAndKeepRunning`
   * for the devspace of this window.
   */
  contextValue: string;
}

/**
 * A repository with two or more possible sources (possibleSources): a level of the tree only, with one child row per
 * source. It has no state, no description, no buttons and no menu: everything of a repository row is on its children.
 * A double-click or Enter on it starts its first child row (rowActivation.ts).
 */
export interface RepositoryNode {
  kind: 'repositoryNode';
  /** `repo:` + lower-case owner/name. */
  id: string;
  repository: string;
  owner: string;
  name: string;
  info?: RepositoryInfo;
  /** The repository name. */
  label: string;
  tooltip: string;
  /** Initial state in the view: expanded while a child row has a devspace, so that its state and buttons show. */
  expanded: boolean;
  /** One row per source, in the order of possibleSources; a source with several devspaces (one per Docker host) has a row per devspace. */
  children: RepositoryRow[];
}

/** A repository in the tree: its one row, or its node with child rows. */
export type RepositoryEntry = RepositoryRow | RepositoryNode;

/** Organization whose repositories GitHub did not return. The row opens `url` (action Authorize). */
export interface HintRow {
  kind: 'hint';
  /** `hint:` + lower-case organization. */
  id: string;
  organization: string;
  /** Set for an owner of the scan scope that GitHub did not return: the row opens its page, there is nothing to authorize. */
  notFound?: true;
  /** `Messages.organizationNotAuthorized(organization)`, or `Messages.organizationNotFound(organization)`. */
  label: string;
  url: string;
}

/**
 * Row at the top of the view when the user is not signed in but the view lists devspaces: the welcome view with its
 * sign-in button only shows while the view is empty.
 */
export interface SignInRow {
  kind: 'signIn';
  id: typeof SIGN_IN_ROW_ID;
  label: string;
  tooltip: string;
}

export const SIGN_IN_ROW_ID = 'signIn';

export interface OwnerGroup {
  kind: 'owner';
  /** `owner:` + lower-case owner. */
  id: string;
  owner: string;
  /**
   * Hints first, then the repositories in alphabetical order, with or without a devspace. With the setting
   * `repositoryGroups`, when a repository of the owner matches a pattern: hints first, then the nodes and rows in the
   * order of the patterns that put them there (within one pattern group nodes before rows, each alphabetically), then
   * the repositories with a devspace that match no pattern. When no repository of the owner matches, the plain
   * list.
   */
  children: Array<RepositoryEntry | HintRow | GroupNode>;
}

/**
 * Node of the setting `repositoryGroups`: the root node of an entry with a `name` (`level` 0), or a group level made
 * from a capturing group of a pattern (`level` 1 is the top level).
 */
export interface GroupNode {
  kind: 'group';
  /**
   * `group:` + lower-case owner + `:` + the index of the named entry in the setting (`-` for the levels of unnamed
   * entries) + `:` + the level values from the top down, each URI-encoded and joined by `/` (empty for a named root).
   */
  id: string;
  owner: string;
  /** 0 for the root of a pattern; 1 for the top group level, and so on. */
  level: number;
  /** A named root: the name of the entry. A level: the value of its capturing group. */
  label: string;
  /** A named root: the pattern text. */
  tooltip?: string;
  /**
   * Initial state in the view: a named root is expanded; a group level is collapsed, except when it holds the row of the
   * devspace of this window.
   */
  expanded: boolean;
  /** In the order of the patterns that put them here, then group nodes before rows, then alphabetically (groupRows). */
  children: Array<GroupNode | RepositoryEntry>;
}

/**
 * Icon of a state, as a codicon ID or an icon of the extension (package.json contributes.icons), and an optional theme
 * color ID.
 */
export interface StateIcon {
  id: string;
  color?: string;
}

/**
 * The monitors of the extension (package.json contributes.icons, the font resources/icons/devspace-icons.woff, built by
 * scripts/build-icon-font.py). An icon font, so VS Code colors them like the codicons (theme, selected row, high
 * contrast), also in Quick Picks and the status bar.
 */
export const MonitorIcons = {
  off: 'devspaces-monitor-off',
  on: 'devspaces-monitor-on',
  connected: 'devspaces-monitor-connected',
  /** The header row of a remote Docker host. */
  remote: 'devspaces-monitor-remote',
  // The other states, with the badges of the codicons vm-running (play), vm-pending (clock), vm-outline (ring), and a
  // warning sign.
  running: 'devspaces-monitor-running',
  updating: 'devspaces-monitor-updating',
  noContainer: 'devspaces-monitor-no-container',
  /** Files missing, and the header row of a Docker endpoint that is not supported. */
  warning: 'devspaces-monitor-warning',
} as const;

const STATE_ICONS: Record<DevspaceState, StateIcon> = {
  // A monitor for the three states of a window, all with the frame of the codicon `vm` at the same place, so the
  // connection sign does not move it (the monitor icons are left aligned). A disconnected one is the silhouette only
  // (switched off), connected in another window the screen is filled inside a line (switched on), connected in this
  // window with a small connection sign of `vm-connect`. No codicon is a filled monitor.
  connected: { id: MonitorIcons.connected },
  connectedOtherWindow: { id: MonitorIcons.on },
  // The other states are the switched-off monitor (no window uses it; a running devspace must not look like a
  // connected one) with a sign: play while its container runs, a clock while it is updated, a ring without container, a
  // warning without files.
  noContainer: { id: MonitorIcons.noContainer },
  running: { id: MonitorIcons.running },
  stopped: { id: MonitorIcons.off },
  // Not animated: `~spin` would turn the whole monitor; the clock marks the work.
  updating: { id: MonitorIcons.updating },
  filesMissing: { id: MonitorIcons.warning, color: 'list.warningForeground' },
};

/**
 * Icon of a state: a switched-on monitor with the connection sign connected (this window), a switched-on monitor
 * connected in another window, and a switched-off monitor otherwise: plain when stopped, with a play sign running, a
 * clock updating, a ring without container, a warning without files.
 */
export function stateIcon(state: DevspaceState): StateIcon {
  return STATE_ICONS[state];
}

/** State text of a state, for example `Connected · other window`. */
export function stateText(state: DevspaceState): string {
  return StateTexts[state];
}

/**
 * State text of a row: the text of the state, with the suffix ` · kept` for a kept devspace (Keep Running When
 * Closed), for example `Running · kept`, `Connected · kept`, or `Stopped · kept` (the user sees that the next start
 * keeps it running). The suffix shows in every state, as the menu offers Stop When Closed in every state, also
 * `No container · kept` and `Updating · kept`. A tree item has one icon only, so the icon stays the one of the state,
 * and the text marks the kept devspace.
 */
export function rowStateText(state: DevspaceState, kept: boolean): string {
  return kept ? `${stateText(state)} · ${StateTexts.kept}` : stateText(state);
}

type StateInput = Pick<TreeInput, 'runtime' | 'currentDevspaceId' | 'otherWindowDevspaceIds' | 'busyDevspaceIds'>;

/**
 * State of a devspace. Precedence: busy → updating; volume known to be missing → files missing; this window →
 * connected; another window → connected · other window; then the container state (running, stopped, no container).
 * Without runtime data (Docker not running or not asked yet) the registry decides: connected when a window references
 * the devspace, otherwise stopped. A window counts as connected only while the container may run: when Docker
 * reports the container stopped or missing, the connection is lost, and the row shows the container state (so Start can
 * reconnect).
 */
export function devspaceState(devspace: Devspace, input: StateInput): DevspaceState {
  if (input.busyDevspaceIds.has(devspace.id)) return 'updating';
  const runtime = input.runtime?.get(devspace.id);
  if (runtime && !runtime.volume) return 'filesMissing';
  const containerMayRun = runtime === undefined || runtime.container === 'running';
  if (containerMayRun && input.currentDevspaceId === devspace.id) return 'connected';
  if (containerMayRun && input.otherWindowDevspaceIds.has(devspace.id)) return 'connectedOtherWindow';
  if (!runtime) return 'stopped';
  switch (runtime.container) {
    case 'running':
      return 'running';
    case 'stopped':
      return 'stopped';
    case 'missing':
      return 'noContainer';
  }
}

/** True for the states in which the container runs. */
export function containerRuns(state: DevspaceState | undefined): boolean {
  return state === 'connected' || state === 'connectedOtherWindow' || state === 'running';
}

/**
 * Actions of a row. `state` is `undefined` for a row without devspace. `busyOperation` is the operation of the live
 * busy mark while the state is `updating`. Delete is possible in every state; during an operation of another window it
 * runs after that operation, and it is hidden only while the devspace is being deleted. Start, Stop, and Rebuild are
 * hidden while the devspace is updating: a busy devspace is in use and must not be stopped or changed.
 */
export function rowActions(
  state: DevspaceState | undefined,
  info: RepositoryInfo | undefined,
  busyOperation?: BusyOperation,
  servicesRunning = false,
): RowActions {
  const hasDevspace = state !== undefined;
  return {
    canStart: state !== 'connected' && state !== 'updating',
    // Also while only other services of Docker Compose or another dev container of the devspace run (the dev
    // container is stopped).
    canStop: containerRuns(state) || (servicesRunning && hasDevspace && state !== 'updating'),
    canDelete: hasDevspace && !(state === 'updating' && busyOperation === 'delete'),
    canRebuild: hasDevspace && state !== 'updating',
    onGitHub: info !== undefined,
  };
}

/**
 * `contextValue` of a repository row; the `when` clauses in package.json match these flags. `checks`: the switch of the
 * host access checks of the repository, the flag `hostAccessChecked` (Turn Off Host Access Checks…) or
 * `hostAccessUnrestricted` (Turn On Host Access Checks); none without it. `kept`: the switch Keep Running When Closed of
 * the devspace, the flag `kept` (Stop When Closed) or `canKeepRunning` (Keep Running When Closed); none for a row
 * without devspace. `connectedHere`: the devspace of this window, the flag `canCloseAndKeepRunning` (Close and
 * Keep Running).
 */
export function contextValue(actions: RowActions, checks?: HostAccessChecks, kept?: boolean, connectedHere = false): string {
  const flags = ['repository'];
  if (actions.canStart) flags.push('canStart');
  if (actions.canStop) flags.push('canStop');
  if (actions.canDelete) flags.push('canDelete');
  if (actions.canRebuild) flags.push('canRebuild');
  if (actions.onGitHub) flags.push('onGitHub');
  if (checks === 'on') flags.push('hostAccessChecked');
  if (checks === 'off') flags.push('hostAccessUnrestricted');
  if (kept === true) flags.push('kept');
  if (kept === false) flags.push('canKeepRunning');
  if (connectedHere) flags.push('canCloseAndKeepRunning');
  return flags.join(';');
}

/** The `contextValue` of a repository node (RepositoryNode): no flag of a row, so no row action applies to it. */
export const REPOSITORY_NODE_CONTEXT = 'sources';

/**
 * The sidebar model: the repositories of the discovery (filtered by the settings; with a default image also those
 * without a Dev Container configuration) plus every repository that has a devspace. Devspaces are always listed, also
 * when the settings filter their repository out, when GitHub does not list the repository (`not on GitHub`), and when
 * the user is not signed in, because they hold the user's work. Without a sign-in, and with the setting
 * `showOnlyDevspaces`, only the devspaces are listed. A repository with one possible source (possibleSources) is one
 * row; one with several is a node with a child row per source (repositoryEntries). Groups are sorted by owner; in each
 * group, hints come first, then all repositories in alphabetical order: a repository with a devspace keeps its place.
 * With valid entries of the setting `repositoryGroups`, the rows of each owner where a repository matches are filtered
 * and nested in group nodes (`groupRows`); other owners, and every owner without valid entries, keep the plain list.
 */
export function buildTreeModel(input: TreeInput): OwnerGroup[] {
  // With a default image, the repositories without a configuration get rows too; their data serves every row.
  const withoutConfiguration = input.discovery?.withoutConfiguration ?? [];
  const discovered = [...(input.discovery?.repositories ?? []), ...(defaultImageOf(input.settings) !== undefined ? withoutConfiguration : [])];
  const infoByKey = new Map<string, RepositoryInfo>();
  for (const info of [...discovered, ...withoutConfiguration]) {
    const key = info.nameWithOwner.toLowerCase();
    if (!infoByKey.has(key)) infoByKey.set(key, info);
  }

  interface GroupParts {
    group: OwnerGroup;
    hints: HintRow[];
    devspaces: RepositoryEntry[];
    others: RepositoryEntry[];
  }
  const groups = new Map<string, GroupParts>();
  const groupFor = (owner: string) => {
    const key = owner.toLowerCase();
    let entry = groups.get(key);
    if (!entry) {
      entry = { group: { kind: 'owner', id: `owner:${key}`, owner, children: [] }, hints: [], devspaces: [], others: [] };
      groups.set(key, entry);
    }
    return entry;
  };

  // The devspaces of each repository, most recently used first, so that the plain row ID goes to that devspace when
  // the registry holds two devspaces of one source (one per Docker host; tree item IDs must be unique).
  const devspacesByKey = new Map<string, Devspace[]>();
  for (const devspace of [...input.devspaces].sort((a, b) => timeValue(b.lastUsedAt) - timeValue(a.lastUsedAt))) {
    const key = devspace.repository.toLowerCase();
    const list = devspacesByKey.get(key);
    if (list) list.push(devspace);
    else devspacesByKey.set(key, [devspace]);
  }
  for (const [key, devspaces] of devspacesByKey) {
    const lookup = input.repositoryLookups?.get(key);
    const info = infoByKey.get(key) ?? lookup ?? undefined;
    const confirmedMissing = input.repositoryLookups === undefined || lookup === null;
    for (const entry of repositoryEntries(key, info, devspaces, confirmedMissing, input)) groupFor(entry.owner).devspaces.push(entry);
  }

  if (input.signedIn && input.discovery && input.settings.showOnlyDevspaces !== true) {
    // A repository once, also when the discovery lists it twice (tree item IDs must be unique).
    const listed = new Set<string>();
    for (const info of filterRepositories(discovered, input.settings)) {
      const key = info.nameWithOwner.toLowerCase();
      if (devspacesByKey.has(key) || listed.has(key)) continue;
      listed.add(key);
      for (const entry of repositoryEntries(key, info, [], false, input)) groupFor(entry.owner).others.push(entry);
    }

    const owners = ownerFilter(input.settings.owners);
    const hintIds = new Set<string>();
    for (const hint of input.discovery.hints) {
      const key = hint.organization.toLowerCase();
      if (key === '' || (owners.size > 0 && !owners.has(key))) continue;
      const id = `hint:${key}`;
      if (hintIds.has(id)) continue;
      hintIds.add(id);
      groupFor(hint.organization).hints.push({
        kind: 'hint',
        id,
        organization: hint.organization,
        ...(hint.kind === 'notFound' ? { notFound: true as const } : {}),
        label:
          hint.kind === 'notFound'
            ? Messages.organizationNotFound(hint.organization)
            : Messages.organizationNotAuthorized(hint.organization),
        url: hint.url,
      });
    }
  }

  const byName = (a: RepositoryEntry, b: RepositoryEntry) => compareNames(a.name, b.name) || compareNames(a.id, b.id);
  const patterns = input.repositoryGroups ?? [];
  const groupMatch = input.groupMatch ?? ((name: string) => matchRepositoryGroup(patterns, name));
  return [...groups.values()]
    .sort((a, b) => compareNames(a.group.owner, b.group.owner))
    .map(({ group, hints, devspaces: withDevspace, others }) => {
      hints.sort((a, b) => compareNames(a.organization, b.organization));
      // Patterns apply per owner: an owner where no repository matches a pattern keeps the plain list, so no owner is
      // hidden by the patterns; without patterns, the model is exactly the plain list.
      const grouped =
        patterns.length > 0 ? groupRows(group.owner, withDevspace, others, groupMatch, input.currentDevspaceId) : undefined;
      group.children = [...hints, ...(grouped ?? [...withDevspace, ...others].sort(byName))];
      return group;
    });
}

/**
 * The entries of one repository (key: lower-case `owner/name`) with its devspaces of the signed-in account
 * (`devspaces`, most recently used first; empty for a repository without one): its one row when it has one possible
 * source (possibleSources), with a row per devspace when several devspaces (one per Docker host) have that source; else
 * its node with a child row per source. A repository that GitHub does not list (`info` missing) shows only the sources
 * of its devspaces (possibleSources).
 */
function repositoryEntries(key: string, info: RepositoryInfo | undefined, devspaces: readonly Devspace[], confirmedMissing: boolean, input: TreeInput): RepositoryEntry[] {
  const repository = info?.nameWithOwner ?? devspaces[0]?.repository ?? key;
  // The host access checks of the repository are read under the registry name of its devspaces (the name the pipeline
  // reads, which keeps the old name after a rename or a transfer on GitHub), on every row of the repository alike.
  const checksName = devspaces[0]?.repository ?? repository;
  const sources = possibleSources({ info, devspaces, settings: input.settings });
  const baseId = `repo:${key}`;
  const rowsOf = (source: DevspaceSource, id: string, child: boolean): RepositoryRow[] => {
    const matching = devspaces.filter((devspace) => isSourceOf(devspace, source));
    if (matching.length === 0) return [repositoryRow(id, repository, checksName, info, source, child, input)];
    return matching.map((devspace, index) => devspaceRow(index === 0 ? id : `${id}#${devspace.id}`, devspace, info, source, child, confirmedMissing, input));
  };
  if (sources.length <= 1) {
    // A listed repository without a known configuration and without a default image (a list of an older version):
    // Start finds its configuration after the clone.
    const source: DevspaceSource = sources[0] ?? { kind: 'configuration', configPath: devspaces[0]?.configPath ?? DEFAULT_CONFIG_PATH };
    return rowsOf(source, baseId, false);
  }
  const children = sources.flatMap((source) => rowsOf(source, `${baseId}:${sourceKey(source)}`, true));
  const { owner, name } = info ? { owner: info.owner, name: info.name } : splitName(repository);
  const tooltip = [repository, TreeTexts.sources(sources.length), info?.isArchived ? TreeTexts.archived : undefined].filter(isText).join('\n');
  return [{ kind: 'repositoryNode', id: baseId, repository, owner, name, info, label: name, tooltip, expanded: children.some((row) => row.devspace !== undefined), children }];
}

/** Whether a repository entry carries a devspace: the row has one, or a child row of the node has one. */
function hasDevspace(entry: RepositoryEntry): boolean {
  return entry.kind === 'repository' ? entry.devspace !== undefined : entry.children.some((row) => row.devspace !== undefined);
}

/** Whether a repository entry carries the devspace of this window. */
function holdsCurrent(entry: RepositoryEntry, currentDevspaceId: string | null): boolean {
  if (currentDevspaceId === null) return false;
  return entry.kind === 'repository' ? entry.devspace?.id === currentDevspaceId : entry.children.some((row) => row.devspace?.id === currentDevspaceId);
}

/**
 * The rows of one owner under the patterns of the setting `repositoryGroups`, or `undefined` when no repository of the
 * owner matches a pattern (the owner keeps the plain list). Each row goes under the first pattern that matches its
 * repository name. The values of the capturing groups are the group nodes: the top level directly under the owner, or
 * under the root node of an entry with a `name`. Group nodes are keyed by their label path under the same parent, so
 * equal paths of different unnamed patterns are one node. Rows without devspace that match no pattern are hidden
 * (the patterns filter); rows with a devspace stay directly under the owner (devspaces are always listed). Order
 * (the nodes follow the order of the patterns in the setting): on each level, by the first pattern of the setting that
 * puts a node there (a named root by its own pattern; a group node by the first pattern among the repositories below
 * it; a row by its pattern), then group nodes before rows, then alphabetically. Rows with a devspace that match no
 * pattern come last. A repository node (child rows per source) is placed like a row.
 */
function groupRows(
  owner: string,
  withDevspace: readonly RepositoryEntry[],
  others: readonly RepositoryEntry[],
  groupMatch: (name: string) => RepositoryGroupMatch | undefined,
  currentDevspaceId: string | null,
): Array<GroupNode | RepositoryEntry> | undefined {
  const ownerKey = owner.toLowerCase();
  let matched = false;
  const top: Array<GroupNode | RepositoryEntry> = [];
  const namedRoots = new Map<number, GroupNode>();
  const nodes = new Map<string, GroupNode>();
  // The index of the first pattern that puts a node or row on its level (sortGroupChildren).
  const order = new WeakMap<GroupNode | RepositoryEntry, number>();
  const note = (item: GroupNode | RepositoryEntry, index: number) => order.set(item, Math.min(order.get(item) ?? index, index));
  for (const row of [...withDevspace, ...others]) {
    const match = groupMatch(row.name);
    if (!match) {
      if (hasDevspace(row)) {
        top.push(row);
        order.set(row, Number.POSITIVE_INFINITY);
      }
      continue;
    }
    matched = true;
    const { pattern } = match;
    const prefix = `group:${ownerKey}:${pattern.name !== undefined ? String(pattern.index) : '-'}:`;
    let children = top;
    if (pattern.name !== undefined) {
      let root = namedRoots.get(pattern.index);
      if (!root) {
        root = {
          kind: 'group',
          id: prefix,
          owner,
          level: 0,
          label: pattern.name,
          tooltip: pattern.source,
          expanded: true,
          children: [],
        };
        namedRoots.set(pattern.index, root);
        top.push(root);
        order.set(root, pattern.index);
      }
      children = root.children;
    }
    const path: string[] = [];
    const isCurrent = holdsCurrent(row, currentDevspaceId);
    for (const value of match.levels) {
      path.push(encodeURIComponent(value));
      const id = prefix + path.join('/');
      let node = nodes.get(id);
      if (!node) {
        node = { kind: 'group', id, owner, level: path.length, label: value, expanded: false, children: [] };
        nodes.set(id, node);
        children.push(node);
      }
      note(node, pattern.index);
      if (isCurrent) node.expanded = true;
      children = node.children;
    }
    const placed: RepositoryEntry = match.label === row.label ? row : { ...row, label: match.label };
    order.set(placed, pattern.index);
    children.push(placed);
  }
  if (!matched) return undefined;
  return sortGroupChildren(top, order);
}

/**
 * Sorts all levels: by the index of the first pattern that puts the node or row there (`order`; see groupRows), then
 * group nodes before rows, then group nodes by label and rows by label, repository, and ID.
 */
function sortGroupChildren(
  children: ReadonlyArray<GroupNode | RepositoryEntry>,
  order: WeakMap<GroupNode | RepositoryEntry, number>,
): Array<GroupNode | RepositoryEntry> {
  for (const child of children) if (child.kind === 'group') child.children = sortGroupChildren(child.children, order);
  const rank = (item: GroupNode | RepositoryEntry) => order.get(item) ?? Number.POSITIVE_INFINITY;
  return [...children].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) < rank(b) ? -1 : 1;
    if (a.kind === 'group' || b.kind === 'group') {
      if (a.kind === 'group' && b.kind === 'group') return compareNames(a.label, b.label) || compareNames(a.id, b.id);
      return a.kind === 'group' ? -1 : 1;
    }
    return compareNames(a.label, b.label) || compareNames(a.repository, b.repository) || compareNames(a.id, b.id);
  });
}

/**
 * Top-level nodes of the view: the groups, with the rows that stand for the welcome view when the view is not empty (an
 * empty view shows the welcome view with its buttons instead): the sign-in row when the user is not signed in.
 * No Docker row: while no Docker CLI is found, the sidebar passes an empty model, so the view shows the Docker setup of
 * the welcome view: without a remote Docker host and without a local Docker, the sidebar shows the Docker setup, not
 * the repositories.
 */
export function rootNodes(groups: readonly OwnerGroup[], signedIn: boolean): Array<SignInRow | OwnerGroup> {
  if (groups.length === 0) return [];
  if (signedIn) return [...groups];
  return [{ kind: 'signIn', id: SIGN_IN_ROW_ID, label: TreeTexts.signIn, tooltip: TreeTexts.signInTooltip }, ...groups];
}

/**
 * All repository rows of the model, in display order: the single rows, the child rows of the repository nodes, also
 * inside the nodes of `repositoryGroups`.
 */
export function repositoryRows(groups: readonly OwnerGroup[]): RepositoryRow[] {
  const rows: RepositoryRow[] = [];
  const walk = (children: ReadonlyArray<RepositoryEntry | HintRow | GroupNode>): void => {
    for (const child of children) {
      if (child.kind === 'repository') rows.push(child);
      else if (child.kind === 'repositoryNode') rows.push(...child.children);
      else if (child.kind === 'group') walk(child.children);
    }
  };
  for (const group of groups) walk(group.children);
  return rows;
}

/** The repository entries (single rows and repository nodes) of the model, in display order. */
export function repositoryEntriesOf(groups: readonly OwnerGroup[]): RepositoryEntry[] {
  const entries: RepositoryEntry[] = [];
  const walk = (children: ReadonlyArray<RepositoryEntry | HintRow | GroupNode>): void => {
    for (const child of children) {
      if (child.kind === 'repository' || child.kind === 'repositoryNode') entries.push(child);
      else if (child.kind === 'group') walk(child.children);
    }
  };
  for (const group of groups) walk(group.children);
  return entries;
}

/** One devspace in the switcher. */
export interface RecentDevspace {
  devspaceId: string;
  repository: string;
  /** The name shown: the repository, with the word of the source of a child row (`acme/api · default`). */
  name: string;
  /** `undefined` if the model has no row for the devspace. */
  state?: DevspaceState;
  /** The description of the sidebar row: branch, state, and changes. */
  description: string;
}

/** The name of a devspace in texts: its repository, with the word of its source when its row is a child row. */
export function devspaceName(repository: string, source: DevspaceSource | undefined, child: boolean): string {
  return child && source !== undefined ? `${repository} · ${sourceLabel(source)}` : repository;
}

/** Devspaces for the switcher, most recently used first, with the state and description of their sidebar row. */
export function recentDevspaces(groups: readonly OwnerGroup[], devspaces: readonly Devspace[]): RecentDevspace[] {
  const rowsById = new Map<string, RepositoryRow>();
  for (const row of repositoryRows(groups)) {
    if (row.devspace) rowsById.set(row.devspace.id, row);
  }
  return [...devspaces]
    .sort(
      (a, b) =>
        timeValue(b.lastUsedAt) - timeValue(a.lastUsedAt) ||
        compareNames(a.repository, b.repository) ||
        compareNames(a.id, b.id),
    )
    .map((devspace) => {
      const row = rowsById.get(devspace.id);
      const repository = row?.repository ?? devspace.repository;
      return {
        devspaceId: devspace.id,
        repository,
        name: devspaceName(repository, row?.source, row?.child ?? false),
        state: row?.state,
        description: row?.description ?? '',
      };
    });
}

/** Repositories for the repository picker: most recently pushed first, then by name. */
export function repositoriesForPicker(repositories: readonly RepositoryInfo[]): RepositoryInfo[] {
  return [...repositories].sort(
    (a, b) =>
      timeValue(b.pushedAt ?? undefined) - timeValue(a.pushedAt ?? undefined) ||
      compareNames(a.nameWithOwner, b.nameWithOwner),
  );
}

/** The tooltip line of the source of a row. */
function sourceLine(source: DevspaceSource): string {
  return source.kind === 'defaultImage' ? TreeTexts.sourceDefaultImage(source.image) : TreeTexts.sourceConfiguration(source.configPath);
}

function devspaceRow(
  id: string,
  devspace: Devspace,
  info: RepositoryInfo | undefined,
  source: DevspaceSource,
  child: boolean,
  confirmedMissing: boolean,
  input: TreeInput,
): RepositoryRow {
  const repository = info?.nameWithOwner ?? devspace.repository;
  const { owner, name } = info ? { owner: info.owner, name: info.name } : splitName(repository);
  const state = devspaceState(devspace, input);
  // The state of a devspace on an engine that the last refresh could not read is unknown; a live busy mark
  // (Updating) is known without Docker. The actions stay those of `state`.
  const unknown =
    input.statesUnknown !== undefined && state !== 'updating' && isOnDockerHost(devspace, input.statesUnknown.dockerHost) ? input.statesUnknown : undefined;
  // The state is the one of the dev container; running side services keep Stop and are named, and so does another
  // running dev container of the devspace.
  const servicesRunning = input.runtime?.get(devspace.id)?.servicesRunning === true && !containerRuns(state) && state !== 'updating';
  const actions = rowActions(state, info, state === 'updating' ? devspace.busy?.operation : undefined, servicesRunning);
  const liveBranch = containerRuns(state) || state === 'updating' ? input.liveBranches.get(devspace.id) : undefined;
  const branch = nonEmpty(liveBranch) ?? nonEmpty(devspace.gitSummary?.branch ?? undefined);
  const notOnGitHub = input.signedIn && input.discovery !== undefined && info === undefined && confirmedMissing;
  // The change counts are recorded at each stop; while the container runs they are outdated, and with a missing volume
  // the changes are gone. Not while the state is unknown (the volume may be gone).
  const changes =
    unknown === undefined && (state === 'stopped' || state === 'noContainer') && devspace.gitSummary ? formatChanges(devspace.gitSummary) : '';

  // After a rename or transfer on GitHub the row shows the current name, while the pipeline reads the switch under the
  // registry name: the row shows the state of the switch under that name, as the pipeline applies it.
  const checks: HostAccessChecks = hostAccessChecks(devspace.repository, input.settings);
  const unrestricted = checks === 'off' ? StateTexts.hostAccessUnrestricted : undefined;
  // The one row of a repository names the default image in brackets; a child row names its source in its label.
  const left = [branch, !child && source.kind === 'defaultImage' ? `(${TreeTexts.defaultImageShort})` : undefined].filter(isText).join(' ');
  const kept = devspace.keepRunning === true;
  // Close and Keep Running shows like a kept devspace; the menu keeps the switch of Keep Running When Closed.
  const keptOnce = !kept && devspace.keepRunningOnce === true;
  // The keeps of the settings (keptWhenClosed, as the heartbeats send them): the row shows them too, with the setting
  // that keeps it in the tooltip.
  const keptBySettings = !kept && !keptOnce && keptWhenClosed(keepFlagsOf(devspace), input.settings);
  const keptBySettingText = keptBySettings ? (input.settings.stopOnClose === false ? TreeTexts.keptByStopOnClose : TreeTexts.keptByShutdownAction) : undefined;
  const services = servicesRunning ? StateTexts.servicesRunning : undefined;
  const keptAny = kept || keptOnce || keptBySettings;
  // `State unknown (Docker not ready)`, with the suffix ` · kept` as every state text.
  const engine = unknown === undefined ? '' : unknown.dockerHost === '' ? 'Docker' : unknown.dockerHost;
  const shownState =
    unknown !== undefined
      ? [`${StateTexts.unknown} (${TreeTexts.unknownShort(engine, unknown.reason)})`, keptAny ? StateTexts.kept : undefined].filter(isText).join(' · ')
      : rowStateText(state, keptAny);
  const right = [shownState, services, changes, notOnGitHub ? StateTexts.notOnGitHub : undefined, unrestricted].filter(isText).join(' · ');
  const description = [left, right].filter(isText).join('   ');

  const formatTime = input.formatTime ?? defaultFormatTime;
  const tooltip = [
    devspaceName(repository, source, child),
    // The configuration of the devspace itself (the root configuration under the file name it was created with); for
    // the default image, the image of the settings, which its next start takes.
    sourceLine(source.kind === 'configuration' ? sourceOf(devspace) : source),
    [unknown !== undefined ? [StateTexts.unknown, keptAny ? StateTexts.kept : undefined].filter(isText).join(' · ') : rowStateText(state, keptAny), services, changes]
      .filter(isText)
      .join(' · '),
    unknown !== undefined ? TreeTexts.unknownDetail(engine, unknown.reason) : undefined,
    kept ? TreeTexts.kept : undefined,
    keptOnce ? TreeTexts.keptOnce : undefined,
    keptBySettingText,
    servicesRunning ? TreeTexts.servicesRunning : undefined,
    branch !== undefined ? TreeTexts.branch(branch) : undefined,
    timeValue(devspace.lastUsedAt) > 0 ? TreeTexts.lastUsed(formatTime(devspace.lastUsedAt)) : undefined,
    notOnGitHub ? TreeTexts.notListedOnGitHub : undefined,
    info?.isArchived ? TreeTexts.archived : undefined,
    checks === 'off' ? Messages.hostAccessUnrestrictedTooltip : undefined,
  ]
    .filter(isText)
    .join('\n');

  return {
    kind: 'repository',
    id,
    repository,
    owner,
    name,
    info,
    source,
    child,
    devspace,
    state,
    ...(unknown !== undefined ? { stateUnknown: true as const } : {}),
    branch,
    notOnGitHub,
    hostAccessChecks: checks,
    actions,
    label: child ? sourceLabel(source) : name,
    description,
    tooltip,
    // While a setting keeps it running, the row offers neither Keep Running When Closed nor Close and Keep Running
    // (both would change nothing).
    contextValue: contextValue(actions, checks, keptBySettings ? undefined : kept, state === 'connected' && !keptBySettings),
  };
}

/**
 * The row of a source of a repository without devspace of the signed-in account. A devspace of another account does
 * not change it: Start creates the account's own devspace.
 */
/** The row of a source without a devspace; `checksName` is the name the host access checks are read under. */
function repositoryRow(id: string, repository: string, checksName: string, info: RepositoryInfo | undefined, source: DevspaceSource, child: boolean, input: Pick<TreeInput, 'settings'>): RepositoryRow {
  const { owner, name } = info ? { owner: info.owner, name: info.name } : splitName(repository);
  const actions = rowActions(undefined, info);
  const checks = hostAccessChecks(checksName, input.settings);
  const tooltip = [
    devspaceName(repository, source, child),
    sourceLine(source),
    TreeTexts.noDevspace,
    !child && source.kind === 'defaultImage' && !hasConfiguration(info) ? TreeTexts.noConfiguration : undefined,
    info?.defaultBranch ? TreeTexts.defaultBranch(info.defaultBranch) : undefined,
    info?.isArchived ? TreeTexts.archived : undefined,
    checks === 'off' ? Messages.hostAccessUnrestrictedTooltip : undefined,
  ]
    .filter(isText)
    .join('\n');
  return {
    kind: 'repository',
    id,
    repository,
    owner,
    name,
    info,
    source,
    child,
    notOnGitHub: false,
    hostAccessChecks: checks,
    actions,
    label: child ? sourceLabel(source) : name,
    description: checks === 'off' ? StateTexts.hostAccessUnrestricted : '',
    tooltip,
    contextValue: contextValue(actions, checks),
  };
}

function splitName(repository: string): { owner: string; name: string } {
  const index = repository.indexOf('/');
  if (index <= 0 || index === repository.length - 1) return { owner: repository, name: repository };
  return { owner: repository.slice(0, index), name: repository.slice(index + 1) };
}

function ownerFilter(owners: readonly unknown[] | undefined): Set<string> {
  return new Set(
    (owners ?? [])
      .filter((owner): owner is string => typeof owner === 'string')
      .map((owner) => owner.trim().toLowerCase())
      .filter((owner) => owner !== ''),
  );
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/** Case-insensitive, natural order (`repo2` before `repo10`); ties are broken by code points, so the order is stable. */
function compareNames(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

function timeValue(isoTime: string | undefined): number {
  const value = isoTime ? Date.parse(isoTime) : NaN;
  return Number.isNaN(value) ? 0 : value;
}

function defaultFormatTime(isoTime: string): string {
  const date = new Date(isoTime);
  return Number.isNaN(date.getTime()) ? isoTime : date.toLocaleString();
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined;
}

function isText(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}
