// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The login without setup against a real OpenSSH (docs/architecture.md "Login without setup"): the SSH server of the
// remote host tests (test/docker/sshd) with a password for root and no key, and an empty known_hosts. The login of a
// flow of the user asks for the unknown host key and the password in VS Code (fake dialogs; the real launcher, helper
// and pipe of SshAskpassServer, run by the real `ssh` through SSH_ASKPASS), then the shell before the relay runs
// `docker info` of the host on that one login. A login outside of a flow of the user asks nothing and fails at once.
// The key offer after that login (docs/architecture.md "The key of Devspaces"): the real `ssh-keygen` creates the key of
// Devspaces in a home folder of the test, the shell adds it to authorized_keys of root, and the logins after it (also
// the `ssh` of the Docker CLI, through the wrapper) need no password.
import { vi } from 'vitest';

vi.mock('vscode', async () => (await import('../../src/vscode/testing/fakeVscode')).fakeVscode);

import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BootstrapDocker } from '../../src/core/docker/bootstrapDocker';
import { findExecutable, putFolderFirstInPath } from '../../src/core/docker/dockerCli';
import { noPromptEnv, testRemoteDockerHost } from '../../src/core/docker/remoteDocker';
import { helperDockerSocket } from '../../src/core/helper/helperImages';
import { NodeProcessRunner } from '../../src/core/process';
import { RemoteShells } from '../../src/core/relay/remoteShells';
import { sshHostTransport } from '../../src/core/relay/transport';
import { sshPromptsAllowed, withSshPrompts } from '../../src/core/sshAskpass';
import { RemoteDockerState } from '../../src/core/storage/remoteDockerState';
import { SshKeyOffer, type SshKeyDialogs } from '../../src/vscode/sshKeyOffer';
import { SshAskpassServer, type SshLoginDialogs } from '../../src/vscode/sshLoginPrompts';
import { TEST_BASE_IMAGE, TEST_RUN_LABEL, removeRunObjects } from './dockerRun';
import { dockerTestContext } from './harness';

const ALIAS = 'devspaces-test-password';
/** The same server, where a key may log in too (ALIAS allows only the password). */
const KEY_ALIAS = 'devspaces-test-key-offer';
const PASSWORD = 'devspaces-test-password-1';
const SSHD_DOCKERFILE_FOLDER = path.resolve(__dirname, 'sshd');

/** True when an SSH server answers on 127.0.0.1:`port` with its banner within 2 seconds. */
function sshBanner(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    const done = (answered: boolean) => {
      socket.destroy();
      resolve(answered);
    };
    socket.setTimeout(2_000, () => done(false));
    socket.once('data', (chunk) => done(chunk.toString('latin1').startsWith('SSH-')));
    socket.once('error', () => done(false));
    socket.once('end', () => done(false));
  });
}

