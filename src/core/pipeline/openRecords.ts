// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The registry writes of the open (DevspaceService) as specific operations, never a generic write; one operations
// interface in both directions. Each one takes plain data (JSON-able, no functions); the window that runs it decides
// the rest with its own clock and view of the windows under its registry lock (registryOpenRecords), so that the
// worker's pipeline can send them to the extension as requests (the extension's side of those requests:
// src/core/worker/openRequests.ts). Pure over its deps; no `vscode`.
import { isBusyMarkLive } from '../busy';
import { errorMessage } from '../errors';
import { ownerOf } from '../ownership';
import { isoTime } from '../ports';
import type { BusyMark, BusyOperation, BuildRecord, Devspace, GitHubAccount, GitSummary, RefusedUpdate, WindowStatus } from '../types';
import type { DevspaceRegistry } from '../storage/registry';
import type { BusyMarkView } from './busyMarks';
import { composeRecordOf, lifecycleMarkClears, refusedUpdateOf } from './recordRules';

/**
 * A mark that isBusyMarkLive counts as ended (older than BUSY_MARK_MAX_AGE_MS; the epoch, so a clock correction cannot
 * make it live again), with its operation kept: the create mark of an unfinished clone of this window then blocks
 * nothing (the sidebar of every window, other windows' Start and Delete), like the mark of an ended window, and the
 * next open of any window still completes the clone.
 */
export function endedMark(mark: BusyMark): BusyMark {
  return { ...mark, since: new Date(0).toISOString() };
}

/** The busy marks are the same mark (all four fields). */
export function sameBusyMark(a: BusyMark, b: BusyMark): boolean {
  return a.operation === b.operation && a.since === b.since && a.pid === b.pid && a.windowId === b.windowId;
}

/** What decides whether a busy mark is live (isBusyMarkLive), read before the lock: the mutator does no I/O. */
export interface MarkLiveness {
  /** Milliseconds since the epoch. */
  now: number;
  /** The window status files of this computer; `undefined` when they could not be read (or are not used). */
  windowStatuses?: readonly WindowStatus[];
}

/**
 * The test "a live mark of another window" (`isBusyMarkLive`) of the window `view.owner`: a mark of this window or
 * process, of an ended process, a mark older than 6 hours, and (with window status files) a mark whose window has no
 * recent status file of that process do not count.
 */
export function otherWindowMarkIsLive(mark: BusyMark, view: Pick<BusyMarkView, 'owner' | 'isAlive'>, liveness: MarkLiveness): boolean {
  return (
    !isOwnMarkOf(mark, view.owner) &&
    mark.pid !== view.owner.pid &&
    isBusyMarkLive(mark, { now: liveness.now, isAlive: view.isAlive, windowStatuses: liveness.windowStatuses })
  );
}

function isOwnMarkOf(mark: BusyMark, owner: { windowId: string; pid: number }): boolean {
  return mark.windowId === owner.windowId && mark.pid === owner.pid;
}

/**
 * The result of `takeStepMark`: the entry with the mark that was set, the mark that keeps it (the entry is unchanged),
 * or `undefined` when the devspace is not in the registry.
 */
export type StepMarkResult = { devspace: Devspace; mark: BusyMark } | { devspace: Devspace; conflict: BusyMark } | undefined;

/**
 * The fields of the configuration that an open records; each one only when given, in this order. Volumes are only ever
 * added (a volume that the devspace used may still hold its data).
 */
export interface ConfigurationChange {
  /** Devspace.configPath: the selected configuration (or the one restored after a failed start). */
  select?: string;
  /**
   * Devspace.defaultImage: the default image that this open of a default-image devspace uses in place of the
   * configuration (DevspaceSource). A devspace never changes its kind: the field is never removed.
   */
  defaultImage?: string;
  shutdownActionNone?: boolean;
  /** Joins Devspace.additionalVolumes, those not recorded yet. */
  addVolumes?: readonly string[];
  /** Joins Devspace.serviceVolumes, those not recorded yet. */
  addServiceVolumes?: readonly string[];
  /** The refused update stays only when it is of this configuration; else it is dropped. */
  keepRefusedFor?: { configPath: string; configHash: string };
  /** Devspace.serviceFolders and serviceFoldersOverflow, replaced. */
  serviceFolders?: { folders: readonly string[]; overflow: boolean };
  /** The repository was cloned again: its Git state is not known. */
  cloned?: true;
}

/** The build records of an open. */
export type BuildChange =
  /** A build number is used (before the build): Devspace.lastBuildNumber never goes back. */
  | { kind: 'number'; buildNumber: number }
  /**
   * The build record of the devspace image; with `dropRefused` (a new build of the open), the refused update goes too
   * (not when the record is taken from an existing image).
   */
  | { kind: 'record'; record: BuildRecord; dropRefused: boolean }
  /**
   * The Docker Compose record takes a new model hash and plugin version, only while it is still of `devspaceImage`.
   */
  | { kind: 'rebaseline'; devspaceImage: string; configHash: string; version: string }
  /** The update that the user or the policy refused (rememberRefusedUpdate). */
  | { kind: 'refused'; refusedUpdate: RefusedUpdate };

