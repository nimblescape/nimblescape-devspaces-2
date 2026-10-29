// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The connections of the relay of this window (docs/architecture.md "The connection of the relay"): at most one current
// connection per Docker host, which the worker channel and the Docker pipe of the host share, so that a window logs in
// to a host once. A connection ends after RELAY_IDLE_CLOSE_MS without a stream, at `close`, and at once at `dispose`.
// No `vscode`.
import type { Logger } from '../ports';
import type { RelayConnection } from './connection';

/** A connection of the relay without a stream (no worker, no Docker stream) is closed after this long. */
export const RELAY_IDLE_CLOSE_MS = 10 * 60_000;
/** How often the connections without a stream are looked for. */
export const RELAY_SWEEP_INTERVAL_MS = 60_000;
/**
 * A new worker starts on a connection only for this long after its open (as HELPER_IMAGE_RECHECK_MS): the container of
 * the connection runs the helper image of that time, and another window or computer may have built it again since.
 */
export const RELAY_WORKER_MAX_AGE_MS = 60 * 60_000;

export interface RelayConnectionsOptions {
  logger: Logger;
  idleCloseMs?: number;
  sweepIntervalMs?: number;
  workerMaxAgeMs?: number;
  /** Only for the tests. */
  now?: () => number;
}

/**
 * The connection of the relay to a remote engine (ChannelOpenDeps.relay): the open connection of the engine, which the
 * worker channel and the Docker pipe of the window share, or a new one.
 */
export interface RelayAccess {
  /** The open connection to the engine on which a worker may start; undefined when none is open (see retire). */
  current(): RelayConnection | undefined;
  /**
   * Opens a new connection: starts `command` (`docker run …`) on the computer of the engine and writes `bundle` as the
   * first line of its pipe loader. It becomes the current one only with `use`, after its worker passed its checks.
   */
  connect(command: readonly string[], bundle: string): Promise<RelayConnection>;
  /** `connection` (from connect) is the current connection to the engine from now on. */
  use(connection: RelayConnection): void;
  /** No new worker starts on `connection` (a worker could not be opened on it); the next worker opens a new one. */
  retire(connection: RelayConnection): void;
}

/** The RelayAccess of the engine on `host`: the connection of `connections`, or a new one with `connect` that it keeps. */
export function relayAccess(
  connections: RelayConnections,
  host: string,
  connect: (command: readonly string[], bundle: string) => Promise<RelayConnection>,
): RelayAccess {
  return {
    current: () => connections.forWorker(host),
    connect: async (command, bundle) => {
      const connection = await connect(command, bundle);
      // The window closed meanwhile: `add` stopped it.
      if (!connections.add(host, connection)) throw new Error('The window closes.');
      return connection;
    },
    use: (connection) => connections.use(host, connection),
    retire: (connection) => connections.retire(connection),
  };
}

/** The connections of the relay of this window, by the Docker host (DockerTarget.host). */
export class RelayConnections {
  private readonly current = new Map<string, RelayConnection>();
  /**
   * Every connection that is not closed yet: its host, the time of its open, the time since when it has no stream, the
   * number of streams that were opened on it at the last sweep, and whether new workers may start on it.
   */
  private readonly all = new Map<RelayConnection, { host: string; addedAt: number; idleSince?: number; opened: number; retired: boolean }>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private disposed = false;

  constructor(private readonly options: RelayConnectionsOptions) {
    this.sweepTimer = setInterval(() => this.sweep(), options.sweepIntervalMs ?? RELAY_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  /** The open connection to `host` for a Docker stream, or undefined. */
  get(host: string): RelayConnection | undefined {
    const connection = this.current.get(host);
    return connection?.isOpen ? connection : undefined;
  }

  /** The open connection to `host` on which a new worker may start (not retired, opened within RELAY_WORKER_MAX_AGE_MS), or undefined. */
  forWorker(host: string): RelayConnection | undefined {
    const connection = this.get(host);
    const entry = connection === undefined ? undefined : this.all.get(connection);
    if (entry === undefined || entry.retired) return undefined;
    return Math.abs(this.now() - entry.addedAt) < (this.options.workerMaxAgeMs ?? RELAY_WORKER_MAX_AGE_MS) ? connection : undefined;
  }

  /**
   * Keeps `connection` to `host` (a new one that the worker channel opened) until it ends, for `close`, the sweeps and
   * `dispose`; it is not the current one before `use`. After `dispose`, it is stopped at once (false).
   */
  add(host: string, connection: RelayConnection): boolean {
    if (this.disposed) {
      connection.killNow();
      return false;
    }
    this.all.set(connection, { host, addedAt: this.now(), opened: connection.streamsOpened, retired: false });
    connection.onClose(() => {
      this.all.delete(connection);
      if (this.current.get(host) === connection) this.current.delete(host);
    });
    return true;
  }

  /**
   * `connection` (added, its worker passed its checks) is the connection to `host` from now on. An older connection to
   * the host stays until its streams ended and it was idle, so a stream on it is not lost.
   */
  use(host: string, connection: RelayConnection): void {
    if (this.all.get(connection)?.host === host && connection.isOpen) this.current.set(host, connection);
  }

  /** No new worker starts on `connection`; it still carries its streams and the Docker streams until a new one is used. */
  retire(connection: RelayConnection): void {
    const entry = this.all.get(connection);
    if (entry !== undefined) entry.retired = true;
  }

  /**
   * No new worker starts on the connections to `host` (every host when undefined): the helper image was built again, and
   * the containers of these connections run the image from before.
   */
  retireAll(host?: string): void {
    for (const entry of this.all.values()) if (host === undefined || entry.host === host) entry.retired = true;
  }

  /** Closes every connection to `host` ("Remove Devspaces from This Docker Engine…"); its streams are lost. */
  close(host: string, reason: string): void {
    for (const [connection, entry] of [...this.all]) if (entry.host === host) connection.close(reason);
  }

  /**
   * Closes the connections that had no stream for RELAY_IDLE_CLOSE_MS (measured at the sweeps; a stream that was opened
   * and ended between two sweeps counts as use).
   */
  sweep(): void {
    const now = this.now();
    const idleMs = this.options.idleCloseMs ?? RELAY_IDLE_CLOSE_MS;
    for (const [connection, entry] of [...this.all]) {
      const opened = connection.streamsOpened;
      if (connection.streamCount > 0 || opened !== entry.opened) {
        entry.opened = opened;
        entry.idleSince = undefined;
        continue;
      }
      entry.idleSince ??= now;
      if (now - entry.idleSince < idleMs) continue;
      this.options.logger.info(`The connection to ${entry.host} was closed after a time without use.`);
      connection.close('closed after a time without use');
    }
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Stops every connection at once (the window closes; no timer of the extension host runs after it). */
  dispose(): void {
    this.disposed = true;
    clearInterval(this.sweepTimer);
    for (const connection of [...this.all.keys()]) connection.killNow();
    this.all.clear();
    this.current.clear();
  }
}
