// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it, vi } from 'vitest';
import { Messages } from '../messages';
import { silentLogger, type ProcessRunner, type RunOptions, type RunResult } from '../ports';
// The Docker CLI of the extension (BootstrapDocker).
import { BootstrapDocker } from './bootstrapDocker';
import { dockerTargetOf, isDockerContextHostTarget, isOnDockerHost, isPodmanDockerTarget, isUnreadableDockerTarget, remoteDockerTarget } from './dockerHost';
import { ensureDockerRunning } from './dockerStart';
import {
  CONTEXT_INSPECT_TIMEOUT_MS,
  DockerTargets,
  UNREADABLE_DOCKER_TARGET,
  operationDockerTarget,
  podmanDockerTarget,
  runWithDockerTarget,
} from './dockerTargets';
import { startDockerFor } from './remoteDocker';

const DOCKER = '/usr/local/bin/docker';

interface Call {
  args: string[];
  options: RunOptions;
}

/** A Docker CLI whose current context the test changes (`context`), like `docker context use` in another terminal. */
class FakeDockerCli implements ProcessRunner {
  readonly calls: Call[] = [];
  contexts: Record<string, string> = { default: 'unix:///var/run/docker.sock', 'desktop-linux': 'unix:///home/me/.docker/desktop/docker.sock', box: 'ssh://box' };
  context = 'default';
  inspectFails = false;

  async run(_file: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    this.calls.push({ args: [...args], options });
    if (args[0] === 'context' && args[1] === 'inspect') {
      if (this.inspectFails) return { exitCode: 1, stdout: '', stderr: 'context "x": context not found', timedOut: false };
      const host = options.env?.DOCKER_HOST;
      // `docker context inspect --format {{json .}} <name>` reads a named context.
      const named = args[4];
      if (named !== undefined && !(named in this.contexts)) return { exitCode: 1, stdout: '', stderr: `context "${named}": context not found`, timedOut: false };
      const name = host ? 'default' : (named ?? options.env?.DOCKER_CONTEXT ?? this.context);
      const endpoint = host ?? this.contexts[name];
      return { exitCode: 0, stdout: `${JSON.stringify({ Name: name, Endpoints: { docker: { Host: endpoint } } })}\n`, stderr: '', timedOut: false };
    }
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
  }
}

/** The Docker host of Devspaces that the test changes (`host`), like "Use a Remote Docker Host…" in another window. */
class FakeChoice {
  host: string | undefined;
  async dockerHost(): Promise<string | undefined> {
    return this.host;
  }
}

function setup(env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }, cliFound = true) {
  const dockerPath = cliFound ? DOCKER : undefined;
  const cli = new FakeDockerCli();
  const choice = new FakeChoice();
  const docker = new BootstrapDocker(cli, dockerPath, env, silentLogger, 'linux');
  const targets = new DockerTargets(docker, env, silentLogger, 'linux', choice);
  return { cli, docker, targets, choice };
}

