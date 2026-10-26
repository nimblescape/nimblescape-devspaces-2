// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The worker is the deputy of the window: what a flow in the worker needs from the user's computer, as one interface
// per kind of request (`question`, `local`, `record`, `secret`; no `connect`, the open answers with what the window
// needs). The worker's side of them (workerHostSide) sends the requests; the extension's side (hostSideHandler,
// src/vscode) answers them. Pure types, the check of a request, and the requests of each flow; no I/O, no `vscode`.
import type { ConfigurationChangeKind } from '../ports';
import { OP_DELETE, OP_DELETE_CHECK, OP_HEARTBEAT, OP_LIST_CONFIGURATIONS, OP_MONITOR_ENSURE, OP_MONITOR_RUN_NOW, OP_OPEN, OP_PREPARE, OP_RECONCILE, OP_RECORD_GIT_STATE, OP_STOP, OP_TOKEN_REMOVE, OP_WINDOW_STATE, SECRET_REGISTRY, SECRET_TOKEN, type AskKind } from '../helperChannel/protocol';
import type { BusyMarkResult } from '../pipeline/busyMarks';
import type { BusyMark, BusyOperation, Devspace, DevspaceSource, GitHubAccount, GitSummary, RegistryFile, WindowStatus } from '../types';
import type { DeleteConfirmation } from '../pipeline/deleteCheck';
import type { GitHubViewer } from '../helper/containerGit';
import type { BuildChange, ConfigurationChange, LifecycleMarkChange, StepMarkResult } from '../pipeline/openRecords';
import type { HostOpenFinish, OpenRequestScope } from './openRequests';
import type { ConfigCheckEntry } from '../storage/configCheckEntry';

/**
 * The time limit of the question to GitHub for the profile of the account (HostSide.viewer), for the Git identity of a
 * new devspace: the worker's pipeline waits this long for it (DevspaceService.identityOf), and the extension
 * gives its question to GitHub as long (extensionHostSide). One definition for both ends.
 */
export const VIEWER_TIMEOUT_MS = 5_000;

/** The questions of a flow to the user (PipelineUi without the messages, which go as log lines and progress). */
export interface HostQuestions {
  confirmUntrustedRepository(repository: string): Promise<boolean>;
  configurationChanged(repository: string, what?: ConfigurationChangeKind): Promise<'rebuildNow' | 'later'>;
  configurationKindChanged(repository: string, message: string): Promise<'rebuildNow' | 'later'>;
  filesMissing(repository: string): Promise<'cloneAgain' | 'deleteDevspace' | undefined>;
  recreateContainer(repository: string, question: { message: string; detail: string }): Promise<boolean>;
  /** A newer image for the existing container of the devspace (PipelineUi). */
  updateContainer(repository: string, running: boolean): Promise<'update' | 'later' | 'cancel'>;
  /** The questions of Delete (PipelineUi), with their facts; `undefined`: cancel. */
  confirmDelete(repository: string, confirmation: DeleteConfirmation): Promise<'delete' | 'open' | undefined>;
  deleteAdditionalVolumes(volumes: readonly string[]): Promise<'remove' | 'keep' | undefined>;
  deleteServiceData(volumes: readonly string[], possibly: readonly string[]): Promise<string[] | undefined>;
  /** A message without a question: info, warn, or the sign-in hint of a registry. */
  message(kind: 'info' | 'warn' | 'registrySignIn', text: string): Promise<void>;
}

