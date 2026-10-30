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
import { LockTimeoutError, withLockFolder } from '../storage/lockFolder';
import { errorCode } from '../storage/paths';
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
/** The lock of the script in the distribution (flock): one run at a time, also of the upgrade (wslUpgrade.ts). */
export const WSL_SETUP_LOCK = '/run/devspaces-setup.lock';
/**
 * The policy-rc.d of the script: no service starts while a run holds WSL_SETUP_LOCK. The file of a run that `wsl
 * --terminate` stopped, whose trap did not remove it, keeps no service from starting after that.
 */
export const WSL_POLICY = ['#!/bin/sh', WSL_POLICY_MARK, `flock -n ${WSL_SETUP_LOCK} true || exit 101`].join('\n');
/**
 * The lines of a script that write WSL_POLICY to /usr/sbin/policy-rc.d for the run (not over a policy-rc.d of another
 * origin), and remove it at its end.
 */
export const WSL_POLICY_INSTALL = `if [ ! -e /usr/sbin/policy-rc.d ] || grep -qxF '${WSL_POLICY_MARK}' /usr/sbin/policy-rc.d; then
cat > /usr/sbin/policy-rc.d <<'POLICY'
${WSL_POLICY}
POLICY
chmod 755 /usr/sbin/policy-rc.d
trap 'rm -f /usr/sbin/policy-rc.d' EXIT
trap 'exit 1' HUP INT TERM
fi`;
/** The key of the registry with the WSL distributions of the Windows user: one subkey for each, with its name and folder. */
export const LXSS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss';

/** The code in the answer of `wsl.exe --list` without any distribution (its text is in the language of Windows). */
const NO_DISTRIBUTIONS = /WSL_E_DEFAULT_DISTRO_NOT_FOUND/;
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
 * The lock of the setup for all windows (withLockFolder): its holder refreshes it every 15 seconds, so that a lock
 * older than a minute is of a window that ended; another window waits for it one second. After the computer slept for
 * more than a minute, another window can take it before the holder refreshes it; then the script in the distribution
 * still runs only once at a time (flock), and WSL registers the name only once.
 */
const LOCK_TIMINGS = { staleMs: 60_000, timeoutMs: 1_000 };
/** The longest wait for the list of WSL distributions and for the size of the Debian file. */
const REQUEST_MS = 30_000;
/** The folders `disk-2` and so on that a new registration may take when `disk` has files of unknown use. */
const MAX_DISK_FOLDERS = 20;

/**
 * The folder of the WSL distribution of Devspaces: `%LOCALAPPDATA%\nimblescape\devspaces\wsl`, outside of the storage
 * of VS Code (which is in the roaming profile), so that the virtual disk stays on this computer. Undefined without
 * LOCALAPPDATA.
 */
export function wslSetupFolder(env: NodeJS.ProcessEnv): string | undefined {
  const localAppData = envValue(env, 'LOCALAPPDATA', 'win32');
  return localAppData ? path.win32.join(localAppData, 'nimblescape', 'devspaces', 'wsl') : undefined;
}

/**
 * The arguments of `wsl.exe` that register the file `file` as the distribution `devspaces` of WSL 2 (also when the
 * default of the user is WSL 1, which has no systemd), without a start.
 */
