// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import {
  classifyDockerEndpoint,
  describeDockerHost,
  dockerHostField,
  dockerHostOf,
  dockerHostProblem,
  isSshClosedBeforeLogin,
  dockerTargetOf,
  devspacesOfHost,
  isOnDockerHost,
  isDockerContextHostTarget,
  isRootlessEngine,
  isUsableSshAlias,
  parseContextInspect,
  parseSshAddress,
  remoteDockerTarget,
  rootlessSocketPath,
  sameDockerHost,
  sshCommandArgs,
  sshEndpoint,
  sshTargetOf,
  unsupportedTargetReason,
  RUNTIME_DIR_COMMAND,
  WSL_HOST,
  hostAccessOf,
  hostEndpoint,
  parseWslList,
  wslCommandArgs,
  wslDistributionOf,
  wslEnv,
} from './dockerHost';

describe('classifyDockerEndpoint (SSH only for another computer)', () => {
  it.each([
    ['', 'local'],
    ['unix:///var/run/docker.sock', 'local'],
    ['unix:///run/user/1000/docker.sock', 'local'],
    ['unix:///Users/me/.docker/run/docker.sock', 'local'],
    ['npipe:////./pipe/docker_engine', 'local'],
    ['npipe:////./pipe/dockerDesktopLinuxEngine', 'local'],
    ['tcp://localhost:2375', 'local'],
    ['tcp://127.0.0.1:2376', 'local'],
    ['tcp://[::1]:2375', 'local'],
  ])('%s is the local Docker', (endpoint, kind) => {
    expect(classifyDockerEndpoint(endpoint)).toEqual({ kind, host: '' });
  });

  it.each([
    ['ssh://build-box', 'build-box'],
    ['ssh://me@build-box', 'me@build-box'],
    ['ssh://me@192.0.2.10:2222', 'me@192.0.2.10:2222'],
    ['ssh://me@[2001:db8::1]:22', 'me@[2001:db8::1]:22'],
    ['SSH://build-box/', 'build-box'],
  ])('%s is the remote host %s', (endpoint, host) => {
    expect(classifyDockerEndpoint(endpoint)).toEqual({ kind: 'remote', host });
  });

  it.each(['tcp://build-box:2376', 'tcp://192.0.2.10:2375', 'https://docker.example.com', 'fd://', 'build-box', 'ssh://'])(
    '%s is refused (not SSH, not local)',
    (endpoint) => {
      expect(classifyDockerEndpoint(endpoint)).toEqual({ kind: 'unsupported', host: endpoint });
    },
  );

  it('keeps the context name only when a context decides the endpoint', () => {
    expect(dockerTargetOf('unix:///var/run/docker.sock', 'default')).toEqual({ kind: 'local', host: '', endpoint: 'unix:///var/run/docker.sock', context: 'default' });
    expect(dockerTargetOf('unix:///var/run/docker.sock', undefined)).toEqual({ kind: 'local', host: '', endpoint: 'unix:///var/run/docker.sock' });
  });

  // Devspaces reaches a remote host only through its own list, never through a Docker context or DOCKER_HOST of the user.
  it('does not support a Docker context or DOCKER_HOST of the user that reaches a host over SSH, and names the host', () => {
    const named = dockerTargetOf('ssh://me@box', 'box');
    expect(named).toEqual({ kind: 'unsupported', host: 'ssh://me@box', endpoint: 'ssh://me@box', context: 'box', sshHost: 'me@box' });
    expect(isDockerContextHostTarget(named)).toBe(true);
    expect(unsupportedTargetReason(named)).toBe('The current Docker context box reaches me@box over SSH, which is not a host of the list of Devspaces.');
    const variable = dockerTargetOf('ssh://box', undefined);
    expect(variable).toEqual({ kind: 'unsupported', host: 'ssh://box', endpoint: 'ssh://box', sshHost: 'box' });
    expect(unsupportedTargetReason(variable)).toBe('DOCKER_HOST reaches box over SSH, which is not a host of the list of Devspaces.');
    const tcp = dockerTargetOf('tcp://192.0.2.10:2376', 'other');
    expect(isDockerContextHostTarget(tcp)).toBe(false);
    expect(unsupportedTargetReason(tcp)).toBe('The Docker endpoint tcp://192.0.2.10:2376 is neither local nor SSH.');
    expect(isDockerContextHostTarget(dockerTargetOf('unix:///var/run/docker.sock', 'default'))).toBe(false);
  });

  it('gives a host of the list of Devspaces its Docker over SSH, without a context', () => {
    expect(remoteDockerTarget('me@192.0.2.10:2222')).toEqual({ kind: 'remote', host: 'me@192.0.2.10:2222', endpoint: 'ssh://me@192.0.2.10:2222' });
    expect(isDockerContextHostTarget(remoteDockerTarget('box'))).toBe(false);
  });
});