describe('DockerTargets.resolve (the Docker host of Devspaces, else the current context)', () => {
  it('reads the local Docker of the current context', async () => {
    const { targets, cli } = setup();
    await expect(targets.resolve()).resolves.toEqual({ kind: 'local', host: '', endpoint: 'unix:///var/run/docker.sock', context: 'default' });
    expect(cli.calls[0].args).toEqual(['context', 'inspect', '--format', '{{json .}}']);
    expect(targets.last?.kind).toBe('local');
  });

  it('uses a host of its list over SSH, and reads no Docker context for it', async () => {
    const { targets, cli, choice } = setup();
    choice.host = 'me@box:2222';
    await expect(targets.resolve()).resolves.toEqual(remoteDockerTarget('me@box:2222'));
    await expect(targets.host()).resolves.toBe('me@box:2222');
    expect(cli.calls).toEqual([]);
    expect(targets.last).toEqual(remoteDockerTarget('me@box:2222'));
  });

  // A remote host needs the Docker CLI of this computer too: without one, the Docker setup shows (the local Docker).
  it('reads the local Docker without a Docker CLI, also with a host of its list', async () => {
    const { targets, choice } = setup({ PATH: '/usr/bin' }, false);
    choice.host = 'build-box';
    await expect(targets.resolve()).resolves.toEqual({ kind: 'local', host: '', endpoint: '' });
  });

  // Devspaces reaches a remote host only through its own list.
  it('does not support a current context of the user that reaches a host over SSH, and names the host', async () => {
    const { targets, cli } = setup();
    cli.context = 'box';
    const target = await targets.resolve();
    expect(target).toEqual({ kind: 'unsupported', host: 'ssh://box', endpoint: 'ssh://box', context: 'box', sshHost: 'box' });
    expect(isDockerContextHostTarget(target)).toBe(true);
    // Its host is that of no devspace, also not of one on `box`.
    expect(isOnDockerHost({ dockerHost: 'box' }, target.host)).toBe(false);
  });

  it('follows DOCKER_HOST of VS Code, without a context name; one that reaches a host over SSH is not supported', async () => {
    const local = setup({ PATH: '/usr/bin', DOCKER_HOST: 'unix:///run/user/1000/docker.sock' });
    await expect(local.targets.resolve()).resolves.toEqual({ kind: 'local', host: '', endpoint: 'unix:///run/user/1000/docker.sock' });
    const ssh = setup({ PATH: '/usr/bin', DOCKER_HOST: 'ssh://me@other' });
    await expect(ssh.targets.resolve()).resolves.toEqual({ kind: 'unsupported', host: 'ssh://me@other', endpoint: 'ssh://me@other', sshHost: 'me@other' });
    // A host of the list wins over DOCKER_HOST.
    ssh.choice.host = 'box';
    await expect(ssh.targets.resolve()).resolves.toEqual(remoteDockerTarget('box'));
  });

  it('uses the local Docker when the Docker host of Devspaces cannot be read (logged), and without a choice', async () => {
    const warnings: string[] = [];
    const logger = { ...silentLogger, warn: (message: string) => warnings.push(message) };
    const cli = new FakeDockerCli();
    const docker = new BootstrapDocker(cli, DOCKER, { PATH: '/usr/bin' }, silentLogger, 'linux');
    const broken = new DockerTargets(docker, { PATH: '/usr/bin' }, logger, 'linux', {
      dockerHost: () => Promise.reject(new Error('EACCES: permission denied')),
    });
    await expect(broken.resolve()).resolves.toMatchObject({ kind: 'local', context: 'default' });
    expect(warnings).toEqual(['The Docker host of Devspaces could not be read, so it uses the local Docker: EACCES: permission denied']);
    await expect(new DockerTargets(docker, { PATH: '/usr/bin' }, silentLogger, 'linux').resolve()).resolves.toMatchObject({ kind: 'local' });
  });

  it('refuses tcp to another computer', async () => {
    const { targets, cli } = setup();
    cli.contexts.default = 'tcp://192.0.2.10:2376';
    await expect(targets.resolve()).resolves.toMatchObject({ kind: 'unsupported', host: 'tcp://192.0.2.10:2376' });
  });

  it('assumes the local Docker without a CLI', async () => {
    const withoutCli = setup({ PATH: '/usr/bin' }, false);
    await expect(withoutCli.targets.resolve()).resolves.toEqual({ kind: 'local', host: '', endpoint: '' });
    expect(withoutCli.cli.calls).toEqual([]);
  });

  // The Docker calls of an operation without a context name go to the context that the CLI finds, perhaps a remote one,
  // so a context that cannot be read is never taken as the local Docker.
  it('refuses a current context that cannot be read: not supported, no endpoint, and the host of no devspace', async () => {
    const broken = setup();
    broken.cli.inspectFails = true;
    const target = await broken.targets.resolve();
    expect(target).toEqual(UNREADABLE_DOCKER_TARGET);
    expect(target.kind).toBe('unsupported');
    expect(isUnreadableDockerTarget(target)).toBe(true);
    expect(isOnDockerHost({}, target.host)).toBe(false);
    expect(isOnDockerHost({ dockerHost: 'box' }, target.host)).toBe(false);
    // An endpoint that is not supported is not taken for one that could not be read.
    expect(isUnreadableDockerTarget(dockerTargetOf('tcp://192.0.2.10:2376', 'other'))).toBe(false);
    // A call of the CLI that throws too.
    const thrown = setup();
    thrown.cli.run = async () => {
      throw new Error('spawn docker EACCES');
    };
    await expect(thrown.targets.resolve()).resolves.toEqual(UNREADABLE_DOCKER_TARGET);
    // With DOCKER_HOST set for VS Code, DOCKER_HOST decides the endpoint.
    const withHost = setup({ PATH: '/usr/bin', DOCKER_HOST: 'unix:///run/user/1000/docker.sock' });
    withHost.cli.inspectFails = true;
    await expect(withHost.targets.resolve()).resolves.toEqual({ kind: 'local', host: '', endpoint: 'unix:///run/user/1000/docker.sock' });
  });

  // podman-docker on Fedora with the Podman socket not enabled: `docker` runs podman, which has no Docker contexts.
  describe('a docker command that is Podman (podman-docker)', () => {
    const NOTE = 'Emulate Docker CLI using podman. Create /etc/containers/nodocker to quiet msg.\n';
    const result = (exitCode: number, stdout: string, stderr = NOTE): RunResult => ({ exitCode, stdout, stderr, timedOut: false });
    /**
     * Podman 5 prints an empty list for `context inspect --format '{{json .}}'` without a name (it has no Docker contexts);
     * older versions do not know the command. A docker command that prints nothing is taken the same way.
     */
    const PODMAN_5 = result(0, '[]\n');
    const NO_OUTPUT = result(0, '');
    const PODMAN_4 = result(125, '', `${NOTE}Error: unrecognized command \`podman context\`\nTry 'podman --help' for more information\n`);
    const DETAIL = 'docker --version: podman version 5.2.2';
    /** `podman info` has no ServerVersion. */
    const PODMAN_INFO = result(125, '', `${NOTE}Error: template: info:1:7: executing "info" at <.ServerVersion>: can't evaluate field ServerVersion\n`);

    function podmanDocker(contextInspect: RunResult, env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }, version = result(0, 'podman version 5.2.2\n')) {
      // What the docker command answers, and the identity of its file (BootstrapDocker.podmanCli).
      const answers = { contextInspect, version, info: PODMAN_INFO, server: undefined as RunResult | undefined, file: 'podman-docker 5.2.2' };
      const cli = {
        calls: [] as string[][],
        async run(_file: string, args: readonly string[]): Promise<RunResult> {
          cli.calls.push([...args]);
          if (args[0] === 'context') return answers.contextInspect;
          if (args[0] === '--version') return answers.version;
          if (args[0] === 'info') return answers.info;
          if (args[0] === 'version' && answers.server) return answers.server;
          throw new Error(`Unexpected call: docker ${args.join(' ')}`);
        },
      };
      const docker = new BootstrapDocker(cli, DOCKER, env, silentLogger, 'linux', { fileIdentity: async () => answers.file });
      const targets = new DockerTargets(docker, env, silentLogger, 'linux');
      const startLocal = vi.fn(() =>
        ensureDockerRunning(docker, cli, silentLogger, {
          platform: 'linux',
          timeoutMs: 1,
          sleep: async () => undefined,
          exists: () => false,
          launchDetached: async () => {
            throw new Error('not expected');
          },
        }),
      );
      const state = { rootlessSocket: async () => undefined, setRootlessSocket: async () => undefined };
      // The Docker start of an operation (extension.ts), with the target that the operation read.
      const start = async () => startDockerFor(await targets.resolve(), startLocal, { docker, runner: cli, state, logger: silentLogger, sshPath: undefined, env });
      return { cli, answers, targets, startLocal, start };
    }

    it.each([
      ['Podman 5 (an empty list)', PODMAN_5],
      ['an older Podman (unrecognized command)', PODMAN_4],
      ['a docker command without output', NO_OUTPUT],
    ])('%s: the operation is refused with the Podman message, not as a context that cannot be read', async (_name, contextInspect) => {
      const p = podmanDocker(contextInspect);
      const target = await p.targets.resolve();
      expect(target).toEqual(podmanDockerTarget(DETAIL));
      expect(isPodmanDockerTarget(target)).toBe(true);
      expect(isUnreadableDockerTarget(target)).toBe(false);
      // Its host is that of no devspace.
      expect(isOnDockerHost({}, target.host)).toBe(false);
      expect(isOnDockerHost({ dockerHost: 'Podman' }, target.host)).toBe(false);
      await expect(p.start()).rejects.toMatchObject({ code: 'dockerEndpointUnsupported', message: Messages.podmanNotSupported, detail: DETAIL });
      expect(p.startLocal).not.toHaveBeenCalled();
      expect(p.cli.calls.some((args) => args[0] === 'info')).toBe(false);
      // `docker --version` is asked once for the same file of the CLI.
      expect(p.cli.calls.filter((args) => args[0] === '--version')).toHaveLength(1);
    });

    // The user follows the Podman message: removes podman-docker and installs Docker Engine, whose CLI is another file at
    // the same path.
    it('asks the docker command again after its file changed: Docker in place of podman-docker works without a reload', async () => {
      const p = podmanDocker(PODMAN_5);
      await expect(p.targets.resolve()).resolves.toEqual(podmanDockerTarget(DETAIL));
      await expect(p.startLocal()).rejects.toMatchObject({ message: Messages.podmanNotSupported });
      Object.assign(p.answers, {
        file: 'docker-ce 29.8.0',
        contextInspect: result(0, `${JSON.stringify({ Name: 'default', Endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } })}\n`, ''),
        version: result(0, 'Docker version 29.8.0, build 3f2a5b1\n', ''),
        info: result(0, '"29.8.0"\n', ''),
        server: result(0, `${JSON.stringify({ Components: [{ Name: 'Engine', Version: '29.8.0' }], Version: '29.8.0' })}\n`, ''),
      });
      await expect(p.targets.resolve()).resolves.toMatchObject({ kind: 'local', host: '', endpoint: 'unix:///var/run/docker.sock' });
      await expect(p.startLocal()).resolves.toBeUndefined();
      await expect(p.start()).resolves.toBeUndefined();
      expect(p.cli.calls.filter((args) => args[0] === '--version')).toHaveLength(2);
    });

    it('with DOCKER_HOST set to the Podman socket, the Docker start refuses Podman as before', async () => {
      const p = podmanDocker(PODMAN_5, { PATH: '/usr/bin', DOCKER_HOST: 'unix:///run/user/1000/podman/podman.sock' });
      await expect(p.targets.resolve()).resolves.toMatchObject({ kind: 'local', endpoint: 'unix:///run/user/1000/podman/podman.sock' });
      await expect(p.start()).rejects.toMatchObject({ code: 'dockerEndpointUnsupported', message: Messages.podmanNotSupported, detail: DETAIL });
      expect(p.startLocal).toHaveBeenCalledTimes(1);
    });

    it('a check of the CLI that fails counts as Docker: the context cannot be read', async () => {
      const p = podmanDocker(PODMAN_5, { PATH: '/usr/bin' }, result(1, '', 'unknown flag: --version'));
      await expect(p.targets.resolve()).resolves.toEqual(UNREADABLE_DOCKER_TARGET);
      await expect(p.start()).rejects.toMatchObject({ code: 'dockerEndpointUnsupported', message: Messages.dockerContextUnreadable });
      // A reader without the check (another ContextReader) counts as Docker too.
      const plain = new DockerTargets({ isInstalled: () => true, run: async () => PODMAN_5 }, {}, silentLogger, 'linux');
      await expect(plain.resolve()).resolves.toEqual(UNREADABLE_DOCKER_TARGET);
    });
  });

  it('reads the Docker host of Devspaces and the context again for each operation, not once for ever', async () => {
    const { targets, cli, choice } = setup();
    await expect(targets.host()).resolves.toBe('');
    choice.host = 'box';
    await expect(targets.host()).resolves.toBe('box');
    choice.host = undefined;
    cli.context = 'desktop-linux';
    await expect(targets.current()).resolves.toMatchObject({ kind: 'local', context: 'desktop-linux' });
  });
});

