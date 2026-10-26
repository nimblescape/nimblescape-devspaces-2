// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The helper channel against the real Docker engine of the runner: the container of a channel with the workspace helper
// image, as openHelperChannel starts it on a remote host (here without a Docker context, so on the engine of the
// runner). The script is bundled from src/helperChannel/main.ts like dist/helperChannel.js. Checked above all: the
// container ends and is removed by itself when its connection is lost (the extension closes it, the `docker run`
// process of the computer is killed, or the connection stays silent). `afterAll` fails when a channel container is left
// over. The channel starts no step container (the end of a batch helper with its worker is tested in
// src/helperChannel/batch.e2e.test.ts). The probe and the sweep of the worker go over the Engine API of its socket (no
// Docker CLI of the worker), so their answers are checked against what the Docker CLI of the runner reports.
import * as esbuild from 'esbuild';
import { sharedBundleOptions, workerBundleOptions } from '../../scripts/bundleOptions.mjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// The Docker CLI of the extension (BootstrapDocker).
import { BootstrapDocker } from '../../src/core/docker/bootstrapDocker';
import { dockerTargetOf } from '../../src/core/docker/dockerHost';
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
import type { StartedProcess } from '../../src/core/ports';
import { NodeProcessRunner } from '../../src/core/process';
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

describe('the helper channel with the real Docker engine', () => {
  const { run, env, cli, log } = dockerTestContext('helperChannel');
  const docker = new BootstrapDocker(new NodeProcessRunner(), run.dockerPath, env, log);
  const timings = new Timings();
  const socket = helperDockerSocket(env, process.platform, run.dockerHost);
  // A remote target without a context name: the calls go to the engine of the runner.
  const target = dockerTargetOf('ssh://runner-engine', undefined);
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

  /** Opens a channel as the extension does; `extraArgs` go before the image (for example `-e`), `process` is kept. */
  async function open(extraArgs: string[] = []): Promise<{ channel: HelperChannel; process: StartedProcess; name: string }> {
    let started: StartedProcess | undefined;
    let name = '';
    const channel = await openHelperChannel(
      {
        start: (args) => {
          const all = [...args];
          all.splice(all.indexOf(helperTag), 0, ...runLabelArgs, ...extraArgs);
          name = all[all.indexOf('--name') + 1];
          started = docker.start(all);
          return started;
        },
        // The engine identity of the open is compared with one call without the worker.
        runDirect: (args, options) => docker.run(args, options),
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
    return { channel, process: started!, name };
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
