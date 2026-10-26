// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { dockerTargetOf, remoteContextNames, LOCAL_DOCKER_TARGET, type DockerTarget } from '../docker/dockerHost';
import { operationDockerTarget } from '../docker/dockerTargets';
import { abortError, silentLogger, type Logger, type StartedProcess } from '../ports';
import { UserFacingError } from '../errors';
import { setUserAgentVersion } from '../http';
import { HelperChannel, HelperChannelError } from './helperChannel';
import {
  CHANNEL_PASSIVE_OPEN_WAIT_MS,
  CHANNEL_PROBE_TIMEOUT_MS,
  CHANNEL_REFRESH_TIMEOUT_MS,
  CHANNEL_RETRY_AFTER_FAILURE_MS,
  HelperChannels,
  channelRunArgs,
  openHelperChannel,
} from './helperChannels';
import { PIPE_LOADER, bundleHash } from '../loader/pipeLoader';
import { LABEL_HELPER_CHANNEL } from '../names';
import {
  CHANNEL_IDLE_CLOSE_MS,
  CHANNEL_PROTOCOL_VERSION,
  MAX_REFRESH_DEVSPACES,
  encodeMessage,
  parseClientMessage,
  refreshValue,
} from './protocol';
import { EXPECTED_STATES, REFRESH_DEVSPACES } from '../pipeline/refreshStates.testkit';

// The Docker context of a host is named after it (remoteContextNames).
const REMOTE: DockerTarget = dockerTargetOf('ssh://build-box', remoteContextNames('build-box')[0]);
/** The engine identity (ENGINE_IDENTITY_ARGS) of the engine of the tests. */
const ENGINE = '"7b1c7a44-2f0e-4d38-9d1d-3a8f7b0e8c11" "/var/lib/docker"';
/**
 * The same identity as the worker answers it (ProbeValue.engine, the values of `GET /info`); ENGINE is the output of
 * the extension's own Docker CLI.
 */
const ENGINE_IDENTITY = { id: '7b1c7a44-2f0e-4d38-9d1d-3a8f7b0e8c11', rootDir: '/var/lib/docker' };
const directEngine = async () => ({ exitCode: 0, stdout: `${ENGINE}\n`, stderr: '', timedOut: false });
/**
 * A short wait for an opening channel (5 s); the tests below go beyond it to show that a call awaits the open in full.
 */
const OLD_OPEN_WAIT_MS = 5_000;
/** The value of the flow of the fake channel. */
const FLOWED = { outcome: 'notRunning' };

/** A channel stand-in with the parts that HelperChannels uses. */
function fakeChannel() {
  const closeListeners: ((reason: string) => void)[] = [];
  const channel = {
    isOpen: true,
    busy: 0,
    lastUsed: Date.now(),
    closed: 0,
    onClose: (listener: (reason: string) => void) => {
      closeListeners.push(listener);
      return () => {};
    },
    close: () => {
      channel.isOpen = false;
      channel.closed++;
      for (const listener of closeListeners) listener('closed');
    },
    // dispose closes at once.
    closeNow: () => channel.close(),
    lose: () => {
      channel.isOpen = false;
      for (const listener of closeListeners) listener('lost');
    },
    flow: vi.fn(async (_op: string, _params: unknown, _options?: unknown): Promise<unknown> => ({ outcome: 'notRunning' })),
  };
  return channel;
}

function recordingLogger() {
  const lines: string[] = [];
  const logger: Logger = { ...silentLogger, info: (text) => lines.push(text), warn: (text) => lines.push(text) };
  return { logger, lines };
}