/** The state on the user's computer that a flow reads (the window files, the busy marks, the remembered answers). */
export interface HostState {
  /** The windows of this computer with their status (SessionFiles.readWindowStatuses). */
  windowStatuses(): Promise<readonly WindowStatus[]>;
  /** The pending files of this computer (SessionFiles.readPendings). */
  pendings(): Promise<readonly { devspaceId: string; windowId: string; createdAt: string }[]>;
  /** True while the process `pid` of this computer runs. */
  processAlive(pid: number): Promise<boolean>;
  /**
   * The signed-in GitHub account (GitHubAuth.getAccount), its id and login, never a token; `interactive` lets the
   * extension ask the user to sign in. `undefined`: no one is signed in.
   */
  account(interactive: boolean): Promise<GitHubAccount | undefined>;
  /**
   * The GitHub profile of the signed-in account (DiscoveryService.viewer), asked by the extension with its own token,
   * for the Git identity of a new devspace. `undefined`: it could not be read.
   */
  viewer(): Promise<GitHubViewer | undefined>;
  /** The container that the window remembers for the devspace (LifecycleMemory). */
  unrecordedLifecycle(devspaceId: string): Promise<string | undefined>;
}

/** The records of the user's computer that a flow changes (the registry and the session files). */
export interface HostRecords {
  read(): Promise<RegistryFile>;
  get(id: string): Promise<Devspace | undefined>;
  list(): Promise<Devspace[]>;
  /** With `source`: the devspace of that source of the repository; without: any devspace of the repository. */
  findForAccount(repository: string, accountId: string, dockerHost: string, source?: DevspaceSource): Promise<Devspace | undefined>;
  // There is no generic `add` or `update`: an entry is added only as `record createDevspace`, and changed only by
  // the specific requests below.
  remove(id: string, volumes: { kept?: readonly string[]; removed?: readonly string[] }): Promise<void>;
  forgetKeptVolumes(names: readonly string[]): Promise<void>;
  /** The window remembers the container of the devspace whose lifecycle mark could not be recorded. */
  rememberLifecycle(devspaceId: string, containerId: string): Promise<void>;
  /** The window forgets it, when it is that container. */
  forgetLifecycle(devspaceId: string, containerId: string): Promise<void>;
  /**
   * The session files of the devspace (pending, operation, reopen, disconnect request). `removeReopenOf`: the reopen
   * record only when it names the devspace.
   */
  sessionFile(kind: HostSessionFile, devspaceId: string): Promise<void>;
  /**
   * The busy mark of the window that sent the operation, set by the extension with its clock and its view of the
   * windows, under its registry lock (registryBusyMarks). `onReplaced` hears the mark that the new mark replaced (the
   * extension's handler remembers it for `record createMark` `previous`); the worker's side never passes it.
   */
  markBusy(devspaceId: string, operation: BusyOperation, onReplaced?: (mark: BusyMark) => void): Promise<BusyMarkResult>;
  /** Removes the busy mark of the window that sent the operation. */
  clearBusy(devspaceId: string): Promise<void>;
  /**
   * Records the Git state of the devspace (Devspace.gitSummary), as the worker read it in its running dev
   * container.
   */
  recordGitSummary(devspaceId: string, summary: GitSummary): Promise<void>;
  /**
   * Adds the entries that the worker rebuilt from the labels of the volumes of its engine
   * (DevspaceRegistry.restore), under the registry lock, with the clock of the extension; `skipped`: the volumes
   * whose repository has a devspace of the same owner already.
   */
  restore(entries: readonly Devspace[]): Promise<{ added: number; skipped: string[] }>;
  /**
   * The registry writes of the open (OpenRecords), each a request of its own that the extension applies under its
   * registry lock with its owner, clock, account and view of the windows, only on the entry of the operation's
   * devspace of the signed-in account on the operation's Docker host (requestOpenRecords). `scope` is what the
   * extension's handler takes from the operation, never from the request; the worker's side never passes it, and the
   * extension refuses without it. `record createMark`: `previous` only as a mark that a `record markBusy` of the same
   * operation replaced.
   */
  createMark(devspaceId: string, kind: 'ended' | 'previous', previous: BusyMark | undefined, scope?: OpenRequestScope): Promise<Devspace | undefined>;
  /** `record stepMark` `take`; the extension builds the mark (its owner and clock). */
  takeStepMark(devspaceId: string, operation: BusyOperation, scope?: OpenRequestScope): Promise<StepMarkResult>;
  /** `record stepMark` `release`, only a mark of the window that sent the operation. */
  releaseStepMark(devspaceId: string, mark: BusyMark, scope?: OpenRequestScope): Promise<Devspace | undefined>;
  /** `record ownerLogin`, the login of the account signed in in the extension (never the worker's). */
  ownerLogin(devspaceId: string, scope?: OpenRequestScope): Promise<Devspace | undefined>;
  /** `record lifecycleMark`. */
  lifecycleMark(devspaceId: string, change: LifecycleMarkChange, scope?: OpenRequestScope): Promise<Devspace | undefined>;
  /** `record openFinished`; the time and the liveness are the extension's. */
  openFinished(devspaceId: string, finish: HostOpenFinish, scope?: OpenRequestScope): Promise<Devspace | undefined>;
  /**
   * `record createDevspace`, the entry of a first open: the worker picks its ID and names the repository, the
   * configuration and, for a default-image devspace, its default image; the extension builds the rest (its account,
   * clock and create mark, the Docker host of the operation, the names) and binds the operation to the devspace. The
   * answer is the new entry, or the one of the source of the repository that another window of the account created
   * meanwhile.
   */
  createDevspace(id: string, repository: string, configPath: string, scope?: OpenRequestScope, defaultImage?: string): Promise<Devspace>;
  /** `record dropCreated`, only the entry that the operation created, with the create mark of the window. */
  dropCreated(devspaceId: string, scope?: OpenRequestScope): Promise<void>;
  /** `record configuration`; a volume that the entry may not record is left out (and logged). */
  configuration(devspaceId: string, change: ConfigurationChange, scope?: OpenRequestScope): Promise<Devspace | undefined>;
  /** `record build` (`number`, `record`, `rebaseline`, `refused`). */
  build(devspaceId: string, change: BuildChange, scope?: OpenRequestScope): Promise<Devspace | undefined>;
  /**
   * `record configCheck`, the remembered check result of the configuration of the devspace (ConfigCheckEntry), when
   * the extension has a valid one of the code of its worker; only for an entry of the signed-in account on the
   * operation's Docker host.
   */
  configCheck(devspaceId: string, scope?: OpenRequestScope): Promise<ConfigCheckEntry | undefined>;
  /**
   * `record rememberConfigCheck`, the check result of a configuration that passed (one per devspace, the previous
   * one replaced); the extension checks its shape and size (parseConfigCheckEntry) and stores it in its own storage,
   * never the worker's or the engine's.
   */
  rememberConfigCheck(devspaceId: string, entry: ConfigCheckEntry, scope?: OpenRequestScope): Promise<void>;
}

