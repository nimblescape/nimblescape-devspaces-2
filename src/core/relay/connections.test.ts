// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../ports';
import type { RelayConnection } from './connection';
import { RELAY_IDLE_CLOSE_MS, RELAY_WORKER_MAX_AGE_MS, RelayConnections, relayAccess } from './connections';

/** A connection of the test: its streams are set by the test; close and killNow end it. */
class FakeConnection {
  streamCount = 0;
  streamsOpened = 0;
  isOpen = true;
  readonly ends: string[] = [];
  private listener: ((reason: string) => void) | undefined;

  onClose(listener: (reason: string) => void): () => void {
    this.listener = listener;
    return () => {};
  }

  close(reason = 'closed'): void {
    this.end(`close ${reason}`);
  }

  killNow(): void {
    this.end('killNow');
  }

  private end(what: string): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.ends.push(what);
    this.listener?.(what);
  }
}

const registries: RelayConnections[] = [];

afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose();
});

function registry(now: () => number = () => 0): RelayConnections {
  const connections = new RelayConnections({ logger: silentLogger, now });
  registries.push(connections);
  return connections;
}

const asConnection = (fake: FakeConnection) => fake as unknown as RelayConnection;

/** Adds `fake` and uses it as the connection to `host` (its worker passed the checks). */
function addUsed(connections: RelayConnections, host: string, fake: FakeConnection): void {
  connections.add(host, asConnection(fake));
  connections.use(host, asConnection(fake));
}

