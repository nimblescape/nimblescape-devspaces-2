// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The setup of the WSL distribution of Devspaces on Windows (docs/architecture.md "The WSL distribution of Devspaces"):
// Devspaces downloads the Debian file of the list of WSL distributions of Microsoft (DistributionInfo.json, the list that
// `wsl --install` itself uses), checks it against the SHA-256 of that list, and registers it for the Windows user with
// `wsl --install --from-file` under the name `devspaces`, with its virtual disk in a folder of Devspaces. Then a script
// runs as root in the distribution: it turns on systemd and installs Docker Engine from download.docker.com. After a
// restart of the distribution, systemd starts Docker. The removal is `wsl --unregister devspaces`. Whether Devspaces set
// up the distribution comes from the registry of the Windows user (the folder of its virtual disk). No `vscode`.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { errorMessage } from '../errors';
import type { HttpTransport } from '../http';
import { abortError, isAbortError, type Logger, type ProcessRunner, type RunOptions, type RunResult } from '../ports';
import { envValue } from './dockerCli';
import { downloadFile, type DownloadOptions } from './dockerDownload';
import { WSL_DISTRIBUTION, WSL_LIST_ARGS, parseWslList, wslCommandArgs, wslEnv, wslText } from './dockerHost';
import { DOCKER_ENGINE_PACKAGES, isHttpsUrl } from './dockerSetup';

/** The list of the WSL distributions that `wsl --install` offers, with the URL and the SHA-256 of each file. */
export const WSL_DISTRIBUTION_LIST_URL = 'https://raw.githubusercontent.com/microsoft/WSL/master/distributions/DistributionInfo.json';
/** `wsl --install --from-file`, with `--name` and `--location`, needs WSL 2.4.4 or later. */
export const WSL_FROM_FILE_VERSION: readonly [number, number, number] = [2, 4, 4];
export const WSL_VERSION_ARGS: readonly string[] = ['--version'];
export const WSL_STATUS_ARGS: readonly string[] = ['--status'];
/** Stops the distribution, so that the next start reads /etc/wsl.conf (systemd). */
export const WSL_TERMINATE_ARGS: readonly string[] = ['--terminate', WSL_DISTRIBUTION];
/** Deletes the distribution with its virtual disk: everything in it is lost. */
export const WSL_UNREGISTER_ARGS: readonly string[] = ['--unregister', WSL_DISTRIBUTION];
/** The log of the script in the distribution. */
export const WSL_SETUP_LOG = '/var/log/devspaces-setup.log';
/** The line of the policy-rc.d of the script, so that a later run knows the file of a run that was stopped. */
export const WSL_POLICY_MARK = '# Written by the setup of Devspaces.';
/** The key of the registry with the WSL distributions of the Windows user: one subkey for each, with its name and folder. */
export const LXSS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss';

/** The largest list that is read. */
const MAX_LIST_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 5;
/** A download that receives no bytes for this long stops (also before the answer of the server). */
const STALLED_AFTER_MS = 60_000;
/** The largest Debian file that is downloaded (it has some 100 MB), so that a body without an end does not fill the disk. */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024 * 1024;
const SHORT_CALL_MS = 15_000;
const REGISTER_MS = 15 * 60_000;
const PROVISION_MS = 30 * 60_000;
const TERMINATE_MS = 60_000;
/** The script that waits for Docker waits 120 seconds itself. */
const START_MS = 3 * 60_000;
const UNREGISTER_MS = 5 * 60_000;
/** The name of the downloaded file in the folder `download`; it is removed after the registration. */
const DOWNLOAD_NAME = 'debian.wsl';
/** The file of `reg.exe export`, in a new folder of the temporary folder that is removed after the read. */
const REGISTRY_EXPORT_NAME = 'distributions.reg';
/** The start of the lines of the script that name its next step. */
const STEP_PREFIX = 'devspaces-step ';

/**
 * The folder of the WSL distribution of Devspaces: `%LOCALAPPDATA%\nimblescape\devspaces\wsl`, outside of the storage
 * of VS Code (which is in the roaming profile), so that the virtual disk stays on this computer. Undefined without
 * LOCALAPPDATA.
 */
export function wslSetupFolder(env: NodeJS.ProcessEnv): string | undefined {
  const localAppData = envValue(env, 'LOCALAPPDATA', 'win32');
  return localAppData ? path.win32.join(localAppData, 'nimblescape', 'devspaces', 'wsl') : undefined;
}