describe('HelperChannels', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // The worker is used for the local Docker too, never for an unsupported endpoint.
  it('opens a channel for the local Docker, none for an unsupported endpoint', async () => {
    const channel = fakeChannel();
    const open = vi.fn(async () => channel as unknown as HelperChannel);
    const channels = new HelperChannels({ open, logger: silentLogger });
    expect(await channels.get(LOCAL_DOCKER_TARGET)).toBe(channel);
    expect(await channels.flow(LOCAL_DOCKER_TARGET, 'tokenRemove', {})).toEqual(FLOWED);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(LOCAL_DOCKER_TARGET);
    const unsupported = dockerTargetOf('tcp://build-box:2375', 'tcp-box');
    expect(unsupported.kind).toBe('unsupported');
    expect(await channels.get(unsupported)).toBeUndefined();
    // Refused.
    await expect(channels.flow(unsupported, 'tokenRemove', {})).rejects.toMatchObject({ code: 'unavailable', message: 'the Docker endpoint is neither local nor SSH' });
    expect(open).toHaveBeenCalledTimes(1);
    channels.dispose();
  });

  // The Docker engine began to answer, or the helper image was built.
  it('clearFailures ends the wait after a failed open', async () => {
    const channel = fakeChannel();
    const open = vi.fn().mockRejectedValueOnce(new HelperChannelError('open', 'no image.')).mockResolvedValueOnce(channel);
    const channels = new HelperChannels({ open, logger: silentLogger });
    expect(await channels.get(REMOTE)).toBeUndefined();
    expect(await channels.get(REMOTE)).toBeUndefined();
    expect(open).toHaveBeenCalledTimes(1);
    channels.clearFailures();
    expect(await channels.get(REMOTE)).toBe(channel);
    expect(open).toHaveBeenCalledTimes(2);
    channels.dispose();
  });

  it('opens one channel per host at its first use, shared by callers at the same time', async () => {
    const channel = fakeChannel();
    const open = vi.fn(async () => channel as unknown as HelperChannel);
    const channels = new HelperChannels({ open, logger: silentLogger });
    const [a, b] = await Promise.all([channels.get(REMOTE), channels.get(REMOTE)]);
    expect(a).toBe(channel);
    expect(b).toBe(channel);
    expect(await channels.get(REMOTE)).toBe(channel);
    expect(open).toHaveBeenCalledTimes(1);
    // The context named after the host (remoteContextNames).
    const other = dockerTargetOf('ssh://other-box', remoteContextNames('other-box')[0]);
    await channels.get(other);
    expect(open).toHaveBeenCalledTimes(2);
    channels.dispose();
  });

  // A context of the user pointed to another host under the same name.
  it('opens a channel of its own for the same context with another endpoint; the old one gets no new call', async () => {
    const first = fakeChannel();
    const second = fakeChannel();
    const open = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const channels = new HelperChannels({ open, logger: silentLogger });
    const before = dockerTargetOf('ssh://host-a', 'prod');
    const after = dockerTargetOf('ssh://host-b', 'prod');
    expect(await channels.get(before)).toBe(first);
    expect(await channels.get(after)).toBe(second);
    expect(open).toHaveBeenLastCalledWith(after);
    expect(await channels.get(after)).toBe(second);
    expect(open).toHaveBeenCalledTimes(2);
    channels.dispose();
  });

  // "Remove Devspaces from This Docker Engine…" ends the worker of the engine before it removes its container.
  it('close ends the channel of one engine; the next call opens a new one, and an open that runs is closed when it ends', async () => {
    const first = fakeChannel();
    const second = fakeChannel();
    const local = fakeChannel();
    const opening = fakeChannel();
    let finishOpen: (channel: HelperChannel) => void = () => {};
    const open = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(local)
      .mockResolvedValueOnce(second)
      .mockImplementationOnce(() => new Promise<HelperChannel>((resolve) => (finishOpen = resolve)));
    const { logger, lines } = recordingLogger();
    const channels = new HelperChannels({ open, logger });
    expect(await channels.get(REMOTE)).toBe(first);
    expect(await channels.get(LOCAL_DOCKER_TARGET)).toBe(local);
    channels.close(REMOTE);
    expect(first.closed).toBe(1);
    expect(lines).toContain('The helper channel to build-box was closed.');
    // The other engine keeps its channel.
    expect(local.closed).toBe(0);
    expect(await channels.get(LOCAL_DOCKER_TARGET)).toBe(local);
    expect(await channels.get(REMOTE)).toBe(second);
    expect(open).toHaveBeenCalledTimes(3);
    // Closed while it is being opened: the channel of that open is closed, and is not used.
    channels.close(REMOTE);
    expect(second.closed).toBe(1);
    const pending = channels.get(dockerTargetOf('ssh://other-box', remoteContextNames('other-box')[0]));
    channels.close(dockerTargetOf('ssh://other-box', remoteContextNames('other-box')[0]));
    finishOpen(opening as unknown as HelperChannel);
    expect(await pending).toBeUndefined();
    expect(opening.closed).toBe(1);
    // An engine without a channel: nothing to close.
    channels.close(dockerTargetOf('ssh://third-box', remoteContextNames('third-box')[0]));
    channels.dispose();
  });

  it('opens it again after it was lost', async () => {
    const first = fakeChannel();
    const second = fakeChannel();
    const open = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const channels = new HelperChannels({ open, logger: silentLogger });
    expect(await channels.get(REMOTE)).toBe(first);
    first.lose();
    expect(await channels.get(REMOTE)).toBe(second);
    channels.dispose();
  });

  // The call is refused with the cause of the failed open, and the log says that the calls are refused. The wait of
  // `get` after the failure stays.
  it('after a failure: the call is refused with the cause, and the next attempt of get waits CHANNEL_RETRY_AFTER_FAILURE_MS', async () => {
    const channel = fakeChannel();
    const open = vi
      .fn()
      .mockRejectedValueOnce(new HelperChannelError('open', 'The helper channel to build-box could not be opened: no image.'))
      .mockResolvedValueOnce(channel);
    const { logger, lines } = recordingLogger();
    const channels = new HelperChannels({ open, logger });
    await expect(channels.flow(REMOTE, 'tokenRemove', {})).rejects.toMatchObject({
      code: 'unavailable',
      message: 'The helper channel to build-box could not be opened: no image.',
    });
    expect(lines).toEqual([
      'The helper channel to build-box could not be opened: no image. The Docker calls of operations on build-box are refused until it is open.',
    ]);
    await vi.advanceTimersByTimeAsync(CHANNEL_RETRY_AFTER_FAILURE_MS - 1_000);
    expect(await channels.get(REMOTE)).toBeUndefined();
    expect(open).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await channels.get(REMOTE)).toBe(channel);
    channels.dispose();
  });

  // A flow that was not sent because the channel closed is sent once more through a channel made ready again (it did
  // not run; withChannel); closed twice, or beyond what the channel carries, it rejects.
  it('flow: sends once more when the channel closed before the call was sent; not sent twice, unsendable, or lost while it ran rejects', async () => {
    const channel = fakeChannel();
    const channels = new HelperChannels({ open: async () => channel as unknown as HelperChannel, logger: silentLogger });
    expect(await channels.flow(REMOTE, 'tokenRemove', {})).toEqual(FLOWED);
    channel.flow.mockRejectedValueOnce(new HelperChannelError('closed', 'closed'));
    expect(await channels.flow(REMOTE, 'tokenRemove', {})).toEqual(FLOWED);
    expect(channel.flow).toHaveBeenCalledTimes(3);
    channel.flow.mockRejectedValueOnce(new HelperChannelError('closed', 'closed')).mockRejectedValueOnce(new HelperChannelError('closed', 'closed again'));
    await expect(channels.flow(REMOTE, 'tokenRemove', {})).rejects.toMatchObject({ code: 'closed', message: 'closed again' });
    // A call beyond what the channel carries is not sent either.
    channel.flow.mockRejectedValueOnce(new HelperChannelError('unsendable', 'too long'));
    await expect(channels.flow(REMOTE, 'tokenRemove', {})).rejects.toMatchObject({ code: 'unsendable' });
    channel.flow.mockRejectedValueOnce(new HelperChannelError('lost', 'lost'));
    await expect(channels.flow(REMOTE, 'tokenRemove', {})).rejects.toMatchObject({ code: 'lost' });
    channels.dispose();
  });

  // A flow goes to the channel of its target with all its options, once more after `closed`.
  it('flow: its options passed on, once more after closed', async () => {
    const channel = fakeChannel();
    const channels = new HelperChannels({ open: async () => channel as unknown as HelperChannel, logger: silentLogger });
    const options = { signal: new AbortController().signal, timeoutMs: 60_000, onAsk: async () => ({ value: null }) };
    channel.flow.mockRejectedValueOnce(new HelperChannelError('closed', 'closed'));
    expect(await channels.flow(REMOTE, 'tokenRemove', { devspaceId: 'e1' }, options)).toEqual({ outcome: 'notRunning' });
    expect(channel.flow.mock.calls).toEqual([
      ['tokenRemove', { devspaceId: 'e1' }, options],
      ['tokenRemove', { devspaceId: 'e1' }, options],
    ]);
    channels.dispose();
  });

  // A call awaits the open in full, as the lock does; its signal ends its wait, not the opening.
  it('a call awaits an opening channel in full, also beyond a short open wait and its time limit; its signal ends the wait', async () => {
    const channel = fakeChannel();
    let finishOpen!: (channel: HelperChannel) => void;
    const open = vi.fn(() => new Promise<HelperChannel>((resolve) => (finishOpen = resolve)));
    const channels = new HelperChannels({ open, logger: silentLogger });
    let firstDone = false;
    const first = channels.flow(REMOTE, 'tokenRemove', {}, { timeoutMs: 1_000 }).finally(() => (firstDone = true));
    const second = channels.flow(REMOTE, 'tokenRemove', {});
    await vi.advanceTimersByTimeAsync(OLD_OPEN_WAIT_MS + 1_000);
    expect(firstDone).toBe(false);
    const controller = new AbortController();
    const third = channels.flow(REMOTE, 'tokenRemove', {}, { signal: controller.signal });
    controller.abort();
    await expect(third).rejects.toMatchObject({ name: 'AbortError' });
    // The opening went on: the waiting calls use the channel.
    finishOpen(channel as unknown as HelperChannel);
    expect(await first).toEqual(FLOWED);
    expect(await second).toEqual(FLOWED);
    expect(open).toHaveBeenCalledTimes(1);
    channels.dispose();
  });

  // The open is awaited in full like a state repair, so it is not taken from the time limit.
  it('awaits the open apart from the time limit', async () => {
    const channel = fakeChannel();
    let finishOpen!: (channel: HelperChannel) => void;
    const channels = new HelperChannels({ open: () => new Promise<HelperChannel>((resolve) => (finishOpen = resolve)), logger: silentLogger });
    const call = channels.flow(REMOTE, 'tokenRemove', {}, { timeoutMs: 10_000 });
    await vi.advanceTimersByTimeAsync(3_000);
    finishOpen(channel as unknown as HelperChannel);
    expect(await call).toEqual(FLOWED);
    expect(channel.flow).toHaveBeenCalledWith('tokenRemove', {}, { timeoutMs: 10_000 });
    channels.dispose();
  });

  // The state is made consistent before a call: the helper image, then the open in full, also within the wait after a
  // failed open.
  it('flow: without an open worker, prepares the helper image and opens it in full, also within the wait after a failed open', async () => {
    const channel = fakeChannel();
    const open = vi.fn().mockRejectedValueOnce(new HelperChannelError('open', 'no image.')).mockResolvedValueOnce(channel);
    const prepare = vi.fn(async () => {});
    const channels = new HelperChannels({ open, prepare, logger: silentLogger });
    expect(await channels.get(REMOTE)).toBeUndefined();
    expect(prepare).not.toHaveBeenCalled();
    const signal = new AbortController().signal;
    expect(await channels.flow(REMOTE, 'tokenRemove', {}, { signal })).toEqual(FLOWED);
    expect(prepare).toHaveBeenCalledWith(REMOTE, signal);
    expect(open).toHaveBeenCalledTimes(2);
    // With an open worker, nothing is prepared again.
    expect(await channels.flow(REMOTE, 'tokenRemove', {})).toEqual(FLOWED);
    expect(prepare).toHaveBeenCalledTimes(1);
    channels.dispose();
  });

  it('flow: a helper image that cannot be prepared refuses the call with the cause, and opens nothing', async () => {
    const open = vi.fn(async () => fakeChannel() as unknown as HelperChannel);
    const prepare = vi.fn(async () => {
      throw new UserFacingError('helperFailed', 'The workspace helper could not be prepared.', 'no space left on device');
    });
    const { logger, lines } = recordingLogger();
    const channels = new HelperChannels({ open, prepare, logger });
    await expect(channels.flow(REMOTE, 'stop', {})).rejects.toMatchObject({
      name: 'HelperChannelError',
      code: 'unavailable',
      message: 'the helper image could not be prepared: The workspace helper could not be prepared. no space left on device',
    });
    expect(open).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('The helper image for the worker on build-box could not be prepared');
    // An abort of the preparation is an abort, not a refusal.
    prepare.mockImplementationOnce(async () => {
      throw abortError();
    });
    await expect(channels.flow(REMOTE, 'tokenRemove', {})).rejects.toMatchObject({ name: 'AbortError' });
    channels.dispose();
    // After dispose: refused, nothing prepared.
    prepare.mockClear();
    await expect(channels.flow(REMOTE, 'tokenRemove', {})).rejects.toMatchObject({ code: 'unavailable', message: 'the window is closing' });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('closes a channel without an operation for CHANNEL_IDLE_CLOSE_MS, not one that is busy', async () => {
    const channel = fakeChannel();
    const channels = new HelperChannels({ open: async () => channel as unknown as HelperChannel, logger: silentLogger });
    await channels.get(REMOTE);
    channel.busy = 1;
    await vi.advanceTimersByTimeAsync(CHANNEL_IDLE_CLOSE_MS + 60_000);
    expect(channel.closed).toBe(0);
    channel.busy = 0;
    channel.lastUsed = Date.now();
    await vi.advanceTimersByTimeAsync(CHANNEL_IDLE_CLOSE_MS - 60_000);
    expect(channel.closed).toBe(0);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(channel.closed).toBe(1);
    channels.dispose();
  });

  it('dispose closes every channel, also one that opens meanwhile, and opens none after it', async () => {
    const open1 = fakeChannel();
    const open2 = fakeChannel();
    let finishOpen!: (channel: HelperChannel) => void;
    const open = vi
      .fn()
      .mockResolvedValueOnce(open1)
      .mockImplementationOnce(() => new Promise((resolve) => (finishOpen = resolve)));
    const channels = new HelperChannels({ open, logger: silentLogger });
    await channels.get(REMOTE);
    // The context named after the host (remoteContextNames).
    const pending = channels.get(dockerTargetOf('ssh://other-box', remoteContextNames('other-box')[0]));
    channels.dispose();
    expect(open1.closed).toBe(1);
    finishOpen(open2 as unknown as HelperChannel);
    expect(await pending).toBeUndefined();
    expect(open2.closed).toBe(1);
    expect(await channels.get(REMOTE)).toBeUndefined();
  });
});