describe('the login without setup: password and host key in VS Code', () => {
  const { run, env: localEnv, cli: localCli, log } = dockerTestContext('sshLogin');
  const runner = new NodeProcessRunner();
  const dir = path.join(run.runDir, 'ssh-login');
  const sshdImage = `devspaces-test-sshd:${run.runId}`;
  const sshdContainer = `devspaces-test-sshd-password-${run.runId}`;
  const env: NodeJS.ProcessEnv = { ...localEnv };
  const knownHosts = path.join(dir, 'known_hosts');
  let sshPath: string;
  let hostKey: string;
  let askpass: SshAskpassServer;
  /** What the fake dialogs were asked, and their answers. */
  const asked: string[] = [];
  const secrets: Array<string | undefined> = [];

  const dialogs: SshLoginDialogs = {
    secret: async (host, prompt, again) => {
      asked.push(`secret ${host}${again ? ' again' : ''}: ${prompt}`);
      return secrets.shift();
    },
    hostKey: async (host, text) => {
      asked.push(`hostKey ${host}: ${text}`);
      return true;
    },
    confirm: async () => false,
    notice: () => undefined,
  };

  /**
   * The shells of a window, whose logins may ask within withSshPrompts (as extension.ts); with `keys`, they use the key
   * of Devspaces for a host that has it, and offer it after a login with a password.
   */
  function shells(keys?: SshKeyOffer): RemoteShells {
    return new RemoteShells({
      logger: log,
      loginTimeoutMs: 30_000,
      start: (host) => {
        const login = sshPromptsAllowed() ? askpass.login(host) : undefined;
        const transport = sshHostTransport(host, sshPath, env, { prompts: login, identity: keys?.identityFor(host) });
        if (transport === undefined) return undefined;
        const process = runner.startBytes(transport.file, transport.args, { env: transport.env });
        if (login !== undefined) void process.exited.then(() => login.dispose());
        return { process, prompts: login, afterLogin: keys !== undefined && login !== undefined ? (shell) => keys.afterLogin(host, login, shell) : undefined };
      },
    });
  }

  beforeAll(async () => {
    fs.mkdirSync(dir, { recursive: true });
    const ssh = findExecutable('ssh', process.env, process.platform);
    if (!ssh) throw new Error('The Docker test of the login needs the OpenSSH client (ssh).');
    localCli.ok(['build', '-q', '--label', `${TEST_RUN_LABEL}=${run.runId}`, '--build-arg', `BASE_IMAGE=${TEST_BASE_IMAGE}`, '-t', sshdImage, SSHD_DOCKERFILE_FOLDER]);
    // Root with a password and no key; the options on the command line of sshd come before those of its config file.
    localCli.ok([
      'run', '-d', '--name', sshdContainer, '--label', `${TEST_RUN_LABEL}=${run.runId}`,
      '-v', `${helperDockerSocket(localEnv, process.platform)}:/var/run/docker.sock`,
      '-p', '127.0.0.1::22',
      sshdImage,
      'sh', '-c', `printf 'root:%s\\n' '${PASSWORD}' | chpasswd && exec /usr/sbin/sshd -D -e -o PasswordAuthentication=yes -o PermitRootLogin=yes`,
    ]);
    const port = Number(localCli.ok(['port', sshdContainer, '22/tcp']).split('\n')[0].split(':').pop());
    expect(port).toBeGreaterThan(0);
    // The fingerprint that the dialog must show: from the container itself.
    const deadline = Date.now() + 30_000;
    for (;;) {
      const result = localCli.run(['exec', sshdContainer, 'ssh-keygen', '-l', '-f', '/etc/ssh/ssh_host_ed25519_key.pub']);
      if (result.code === 0) {
        hostKey = result.out.split(' ')[1];
        break;
      }
      if (Date.now() > deadline) throw new Error(`The host key of the SSH server cannot be read: ${result.err}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    // Only the password: no key of the runner, no agent, and an empty known_hosts of this file.
    const config = path.join(dir, 'ssh_config');
    fs.writeFileSync(
      config,
      [
        `Host ${ALIAS}`, '  HostName 127.0.0.1', `  Port ${port}`, '  User root', '  PubkeyAuthentication no', '  IdentityAgent none',
        '  PreferredAuthentications password', `  UserKnownHostsFile ${knownHosts}`, '  StrictHostKeyChecking ask',
        // No key of the runner (a file that is not there in place of the default files), and no agent.
        `Host ${KEY_ALIAS}`, '  HostName 127.0.0.1', `  Port ${port}`, '  User root', '  IdentityAgent none', `  IdentityFile ${path.join(dir, 'no-key')}`,
        '  PreferredAuthentications publickey,password', `  UserKnownHostsFile ${knownHosts}`, '  StrictHostKeyChecking ask', '',
      ].join('\n'),
    );
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    sshPath = path.join(bin, 'ssh');
    fs.writeFileSync(sshPath, `#!/bin/sh\nexec '${ssh}' -F '${config}' "$@"\n`, { mode: 0o755 });
    askpass = new SshAskpassServer({ folder: path.join(dir, 'askpass'), platform: process.platform, nodePath: process.execPath, base: () => dir, dialogs, logger: log });
    await askpass.prepare();
    // sshd answers: its banner comes on the port.
    while (!(await sshBanner(port))) {
      if (Date.now() > deadline) throw new Error('The SSH server does not start.');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  });

  afterAll(() => {
    askpass?.dispose();
    removeRunObjects(localCli, run.runId);
    expect(localCli.container(sshdContainer)).toBeUndefined();
  });

  it('asks nothing in a login outside of a flow of the user, which fails at once', async () => {
    const started = Date.now();
    const result = await shells().login(ALIAS);
    log.info(`Without a flow of the user: ${JSON.stringify(result)}`);
    expect(result).toMatchObject({ ok: false, timedOut: false });
    expect(asked).toEqual([]);
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it('asks for the host key and the password in a flow of the user, again after a wrong one, then runs docker info on that login', async () => {
    secrets.push('wrong-password', PASSWORD);
    const windowShells = shells();
    const docker = new BootstrapDocker(runner, run.dockerPath, env, log);
    const result = await withSshPrompts(() => testRemoteDockerHost(docker, ALIAS, { runner, sshPath, env, shells: windowShells }, { timeoutMs: 30_000 }));
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, rootless: false });
    expect(asked).toHaveLength(3);
    expect(asked[0]).toContain(`hostKey ${ALIAS}: `);
    expect(asked[0]).toContain(hostKey);
    expect(asked[1]).toMatch(new RegExp(`^secret ${ALIAS}: .*password`, 'i'));
    expect(asked[2]).toMatch(new RegExp(`^secret ${ALIAS} again: .*password`, 'i'));
    // ssh kept the accepted key.
    expect(fs.readFileSync(knownHosts, 'utf8')).toContain('ssh-ed25519');
    // The shell stays open for the next calls: no second login, no question.
    await expect(windowShells.run(ALIAS, 'printf ok')).resolves.toMatchObject({ exitCode: 0, stdout: 'ok' });
    expect(asked).toHaveLength(3);
    windowShells.dispose();
  });

  it('offers the key after the login with the password, and the logins after it need none, also the ssh of the Docker CLI', async () => {
    asked.length = 0;
    secrets.push(PASSWORD);
    const keygen = findExecutable('ssh-keygen', process.env, process.platform);
    if (!keygen) throw new Error('The Docker test of the key offer needs ssh-keygen.');
    const home = path.join(dir, 'home');
    fs.mkdirSync(home, { recursive: true });
    const offered: string[] = [];
    // The offer runs after the login while the calls go on (RemoteShellStart.afterLogin): its end is the last dialog.
    let offerEnded: () => void = () => undefined;
    const ended = new Promise<void>((resolve) => (offerEnded = resolve));
    const keyDialogs: SshKeyDialogs = {
      offer: async (host) => {
        offered.push(`offer ${host}`);
        return 'use';
      },
      installed: (host) => {
        offered.push(`installed ${host}`);
        offerEnded();
      },
      failed: (host, detail) => {
        offered.push(`failed ${host}: ${detail}`);
        offerEnded();
      },
    };
    const keys = new SshKeyOffer({
      home,
      platform: process.platform,
      computerName: 'docker-test',
      wrapperFolder: path.join(dir, 'ssh-wrapper'),
      runner,
      sshPath: () => sshPath,
      sshKeygenPath: () => keygen,
      env,
      state: new RemoteDockerState(path.join(dir, 'remote-docker.json'), log),
      dialogs: keyDialogs,
      logger: log,
    });
    await keys.prepare();
    const first = shells(keys);
    await expect(withSshPrompts(() => first.run(KEY_ALIAS, 'printf one'))).resolves.toMatchObject({ exitCode: 0, stdout: 'one' });
    await ended;
    first.dispose();
    expect(asked.filter((line) => line.startsWith('secret'))).toHaveLength(1);
    expect(offered).toEqual([`offer ${KEY_ALIAS}`, `installed ${KEY_ALIAS}`]);
    expect(localCli.ok(['exec', sshdContainer, 'cat', '/root/.ssh/authorized_keys'])).toMatch(/^ssh-ed25519 \S+ devspaces@docker-test$/);
    // A login outside of a flow of the user asks nothing, and works with the key.
    asked.length = 0;
    const second = shells(keys);
    await expect(second.run(KEY_ALIAS, 'printf two')).resolves.toMatchObject({ exitCode: 0, stdout: 'two' });
    second.dispose();
    expect(asked).toEqual([]);
    // The Docker CLI with ssh://: its `ssh` is the wrapper, with the key.
    const dockerEnv: NodeJS.ProcessEnv = { ...noPromptEnv(localEnv), DOCKER_HOST: `ssh://${KEY_ALIAS}` };
    delete dockerEnv.DOCKER_CONTEXT;
    // The `ssh` of the test (with its config file) first, so that only the key can make the difference.
    putFolderFirstInPath(dockerEnv, process.platform, path.dirname(sshPath));
    keys.dockerSshEnv(KEY_ALIAS, dockerEnv);
    const info = await runner.run(run.dockerPath, ['info', '--format', '{{json .ServerVersion}}'], { env: dockerEnv, timeoutMs: 60_000 });
    expect(info, JSON.stringify(info)).toMatchObject({ exitCode: 0 });
    expect(asked).toEqual([]);
  });

  it('fails the login of a flow of the user whose question was cancelled', async () => {
    asked.length = 0;
    secrets.push(undefined);
    const result = await withSshPrompts(() => shells().login(ALIAS));
    expect(result).toMatchObject({ ok: false });
    // The host key is known now; one question, and none after the cancel.
    expect(asked).toHaveLength(1);
  });
});