/** Devspace.lifecycleIncomplete set to a container, or cleared. */
export type LifecycleMarkChange = { set: string } | 'clear';

/** What the end of a successful open records (finish). */
export interface OpenFinish {
  lastUsedAt: string;
  /** The lifecycle mark that the open decided with, and the container whose commands ran. */
  lifecycleMarkRead?: string;
  lifecycleRanFor?: string;
  remoteUser?: string;
  remoteWorkspaceFolder: string;
  gitSummary?: GitSummary;
  /**
   * Read by the caller before it wrote its pending connection file (the busy mark goes after that file). This is the
   * window's own reading; when the worker sends the finish, the extension reads the liveness itself under its request
   * and never takes it from the worker.
   */
  liveness: MarkLiveness;
}

/**
 * The registry writes of the open. The methods that change an entry return it, or `undefined` when the devspace is
 * not in the registry.
 */
export interface OpenRecords {
  /** The entry of a first open (with its create mark); fails when the registry has the devspace already. */
  createDevspace(devspace: Devspace): Promise<void>;
  /** Removes the entry of a first open whose lock was refused (nothing was created on Docker). */
  dropCreated(devspaceId: string): Promise<void>;
  /**
   * The create mark after a failed clone, when this window holds a mark: `ended` keeps it as ended; `previous` gives
   * back `previous`, the mark that the open found (as ended when it is of this window), or clears the mark when there
   * was none.
   */
  createMark(devspaceId: string, kind: 'ended' | 'previous', previous?: BusyMark): Promise<Devspace | undefined>;
  /**
   * Sets a busy mark of this window for `operation` unless the entry has a mark that is not an ended one (a live mark
   * of another window, any mark of this window or process).
   */
  takeStepMark(devspaceId: string, operation: BusyOperation): Promise<StepMarkResult>;
  /** Clears `mark` (the mark that takeStepMark set), and no other. */
  releaseStepMark(devspaceId: string, mark: BusyMark): Promise<Devspace | undefined>;
  /** The login of the owner, when the entry belongs to `account`. */
  ownerLogin(devspaceId: string, account: GitHubAccount): Promise<Devspace | undefined>;
  configuration(devspaceId: string, change: ConfigurationChange): Promise<Devspace | undefined>;
  build(devspaceId: string, change: BuildChange): Promise<Devspace | undefined>;
  lifecycleMark(devspaceId: string, change: LifecycleMarkChange): Promise<Devspace | undefined>;
  /** The end of a successful open: last use, the container facts, and the busy mark goes (unless another window's live one). */
  openFinished(devspaceId: string, finish: OpenFinish): Promise<Devspace | undefined>;
}

