// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Prepares the Docker engine of this computer and the test VS Code for the attach tests (configuration `attach` of
// .vscode-test.mjs), and writes what it made to out/test/vscode/attach/seed.json (npm run test:vscode:attach:prepare).
// It uses the real Docker engine, where the extension then creates its own objects (Monitor, workers, volumes) with the
// names of a real installation, so it runs only on CI, on a runner of its own.
// - The test VS Code (downloaded to .vscode-test/ as @vscode/test-cli does) trusts the Devspaces extension with the
//   sessions of the sign-in provider `github` (trustedExtensionAuthAccess in its product.json), so that the
//   extension gets the session of the fake provider (test/vscode/github) without the dialog that asks for access.
// - The workspace helper image, built as the extension builds it, so that the restore of the registry at activation
//   (passive: it builds no image) finds the devspace.
// - A devspace without container: its workspace volume with the labels of the extension (the test account owns it)
//   and a repository with a devcontainer.json. VS Code starts with a fresh user data folder, so the registry of the
//   extension is empty, and the window restores the devspace from the volume labels, as on a new computer. The
//   configuration sets the old key "remote.containers.copyGitConfig": true, a postAttachCommand that writes the time
//   of each attach, and a postStartCommand that waits LONG_START_SECONDS once when the mark LONG_START_MARK exists
//   (the run `longopen`).
// - A plain container that is no devspace, of the same dev image (with Git and the Docker CLI, so that Dev Containers
//   configures its credential helpers there).
// With DEVSPACE_TEST_ATTACH_PREPARE=remote (the run `remote`, a CI job of its own), the devspace is on the Docker engine
// of another computer instead, reached over SSH, and the engine of the runner gets a container with its name
// (prepareRemote). That run has no plain container.
// With DEVSPACE_TEST_ATTACH_PREPARE=update (the runs `previous` and `updated`, a CI job of its own), the test VS Code
// also gets the last released version of the extension from the VSIX of its GitHub release, and the helper image is
// built as that version builds it (prepareUpdate). That run has no plain container.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as childProcess from 'child_process';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from '@vscode/test-electron';
import { BootstrapDocker } from '../../../src/core/docker/bootstrapDocker';
import { findDockerCli } from '../../../src/core/docker/dockerCli';
import { ensureRemoteContext, useContext } from '../../../src/core/docker/remoteDocker';
import { DEVCONTAINER_CLI_VERSION, helperImageTag } from '../../../src/core/helper/helperImage';
import { HelperImages } from '../../../src/core/helper/helperImages';
import { LABEL_DEVSPACE_ID, LABEL_HELPER, LABEL_OWNER_ID, LABEL_REPOSITORY, WORKSPACES_ROOT, newDevspaceId, repositoryFolder, resourceName } from '../../../src/core/names';
import type { Logger } from '../../../src/core/ports';
import { NodeProcessRunner } from '../../../src/core/process';
import { dockerPipeAddress, dockerPipeBase, dockerPipeId } from '../../../src/core/relay/pipeAddress';
import { newComputerId } from '../../../src/core/storage/computerId';
import { folderUriParts, type WindowDocker } from '../../../src/vscode/connection/authority';
import { answerAttachQuestion } from '../../../scripts/attachQuestion.mjs';

/** The checkout: the bundle runs from out/test/vscode/attach/. */
const ROOT = path.resolve(__dirname, '../../../..');
const EXTENSION_ID = 'nimblescape.nimblescape-devspaces-2';
/** The account of the fake sign-in provider (test/vscode/github/extension.js). */
const TEST_ACCOUNT_ID = '4242';
const REPOSITORY = 'devspaces-test/attach';
/** A glibc image with a user `node`: the Dev Containers extension installs its server there. */
const BASE_IMAGE = 'mirror.gcr.io/library/node:24-trixie-slim';
/**
 * The dev image of the devspace and of the plain container: the base image with Git and the Docker CLI, so that Dev
 * Containers configures its credential helpers of Git and Docker where its settings allow them.
 */