/** The arguments of `wsl.exe` that register the file `file` as the distribution `devspaces`, without a start. */
export function wslInstallArgs(file: string, location: string): string[] {
  return ['--install', '--from-file', file, '--name', WSL_DISTRIBUTION, '--location', location, '--no-launch'];
}

/** One file of the list of WSL distributions. */
export interface WslImage {
  /** The name of the distribution in the list, for example `Debian`. */
  name: string;
  /** An HTTPS URL. */
  url: string;
  /** The SHA-256 of the file, hex in lower case. */
  sha256: string;
  /** The size in bytes, when a HEAD request tells it (WslSetup.image). */
  size?: number;
}

const SHA256 = /^(?:0x)?([0-9a-f]{64})$/i;

/**
 * The Debian file of the list of WSL distributions (DistributionInfo.json) for the architecture `arch` (`process.arch`:
 * `x64` or `arm64`): the entry `Default` of `ModernDistributions.Debian`, else its first entry. Undefined when the list
 * has none, or when its URL is not HTTPS or its SHA-256 is not 64 hex digits (the list writes some with `0x`).
 */
export function debianImageOf(list: unknown, arch: string): WslImage | undefined {
  const key = arch === 'x64' ? 'Amd64Url' : arch === 'arm64' ? 'Arm64Url' : undefined;
  const entries = (list as { ModernDistributions?: { Debian?: unknown } } | null)?.ModernDistributions?.Debian;
  if (key === undefined || !Array.isArray(entries)) return undefined;
  const entry = (entries.find((candidate: { Default?: unknown } | null) => candidate?.Default === true) ?? entries[0]) as Record<string, unknown> | undefined;
  const file = entry?.[key] as { Url?: unknown; Sha256?: unknown } | undefined;
  const name = typeof entry?.Name === 'string' ? entry.Name : 'Debian';
  if (typeof file?.Url !== 'string' || typeof file.Sha256 !== 'string' || !isHttpsUrl(file.Url)) return undefined;
  const sha256 = SHA256.exec(file.Sha256)?.[1];
  return sha256 === undefined ? undefined : { name, url: file.Url, sha256: sha256.toLowerCase() };
}

/** The version of WSL in the output of `wsl.exe --version` (its first line, also in other languages), or undefined. */
export function parseWslVersion(output: string): [number, number, number] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(wslText(output));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** True when `version` is WSL_FROM_FILE_VERSION or later. */
export function supportsFromFile(version: readonly [number, number, number]): boolean {
  for (let index = 0; index < 3; index++) {
    if (version[index] !== WSL_FROM_FILE_VERSION[index]) return version[index] > WSL_FROM_FILE_VERSION[index];
  }
  return true;
}

/** The arguments of `reg.exe` that write the key LXSS_KEY to `file` (a `.reg` file in UTF-16). */
export function regExportArgs(file: string): string[] {
  return ['export', LXSS_KEY, file, '/y'];
}

/**
 * The folders of the WSL distributions (the value BasePath: the folder of the virtual disk) by their name in lower case
 * (DistributionName), from the file of `reg.exe export` (UTF-16 with a BOM, else UTF-8).
 */
export function parseLxssExport(content: Buffer): Map<string, string> {
  const text = content[0] === 0xff && content[1] === 0xfe ? content.subarray(2).toString('utf16le') : content.toString('utf8');
  const folders = new Map<string, string>();
  let values = new Map<string, string>();
  const close = (): void => {
    const name = values.get('distributionname');
    const basePath = values.get('basepath');
    if (name !== undefined && basePath !== undefined) folders.set(name.toLowerCase(), basePath);
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('[')) {
      close();
      values = new Map();
      continue;
    }
    // A string value: "Name"="Value", with \\ and \" inside.
    const match = /^"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"$/.exec(line.trim());
    if (match) values.set(unescapeRegistry(match[1]).toLowerCase(), unescapeRegistry(match[2]));
  }
  close();
  return folders;
}

function unescapeRegistry(text: string): string {
  return text.replace(/\\(.)/g, '$1');
}

/** Whether the Windows path `folder` is `parent` or inside it: without case, without `\\?\` and closing separators. */
function isWithin(folder: string, parent: string): boolean {
  const plain = (name: string): string => path.win32.normalize(name.replace(/^\\\\\?\\/, '')).replace(/[\\/]+$/, '').toLowerCase();
  return plain(folder) === plain(parent) || plain(folder).startsWith(`${plain(parent)}\\`);
}

/** The steps of the script in the distribution (PROVISION_SCRIPT), in this order. */
export type ProvisionPhase = 'packages' | 'repository' | 'docker';
const PHASES: readonly ProvisionPhase[] = ['packages', 'repository', 'docker'];

