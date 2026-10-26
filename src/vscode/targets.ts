// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Targets of the commands and the choices of their Quick Picks. No `vscode` import, so the rules are unit-tested.
import { defaultImageOf, isSourceOf, sourceLabel } from '../core/devspaceSource';
import { filterRepositories, isTrustedOwner } from '../core/discovery/discoveryService';
import { isRepositoryInScope } from '../core/discovery/scope';
import { parseDevspaceSource } from '../core/helperChannel/protocol';
import type { RepositoryTarget } from '../core/pipeline/operationBase';
import type { DiscoveryData, Devspace, DevspaceSource, ExtensionSettings, RepositoryInfo } from '../core/types';
import { ControllerTexts } from './controllerTexts';
import { isRecord } from '../core/valueChecks';

/** Key of a repository in maps and in the operation gate: lower-case `owner/name` (GitHub names ignore case). */
export function repositoryKey(repository: string): string {
  return repository.toLowerCase();
}

/**
 * The argument of a command:
 * - a row of the sidebar (`RepositoryRow`, from the menus of the view), with the source of the row (what Start builds
 *   the devspace of the row from, or what its devspace was built from),
 * - `{ devspaceId }` (the status bar item "Reconnect"),
 * - nothing (Command Palette, keyboard shortcut): the command asks with a Quick Pick.
 */
export type CommandArgument =
  | { kind: 'row'; repository: string; info?: RepositoryInfo; devspaceId?: string; source?: DevspaceSource }
  | { kind: 'devspace'; devspaceId: string }
  | { kind: 'none' };

export function parseCommandArgument(argument: unknown): CommandArgument {
  if (!isRecord(argument)) return { kind: 'none' };
  if (argument.kind === 'repository' && typeof argument.repository === 'string' && argument.repository.includes('/')) {
    const info = isRepositoryInfo(argument.info) ? argument.info : undefined;
    const devspace = isRecord(argument.devspace) ? argument.devspace : undefined;
    const devspaceId = typeof devspace?.id === 'string' && devspace.id !== '' ? devspace.id : undefined;
    const source = parseDevspaceSource(argument.source);
    return { kind: 'row', repository: argument.repository, info, devspaceId, ...(source !== undefined ? { source } : {}) };
  }
  if (argument.kind === undefined && typeof argument.devspaceId === 'string' && argument.devspaceId !== '') {
    return { kind: 'devspace', devspaceId: argument.devspaceId };
  }
  return { kind: 'none' };
}

/** Target of the open pipeline for a repository (first open). */
export function repositoryTarget(repository: string, info: RepositoryInfo | undefined, trusted: boolean): RepositoryTarget {
  return {
    repository: info?.nameWithOwner ?? repository,
    defaultBranch: info?.defaultBranch ?? null,
    configPaths: info ? [...info.configPaths] : [],
    trusted,
  };
}

/**
 * Trust of an owner for a first open. The discovery data belongs to `data.viewerLogin`: after a change of the GitHub
 * account it says nothing about the new account until a refresh finished (`unknown`).
 */
export function ownerTrust(
  data: DiscoveryData | undefined,
  accountLogin: string | undefined,
  owner: string,
): 'trusted' | 'untrusted' | 'unknown' {
  if (!data || !accountLogin || data.viewerLogin.toLowerCase() !== accountLogin.toLowerCase()) return 'unknown';
  return isTrustedOwner(data, owner) ? 'trusted' : 'untrusted';
}

/** A repository that only the registry knows, for the pickers. It has no URL of its own and no configurations. */
export function placeholderRepositoryInfo(repository: string): RepositoryInfo {
  const index = repository.indexOf('/');
  const owner = index > 0 ? repository.slice(0, index) : repository;
  const name = index > 0 ? repository.slice(index + 1) : repository;
  return {
    nameWithOwner: repository,
    owner,
    name,
    url: gitHubUrl(repository),
    isArchived: false,
    isFork: false,
    isPrivate: false,
    pushedAt: null,
    defaultBranch: null,
    configPaths: [],
  };
}

/** `https://github.com/owner/name`. */
export function gitHubUrl(repository: string): string {
  return `https://github.com/${repository.split('/').map(encodeURIComponent).join('/')}`;
}