const DOCKERFILE = `FROM ${BASE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends docker-cli git && rm -rf /var/lib/apt/lists/*
`;
const PLAIN_IMAGE = 'devspaces-attach-test-plain:1';
/**
 * The run `longopen`: a start of the devspace container that takes several minutes. The CI job writes the mark (as
 * the remote user) and stops the container; postStartCommand removes the mark, so it waits once, and writes when it
 * began and ended.
 */
const LONG_START_SECONDS = 150;
const LONG_START_MARK = '/tmp/devspaces-test-long-start';
const POST_START_COMMAND = `if [ -f ${LONG_START_MARK} ]; then rm -f ${LONG_START_MARK}; date +%s > /tmp/long-start-began; sleep ${LONG_START_SECONDS}; date +%s > /tmp/long-start-ended; fi`;

/**
 * The run `remote`: the other computer is a container of the runner with a Docker engine of its own (Docker in Docker,
 * its data in a volume of the runner, where its storage driver works) and an SSH server for root with key
 * authentication. MaxStartups, MaxSessions and PerSourcePenalties are set as in test/docker/sshd/Dockerfile, because the
 * Docker CLI opens a new SSH connection for each call (OpenSSH of docker:28-dind knows PerSourcePenalties). The host
 * REMOTE_HOST of the SSH config of the runner points to it. sshd logs each login (LogLevel VERBOSE), and its
 * ForceCommand REMOTE_HOST_SESSION writes the command of each session into the log of the container before it runs it as
 * sshd would, so that remote.test.ts can count the SSH logins of the open.
 */
const REMOTE_HOST = 'devspaces-test-remote';
const REMOTE_HOST_IMAGE = 'devspaces-attach-test-remote:2';
const REMOTE_HOST_CONTAINER = 'attach-test-remote-host';
const REMOTE_HOST_DOCKER_VOLUME = 'attach-test-remote-docker';
/** The ForceCommand of sshd on the other computer (REMOTE_HOST_START writes it). */
const REMOTE_HOST_SESSION = '/usr/local/bin/devspaces-test-session';
const REMOTE_HOST_DOCKERFILE = `FROM mirror.gcr.io/library/docker:28-dind
RUN apk add --no-cache openssh-server \\
 && ssh-keygen -A \\
 && sed -i 's/^root:[^:]*:/root:*:/' /etc/shadow \\
 && printf '%s\\n' 'PermitRootLogin prohibit-password' 'PasswordAuthentication no' 'KbdInteractiveAuthentication no' 'PubkeyAuthentication yes' 'LogLevel VERBOSE' 'MaxStartups 100:30:200' 'MaxSessions 100' 'ForceCommand ${REMOTE_HOST_SESSION}' >> /etc/ssh/sshd_config \\
 && if /usr/sbin/sshd -t -o PerSourcePenalties=no; then echo 'PerSourcePenalties no' >> /etc/ssh/sshd_config; fi \\
 && /usr/sbin/sshd -t
`;
/**
 * The start of the other computer: the public key of the runner for root, the ForceCommand REMOTE_HOST_SESSION, sshd,
 * and the Docker engine (unix socket only). REMOTE_HOST_SESSION writes `devspaces-test-ssh: <command>` (`(shell)` for a
 * session without a command) to the standard error of the first process of the container, which `docker logs
 * --timestamps` shows with its time, and then runs the command with `sh -c`, as sshd runs it with the shell of root.
 */
const REMOTE_HOST_START = `set -eu
mkdir -p /root/.ssh
printf '%s\\n' "$AUTHORIZED_KEY" > /root/.ssh/authorized_keys
chmod 700 /root/.ssh
chmod 600 /root/.ssh/authorized_keys
cat > ${REMOTE_HOST_SESSION} <<'SESSION'
#!/bin/sh
printf 'devspaces-test-ssh: %s\\n' "\${SSH_ORIGINAL_COMMAND:-(shell)}" >> /proc/1/fd/2 2>/dev/null || true
if [ -n "\${SSH_ORIGINAL_COMMAND:-}" ]; then exec /bin/sh -c "$SSH_ORIGINAL_COMMAND"; fi
exec /bin/sh -l
SESSION
chmod 755 ${REMOTE_HOST_SESSION}
/usr/sbin/sshd -D -e &
exec dockerd-entrypoint.sh dockerd --host=unix:///var/run/docker.sock
`;
/** The longest wait for the Docker engine of the other computer to answer over SSH. */
const REMOTE_ENGINE_WAIT_MS = 120_000;

