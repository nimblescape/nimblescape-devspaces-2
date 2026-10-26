// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Monitor container of a remote Docker host, against the real Docker engine of the runner (the same code
// path as on a remote host: RemoteSessionMonitor.ensure with the workspace helper image and the socket of the engine).
// The script is the worker's bundle (dist/helperChannel.js, as esbuild.mjs builds it), whose entry startMonitor runs the
// Monitor (src/remoteMonitor/main.ts). The container, its volume, and the test containers have
// names of this run; the test containers carry the label nimblescape.devspaces.id with new ids, so the
// monitor acts on them. The tick of the monitor is shortened with DEVSPACE_MONITOR_TICK_MS (read only by main.ts).
// Checked: a labeled container with a stale record is stopped; one whose record keeps it running is not; one with a
// fresh heartbeat is not; one without any record is never touched; ensure on a running, a stopped, and a missing
// container; the forget subcommand and the record files of the volume (the test reads the files itself); an invalid
// heartbeat writes nothing. The container runs the pipe loader and gets the script on its input only; `docker restart`
// resumes from the stored script; a changed stored script makes the loader exit with 3, and ensure then replaces the
// container (with the restart policy kept); a monitor whose first load was cut off is replaced too. A heartbeat of the
// window (WindowHeartbeats, also sendFor of Close and Keep Running), with the image settings, the image list and
// Delete's forget, as the worker sends them over the Engine API (monitorFlow), to the monitor of this run. The restart
// policy `on-failure`; an automatic stop waits for the devspace lock that a worker holds, and a monitor killed
// during its stop under the lock leaves no lock held; the monitor exits with 0 when idle and stays exited until ensure
// starts it; a permanent monitor that no window uses ends itself (restart policy `no`, exit 0), and ensure replaces it.
// A window that closes records the Git state and sends its short release; the monitor stops the devspace after the
// short limit, and keeps one whose window reloaded within the waiting time.
import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sharedBundleOptions, workerBundleOptions } from '../../scripts/bundleOptions.mjs';
// The Docker CLI of the extension (BootstrapDocker).
import { BootstrapDocker } from '../../src/core/docker/bootstrapDocker';
import { helperDockerSocket } from '../../src/core/helper/helperImages';
import { LABEL_DEVSPACE_ID } from '../../src/core/names';
import { NodeProcessRunner } from '../../src/core/process';
import { LOADER_EXIT_CODE, PIPE_LOADER, bundleHash } from '../../src/core/loader/pipeLoader';
import {
  LABEL_MONITOR,
  MIN_LIMIT_SECONDS,
  REMOTE_MONITOR_READY_TEXT,
  REMOTE_MONITOR_SCRIPT_PATH,
  heartbeatFileName,
  parseHeartbeatFileName,
  parseHeartbeatRecord,
  remoteMonitorLabelValue,
} from '../../src/core/remoteMonitor/protocol';
import { forgetRecord, sendHeartbeat, sendMonitorSettings } from '../../src/core/worker/monitorFlow';
import { engineMonitor } from '../../src/core/worker/engineMonitor';
import type { MonitorRunSpec } from '../../src/core/worker/dockerEngine';
import { engineApi, engineHijack } from '../../src/helperChannel/engineApi';
import { dockerEngine } from '../../src/helperChannel/engineClient';
import { RemoteSessionMonitor } from '../../src/core/remoteMonitor/remoteSessionMonitor';
import { WindowHeartbeats } from '../../src/core/session/windowHeartbeats';
import { RELEASE_LIMIT_SECONDS, SWITCH_RELEASE_BOUNDS, releaseDevspace } from '../../src/core/session/windowRelease';
import type { Devspace } from '../../src/core/types';
import { TEST_BASE_IMAGE, TEST_RUN_LABEL, removeRunObjects } from './dockerRun';
import { Timings, dockerTestContext, testHelperImage, testStateVolume, testVscodeVolume } from './harness';
import { holdLockInContainer, lockIsFree } from './workerLocks';

const SOURCE = crypto.randomBytes(16).toString('hex');
const OTHER_SOURCE = crypto.randomBytes(16).toString('hex');
const TICK_MS = 500;

/** The records of a devspace: the time of the read and each record of a source. */
interface Recorded {
  now: number;
  records: Array<{ source: string; at: number; keepRunning: boolean }>;
}
/**
 * The release limit that the test sends to the monitor in place of the one of the window (RELEASE_LIMIT_SECONDS, a
 * fixed 5 minutes): the smallest limit of a heartbeat (MIN_LIMIT_SECONDS), so the test waits 1 minute and not 5. The
 * rules of the monitor do not depend on the length of the limit.
 */
const TEST_RELEASE_LIMIT_MS = MIN_LIMIT_SECONDS * 1000;
/** The wait for the stop: the limit, then some ticks of the monitor, the stop itself, and slack for a loaded runner. */
const RELEASE_STOP_WAIT_MS = TEST_RELEASE_LIMIT_MS + 60_000;

/** The script of the Monitor: the worker's bundle, as a production build of esbuild.mjs builds it. */
async function bundleScript(): Promise<string> {
  const result = await esbuild.build({ ...workerBundleOptions(sharedBundleOptions({ production: true })), write: false, logLevel: 'silent' });
  return result.outputFiles[0].text;
}

/**
 * The arguments of an attached `docker run -i` of the container of `spec`, for the arrangement of a first load that is cut
 * off (a client that the test kills before it writes the script). The ensure itself creates over the Engine API
 * (engineMonitor).
 */
function attachedRunArgs(spec: MonitorRunSpec): string[] {
  const { [LABEL_MONITOR]: label, ...others } = spec.labels;
  const args = ['run', '-i', '--sig-proxy=false', '--pull', 'never', '--name', spec.name, '--label', `${LABEL_MONITOR}=${label}`];
  for (const [key, value] of Object.entries(others)) args.push('--label', `${key}=${value}`);
  args.push('--restart', spec.restartPolicy);
  if (spec.network === 'none') args.push('--network', 'none');
  args.push('--cap-drop', 'ALL', '--security-opt', 'no-new-privileges');
  args.push('--log-driver', spec.log.driver, '--log-opt', `max-size=${spec.log.maxSize}`, '--log-opt', `max-file=${spec.log.maxFile}`);
  args.push('-v', `${spec.mounts.socket}:/var/run/docker.sock`, '-v', `${spec.mounts.volume}:${spec.mounts.volumeTarget}`);
  if (spec.mounts.store !== undefined) args.push('--mount', `type=volume,source=${spec.mounts.store.volume},target=${spec.mounts.store.target},volume-nocopy`);
  for (const [key, value] of Object.entries(spec.env)) args.push('-e', `${key}=${value}`);
  args.push(spec.image, ...spec.command);
  return args;
}