export function wslInstallArgs(file: string, location: string): string[] {
  return ['--install', '--from-file', file, '--name', WSL_DISTRIBUTION, '--location', location, '--version', '2', '--no-launch'];
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

/**
 * Whether the result of `wsl.exe --list --quiet` (WSL_LIST_ARGS) names the distribution `distribution` (without case):
 * false also when WSL has no distribution (NO_DISTRIBUTIONS); undefined when the list ends with another exit code
 * that is not 0.
 */
export function listsDistribution(result: RunResult, distribution: string): boolean | undefined {
  if (result.exitCode !== 0) return NO_DISTRIBUTIONS.test(wslText(`${result.stdout}\n${result.stderr}`)) ? false : undefined;
  return parseWslList(result.stdout).some((name) => name.toLowerCase() === distribution.toLowerCase());
}

/** `reg.exe` in System32 of SystemRoot, not from PATH. */
export function regExePath(env: NodeJS.ProcessEnv): string {
  const systemRoot = envValue(env, 'SystemRoot', 'win32') ?? 'C:\\Windows';
  return path.win32.join(systemRoot, 'System32', 'reg.exe');
}

/** The arguments of `reg.exe` that write the key LXSS_KEY to `file` (a `.reg` file in UTF-16). */
export function regExportArgs(file: string): string[] {
  return ['export', LXSS_KEY, file, '/y'];
}

/** The value of LXSS_KEY that names the default distribution of WSL by its key (DistributionRegistration.cpp of WSL). */
export const LXSS_DEFAULT_VALUE = 'DefaultDistribution';

/** The arguments of `reg.exe` that delete the default distribution of WSL (LXSS_DEFAULT_VALUE): then WSL has none. */
export function regDeleteDefaultArgs(): string[] {
  return ['delete', LXSS_KEY, '/v', LXSS_DEFAULT_VALUE, '/f'];
}

/** The arguments of `wsl.exe` that make the distribution `name` the default distribution of WSL. */
export function wslSetDefaultArgs(name: string): string[] {
  return ['--set-default', name];
}

/** A WSL distribution in the registry (LXSS_KEY). */
export interface LxssDistribution {
  /** Its key, a GUID in braces, in lower case. */
  id: string;
  /** DistributionName. */
  name: string;
  /** BasePath, the folder of its virtual disk; undefined when it is missing or not a plain string. */
  basePath: string | undefined;
  /** Whether its State is LxssDistributionStateInstalled (1, wslservice.idl of WSL); undefined without a State. */
  installed: boolean | undefined;
}

/** The WSL distributions of the registry, in its order, and the key of the default one (lower case), when it has one. */
export interface LxssRegistry {
  defaultId: string | undefined;
  distributions: LxssDistribution[];
}

/**
 * The WSL distributions and the default one, from the file of `reg.exe export` of LXSS_KEY (UTF-16 with a BOM, else
 * UTF-8). A key without DistributionName is no distribution.
 */
export function parseLxss(content: Buffer): LxssRegistry {
  const text = content[0] === 0xff && content[1] === 0xfe ? content.subarray(2).toString('utf16le') : content.toString('utf8');
  const registry: LxssRegistry = { defaultId: undefined, distributions: [] };
  let key = '';
  let values = new Map<string, string>();
  let state: number | undefined;
  const close = (): void => {
    const name = values.get('distributionname');
    if (/\\lxss$/i.test(key)) registry.defaultId = values.get(LXSS_DEFAULT_VALUE.toLowerCase())?.toLowerCase();
    else if (name !== undefined) {
      const id = key.slice(key.lastIndexOf('\\') + 1).toLowerCase();
      registry.distributions.push({ id, name, basePath: values.get('basepath'), installed: state === undefined ? undefined : state === 1 });
    }
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('[')) {
      close();
      key = line.trim().replace(/^\[|\]$/g, '');
      values = new Map();
      state = undefined;
      continue;
    }
    // A string value: "Name"="Value", with \\ and \" inside.
    const match = /^"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"$/.exec(line.trim());
    if (match) values.set(unescapeRegistry(match[1]).toLowerCase(), unescapeRegistry(match[2]));
    const dword = /^"State"=dword:([0-9a-f]{8})$/i.exec(line.trim());
    if (dword) state = parseInt(dword[1], 16);
  }
  close();
  return registry;
}

/**
 * The folders of the WSL distributions of `registry` (the value BasePath: the folder of the virtual disk) by their name
 * in lower case (DistributionName). Undefined for a distribution whose BasePath is missing or not a plain string: its
 * folder is not known.
 */
export function distributionFoldersOf(registry: LxssRegistry): Map<string, string | undefined> {
  return new Map(registry.distributions.map((distribution) => [distribution.name.toLowerCase(), distribution.basePath]));
}