/** The registry writes of the open over the registry of this computer (the extension's side). */
export function registryOpenRecords(registry: Pick<DevspaceRegistry, 'add' | 'remove' | 'updateDevspace'>, view: BusyMarkView): OpenRecords {
  const isOwnMark = (mark: BusyMark) => isOwnMarkOf(mark, view.owner);
  return {
    async createDevspace(devspace) {
      await registry.add(devspace);
    },
    async dropCreated(devspaceId) {
      await registry.remove(devspaceId, { kept: [] });
    },
    createMark(devspaceId, kind, previous) {
      return registry.updateDevspace(devspaceId, (entry) => {
        if (kind === 'ended') {
          if (entry.busy && isOwnMark(entry.busy)) entry.busy = endedMark(entry.busy);
          return;
        }
        if (!entry.busy || !isOwnMark(entry.busy)) return;
        // The create mark of a failed first open of this window (kept because its volume could not be removed) comes
        // back too, so a resume that fails again does not lose the clone.
        if (previous) entry.busy = isOwnMark(previous) ? endedMark(previous) : previous;
        else delete entry.busy;
      });
    },
    async takeStepMark(devspaceId, operation) {
      const mark: BusyMark = { operation, since: isoTime(view.clock), pid: view.owner.pid, windowId: view.owner.windowId };
      const state: { conflict?: BusyMark } = {};
      // Read before the lock: the mutator does no I/O.
      const liveness = await readLiveness(view);
      const updated = await registry.updateDevspace(devspaceId, (entry) => {
        if (entry.busy && (otherWindowMarkIsLive(entry.busy, view, liveness) || isOwnMark(entry.busy) || entry.busy.pid === view.owner.pid)) {
          state.conflict = entry.busy;
          return;
        }
        entry.busy = mark;
      });
      if (!updated) return undefined;
      return state.conflict ? { devspace: updated, conflict: state.conflict } : { devspace: updated, mark };
    },
    releaseStepMark(devspaceId, mark) {
      return registry.updateDevspace(devspaceId, (entry) => {
        if (entry.busy !== undefined && sameBusyMark(entry.busy, mark)) delete entry.busy;
      });
    },
    ownerLogin(devspaceId, account) {
      return registry.updateDevspace(devspaceId, (entry) => {
        if (entry.owner.id === account.id) entry.owner = ownerOf(account);
      });
    },
    configuration(devspaceId, change) {
      return registry.updateDevspace(devspaceId, (entry) => {
        if (change.select !== undefined) entry.configPath = change.select;
        if (change.defaultImage !== undefined) entry.defaultImage = change.defaultImage;
        if (change.shutdownActionNone !== undefined) entry.shutdownActionNone = change.shutdownActionNone;
        // A name once, also when the change repeats it.
        if (change.addVolumes !== undefined) {
          const recorded = entry.additionalVolumes ?? [];
          const added = [...new Set(change.addVolumes)].filter((name) => !recorded.includes(name));
          if (added.length > 0) entry.additionalVolumes = [...recorded, ...added];
        }
        if (change.addServiceVolumes !== undefined) {
          const services = entry.serviceVolumes ?? [];
          const used = [...new Set(change.addServiceVolumes)].filter((name) => !services.includes(name));
          if (used.length > 0) entry.serviceVolumes = [...services, ...used];
        }
        if (change.keepRefusedFor !== undefined) {
          // A refused update of another configuration is not tried again anyway.
          const refused = refusedUpdateOf(entry);
          if ('refusedUpdate' in entry && (refused?.configPath !== change.keepRefusedFor.configPath || refused.configHash !== change.keepRefusedFor.configHash)) {
            delete entry.refusedUpdate;
          }
        }
        if (change.serviceFolders !== undefined) {
          if (change.serviceFolders.folders.length > 0) entry.serviceFolders = [...change.serviceFolders.folders];
          else delete entry.serviceFolders;
          if (change.serviceFolders.overflow) entry.serviceFoldersOverflow = true;
          else delete entry.serviceFoldersOverflow;
        }
        if (change.cloned === true) delete entry.gitSummary;
      });
    },
    build(devspaceId, change) {
      return registry.updateDevspace(devspaceId, (entry) => {
        switch (change.kind) {
          case 'number':
            entry.lastBuildNumber = Math.max(entry.lastBuildNumber ?? 0, change.buildNumber);
            return;
          case 'record':
            entry.buildRecord = change.record;
            entry.lastBuildNumber = Math.max(entry.lastBuildNumber ?? 0, change.record.buildNumber);
            if (change.dropRefused) delete entry.refusedUpdate;
            return;
          case 'rebaseline': {
            const compose = composeRecordOf(entry.buildRecord);
            if (!entry.buildRecord || !compose || entry.buildRecord.devspaceImage !== change.devspaceImage) return;
            entry.buildRecord.configHash = change.configHash;
            entry.buildRecord.compose = { ...compose, version: change.version };
            return;
          }
          case 'refused':
            entry.refusedUpdate = change.refusedUpdate;
            return;
        }
      });
    },
    lifecycleMark(devspaceId, change) {
      return registry.updateDevspace(devspaceId, (entry) => {
        if (change === 'clear') delete entry.lifecycleIncomplete;
        else entry.lifecycleIncomplete = change.set;
      });
    },
    openFinished(devspaceId, finish) {
      return registry.updateDevspace(devspaceId, (entry) => {
        entry.lastUsedAt = finish.lastUsedAt;
        // Close and Keep Running holds only until a window connects again.
        delete entry.keepRunningOnce;
        // The container that opens ran its lifecycle commands in this open (or runs as it ran before, and a mark of
        // another container names one that this open replaced or that is gone). Only the mark that this run decided
        // with, or one that names the container whose lifecycle commands this run ran, is cleared; a mark that another
        // window set meanwhile (Step 9 holds no busy mark) stays.
        if (lifecycleMarkClears(entry.lifecycleIncomplete, finish.lifecycleMarkRead, finish.lifecycleRanFor)) delete entry.lifecycleIncomplete;
        if (finish.remoteUser) entry.remoteUser = finish.remoteUser;
        entry.remoteWorkspaceFolder = finish.remoteWorkspaceFolder;
        if (finish.gitSummary) entry.gitSummary = finish.gitSummary;
        // The own mark, and a mark that an ended window left behind (it protects nothing, see markBlocker). A live mark of
        // another window stays.
        if (entry.busy && (isOwnMark(entry.busy) || !otherWindowMarkIsLive(entry.busy, view, finish.liveness))) delete entry.busy;
      });
    },
  };
}

/** The window status files (when the view reads them; a failure is logged) and the time, for otherWindowMarkIsLive. */
export async function readLiveness(view: Pick<BusyMarkView, 'clock' | 'windowStatuses' | 'logger'>): Promise<MarkLiveness> {
  let windowStatuses: readonly WindowStatus[] | undefined;
  if (view.windowStatuses) {
    try {
      windowStatuses = await view.windowStatuses();
    } catch (error) {
      view.logger.warn(`The window status files could not be read: ${errorMessage(error)}`);
    }
  }
  return { now: view.clock.now(), windowStatuses };
}
