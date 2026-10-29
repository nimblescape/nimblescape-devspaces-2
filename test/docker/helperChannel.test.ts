// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The helper channel against the real Docker engine of the runner: the container of a channel with the workspace helper
// image, as openHelperChannel starts it on a remote host (here with the Docker CLI and the environment of the run, so on
// the engine of the runner). The script is bundled from src/helperChannel/main.ts like dist/helperChannel.js. Checked above all: the
// container ends and is removed by itself when its connection is lost (the extension closes it, the `docker run`
// process of the computer is killed, or the connection stays silent). `afterAll` fails when a channel container is left
// over. The channel starts no step container (the end of a batch helper with its worker is tested in
// src/helperChannel/batch.e2e.test.ts). The probe and the sweep of the worker go over the Engine API of its socket (no
// Docker CLI of the worker), so their answers are checked against what the Docker CLI of the runner reports.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as esbuild from 'esbuild';
import { sharedBundleOptions, workerBundleOptions } from '../../scripts/bundleOptions.mjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// The Docker CLI of the extension (BootstrapDocker).
import { BootstrapDocker } from '../../src/core/docker/bootstrapDocker';
import { remoteDockerTarget } from '../../src/core/docker/dockerHost';
import { outsideOperation, runWithDockerTarget } from '../../src/core/docker/dockerTargets';
import { HelperChannel } from '../../src/core/helperChannel/helperChannel';
import { channelRunArgs, openHelperChannel } from '../../src/core/helperChannel/helperChannels';
import {
  CHANNEL_PROTOCOL_VERSION,
  ENGINE_IDENTITY_ARGS,
  OP_PROBE,
  OP_SWEEP,
  channelLabelValue,
  encodeMessage,
  engineIdentity,
  parseProbeParams,
  parseProbeValue,
  parseSweepParams,
  parseSweepValue,
} from '../../src/core/helperChannel/protocol';
import { PIPE_LOADER, bundleHash, encodeBundle } from '../../src/core/loader/pipeLoader';
import { LABEL_HELPER_CHANNEL, LABEL_HELPER_RUN } from '../../src/core/names';
import { helperDockerSocket } from '../../src/core/helper/helperImages';
import type { StartOptions, StartedByteProcess, StartedProcess } from '../../src/core/ports';
import { NodeProcessRunner } from '../../src/core/process';
import type { RelayConnection } from '../../src/core/relay/connection';
import { RelayConnections, relayAccess } from '../../src/core/relay/connections';
import { DockerPipe, relayDockerDial } from '../../src/core/relay/dockerPipe';
import { HostPipes } from '../../src/core/relay/hostPipes';
import { dockerPipeAddress } from '../../src/core/relay/pipeAddress';
import { openRelayConnection } from '../../src/core/relay/transport';
import { TEST_RUN_LABEL, removeRunObjects } from './dockerRun';
import { Timings, dockerTestContext, testHelperImage, testStateVolume, testVscodeVolume } from './harness';