/** The discovery data or a single lookup (`null`: GitHub does not list it) of a repository. */
export function findRepositoryInfo(
  repository: string,
  data: DiscoveryData | undefined,
  lookups: ReadonlyMap<string, RepositoryInfo | null>,
): RepositoryInfo | undefined {
  const key = repositoryKey(repository);
  return listedRepositories(data).find((info) => repositoryKey(info.nameWithOwner) === key) ?? lookups.get(key) ?? undefined;
}

/** The repositories that the discovery knows: with a configuration, then without one. */
export function listedRepositories(data: DiscoveryData | undefined): RepositoryInfo[] {
  return data ? [...data.repositories, ...data.withoutConfiguration] : [];
}

/**
 * Repositories of the pickers (Search, "Open repository…" of the switcher): the discovered repositories that the
 * settings show (with a default image also those without a configuration), plus the repository of every devspace (like
 * the sidebar), with the GitHub data when it is known.
 */
export function pickerRepositories(input: {
  data: DiscoveryData | undefined;
  settings: Pick<ExtensionSettings, 'owners' | 'includeArchived' | 'includeForks'> & Partial<Pick<ExtensionSettings, 'defaultImage'>>;
  devspaces: readonly Devspace[];
  lookups: ReadonlyMap<string, RepositoryInfo | null>;
}): RepositoryInfo[] {
  const result: RepositoryInfo[] = [];
  const seen = new Set<string>();
  const add = (info: RepositoryInfo): void => {
    const key = repositoryKey(info.nameWithOwner);
    if (seen.has(key)) return;
    seen.add(key);
    result.push(info);
  };
  const shown = defaultImageOf(input.settings) !== undefined ? listedRepositories(input.data) : (input.data?.repositories ?? []);
  for (const info of filterRepositories(shown, input.settings)) add(info);
  for (const devspace of input.devspaces) {
    add(findRepositoryInfo(devspace.repository, input.data, input.lookups) ?? placeholderRepositoryInfo(devspace.repository));
  }
  return result;
}

/**
 * Repositories of devspaces that the discovery does not list (`listed`: with and without a configuration; a repository
 * of the scan is only missing when the account cannot see it): they are looked up one by one after a refresh, so that
 * the sidebar does not show `not on GitHub`
 * for a repository that exists. Each repository once, in the order of the registry. With a scan scope (`owners`), only
 * repositories of its owners: GitHub is not asked about any other one.
 */
export function repositoriesToLookUp(
  devspaces: readonly Devspace[],
  listed: readonly RepositoryInfo[],
  owners: readonly string[] = [],
): string[] {
  const known = new Set(listed.map((info) => repositoryKey(info.nameWithOwner)));
  const result: string[] = [];
  for (const devspace of devspaces) {
    const key = repositoryKey(devspace.repository);
    if (known.has(key) || !isRepositoryInScope(owners, devspace.repository)) continue;
    known.add(key);
    result.push(devspace.repository);
  }
  return result;
}

export interface SourceChoice {
  source: DevspaceSource;
  /** The word of the source (sourceLabel): `default`, `config`, or the folder name of an alternative configuration. */
  label: string;
  /** The image reference or the path of the configuration; ` · devspace` when a devspace of the source exists. */
  description: string;
  /** A devspace of the source exists. */
  hasDevspace: boolean;
}

/**
 * Choices of the source of a repository with several possible sources (possibleSources), for a Start from the Command
 * Palette, Search, or the switcher: the word of the source as label, its image or path as description, marked when a
 * devspace of it exists.
 */
export function sourceChoices(sources: readonly DevspaceSource[], devspaces: readonly Devspace[]): SourceChoice[] {
  return sources.map((source) => {
    const hasDevspace = devspaces.some((devspace) => isSourceOf(devspace, source));
    const what = source.kind === 'defaultImage' ? source.image : source.configPath;
    return {
      source,
      label: sourceLabel(source),
      description: hasDevspace ? `${what} · ${ControllerTexts.devspaceExists}` : what,
      hasDevspace,
    };
  });
}

function isRepositoryInfo(value: unknown): value is RepositoryInfo {
  return (
    isRecord(value) &&
    typeof value.nameWithOwner === 'string' &&
    typeof value.url === 'string' &&
    Array.isArray(value.configPaths)
  );
}