const log: Logger = {
  info: (message) => console.log(`INFO  ${message}`),
  warn: (message) => console.log(`WARN  ${message}`),
  error: (message, error) => console.log(`ERROR ${message}${error === undefined ? '' : `: ${String(error)}`}`),
  output: (text) => process.stdout.write(text),
};

const SEED_SCRIPT = `set -eu
mkdir -p "$1/.devcontainer"
printf '%s\\n' "$2" > "$1/.devcontainer/devcontainer.json"
printf '%s' "$3" > "$1/.devcontainer/Dockerfile"
printf '# Attach test\\n' > "$1/README.md"
cd "$1"
git init -q -b main
git add -A
git -c user.name=Test -c user.email=test@example.invalid commit -q -m 'Initial commit'
`;

/**
 * trustedExtensionAuthAccess of the product.json of the test VS Code names the extension for `github`. Dev Containers
 * is installed into the extensions folder of @vscode/test-cli (which then does not install it again), without its
 * attach question (scripts/attachQuestion.mjs). Returns the command line of the test VS Code.
 */
async function trustExtension(): Promise<TestVscode> {
  const executable = await downloadAndUnzipVSCode(process.env.VSCODE_TEST_VERSION || 'stable');
  const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(executable);
  const install = childProcess.spawnSync(cli, [...cliArgs, '--install-extension', 'ms-vscode-remote.remote-containers'], { encoding: 'utf8' });
  log.info(`Dev Containers: exit code ${install.status}\n${install.stdout}${install.stderr}`);
  const extensionsDir = cliArgs.find((arg) => arg.startsWith('--extensions-dir='))?.slice('--extensions-dir='.length);
  if (!extensionsDir) throw new Error(`No extensions folder in ${cliArgs.join(' ')}.`);
  for (const line of answerAttachQuestion(extensionsDir)) log.info(line);
  const productJson = path.join(path.dirname(executable), 'resources', 'app', 'product.json');
  const product = JSON.parse(fs.readFileSync(productJson, 'utf8')) as { quality?: string; trustedExtensionAuthAccess?: string[] | Record<string, string[]> };
  const { version } = JSON.parse(fs.readFileSync(path.join(path.dirname(productJson), 'package.json'), 'utf8')) as { version: string };
  log.info(`VS Code ${version} (${product.quality ?? 'no quality'}) in ${path.dirname(executable)}.`);
  const trusted = product.trustedExtensionAuthAccess;
  if (Array.isArray(trusted)) trusted.push(EXTENSION_ID);
  else product.trustedExtensionAuthAccess = { ...trusted, github: [...(trusted?.github ?? []), EXTENSION_ID] };
  fs.writeFileSync(productJson, JSON.stringify(product, null, '\t'));
  log.info(`${productJson}: trustedExtensionAuthAccess ${JSON.stringify(product.trustedExtensionAuthAccess)}`);
  return { cli, cliArgs, extensionsDir };
}

/** The command line of the test VS Code (with its extensions folder and user data folder) and its extensions folder. */
interface TestVscode {
  cli: string;
  cliArgs: string[];
  extensionsDir: string;
}

function folderUri(containerName: string, folder: string, docker?: WindowDocker): string {
  const parts = folderUriParts(containerName, folder, docker);
  return `${parts.scheme}://${parts.authority}${parts.path}`;
}

/**
 * A devspace without container on the engine of `docker`: its workspace volume with the labels of the extension (the
 * test account owns it) and a repository with a devcontainer.json, written by a container of the helper image.
 */