/**
 * The settings of WSL for the distribution: systemd starts Docker; root is the user of `wsl -d devspaces`; WSL mounts no
 * drive of Windows at the start and turns off the start of Windows programs, so that Docker and the devspaces do not see
 * the files of the Windows user by default. These are no wall: root in the distribution can mount the drives again
 * (docs/security.md).
 */
export const WSL_CONF = [
  '# Written by Devspaces: the settings of the WSL distribution of Devspaces.',
  '[boot]',
  'systemd=true',
  '',
  '[user]',
  'default=root',
  '',
  '[automount]',
  'enabled=false',
  '',
  '[interop]',
  'enabled=false',
  'appendWindowsPath=false',
].join('\n');

/**
 * The script that sets up the distribution, as root (`sh -s`, on standard input). It can run again on a distribution
 * that it set up before, also after a run that was stopped: each file is written anew, dpkg ends an interrupted
 * installation, and apt installs or updates. Only one run at a time (flock): a second one fails at once. The output of
 * the commands goes to WSL_SETUP_LOG; standard output gets only the step lines (`devspaces-step <phase>`). On a failure,
 * standard error gets the last 40 lines of the log. The body is a function that runs with its standard input from
 * /dev/null, so no command reads the rest of the script. No service starts during the installation (a policy-rc.d with
 * WSL_POLICY_MARK, removed at the end; one of another program stays): systemd starts Docker after the restart of the
 * distribution.
 */
export const PROVISION_SCRIPT = `set -eu
main() {
log=${WSL_SETUP_LOG}
exec 9> /run/devspaces-setup.lock
if ! flock -n 9; then
echo "Another setup of Docker runs in the distribution. Try again after it." >&2
exit 1
fi
: > "$log"
step() { echo "${STEP_PREFIX}$1"; echo "== $1" >> "$log"; }
fail() { echo "The setup failed. The last lines of $log:" >&2; tail -n 40 "$log" >&2; exit 1; }
run() { "$@" >> "$log" 2>&1 || fail; }
export DEBIAN_FRONTEND=noninteractive
if [ ! -e /usr/sbin/policy-rc.d ] || grep -qxF '${WSL_POLICY_MARK}' /usr/sbin/policy-rc.d; then
printf '#!/bin/sh\\n${WSL_POLICY_MARK}\\nexit 101\\n' > /usr/sbin/policy-rc.d
chmod 755 /usr/sbin/policy-rc.d
trap 'rm -f /usr/sbin/policy-rc.d' EXIT
trap 'exit 1' HUP INT TERM
fi
step packages
cat > /etc/wsl.conf <<'WSLCONF'
${WSL_CONF}
WSLCONF
run dpkg --configure -a
run apt-get update
run apt-get install -y ca-certificates curl systemd systemd-sysv
step repository
. /etc/os-release
if [ "\${ID:-}" != debian ] || [ -z "\${VERSION_CODENAME:-}" ]; then
echo "The distribution is not Debian with a code name in /etc/os-release: \${PRETTY_NAME:-unknown}." >&2
exit 1
fi
arch=$(dpkg --print-architecture)
run install -m 0755 -d /etc/apt/keyrings
run curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
run chmod a+r /etc/apt/keyrings/docker.asc
cat > /etc/apt/sources.list.d/docker.sources <<SOURCES
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: $VERSION_CODENAME
Components: stable
Architectures: $arch
Signed-By: /etc/apt/keyrings/docker.asc
SOURCES
step docker
run apt-get update
run apt-get install -y ${DOCKER_ENGINE_PACKAGES}
run systemctl enable docker.service containerd.service
run apt-get clean
}
main < /dev/null
`;

/**
 * The script that waits up to 120 seconds for Docker after the restart (`sh -s`, as root). Standard output: the version
 * of the engine. On a failure, standard error gets the answer of `docker info` and the state of the service.
 */
export const DOCKER_WAIT_SCRIPT = `i=0
until docker info > /dev/null 2>&1; do
i=$((i + 1))
if [ "$i" -ge 60 ]; then
[ -d /run/systemd/system ] || echo "systemd does not run in the distribution." >&2
docker info > /dev/null 2>&1 || docker info 2>&1 | tail -n 5 >&2
systemctl --no-pager status docker.service 2>&1 | tail -n 20 >&2
exit 1
fi
sleep 2
done
docker version --format '{{.Server.Version}}'
`;