/** The session files that a flow writes or removes (HostRecords.sessionFile). */
export const HOST_SESSION_FILES = ['writePending', 'removePending', 'removeOperation', 'removeReopenOf', 'removeDisconnectRequest'] as const;
export type HostSessionFile = (typeof HOST_SESSION_FILES)[number];

/** A registry login (HostSecrets.registry). */
export interface HostRegistryLogin {
  username?: string;
  identityToken?: boolean;
  serveraddress: string;
  password: string;
  /**
   * Where the extension found it: the login that Docker stored on this computer, or the GitHub sign-in. Only for the
   * log of the extension; the worker never gets it.
   */
  from?: 'docker' | 'github';
}

/** The secrets that only the user's computer has. `undefined`: there is none (an anonymous pull, no sign-in). */
export interface HostSecrets {
  /** The GitHub token of the signed-in account (SECRET_TOKEN). */
  token(): Promise<string | undefined>;
  /**
   * The login of the registry `registry` for the image or Feature `registry`/`repository` (both as parseImageReference
   * normalizes them): what Docker stored on this computer, else for ghcr.io the GitHub sign-in. The password (or the
   * identity token) travels as the secret SECRET_REGISTRY, never in the value of the answer. The extension checks the
   * request, limits the logins of an operation and logs each request (hostSideHandler).
   */
  registry(registry: string, repository: string): Promise<HostRegistryLogin | undefined>;
}