async function seedDevspace(docker: BootstrapDocker, helperTag: string): Promise<{ devspaceId: string; name: string; folder: string }> {
  const devspaceId = newDevspaceId();
  const name = resourceName(REPOSITORY, devspaceId);
  const folder = repositoryFolder(REPOSITORY);
  await docker.runChecked(['volume', 'create', '--label', `${LABEL_DEVSPACE_ID}=${devspaceId}`, '--label', `${LABEL_REPOSITORY}=${REPOSITORY}`, '--label', `${LABEL_OWNER_ID}=${TEST_ACCOUNT_ID}`, name]);
  const devcontainerJson = JSON.stringify(
    {
      name: 'Attach test',
      build: { dockerfile: 'Dockerfile' },
      remoteUser: 'node',
      postStartCommand: POST_START_COMMAND,
      postAttachCommand: 'date +%s >> /tmp/attach-count',
      customizations: { vscode: { settings: { 'remote.containers.copyGitConfig': true } } },
    },
    null,
    2,
  );
  await docker.runChecked(['run', '--rm', '--pull', 'never', '--network', 'none', '--mount', `type=volume,source=${name},target=${WORKSPACES_ROOT}`, '--entrypoint', 'sh', helperTag, '-c', SEED_SCRIPT, 'sh', folder, devcontainerJson, DOCKERFILE]);
  return { devspaceId, name, folder };
}

/** The helper image on the engine of `docker`, built as the extension builds it. */
async function helperImage(docker: BootstrapDocker, started: number): Promise<string> {
  const helper = await new HelperImages({ docker, logger: log, dockerfilePath: path.join(ROOT, 'resources', 'helper', 'Dockerfile') }).ensureImageUse();
  log.info(`Helper image ${helper.tag} (${((Date.now() - started) / 1000).toFixed(0)} s since the start).`);
  return helper.tag;
}

/** The runs on the engine of the runner: the devspace and the plain container. */
async function prepareLocal(docker: BootstrapDocker, started: number): Promise<Record<string, unknown>> {
  const { devspaceId, name, folder } = await seedDevspace(docker, await helperImage(docker, started));
  // The plain container has the dev image, built here; the build of the devspace finds its layers in the cache.
  await docker.runChecked(['build', '-t', PLAIN_IMAGE, '-'], { input: DOCKERFILE, timeoutMs: 300_000 });
  const plain = `attach-test-plain-${crypto.randomBytes(3).toString('hex')}`;
  await docker.runChecked(['run', '-d', '--name', plain, PLAIN_IMAGE, 'sleep', 'infinity']);
  return {
    devspace: { containerName: name, folder, folderUri: folderUri(name, folder), user: 'node', devspaceId, longStartSeconds: LONG_START_SECONDS, longStartMark: LONG_START_MARK },
    plain: { containerName: plain, folder: '/tmp', folderUri: folderUri(plain, '/tmp'), user: 'root' },
  };
}

/**
 * The run `remote`: the other computer (REMOTE_HOST_DOCKERFILE) with the host REMOTE_HOST in the SSH config of the runner
 * (its own key and known_hosts file in ~/.ssh), the Docker context of that host as the extension makes it
 * (ensureRemoteContext), the helper image and the devspace on its engine, and on the engine of the runner a container
 * with the name of the devspace container. The context of the host becomes the current context last, as after "Use a
 * Remote Docker Host…": every Docker call of the runner without a context goes to the other computer from then on.
 */