describe('channelRunArgs and openHelperChannel', () => {
  it('runs the helper image with --rm -i, never a pull, outbound network only, no capability, only the socket, and the loader', () => {
    const hash = bundleHash('SCRIPT');
    // The state volume with the lock files is mounted too, and the shared VS Code server store.
    const args = channelRunArgs({
      tag: 'devspaces-worker:abc',
      socketPath: '/run/user/1000/docker.sock',
      stateVolume: 'devspaces-monitor',
      vscodeVolume: 'devspaces-vscode',
      containerName: 'devspaces-api-worker1',
      label: '1-x',
      scriptHash: hash,
    });
    expect(args).toEqual([
      'run', '--rm', '-i', '--pull', 'never', '--name', 'devspaces-api-worker1',
      '--label', 'nimblescape.devspaces.worker-run=true',
      '--label', `${LABEL_HELPER_CHANNEL}=1-x`,
      // No log of the channel on the host; outbound network on the default bridge.
      '--network', 'bridge', '--log-driver', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--mount', 'type=bind,source=/run/user/1000/docker.sock,target=/var/run/docker.sock',
      // The volume of the Monitor at /state, for the lock files.
      '--mount', 'type=volume,source=devspaces-monitor,target=/state',
      // The shared VS Code server store of the engine, read-write at /vscode, with `volume-nocopy`: the store's content
      // never comes from an image.
      '--mount', 'type=volume,source=devspaces-vscode,target=/vscode,volume-nocopy',
      // Pipe loading.
      'devspaces-worker:abc', 'node', '-e', PIPE_LOADER, '/opt/devspace/channel.js', hash, 'startChannel',
    ]);
    // Neither a restart policy nor -d: the container lives only as long as its connection.
    expect(args).not.toContain('--restart');
    expect(args).not.toContain('-d');
    // Its only variable: the version of Devspaces, for the header User-Agent of the worker; none without a version
    // x.y.z.
    expect(args).not.toContain('--env');
    const withVersion = (version: string) =>
      channelRunArgs({ tag: 't', socketPath: '/s', stateVolume: 'v', vscodeVolume: 'w', containerName: 'n', label: 'l', scriptHash: hash, version });
    expect(withVersion('1.20.3').slice(-9, -6)).toEqual(['--env', 'DEVSPACES_VERSION=1.20.3', 't']);
    expect(withVersion('1.20.3').filter((arg) => arg === '--env')).toHaveLength(1);
    for (const version of ['1.20', '1.20.3 --privileged', '']) expect(withVersion(version)).not.toContain('--env');
    expect(() => channelRunArgs({ tag: 't', socketPath: '/a,b', stateVolume: 'v', vscodeVolume: 'w', containerName: 'n', label: 'l', scriptHash: hash })).toThrow(HelperChannelError);
    // A volume name that could change the mount (CSV) or be an option is refused.
    for (const stateVolume of ['a,b', '-v', 'a"b', '', 'a=b']) {
      expect(() => channelRunArgs({ tag: 't', socketPath: '/s', stateVolume, vscodeVolume: 'w', containerName: 'n', label: 'l', scriptHash: hash })).toThrow(HelperChannelError);
      // The same for the volume of the shared VS Code server store.
      expect(() => channelRunArgs({ tag: 't', socketPath: '/s', stateVolume: 'v', vscodeVolume: stateVolume, containerName: 'n', label: 'l', scriptHash: hash })).toThrow(HelperChannelError);
    }
  });

  it('starts the container with the Docker context of the target and checks the engine with probe', async () => {
    // The version that the extension set at its start (activate).
    setUserAgentVersion('1.20.3');
    onTestFinished(() => void setUserAgentVersion(undefined));
    let started: { args: readonly string[]; context: string | undefined } | undefined;
    let stdout: ((text: string) => void) | undefined;
    const written: string[] = [];
    const process: StartedProcess = {
      write: (text) => {
        written.push(text);
        for (const line of text.split('\n').filter((part) => part !== '')) {
          const message = parseClientMessage(line);
          if (message?.t === 'hello') {
            queueMicrotask(() => stdout?.(encodeMessage({ t: 'hello', protocol: CHANNEL_PROTOCOL_VERSION, node: 'v24', ops: ['docker', 'probe', 'sweep'] })));
          }
          if (message?.t === 'op' && message.op === 'probe') {
            // The probe names its engine as its values (ProbeValue.engine).
            queueMicrotask(() => stdout?.(encodeMessage({ t: 'result', id: message.id, ok: true, value: { serverVersion: '27.1.0', detail: 'Docker 27.1.0', engine: ENGINE_IDENTITY } })));
          }
        }
        return true;
      },
      end: () => {},
      kill: () => {},
      onStdout: (listener) => (stdout = listener),
      onStderr: () => {},
      exited: new Promise(() => {}),
    };
    const channel = await openHelperChannel(
      {
        start: (args) => {
          started = { args, context: operationDockerTarget()?.context };
          return process;
        },
        // The engine identity without the worker.
        runDirect: async () => ({ exitCode: 0, stdout: `${ENGINE}\n`, stderr: '', timedOut: false }),
        logger: silentLogger,
        script: async () => 'SCRIPT',
        helperTag: async () => 'devspaces-worker:abc',
        socketPath: async () => '/var/run/docker.sock',
        stateVolume: 'devspaces-monitor',
        vscodeVolume: 'devspaces-vscode',
        windowName: () => 'api',
      },
      REMOTE,
    );
    expect(started?.context).toBe(REMOTE.context);
    expect(started?.args).toContain('devspaces-worker:abc');
    // The worker gets the version of the extension.
    expect(started?.args.slice(-9, -6)).toEqual(['--env', 'DEVSPACES_VERSION=1.20.3', 'devspaces-worker:abc']);
    // The worker is named by its window (workerNameStart).
    expect(started?.args[started.args.indexOf('--name') + 1]).toBe('devspaces-api-worker1');
    expect(channel.isOpen).toBe(true);
    expect(written[0]).toBe(`${JSON.stringify('SCRIPT')}\n`);
    // Pipe loading: the loader gets the hash of that script, never the script.
    expect(started?.args.slice(-4)).toEqual([PIPE_LOADER, '/opt/devspace/channel.js', bundleHash('SCRIPT'), 'startChannel']);
    // Then the sweep of never-started channel containers, in the background.
    expect(written.some((line) => line.includes('"op":"sweep"'))).toBe(true);
    channel.close();
  });

  it('a daemon without its default bridge: the worker starts again without network, and the log says why', async () => {
    const good = (): StartedProcess => {
      let stdout: ((text: string) => void) | undefined;
      return {
        write: (text) => {
          for (const line of text.split('\n').filter((part) => part !== '')) {
            const message = parseClientMessage(line);
            if (message?.t === 'hello') queueMicrotask(() => stdout?.(encodeMessage({ t: 'hello', protocol: CHANNEL_PROTOCOL_VERSION, node: 'v24', ops: ['docker', 'probe', 'sweep'] })));
            if (message?.t === 'op' && message.op === 'probe') {
              // The engine as its values.
              queueMicrotask(() => stdout?.(encodeMessage({ t: 'result', id: message.id, ok: true, value: { serverVersion: '27.1.0', detail: 'Docker 27.1.0', engine: ENGINE_IDENTITY } })));
            }
          }
          return true;
        },
        end: () => {},
        kill: () => {},
        onStdout: (listener) => (stdout = listener),
        onStderr: () => {},
        exited: new Promise(() => {}),
      };
    };
    const refused = (stderr: string): StartedProcess => {
      let errors: ((text: string) => void) | undefined;
      let exit: (value: { exitCode: number | null }) => void = () => {};
      const exited = new Promise<{ exitCode: number | null }>((resolve) => (exit = resolve));
      return {
        write: () => true,
        end: () => {},
        kill: () => {},
        onStdout: () => {},
        onStderr: (listener) => {
          errors = listener;
          queueMicrotask(() => {
            errors?.(stderr);
            exit({ exitCode: 125 });
          });
        },
        exited,
      };
    };
    const open = async (first: StartedProcess) => {
      const networks: string[] = [];
      const warnings: string[] = [];
      const processes = [first, good()];
      const channel = await openHelperChannel(
        {
          start: (args) => (networks.push(args[args.indexOf('--network') + 1]), processes.shift()),
          runDirect: async () => ({ exitCode: 0, stdout: `${ENGINE}\n`, stderr: '', timedOut: false }),
          logger: { ...silentLogger, warn: (text) => warnings.push(text) },
          script: async () => 'SCRIPT',
          helperTag: async () => 'devspaces-worker:abc',
          socketPath: async () => '/var/run/docker.sock',
          stateVolume: 'devspaces-monitor',
          vscodeVolume: 'devspaces-vscode',
        },
        REMOTE,
      );
      return { channel, networks, warnings };
    };
    const fallback = await open(refused('docker: Error response from daemon: network bridge not found.\n'));
    expect(fallback.networks).toEqual(['bridge', 'none']);
    expect(fallback.channel.isOpen).toBe(true);
    expect(fallback.warnings.join('\n')).toContain('no default bridge network');
    fallback.channel.close();
    // Any other failure is not retried.
    await expect(open(refused('docker: Error response from daemon: no space left on device.\n'))).rejects.toThrow('no space left');
  });

  // Pipe loading: the script never goes on the command line, so its size has no limit of the command line.
  it('a 1 MB script is accepted and never in argv', async () => {
    const script = `/* ${'a "quoted" \\ line\n'.repeat(60_000)} */`;
    expect(script.length).toBeGreaterThan(1024 * 1024);
    let args: readonly string[] = [];
    let stdout: ((text: string) => void) | undefined;
    const written: string[] = [];
    const process: StartedProcess = {
      write: (text) => {
        written.push(text);
        for (const line of text.split('\n').filter((part) => part !== '' && part.length < 10_000)) {
          const message = parseClientMessage(line);
          if (message?.t === 'hello') {
            queueMicrotask(() => stdout?.(encodeMessage({ t: 'hello', protocol: CHANNEL_PROTOCOL_VERSION, node: 'v24', ops: ['docker', 'probe'] })));
          }
          if (message?.t === 'op' && message.op === 'probe') {
            // The probe names its engine as its values (ProbeValue.engine).
            queueMicrotask(() => stdout?.(encodeMessage({ t: 'result', id: message.id, ok: true, value: { serverVersion: '27.1.0', detail: 'Docker 27.1.0', engine: ENGINE_IDENTITY } })));
          }
        }
        return true;
      },
      end: () => {},
      kill: () => {},
      onStdout: (listener) => (stdout = listener),
      onStderr: () => {},
      exited: new Promise(() => {}),
    };
    const channel = await openHelperChannel(
      {
        start: (startArgs) => {
          args = startArgs;
          return process;
        },
        // The engine identity without the worker.
        runDirect: async () => ({ exitCode: 0, stdout: `${ENGINE}\n`, stderr: '', timedOut: false }),
        logger: silentLogger,
        script: async () => script,
        helperTag: async () => 'devspaces-worker:abc',
        socketPath: async () => '/var/run/docker.sock',
        stateVolume: 'devspaces-monitor',
        vscodeVolume: 'devspaces-vscode',
      },
      REMOTE,
    );
    expect(channel.isOpen).toBe(true);
    expect(written[0]).toBe(`${JSON.stringify(script)}\n`);
    expect(args.join(' ').length).toBeLessThan(5_000);
    expect(args.some((arg) => arg.includes('quoted'))).toBe(false);
    expect(args.slice(-2)).toEqual([bundleHash(script), 'startChannel']);
    channel.close();
  });

  it('closes the channel and fails to open when the probe does not reach Docker', async () => {
    let stdout: ((text: string) => void) | undefined;
    let ended = false;
    const process: StartedProcess = {
      write: (text) => {
        for (const line of text.split('\n').filter((part) => part !== '')) {
          const message = parseClientMessage(line);
          if (message?.t === 'hello') queueMicrotask(() => stdout?.(encodeMessage({ t: 'hello', protocol: CHANNEL_PROTOCOL_VERSION, node: 'v24', ops: ['probe'] })));
          if (message?.t === 'op') {
            queueMicrotask(() =>
              stdout?.(encodeMessage({ t: 'result', id: message.id, ok: true, value: { detail: 'permission denied while trying to connect to the Docker daemon socket' } })),
            );
          }
        }
        return true;
      },
      end: () => (ended = true),
      kill: () => {},
      onStdout: (listener) => (stdout = listener),
      onStderr: () => {},
      exited: new Promise(() => {}),
    };
    await expect(
      openHelperChannel(
        { start: () => process, runDirect: directEngine, logger: silentLogger, script: async () => 'S', helperTag: async () => 't', socketPath: async () => '/s', stateVolume: 'devspaces-monitor', vscodeVolume: 'devspaces-vscode' },
        REMOTE,
      ),
    ).rejects.toThrow('The helper channel to build-box does not reach Docker: permission denied while trying to connect to the Docker daemon socket');
    expect(ended).toBe(true);
  });

  it('fails to open without a Docker CLI', async () => {
    await expect(
      openHelperChannel(
        { start: () => undefined, runDirect: directEngine, logger: silentLogger, script: async () => 'S', helperTag: async () => 't', socketPath: async () => '/s', stateVolume: 'devspaces-monitor', vscodeVolume: 'devspaces-vscode' },
        REMOTE,
      ),
    ).rejects.toMatchObject({ code: 'open' });
  });
});