export type WslSetupProblem =
  /** No `wsl.exe`, or WSL is not installed. */
  | 'wslMissing'
  /** `wsl.exe` did not answer a short call (its version, its list). */
  | 'wslNotAnswering'
  /** WSL older than 2.4.4. */
  | 'wslTooOld'
  /** The list of WSL distributions could not be loaded or read. */
  | 'listFailed'
  /** The list has no Debian file for this computer. */
  | 'noImage'
  | 'downloadFailed'
  /** `wsl --install --from-file` failed. */
  | 'registerFailed'
  /** The script in the distribution failed. */
  | 'dockerFailed'
  /** Docker did not answer after the restart. */
  | 'dockerNotRunning'
  /** `wsl --unregister` failed. */
  | 'removeFailed';

/** A failure of the setup or the removal; the message is technical (for the log), the problem chooses the text. */
export class WslSetupError extends Error {
  constructor(
    readonly problem: WslSetupProblem,
    message: string,
  ) {
    super(message);
    this.name = 'WslSetupError';
  }
}

export function isWslSetupError(error: unknown): error is WslSetupError {
  return error instanceof WslSetupError;
}

/**
 * Whether the distribution `devspaces` is registered: `none`; `own`, set up by Devspaces (the registry names the folder
 * of Devspaces as the folder of its virtual disk); or `foreign`, a distribution with that name that the user made,
 * which Devspaces never sets up or removes.
 */
export type WslRegistration = 'none' | 'own' | 'foreign';

/** A step of the setup, for the progress. */
export type WslSetupStep =
  | { kind: 'download'; received: number; total: number | undefined }
  | { kind: 'register' }
  | { kind: 'docker'; phase: ProvisionPhase }
  | { kind: 'restart' }
  | { kind: 'start' };

export interface WslSetupDeps {
  runner: ProcessRunner;
  /** The path of `wsl.exe` (findExecutable), or undefined. */
  wslPath: () => string | undefined;
  env: NodeJS.ProcessEnv;
  /** `process.arch`: the Debian file for `x64` or `arm64`. */
  arch: string;
  /** The folder of Devspaces for the distribution (wslSetupFolder): the virtual disk in `disk`, the download in `download`. */
  folder: string;
  logger: Logger;
  /** The list of WSL distributions and the size of the Debian file. */
  http: HttpTransport;
  /** For tests. Default: `downloadFile`. */
  download?: (options: DownloadOptions) => Promise<void>;
  /** For tests: STALLED_AFTER_MS. */
  stalledAfterMs?: number;
}

export class WslSetup {
  constructor(private readonly deps: WslSetupDeps) {}

  /** The folder of the virtual disk of the distribution (`--location`). */
  get diskFolder(): string {
    return path.join(this.deps.folder, 'disk');
  }

  private get downloadFolder(): string {
    return path.join(this.deps.folder, 'download');
  }

  /** `reg.exe` in System32 of SystemRoot, not from PATH. */
  private get regPath(): string {
    const systemRoot = envValue(this.deps.env, 'SystemRoot', 'win32') ?? 'C:\\Windows';
    return path.win32.join(systemRoot, 'System32', 'reg.exe');
  }

  /**
   * The version of WSL, when it can register a file (WSL_FROM_FILE_VERSION). Throws WslSetupError `wslMissing` without
   * WSL, `wslTooOld` for an older WSL (an older `wsl.exe` knows no `--version`; `--status` then tells whether WSL is
   * installed).
   */
  async checkWsl(signal?: AbortSignal): Promise<string> {
    const versionResult = await this.runShort(WSL_VERSION_ARGS, signal);
    const version = versionResult.exitCode === 0 ? parseWslVersion(versionResult.stdout) : undefined;
    if (version !== undefined) {
      if (!supportsFromFile(version)) {
        throw new WslSetupError('wslTooOld', `WSL ${version.join('.')} cannot register a file; it needs ${WSL_FROM_FILE_VERSION.join('.')} or later.`);
      }
      return version.join('.');
    }
    const status = await this.runShort(WSL_STATUS_ARGS, signal);
    const detail = `wsl.exe --version ended with exit code ${versionResult.exitCode}: ${outputOf(versionResult)}`;
    if (status.exitCode === 0) throw new WslSetupError('wslTooOld', `${detail}. WSL is installed, but too old to show its version.`);
    throw new WslSetupError('wslMissing', `${detail}. wsl.exe --status ended with exit code ${status.exitCode}: ${outputOf(status)}`);
  }

