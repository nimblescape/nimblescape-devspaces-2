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

export interface RelayConnectionsOptions {
  logger: Logger;
  idleCloseMs?: number;
  sweepIntervalMs?: number;
  /** Only for the tests. */
  now?: () => number;
}

/**
 * The connection of the relay to a remote engine (ChannelOpenDeps.relay): the open connection of the engine, which the
 * worker channel and the Docker pipe of the window share, or a new one.
 */
export interface RelayAccess {
  /** The open connection to the engine; undefined when none is open. */
  current(): RelayConnection | undefined;
  /**
   * Opens a new connection: starts `command` (`docker run …`) on the computer of the engine and writes `bundle` as the
   * first line of its pipe loader. It is `current` from then on.
   */
  connect(command: readonly string[], bundle: string): Promise<RelayConnection>;
}

/** The RelayAccess of the engine on `host`: the connection of `connections`, or a new one with `connect` that it keeps. */
export function relayAccess(
  connections: RelayConnections,
  host: string,
  connect: (command: readonly string[], bundle: string) => Promise<RelayConnection>,
): RelayAccess {
  return {
    current: () => connections.get(host),
    connect: async (command, bundle) => {
      const connection = await connect(command, bundle);
      connections.add(host, connection);
      return connection;
    },
  };
}

/** The connections of the relay of this window, by the Docker host (DockerTarget.host). */
export class RelayConnections {
  private readonly current = new Map<string, RelayConnection>();
  /** Every connection that is not closed yet, with the time since when it has no stream. */
  private readonly all = new Map<RelayConnection, { host: string; idleSince?: number }>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private disposed = false;

  constructor(private readonly options: RelayConnectionsOptions) {
    this.sweepTimer = setInterval(() => this.sweep(), options.sweepIntervalMs ?? RELAY_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  /** The open connection to `host`, or undefined. */
  get(host: string): RelayConnection | undefined {
    const connection = this.current.get(host);
    return connection?.isOpen ? connection : undefined;
  }

  /**
   * Keeps `connection` as the connection to `host` (a new one that the worker channel opened). An older connection to
   * the host stays until its streams ended and it was idle, so a stream on it is not lost. After `dispose`, it is
   * stopped at once.
   */
  add(host: string, connection: RelayConnection): void {
    if (this.disposed) {
      connection.killNow();
      return;
    }
    this.current.set(host, connection);
    this.all.set(connection, { host });
    connection.onClose(() => {
      this.all.delete(connection);
      if (this.current.get(host) === connection) this.current.delete(host);
    });
  }

  /** Closes every connection to `host` ("Remove Devspaces from This Docker Engine…"); its streams are lost. */
  close(host: string, reason: string): void {
    for (const [connection, entry] of [...this.all]) if (entry.host === host) connection.close(reason);
  }

  /** Closes the connections that had no stream for RELAY_IDLE_CLOSE_MS (measured at the sweeps). */
  sweep(): void {
    const now = (this.options.now ?? Date.now)();
    const idleMs = this.options.idleCloseMs ?? RELAY_IDLE_CLOSE_MS;
    for (const [connection, entry] of [...this.all]) {
      if (connection.streamCount > 0) {
        entry.idleSince = undefined;
        continue;
      }
      entry.idleSince ??= now;
      if (now - entry.idleSince < idleMs) continue;
      this.options.logger.info(`The connection to ${entry.host} was closed after a time without use.`);
      connection.close('closed after a time without use');
    }
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