describe('parseContextInspect', () => {
  it('reads the name and the Docker endpoint of `docker context inspect --format {{json .}}`', () => {
    const stdout = JSON.stringify({
      Name: 'devspaces-remote-26f8567f',
      Metadata: { Description: 'x' },
      Endpoints: { docker: { Host: 'ssh://build-box', SkipTLSVerify: false } },
    });
    expect(parseContextInspect(`${stdout}\n`)).toEqual({ name: 'devspaces-remote-26f8567f', endpoint: 'ssh://build-box' });
  });

  it('reads the first entry of a list, and gives an empty endpoint when none is set', () => {
    expect(parseContextInspect(JSON.stringify([{ Name: 'default', Endpoints: {} }]))).toEqual({ name: 'default', endpoint: '' });
  });

  it.each(['', 'not json', '{}', '[]', 'null', '{"Name": 3}'])('refuses %j', (stdout) => {
    expect(parseContextInspect(stdout)).toBeUndefined();
  });
});

// The contexts are named after the SSH host and recognised as ours by their description.
describe('the Docker host of devspaces (registry filter)', () => {
  const local = { id: 'a', dockerHost: undefined };
  const box = { id: 'b', dockerHost: 'build-box' };
  const boxAddress = { id: 'c', dockerHost: 'me@build-box' };

  it('a missing field is the local Docker (greenfield, no migration)', () => {
    expect(dockerHostOf(local)).toBe('');
    expect(isOnDockerHost(local, '')).toBe(true);
    expect(isOnDockerHost(local, 'build-box')).toBe(false);
  });

  it('shows only the devspaces of the current host; two names of one computer are two hosts', () => {
    const all = [local, box, boxAddress];
    expect(devspacesOfHost(all, '')).toEqual([local]);
    expect(devspacesOfHost(all, 'build-box')).toEqual([box]);
    expect(devspacesOfHost(all, 'me@build-box')).toEqual([boxAddress]);
    expect(devspacesOfHost(all, 'other')).toEqual([]);
    expect(sameDockerHost(undefined, '')).toBe(true);
    expect(sameDockerHost('build-box', 'Build-Box')).toBe(false);
  });

  it('a new local devspace gets no field; a remote one its host', () => {
    expect(dockerHostField('')).toEqual({});
    expect(dockerHostField('build-box')).toEqual({ dockerHost: 'build-box' });
    expect(describeDockerHost('')).toBe('the local Docker');
    expect(describeDockerHost('build-box')).toBe('build-box');
  });
});