describe('DockerTargets.withOperation (an operation keeps the host it started with)', () => {
  // Background work of an operation (the image list of the remote monitor) that it pins with runWithDockerTarget keeps
  // the target after the operation ended, also when the Docker host was switched meanwhile.
  it('background work pinned to the target of an operation keeps it after the operation ended', async () => {
    const { targets, choice } = setup();
    choice.host = 'box';
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let later: Promise<string | undefined> | undefined;
    let unpinned: Promise<string | undefined> | undefined;
    await targets.withOperation(async () => {
      const target = operationDockerTarget()!;
      later = runWithDockerTarget(target, async () => {
        await gate;
        return operationDockerTarget()?.host;
      });
      unpinned = (async () => {
        await gate;
        return operationDockerTarget()?.host;
      })();
    });
    choice.host = undefined;
    release();
    expect(await later).toBe('box');
    expect(await unpinned).toBeUndefined();
  });

  it('reads the target once; a switch in the middle does not move the operation', async () => {
    const { targets, cli, docker, choice } = setup();
    choice.host = 'box';
    await targets.withOperation(async () => {
      expect(operationDockerTarget()?.host).toBe('box');
      // The user chooses the local Docker in another window meanwhile.
      choice.host = undefined;
      await expect(targets.host()).resolves.toBe('box');
      await docker.run(['ps']);
      // A nested operation keeps it too.
      await targets.withOperation(async () => {
        await expect(targets.host()).resolves.toBe('box');
      });
    });
    expect(cli.calls.filter((call) => call.args[1] === 'inspect')).toHaveLength(0);
    // Every Docker call of the operation goes to the host it started with.
    const ps = cli.calls.find((call) => call.args[0] === 'ps');
    expect(ps?.options.env?.DOCKER_HOST).toBe('ssh://box');
    expect(ps?.options.env).not.toHaveProperty('DOCKER_CONTEXT');
    // The next operation reads the new host: the local Docker of the current context.
    cli.calls.length = 0;
    cli.context = 'desktop-linux';
    await targets.withOperation(async () => {
      await expect(targets.host()).resolves.toBe('');
      // The user runs `docker context use default` meanwhile.
      cli.context = 'default';
      await docker.run(['ps']);
    });
    expect(cli.calls.filter((call) => call.args[1] === 'inspect')).toHaveLength(1);
    // Every Docker call of the operation names the context it started with.
    expect(cli.calls.find((call) => call.args[0] === 'ps')?.options.env?.DOCKER_CONTEXT).toBe('desktop-linux');
    expect(operationDockerTarget()).toBeUndefined();
  });

  it('leaves the Docker calls outside of an operation, and with DOCKER_HOST, as they are', async () => {
    const plain = setup();
    await plain.docker.run(['ps']);
    expect(plain.cli.calls[0].options.env).not.toHaveProperty('DOCKER_CONTEXT');
    const withHost = setup({ PATH: '/usr/bin', DOCKER_HOST: 'unix:///run/user/1000/docker.sock' });
    await withHost.targets.withOperation(() => withHost.docker.run(['ps']));
    const ps = withHost.cli.calls.find((call) => call.args[0] === 'ps');
    expect(ps?.options.env).not.toHaveProperty('DOCKER_CONTEXT');
    expect(ps?.options.env?.DOCKER_HOST).toBe('unix:///run/user/1000/docker.sock');
  });

  it('keeps an explicit environment of a call (docker --config for a pull) as the caller built it', async () => {
    const { targets, cli, docker, choice } = setup();
    choice.host = 'box';
    await targets.withOperation(() => docker.run(['--config', '/tmp/x', 'pull', 'img'], { env: { DOCKER_HOST: 'ssh://box' } }));
    const pull = cli.calls.find((call) => call.args.includes('pull'));
    expect(pull?.options.env).toEqual({ DOCKER_HOST: 'ssh://box' });
  });

  it('a timer that an operation started reads the Docker host again after the operation ended', async () => {
    const { targets, cli, docker, choice } = setup();
    choice.host = 'box';
    let later: Promise<string> | undefined;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await targets.withOperation(async () => {
      later = gate.then(async () => {
        await docker.run(['ps']);
        return targets.host();
      });
    });
    choice.host = undefined;
    release();
    await expect(later).resolves.toBe('');
    expect(cli.calls.find((call) => call.args[0] === 'ps')?.options.env).not.toHaveProperty('DOCKER_CONTEXT');
    expect(cli.calls.find((call) => call.args[0] === 'ps')?.options.env).not.toHaveProperty('DOCKER_HOST');
  });
});