// A worker that talks to another engine is refused.
describe('the engine identity at the open', () => {
  /**
   * A channel process that answers hello and a probe with `engine` (the values of the worker); `ended()` after the
   * extension closed it.
   */
  function probeProcess(engine: unknown) {
    let stdout: ((text: string) => void) | undefined;
    let ended = false;
    const process: StartedProcess = {
      write: (text) => {
        for (const line of text.split('\n').filter((part) => part !== '')) {
          const message = parseClientMessage(line);
          if (message?.t === 'hello') {
            queueMicrotask(() => stdout?.(encodeMessage({ t: 'hello', protocol: CHANNEL_PROTOCOL_VERSION, node: 'v24', ops: ['docker', 'probe'] })));
          }
          if (message?.t === 'op' && message.op === 'probe') {
            const value = { serverVersion: '27.1.0', detail: 'Docker 27.1.0', ...(engine === undefined ? {} : { engine }) };
            queueMicrotask(() => stdout?.(encodeMessage({ t: 'result', id: message.id, ok: true, value })));
          }
        }
        return true;
      },
      end: () => (ended = true),
      kill: () => {},
      onStdout: (listener) => (stdout = listener),
      onStderr: () => {},
      exited: new Promise(() => {}),
    };
    return { process, ended: () => ended };
  }

  it('opens for the local Docker when the engine is the one without the worker, compared in the context of the target', async () => {
    const worker = probeProcess(ENGINE_IDENTITY);
    const direct: { args: readonly string[]; context: string | undefined; timeoutMs: number | undefined }[] = [];
    const target = dockerTargetOf('unix:///run/user/1000/docker.sock', 'rootless');
    expect(target.kind).toBe('local');
    const channel = await openHelperChannel(
      {
        start: () => worker.process,
        runDirect: async (args, options) => {
          direct.push({ args, context: operationDockerTarget()?.context, timeoutMs: options?.timeoutMs });
          return { exitCode: 0, stdout: `${ENGINE}\n`, stderr: '', timedOut: false };
        },
        logger: silentLogger,
        script: async () => 'S',
        helperTag: async () => 't',
        socketPath: async () => '/run/user/1000/docker.sock',
        stateVolume: 'devspaces-monitor',
        vscodeVolume: 'devspaces-vscode',
      },
      target,
    );
    expect(channel.isOpen).toBe(true);
    // The direct call has a time limit, so a hanging engine cannot keep the open pending.
    expect(direct).toEqual([
      { args: ['info', '--format', '{{json .ID}} {{json .DockerRootDir}}'], context: 'rootless', timeoutMs: CHANNEL_PROBE_TIMEOUT_MS },
    ]);
    channel.close();
  });

  // The engine of the worker as its values; another root folder of the same ID is another engine too.
  for (const [what, engine, directStdout] of [
    ['another engine', { id: 'other-id', rootDir: '/var/lib/docker' }, ENGINE],
    ['another root folder of the engine', { id: ENGINE_IDENTITY.id, rootDir: '/srv/docker' }, ENGINE],
    ['a worker that names no engine', undefined, ENGINE],
    ['an engine that cannot be identified without the worker', ENGINE_IDENTITY, ''],
  ] as const) {
    it(`refuses ${what}: the worker is closed, the open fails, and the next attempt waits`, async () => {
      vi.useFakeTimers();
      try {
        const worker = probeProcess(engine);
        const { logger, lines } = recordingLogger();
        const open = vi.fn((target: DockerTarget) =>
          openHelperChannel(
            {
              start: () => worker.process,
              runDirect: async () => ({ exitCode: directStdout === '' ? 1 : 0, stdout: directStdout, stderr: '', timedOut: false }),
              logger: silentLogger,
              script: async () => 'S',
              helperTag: async () => 't',
              socketPath: async () => '/var/run/docker.sock',
              stateVolume: 'devspaces-monitor',
              vscodeVolume: 'devspaces-vscode',
            },
            target,
          ),
        );
        const channels = new HelperChannels({ open, logger });
        // The call is refused with the cause.
        await expect(channels.flow(LOCAL_DOCKER_TARGET, 'tokenRemove', {})).rejects.toMatchObject({
          code: 'unavailable',
          message: expect.stringContaining('The helper channel to the local Docker was closed:'),
        });
        expect(worker.ended()).toBe(true);
        expect(lines.join('\n')).toContain('The helper channel to the local Docker was closed:');
        expect(lines.join('\n')).toContain('The Docker calls of operations on the local Docker are refused until it is open.');
        expect(await channels.get(LOCAL_DOCKER_TARGET)).toBeUndefined();
        expect(open).toHaveBeenCalledTimes(1);
        channels.dispose();
      } finally {
        vi.useRealTimers();
      }
    });
  }
});