/** What WslSetup.separate found. */
export interface WslSeparation {
  /**
   * `none`, no distribution of Devspaces (or no folder of Devspaces); `unknown`, the registry cannot be read; `default`,
   * the distribution of Devspaces stays the default of WSL (its change failed); `separate`, it is not the default.
   */
  state: 'none' | 'unknown' | 'default' | 'separate';
  /**
   * Whether the registry has a distribution of Docker Desktop, which its WSL 2 engine and so its WSL integration need;
   * undefined when the registry cannot be read.
   */
  dockerDesktop: boolean | undefined;
}

/** The distributions of Docker Desktop (`docker-desktop`, and `docker-desktop-data` of older versions). */
function isDockerDesktopDistribution(name: string): boolean {
  return /^docker-desktop(-data)?$/i.test(name);
}

/**
 * The distributions that tools run as their machine, which must not be the default distribution of WSL in place of
 * the one of Devspaces: Docker Desktop, Rancher Desktop (`rancher-desktop`, `rancher-desktop-data`) and Podman
 * (`podman-machine-<name>`).
 */
function isToolDistribution(name: string): boolean {
  return isDockerDesktopDistribution(name) || /^rancher-desktop(-data)?$/i.test(name) || /^podman-machine-/i.test(name);
}

/**
 * The settings files of Docker Desktop on Windows: `settings-store.json`, and `settings.json` of older versions, in
 * `%APPDATA%\Docker` (docs.docker.com, "Change your Docker Desktop settings"). Empty without APPDATA.
 */
export function dockerDesktopSettingsFiles(env: NodeJS.ProcessEnv): string[] {
  const appData = envValue(env, 'APPDATA', 'win32');
  return appData ? ['settings-store.json', 'settings.json'].map((name) => path.win32.join(appData, 'Docker', name)) : [];
}

/**
 * Whether Docker Desktop has its WSL integration on for `distribution`: it is in the list IntegratedWslDistros, or it
 * is the default distribution of WSL (`isDefault`) while EnableIntegrationWithDefaultWslDistro is not false (on by
 * default); never while WslEngineEnabled is false (the engine of Hyper-V has no WSL integration). Keys and names
 * without case. The first settings file that can be read decides (the file of an older version may stay after the
 * move to settings-store.json); false when it is no JSON object, or when none can be read. Never rejects.
 */
export async function dockerDesktopIntegrates(
  env: NodeJS.ProcessEnv,
  distribution: string,
  isDefault: boolean,
  readFile: (file: string) => Promise<string> = (file) => fs.promises.readFile(file, 'utf8'),
): Promise<boolean> {
  for (const file of dockerDesktopSettingsFiles(env)) {
    let text: string;
    try {
      text = await readFile(file);
    } catch {
      continue;
    }
    let settings: unknown;
    try {
      settings = JSON.parse(text);
    } catch {
      // Docker Desktop may be writing it; the file of an older version would tell old settings.
      return false;
    }
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return false;
    const value = (name: string): unknown => Object.entries(settings).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
    if (value('WslEngineEnabled') === false) return false;
    const list = value('IntegratedWslDistros');
    if (Array.isArray(list) && list.some((name) => typeof name === 'string' && name.toLowerCase() === distribution.toLowerCase())) return true;
    return isDefault && value('EnableIntegrationWithDefaultWslDistro') !== false;
  }
  return false;
}

function unescapeRegistry(text: string): string {
  return text.replace(/\\(.)/g, '$1');
}

/** Whether the Windows path `folder` is `parent` or inside it: without case, without `\\?\` and closing separators. */
function isWithin(folder: string, parent: string): boolean {
  const plain = (name: string): string => path.win32.normalize(withoutLongPrefix(name)).replace(/[\\/]+$/, '').toLowerCase();
  return plain(folder) === plain(parent) || plain(folder).startsWith(`${plain(parent)}\\`);
}

function withoutLongPrefix(name: string): string {
  return name.replace(/^\\\\\?\\/, '');
}

/**
 * isWithin, also after links, junctions and short names are resolved (realpath), when both folders exist: the
 * registry may name the folder of a virtual disk in another form than LOCALAPPDATA.
 */