/** Everything that a flow in the worker needs from the user's computer. */
export interface HostSide {
  questions: HostQuestions;
  state: HostState;
  records: HostRecords;
  secrets: HostSecrets;
}

/**
 * The payload of a request: its kind and the call, so that one handler on the extension's side answers every request of
 * a flow. `args` are the arguments of the call, as JSON.
 */
export interface HostRequest {
  kind: AskKind;
  call: string;
  args: unknown[];
}

/** The strict check of a request (the extension's side). */
export function parseHostRequest(value: unknown, kind: AskKind): HostRequest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { call, args } = value as { call?: unknown; args?: unknown };
  if (typeof call !== 'string' || !/^[a-z][a-zA-Z0-9]{0,63}$/.test(call)) return undefined;
  if (!Array.isArray(args)) return undefined;
  return { kind, call, args: [...(args as unknown[])] };
}

/** The names of the secrets that a flow asks for. */
export const HOST_SECRET_NAMES = { token: SECRET_TOKEN, registry: SECRET_REGISTRY } as const;

/** The answer of a `secret` request: what the operation needs beside the secret, which travels in `secrets`. */
export interface HostSecretAnswer {
  /** False when the user's computer has no such secret (the operation goes on without it). */
  given: boolean;
  /** For a registry login: its user and server; an identity token has no user. */
  username?: string;
  identityToken?: boolean;
  serveraddress?: string;
}

/** A request as `<kind> <call>`, for example `record get`. */
export type HostCall = `${AskKind} ${string}`;

/**
 * The requests that each flow may send. The extension answers only these for an operation, so a flow gets no secret,
 * and changes no record, that it has no business with; an operation that is not listed may send none.
 */
export const FLOW_REQUESTS: Readonly<Record<string, readonly HostCall[]>> = {
  [OP_TOKEN_REMOVE]: ['record get'],
  // Stop needs nothing from this computer (its parameters carry what it needs; the extension records the Git state).
  [OP_STOP]: [],
  // The listing of the configurations reads the record and the account; no secret, no write.
  [OP_LIST_CONFIGURATIONS]: ['record get', 'local account'],
  // The reads of an attached window need nothing from this computer.
  [OP_WINDOW_STATE]: [],
  // Delete reads the record, the registry (the volumes that other devspaces use or keep) and the account, marks the
  // devspace busy for `delete` only and clears the mark, removes the entry and the session files of the devspace
  // (each tied to the devspace of the operation: SCOPED_REQUESTS; only these kinds); no secret, no other write.
  [OP_DELETE]: [
    'record get',
    'record list',
    'record read',
    'local account',
    'record markBusy.delete',
    'record clearBusy',
    'record remove',
    'record sessionFile.removePending',
    'record sessionFile.removeOperation',
    'record sessionFile.removeDisconnectRequest',
    'record sessionFile.removeReopenOf',
  ],
  // The check of Delete reads the record, the registry (the volumes of the other devspaces) and the account, records
  // the Git state of its devspace (SCOPED_REQUESTS), and asks the questions of Delete; no secret.
  [OP_DELETE_CHECK]: [
    'record get',
    'record read',
    'local account',
    'record recordGitSummary',
    'question confirmDelete',
    'question deleteAdditionalVolumes',
    'question deleteServiceData',
  ],
  // The rebuild of the registry adds the entries of the volumes of its engine, and nothing else; it reads no record
  // (the registry adds only what it lacks).
  [OP_RECONCILE]: ['record restore'],
  // The commands of the Monitor need nothing from this computer (their parameters carry them).
  [OP_HEARTBEAT]: [],
  // The headless prepare needs nothing from a computer at all.
  [OP_PREPARE]: [],
  // The ensure of the monitor needs nothing from this computer either.
  [OP_MONITOR_ENSURE]: [],
  // "Update All Images Now" (the ensure, then the request of the run) needs nothing either.
  [OP_MONITOR_RUN_NOW]: [],
  // The Git state of a release reads the record and records the state of its devspace (SCOPED_REQUESTS).
  [OP_RECORD_GIT_STATE]: ['record get', 'record recordGitSummary'],
  // The open reads the registry (the entry, the devspace of the repository, its source and the account, the volumes that other
  // devspaces record), the windows and pending files of this computer, the account, the profile and the window's
  // lifecycle memory; it rebuilds the registry from the volumes before a first open (`record restore`); it writes the
  // records of the open (each for its devspace: SCOPED_REQUESTS), the pending file of the window, and the busy marks
  // of the open (and of its Delete, when the files are missing and the user deletes the devspace); it asks the
  // questions of the open, the token and the registry logins. The settings come with the parameters.
  [OP_OPEN]: [
    'record get',
    'record list',
    'record read',
    'record findForAccount',
    'record restore',
    'local account',
    'local viewer',
    'local windowStatuses',
    'local pendings',
    'local processAlive',
    'local unrecordedLifecycle',
    'record rememberLifecycle',
    'record forgetLifecycle',
    'record sessionFile.writePending',
    'record sessionFile.removePending',
    'record markBusy.create',
    'record markBusy.update',
    'record markBusy.rebuild',
    'record markBusy.delete',
    'record clearBusy',
    'record createMark',
    'record stepMark',
    'record ownerLogin',
    'record lifecycleMark',
    'record openFinished',
    'record createDevspace',
    'record dropCreated',
    'record configuration',
    'record build',
    // The remembered check result of the configuration (SCOPED_REQUESTS).
    'record configCheck',
    'record rememberConfigCheck',
    // The records of kept volumes that are gone from the engine (hostAccessInput).
    'record forgetKeptVolumes',
    // Delete of the devspace after "files missing", as the operation `delete` sends them.
    'record remove',
    'record sessionFile.removeOperation',
    'record sessionFile.removeDisconnectRequest',
    'record sessionFile.removeReopenOf',
    'question confirmUntrustedRepository',
    'question configurationChanged',
    'question configurationKindChanged',
    'question filesMissing',
    'question recreateContainer',
    // A newer image for an existing container.
    'question updateContainer',
    'question message',
    'secret token',
    'secret registry',
  ],
};