async function prepareRemote(local: BootstrapDocker, dockerPath: string, started: number): Promise<Record<string, unknown>> {
  await local.runChecked(['build', '-t', REMOTE_HOST_IMAGE, '-'], { input: REMOTE_HOST_DOCKERFILE, timeoutMs: 300_000 });
  const sshFolder = path.join(os.homedir(), '.ssh');
  fs.mkdirSync(sshFolder, { recursive: true, mode: 0o700 });
  const key = path.join(sshFolder, REMOTE_HOST);
  for (const file of [key, `${key}.pub`]) fs.rmSync(file, { force: true });
  childProcess.execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', REMOTE_HOST, '-f', key]);
  const publicKey = fs.readFileSync(`${key}.pub`, 'utf8').trim();
  await local.runChecked([
    'run', '-d', '--name', REMOTE_HOST_CONTAINER, '--privileged', '--init', '-p', '127.0.0.1::22',
    '-e', 'DOCKER_TLS_CERTDIR=', '-e', `AUTHORIZED_KEY=${publicKey}`,
    '--mount', `type=volume,source=${REMOTE_HOST_DOCKER_VOLUME},target=/var/lib/docker`,
    '--entrypoint', 'sh', REMOTE_HOST_IMAGE, '-c', REMOTE_HOST_START,
  ]);
  const port = Number((await local.runChecked(['port', REMOTE_HOST_CONTAINER, '22/tcp'])).trim().split('\n')[0].split(':').pop());
  if (!Number.isInteger(port) || port <= 0) throw new Error(`The SSH port of ${REMOTE_HOST_CONTAINER} was not found.`);
  const hostKey = (await local.runChecked(['exec', REMOTE_HOST_CONTAINER, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub'])).trim().split(' ').slice(0, 2).join(' ');
  const knownHosts = path.join(sshFolder, `${REMOTE_HOST}.known_hosts`);
  fs.writeFileSync(knownHosts, `[127.0.0.1]:${port} ${hostKey}\n`, { mode: 0o600 });
  const config = path.join(sshFolder, 'config');
  const entry = [`Host ${REMOTE_HOST}`, '  HostName 127.0.0.1', `  Port ${port}`, '  User root', `  IdentityFile ${key}`, '  IdentitiesOnly yes', '  StrictHostKeyChecking yes', `  UserKnownHostsFile ${knownHosts}`];
  // ssh takes the first value of each option, so the entry comes first (before a `Host *` of the runner), and the entry
  // of an earlier preparation on this runner is removed from the rest.
  const rest = fs.existsSync(config) ? fs.readFileSync(config, 'utf8').replace(new RegExp(`^Host ${REMOTE_HOST}\\n(?:[ \\t]+.*(?:\\n|$))*`, 'gm'), '').trim() : '';
  fs.writeFileSync(config, `${entry.join('\n')}\n${rest === '' ? '' : `\n${rest}\n`}`, { mode: 0o600 });
  fs.chmodSync(config, 0o600);
  log.info(`${config}: ${entry.join('; ')}`);

  const context = await ensureRemoteContext(local, REMOTE_HOST);
  const remote = new BootstrapDocker(new NodeProcessRunner(), dockerPath, { ...process.env, DOCKER_CONTEXT: context }, log);
  for (const deadline = Date.now() + REMOTE_ENGINE_WAIT_MS; ; ) {
    const info = await remote.run(['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 30_000 });
    if (info.exitCode === 0) {
      log.info(`The Docker engine ${info.stdout.trim()} of ${REMOTE_HOST} answers through the context ${context}.`);
      break;
    }
    if (Date.now() > deadline) throw new Error(`The Docker engine of ${REMOTE_HOST} does not answer: ${(info.stderr || info.stdout).trim()}`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  const { devspaceId, name, folder } = await seedDevspace(remote, await helperImage(remote, started));
  await local.runChecked(['run', '-d', '--name', name, '--entrypoint', 'sh', REMOTE_HOST_IMAGE, '-c', 'exec tail -f /dev/null']);
  await useContext(local, context);
  log.info(`The current Docker context is ${context}.`);
  // After the last SSH login of the preparation: remote.test.ts counts the logins from this time.
  const preparedAt = new Date().toISOString();
  // The window reaches the engine through its Docker pipe, as a window that Devspaces opens (windowPipe.ts): the address
  // that this computer makes for the devspace, with the ID of this computer that .vscode-test.mjs writes into the
  // storage folder of the extension before VS Code starts.
  const computerId = newComputerId();
  const dockerHost = dockerPipeAddress(dockerPipeId(computerId, REMOTE_HOST, name), process.platform, dockerPipeBase(process.env, os.tmpdir())).dockerHost;
  return {
    remote: {
      containerName: name,
      folder,
      folderUri: folderUri(name, folder, { host: dockerHost }),
      computerId,
      dockerHost,
      user: 'node',
      devspaceId,
      dockerContext: context,
      remoteHost: REMOTE_HOST,
      remoteHostContainer: REMOTE_HOST_CONTAINER,
      preparedAt,
    },
  };
}

/**
 * The last release of this repository on GitHub and its VSIX, downloaded into `folder`: the file that the release
 * workflow attaches to the GitHub release (its publish job publishes this file to the Marketplace). The test installs
 * this file, so that it does not depend on the listing of the Marketplace. The token (GITHUB_TOKEN, see main) only
 * raises the rate limit of the GitHub API. Undefined when the repository has no release of this extension ID yet: no
 * release at all, or a latest release whose VSIX is not the package `<name>-<version>.vsix` of the name of this
 * checkout (a release of another ID, see the section Naming of CONTRIBUTING.md).
 */
async function latestReleaseVsix(folder: string, token: string | undefined): Promise<{ tag: string; file: string } | undefined> {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error('GITHUB_REPOSITORY is not set (GitHub Actions sets it).');
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const answer = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, { headers, signal: AbortSignal.timeout(30_000) });
  if (answer.status === 404) {
    log.info(`${repository} has no release.`);
    return undefined;
  }
  if (!answer.ok) throw new Error(`The latest release of ${repository} could not be read: ${answer.status} ${await answer.text()}`);
  const release = (await answer.json()) as { tag_name: string; assets: { name: string; browser_download_url: string }[] };
  const assets = release.assets.filter((asset) => asset.name.endsWith('.vsix'));
  if (assets.length !== 1) throw new Error(`The release ${release.tag_name} of ${repository} has ${assets.length} VSIX files: ${assets.map((asset) => asset.name).join(', ')}`);
  const { name } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { name: string };
  if (assets[0].name !== `${name}-${release.tag_name.replace(/^v/, '')}.vsix`) {
    log.info(`The latest release ${release.tag_name} of ${repository} holds ${assets[0].name}, not a package of ${name}.`);
    return undefined;
  }
  const download = await fetch(assets[0].browser_download_url, { signal: AbortSignal.timeout(120_000) });
  if (!download.ok) throw new Error(`${assets[0].browser_download_url} could not be downloaded: ${download.status}`);
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, assets[0].name);
  fs.writeFileSync(file, Buffer.from(await download.arrayBuffer()));
  return { tag: release.tag_name, file };
}

/**
 * The VSIX of this checkout in `folder`, as `npm run package` builds it, for the first version of an extension ID: with
 * no release of the ID (latestReleaseVsix), the run `previous` runs this version, and the update installs it again.
 */
function checkoutVsix(folder: string): { tag: string; file: string } {
  const { name, version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { name: string; version: string };
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${name}-${version}.vsix`);
  const build = childProcess.spawnSync('npm', ['run', '-s', 'package', '--', '--out', file], { cwd: ROOT, encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`The VSIX of this checkout could not be built: exit code ${build.status}\n${build.stdout}${build.stderr}`);
  log.info(`No release of ${EXTENSION_ID} exists yet: the run previous runs the VSIX of this checkout, version ${version}.`);
  return { tag: `v${version}`, file };
}

/**
 * The helper image of the released version in `folder` (its extension folder), built as that version builds it when it
 * is missing (helperImage.ts, ensureHelperImageUse): the tag from its Dockerfile and the CLI version of its package.json
 * (helperImageTag), with that CLI version as the build argument. The CLI version of this checkout can be another one
 * (Dependabot updates it), and that version restores the devspace at activation only when its own tag exists. The image
 * name, its label and the helper generation are those of this checkout.
 */
async function releasedHelperImage(docker: BootstrapDocker, folder: string, started: number): Promise<string> {
  const dockerfile = path.join(folder, 'resources', 'helper', 'Dockerfile');
  // As scripts/cliVersion.mjs reads it; that module uses import.meta, which the CommonJS bundle of this file has not.
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8')) as { devDependencies?: Record<string, unknown> };
  const cliVersion = manifest.devDependencies?.['@devcontainers/cli'];
  if (typeof cliVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(cliVersion)) {
    throw new Error(`The package.json of the released version has no exact version of @devcontainers/cli: ${JSON.stringify(cliVersion)}`);
  }
  const tag = helperImageTag(fs.readFileSync(dockerfile, 'utf8'), cliVersion);
  if (!(await docker.imageExists(tag))) {
    await docker.buildImage({ tag, dockerfile, context: path.dirname(dockerfile), labels: { [LABEL_HELPER]: 'true' }, buildArgs: { DEVCONTAINER_CLI_VERSION: cliVersion } });
  }
  log.info(`Helper image ${tag} of the released version, CLI ${cliVersion} (this checkout: ${DEVCONTAINER_CLI_VERSION}), ${((Date.now() - started) / 1000).toFixed(0)} s since the start.`);
  return tag;
}

/** Whether the version `a` (major.minor.patch) is greater than `b`. */
function newerVersion(a: string, b: string): boolean {
  const [pa, pb] = [a, b].map((value) => value.split('.').map((part) => Number.parseInt(part, 10)));
  for (let index = 0; index < 3; index++) if ((pa[index] ?? 0) !== (pb[index] ?? 0)) return (pa[index] ?? 0) > (pb[index] ?? 0);
  return false;
}

/**
 * The runs `previous` and `updated`: the last released version of the extension, installed from the VSIX of its GitHub
 * release into the extensions folder of the test VS Code as users install a VSIX, the helper image of that version
 * (releasedHelperImage), and the devspace without container. The seed names the version and the SHA-256 of its
 * dist/extension.js, so that the run `previous` can check that VS Code loads it. The image name, label and generation of
 * the helper image and the volume labels of the devspace are those of this checkout: a version that changes them must
 * build the image or seed the devspace with those of the released version here. A checkout older than the latest
 * release fails: its VSIX would replace a newer version (a downgrade). Before the first release of the extension ID,
 * the released version is the VSIX of this checkout (checkoutVsix).
 */
async function prepareUpdate(docker: BootstrapDocker, vscode: TestVscode, started: number, githubToken: string | undefined): Promise<Record<string, unknown>> {
  const previousFolder = path.join(ROOT, 'out', 'test', 'vscode', 'attach', 'previous');
  const release = (await latestReleaseVsix(previousFolder, githubToken)) ?? checkoutVsix(previousFolder);
  const install = childProcess.spawnSync(vscode.cli, [...vscode.cliArgs, '--install-extension', release.file], { encoding: 'utf8' });
  log.info(`${release.file} of the release ${release.tag}: exit code ${install.status}\n${install.stdout}${install.stderr}`);
  if (install.status !== 0) throw new Error(`${release.file} could not be installed.`);
  const folders = fs.readdirSync(vscode.extensionsDir).filter((name) => name.toLowerCase().startsWith(`${EXTENSION_ID}-`));
  if (folders.length !== 1) throw new Error(`${vscode.extensionsDir} has ${folders.length} folders of ${EXTENSION_ID}: ${folders.join(', ')}`);
  const folder = path.join(vscode.extensionsDir, folders[0]);
  const version = (JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8')) as { version: string }).version;
  if (release.tag !== `v${version}`) throw new Error(`The release ${release.tag} holds the version ${version}.`);
  const own = (JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
  if (newerVersion(version, own)) throw new Error(`The latest release ${version} is newer than the version ${own} of this checkout: the update would be a downgrade. Merge main.`);
  const extensionSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(folder, 'dist', 'extension.js'))).digest('hex');
  log.info(`The previous version ${version} is in ${folder} (dist/extension.js ${extensionSha256}).`);
  const helper = await releasedHelperImage(docker, folder, started);
  const { devspaceId, name, folder: repository } = await seedDevspace(docker, helper);
  return {
    devspace: { containerName: name, folder: repository, folderUri: folderUri(name, repository), user: 'node', devspaceId, previous: { version, extensionSha256 } },
  };
}

async function main(): Promise<void> {
  if (process.env.CI !== 'true') throw new Error('The attach tests use the Docker engine as a real installation does. They run only on CI (CI=true).');
  const started = Date.now();
  // The preparation `update` reads the latest release with it; no program that the preparation starts gets it.
  const githubToken = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  const vscode = await trustExtension();
  const dockerPath = findDockerCli(process.env, process.platform);
  if (!dockerPath) throw new Error('The Docker CLI was not found.');
  const docker = new BootstrapDocker(new NodeProcessRunner(), dockerPath, process.env, log);
  const kind = process.env.DEVSPACE_TEST_ATTACH_PREPARE;
  const seed =
    kind === 'remote' ? await prepareRemote(docker, dockerPath, started) : kind === 'update' ? await prepareUpdate(docker, vscode, started, githubToken) : await prepareLocal(docker, started);
  const file = path.join(ROOT, 'out', 'test', 'vscode', 'attach', 'seed.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(seed, null, 2));
  log.info(`${file}: ${JSON.stringify(seed)}`);
  log.info(`Prepared in ${((Date.now() - started) / 1000).toFixed(0)} s.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