// The worker reads its identity over the Engine API, the extension with its Docker CLI; both are compared as values,
// and the value of the worker is checked as everything that it answers.
describe('the engine identity as values', () => {
  /** A channel process that answers hello and a probe whose engine is `engine`; `ended()` after the extension closed it. */
  function probeProcess(engine: unknown) {
    let stdout: ((text: string) => void) | undefined;
    let ended = false;
    const process: StartedProcess = {
      write: (text) => {
        for (const line of text.split('\n').filter((part) => part !== '')) {
          const message = parseClientMessage(line);
          if (message?.t === 'hello') queueMicrotask(() => stdout?.(encodeMessage({ t: 'hello', protocol: CHANNEL_PROTOCOL_VERSION, node: 'v24', ops: ['probe'] })));
          if (message?.t === 'op' && message.op === 'probe') {
            queueMicrotask(() => stdout?.(encodeMessage({ t: 'result', id: message.id, ok: true, value: { serverVersion: '27.1.0', detail: 'Docker 27.1.0', engine } })));
          }
        }
        return true;
      },
      end: () => (ended = true),
      kill: () => {},
      onStdout: (listener) => (stdout = listener),
      onStderr: () => {},
      exited: new Promise(() => {}),
    };
    return { process, ended: () => ended };
  }
  const deps = (process: StartedProcess, directStdout = `${ENGINE}\n`) => ({
    start: () => process,
    runDirect: async () => ({ exitCode: 0, stdout: directStdout, stderr: '', timedOut: false }),
    logger: silentLogger,
    script: async () => 'S',
    helperTag: async () => 't',
    socketPath: async () => '/var/run/docker.sock',
    stateVolume: 'devspaces-monitor',
    vscodeVolume: 'devspaces-vscode',
  });

  // Go's `{{json}}` escapes `&`, `<` and `>` (\u0026, \u003c, \u003e); the Engine API answers the plain value.
  it('opens when the Docker CLI prints the root folder in the escapes of Go and the worker answers its plain value', async () => {
    const worker = probeProcess({ id: 'id-1', rootDir: '/srv/docker&<data>' });
    const channel = await openHelperChannel(deps(worker.process, '"id-1" "/srv/docker\\u0026\\u003cdata\\u003e"\n'), REMOTE);
    expect(channel.isOpen).toBe(true);
    channel.close();
  });

  it('names both engines when they differ, each part as a JSON string', async () => {
    const worker = probeProcess({ id: 'other\nid', rootDir: '/var/lib/docker' });
    await expect(openHelperChannel(deps(worker.process), REMOTE)).rejects.toThrow(
      'The helper channel to build-box was closed: it reaches another Docker engine ("other\\nid" "/var/lib/docker") than the Docker calls without it ("7b1c7a44-2f0e-4d38-9d1d-3a8f7b0e8c11" "/var/lib/docker").',
    );
    expect(worker.ended()).toBe(true);
  });

  it('refuses a worker whose engine is no identity: an invalid answer, never compared', async () => {
    for (const engine of [ENGINE, { id: '', rootDir: '/var/lib/docker' }, { ...ENGINE_IDENTITY, extra: 1 }, { id: ENGINE_IDENTITY.id, rootDir: 'r'.repeat(1_025) }]) {
      const worker = probeProcess(engine);
      await expect(openHelperChannel(deps(worker.process), REMOTE), JSON.stringify(engine)).rejects.toThrow('The helper channel to build-box does not reach Docker: an invalid answer');
      expect(worker.ended()).toBe(true);
    }
  });
});