/**
 * The requests whose allowance can name one kind (`<kind> <call>.<detail>` in FLOW_REQUESTS), and the index of that
 * kind in their arguments: the session file, the busy operation. The bare `<kind> <call>` allows every kind.
 */
export const DETAILED_REQUESTS: Readonly<Partial<Record<HostCall, number>>> = {
  'record sessionFile': 0,
  'record markBusy': 1,
  // The kind of the create mark (`ended`, `previous`) and of the step mark (`take`, `release`).
  'record createMark': 1,
  'record stepMark': 1,
  // The kind of the build change (`number`, `record`, `rebaseline`, `refused`).
  'record build': 1,
};

/**
 * The requests that change the record or the session files of one devspace, and the index of its id in their
 * arguments. The extension answers them only for the devspace of the operation (`devspaceId` of its parameters,
 * or the one that its `record createDevspace` created).
 */
export const SCOPED_REQUESTS: Readonly<Partial<Record<HostCall, number>>> = {
  'record markBusy': 0,
  'record clearBusy': 0,
  'record remove': 0,
  'record sessionFile': 1,
  'record recordGitSummary': 0,
  // The registry writes of the open (OpenRecords); the operation `open` sends them.
  'record createMark': 0,
  'record stepMark': 0,
  'record ownerLogin': 0,
  'record lifecycleMark': 0,
  'record openFinished': 0,
  // `record createDevspace` names no devspace of the operation yet: it binds the operation to the one that it
  // creates (hostSideHandler), and these are answered only for it.
  'record dropCreated': 0,
  'record configuration': 0,
  'record build': 0,
  // The remembered check result of the configuration of the devspace.
  'record configCheck': 0,
  'record rememberConfigCheck': 0,
  // The window's memory of the devspace's container whose lifecycle mark could not be recorded.
  'local unrecordedLifecycle': 0,
  'record rememberLifecycle': 0,
  'record forgetLifecycle': 0,
};