describe('parseSshAddress (Enter an SSH address…)', () => {
  it.each([
    ['me@build-box', 'me@build-box', { user: 'me', host: 'build-box' }],
    ['build-box.example.com', 'build-box.example.com', { host: 'build-box.example.com' }],
    ['  me@192.0.2.10:2222  ', 'me@192.0.2.10:2222', { user: 'me', host: '192.0.2.10', port: 2222 }],
    ['me@[2001:db8::1]:22', 'me@[2001:db8::1]:22', { user: 'me', host: '2001:db8::1', port: 22 }],
    ['[::1]', '[::1]', { host: '::1' }],
    ['ssh://me@build-box', 'me@build-box', { user: 'me', host: 'build-box' }],
    ['first.last@box', 'first.last@box', { user: 'first.last', host: 'box' }],
  ])('accepts %j as %s', (text, address, parts) => {
    expect(parseSshAddress(text)).toEqual({ ok: true, address, parts });
  });

  it.each([
    ['', 'empty'],
    ['me@build box', 'spaces'],
    ['-oProxyCommand=evil', 'option'],
    ['me@box/path', 'path'],
    ['me@box?x=1', 'path'],
    ['me@box#frag', 'path'],
    ['-l@box', 'option'],
    ['me;rm@box', 'user'],
    ['me:pw@box', 'user'],
    ['me@-box', 'host'],
    ['me@bo$x', 'host'],
    ['me@box:0', 'port'],
    ['me@box:65536', 'port'],
    ['me@box:22x', 'port'],
    ['me@2001:db8::1', 'ipv6'],
    ['me@[2001:db8::1', 'ipv6'],
    ['me@[box]', 'ipv6'],
    ['me@[::1]x', 'port'],
  ])('refuses %j (%s)', (text, problem) => {
    expect(parseSshAddress(text)).toEqual({ ok: false, problem });
  });
});

describe('SSH aliases and the ssh command line', () => {
  it.each(['build-box', 'box_1', 'my.box', 'Box'])('offers the alias %s', (alias) => {
    expect(isUsableSshAlias(alias)).toBe(true);
  });

  it.each(['-oProxyCommand=x', 'a b', 'a;b', '$(x)', '', 'a/b', 'a@b'])('does not offer %j', (alias) => {
    expect(isUsableSshAlias(alias)).toBe(false);
  });

  it('builds a non-interactive ssh call with the destination after --', () => {
    expect(sshCommandArgs({ host: 'build-box' }, RUNTIME_DIR_COMMAND)).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=15',
      '-T',
      '--',
      'build-box',
      'printf %s "$XDG_RUNTIME_DIR"',
    ]);
    expect(sshCommandArgs({ user: 'me', host: '2001:db8::1', port: 2222 }, 'true', 5)).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=5',
      '-T',
      '-p',
      '2222',
      '-l',
      'me',
      '--',
      '2001:db8::1',
      'true',
    ]);
  });

  it('gives the key of Devspaces with -i before the destination, and only that key for the check of the key offer', () => {
    const key = '/home/ann/.ssh/devspaces_ed25519';
    expect(sshCommandArgs({ host: 'box', port: 2222 }, 'true', 15, { identity: key })).toEqual([
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-T', '-i', key, '-p', '2222', '--', 'box', 'true',
    ]);
    expect(sshCommandArgs({ host: 'box' }, 'sh -s', 15, { prompts: true, identity: key })).toEqual(['-x', '-o', 'ConnectTimeout=15', '-T', '-i', key, '--', 'box', 'sh -s']);
    expect(sshCommandArgs({ host: 'box' }, 'true', 15, { identity: key, identityOnly: true })).toEqual([
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-T', '-i', key, '-o', 'IdentitiesOnly=yes', '-o', 'PreferredAuthentications=publickey',
      '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '--', 'box', 'true',
    ]);
    // Without a key, identityOnly changes nothing.
    expect(sshCommandArgs({ host: 'box' }, 'true', 15, { identityOnly: true })).toEqual(sshCommandArgs({ host: 'box' }, 'true'));
  });

  it('parses a recorded host back into its parts, and refuses anything else', () => {
    expect(sshTargetOf('build-box')).toEqual({ host: 'build-box' });
    expect(sshTargetOf('me@box:2222')).toEqual({ user: 'me', host: 'box', port: 2222 });
    expect(sshTargetOf('me@box/run/docker.sock')).toBeUndefined();
    expect(sshTargetOf('-oProxyCommand=x')).toBeUndefined();
    expect(sshEndpoint('me@box:2222')).toBe('ssh://me@box:2222');
  });
});