describe('RelayConnections', () => {
  it('keeps the connection of each host once it is used, and forgets it when it ends', () => {
    const connections = registry();
    const box = new FakeConnection();
    const other = new FakeConnection();
    connections.add('build-box', asConnection(box));
    // Not before its worker passed the checks.
    expect(connections.get('build-box')).toBeUndefined();
    connections.use('build-box', asConnection(box));
    addUsed(connections, 'me@other:2222', other);
    // Never as the connection of another host.
    connections.use('third', asConnection(box));
    expect(connections.get('build-box')).toBe(box);
    expect(connections.get('me@other:2222')).toBe(other);
    expect(connections.get('third')).toBeUndefined();
    box.close('the transport ended');
    expect(connections.get('build-box')).toBeUndefined();
    expect(connections.get('me@other:2222')).toBe(other);
  });

  it('closes a connection after RELAY_IDLE_CLOSE_MS without a stream, measured at the sweeps', () => {
    let now = 0;
    const connections = registry(() => now);
    const connection = new FakeConnection();
    addUsed(connections, 'build-box', connection);
    connection.streamCount = 1;
    connections.sweep();
    now = RELAY_IDLE_CLOSE_MS * 2;
    connections.sweep();
    expect(connection.ends).toEqual([]);
    // The time without a stream counts from the first sweep that saw none.
    connection.streamCount = 0;
    connections.sweep();
    now += RELAY_IDLE_CLOSE_MS - 1;
    connections.sweep();
    expect(connection.ends).toEqual([]);
    // A stream in between starts the count again.
    connection.streamCount = 2;
    connections.sweep();
    connection.streamCount = 0;
    now += 1;
    connections.sweep();
    expect(connection.ends).toEqual([]);
    // A short stream that ended between two sweeps starts the count again too.
    now += RELAY_IDLE_CLOSE_MS;
    connection.streamsOpened++;
    connections.sweep();
    now += 1;
    connections.sweep();
    now += RELAY_IDLE_CLOSE_MS - 1;
    connections.sweep();
    expect(connection.ends).toEqual([]);
    now += 1;
    connections.sweep();
    expect(connection.ends).toEqual(['close closed after a time without use']);
    expect(connections.get('build-box')).toBeUndefined();
  });

  it('keeps an older connection of a host as long as it is used, with the newer one as the current one', () => {
    let now = 0;
    const connections = registry(() => now);
    const older = new FakeConnection();
    const newer = new FakeConnection();
    older.streamCount = 1;
    addUsed(connections, 'build-box', older);
    addUsed(connections, 'build-box', newer);
    expect(connections.get('build-box')).toBe(newer);
    older.close('the worker ended');
    expect(connections.get('build-box')).toBe(newer);
    now = RELAY_IDLE_CLOSE_MS;
    connections.sweep();
    now *= 2;
    connections.sweep();
    expect(newer.ends).toEqual(['close closed after a time without use']);
  });

  it('closes every connection of a host at close, and stops every connection at once at dispose, also one added after it', () => {
    const connections = new RelayConnections({ logger: silentLogger });
    const a = new FakeConnection();
    const b = new FakeConnection();
    const other = new FakeConnection();
    connections.add('build-box', asConnection(a));
    connections.add('build-box', asConnection(b));
    connections.add('other', asConnection(other));
    connections.close('build-box', 'Devspaces is removed from the engine');
    expect([a.ends, b.ends, other.ends]).toEqual([['close Devspaces is removed from the engine'], ['close Devspaces is removed from the engine'], []]);
    connections.dispose();
    expect(other.ends).toEqual(['killNow']);
    const late = new FakeConnection();
    connections.add('build-box', asConnection(late));
    expect(late.ends).toEqual(['killNow']);
    expect(connections.get('build-box')).toBeUndefined();
  });

  it('relayAccess: the open connection of the host for a worker, or a new one that the registry keeps and that the host uses after `use`', async () => {
    const connections = registry();
    const created = new FakeConnection();
    const connect = vi.fn(async () => asConnection(created));
    const access = relayAccess(connections, 'build-box', connect);
    expect(access.current()).toBeUndefined();
    await expect(access.connect(['docker', 'run'], 'bundle')).resolves.toBe(created);
    expect(connect).toHaveBeenCalledWith(['docker', 'run'], 'bundle');
    expect([access.current(), connections.get('build-box')]).toEqual([undefined, undefined]);
    access.use(asConnection(created));
    expect(access.current()).toBe(created);
    expect(connections.get('build-box')).toBe(created);
    // Retired: it still carries the Docker streams, but the next worker opens a new connection.
    access.retire(asConnection(created));
    expect(access.current()).toBeUndefined();
    expect(connections.get('build-box')).toBe(created);
    // A connection that comes after the window closed is stopped, and the open fails.
    connections.dispose();
    const late = new FakeConnection();
    await expect(relayAccess(connections, 'build-box', async () => asConnection(late)).connect(['docker', 'run'], 'bundle')).rejects.toThrow('The window closes.');
    expect(late.ends).toEqual(['killNow']);
  });

  it('retires the connections of a host, or of every host, for new workers after a build of the helper image', () => {
    const connections = registry();
    const box = new FakeConnection();
    const other = new FakeConnection();
    addUsed(connections, 'build-box', box);
    addUsed(connections, 'other', other);
    connections.retireAll('build-box');
    expect([connections.forWorker('build-box'), connections.forWorker('other')]).toEqual([undefined, other]);
    connections.retireAll();
    expect(connections.forWorker('other')).toBeUndefined();
    expect([connections.get('build-box'), connections.get('other')]).toEqual([box, other]);
  });

  it('starts new workers on a connection only for RELAY_WORKER_MAX_AGE_MS after its open, and keeps its Docker streams', () => {
    let now = 0;
    const connections = registry(() => now);
    const box = new FakeConnection();
    box.streamCount = 1;
    addUsed(connections, 'build-box', box);
    now = RELAY_WORKER_MAX_AGE_MS - 1;
    expect(connections.forWorker('build-box')).toBe(box);
    now = RELAY_WORKER_MAX_AGE_MS;
    expect(connections.forWorker('build-box')).toBeUndefined();
    expect(connections.get('build-box')).toBe(box);
  });
});