  /**
   * Whether the distribution `devspaces` is registered, and whether Devspaces set it up (WslRegistration): from the
   * list of WSL and the folder of its virtual disk in the registry. When `wsl.exe --list` fails (also without any
   * distribution), the registry alone decides. When the registry cannot be read (logged), a virtual disk in `diskFolder`
   * makes it `own`.
   */
  async registration(signal?: AbortSignal): Promise<WslRegistration> {
    const listed = await this.listed(signal);
    if (listed === false) return 'none';
    const folders = await this.distributionFolders(signal);
    if (folders !== undefined) {
      const diskFolder = folders.get(WSL_DISTRIBUTION);
      if (diskFolder === undefined) return listed ? 'foreign' : 'none';
      return isWithin(diskFolder, this.diskFolder) ? 'own' : 'foreign';
    }
    if (!listed) return 'none';
    this.deps.logger.info(`Without the registry, a virtual disk in ${this.diskFolder} tells whether Devspaces set up the WSL distribution ${WSL_DISTRIBUTION}.`);
    return (await this.hasDisk()) ? 'own' : 'foreign';
  }

  /**
   * The Debian file of the list of WSL distributions for this computer, with its size when a HEAD request tells it.
   * Throws WslSetupError `listFailed` or `noImage`.
   */
  async image(signal?: AbortSignal): Promise<WslImage> {
    let list: unknown;
    try {
      const response = await this.deps.http.request({ method: 'GET', url: WSL_DISTRIBUTION_LIST_URL, maxBodyBytes: MAX_LIST_BYTES }, signal);
      if (response.status !== 200) throw new Error(`HTTP status ${response.status}`);
      list = JSON.parse(response.body);
    } catch (error) {
      if (signal?.aborted) throw abortError();
      throw new WslSetupError('listFailed', `The list of WSL distributions could not be loaded from ${WSL_DISTRIBUTION_LIST_URL}: ${errorMessage(error)}`);
    }
    const image = debianImageOf(list, this.deps.arch);
    if (image === undefined) throw new WslSetupError('noImage', `The list of WSL distributions has no Debian file for ${this.deps.arch}.`);
    const size = await this.sizeOf(image.url, signal);
    return size === undefined ? image : { ...image, size };
  }

  /**
   * Sets up the distribution: with `image`, downloads it into the folder `download`, registers it with its virtual disk
   * in `diskFolder`, and removes the download; then the script installs Docker Engine (PROVISION_SCRIPT), the
   * distribution restarts, and Docker must answer. Without `image`, only the script, the restart and the check run (a
   * distribution that Devspaces set up before). Returns the version of the engine. Throws WslSetupError, or an
   * AbortError when the signal aborts. When the script is cancelled or ends by its time limit, the distribution stops,
   * because the script would go on there after the end of wsl.exe; its next run goes on from there.
   */
  async setUp(image: WslImage | undefined, onStep: (step: WslSetupStep) => void, signal?: AbortSignal): Promise<string> {
    if (image !== undefined) await this.register(image, onStep, signal);
    let pending = '';
    let provision: RunResult;
    try {
      provision = await this.runWsl(wslCommandArgs(WSL_DISTRIBUTION, ['sh', '-s']), {
        input: PROVISION_SCRIPT,
        timeoutMs: PROVISION_MS,
        signal,
        onStdout: (text) => {
          pending += wslText(text);
          const lines = pending.split(/\r?\n/);
          pending = lines.pop() ?? '';
          for (const line of lines) {
            const phase = line.startsWith(STEP_PREFIX) ? (line.slice(STEP_PREFIX.length).trim() as ProvisionPhase) : undefined;
            if (phase !== undefined && PHASES.includes(phase)) {
              this.deps.logger.info(`The WSL distribution ${WSL_DISTRIBUTION}: ${phase}.`);
              onStep({ kind: 'docker', phase });
            }
          }
        },
      });
    } catch (error) {
      if (isAbortError(error)) await this.stopDistribution('the setup was cancelled');
      throw error;
    }
    if (provision.timedOut) await this.stopDistribution(`the script did not end within ${duration(PROVISION_MS)}`);
    if (provision.exitCode !== 0) {
      throw new WslSetupError('dockerFailed', `Docker Engine could not be installed in the WSL distribution ${WSL_DISTRIBUTION} (${endOf(provision, PROVISION_MS)}): ${outputOf(provision)}`);
    }
    onStep({ kind: 'restart' });
    const terminate = await this.runWsl(WSL_TERMINATE_ARGS, { timeoutMs: TERMINATE_MS, signal });
    // Docker then starts without systemd, if at all; the check below says so.
    if (terminate.exitCode !== 0) this.deps.logger.warn(`wsl.exe ${WSL_TERMINATE_ARGS.join(' ')} failed (${endOf(terminate, TERMINATE_MS)}): ${outputOf(terminate)}`);
    onStep({ kind: 'start' });
    const wait = await this.runWsl(wslCommandArgs(WSL_DISTRIBUTION, ['sh', '-s']), { input: DOCKER_WAIT_SCRIPT, timeoutMs: START_MS, signal });
    if (wait.exitCode !== 0) {
      throw new WslSetupError('dockerNotRunning', `Docker does not answer in the WSL distribution ${WSL_DISTRIBUTION} after its restart (${endOf(wait, START_MS)}): ${outputOf(wait)}`);
    }
    const version = wslText(wait.stdout).trim();
    this.deps.logger.info(`The WSL distribution ${WSL_DISTRIBUTION} runs Docker Engine ${version}.`);
    return version;
  }