describe('rootless Docker on the remote computer', () => {
  it('detects name=rootless in the security options of docker info', () => {
    expect(isRootlessEngine(['name=seccomp,profile=builtin', 'name=rootless', 'name=cgroupns'])).toBe(true);
    expect(isRootlessEngine(['name=seccomp,profile=builtin', 'name=cgroupns'])).toBe(false);
    expect(isRootlessEngine(null)).toBe(false);
    expect(isRootlessEngine('name=rootless')).toBe(false);
  });

  it('places the socket in the runtime folder of the user', () => {
    expect(rootlessSocketPath('/run/user/1000')).toBe('/run/user/1000/docker.sock');
    expect(rootlessSocketPath('/run/user/1000/\n')).toBe('/run/user/1000/docker.sock');
    expect(rootlessSocketPath('')).toBeUndefined();
    expect(rootlessSocketPath('relative/dir')).toBeUndefined();
    expect(rootlessSocketPath('/run/user/../etc')).toBeUndefined();
    expect(rootlessSocketPath('/run/user/1000;rm')).toBeUndefined();
  });
});

describe('the WSL distribution of Devspaces as a host', () => {
  it('names the distribution in its host, which is never an SSH alias or address', () => {
    expect(WSL_HOST).toBe('wsl:devspaces');
    expect(wslDistributionOf(WSL_HOST)).toBe('devspaces');
    expect(wslDistributionOf('wsl:Ubuntu-24.04')).toBe('Ubuntu-24.04');
    for (const host of ['wsl:', 'wsl:-d', 'wsl:a b', 'wsl:x/y', 'wsl:x;y', `wsl:${'a'.repeat(65)}`, 'devspaces', 'ssh://wsl:devspaces', 'WSL:devspaces']) {
      expect(wslDistributionOf(host), host).toBeUndefined();
    }
    expect(sshTargetOf(WSL_HOST)).toBeUndefined();
    expect(parseSshAddress(WSL_HOST).ok).toBe(false);
  });

  it('reaches an SSH host over SSH and the distribution through wsl.exe; any other host has no transport', () => {
    expect(hostAccessOf(WSL_HOST)).toEqual({ kind: 'wsl', distribution: 'devspaces' });
    expect(hostAccessOf('me@box:2222')).toEqual({ kind: 'ssh', address: { user: 'me', host: 'box', port: 2222 } });
    expect(hostAccessOf('build-box')).toEqual({ kind: 'ssh', address: { host: 'build-box' } });
    expect(hostAccessOf('box/path')).toBeUndefined();
    expect(hostAccessOf('wsl:-x')).toBeUndefined();
    // An SSH address stays an SSH host: the host `wsl` with the port 2222.
    expect(wslDistributionOf('wsl:2222')).toBeUndefined();
    expect(hostAccessOf('wsl:2222')).toEqual({ kind: 'ssh', address: { host: 'wsl', port: 2222 } });
  });

  it('gives its target the endpoint wsl://<distribution>, and an SSH host ssh://<host>', () => {
    expect(remoteDockerTarget(WSL_HOST)).toEqual({ kind: 'remote', host: WSL_HOST, endpoint: 'wsl://devspaces' });
    expect(hostEndpoint('build-box')).toBe('ssh://build-box');
  });

  it('runs a command as root in the root folder without a shell of the distribution, with the messages of wsl.exe in UTF-8', () => {
    expect(wslCommandArgs('devspaces', ['sh', '-s'])).toEqual(['-d', 'devspaces', '-u', 'root', '--cd', '/', '--exec', 'sh', '-s']);
    const base = { PATH: 'C:\\Windows\\System32', wsl_utf8: '0' };
    expect(wslEnv(base)).toEqual({ PATH: 'C:\\Windows\\System32', WSL_UTF8: '1' });
    expect(base).toEqual({ PATH: 'C:\\Windows\\System32', wsl_utf8: '0' });
  });

  it('reads the names of `wsl.exe --list --quiet`, also as UTF-16 of an older wsl.exe', () => {
    expect(parseWslList('Ubuntu\r\ndevspaces\r\n\r\n')).toEqual(['Ubuntu', 'devspaces']);
    const utf16 = Buffer.from('\uFEFFUbuntu\r\ndevspaces\r\n', 'utf16le').toString('utf8');
    expect(parseWslList(utf16)).toEqual(['Ubuntu', 'devspaces']);
    expect(parseWslList('')).toEqual([]);
  });
});