async function bundleScript(): Promise<string> {
  const result = await esbuild.build({
    // The worker's bundle as a production build of esbuild.mjs builds it: also the program of the Monitor and of
    // the analysis thread.
    ...workerBundleOptions(sharedBundleOptions({ production: true })),
    write: false,
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

async function waitUntil(condition: () => boolean, what: string, timeoutMs = 60_000, pollMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * The operation `sweep` through `channel`. The engine runs one prune at a time and refuses another meanwhile (409, "a
 * prune operation is already running"), and the open of the channel sends its own sweep in the background, so a refusal
 * for that reason alone is tried again, a few times.
 */
async function sweepThrough(channel: HelperChannel): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await channel.operation(OP_SWEEP, parseSweepParams({}), { timeoutMs: 30_000 });
    } catch (error) {
      if (attempt >= 5 || !(error instanceof Error) || !error.message.includes('a prune operation is already running')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

/**
 * One request on a Docker stream of `connection`, without the end of this side (the engine ends its side after the
 * answer of an HTTP/1.0 request): the answer as text.
 */
function dockerRequest(connection: RelayConnection, request: string): Promise<string> {
  const stream = connection.openDocker();
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    stream.onData((chunk) => {
      chunks.push(chunk);
      stream.consumed(chunk.length);
    });
    stream.onEnd(() => {
      stream.end();
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    stream.onClose((reason) => reject(new Error(reason)));
    stream.write(Buffer.from(request, 'utf8'));
  });
}

describe('the helper channel with the real Docker engine', () => {
  const { run, env, cli, log } = dockerTestContext('helperChannel');
  const byteRunner = new NodeProcessRunner();
  const docker = new BootstrapDocker(byteRunner, run.dockerPath, env, log);
  const timings = new Timings();
  const socket = helperDockerSocket(env, process.platform, run.dockerHost);
  // A host of the list of Devspaces. An operation on it would run its Docker calls with DOCKER_HOST=ssh://runner-engine
  // (BootstrapDocker); the open of this file runs them with the environment of the run instead, so on the engine of the
  // runner, and the calls through the Docker pipe of the extension go there through the relay.
  const target = remoteDockerTarget('runner-engine');
  let script = '';
  let helperTag = '';

  /**
   * The channel containers of this run. Only those with the label of the run, so that the channel of another run or of
   * a real window on the same engine is never listed or removed.
   */
  const channelContainers = () =>
    cli.lines(['ps', '-a', '--filter', `label=${LABEL_HELPER_CHANNEL}`, '--filter', `label=${TEST_RUN_LABEL}=${run.runId}`, '--format', '{{.Names}}']);
  /** The label of the run, on every channel container of this file. */
  const runLabelArgs = ['--label', `${TEST_RUN_LABEL}=${run.runId}`];

  /**
   * Opens a channel as the extension does; `extraArgs` go before the image (for example `-e`), `process` is kept.
   * `relay`: the worker behind the relay, on the connection of `relay` when it has one, else on a new connection whose
   * transport is a local `sh -s` (in place of `ssh … sh -s`); `transport` is that process, and `name` the name of its
   * container.
   */
  async function open(
    extraArgs: string[] = [],
    options: { relay?: RelayConnections } = {},
  ): Promise<{ channel: HelperChannel; process: StartedProcess; name: string; transport?: StartedByteProcess }> {
    let started: StartedProcess | undefined;
    let transport: StartedByteProcess | undefined;
    let name = '';
    const testArgs = (args: readonly string[]) => {
      const all = [...args];
      all.splice(all.indexOf(helperTag), 0, ...runLabelArgs, ...extraArgs);
      name = all[all.indexOf('--name') + 1];
      return all;
    };
    const channel = await openHelperChannel(
      {
        // `docker run` of the computer, as BootstrapDocker.start without an operation.
        start: (args) => {
          started = byteRunner.start(run.dockerPath, testArgs(args), { env });
          return started;
        },
        relay: () => {
          if (!options.relay) return undefined;
          const runner = {
            startBytes: (file: string, args: readonly string[], startOptions?: StartOptions) => (transport = byteRunner.startBytes(file, args, startOptions)),
          };
          // The Docker CLI of the run, with the environment of the run.
          return relayAccess(options.relay, 'runner-engine', (command, bundle) =>
            openRelayConnection(runner, { file: 'sh', args: ['-s'], env }, [run.dockerPath, ...testArgs(command.slice(1))], bundle, { logger: log, name: 'runner-engine' }),
          );
        },
        // The engine identity of the open is compared with one call without the worker.
        runDirect: (args, options) => outsideOperation(() => docker.run(args, options)),
        logger: log,
        script: async () => script,
        helperTag: async () => helperTag,
        socketPath: async () => socket,
        // The lock files in a volume of the test, never the one of the Monitor.
        stateVolume: testStateVolume({ run, cli }, 'helperChannel'),
        // The shared VS Code server store, a volume of the test.
        vscodeVolume: testVscodeVolume({ run, cli }, 'helperChannel'),
        // A window name that is cut at the end of a word (workerNameStart).
        windowName: () => 'Docker Test of the Worker Channel',
      },
      target,
    );
    return { channel, process: started!, name, transport };
  }

  /**
   * Closes the connection of the relay and waits until `--rm` removed its container `name`, so that no later check of
   * the leftovers (afterAll) sees it, also when the test runs alone.
   */
  async function endRelay(connections: RelayConnections, transport: StartedByteProcess | undefined, name: string): Promise<void> {
    connections.close('runner-engine', 'the test closed it');
    await transport?.exited;
    await waitUntil(() => cli.container(name) === undefined, 'the removal of the container');
  }

  beforeAll(async () => {
    script = await timings.measure('bundle the script', bundleScript);
    // The helper image through the harness.
    helperTag = (await timings.measure('workspace helper image ready', () => testHelperImage(docker, log, env))).tag;
  });

  afterAll(() => {
    timings.print('Timings of the helper channel:');
    const leftovers = channelContainers();
    removeRunObjects(cli, run.runId);
    for (const name of leftovers) cli.run(['rm', '-f', name]);
    // Every channel container must have ended by itself.
    expect(leftovers).toEqual([]);
  });

  it('opens: the container has outbound network only, no capability, --rm, and the labels; an operation and its value come back', async () => {
    const { channel, name } = await timings.measure('open a channel', () => open());
    // The short name of the worker: its window, cut at the end of a word, and its number.
    expect(name).toMatch(/^devspaces-docker-test-of-the-worker[0-9]+$/);
    const details = cli.container(name)!;
    expect(details.State.Running).toBe(true);
    expect(details.HostConfig.AutoRemove).toBe(true);
    expect(details.HostConfig.CapDrop).toEqual(['ALL']);
    expect(details.HostConfig.RestartPolicy?.Name ?? 'no').toMatch(/^(no|)$/);
    expect(details.Config.Labels?.[LABEL_HELPER_CHANNEL]).toBe(channelLabelValue(script));
    // Outbound network on the default bridge and no published port.
    const host = (details as unknown as { HostConfig: { NetworkMode: string; PortBindings?: Record<string, unknown> | null } }).HostConfig;
    expect(host.NetworkMode).toBe('bridge');
    expect(host.PortBindings ?? {}).toEqual({});
    // The command is the pipe loader with the path, the hash and the entry; the script came over stdin and is nowhere
    // in the configuration of the container.
    expect(details.Config.Cmd).toEqual(['node', '-e', PIPE_LOADER, '/opt/devspace/channel.js', bundleHash(script), 'startChannel']);
    expect(details.Config.OpenStdin).toBe(true);
    // The piece as it appears in the JSON of the details (a plain piece of the script would be escaped there, so the
    // check could never fail).
    expect(JSON.stringify(details)).not.toContain(JSON.stringify(script).slice(1, 201));

    // The operation `probe` reads the Engine API in the worker (`GET /version`, `GET /info`): the same version as the
    // Docker CLI of the runner, and the same identity, compared as values (as the open compares them).
    const probe = parseProbeValue(await timings.measure('probe through the channel', () => channel.operation(OP_PROBE, parseProbeParams({}), { timeoutMs: 30_000 })));
    expect(probe?.serverVersion).toBe(cli.ok(['version', '--format', '{{.Server.Version}}']));
    expect(probe?.engine).toBeDefined();
    expect(probe?.engine).toEqual(engineIdentity(cli.ok([...ENGINE_IDENTITY_ARGS])));

    // The sweep prunes over the Engine API with a label and an age: a channel container that was created but never
    // started, younger than 10 minutes, is kept (an open that runs now), and the value says how many it removed (others
    // of this engine older than 10 minutes may go, as at every open). With the label of every helper container that the
    // sweep prunes (the channels carry it, channelRunArgs), so that only its age keeps it.
    const young = `devspaces-worker-young-${run.runId}`;
    cli.ok(['create', '--name', young, '--label', `${LABEL_HELPER_RUN}=true`, '--label', `${LABEL_HELPER_CHANNEL}=${channelLabelValue(script)}`, ...runLabelArgs, helperTag, 'true']);
    try {
      const swept = parseSweepValue(await timings.measure('sweep through the channel', () => sweepThrough(channel)));
      expect(swept).toBeDefined();
      expect(swept!.removed).toBeGreaterThanOrEqual(0);
      expect(cli.container(young)?.State.Status).toBe('created');
    } finally {
      cli.run(['rm', '-f', young]);
    }

    channel.close();
    await timings.measure('end after close', () => waitUntil(() => cli.container(name) === undefined, 'the removal of the container'));
  });

  it('ends when the docker run process of the computer is killed hard (the connection breaks)', async () => {
    const { process: started, name } = await open();
    expect(cli.container(name)?.State.Running).toBe(true);
    // SIGKILL: docker run cannot pass a signal on or close anything; the engine sees its connection end.
    process.kill(started.pid!, 'SIGKILL');
    // The end of the input ends it at once; at the latest the silence (CHANNEL_SILENCE_EXIT_MS) does.
    await timings.measure('end after a hard kill of docker run', () =>
      waitUntil(() => cli.container(name) === undefined, 'the removal of the container', 120_000),
    );
  });

  it('runs the worker behind the relay: the next worker on the same connection, a Docker stream, the end of the relay container at the close of the connection and after a hard kill of its transport', async () => {
    const connections = new RelayConnections({ logger: log });
    try {
      const { channel, name, transport } = await timings.measure('open a channel behind the relay', () => open([], { relay: connections }));
      expect(transport).toBeDefined();
      const details = cli.container(name)!;
      expect(details.State.Running).toBe(true);
      expect(details.HostConfig.AutoRemove).toBe(true);
      // The relay is the first program of the container; it stored the bundle, and the worker runs from that file.
      expect(details.Config.Cmd).toEqual(['node', '-e', PIPE_LOADER, '/opt/devspace/channel.js', bundleHash(script), 'startRelay']);
      const identity = engineIdentity(cli.ok([...ENGINE_IDENTITY_ARGS]));
      const probe = parseProbeValue(await channel.operation(OP_PROBE, parseProbeParams({}), { timeoutMs: 30_000 }));
      expect(probe?.engine).toEqual(identity);
      // The close of the channel ends the worker; the connection stays, and the next channel starts its worker in the
      // same container, without a new transport.
      const connection = connections.get('runner-engine')!;
      channel.close();
      await waitUntil(() => connection.streamCount === 0, 'the end of the worker');
      expect(cli.container(name)?.State.Running).toBe(true);
      const next = await timings.measure('open a channel on the open connection', () => open([], { relay: connections }));
      expect(next.transport).toBeUndefined();
      expect(parseProbeValue(await next.channel.operation(OP_PROBE, parseProbeParams({}), { timeoutMs: 30_000 }))?.engine).toEqual(identity);
      // A Docker stream reaches the Docker socket of the container.
      expect(await dockerRequest(connection, 'GET /_ping HTTP/1.0\r\nHost: docker\r\n\r\n')).toMatch(/^HTTP\/1\.[01] 200 [\s\S]*\r\n\r\nOK$/);
      // The close of the connection ends the relay.
      connections.close('runner-engine', 'the test closed it');
      await expect(transport!.exited).resolves.toEqual({ exitCode: 0 });
      await timings.measure('end of the relay after close', () => waitUntil(() => cli.container(name) === undefined, 'the removal of the container'));
    } finally {
      connections.dispose();
    }

    const killed = new RelayConnections({ logger: log });
    try {
      const second = await open([], { relay: killed });
      expect(cli.container(second.name)?.State.Running).toBe(true);
      // SIGKILL of the transport, which `exec` made the `docker run` process: the engine sees its connection end.
      process.kill(second.transport!.pid!, 'SIGKILL');
      await timings.measure('end of the relay after a hard kill of its transport', () =>
        waitUntil(() => cli.container(second.name) === undefined, 'the removal of the container', 120_000),
      );
    } finally {
      killed.dispose();
    }
  });

  // The Docker pipe of a window (docs/architecture.md "The Docker pipe"): the Docker CLI with DOCKER_HOST at the pipe, as
  // the Dev Containers extension uses it, through the connection of the relay that the worker opened.
  it('carries the Docker CLI through the Docker pipe and the relay: the end of standard input of `run -i` and `exec -i`, and the output', async () => {
    const connections = new RelayConnections({ logger: log });
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-'));
    let pipe: DockerPipe | undefined;
    const sleeper = `devspaces-pipe-test-${run.runId}`;
    try {
      const { channel, name, transport } = await open([], { relay: connections });
      const address = dockerPipeAddress('0123456789abcdef', process.platform, folder);
      pipe = await DockerPipe.listen({ address, connect: async (socket) => relayDockerDial(connections.get('runner-engine')!, socket), logger: log, name: 'the test' });
      const viaPipe = (args: string[], input?: string) => byteRunner.run(run.dockerPath, ['-H', address.dockerHost, ...args], { env, input, timeoutMs: 120_000 });
      const version = await timings.measure('docker version through the pipe', () => viaPipe(['version', '--format', '{{.Server.Version}}']));
      expect({ exitCode: version.exitCode, stdout: version.stdout.trim() }).toEqual({ exitCode: 0, stdout: cli.ok(['version', '--format', '{{.Server.Version}}']) });
      // The end of standard input reaches the program in the container (CloseWrite of the Docker CLI): `cat` ends.
      const ran = await timings.measure('docker run -i through the pipe', () =>
        viaPipe(['run', '--rm', '-i', ...runLabelArgs, '--entrypoint', 'sh', helperTag, '-c', 'cat; echo " and the end"'], 'the input'),
      );
      expect({ exitCode: ran.exitCode, stdout: ran.stdout }).toEqual({ exitCode: 0, stdout: 'the input and the end\n' });
      expect((await viaPipe(['run', '-d', '--name', sleeper, ...runLabelArgs, '--entrypoint', 'sleep', helperTag, '600'])).exitCode).toBe(0);
      const executed = await viaPipe(['exec', '-i', sleeper, 'sh', '-c', 'wc -c'], 'x'.repeat(300_000));
      expect({ exitCode: executed.exitCode, stdout: executed.stdout.trim() }).toEqual({ exitCode: 0, stdout: '300000' });
      // Every connection of the Docker CLI ended with it; the worker stream stays.
      await waitUntil(() => pipe!.connectionCount === 0, 'the end of the connections of the pipe');
      expect(connections.get('runner-engine')?.streamCount).toBe(1);
      // The worker stream and at least one Docker stream for each of the four calls.
      expect(connections.get('runner-engine')?.streamsOpened).toBeGreaterThanOrEqual(5);
      channel.close();
      await endRelay(connections, transport, name);
    } finally {
      cli.run(['rm', '-f', sleeper]);
      pipe?.close();
      connections.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  // The Docker pipe of the extension (docs/architecture.md "The Docker pipe"): the Docker CLI of the extension
  // (BootstrapDocker) in an operation on the host, through the connection of the relay that the worker opened, once that
  // connection passed its checks; a build too (the context and the session of BuildKit on Docker streams).
  it('carries the Docker calls of the extension through its Docker pipe and the relay: a query and a build', async () => {
    let hostPipes: HostPipes | undefined;
    const connections = new RelayConnections({ logger: log, onUse: (host) => void hostPipes?.serve(host) });
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'host-pipe-'));
    hostPipes = new HostPipes({ logger: log, platform: process.platform, base: () => folder, relayConnection: (host) => connections.get(host), dialStdio: () => undefined });
    const pipes = hostPipes;
    const viaPipe = new BootstrapDocker(byteRunner, run.dockerPath, env, log, process.platform, { dockerPipe: (pipeTarget) => pipes.dockerHost(pipeTarget.host) });
    const context = fs.mkdtempSync(path.join(os.tmpdir(), 'host-pipe-build-'));
    const tag = `devspaces-pipe-build-test:${run.runId}`;
    try {
      const { channel, name, transport } = await open([], { relay: connections });
      await waitUntil(() => pipes.dockerHost('runner-engine') !== undefined, 'the Docker pipe of the extension');
      const connection = connections.get('runner-engine')!;
      const opened = connection.streamsOpened;
      fs.writeFileSync(path.join(context, 'Dockerfile'), `FROM ${helperTag}\nLABEL ${TEST_RUN_LABEL}=${run.runId}\n`);
      const built = await runWithDockerTarget(target, async () => {
        expect(await viaPipe.imageExists(helperTag)).toBe(true);
        return timings.measure('docker build through the Docker pipe of the extension', () =>
          viaPipe.buildImage({ tag, dockerfile: path.join(context, 'Dockerfile'), context, labels: { [TEST_RUN_LABEL]: run.runId } }),
        );
      });
      expect(built).toBe(cli.ok(['image', 'inspect', '--format', '{{.Id}}', tag]));
      // The inspect, the build, and the list of the image by its build label went over Docker streams of the connection.
      expect(connection.streamsOpened - opened).toBeGreaterThanOrEqual(3);
      channel.close();
      await endRelay(connections, transport, name);
    } finally {
      hostPipes.dispose();
      connections.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
      fs.rmSync(context, { recursive: true, force: true });
    }
  });

  // The end after the silence.
  it('ends after the silence while the connection stays open', async () => {
    const containerName = `devspaces-worker-test-${run.runId}`;
    // The state volume (a volume of the test).
    const args = channelRunArgs({
      tag: helperTag,
      socketPath: socket,
      stateVolume: testStateVolume({ run, cli }, 'helperChannel'),
      // The shared VS Code server store (a volume of the test).
      vscodeVolume: testVscodeVolume({ run, cli }, 'helperChannel'),
      containerName,
      label: channelLabelValue(script),
      scriptHash: bundleHash(script),
    });
    // Long enough for the answer to hello to be seen on a slow runner.
    args.splice(args.indexOf(helperTag), 0, ...runLabelArgs, '-e', 'DEVSPACE_CHANNEL_SILENCE_MS=10000');
    const process = docker.start(args)!;
    let stdout = '';
    process.onStdout((text) => (stdout += text));
    process.write(encodeBundle(script));
    process.write(encodeMessage({ t: 'hello', protocol: CHANNEL_PROTOCOL_VERSION }));
    await waitUntil(() => stdout.includes('"t":"hello"'), 'the answer to hello');
    // Nothing more is written; the input of docker run stays open, as with a connection that hangs.
    await timings.measure('end after the silence', () => waitUntil(() => cli.container(containerName) === undefined, 'the removal of the channel container'));
    process.end();
    await process.exited;
  });
});