async function isWithinResolved(folder: string, parent: string): Promise<boolean> {
  if (isWithin(folder, parent)) return true;
  const resolve = (name: string): Promise<string | undefined> => fs.promises.realpath(withoutLongPrefix(name)).catch(() => undefined);
  const [realFolder, realParent] = await Promise.all([resolve(folder), resolve(parent)]);
  return realFolder !== undefined && realParent !== undefined && isWithin(realFolder, realParent);
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
exec 9> ${WSL_SETUP_LOCK}
if ! flock -n 9; then
echo "Another setup of Docker, or the weekly upgrade of the packages (up to 30 minutes), runs in the distribution. Try again after it." >&2
exit 1
fi
: > "$log"
step() { echo "${STEP_PREFIX}$1"; echo "== $1" >> "$log"; }
fail() { echo "The setup failed. The last lines of $log:" >&2; tail -n 40 "$log" >&2; exit 1; }
run() { "$@" >> "$log" 2>&1 || fail; }
export DEBIAN_FRONTEND=noninteractive
${WSL_POLICY_INSTALL}
step packages
run dpkg --configure -a
run apt-get update
run apt-get install -y ca-certificates curl systemd systemd-sysv
cat > /etc/wsl.conf <<'WSLCONF'
${WSL_CONF}
WSLCONF
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
  /** `wsl.exe` did not answer a short call (its version, its list), or could not start for another reason than a missing file. */
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
  | 'removeFailed'
  /** WSL lists the distribution, but the registry cannot be read, so it is not known whether Devspaces set it up. */
  | 'registryFailed';

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
 * Whether the distribution `devspaces` is registered: `none`; `own`, set up by Devspaces (the registry names a folder
 * in the folder of Devspaces as the folder of its virtual disk); or `foreign`, a distribution with that name that the
 * user made, which Devspaces never sets up or removes.
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

  private get downloadFolder(): string {
    return path.join(this.deps.folder, 'download');
  }

  private get regPath(): string {
    return regExePath(this.deps.env);
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
   * list of WSL and the folder of its virtual disk in the registry, `own` only when that folder is in the folder of
   * Devspaces. When `wsl.exe --list` fails otherwise than without any distribution, the registry alone decides, and
   * without the registry it is `none` (a WSL with no distribution may have no key in the registry yet); with `sure`
   * (a removal, which must not forget a distribution that still exists), it is `none` only when WSL is not installed
   * (wslInstalled), and else throws WslSetupError `registryFailed`. It throws that too when WSL lists the distribution
   * but the registry cannot be read: Devspaces never guesses that it set up a distribution.
   */
  async registration(signal?: AbortSignal, sure = false): Promise<WslRegistration> {
    const listed = await this.listed(signal);
    if (listed === false) return 'none';
    const folders = await this.distributionFolders(signal);
    if (folders === undefined) {
      if (listed === undefined && (!sure || !(await this.wslInstalled(signal)))) return 'none';
      throw new WslSetupError(
        'registryFailed',
        listed
          ? `WSL lists the distribution ${WSL_DISTRIBUTION}, but the registry (${LXSS_KEY}) cannot be read, so Devspaces cannot tell whether it set it up.`
          : `Neither the list of WSL nor the registry (${LXSS_KEY}) can be read, so Devspaces cannot tell whether the distribution ${WSL_DISTRIBUTION} exists.`,
      );
    }
    if (!folders.has(WSL_DISTRIBUTION)) return listed ? 'foreign' : 'none';
    const diskFolder = folders.get(WSL_DISTRIBUTION);
    return diskFolder !== undefined && (await isWithinResolved(diskFolder, this.deps.folder)) ? 'own' : 'foreign';
  }

  /**
   * Runs `task` while this window holds the lock of the setup for all windows of the Windows user (the lock folder
   * `<folder>.lock`, withLockFolder), so that two windows never set up or remove the distribution at the same time.
   * Undefined, without `task`, while another window holds it.
   */
  async locked<T>(task: () => Promise<T>): Promise<{ value: T } | undefined> {
    let started = false;
    try {
      const value = await withLockFolder(
        `${this.deps.folder}.lock`,
        () => {
          started = true;
          return task();
        },
        LOCK_TIMINGS,
      );
      return { value };
    } catch (error) {
      if (!started && error instanceof LockTimeoutError) return undefined;
      throw error;
    }
  }

  /**
   * The Debian file of the list of WSL distributions for this computer, with its size when a HEAD request tells it.
   * Throws WslSetupError `listFailed` (also when the list does not arrive within 30 seconds) or `noImage`.
   */
  async image(signal?: AbortSignal): Promise<WslImage> {
    let list: unknown;
    try {
      const response = await this.deps.http.request({ method: 'GET', url: WSL_DISTRIBUTION_LIST_URL, maxBodyBytes: MAX_LIST_BYTES }, withTimeout(signal, REQUEST_MS));
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
   * in a folder `disk` (diskFolderFor), and removes the download; then the script installs Docker Engine (PROVISION_SCRIPT), the
   * distribution restarts, and Docker must answer. Without `image`, only the script, the restart and the check run (a
   * distribution that Devspaces set up before). Returns the version of the engine, and what WslSetup.separate found
   * after the registration (or before the script). Throws WslSetupError, or an
   * AbortError when the signal aborts. The registration itself is not cancelled: the service of WSL would go on with it
   * after the end of wsl.exe, so a cancel takes effect after it. When the script is cancelled or ends by its time
   * limit, the distribution stops, because the script would go on there after the end of wsl.exe; its next run goes on
   * from there.
   */
  async setUp(image: WslImage | undefined, onStep: (step: WslSetupStep) => void, signal?: AbortSignal): Promise<{ version: string; separation: WslSeparation }> {
    if (image !== undefined) {
      await this.register(image, onStep, signal);
    } else {
      // A download that could not be removed after the registration (WSL still had it open).
      await fs.promises.rm(this.downloadFolder, { recursive: true, force: true }).catch(() => undefined);
    }
    // WSL makes a new distribution the default when it has none.
    const separation = await this.separate();
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
    return { version, separation };
  }

  /**
   * `wsl --unregister devspaces`, which deletes the distribution with everything in it, then the folder of Devspaces,
   * unless another WSL distribution has its virtual disk there (removeLeftovers). Only for a distribution that Devspaces
   * set up (the caller checks `registration`). True when the folder is gone. Throws WslSetupError `removeFailed`.
   */
  async remove(signal?: AbortSignal): Promise<boolean> {
    const result = await this.runWsl(WSL_UNREGISTER_ARGS, { timeoutMs: UNREGISTER_MS, signal });
    if (result.exitCode !== 0) {
      throw new WslSetupError('removeFailed', `wsl.exe ${WSL_UNREGISTER_ARGS.join(' ')} failed (${endOf(result, UNREGISTER_MS)}): ${outputOf(result)}`);
    }
    this.deps.logger.info(`The WSL distribution ${WSL_DISTRIBUTION} was removed.`);
    return this.removeLeftovers();
  }

  /**
   * Removes the folder of Devspaces when no WSL distribution has its virtual disk there (the registry): after the
   * removal, or the files of a setup that did not end. True when the folder is gone. Never throws (logged).
   */
  async removeLeftovers(): Promise<boolean> {
    const { folder, logger } = this.deps;
    const exists = await fs.promises.access(folder).then(
      () => true,
      (error: unknown) => errorCode(error) !== 'ENOENT',
    );
    if (!exists) return true;
    const users = await this.diskUsers(folder).catch(() => undefined);
    if (users === undefined || users.length > 0) {
      logger.warn(`The folder ${folder} stays: ${users === undefined ? 'neither the registry nor WSL tells whether a WSL distribution uses it' : `the WSL distribution ${users.join(', ')} has its virtual disk there`}.`);
      return false;
    }
    return fs.promises.rm(folder, { recursive: true, force: true }).then(
      () => {
        logger.info(`The folder ${folder} was removed.`);
        return true;
      },
      (error: unknown) => {
        logger.warn(`The folder ${folder} could not be removed: ${errorMessage(error)}`);
        return false;
      },
    );
  }

  private async register(image: WslImage, onStep: (step: WslSetupStep) => void, signal?: AbortSignal): Promise<void> {
    const file = path.join(this.downloadFolder, DOWNLOAD_NAME);
    const diskFolder = await this.diskFolderFor(signal);
    await fs.promises.mkdir(this.downloadFolder, { recursive: true });
    await fs.promises.mkdir(diskFolder, { recursive: true });
    try {
      onStep({ kind: 'download', received: 0, total: image.size });
      await this.downloadImage(image, file, onStep, signal);
      onStep({ kind: 'register' });
      const args = wslInstallArgs(file, diskFolder);
      this.deps.logger.info(`wsl.exe ${args.join(' ')}`);
      // Without the signal (setUp). After the time limit, WSL may still end the registration: the next setup then finds
      // the distribution of Devspaces and only runs the script. Windows removes no file that WSL still has open (the
      // download, the virtual disk): such a removal fails, below and in diskFolderFor, and changes nothing.
      const result = await this.runWsl(args, { timeoutMs: REGISTER_MS });
      if (result.exitCode !== 0) {
        throw new WslSetupError('registerFailed', `wsl.exe --install --from-file failed (${endOf(result, REGISTER_MS)}): ${outputOf(result)}`);
      }
      this.deps.logger.info(`The WSL distribution ${WSL_DISTRIBUTION} was registered with its virtual disk in ${diskFolder}.`);
      if (signal?.aborted) {
        // The cancel takes effect after the registration, which WSL may have made its default.
        await this.separate();
        throw abortError();
      }
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

  /** The size of the file at `url` from HEAD requests (HTTPS redirects followed, all within 30 seconds), or undefined (logged). */
  private async sizeOf(url: string, signal?: AbortSignal): Promise<number | undefined> {
    let current = url;
    const deadline = withTimeout(signal, REQUEST_MS);
    try {
      for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
        const response = await this.deps.http.request({ method: 'HEAD', url: current }, deadline);
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
   * The folder for the virtual disk of a new registration (`--location`), so that WSL creates it in an empty folder:
   * `disk`, emptied when it has the files of a setup that did not end and no WSL distribution uses them. When that is
   * not known, nothing is removed on a guess: the first empty folder `disk-2`, `disk-3` and so on.
   */
  private async diskFolderFor(signal?: AbortSignal): Promise<string> {
    const first = path.join(this.deps.folder, 'disk');
    const names = await filesOf(first);
    if (names?.length === 0) return first;
    const users = names === undefined ? undefined : await this.diskUsers(first, signal);
    let removalError: unknown;
    if (names !== undefined && users?.length === 0) {
      this.deps.logger.info(`The folder ${first} has the files of a setup that did not end (${names.join(', ')}); they are removed.`);
      try {
        await fs.promises.rm(first, { recursive: true, force: true });
        return first;
      } catch (error) {
        // For example a file that WSL still has open.
        removalError = error;
      }
    }
    const content = names === undefined ? 'cannot be read' : `has files (${names.join(', ')})`;
    const why =
      removalError !== undefined
        ? `they could not be removed (${errorMessage(removalError)})`
        : names === undefined
          ? 'what is in it is not known'
          : users === undefined
            ? 'neither the registry nor WSL tells whether a WSL distribution uses it'
            : `the WSL distribution ${users.join(', ')} has its virtual disk there`;
    for (let number = 2; number <= MAX_DISK_FOLDERS; number++) {
      const next = path.join(this.deps.folder, `disk-${number}`);
      if ((await filesOf(next))?.length !== 0) continue;
      this.deps.logger.info(`The folder ${first} ${content}, and ${why}; the new distribution gets the folder ${next}.`);
      return next;
    }
    throw new WslSetupError('registerFailed', `The folders ${first} to disk-${MAX_DISK_FOLDERS} all have files, and ${why}.`);
  }

  /**
   * The WSL distributions (names in lower case) with their virtual disk in `parent`, from the registry; undefined when
   * it names none there but does not tell the folder of a distribution. Without the registry, only the distribution
   * `devspaces` can have it there (Devspaces registers no other one): then `wsl.exe --list` must answer. Undefined when
   * neither tells. Throws an AbortError when the signal aborts.
   */
  private async diskUsers(parent: string, signal?: AbortSignal): Promise<string[] | undefined> {
    const folders = await this.distributionFolders(signal);
    if (folders !== undefined) {
      const entries = [...folders.entries()];
      const users: string[] = [];
      for (const [name, diskFolder] of entries) {
        if (diskFolder !== undefined && (await isWithinResolved(diskFolder, parent))) users.push(name);
      }
      return users.length > 0 || entries.every(([, diskFolder]) => diskFolder !== undefined) ? users : undefined;
    }
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
   * Whether WSL is installed: `wsl.exe --version` or, from an older WSL, `wsl.exe --status` ends with exit code 0 (as
   * in checkWsl). Throws WslSetupError (runShort).
   */
  private async wslInstalled(signal?: AbortSignal): Promise<boolean> {
    if ((await this.runShort(WSL_VERSION_ARGS, signal)).exitCode === 0) return true;
    return (await this.runShort(WSL_STATUS_ARGS, signal)).exitCode === 0;
  }

  /**
   * Keeps the WSL distribution of Devspaces from being the default distribution of WSL, which `wsl` without `-d` opens
   * (as root there) and which Docker Desktop integrates by default. WSL makes a new distribution the default when it
   * has none, and the first one that is left after the removal of the default (LxssUserSession.cpp of WSL). Then the
   * first other installed distribution of the registry that takes it becomes the default (`wsl.exe --set-default`, as
   * WSL would choose without the one of Devspaces; never the machine of a tool, isToolDistribution), or, when WSL
   * refuses all, WSL has no default (the value DefaultDistribution goes; `wsl --list` still lists the distributions,
   * and WSL makes the next new distribution the default). After a call that WSL does not answer, nothing more is tried
   * until the next check. Only for a distribution that Devspaces set up (the folder of its virtual disk is in the
   * folder of Devspaces); without the folder of Devspaces, nothing runs. Not cancelled: a cancel would leave the
   * distribution the default. A failure is logged; never throws.
   */
  async separate(): Promise<WslSeparation> {
    if (!(await fs.promises.access(this.deps.folder).then(() => true, () => false))) return { state: 'none', dockerDesktop: undefined };
    const registry = await this.readRegistry();
    if (registry === undefined) return { state: 'unknown', dockerDesktop: undefined };
    const dockerDesktop = registry.distributions.some((distribution) => isDockerDesktopDistribution(distribution.name));
    const result = (state: WslSeparation['state']): WslSeparation => ({ state, dockerDesktop });
    const ours = registry.distributions.find((distribution) => distribution.name.toLowerCase() === WSL_DISTRIBUTION);
    if (ours?.basePath === undefined || !(await isWithinResolved(ours.basePath, this.deps.folder))) return result('none');
    if (registry.defaultId !== ours.id) return result('separate');
    const others = registry.distributions.filter(
      (distribution) => distribution !== ours && distribution.installed !== false && !isToolDistribution(distribution.name),
    );
    const failures: string[] = [];
    const stays = (): WslSeparation => {
      this.deps.logger.warn(`The WSL distribution ${WSL_DISTRIBUTION} of Devspaces stays the default distribution of WSL: ${failures.join('; ')}`);
      return result('default');
    };
    /** True when `run` ended well; false after a failure; undefined when WSL did not answer or start (WslSetupError). */
    const attempt = async (what: string, run: () => Promise<RunResult>, done: string): Promise<boolean | undefined> => {
      try {
        const ended = await run();
        if (ended.exitCode === 0 && !ended.timedOut) {
          this.deps.logger.info(`The WSL distribution ${WSL_DISTRIBUTION} of Devspaces was the default distribution of WSL; ${done}.`);
          return true;
        }
        failures.push(`${what} ended with ${endOf(ended, SHORT_CALL_MS)}: ${outputOf(ended)}`);
        return false;
      } catch (error) {
        failures.push(`${what}: ${errorMessage(error)}`);
        return error instanceof WslSetupError ? undefined : false;
      }
    };
    for (const other of others) {
      const args = wslSetDefaultArgs(other.name);
      const done = await attempt(`wsl.exe ${args.join(' ')}`, () => this.runShort(args), `now ${other.name} is`);
      if (done) return result('separate');
      // WSL may only be slow (just after the logon, or busy with a setup in another window): the next window start
      // tries again, and the user keeps a default.
      if (done === undefined) return stays();
    }
    // Only while the default is still the one of Devspaces: the user, or a removal in another window, may have changed
    // it meanwhile, and that default stays.
    const now = await this.readRegistry();
    if (now === undefined) return stays();
    if (now.defaultId !== ours.id) return result('separate');
    const removed = await attempt(
      'reg.exe delete',
      () => this.deps.runner.run(this.regPath, regDeleteDefaultArgs(), { timeoutMs: SHORT_CALL_MS }),
      'now WSL has no default, so "wsl" without "-d" does not open it',
    );
    return removed ? result('separate') : stays();
  }

  /**
   * Whether `wsl.exe --list` names the distribution `devspaces` (WSL compares the names without case): false also when
   * WSL has no distribution (NO_DISTRIBUTIONS); undefined when the list ends with another exit code that is not 0.
   * Throws WslSetupError (runShort).
   */
  private async listed(signal?: AbortSignal): Promise<boolean | undefined> {
    return listsDistribution(await this.runShort(WSL_LIST_ARGS, signal), WSL_DISTRIBUTION);
  }

  /**
   * The folders of the virtual disks of the WSL distributions of the Windows user by name in lower case
   * (readRegistry), or undefined when the registry cannot be read (logged). Throws an AbortError when the signal aborts.
   */
  private async distributionFolders(signal?: AbortSignal): Promise<Map<string, string | undefined> | undefined> {
    const registry = await this.readRegistry(signal);
    return registry && distributionFoldersOf(registry);
  }

  /**
   * The WSL distributions of the Windows user in the registry (`reg.exe export` into a new temporary folder, removed
   * after the read), or undefined when it cannot be read (logged). Throws an AbortError when the signal aborts.
   */
  private async readRegistry(signal?: AbortSignal): Promise<LxssRegistry | undefined> {
    let temporary: string | undefined;
    try {
      temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'devspaces-registry-'));
      const file = path.join(temporary, REGISTRY_EXPORT_NAME);
      const result = await this.deps.runner.run(this.regPath, regExportArgs(file), { timeoutMs: SHORT_CALL_MS, signal });
      if (result.exitCode !== 0) throw new Error(`reg.exe export ended with ${endOf(result, SHORT_CALL_MS)}: ${outputOf(result)}`);
      return parseLxss(await fs.promises.readFile(file));
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
   * `wsl.exe` with `args` (WSL_UTF8=1). Throws WslSetupError `wslMissing` when it is not found, `wslNotAnswering` when
   * it cannot start for another reason (a removal must not take that for a missing WSL), and an AbortError when the
   * signal aborts.
   */
  private async runWsl(args: readonly string[], options: RunOptions): Promise<RunResult> {
    const wsl = this.deps.wslPath();
    if (wsl === undefined) throw new WslSetupError('wslMissing', 'wsl.exe was not found.');
    try {
      return await this.deps.runner.run(wsl, args, { ...options, env: wslEnv(this.deps.env) });
    } catch (error) {
      if (options.signal?.aborted) throw abortError();
      throw new WslSetupError(errorCode(error) === 'ENOENT' ? 'wslMissing' : 'wslNotAnswering', `wsl.exe could not be started: ${errorMessage(error)}`);
    }
  }
}

/** The names in `folder`: none when it does not exist; undefined when it cannot be read (it counts as one with files). */
async function filesOf(folder: string): Promise<string[] | undefined> {
  try {
    return await fs.promises.readdir(folder);
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? [] : undefined;
  }
}

/** `signal`, which also aborts after `ms` (a server that never answers). */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/** The output of a call for the log (wslText): standard error, else standard output. */
export function outputOf(result: RunResult): string {
  const text = wslText(result.stderr || result.stdout).trim();
  return text === '' ? '(no output)' : text;
}

/** How a call ended, for the log. */
export function endOf(result: RunResult, timeoutMs: number): string {
  return result.timedOut ? `no end within ${duration(timeoutMs)}` : `exit code ${result.exitCode}`;
}

function duration(ms: number): string {
  return ms >= 120_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} seconds`;
}