async function waitUntil(condition: () => boolean, what: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe('the Monitor container of a remote Docker host', () => {
  const { run, env, cli, log } = dockerTestContext('remoteMonitor');
  const docker = new BootstrapDocker(new NodeProcessRunner(), run.dockerPath, env, log);
  const containerName = `devspaces-test-monitor-${run.runId}`;
  const volumeName = `devspaces-test-monitor-${run.runId}`;
  const timings = new Timings();
  let script = '';
  let helperTag = '';
  // The ensure as the worker runs it, over the Engine API of the local engine (engineMonitor).
  const monitor = new RemoteSessionMonitor({
    engine: engineMonitor(dockerEngine(engineApi(helperDockerSocket(env, process.platform)), engineHijack(helperDockerSocket(env, process.platform)))),
    logger: log,
    script: async () => script,
    containerName,
    volumeName,
    labels: { [TEST_RUN_LABEL]: run.runId },
    containerEnv: { DEVSPACE_MONITOR_TICK_MS: String(TICK_MS) },
  });
  const socket = helperDockerSocket(env, process.platform, run.dockerHost);
  const ids = { stale: crypto.randomUUID(), kept: crypto.randomUUID(), fresh: crypto.randomUUID(), unrecorded: crypto.randomUUID() };
  const names = {
    stale: `devspaces-test-monitor-stale-${run.runId}`,
    kept: `devspaces-test-monitor-kept-${run.runId}`,
    fresh: `devspaces-test-monitor-fresh-${run.runId}`,
    unrecorded: `devspaces-test-monitor-unrecorded-${run.runId}`,
  };

  /** A labeled container of a devspace that ends at once on SIGTERM (--init). */
  function startDevspaceContainer(name: string, devspaceId: string): void {
    cli.ok([
      'run', '-d', '--init', '--name', name,
      '--label', `${LABEL_DEVSPACE_ID}=${devspaceId}`,
      '--label', `${TEST_RUN_LABEL}=${run.runId}`,
      TEST_BASE_IMAGE, 'sleep', '3600',
    ]);
  }

  /** Writes a record into the volume of the monitor as a heartbeat of long ago would have left it. */
  function writeRecord(source: string, devspaceId: string, record: { at: number; keepRunning: boolean; limitSeconds: number; seq: number }): void {
    const file = `/state/heartbeats/${heartbeatFileName(source, devspaceId)}`;
    cli.ok(['exec', '-i', containerName, 'sh', '-c', `mkdir -p /state/heartbeats && cat > ${file}`], JSON.stringify(record));
  }

  const running = (name: string): boolean => cli.container(name)?.State.Running === true;
  // The commands of the monitor as the worker sends them (monitorFlow over the Engine API of the local engine), to the
  // monitor container of this run; the operations of the worker name the real one.
  const engine = dockerEngine(engineApi(helperDockerSocket(env, process.platform)), engineHijack(helperDockerSocket(env, process.platform)));
  /**
   * The records of a devspace, read from the record files of the state volume in the monitor container (each
   * `<source>.<devspace id>.json` of /state/heartbeats with `cat`, checked by the protocol's parsers); `now` is the
   * clock of the test, which runs on the host of the engine. Undefined while the container does not run (its exec
   * fails).
   */
  const records = async (devspaceId: string): Promise<Recorded | undefined> => {
    const listed = cli.run(['exec', containerName, 'sh', '-c', 'cd /state/heartbeats 2>/dev/null || exit 0; for file in *.json; do [ -f "$file" ] && printf "%s %s\\n" "$file" "$(cat "$file")"; done; exit 0']);
    if (listed.code !== 0) return undefined;
    const found: Recorded['records'] = [];
    for (const line of listed.out.split('\n')) {
      const space = line.indexOf(' ');
      const parts = space < 0 ? undefined : parseHeartbeatFileName(line.slice(0, space));
      if (parts === undefined || parts.devspaceId !== devspaceId) continue;
      const record = parseHeartbeatRecord(line.slice(space + 1));
      if (record !== undefined) found.push({ source: parts.source, at: record.at, keepRunning: record.keepRunning });
    }
    return { now: Date.now(), records: found };
  };

  beforeAll(async () => {
    script = await timings.measure('bundle the script', bundleScript);
    // The helper image through the harness.
    helperTag = (await timings.measure('workspace helper image ready', () => testHelperImage(docker, log, env))).tag;
  });

  afterAll(() => {
    timings.print('Timings of the remote Monitor:');
    log.output(`docker logs ${containerName}:\n${cli.run(['logs', containerName]).out}\n`);
    removeRunObjects(cli, run.runId);
    // The volume of the records was created by `docker run -v` without the label of the run.
    cli.run(['rm', '-f', containerName]);
    cli.run(['volume', 'rm', volumeName]);
    expect(cli.container(containerName)).toBeUndefined();
    expect(cli.volume(volumeName)).toBeUndefined();
  });

  it('creates the container: its label, the restart policy, no network, the socket, and the volume', async () => {
    expect(await timings.measure('ensure (create)', () => monitor.ensure(helperTag, socket))).toBe('created');
    const details = cli.container(containerName) as unknown as {
      State: { Running: boolean };
      Config: { Labels: Record<string, string>; Image: string; Cmd: string[]; OpenStdin: boolean };
      HostConfig: { NetworkMode: string; RestartPolicy: { Name: string }; CapDrop: string[] | null; PortBindings: unknown };
    };
    expect(details.State.Running).toBe(true);
    expect(details.Config.Image).toBe(helperTag);
    expect(details.Config.Labels[LABEL_MONITOR]).toMatch(/^[0-9a-f]{12}$/);
    expect(details.Config.Labels[LABEL_DEVSPACE_ID]).toBeUndefined();
    // The monitor always has the default network (its background run reaches the update service of VS Code; it
    // publishes no port).
    expect(details.HostConfig.NetworkMode).toMatch(/^(default|bridge)$/);
    // `on-failure`: the monitor exits when idle and stays exited.
    expect(details.HostConfig.RestartPolicy.Name).toBe('on-failure');
    expect(details.HostConfig.CapDrop).toEqual(['ALL']);
    // The command is the pipe loader with the path, the hash and the entry; the script came over stdin and is nowhere
    // in the configuration of the container.
    expect(details.Config.Cmd).toEqual(['node', '-e', PIPE_LOADER, REMOTE_MONITOR_SCRIPT_PATH, bundleHash(script), 'startMonitor']);
    expect(details.Config.OpenStdin).toBe(true);
    // The piece as it appears in the JSON of the details (a plain piece of the script would be escaped there, so the
    // check could never fail).
    expect(JSON.stringify(details)).not.toContain(JSON.stringify(script).slice(1, 201));
    // The stored script is the one that was sent.
    expect(cli.run(['exec', containerName, 'sha256sum', REMOTE_MONITOR_SCRIPT_PATH]).out.split(' ')[0]).toBe(bundleHash(script));
    await waitUntil(() => cli.run(['logs', containerName]).out.includes(REMOTE_MONITOR_READY_TEXT), 'the start of the monitor', 30_000);
    // A second ensure finds it running.
    expect(await monitor.ensure(helperTag, socket)).toBe('running');
  });

  it('stops a container with a stale record, keeps one whose record keeps it running, one with a fresh heartbeat, and one without any record', async () => {
    startDevspaceContainer(names.unrecorded, ids.unrecorded);
    startDevspaceContainer(names.stale, ids.stale);
    startDevspaceContainer(names.kept, ids.kept);
    startDevspaceContainer(names.fresh, ids.fresh);
    const longAgo = Date.now() - 30 * 60_000;
    writeRecord(SOURCE, ids.stale, { at: longAgo, keepRunning: false, limitSeconds: 60, seq: longAgo });
    writeRecord(OTHER_SOURCE, ids.kept, { at: longAgo, keepRunning: true, limitSeconds: 60, seq: longAgo });
    // The heartbeat of the worker (monitorFlow.sendHeartbeat).
    const heartbeat = await sendHeartbeat(engine, { source: SOURCE, limitSeconds: 60, devspaces: [{ id: ids.fresh, keepRunning: false, seq: Date.now() }] }, undefined, containerName);
    expect(heartbeat.ok).toBe(true);

    await timings.measure('stop of the stale container', () => waitUntil(() => !running(names.stale), 'the stop of the stale container'));
    // Some more ticks: the others keep running.
    await new Promise((resolve) => setTimeout(resolve, 20 * TICK_MS));
    expect(running(names.kept)).toBe(true);
    expect(running(names.fresh)).toBe(true);
    // No computer sent a heartbeat for it (for example of the host's own local Docker): never acted on.
    expect(running(names.unrecorded)).toBe(true);
    const logs = cli.run(['logs', containerName]).out;
    expect(logs).toContain(`Stopping the container ${names.stale} of ${ids.stale}: no computer sent a heartbeat for 30 minutes`);
    expect(logs).toContain(`${ids.kept} keeps running`);
    expect(logs).not.toContain(names.fresh);
    expect(logs).not.toContain(ids.unrecorded);
  });

  // The stopNow heartbeat of a manual Stop: the monitor stops the devspace within a few ticks, whatever an older
  // keep of another computer says. The container has the label of the run (removeRunObjects).
  it('stops a devspace within a few ticks of a stopNow heartbeat, over an older keep', async () => {
    const id = crypto.randomUUID();
    const name = `devspaces-test-monitor-stopnow-${run.runId}`;
    startDevspaceContainer(name, id);
    const before = Date.now() - 60_000;
    writeRecord(OTHER_SOURCE, id, { at: before, keepRunning: true, limitSeconds: 60, seq: before });
    const sent = await sendHeartbeat(engine, { source: SOURCE, limitSeconds: 600, devspaces: [{ id, keepRunning: false, seq: Date.now(), stopNow: true }] }, undefined, containerName);
    expect(sent).toEqual({ ok: true });
    await timings.measure('stop after a stopNow', () => waitUntil(() => !running(name), 'the stop after the stopNow', 30 * TICK_MS));
    expect(cli.run(['logs', containerName]).out).toContain(`Stopping the container ${name} of ${id}: a computer asked to stop it (Stop)`);
  });

  it('prints the records of a devspace, forgets one, and writes nothing for an invalid heartbeat', async () => {
    // The records read by the test itself, from the record files of the volume.
    const recorded = await records(ids.fresh);
    expect(recorded?.records).toEqual([{ source: SOURCE, at: expect.any(Number), keepRunning: false }]);
    expect(Math.abs(recorded!.now - recorded!.records[0].at)).toBeLessThan(5 * 60_000);
    // Delete's `forget` is the worker's, as the worker sends it (monitorFlow).
    expect(await forgetRecord(engine, SOURCE, ids.fresh, containerName)).toEqual({ ok: true });
    expect((await records(ids.fresh))?.records).toEqual([]);

    const invalid = await docker.run(['exec', containerName, 'node', '/opt/devspace/monitor.js', 'heartbeat', '{"source":"../x"}']);
    expect(invalid.exitCode).toBe(2);
    const files = cli.run(['exec', containerName, 'ls', '-A', '/state/heartbeats']).out.split('\n').filter((name) => name !== '');
    expect(files.every((name) => /^[0-9a-f]{32}\.[0-9a-f-]{36}\.json$/.test(name))).toBe(true);
  });

  it('starts a stopped container again, and replaces one of another version', async () => {
    cli.ok(['stop', containerName]);
    expect(await monitor.ensure(helperTag, socket)).toBe('started');
    expect(running(containerName)).toBe(true);
    const before = cli.container(containerName)!.Id;
    // Another script: another label, so the container is replaced; the volume with the records stays.
    const previous = script;
    script = `${previous}\n// another version`;
    try {
      expect(await monitor.ensure(helperTag, socket)).toBe('created');
    } finally {
      script = previous;
    }
    expect(cli.container(containerName)!.Id).not.toBe(before);
    // The new container writes its script at its start; the records of the volume stay.
    let kept: Recorded | undefined;
    const deadline = Date.now() + 30_000;
    while ((kept = await records(ids.kept)) === undefined && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
    expect(kept?.records.map((record) => record.source)).toEqual([OTHER_SOURCE]);
  });

  // A restart starts the stored script without new input.
  it('resumes from the stored script after docker restart', async () => {
    expect(['created', 'running']).toContain(await monitor.ensure(helperTag, socket));
    await waitUntil(() => running(containerName), 'the monitor');
    const starts = () => cli.run(['logs', containerName]).out.split(REMOTE_MONITOR_READY_TEXT).length - 1;
    await waitUntil(() => starts() >= 1, 'the start of the monitor', 30_000);
    const before = starts();
    const id = cli.container(containerName)!.Id;
    cli.ok(['restart', containerName]);
    await timings.measure('start after docker restart', () => waitUntil(() => starts() > before, 'the start after the restart', 30_000));
    expect(running(containerName)).toBe(true);
    expect(cli.container(containerName)!.Id).toBe(id);
    expect(cli.run(['logs', containerName]).err).not.toContain('devspace loader:');
    expect(await monitor.ensure(helperTag, socket)).toBe('running');
    // It answers the subcommands of `docker exec` from the stored script: a heartbeat without devspaces (it writes
    // nothing).
    expect(await sendHeartbeat(engine, { source: SOURCE, limitSeconds: 60, devspaces: [] }, undefined, containerName)).toEqual({ ok: true });
  });

  it('exits with 3 after a restart when the stored script was changed, and ensure then creates it again', async () => {
    expect(['created', 'running']).toContain(await monitor.ensure(helperTag, socket));
    await waitUntil(() => running(containerName), 'the monitor');
    const id = cli.container(containerName)!.Id;
    cli.ok(['exec', containerName, 'sh', '-c', `echo '// changed' >> ${REMOTE_MONITOR_SCRIPT_PATH}`]);
    // The production configuration (its restart policy) stays. The loader exits 3 at once (the marker of its first
    // start: started before without its bundle), Docker restarts it (RestartCount ≥ 1), and ensure replaces it whether
    // it finds it `restarting` or, between two restarts, `running` (the hash check). The policy is `on-failure`, which
    // restarts the exit 3 too.
    cli.ok(['restart', containerName]);
    await timings.measure('exit 3 of the loader and a restart by the policy', () =>
      waitUntil(() => (cli.container(containerName)?.RestartCount ?? 0) >= 1, 'a restart by the policy', 90_000),
    );
    expect(cli.container(containerName)!.HostConfig.RestartPolicy?.Name).toBe('on-failure');
    expect(cli.run(['logs', containerName]).err).toContain('devspace loader: started before without its bundle');
    expect(LOADER_EXIT_CODE).toBe(3);
    expect(await monitor.ensure(helperTag, socket)).toBe('created');
    const details = cli.container(containerName)!;
    expect(details.Id).not.toBe(id);
    expect(details.State.Running).toBe(true);
    expect(details.HostConfig.RestartPolicy?.Name).toBe('on-failure');
    expect(cli.run(['exec', containerName, 'sha256sum', REMOTE_MONITOR_SCRIPT_PATH]).out.split(' ')[0]).toBe(bundleHash(script));
  });

  // The first, attached `docker run` is cut off before it wrote the script (the window reloaded, the SSH connection
  // dropped). The loader reads the end of its input and exits 3; the restart policy starts it again with an input that
  // never ends, and the marker of the first start makes it exit 3 at once, so ensure finds it restarting (or running
  // with RestartCount ≥ 1 and no stored script) and replaces it.
  it('replaces a monitor whose first load was cut off', { timeout: 240_000 }, async () => {
    cli.run(['rm', '-f', containerName]);
    const label = remoteMonitorLabelValue(script, helperTag, []);
    // An attached `docker run` of the container of runSpec (a client that a test can kill before it wrote the script).
    const client = spawn(run.dockerPath, attachedRunArgs(monitor.runSpec(helperTag, socket, label, script)), { env, stdio: ['pipe', 'pipe', 'pipe'] });
    client.stdin.on('error', () => {});
    client.stdout.resume();
    client.stderr.resume();
    const clientEnded = new Promise<void>((resolve) => client.on('close', () => resolve()));
    try {
      await waitUntil(() => running(containerName), 'the start of the interrupted monitor', 60_000);
      // Before any write: the client is killed as a closed window or a lost connection would end it.
      client.kill('SIGKILL');
      await clientEnded;
      await timings.measure('restart of the interrupted monitor by the policy', () =>
        waitUntil(() => (cli.container(containerName)?.RestartCount ?? 0) >= 1, 'a restart by the policy', 90_000),
      );
    } finally {
      if (client.exitCode === null && client.signalCode === null) client.kill('SIGKILL');
    }
    const interrupted = cli.container(containerName)!;
    // `on-failure`: the loader's exit 3 is restarted.
    expect(interrupted.HostConfig.RestartPolicy?.Name).toBe('on-failure');
    // `docker cp` reads the file system of a container in any state.
    const copied = cli.run(['cp', `${containerName}:${REMOTE_MONITOR_SCRIPT_PATH}`, '-']);
    expect(copied.code).not.toBe(0);
    expect(copied.err).toMatch(/Could not find the file/);
    expect(await monitor.ensure(helperTag, socket)).toBe('created');
    expect(cli.run(['cp', `${containerName}:${REMOTE_MONITOR_SCRIPT_PATH}`, '-']).code).toBe(0);
    const details = cli.container(containerName)!;
    expect(details.Id).not.toBe(interrupted.Id);
    expect(details.State.Running).toBe(true);
    expect(details.HostConfig.RestartPolicy?.Name).toBe('on-failure');
    expect(cli.run(['exec', containerName, 'sha256sum', REMOTE_MONITOR_SCRIPT_PATH]).out.split(' ')[0]).toBe(bundleHash(script));
  });
  // The heartbeats of a window, on the local engine too. They are the operation `heartbeat` of the worker of the engine
  // (its unit tests cover the channel); here WindowHeartbeats sends them as that operation does (monitorFlow over the
  // Engine API), to the monitor of this run. The image settings and list go on the input of their command.
  it('takes the heartbeats of a window, and the image settings and list, as the worker sends them', async () => {
    expect(['created', 'running', 'started']).toContain(await monitor.ensure(helperTag, socket));
    await waitUntil(() => running(containerName), 'the monitor');
    const windowSource = crypto.randomBytes(16).toString('hex');
    const devspace = {
      id: crypto.randomUUID(),
      repository: 'devspaces-test/window-heartbeat',
      configPath: '.devcontainer/devcontainer.json',
      volumeName: 'unused',
      containerName: 'unused',
      owner: { id: '1', login: 'devspaces-test' },
      createdAt: new Date().toISOString(),
    } as Devspace;
    const warnings: string[] = [];
    const heartbeats = new WindowHeartbeats({
      owner: () => ({ windowId: 'docker-test-window', pid: process.pid }),
      connected: () => devspace.id,
      registry: { list: async () => [{ ...devspace }] },
      settings: () => ({ stopOnClose: true, respectShutdownActionNone: false, stopAfterMinutes: 10 }),
      sourceId: () => windowSource,
      engineFor: async () => ({ kind: 'local', host: '', endpoint: '', context: 'default' }) as never,
      send: (_engine, input, signal) => sendHeartbeat(engine, input, signal, containerName),
      repair: async () => {
        throw new Error('the monitor runs; no repair is expected');
      },
      // The devspace of this test has no container; the check of the engine is covered by the unit tests
      // (windowHeartbeats.test.ts).
      containerExists: async () => true,
      warn: (message) => warnings.push(message),
      logger: log,
    });
    try {
      await timings.measure('a heartbeat of the window', () => heartbeats.tick());
      expect((await records(devspace.id))?.records).toEqual([{ source: windowSource, at: expect.any(Number), keepRunning: false }]);
      // Close and Keep Running: one heartbeat with the flag at once.
      devspace.keepRunningOnce = true;
      expect(await heartbeats.sendFor(devspace.id)).toEqual({ ok: true });
      expect((await records(devspace.id))?.records).toEqual([{ source: windowSource, at: expect.any(Number), keepRunning: true }]);
      expect(warnings).toEqual([]);
    } finally {
      heartbeats.dispose();
    }
    // The image settings and the image list, on the input of their commands (the monitor stores them in its volume).
    // The settings without prefixes and no image list.
    const settings = { schedule: '0 3 * * *', timeZone: 'UTC' };
    expect(await sendMonitorSettings(engine, { settings }, undefined, containerName)).toEqual({ ok: true });
    expect(JSON.parse(cli.run(['exec', containerName, 'cat', '/state/image-settings.json']).out)).toEqual(settings);
    // The image references in use of this computer, in a file of its own. A reference pinned by a digest, of a
    // repository that the engine does not have, so the monitor never pulls it (a pulled image would be left after the
    // teardown) and has no image of it to remove.
    const pinned = `ghcr.io/devspace-test/in-use@sha256:${'0'.repeat(64)}`;
    expect(await sendMonitorSettings(engine, { inUse: { source: windowSource, references: [pinned] } }, undefined, containerName)).toEqual({ ok: true });
    expect(JSON.parse(cli.run(['exec', containerName, 'cat', `/state/images-in-use.${windowSource}.json`]).out)).toMatchObject({ references: [pinned] });
    // No list of repositories in the volume.
    expect(cli.run(['exec', containerName, 'ls', '/state']).out.split(/\s+/)).not.toContain('images.json');
    // A monitor container that does not exist: `missing` (the window starts it again).
    expect(await sendHeartbeat(engine, { source: windowSource, limitSeconds: 60, devspaces: [] }, undefined, `${containerName}-none`)).toMatchObject({ ok: false, missing: true });
    // A stopped monitor (it exits when idle), as the engine answers it (409 "is not running"): `missing` too; ensure
    // starts it again.
    cli.ok(['stop', containerName]);
    expect(await sendHeartbeat(engine, { source: windowSource, limitSeconds: 60, devspaces: [] }, undefined, containerName)).toMatchObject({ ok: false, missing: true });
    expect(['started', 'created']).toContain(await monitor.ensure(helperTag, socket));
    await waitUntil(() => running(containerName), 'the monitor');
  });

  // A window that closes records the Git state, sends its short release (RELEASE_LIMIT_SECONDS; the test sends
  // TEST_RELEASE_LIMIT_MS to the monitor in its place) through its worker, and its worker's input ends; the monitor
  // stops the devspace after the short limit, not after the long one. A window that reloads within that limit sends its
  // long heartbeats again, so its devspace keeps running.
  it('stops a closed window\'s devspace after the short release, and keeps one whose window reloaded in time', { timeout: RELEASE_STOP_WAIT_MS + 180_000 }, async () => {
    // The test waits for the release limit (TEST_RELEASE_LIMIT_MS), and its own timeout covers the setup, that wait,
    // and the checks after it.
    expect(['created', 'running', 'started']).toContain(await monitor.ensure(helperTag, socket));
    await waitUntil(() => running(containerName), 'the monitor');
    const closedId = crypto.randomUUID();
    const reloadedId = crypto.randomUUID();
    const closedName = `devspaces-test-monitor-closed-${run.runId}`;
    const reloadedName = `devspaces-test-monitor-reloaded-${run.runId}`;
    startDevspaceContainer(closedName, closedId);
    startDevspaceContainer(reloadedName, reloadedId);
    // The heartbeats and the release as the worker sends them (monitorFlow).
    const windowSource = crypto.randomBytes(16).toString('hex');
    const devspaceOf = (id: string, name: string): Devspace =>
      ({
        id,
        repository: `devspaces-test/${name}`,
        configPath: '.devcontainer/devcontainer.json',
        volumeName: 'unused',
        containerName: name,
        owner: { id: '1', login: 'devspaces-test' },
        createdAt: new Date().toISOString(),
      }) as Devspace;
    const devspaces = [devspaceOf(closedId, closedName), devspaceOf(reloadedId, reloadedName)];
    const settings = { stopOnClose: true, respectShutdownActionNone: false, stopAfterMinutes: 10 };
    const windowOf = (connected: string): WindowHeartbeats =>
      new WindowHeartbeats({
        owner: () => ({ windowId: `docker-test-${connected}`, pid: process.pid }),
        connected: () => connected,
        registry: { list: async () => devspaces.map((item) => ({ ...item })) },
        settings: () => settings,
        sourceId: () => windowSource,
        engineFor: async () => ({ kind: 'local', host: '', endpoint: '', context: 'default' }) as never,
        send: (_engine, input, signal) => sendHeartbeat(engine, input, signal, containerName),
        repair: async () => {
          throw new Error('the monitor runs; no repair is expected');
        },
        containerExists: async () => true,
        warn: (message) => log.warn(message),
        logger: log,
      });
    const events: string[] = [];
    const release = (heartbeats: WindowHeartbeats, id: string) =>
      releaseDevspace(
        {
          registry: { list: async () => devspaces.map((item) => ({ ...item })) },
          settings: () => settings,
          otherWindowUses: async () => false,
          recordGitState: async (devspace) => {
            events.push(`git ${devspace.id}`);
          },
          send: async (devspaceId, limitSeconds, signal) => {
            events.push(`release ${devspaceId} ${limitSeconds}`);
            return heartbeats.release(devspaceId, TEST_RELEASE_LIMIT_MS / 1000, signal);
          },
          logger: log,
        },
        id,
        SWITCH_RELEASE_BOUNDS,
      );
    const closedWindow = windowOf(closedId);
    const reloadingWindow = windowOf(reloadedId);
    try {
      // Both windows use their devspaces: the long limit.
      await closedWindow.tick();
      await reloadingWindow.tick();
      // Both close: the Git state, then the release, each; their heartbeats end.
      // Taken before the release is sent: the monitor writes the record (its `at`) after this time.
      const releaseSentAt = Date.now();
      expect(await release(closedWindow, closedId)).toBe('released');
      expect(await release(reloadingWindow, reloadedId)).toBe('released');
      // The window asks for its release limit; the monitor gets the shorter one of the test.
      expect(events).toEqual([`git ${closedId}`, `release ${closedId} ${RELEASE_LIMIT_SECONDS}`, `git ${reloadedId}`, `release ${reloadedId} ${RELEASE_LIMIT_SECONDS}`]);
      closedWindow.dispose();
      reloadingWindow.dispose();
      // The reload: a new window of the same computer within the waiting time sends the long limit again.
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      const reloadedWindow = windowOf(reloadedId);
      await reloadedWindow.tick();
      reloadedWindow.dispose();
      // Not before the release limit of the test, and long before the long one (stopAfterMinutes: 10); the release
      // limit of the window is shorter than the long one too.
      await timings.measure('stop after the release', () => waitUntil(() => !running(closedName), 'the stop after the release', RELEASE_STOP_WAIT_MS));
      expect(Date.now() - releaseSentAt).toBeGreaterThanOrEqual(TEST_RELEASE_LIMIT_MS - 1_000);
      expect(RELEASE_LIMIT_SECONDS * 1000).toBeLessThan(settings.stopAfterMinutes * 60_000);
      await new Promise((resolve) => setTimeout(resolve, 20 * TICK_MS));
      expect(running(reloadedName)).toBe(true);
      const logs = cli.run(['logs', containerName]).out;
      expect(logs).toContain(`Stopping the container ${closedName} of ${closedId}`);
      expect(logs).not.toContain(`Stopping the container ${reloadedName}`);
    } finally {
      closedWindow.dispose();
      reloadingWindow.dispose();
      cli.run(['rm', '-f', closedName, reloadedName]);
    }
  });

  // The monitor runs from a second tag of the pinned helper image, and its create checks the image ID before the start.
  // A tag of this run, so that the monitor tag of a real installation stays.
  it('runs from a tag of the pinned image, and a create from another image is removed before its start', async () => {
    const imageId = cli.ok(['image', 'inspect', '-f', '{{.Id}}', helperTag]);
    const tag = `devspaces-test-monitor-${run.runId}:0123456789ab`.toLowerCase();
    try {
      await engine.tagImage(imageId, tag);
      expect(cli.ok(['image', 'inspect', '-f', '{{.Id}}', tag])).toBe(imageId);
      cli.ok(['rm', '-f', containerName]);
      expect(await monitor.ensure(helperTag, socket, undefined, tag, imageId)).toBe('created');
      const details = cli.container(containerName) as unknown as { Image: string; Config: { Image: string; Labels: Record<string, string> }; State: { Running: boolean } };
      expect(details.Config.Image).toBe(tag);
      expect(details.Image).toBe(imageId);
      expect(details.State.Running).toBe(true);
      // The label still names the helper tag: an ensure by the image ID finds it running.
      expect(await monitor.ensure(helperTag, socket, undefined, imageId)).toBe('running');

      // The tag moved to another image (another window between its tag and this create): the create fails and leaves nothing.
      cli.ok(['rm', '-f', containerName]);
      const otherId = cli.ok(['image', 'inspect', '-f', '{{.Id}}', TEST_BASE_IMAGE]);
      await engine.tagImage(otherId, tag);
      await expect(monitor.ensureOrThrow(helperTag, socket, undefined, tag, imageId)).rejects.toThrow(`not from ${imageId}`);
      expect(cli.container(containerName)).toBeUndefined();
    } finally {
      cli.run(['image', 'rm', tag]);
      expect(await monitor.ensure(helperTag, socket)).not.toBe('failed');
    }
  });
});

// The automatic stops of the monitor take the devspace lock, which the workers of the windows hold during their
// operations (the same lock file in the same volume); a monitor killed while it holds the lock leaves none behind (the
// kernel frees it); the monitor exits with 0 when it is idle and stays exited under its restart policy, until ensure
// starts it again.
describe('the Monitor container: the devspace lock of its stops and its exit when idle', () => {
  const { run, env, cli, log } = dockerTestContext('remoteMonitor');
  const docker = new BootstrapDocker(new NodeProcessRunner(), run.dockerPath, env, log);
  const containerName = `devspaces-test-monitor-lock-${run.runId}`;
  const socket = helperDockerSocket(env, process.platform, run.dockerHost);
  let script = '';
  let helperTag = '';
  let volumeName = '';
  let monitor: RemoteSessionMonitor;
  const timings = new Timings();

  const running = (name: string): boolean => cli.container(name)?.State.Running === true;
  const logs = (): string => cli.run(['logs', containerName]).out;

  /** A labeled container of a devspace; without --init, `sleep` as PID 1 ignores SIGTERM, so a stop takes 10 s. */
  function startDevspaceContainer(name: string, devspaceId: string, init: boolean): void {
    cli.ok([
      'run', '-d', ...(init ? ['--init'] : []), '--name', name,
      '--label', `${LABEL_DEVSPACE_ID}=${devspaceId}`,
      '--label', `${TEST_RUN_LABEL}=${run.runId}`,
      TEST_BASE_IMAGE, 'sleep', '3600',
    ]);
  }

  function writeStaleRecord(devspaceId: string): void {
    const longAgo = Date.now() - 30 * 60_000;
    const file = `/state/heartbeats/${heartbeatFileName(SOURCE, devspaceId)}`;
    cli.ok(['exec', '-i', containerName, 'sh', '-c', `mkdir -p /state/heartbeats && cat > ${file}`], JSON.stringify({ at: longAgo, keepRunning: false, limitSeconds: 60, seq: longAgo }));
  }

  function newMonitor(idleMs: number): RemoteSessionMonitor {
    return new RemoteSessionMonitor({
      // Over the Engine API, as the worker runs it.
      engine: engineMonitor(dockerEngine(engineApi(helperDockerSocket(env, process.platform)), engineHijack(helperDockerSocket(env, process.platform)))),
      logger: log,
      script: async () => script,
      containerName,
      volumeName,
      labels: { [TEST_RUN_LABEL]: run.runId },
      containerEnv: { DEVSPACE_MONITOR_TICK_MS: String(TICK_MS), DEVSPACE_MONITOR_IDLE_MS: String(idleMs) },
    });
  }

  beforeAll(async () => {
    script = await bundleScript();
    // The helper image through the harness.
    helperTag = (await testHelperImage(docker, log, env)).tag;
    // The volume of the workers' lock files is the volume of this monitor, as on an engine.
    volumeName = testStateVolume({ run, cli }, 'remoteMonitor-locks');
    // Long idle time: these tests do not wait for the exit.
    monitor = newMonitor(3_600_000);
  });

  afterAll(async () => {
    timings.print('Timings of the devspace lock and the idle exit of the Monitor:');
    log.output(`docker logs ${containerName}:\n${cli.run(['logs', containerName]).out}\n`);
    // No worker is started (the holders of the lock are containers of this run).
    removeRunObjects(cli, run.runId);
    expect(cli.container(containerName)).toBeUndefined();
  });

  it('does not stop a devspace while a worker holds its lock, and stops it after the release', async () => {
    const id = crypto.randomUUID();
    const name = `devspaces-test-monitor-locked-${run.runId}`;
    // Held by a container of the helper image on the state volume.
    const lock = await holdLockInContainer({ run, cli }, volumeName, helperTag, id);
    let released = false;
    try {
      expect(await monitor.ensure(helperTag, socket)).toBe('created');
      startDevspaceContainer(name, id, true);
      writeStaleRecord(id);
      // The grace of the start (8 ticks), then some ticks that want to stop it.
      await waitUntil(() => logs().includes(`${id} is busy with an operation`), 'the busy lock in the log', 30_000);
      await new Promise((resolve) => setTimeout(resolve, 10 * TICK_MS));
      expect(running(name)).toBe(true);
      // Logged once per busy streak.
      expect(logs().split(`${id} is busy with an operation`).length - 1).toBe(1);
      lock.release();
      released = true;
      await timings.measure('stop after the release of the lock', () => waitUntil(() => !running(name), 'the stop after the release', 30_000));
      expect(logs()).toContain(`Stopping the container ${name} of ${id}`);
      // The monitor released the lock after its stop: a worker takes it at once (taken with `flock` as a worker takes
      // it, in a container of the helper image).
      expect(await lockIsFree({ run, cli }, volumeName, helperTag, id, 1)).toBe(true);
    } finally {
      if (!released) lock.release();
    }
  });

  it('holds the lock during its stop, and a monitor killed while it holds the lock leaves no lock held', async () => {
    expect(['created', 'running', 'started']).toContain(await monitor.ensure(helperTag, socket));
    const id = crypto.randomUUID();
    const name = `devspaces-test-monitor-slow-${run.runId}`;
    // `sleep` as PID 1 ignores SIGTERM: the `docker stop` of the monitor takes 10 s, under the lock.
    startDevspaceContainer(name, id, false);
    writeStaleRecord(id);
    await waitUntil(() => logs().includes(`Stopping the container ${name} of ${id}`), 'the start of the slow stop', 60_000);
    // During the stop, the lock is held by the monitor: a worker is refused after its wait (`flock` as a worker takes
    // it; busy is its LOCK_BUSY_EXIT).
    expect(await lockIsFree({ run, cli }, volumeName, helperTag, id, 1)).toBe(false);
    cli.ok(['kill', containerName]);
    await waitUntil(() => !running(containerName), 'the end of the killed monitor', 30_000);
    // The kernel freed the lock with the process: a worker takes it at once (as above).
    expect(await lockIsFree({ run, cli }, volumeName, helperTag, id, 1)).toBe(true);
    cli.run(['rm', '-f', name]);
  });

  // A permanent monitor (stopMonitorWhenIdle off, the default) has the restart policy `unless-stopped`,
  // mounts the store of the worker read-write with `nocopy` at /vscode (a volume of this run), and never exits when
  // idle; an ensure of one that ends when idle keeps it. Its first background run is a day away
  // (DEVSPACE_IMAGE_FIRST_MS), so nothing is downloaded here (the one Docker test of the monitor with the store).
  it('a permanent monitor: unless-stopped, the store at /vscode, no exit when idle; an ensure of one that ends when idle keeps it', async () => {
    cli.run(['rm', '-f', containerName]);
    const store = testVscodeVolume({ run, cli }, 'remoteMonitor');
    const options = {
      engine: engineMonitor(dockerEngine(engineApi(helperDockerSocket(env, process.platform)), engineHijack(helperDockerSocket(env, process.platform)))),
      logger: log,
      script: async () => script,
      containerName,
      volumeName,
      labels: { [TEST_RUN_LABEL]: run.runId },
      containerEnv: { DEVSPACE_MONITOR_TICK_MS: String(TICK_MS), DEVSPACE_MONITOR_IDLE_MS: '3000', DEVSPACE_IMAGE_FIRST_MS: '86400000' },
      vscodeStoreVolume: store,
    };
    // A permanent monitor of another computer, which a computer with stopMonitorWhenIdle on keeps (its own permanent
    // one would be replaced).
    const permanent = new RemoteSessionMonitor({ ...options, imageMaintenance: () => ({ schedule: '17', timeZone: 'UTC', permanent: true, computer: 'b'.repeat(32) }) });
    expect(await permanent.ensure(helperTag, socket)).toBe('created');
    const details = cli.container(containerName) as unknown as {
      HostConfig: { RestartPolicy: { Name: string }; Mounts?: Array<{ Type: string; Source: string; Target: string; VolumeOptions?: { NoCopy?: boolean } }> };
      Mounts: Array<{ Type: string; Name?: string; Destination: string; RW: boolean }>;
      Config: { Env: string[] };
    };
    expect(details.HostConfig.RestartPolicy.Name).toBe('unless-stopped');
    expect(details.Mounts).toEqual(expect.arrayContaining([expect.objectContaining({ Type: 'volume', Name: store, Destination: '/vscode', RW: true })]));
    expect(details.HostConfig.Mounts).toEqual([expect.objectContaining({ Type: 'volume', Source: store, Target: '/vscode', VolumeOptions: expect.objectContaining({ NoCopy: true }) })]);
    expect(details.Config.Env).toEqual(expect.arrayContaining(['DEVSPACE_MONITOR_PERMANENT=1', `DEVSPACE_VSCODE_STORE=${store}`]));
    await waitUntil(() => logs().includes('runs permanently.'), 'the start of the permanent monitor', 30_000);
    // Well past its idle time (3 s): still running.
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    expect(running(containerName)).toBe(true);
    expect(logs()).not.toContain('the Monitor exits');
    // A computer with stopMonitorWhenIdle on keeps it, and its owner label names the other computer.
    expect(cli.container(containerName)!.Config.Labels?.['nimblescape.devspaces.monitor-owner']).toBe('b'.repeat(32));
    const idle = new RemoteSessionMonitor({ ...options, imageMaintenance: () => ({ schedule: '17', timeZone: 'UTC', permanent: false, computer: 'a'.repeat(32) }) });
    expect(await idle.ensure(helperTag, socket)).toBe('running');
    expect(cli.container(containerName)!.HostConfig.RestartPolicy?.Name).toBe('unless-stopped');
    cli.ok(['rm', '-f', containerName]);
  });

  // A permanent monitor that no window used for its time without use (DEVSPACE_MONITOR_UNUSED_MS, 3 s here; 30 days
  // without it) looks again after that time, sets the restart policy of its own container (by the nonce of its create)
  // to `no`, and exits with 0, so Docker leaves it exited. The next ensure replaces it: its policy is not the one of its
  // mode.
  it('a permanent monitor that no window uses ends itself: restart policy "no", exit 0; the next ensure replaces it', async () => {
    cli.run(['rm', '-f', containerName]);
    const permanent = new RemoteSessionMonitor({
      engine: engineMonitor(dockerEngine(engineApi(helperDockerSocket(env, process.platform)), engineHijack(helperDockerSocket(env, process.platform)))),
      logger: log,
      script: async () => script,
      containerName,
      volumeName,
      labels: { [TEST_RUN_LABEL]: run.runId },
      containerEnv: { DEVSPACE_MONITOR_TICK_MS: String(TICK_MS), DEVSPACE_MONITOR_UNUSED_MS: '3000', DEVSPACE_IMAGE_FIRST_MS: '86400000' },
      imageMaintenance: () => ({ schedule: '17', timeZone: 'UTC', permanent: true, computer: 'a'.repeat(32) }),
    });
    expect(await permanent.ensure(helperTag, socket)).toBe('created');
    expect(cli.container(containerName)!.HostConfig.RestartPolicy?.Name).toBe('unless-stopped');
    await timings.measure('end without use', () => waitUntil(() => !running(containerName), 'the end without use', 60_000));
    const ended = cli.container(containerName) as unknown as { State: { Status: string; ExitCode: number }; HostConfig: { RestartPolicy: { Name: string } } };
    expect(ended.State.Status).toBe('exited');
    expect(ended.State.ExitCode).toBe(0);
    expect(ended.HostConfig.RestartPolicy.Name).toBe('no');
    expect(logs()).toContain('the Monitor ends itself. Its restart policy is now "no".');
    // Docker leaves it exited.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(running(containerName)).toBe(false);
    expect(await permanent.ensure(helperTag, socket)).toBe('created');
    expect(cli.container(containerName)!.HostConfig.RestartPolicy?.Name).toBe('unless-stopped');
    cli.ok(['rm', '-f', containerName]);
  });

  it('exits with 0 when no devspace container runs and image updates are off, stays exited, and ensure starts it again', async (context) => {
    // The idle exit needs a quiet engine: no running container with the devspace label (of this run or another).
    if (cli.lines(['ps', '-q', '--filter', `label=${LABEL_DEVSPACE_ID}`]).length > 0) {
      log.info('A container with the devspace label runs on this engine; the idle exit is not checked.');
      context.skip();
    }
    cli.run(['rm', '-f', containerName]);
    const idle = newMonitor(3_000);
    expect(await idle.ensure(helperTag, socket)).toBe('created');
    expect(cli.container(containerName)!.HostConfig.RestartPolicy?.Name).toBe('on-failure');
    await timings.measure('exit when idle', () => waitUntil(() => !running(containerName), 'the exit when idle', 60_000));
    const exited = cli.container(containerName) as unknown as { State: { Status: string; ExitCode: number }; RestartCount: number };
    expect(exited.State.Status).toBe('exited');
    expect(exited.State.ExitCode).toBe(0);
    // The text names the mode.
    expect(logs()).toContain('it does not run permanently; the Monitor exits.');
    // The restart policy leaves it exited.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    expect(running(containerName)).toBe(false);
    expect(cli.container(containerName)!.RestartCount).toBe(0);
    expect(await idle.ensure(helperTag, socket)).toBe('started');
    expect(running(containerName)).toBe(true);
  });
});