// The view shows the Docker host of every read.
describe('DockerTargets.onDidResolve', () => {
  it('gives every read target to the listener until it is removed', async () => {
    const { targets, choice } = setup();
    const seen: string[] = [];
    const remove = targets.onDidResolve((target) => seen.push(`${target.kind}:${target.host}`));
    await targets.resolve();
    choice.host = 'box';
    await targets.resolve();
    remove();
    await targets.resolve();
    expect(seen).toEqual(['local:', 'remote:box']);
  });

  it('keeps reading when a listener throws, and tells the others', async () => {
    const { targets } = setup();
    const seen: string[] = [];
    targets.onDidResolve(() => {
      throw new Error('broken');
    });
    targets.onDidResolve((target) => seen.push(target.kind));
    await expect(targets.resolve()).resolves.toMatchObject({ kind: 'local' });
    expect(seen).toEqual(['local']);
  });
});

// Of overlapping reads, the one that started last wins.
describe('DockerTargets.resolve with overlapping reads', () => {
  it('does not let an older read that finishes later overwrite a newer one', async () => {
    const results = [
      { exitCode: 0, stdout: JSON.stringify({ Name: 'default', Endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } }), stderr: '', timedOut: false },
      { exitCode: 0, stdout: JSON.stringify({ Name: 'desktop-linux', Endpoints: { docker: { Host: 'unix:///home/me/.docker/desktop/docker.sock' } } }), stderr: '', timedOut: false },
    ];
    const gates: Array<(value: RunResult) => void> = [];
    const docker = { isInstalled: () => true, run: async (): Promise<RunResult> => new Promise<RunResult>((resolve) => gates.push(resolve)) };
    const targets = new DockerTargets(docker, {}, silentLogger, 'linux');
    const seen: Array<string | undefined> = [];
    targets.onDidResolve((target) => seen.push(target.context));
    const older = targets.resolve();
    const newer = targets.resolve();
    // Both reads ask for the Docker host of Devspaces first.
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    gates[1](results[1]);
    await newer;
    gates[0](results[0]);
    await expect(older).resolves.toMatchObject({ kind: 'local', context: 'default' });
    expect(seen).toEqual(['desktop-linux']);
    expect(targets.last?.context).toBe('desktop-linux');
  });
});

