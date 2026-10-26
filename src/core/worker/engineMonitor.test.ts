// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The engine of the ensure of the Monitor over the port of the worker's engine (engineMonitor): how it reads
// the answers of the Engine API as the ensure needs them.
import { createHash } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import { MAX_BUNDLE_LINE_LENGTH } from '../loader/pipeLoader';
import { LABEL_MONITOR, REMOTE_MONITOR_SCRIPT_PATH } from '../remoteMonitor/protocol';
import { EngineError, type DockerEngine } from './dockerEngine';
import { unusedEngine } from './dockerEngine.testkit';
import { MAX_STORED_SCRIPT_BYTES, engineMonitor, limited, monitorInspected } from './engineMonitor';

const ID = 'feed'.padEnd(64, '1');
const INSPECT = {
  Id: ID,
  Created: '2026-10-04T12:00:00.5Z',
  RestartCount: 2,
  State: { Status: 'exited', ExitCode: 3 },
  Config: { Labels: { [LABEL_MONITOR]: 'label-1', other: 'x' } },
};
const abortError = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });

function with_(methods: Partial<DockerEngine>) {
  return engineMonitor({ ...unusedEngine(), ...methods });
}

describe('the engine of the ensure of the Monitor over the Engine API', () => {
  it('reads the inspect of the container: status, exit code, label, restarts, ID and creation time; missing when the engine has none', async () => {
    expect(monitorInspected(INSPECT)).toEqual({ exists: true, status: 'exited', exitCode: 3, label: 'label-1', restartCount: 2, id: ID, createdAt: Date.parse('2026-10-04T12:00:00.500Z') });
    expect(monitorInspected(undefined)).toEqual({ exists: false });
    // What cannot be read is left out, never guessed.
    expect(monitorInspected({ Id: 'short', RestartCount: -1, State: { Status: 3, ExitCode: 1.5 }, Config: {}, Created: 'yesterday' })).toEqual({
      exists: true,
      status: '',
      exitCode: undefined,
      label: '',
      restartCount: 0,
      id: undefined,
      createdAt: undefined,
    });
    // The restart policy (an empty name is `no`, as Docker shows a container created without one).
    for (const [name, policy] of [
      ['unless-stopped', 'unless-stopped'],
      ['no', 'no'],
      ['', 'no'],
    ]) {
      expect(monitorInspected({ ...INSPECT, HostConfig: { RestartPolicy: { Name: name, MaximumRetryCount: 0 } } })).toMatchObject({ restartPolicy: policy });
    }
    expect(monitorInspected({ ...INSPECT, HostConfig: { RestartPolicy: { Name: 7 } } })).not.toHaveProperty('restartPolicy');
    const inspect = vi.fn(async () => INSPECT as unknown);
    expect(await with_({ inspect }).inspect('devspaces-monitor')).toMatchObject({ exists: true, id: ID });
    expect(inspect).toHaveBeenCalledWith('container', 'devspaces-monitor', expect.any(AbortSignal));
  });

  it('an inspect that fails rejects with its cause; one past its time limit with "no answer in time"; a cancel passes', async () => {
    await expect(with_({ inspect: async () => Promise.reject(new EngineError('permission denied', 403)) }).inspect('m')).rejects.toThrow('docker container inspect failed: permission denied');
    // The time limit of each call (here a short one): past it, "no answer in time"; the call gets the limit as its signal.
    const hanging = limited(50, undefined, (signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(abortError()))));
    await expect(hanging).rejects.toThrow('no answer in time');
    // The limit of the inspect is that of a Docker call (60 s): its signal aborts with it.
    let given: AbortSignal | undefined;
    await with_({
      inspect: async (_kind, _name, signal) => {
        given = signal;
        return INSPECT;
      },
    }).inspect('m');
    expect(given?.aborted).toBe(false);
    const controller = new AbortController();
    const cancelled = with_({ inspect: (_kind, _name, signal) => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(abortError()))) }).inspect('m', controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('the clock of the daemon, or why it cannot be read', async () => {
    expect(await with_({ systemTime: async () => '2026-10-04T12:00:00Z' }).daemonTime()).toBe(Date.parse('2026-10-04T12:00:00Z'));
    expect(await with_({ systemTime: async () => 'soon' }).daemonTime()).toEqual({ reason: 'the engine gave the time "soon"' });
    expect(await with_({ systemTime: async () => Promise.reject(new Error('connect ENOENT')) }).daemonTime()).toEqual({ reason: 'connect ENOENT' });
  });

  it('removes by the ID; a removal that another window runs is no failure, anything else is', async () => {
    const removeContainer = vi.fn(async () => {});
    await with_({ removeContainer }).remove(ID);
    expect(removeContainer).toHaveBeenCalledWith(ID, expect.any(AbortSignal));
    await expect(with_({ removeContainer: async () => Promise.reject(new EngineError(`removal of container ${ID} is already in progress`, 409)) }).remove(ID)).resolves.toBeUndefined();
    await expect(with_({ removeContainer: async () => Promise.reject(new EngineError('device busy', 500)) }).remove(ID)).rejects.toThrow('docker rm failed: device busy');
    await expect(with_({ start: async () => Promise.reject(new EngineError('no such file', 500)) }).start(ID)).rejects.toThrow('docker start failed: no such file');
  });

  it('the stored script: the SHA-256 of the file read through the archive endpoint, definite evidence that there is none, or unknown', async () => {
    const script = Buffer.from('console.log("monitor")');
    const containerFile = vi.fn(async () => script as Buffer | 'missing' | undefined);
    expect(await with_({ containerFile }).storedScript('devspaces-monitor')).toEqual({ hash: createHash('sha256').update(script).digest('hex') });
    // Up to the longest script that the loader takes, in bytes of UTF-8.
    expect(containerFile).toHaveBeenCalledWith('devspaces-monitor', REMOTE_MONITOR_SCRIPT_PATH, MAX_STORED_SCRIPT_BYTES, expect.any(AbortSignal));
    expect(MAX_STORED_SCRIPT_BYTES).toBe(3 * MAX_BUNDLE_LINE_LENGTH);
    const answers: [string, Buffer | 'missing' | undefined | Error, unknown][] = [
      ['an empty file', Buffer.alloc(0), { hash: createHash('sha256').digest('hex') }],
      ['no stored file, or no container', 'missing', 'none'],
      ['no regular file, or too large to read', undefined, 'unknown'],
      ['a failure of the engine', new EngineError('Could not find the file / in container m', 500), 'unknown'],
      ['a transport error', new Error('socket hang up'), 'unknown'],
    ];
    for (const [what, answer, expected] of answers) {
      const engine = with_({ containerFile: async () => (answer instanceof Error ? Promise.reject(answer) : answer) });
      expect(await engine.storedScript('devspaces-monitor'), what).toEqual(expected);
    }
    const controller = new AbortController();
    controller.abort();
    await expect(with_({ containerFile: async () => Promise.reject(abortError()) }).storedScript('m', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('the IDs with a label, stopped ones included; undefined when the list fails', async () => {
    const containerIds = vi.fn(async () => [ID]);
    expect(await with_({ containerIds }).idsWithLabel('nimblescape.devspaces.monitor-create=n1')).toEqual([ID]);
    expect(containerIds).toHaveBeenCalledWith({ label: ['nimblescape.devspaces.monitor-create=n1'] }, expect.any(AbortSignal));
    expect(await with_({ containerIds: async () => Promise.reject(new Error('down')) }).idsWithLabel('x=y')).toBeUndefined();
  });

  it('the create is the attached create of the engine, within the time limit of a Docker call', async () => {
    const createAttached = vi.fn(async () => ({ kind: 'ready' as const }));
    const signal = new AbortController().signal;
    const spec = { name: 'm' } as never;
    expect(await with_({ createAttached }).create(spec, 'line\n', 'ready', signal)).toEqual({ kind: 'ready' });
    expect(createAttached).toHaveBeenCalledWith(spec, { input: 'line\n', readyText: 'ready', timeoutMs: 60_000, signal });
  });
});