describe('dockerHostProblem (plain reasons of a failed connection)', () => {
  it.each([
    ['error during connect: ssh: Could not resolve hostname build-box: Name or service not known', 'unreachable'],
    ['ssh: connect to host 192.0.2.10 port 22: Connection timed out', 'unreachable'],
    ['ssh: connect to host box port 22: Connection refused', 'unreachable'],
    ['docker info did not answer within 45 seconds.', 'unreachable'],
    ['me@box: Permission denied (publickey,password).', 'login'],
    ['Host key verification failed.', 'hostKey'],
    ['No ED25519 host key is known for box and you have requested strict checking.\r\nHost key verification failed.', 'hostKey'],
    ['bash: line 1: docker: command not found', 'dockerMissing'],
    ['sh: 1: docker: not found', 'dockerMissing'],
    ['zsh:1: command not found: docker', 'dockerMissing'],
    ['Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?', 'dockerNotRunning'],
    [
      'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.47/info": dial unix /var/run/docker.sock: connect: permission denied',
      'dockerPermission',
    ],
    ['error during connect: exec: "ssh": executable file not found in $PATH', 'sshMissing'],
    // sshd dropped the connection before the login (MaxStartups, PerSourcePenalties): OpenSSH 9.6 and older clients.
    [
      'error during connect: Get "http://docker.example.com/v1.48/info": command [ssh -o ConnectTimeout=30 -T -- box docker system dial-stdio] has exited with exit status 255, make sure the URL is valid, and Docker 18.09 or later is installed on the remote host: stderr=Connection closed by 127.0.0.1 port 32771\r\n',
      'closedBeforeLogin',
    ],
    ['kex_exchange_identification: Connection closed by remote host\r\nConnection closed by 192.0.2.10 port 22', 'closedBeforeLogin'],
    ['kex_exchange_identification: read: Connection reset by peer\r\nConnection reset by 192.0.2.10 port 22', 'closedBeforeLogin'],
    // wsl.exe for a distribution that is not registered (WSL 2.x, and the older text).
    ['There is no distribution with the supplied name.\r\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND', 'wslDistributionMissing'],
    ['There is no distribution with the supplied name.', 'wslDistributionMissing'],
    // The UTF-16 text of an older wsl.exe, read as UTF-8.
    [Buffer.from('There is no distribution with the supplied name.', 'utf16le').toString('utf8'), 'wslDistributionMissing'],
    ['something else', 'unknown'],
  ])('%s → %s', (detail, problem) => {
    expect(dockerHostProblem(detail)).toBe(problem);
  });
});

describe('isSshClosedBeforeLogin', () => {
  it('is true only when ssh said nothing but the closed connection', () => {
    expect(isSshClosedBeforeLogin('Connection closed by 127.0.0.1 port 32771')).toBe(true);
    expect(isSshClosedBeforeLogin('… installed on the remote host: stderr=Connection closed by 127.0.0.1 port 32771\r\n\n')).toBe(true);
    expect(isSshClosedBeforeLogin('')).toBe(false);
    expect(isSshClosedBeforeLogin('kex_exchange_identification: Connection closed by remote host')).toBe(false);
    expect(isSshClosedBeforeLogin('root@box: Permission denied (publickey).\r\nConnection closed by 127.0.0.1 port 22')).toBe(false);
    expect(isSshClosedBeforeLogin('Connection to box closed by remote host.')).toBe(false);
    expect(isSshClosedBeforeLogin('ssh: connect to host box port 22: Connection refused')).toBe(false);
  });
});