  /**
   * `wsl --unregister devspaces`, which deletes the distribution with everything in it, then the folder of Devspaces.
   * Only for a distribution that Devspaces set up (the caller checks `registration`). Throws WslSetupError `removeFailed`.
   */
  async remove(signal?: AbortSignal): Promise<void> {
    const result = await this.runWsl(WSL_UNREGISTER_ARGS, { timeoutMs: UNREGISTER_MS, signal });
    if (result.exitCode !== 0) {
      throw new WslSetupError('removeFailed', `wsl.exe ${WSL_UNREGISTER_ARGS.join(' ')} failed (${endOf(result, UNREGISTER_MS)}): ${outputOf(result)}`);
    }
    this.deps.logger.info(`The WSL distribution ${WSL_DISTRIBUTION} was removed.`);
    await fs.promises.rm(this.deps.folder, { recursive: true, force: true }).catch((error: unknown) => {
      this.deps.logger.warn(`The folder ${this.deps.folder} could not be removed: ${errorMessage(error)}`);
    });
  }

  /**
   * Removes the folder of Devspaces when no WSL distribution has its virtual disk there (the registry): the files of a
   * setup that did not end. Never throws (logged).
   */
  async removeLeftovers(): Promise<void> {
    const { folder, logger } = this.deps;
    if (!fs.existsSync(folder)) return;
    const users = await this.diskUsers(folder).catch(() => undefined);
    if (users === undefined || users.length > 0) {
      logger.info(`The folder ${folder} stays: ${users === undefined ? 'neither the registry nor WSL tells whether a WSL distribution uses it' : `the WSL distribution ${users.join(', ')} has its virtual disk there`}.`);
      return;
    }
    await fs.promises.rm(folder, { recursive: true, force: true }).then(
      () => logger.info(`The folder ${folder} of an earlier setup was removed.`),
      (error: unknown) => logger.warn(`The folder ${folder} could not be removed: ${errorMessage(error)}`),
    );
  }

  private async register(image: WslImage, onStep: (step: WslSetupStep) => void, signal?: AbortSignal): Promise<void> {
    const file = path.join(this.downloadFolder, DOWNLOAD_NAME);
    await this.clearDiskFolder(signal);
    await fs.promises.mkdir(this.downloadFolder, { recursive: true });
    await fs.promises.mkdir(this.diskFolder, { recursive: true });
    try {
      onStep({ kind: 'download', received: 0, total: image.size });
      await this.downloadImage(image, file, onStep, signal);
      onStep({ kind: 'register' });
      const args = wslInstallArgs(file, this.diskFolder);
      this.deps.logger.info(`wsl.exe ${args.join(' ')}`);
      const result = await this.runWsl(args, { timeoutMs: REGISTER_MS, signal });
      if (result.exitCode !== 0) {
        throw new WslSetupError('registerFailed', `wsl.exe --install --from-file failed (${endOf(result, REGISTER_MS)}): ${outputOf(result)}`);
      }
      this.deps.logger.info(`The WSL distribution ${WSL_DISTRIBUTION} was registered with its virtual disk in ${this.diskFolder}.`);
    } finally {
      await fs.promises.rm(file, { force: true }).catch((error: unknown) => {
        this.deps.logger.warn(`The download ${file} could not be removed: ${errorMessage(error)}`);
      });
    }
  }