// The engine of a Docker host, whatever host Devspaces uses now (the heartbeats, the window of a devspace).
describe('DockerTargets.ofHost', () => {
  it('gives a host of the list over SSH without a call, and the local Docker of the current context for ""', async () => {
    const { targets, cli, choice } = setup();
    choice.host = 'other-box';
    const seen: string[] = [];
    targets.onDidResolve((target) => seen.push(target.host));
    await expect(targets.ofHost('box')).resolves.toEqual(remoteDockerTarget('box'));
    expect(cli.calls).toEqual([]);
    cli.context = 'desktop-linux';
    await expect(targets.ofHost('')).resolves.toMatchObject({ kind: 'local', host: '', context: 'desktop-linux' });
    expect(cli.calls).toHaveLength(1);
    expect(targets.last).toBeUndefined();
    expect(seen).toEqual([]);
  });
});

// The engine of a named Docker context (the context `default` for the heartbeats), whatever context is current.
describe('DockerTargets.ofContext', () => {
  it('reads the named context, not the current one, and changes neither `last` nor tells a listener', async () => {
    const { targets, cli } = setup();
    cli.context = 'box';
    const seen: string[] = [];
    targets.onDidResolve((target) => seen.push(target.host));
    await expect(targets.ofContext('desktop-linux')).resolves.toEqual({
      kind: 'local',
      host: '',
      endpoint: 'unix:///home/me/.docker/desktop/docker.sock',
      context: 'desktop-linux',
    });
    expect(cli.calls[0].args).toEqual(['context', 'inspect', '--format', '{{json .}}', 'desktop-linux']);
    expect(targets.last).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it('is undefined for a context that cannot be read, a name that is no context name, or without a Docker CLI', async () => {
    const { targets, cli } = setup();
    await expect(targets.ofContext('gone')).resolves.toBeUndefined();
    await expect(targets.ofContext('--host=tcp://x')).resolves.toBeUndefined();
    expect(cli.calls.map((call) => call.args[4])).toEqual(['gone']);
    await expect(setup({ PATH: '/usr/bin' }, false).targets.ofContext('default')).resolves.toBeUndefined();
  });

  // Bounded, never an option, never throws.
  function reader(run: (args: readonly string[], options?: RunOptions) => Promise<RunResult>, installed: () => boolean = () => true) {
    const calls: Array<{ args: readonly string[]; options?: RunOptions }> = [];
    const warnings: string[] = [];
    const logger = { ...silentLogger, warn: (message: string) => warnings.push(message) };
    const targets = new DockerTargets(
      {
        isInstalled: installed,
        run: (args, options) => {
          calls.push({ args, options });
          return run(args, options);
        },
      },
      { PATH: '/usr/bin' },
      logger,
      'linux',
    );
    return { targets, calls, warnings };
  }
  const inspected = async (): Promise<RunResult> => ({
    exitCode: 0,
    stdout: JSON.stringify({ Name: 'desktop-linux', Endpoints: { docker: { Host: 'unix:///home/me/.docker/desktop/docker.sock' } } }),
    stderr: '',
    timedOut: false,
  });

  it('reads the context within CONTEXT_INSPECT_TIMEOUT_MS', async () => {
    const r = reader(inspected);
    await expect(r.targets.ofContext('desktop-linux')).resolves.toMatchObject({ context: 'desktop-linux' });
    expect(r.calls[0].options?.timeoutMs).toBe(CONTEXT_INSPECT_TIMEOUT_MS);
  });

  it('is undefined with a warning when the Docker CLI rejects or the check of the CLI throws; never throws', async () => {
    const r = reader(() => Promise.reject(new Error('spawn docker EACCES')));
    await expect(r.targets.ofContext('desktop-linux')).resolves.toBeUndefined();
    expect(r.warnings).toEqual(['The Docker context desktop-linux could not be read: spawn docker EACCES']);
    const s = reader(inspected, () => {
      throw new Error('stat failed');
    });
    await expect(s.targets.ofContext('desktop-linux')).resolves.toBeUndefined();
    expect(s.warnings).toHaveLength(1);
  });

  it('never passes a name that starts with a dash (an option) to the CLI', async () => {
    const r = reader(inspected);
    await expect(r.targets.ofContext('-D')).resolves.toBeUndefined();
    await expect(r.targets.ofContext('--help')).resolves.toBeUndefined();
    expect(r.calls).toEqual([]);
  });

  it('follows DOCKER_HOST of VS Code, as resolve does', async () => {
    const { targets } = setup({ PATH: '/usr/bin', DOCKER_HOST: 'unix:///run/user/1000/docker.sock' });
    await expect(targets.ofContext('desktop-linux')).resolves.toEqual({ kind: 'local', host: '', endpoint: 'unix:///run/user/1000/docker.sock' });
  });
});