// The sweep of never-started channel containers after the open: sent with the parameters of its schema (none), and its
// value checked (parseSweepValue).
describe('the sweep at the open', () => {
  function sweepProcess(sweep: Record<string, unknown>) {
    let stdout: ((text: string) => void) | undefined;
    const sent: Array<{ op: string; params: unknown }> = [];
    const process: StartedProcess = {
      write: (text) => {
        for (const line of text.split('\n').filter((part) => part !== '')) {
          const message = parseClientMessage(line);
          if (message?.t === 'hello') queueMicrotask(() => stdout?.(encodeMessage({ t: 'hello', protocol: CHANNEL_PROTOCOL_VERSION, node: 'v24', ops: ['probe', 'sweep'] })));
          if (message?.t !== 'op') continue;
          sent.push({ op: message.op, params: message.params });
          const result = message.op === 'probe' ? { ok: true, value: { serverVersion: '27.1.0', detail: 'Docker 27.1.0', engine: ENGINE_IDENTITY } } : sweep;
          queueMicrotask(() => stdout?.(encodeMessage({ t: 'result', id: message.id, ...result } as never)));
        }
        return true;
      },
      end: () => {},
      kill: () => {},
      onStdout: (listener) => (stdout = listener),
      onStderr: () => {},
      exited: new Promise(() => {}),
    };
    return { process, sent };
  }

  // The lines name the stopped helper containers (the sweep removes the channels and the batch helpers).
  for (const [what, sweep, expected] of [
    ['logs how many it removed', { ok: true, value: { removed: 2 } }, ['info Removed 2 stopped helper containers on build-box.']],
    ['logs one removed container', { ok: true, value: { removed: 1 } }, ['info Removed 1 stopped helper container on build-box.']],
    ['logs nothing when it removed none', { ok: true, value: { removed: 0 } }, []],
    // The output of `docker container prune` is no valid value.
    ['warns about a value that is not one', { ok: true, value: { output: 'Deleted Containers:' } }, ['warn The worker on build-box answered the removal of the stopped helper containers with an invalid value.']],
    [
      'logs a failure',
      { ok: false, error: { code: 'failed', message: 'a prune operation is already running' }, cancelled: false, timedOut: false },
      ['info The stopped helper containers on build-box could not be removed: a prune operation is already running'],
    ],
  ] as const) {
    it(`sends the probe and the sweep without parameters, and ${what}`, async () => {
      const worker = sweepProcess(sweep);
      const lines: string[] = [];
      const logger: Logger = { ...silentLogger, info: (text) => lines.push(`info ${text}`), warn: (text) => lines.push(`warn ${text}`) };
      const channel = await openHelperChannel(
        { start: () => worker.process, runDirect: directEngine, logger, script: async () => 'S', helperTag: async () => 't', socketPath: async () => '/s', stateVolume: 'devspaces-monitor', vscodeVolume: 'devspaces-vscode' },
        REMOTE,
      );
      for (let i = 0; i < 20 && worker.sent.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 0));
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
      expect(worker.sent).toEqual([
        { op: 'probe', params: {} },
        { op: 'sweep', params: {} },
      ]);
      // The words of the lines above.
      expect(lines.filter((line) => line.includes('stopped helper container'))).toEqual(expected);
      channel.close();
    });
  }
});