  /** The download, checked against the SHA-256 of the list; it stops when no bytes arrive for a minute. */
  private async downloadImage(image: WslImage, file: string, onStep: (step: WslSetupStep) => void, signal?: AbortSignal): Promise<void> {
    const stalledAfterMs = this.deps.stalledAfterMs ?? STALLED_AFTER_MS;
    const stall = new AbortController();
    let stallTimer: NodeJS.Timeout | undefined;
    const watch = (): void => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => stall.abort(), stalledAfterMs);
    };
    this.deps.logger.info(`The ${image.name} file for WSL is downloaded from ${image.url} (SHA-256 ${image.sha256} of ${WSL_DISTRIBUTION_LIST_URL}).`);
    watch();
    try {
      await (this.deps.download ?? downloadFile)({
        url: image.url,
        host: new URL(image.url).hostname,
        expected: { sha256: image.sha256 },
        // The file of a build server is often served from another host (its storage); the SHA-256 checks it.
        anyHttpsRedirect: true,
        target: file,
        maxBytes: MAX_IMAGE_BYTES,
        signal: signal === undefined ? stall.signal : AbortSignal.any([signal, stall.signal]),
        onProgress: (received, total) => {
          watch();
          onStep({ kind: 'download', received, total: total ?? image.size });
        },
      });
    } catch (error) {
      if (signal?.aborted) throw abortError();
      const reason = stall.signal.aborted ? `it received no bytes for ${Math.round(stalledAfterMs / 1000)} seconds` : errorMessage(error);
      throw new WslSetupError('downloadFailed', `The ${image.name} file for WSL could not be downloaded from ${image.url}: ${reason}`);
    } finally {
      clearTimeout(stallTimer);
    }
  }

  /** The size of the file at `url` from a HEAD request (HTTPS redirects followed), or undefined (logged). */
  private async sizeOf(url: string, signal?: AbortSignal): Promise<number | undefined> {
    let current = url;
    try {
      for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
        const response = await this.deps.http.request({ method: 'HEAD', url: current }, signal);
        const location = response.headers.location;
        if (response.status >= 300 && response.status < 400 && location) {
          current = new URL(location, current).href;
          if (!isHttpsUrl(current)) return undefined;
          continue;
        }
        const length = Number.parseInt(response.headers['content-length'] ?? '', 10);
        return response.status === 200 && Number.isFinite(length) && length > 0 ? length : undefined;
      }
    } catch (error) {
      if (signal?.aborted) throw abortError();
      this.deps.logger.info(`The size of ${url} is not known: ${errorMessage(error)}`);
    }
    return undefined;
  }

  /**
   * Empties `diskFolder` before a registration: a virtual disk of a setup that did not end may be there, and WSL creates
   * no distribution on it. Throws WslSetupError `registerFailed` when a WSL distribution has its disk there, or when the
   * registry cannot tell.
   */
  private async clearDiskFolder(signal?: AbortSignal): Promise<void> {
    const names = await fs.promises.readdir(this.diskFolder).catch(() => [] as string[]);
    if (names.length === 0) return;
    const users = await this.diskUsers(this.diskFolder, signal);
    if (users === undefined) {
      throw new WslSetupError(
        'registerFailed',
        `The folder ${this.diskFolder} has files (${names.join(', ')}), and neither the registry nor WSL tells whether a WSL distribution uses them; Devspaces creates no distribution there. When no WSL distribution uses them, remove the folder and try again.`,
      );
    }
    if (users.length > 0) {
      throw new WslSetupError('registerFailed', `The folder ${this.diskFolder} has files (${names.join(', ')}), and the WSL distribution ${users.join(', ')} has its virtual disk there; Devspaces creates no distribution there.`);
    }
    this.deps.logger.info(`The folder ${this.diskFolder} has the files of a setup that did not end (${names.join(', ')}); they are removed.`);
    await fs.promises.rm(this.diskFolder, { recursive: true, force: true });
  }

  /**
   * The WSL distributions (names in lower case) with their virtual disk in `parent`, from the registry. Without the
   * registry, only the distribution `devspaces` can have it there (Devspaces registers no other one): then `wsl.exe
   * --list` must answer. Undefined when neither tells. Throws an AbortError when the signal aborts.
   */
  private async diskUsers(parent: string, signal?: AbortSignal): Promise<string[] | undefined> {
    const folders = await this.distributionFolders(signal);
    if (folders !== undefined) return [...folders.entries()].filter(([, diskFolder]) => isWithin(diskFolder, parent)).map(([name]) => name);
    try {
      const listed = await this.listed(signal);
      return listed === undefined ? undefined : listed ? [WSL_DISTRIBUTION] : [];
    } catch (error) {
      if (signal?.aborted) throw abortError();
      this.deps.logger.info(`WSL does not list its distributions: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /**
   * Whether `wsl.exe --list` names the distribution `devspaces` (WSL compares the names without case); undefined when
   * the list ends with an exit code that is not 0, which it also does without any distribution. Throws WslSetupError
   * (runShort).
   */
  private async listed(signal?: AbortSignal): Promise<boolean | undefined> {
    const result = await this.runShort(WSL_LIST_ARGS, signal);
    if (result.exitCode !== 0) return undefined;
    return parseWslList(result.stdout).some((name) => name.toLowerCase() === WSL_DISTRIBUTION);
  }

  /** True when `diskFolder` has a virtual disk (`*.vhdx`). */
  private async hasDisk(): Promise<boolean> {
    const names = await fs.promises.readdir(this.diskFolder).catch(() => [] as string[]);
    return names.some((name) => name.toLowerCase().endsWith('.vhdx'));
  }

  /**
   * The folders of the virtual disks of the WSL distributions of the Windows user by name in lower case, from the
   * registry (`reg.exe export` into a new temporary folder, removed after the read), or undefined when it cannot be
   * read (logged). Throws an AbortError when the signal aborts.
   */
  private async distributionFolders(signal?: AbortSignal): Promise<Map<string, string> | undefined> {
    let temporary: string | undefined;
    try {
      temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'devspaces-registry-'));
      const file = path.join(temporary, REGISTRY_EXPORT_NAME);
      const result = await this.deps.runner.run(this.regPath, regExportArgs(file), { timeoutMs: SHORT_CALL_MS, signal });
      if (result.exitCode !== 0) throw new Error(`reg.exe export ended with ${endOf(result, SHORT_CALL_MS)}: ${outputOf(result)}`);
      return parseLxssExport(await fs.promises.readFile(file));
    } catch (error) {
      if (signal?.aborted) throw abortError();
      this.deps.logger.warn(`The WSL distributions could not be read from the registry (${LXSS_KEY}): ${errorMessage(error)}`);
      return undefined;
    } finally {
      if (temporary !== undefined) await fs.promises.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Stops the distribution, and with it a script that goes on there after the end of wsl.exe. Never throws (logged). */
  private async stopDistribution(reason: string): Promise<void> {
    try {
      const result = await this.runWsl(WSL_TERMINATE_ARGS, { timeoutMs: TERMINATE_MS });
      if (result.exitCode === 0) this.deps.logger.info(`The WSL distribution ${WSL_DISTRIBUTION} was stopped: ${reason}.`);
      else this.deps.logger.warn(`wsl.exe ${WSL_TERMINATE_ARGS.join(' ')} failed (${endOf(result, TERMINATE_MS)}): ${outputOf(result)}`);
    } catch (error) {
      this.deps.logger.warn(`The WSL distribution ${WSL_DISTRIBUTION} could not be stopped (${reason}): ${errorMessage(error)}`);
    }
  }

  /** A short call of `wsl.exe` (runWsl) that must end within 15 seconds: else WslSetupError `wslNotAnswering`. */
  private async runShort(args: readonly string[], signal?: AbortSignal): Promise<RunResult> {
    const result = await this.runWsl(args, { timeoutMs: SHORT_CALL_MS, signal });
    if (result.timedOut) throw new WslSetupError('wslNotAnswering', `wsl.exe ${args.join(' ')} did not answer within ${duration(SHORT_CALL_MS)}.`);
    return result;
  }

  /**
   * `wsl.exe` with `args` (WSL_UTF8=1). Throws WslSetupError `wslMissing` when it is not found or cannot start, and an
   * AbortError when the signal aborts.
   */
  private async runWsl(args: readonly string[], options: RunOptions): Promise<RunResult> {
    const wsl = this.deps.wslPath();
    if (wsl === undefined) throw new WslSetupError('wslMissing', 'wsl.exe was not found.');
    try {
      return await this.deps.runner.run(wsl, args, { ...options, env: wslEnv(this.deps.env) });
    } catch (error) {
      if (options.signal?.aborted) throw abortError();
      throw new WslSetupError('wslMissing', `wsl.exe could not be started: ${errorMessage(error)}`);
    }
  }
}

/** The output of a call for the log (wslText): standard error, else standard output. */
function outputOf(result: RunResult): string {
  const text = wslText(result.stderr || result.stdout).trim();
  return text === '' ? '(no output)' : text;
}

/** How a call ended, for the log. */
function endOf(result: RunResult, timeoutMs: number): string {
  return result.timedOut ? `no end within ${duration(timeoutMs)}` : `exit code ${result.exitCode}`;
}

function duration(ms: number): string {
  return ms >= 120_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} seconds`;
}