describe('HelperChannels.refresh', () => {
  function refreshChannel(ops: string[], answer: () => Promise<unknown>) {
    const channel = { ...fakeChannel(), operations: ops, operation: vi.fn(answer) };
    const channels = new HelperChannels({ open: async () => channel as unknown as HelperChannel, logger: silentLogger });
    return { channel, channels };
  }

  it('reads the states in one operation, without a secret, and checks its value', async () => {
    const { channel, channels } = refreshChannel(['docker', 'probe', 'refresh'], async () => refreshValue(EXPECTED_STATES));
    expect(await channels.refresh(LOCAL_DOCKER_TARGET, REFRESH_DEVSPACES)).toEqual(EXPECTED_STATES);
    expect(channel.operation).toHaveBeenCalledTimes(1);
    expect(channel.operation).toHaveBeenCalledWith('refresh', { devspaces: REFRESH_DEVSPACES }, { timeoutMs: CHANNEL_REFRESH_TIMEOUT_MS });
    channels.dispose();
  });

  // Each is refused; a refresh that was not sent because the channel closed is sent once more. The worker is this
  // extension's own bundle (its hash checked by the loader, its protocol at `hello`), so it always knows `refresh`.
  it('rejects for an unsupported endpoint, for parameters beyond the check, or when it was not sent', async () => {
    const older = refreshChannel(['refresh'], async () => refreshValue(EXPECTED_STATES));
    const unsupported = dockerTargetOf('tcp://build-box:2375', 'tcp-box');
    await expect(older.channels.refresh(unsupported, REFRESH_DEVSPACES)).rejects.toMatchObject({ code: 'unavailable' });
    expect(older.channel.operation).not.toHaveBeenCalled();
    older.channels.dispose();

    const current = refreshChannel(['refresh'], async () => refreshValue(EXPECTED_STATES));
    const many = Array.from({ length: MAX_REFRESH_DEVSPACES + 1 }, (_, index) => ({ ...REFRESH_DEVSPACES[0], id: `env-${index}` }));
    await expect(current.channels.refresh(LOCAL_DOCKER_TARGET, many)).rejects.toMatchObject({ code: 'unsendable' });
    await expect(current.channels.refresh(LOCAL_DOCKER_TARGET, [{ ...REFRESH_DEVSPACES[0], containerName: '-x' }])).rejects.toMatchObject({ code: 'unsendable' });
    expect(current.channel.operation).not.toHaveBeenCalled();
    current.channels.dispose();

    for (const code of ['closed', 'unsendable'] as const) {
      const notSent = refreshChannel(['refresh'], async () => {
        throw new HelperChannelError(code, 'not sent');
      });
      await expect(notSent.channels.refresh(LOCAL_DOCKER_TARGET, REFRESH_DEVSPACES)).rejects.toMatchObject({ code });
      expect(notSent.channel.operation).toHaveBeenCalledTimes(code === 'closed' ? 2 : 1);
      notSent.channels.dispose();
    }
    const closedOnce = refreshChannel(['refresh'], async () => refreshValue(EXPECTED_STATES));
    closedOnce.channel.operation.mockRejectedValueOnce(new HelperChannelError('closed', 'not sent'));
    expect(await closedOnce.channels.refresh(LOCAL_DOCKER_TARGET, REFRESH_DEVSPACES)).toEqual(EXPECTED_STATES);
    closedOnce.channels.dispose();
  });

  // The refresh makes the worker ready like a Docker call; it only checks the helper image (checkPresent) and never
  // prepares (builds) it.
  it('checks the helper image and opens the worker in full; a failure refuses the refresh with the cause', async () => {
    const channel = { ...fakeChannel(), operations: ['refresh'], operation: vi.fn(async () => refreshValue(EXPECTED_STATES)) };
    const open = vi.fn().mockRejectedValueOnce(new HelperChannelError('open', 'no image.')).mockResolvedValueOnce(channel);
    const prepare = vi.fn(async () => {});
    const checkPresent = vi.fn(async () => {});
    const channels = new HelperChannels({ open, prepare, checkPresent, logger: silentLogger });
    await expect(channels.refresh(LOCAL_DOCKER_TARGET, REFRESH_DEVSPACES)).rejects.toMatchObject({ code: 'unavailable', message: 'no image.' });
    // Within the wait after the failed open, the next refresh is refused with the cause and opens nothing.
    await expect(channels.refresh(LOCAL_DOCKER_TARGET, REFRESH_DEVSPACES)).rejects.toMatchObject({ code: 'unavailable', message: 'no image.' });
    expect(open).toHaveBeenCalledTimes(1);
    // An operation (a flow) opens again at once; the refresh then uses that worker.
    await channels.flow(LOCAL_DOCKER_TARGET, 'tokenRemove', {});
    expect(await channels.refresh(LOCAL_DOCKER_TARGET, REFRESH_DEVSPACES)).toEqual(EXPECTED_STATES);
    // Checked, never prepared by the refresh; the flow prepared once.
    expect(checkPresent).toHaveBeenCalledTimes(2);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(2);
    channels.dispose();
    const refused = new HelperChannels({
      open,
      prepare,
      checkPresent: async () => {
        throw new Error('Cannot connect to the Docker daemon');
      },
      logger: silentLogger,
    });
    await expect(refused.refresh(LOCAL_DOCKER_TARGET, REFRESH_DEVSPACES)).rejects.toMatchObject({
      code: 'unavailable',
      message: 'the helper image could not be prepared: Cannot connect to the Docker daemon',
    });
    expect(open).toHaveBeenCalledTimes(2);
    expect(prepare).toHaveBeenCalledTimes(1);
    refused.dispose();
  });

  // A missing helper image refuses each refresh at once and never starts a build, also after many refreshes; an
  // operation (a flow) still prepares (builds) it.
  it('a missing helper image refuses each refresh without a build; a flow still prepares it', async () => {
    const channel = { ...fakeChannel(), operations: ['refresh'], operation: vi.fn(async () => refreshValue(EXPECTED_STATES)) };
    const open = vi.fn(async () => channel as unknown as HelperChannel);
    const prepare = vi.fn(async () => {});
    const checkPresent = vi.fn(async () => {
      throw new Error('The workspace helper image is not on this Docker engine.');
    });
    const channels = new HelperChannels({ open, prepare, checkPresent, logger: silentLogger });
    for (let i = 0; i < 5; i++) {
      await expect(channels.refresh(REMOTE, REFRESH_DEVSPACES)).rejects.toMatchObject({
        code: 'unavailable',
        message: 'the helper image could not be prepared: The workspace helper image is not on this Docker engine.',
      });
    }
    expect(checkPresent).toHaveBeenCalledTimes(5);
    expect(prepare).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    await channels.flow(REMOTE, 'tokenRemove', {});
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(checkPresent).toHaveBeenCalledTimes(5);
    channels.dispose();
  });

  // The refresh that is sent once more after its channel closed makes the new worker ready the way of the refresh too:
  // it checks the helper image, and never prepares (builds) it.
  it('the refresh sent once more after a closed channel checks the helper image and never prepares it', async () => {
    const first = Object.assign(fakeChannel(), { operations: ['refresh'], operation: vi.fn() });
    first.operation.mockImplementationOnce(async () => {
      first.close();
      throw new HelperChannelError('closed', 'not sent');
    });
    const second = Object.assign(fakeChannel(), { operations: ['refresh'], operation: vi.fn(async () => refreshValue(EXPECTED_STATES)) });
    const open = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const prepare = vi.fn(async () => {});
    const checkPresent = vi.fn(async () => {});
    const channels = new HelperChannels({ open, prepare, checkPresent, logger: silentLogger });
    expect(await channels.refresh(REMOTE, REFRESH_DEVSPACES)).toEqual(EXPECTED_STATES);
    expect(open).toHaveBeenCalledTimes(2);
    expect(checkPresent).toHaveBeenCalledTimes(2);
    expect(prepare).not.toHaveBeenCalled();
    channels.dispose();
  });

  // The refresh waits at most CHANNEL_PASSIVE_OPEN_WAIT_MS for an open that is still running (not the whole open, up to
  // about 3 minutes); the open goes on, and an operation (a flow) still awaits it in full. An open within that time
  // gives the states at once.
  it('the refresh waits at most CHANNEL_PASSIVE_OPEN_WAIT_MS for an open; an operation awaits it in full', async () => {
    vi.useFakeTimers();
    try {
      let fail: (error: Error) => void = () => {};
      const open = vi.fn(
        () =>
          new Promise<HelperChannel>((_resolve, reject) => {
            fail = reject;
          }),
      );
      const channels = new HelperChannels({ open, prepare: vi.fn(async () => {}), checkPresent: vi.fn(async () => {}), logger: silentLogger });
      const refreshed = channels.refresh(REMOTE, REFRESH_DEVSPACES).then(
        () => 'resolved',
        (error: unknown) => (error instanceof HelperChannelError ? `${error.code}: ${error.message}` : 'other'),
      );
      await vi.advanceTimersByTimeAsync(0);
      const call = channels.flow(REMOTE, 'tokenRemove', {}).then(
        () => 'resolved',
        (error: unknown) => (error instanceof HelperChannelError ? `${error.code}: ${error.message}` : 'other'),
      );
      await vi.advanceTimersByTimeAsync(CHANNEL_PASSIVE_OPEN_WAIT_MS - 1);
      let refreshDone = false;
      void refreshed.then(() => (refreshDone = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(refreshDone).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await refreshed).toBe('unavailable: the worker is still being opened');
      // The bound stays far below a hung open (about 3 minutes), at most 30 s.
      expect(CHANNEL_PASSIVE_OPEN_WAIT_MS).toBeLessThanOrEqual(30_000);
      let callDone = false;
      void call.then(() => (callDone = true));
      await vi.advanceTimersByTimeAsync(120_000);
      expect(callDone).toBe(false);
      fail(new HelperChannelError('open', 'The worker on build-box did not answer.'));
      expect(await call).toBe('unavailable: The worker on build-box did not answer.');
      // Within the wait after the failure, the refresh is refused at once with the cause.
      await expect(channels.refresh(REMOTE, REFRESH_DEVSPACES)).rejects.toMatchObject({
        code: 'unavailable',
        message: 'The worker on build-box did not answer.',
      });
      expect(open).toHaveBeenCalledTimes(1);
      channels.dispose();
      // An open that takes longer than the old open wait but less than CHANNEL_PASSIVE_OPEN_WAIT_MS gives the states.
      const channel = { ...fakeChannel(), operations: ['refresh'], operation: vi.fn(async () => refreshValue(EXPECTED_STATES)) };
      const slow = vi.fn(() => new Promise<HelperChannel>((resolve) => setTimeout(() => resolve(channel as unknown as HelperChannel), 4 * OLD_OPEN_WAIT_MS)));
      const later = new HelperChannels({ open: slow, checkPresent: vi.fn(async () => {}), logger: silentLogger });
      const states = later.refresh(REMOTE, REFRESH_DEVSPACES);
      await vi.advanceTimersByTimeAsync(4 * OLD_OPEN_WAIT_MS);
      expect(await states).toEqual(EXPECTED_STATES);
      later.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  // A worker that cannot be opened is opened again by the refresh only after the wait (CHANNEL_RETRY_AFTER_FAILURE_MS),
  // never by each refresh; the first refresh (no failure yet) opens it.
  it('a worker that cannot be opened is not opened again by each refresh within the wait after the failure', async () => {
    const open = vi.fn(async (): Promise<HelperChannel> => {
      throw new HelperChannelError('open', 'The worker on build-box answered from another Docker engine.');
    });
    const checkPresent = vi.fn(async () => {});
    const channels = new HelperChannels({ open, prepare: vi.fn(async () => {}), checkPresent, logger: silentLogger });
    for (let i = 0; i < 5; i++) {
      await expect(channels.refresh(REMOTE, REFRESH_DEVSPACES)).rejects.toMatchObject({
        code: 'unavailable',
        message: 'The worker on build-box answered from another Docker engine.',
      });
    }
    expect(open).toHaveBeenCalledTimes(1);
    channels.dispose();
    const noWait = new HelperChannels({ open, checkPresent, logger: silentLogger, retryAfterFailureMs: 0 });
    await expect(noWait.refresh(REMOTE, REFRESH_DEVSPACES)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(noWait.refresh(REMOTE, REFRESH_DEVSPACES)).rejects.toMatchObject({ code: 'unavailable' });
    expect(open).toHaveBeenCalledTimes(3);
    noWait.dispose();
  });

  // A passive flow (a read of a window in the background) is made ready as the refresh: the helper image only checked,
  // never built, and the wait after a failed open kept; `passive` is not sent on.
  it('a passive flow checks the helper image, never builds it, and keeps the wait after a failed open', async () => {
    const channel = fakeChannel();
    let fail = true;
    const open = vi.fn(async (): Promise<HelperChannel> => {
      if (fail) throw new HelperChannelError('open', 'The worker on build-box could not be started.');
      return channel as unknown as HelperChannel;
    });
    const prepare = vi.fn(async () => {});
    const checkPresent = vi.fn(async () => {});
    const channels = new HelperChannels({ open, prepare, checkPresent, logger: silentLogger });
    for (let i = 0; i < 3; i++) {
      await expect(channels.flow(REMOTE, 'windowState', {}, { passive: true, timeoutMs: 30_000 })).rejects.toMatchObject({
        code: 'unavailable',
        message: 'The worker on build-box could not be started.',
      });
    }
    expect(open).toHaveBeenCalledTimes(1);
    expect(prepare).not.toHaveBeenCalled();
    expect(checkPresent).toHaveBeenCalledTimes(3);
    // A flow of a command of the user prepares the helper image and opens it in full, also within the wait.
    fail = false;
    expect(await channels.flow(REMOTE, 'windowState', {}, { timeoutMs: 30_000 })).toEqual({ outcome: 'notRunning' });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(2);
    await channels.flow(REMOTE, 'windowState', {}, { passive: true, timeoutMs: 30_000 });
    expect(channel.flow.mock.calls.map((call) => call[2])).toEqual([{ timeoutMs: 30_000 }, { timeoutMs: 30_000 }]);
    channels.dispose();
  });

  // The flow sent once more after `closed` is made ready passively too.
  it('a passive flow sent once more after a closed channel checks the helper image and never prepares it', async () => {
    const first = fakeChannel();
    const second = fakeChannel();
    const open = vi.fn().mockResolvedValueOnce(first as unknown as HelperChannel).mockResolvedValueOnce(second as unknown as HelperChannel);
    const prepare = vi.fn(async () => {});
    const checkPresent = vi.fn(async () => {});
    const channels = new HelperChannels({ open, prepare, checkPresent, logger: silentLogger });
    first.flow.mockImplementationOnce(async () => {
      first.close();
      throw new HelperChannelError('closed', 'closed');
    });
    expect(await channels.flow(REMOTE, 'windowState', {}, { passive: true })).toEqual({ outcome: 'notRunning' });
    expect(prepare).not.toHaveBeenCalled();
    expect(checkPresent).toHaveBeenCalledTimes(2);
    expect(second.flow).toHaveBeenCalledTimes(1);
    channels.dispose();
  });

  it('rejects when the worker failed or answered with an invalid value', async () => {
    const lost = refreshChannel(['refresh'], async () => {
      throw new HelperChannelError('lost', 'lost');
    });
    await expect(lost.channels.refresh(LOCAL_DOCKER_TARGET, REFRESH_DEVSPACES)).rejects.toMatchObject({ code: 'lost' });
    lost.channels.dispose();
    const wrong = { ...refreshValue(EXPECTED_STATES), branches: [{ id: REFRESH_DEVSPACES[3].id, branch: 'main' }] };
    const invalid = refreshChannel(['refresh'], async () => wrong);
    await expect(invalid.channels.refresh(LOCAL_DOCKER_TARGET, REFRESH_DEVSPACES)).rejects.toMatchObject({ code: 'protocol' });
    invalid.channels.dispose();
  });
});
